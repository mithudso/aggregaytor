/**
 * @file sniffies-adapter.ts — Sniffies platform adapter.
 *
 * Intercepts Sniffies network traffic (fetch, XHR, WebSocket),
 * extracts actual chat messages, and normalizes them into the
 * {@link UnifiedMessage} format consumed by the aggregator UI.
 *
 * ## Architecture
 * Extends {@link BaseAdapter} which provides the generic network-intercept
 * plumbing (monkey-patching fetch/XHR/WebSocket). This subclass implements:
 *  - `shouldInterceptUrl` -- decides which URLs to capture
 *  - `parseApiResponse`   -- turns a JSON payload into UnifiedMessage[]
 *  - `parseWebSocketFrame`-- turns a WS frame into UnifiedMessage[]
 *
 * ## Key Challenges
 * 1. **body-type vs message-body disambiguation** -- Sniffies profile objects
 *    carry a `body` field whose value is a body-type label ("athletic",
 *    "muscular", etc.). Without filtering, every profile response would be
 *    mistaken for a chat message. The {@link PROFILE_ATTRIBUTE_VALUES} set
 *    and the {@link isLikelyMessage} heuristic exist solely to solve this.
 *
 * 2. **Global chat vs DM routing** -- Two API endpoints serve messages:
 *    `/api/post-authentication?timeThreshold=...` for the global feed, and
 *    `/api/v2/post-authentication/chat-data` for DMs. However, global posts
 *    can leak into the chat-data response, so we also inspect object fields
 *    (author, location, lack of conversationId) to classify each message.
 *
 * 3. **Self-ID detection** -- We must know which profile ID is "us" so we
 *    can (a) skip our own profile in contact extraction and (b) detect
 *    outgoing message direction. IDs are seeded from window globals,
 *    localStorage, URL context, and API payloads.
 */

import {
  BaseAdapter,
  walkPayload,
  createLogger,
  perf,
} from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';
import { parseSocketIOFrame, isGlobalChatEvent, isPresenceEvent } from './ws-parser.js';
import { findLikelyProfileId, normalizeProfileId, extractProfileIdFromUrl } from './profile-resolver.js';

const log = createLogger('[Aggregaytor:Sniffies]');

// ── Profile Attribute Blocklist ─────────────────────────────────────────────
//
// Sniffies profiles have a `body` field that holds a body-type label, NOT
// message text. Without this blocklist the adapter would interpret every
// profile response as a chat message with body "athletic" (etc.).
//
// The set contains all known single/two-word enum values that appear in
// profile payloads: body types, position/attitude, relationship status,
// "looking for" tags, ethnicity/hair/eye colors, HIV status, and generic
// yes/no answers. Any object whose extracted text matches one of these
// values (case-insensitive) is rejected as a message candidate.
const PROFILE_ATTRIBUTE_VALUES = new Set([
  // Body types
  'slim', 'athletic', 'average', 'muscular', 'chubby', 'stocky', 'heavyset',
  'toned', 'dad bod', 'dadbod', 'fit', 'skinny', 'thick', 'lean', 'large',
  'bear', 'otter', 'twink', 'jock', 'cub',
  // Positions/attitudes
  'top', 'bottom', 'vers', 'vers top', 'vers bottom', 'side', 'versatile',
  'power bottom', 'submissive bottom', 'passive top', 'dom top breeder',
  // Roles
  'dominant', 'submissive', 'switch',
  // Relationship status
  'single', 'partnered', 'married', 'open relationship', 'dating',
  // Looking for
  'friends', 'dates', 'networking', 'hookup', 'relationship', 'chat',
  // Ethnicity, hair, eye values -- common single/two-word values
  'white', 'black', 'latino', 'asian', 'mixed', 'other',
  'bald', 'blonde', 'brown', 'red', 'black', 'gray', 'grey',
  'blue', 'green', 'hazel', 'brown',
  // HIV status
  'negative', 'positive', 'undetectable', 'prep', 'on prep',
  // Misc profile fields
  'yes', 'no', 'sometimes', 'never', 'prefer not to say',
  'subscription added', 'subscription removed',
]);

// ── Object Classification Keys ─────────────────────────────────────────────
//
// Because Sniffies payloads mix profile objects and message objects in the
// same response, we classify each object by checking for "signal keys" --
// field names that are strongly associated with one type or the other.
// These are compared against the NORMALIZED (lowercased, no separators)
// key names of the object being inspected.

/** Keys whose presence strongly indicates the object IS a chat message. */
const MESSAGE_SIGNAL_KEYS = [
  'messageid', 'message_id', 'chatid', 'chat_id', 'conversationid',
  'conversation_id', 'senderid', 'sender_id', 'recipientid', 'recipient_id',
  'fromme', 'ismine', 'sentbyme', 'isoutgoing', 'isincoming',
  'messagetype', 'message_type', 'chattype', 'replyto', 'reply_to',
];

/** Keys whose presence strongly indicates the object is a PROFILE, not a message. */
const PROFILE_SIGNAL_KEYS = [
  'attitude', 'bodytype', 'body_type', 'ethnicity', 'height', 'weight',
  'age', 'hivstatus', 'hiv_status', 'position', 'tribe', 'pronouns',
  'lookingfor', 'looking_for', 'hosting', 'lastactive', 'last_active',
  'distance', 'distanceaway', 'miles', 'kilometers',
];

// ── Utility Helpers ─────────────────────────────────────────────────────────

/**
 * Strip separators (hyphens, underscores, spaces) and lowercase a key so that
 * "body_type", "bodyType", and "body-type" all normalize to "bodytype".
 */
function normalizeKey(key: string): string {
  return String(key || '').replace(/[-_ ]/g, '').toLowerCase();
}

/**
 * Coerce a timestamp value (seconds, milliseconds, or ISO string) to
 * epoch-milliseconds. Returns 0 if the value is falsy or unparseable.
 * Values below 1e12 are assumed to be seconds and are multiplied by 1000.
 */
function parseTimestamp(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') {
    // Heuristic: timestamps below 1e12 (~2001 in ms) are likely in seconds
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Search an object for the best available timestamp, trying common key names
 * first with their exact casing, then falling back to a normalized-key scan.
 * Returns the latest (largest) timestamp found, in epoch-ms, or 0.
 */
function extractTimestampFromObj(obj: Record<string, unknown>): number {
  // Fast path: check well-known camelCase keys directly
  for (const key of ['createdAt', 'sentAt', 'timestamp', 'time', 'updatedAt', 'date', 'lastMessageAt', 'ts', 'created_at', 'sent_at']) {
    if (key in obj) {
      const ts = parseTimestamp(obj[key]);
      if (ts) return ts;
    }
  }
  // Slow path: normalize every key and try pattern matching
  let latest = 0;
  for (const [key, value] of Object.entries(obj)) {
    const nk = normalizeKey(key);
    if (/^(createdat|sentat|timestamp|time|updatedat|date|lastmessageat|ts)$/.test(nk)) {
      const ts = parseTimestamp(value);
      if (ts > latest) latest = ts;
    }
  }
  return latest;
}

// ── Message Classification Heuristic ────────────────────────────────────────

/**
 * Determine whether a given API object represents a chat message rather than
 * a profile / attribute / presence blob.
 *
 * The decision is a 4-tier cascade:
 *
 *  1. **Strong positive** -- If the object has any key from MESSAGE_SIGNAL_KEYS
 *     (e.g. `messageId`, `conversationId`), it is a message.
 *  2. **Strong negative** -- If the object has any key from PROFILE_SIGNAL_KEYS
 *     (e.g. `bodyType`, `ethnicity`), it is NOT a message.
 *  3. **Value check** -- If the extracted body text is in the
 *     PROFILE_ATTRIBUTE_VALUES blocklist (e.g. "athletic"), reject it.
 *  4. **Word-count heuristic** -- Require at least 2 words OR 8+ characters.
 *     Single short words are overwhelmingly profile enum values, not messages.
 *
 * @returns `true` if the object should be treated as a chat message candidate.
 */
function isLikelyMessage(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj).map(normalizeKey);

  // Tier 1: strong positive signal -- has message-specific keys
  const hasMessageKey = MESSAGE_SIGNAL_KEYS.some(mk => keys.includes(mk));
  if (hasMessageKey) return true;

  // Tier 2: strong negative signal -- has profile-specific keys
  const hasProfileKey = PROFILE_SIGNAL_KEYS.some(pk => keys.includes(pk));
  if (hasProfileKey) return false;

  // Tier 3: check the body text against the profile-attribute blocklist
  const bodyVal = String(obj.body || obj.text || obj.message || obj.content || '').trim().toLowerCase();
  if (PROFILE_ATTRIBUTE_VALUES.has(bodyVal)) return false;

  // Tier 4: single short words are almost always profile enum values, not messages
  const wordCount = bodyVal.split(/\s+/).length;
  if (wordCount <= 1 && bodyVal.length < 8) return false;

  return true;
}

/**
 * Extract the message body text from an object.
 *
 * The key `body` is deliberately checked ONLY after verifying the object
 * passes {@link isLikelyMessage}, because profile objects use `body` for
 * body-type ("athletic"). Safe keys like `text` / `message` are checked
 * unconditionally since they are unambiguous.
 */
function extractBody(obj: Record<string, unknown>): string {
  // Phase 1: safe, unambiguous keys -- always check these first
  const textKeys = ['text', 'message', 'msg', 'messageText', 'messageBody'];
  for (const key of textKeys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length >= 2) return value.trim();
  }
  // Phase 2: ambiguous keys ('body', 'content') -- only if object is message-like
  // SKIP 'snippet', 'preview', 'lastMessage' — these are conversation-level summary
  // fields that contain concatenated text from the entire conversation, not a single
  // message. Including them produces a giant "rollup" message in the UI.
  if (isLikelyMessage(obj)) {
    for (const key of ['body', 'content']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim().length >= 2) {
        // Cap at 500 chars — real messages are short, but concatenated
        // previews/summaries can be thousands of characters
        const trimmed = value.trim();
        return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
      }
    }
  }
  return '';
}

/**
 * Determine if a message was sent by us ('out') or received ('in').
 *
 * Checks three signal types in order:
 *  1. Boolean flags (`fromMe`, `isOutgoing`, etc.)
 *  2. String direction fields (`direction: "outgoing"`)
 *  3. Sender-ID match against our known self IDs
 *
 * Defaults to 'in' when no signal matches (safer to assume incoming).
 */
function detectDirection(obj: Record<string, unknown>, selfIds: Set<string>): 'in' | 'out' {
  for (const [key, value] of Object.entries(obj)) {
    const k = normalizeKey(key);
    // Check boolean flags first (most reliable signal)
    if (value === true) {
      if (['fromme', 'ismine', 'mine', 'sentbyme', 'outgoing', 'isoutgoing', 'mymessage'].includes(k)) return 'out';
      if (['incoming', 'isincoming', 'fromthem', 'received', 'isreceived', 'theirmessage'].includes(k)) return 'in';
    }
    // Check string direction fields
    if (typeof value === 'string' && ['direction', 'messagedirection', 'type', 'msgtype'].includes(k)) {
      const s = value.toLowerCase();
      if (/(out|sent|fromme|mine)/.test(s)) return 'out';
      if (/(in|received|fromthem)/.test(s)) return 'in';
    }
  }
  // Fallback: compare the sender ID against our known self IDs
  const senderId = normalizeProfileId(String(obj.senderId || obj.sender_id || obj.from || obj.fromId || obj.from_id || ''));
  if (senderId && selfIds.has(senderId)) return 'out';
  return 'in';
}

// ── Adapter Implementation ──────────────────────────────────────────────────

/**
 * Sniffies platform adapter.
 *
 * Intercepts fetch, XHR, and WebSocket traffic from sniffies.com, extracts
 * chat messages and contact/profile data, and emits them as
 * {@link UnifiedMessage} / {@link UnifiedContact} events.
 */
export class SniffiesAdapter extends BaseAdapter {
  readonly platform: Platform = 'sniffies';
  private storageTimer: ReturnType<typeof setInterval> | null = null;
  private captureCount = 0;

  /**
   * Deduplication set for message IDs already emitted this session.
   * Prevents re-emitting the same message when it appears in multiple
   * API responses (e.g. both a conversation fetch and a WS push).
   * Capped at 5000 entries to prevent unbounded memory growth -- when
   * the cap is hit, the oldest 2000 entries are discarded.
   */
  private seenMessageIds = new Set<string>();

  /**
   * Throttle map for userJoined contact extraction.
   * Maps profileId → last-processed timestamp. Prevents the expensive
   * deepFindAvatarUrl recursive search from running on every presence
   * event (userJoined fires hundreds of times per minute on busy maps).
   * Each profile is only processed once per 60 seconds.
   */
  private userJoinedThrottle = new Map<string, number>();

  /**
   * Buffer for contacts extracted from userJoined events.
   * Instead of emitting one chrome.runtime.sendMessage per contact,
   * we batch them and flush every 5 seconds. This reduces the 25+
   * ADAPTER_CONTACTS events/second we were seeing to ~1 batched event.
   */
  private userJoinedContactBuffer: UnifiedContact[] = [];
  private userJoinedFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set up network interception and periodic background tasks. */
  async init(): Promise<void> {
    log.info('Initializing adapter...');
    // Seed self-IDs from window globals (e.g. __sniffies_user_id)
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.seedSelfIdsFromPage();
    // Monkey-patch fetch/XHR/WebSocket to intercept traffic
    this.setupNetworkInterception(window as Window & typeof globalThis);
    // Periodically scrape map-marker DOM nodes for avatar URLs.
    // NOTE: scanStorage() was removed — it cost 300ms+ per call scanning
    // ALL localStorage keys and JSON.parsing matching ones. It was a legacy
    // fallback from before fetch/XHR interception worked reliably.
    this.storageTimer = setInterval(() => {
      this.scrapeAvatarsFromDOM();
    }, 60_000);
    // Initial avatar scrape after DOM settles (5s delay for SPA hydration)
    setTimeout(() => this.scrapeAvatarsFromDOM(), 5000);
    log.info('Adapter initialized. Self IDs:', [...this.selfIds.ids]);
  }

  async destroy(): Promise<void> {
    if (this.storageTimer) {
      clearInterval(this.storageTimer);
      this.storageTimer = null;
    }
    await super.destroy();
  }

  /**
   * Decide which network requests to intercept.
   *
   * NOTE: An earlier version skipped global-chat and cruising-update URLs
   * because they were considered noise. That was wrong -- those URLs are
   * the ONLY reliable signal for routing messages to the Global Chat
   * thread. We now intercept ALL sniffies.com URLs and let parseApiResponse
   * classify each message as global vs DM.
   */
  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    if (!s.includes('sniffies.com') && !s.includes('sniffies')) return false;
    // Skip non-API URLs to avoid wasting CPU on clone+json for static assets.
    // The fetch interceptor clones + JSON.parses every intercepted response,
    // which costs 5-75ms per call. Filtering here prevents that cost for
    // images, scripts, stylesheets, map tiles, analytics, etc.
    if (s.includes('/assets/') || s.includes('/static/') ||
        s.includes('.png') || s.includes('.jpg') || s.includes('.webp') ||
        s.includes('.svg') || s.includes('.css') || s.includes('.woff') ||
        s.includes('.wasm') || s.includes('ngsw') ||
        s.includes('/analytics') || s.includes('/telemetry') ||
        s.includes('/tiles/') || s.includes('.pbf')) {
      return false;
    }
    return true;
  }

  // ── Block / Error Detection ──────────────────────────────────────────────

  /**
   * Detect if an API response indicates a blocked or deleted profile.
   *
   * Checks for HTTP 403/404/410 status codes and error messages containing
   * keywords like "blocked" or "deleted". When found, emits an error event
   * with the pattern `BLOCKED:{profileId}` so the UI can gray out that
   * conversation.
   */
  private detectBlockSignals(url: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const obj = payload as Record<string, unknown>;

    // Error responses that indicate blocking
    const status = obj.status || obj.statusCode || obj.code;
    const error = String(obj.error || obj.message || obj.detail || '').toLowerCase();

    if (status === 403 || status === 404 || status === 410 ||
        error.includes('blocked') || error.includes('not found') ||
        error.includes('deleted') || error.includes('unavailable') ||
        error.includes('no longer available')) {

      // Try to extract the profile ID from the URL
      const match = url.match(/\/profile\/([0-9a-f]{6,})/i) || url.match(/\/([0-9a-f]{6,})/i);
      if (match) {
        const profileId = match[1].toLowerCase();
        log.info(`Block detected for ${profileId}: ${error || status}`);
        this.emit({
          type: 'error',
          payload: new Error(`BLOCKED:${profileId}`),
        });
      }
    }
  }

  // ── API Response Parsing ─────────────────────────────────────────────────

  /**
   * Core message-extraction entry point for HTTP responses.
   *
   * Uses the shared {@link walkPayload} utility to recursively traverse
   * the JSON payload. For each plain object encountered, the `onObject`
   * callback:
   *  1. Seeds self-IDs from any identity hints in the object.
   *  2. Resolves the "other person's" profile ID (skipping self).
   *  3. Extracts contact/profile metadata (avatar, body type, etc.).
   *  4. If the object passes {@link isLikelyMessage}, extracts a message.
   *  5. Classifies the message as global-chat or DM using both URL-based
   *     and field-based heuristics.
   *
   * After walking, deduplicates against {@link seenMessageIds} and emits
   * contacts as a batch event.
   *
   * @param url The intercepted request URL (or synthetic like `[ws-global]`)
   * @param payload The parsed JSON body of the response
   */
  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    const endParseApi = perf.start('parseApiResponse');
    // Check for block/error responses before message extraction
    this.detectBlockSignals(url, payload);

    const messages: UnifiedMessage[] = [];
    const contacts: UnifiedContact[] = [];
    // Try to get the profile ID from the current page URL (e.g. /profile/{id}/chat)
    const contextId = this.getContextProfileId();

    const seenContacts = new Set<string>();

    walkPayload(payload, contextId, {
      onObject: (obj, ctx, _depth) => {
        // Opportunistically detect self-IDs from every object we see
        this.selfIds.detectFromPayload(obj);
        this.detectSelfIdsFromObj(obj);

        // Resolve the profile ID of the OTHER person (not self) in this object
        const profileId = findLikelyProfileId(obj, ctx || '', this.selfIds.ids);

        // ── Contact Extraction ──────────────────────────────────────────────
        // Extract profile metadata from ANY object that has a profile ID,
        // not just message objects. This picks up profile data from map
        // markers, user lists, conversation headers, etc.
        if (profileId && !seenContacts.has(profileId)) {
          const avatarUrl = this.resolveAvatarUrl(obj, profileId);
          const displayName = String(obj.displayName || obj.username || obj.name || obj.label || obj.nickname || '').trim();
          const md: Record<string, unknown> = {};

          // Capture all profile attributes into metadata
          for (const [key, value] of Object.entries(obj)) {
            const k = normalizeKey(key);
            if (typeof value === 'string' && value.length < 100) {
              if (/bodytype|body|build/.test(k)) md.bodyType = value;
              if (/attitude|position|role/.test(k)) md.position = value;
              if (/^age$/.test(k)) md.age = value;
              if (/ethnicity|race/.test(k)) md.ethnicity = value;
              if (/height/.test(k)) md.height = value;
              if (/distance|miles|km/.test(k)) md.distance = value;
              if (/hosting|host/.test(k)) md.hosting = value;
            }
            if (Array.isArray(value) && /photo|image|pic/.test(k)) {
              md.photos = value.filter(v => typeof v === 'string').slice(0, 10);
            }
          }

          if (avatarUrl || displayName || Object.keys(md).length > 0) {
            seenContacts.add(profileId);
            contacts.push({
              id: `sniffies:${profileId}`,
              platform: 'sniffies',
              platformUserId: profileId,
              displayName: displayName || '',
              profileUrl: `https://sniffies.com/profile/${profileId}`,
              avatarUrl,
              lastSeen: new Date().toISOString(),
              metadata: md,
            });
          }
        }

        // ── Message Extraction ──────────────────────────────────────────────
        // Only attempt message extraction if the object passes the
        // isLikelyMessage heuristic (has message keys, lacks profile keys,
        // body text is not a profile attribute enum, etc.)
        if (!isLikelyMessage(obj)) return;

        const body = extractBody(obj);
        if (!body) return;
        // Double-check: even after isLikelyMessage passed, reject body text
        // that exactly matches a known profile attribute value
        if (PROFILE_ATTRIBUTE_VALUES.has(body.toLowerCase())) return;

        const ts = extractTimestampFromObj(obj);
        if (!ts || !profileId) {
          log.debug('Skipped message-like object: missing', !ts ? 'timestamp' : 'profileId', 'body:', body.slice(0, 40), 'keys:', Object.keys(obj).join(','));
          return;
        }

        const direction = detectDirection(obj, this.selfIds.ids);
        const msgId = String(obj.id || obj._id || obj.messageId || obj.message_id || `${profileId}:${ts}`);
        log.debug(`Message: contactId=sniffies:${profileId} dir=${direction} body="${body.slice(0, 30)}..." keys=${Object.keys(obj).slice(0, 8).join(',')}`);

        // ── Global vs DM Classification ────────────────────────────────────
        // CONFIRMED: Sniffies uses two distinct fetch endpoints:
        //   /api/post-authentication?timeThreshold=...  → Global chat (broadcast posts)
        //   /api/v2/post-authentication/chat-data       → DMs (private conversations)
        //   BUT: chat-data also includes global posts mixed in! Need field-based detection.
        // WebSocket: "newGlobalMsg" event = global chat
        //
        // Global post structure (from WS newGlobalMsg):
        //   { body, author, location, isDeleted, _id, createdAt, updatedAt, __v, partialUser }
        // DM message structure:
        //   Has conversationId, senderId, recipientId — global posts do NOT have these
        // Field-based detection: global posts have `author`/`partialUser` +
        // `location`/`isDeleted` but LACK `conversationId`/`recipientId`.
        // This catches global posts that leak into the chat-data endpoint.
        const hasGlobalPostFields = (
          ('author' in obj || 'partialUser' in obj) &&
          ('location' in obj || 'isDeleted' in obj) &&
          !('conversationId' in obj) && !('conversation_id' in obj) &&
          !('recipientId' in obj) && !('recipient_id' in obj)
        );
        // Multi-signal classification -- any match means global
        const isGlobal = url === '[ws-global]' ||                              // synthetic URL from WS handler
          (url.includes('/post-authentication') && !url.includes('/chat-data')) || // URL-based: global feed endpoint
          hasGlobalPostFields ||                                               // field-based (described above)
          url.includes('global') || url.includes('cruising') ||                // keyword fallback
          (typeof obj.channel === 'string' && (obj.channel.includes('global') || obj.channel.includes('group'))) ||
          (typeof obj.type === 'string' && (obj.type.includes('cruising') || obj.type.includes('global') || obj.type.includes('broadcast'))) ||
          (typeof obj.feedType === 'string') ||
          (typeof obj.cruisingUpdate === 'object');
        // Global messages share a single thread key; DMs are keyed by profile
        const threadKey = isGlobal ? 'global-chat' : profileId;

        // Collect sender attributes into message metadata for UI rendering.
        // Global chat messages need per-sender attribution since many users
        // share a single thread.
        const senderAttrs: Record<string, unknown> = { profileId, url };
        if (isGlobal || direction === 'in') {
          // Include profile details in message metadata for per-profile attribution
          const displayName = String(obj.displayName || obj.username || obj.name || obj.label || '').trim();
          if (displayName) senderAttrs.displayName = displayName;
          senderAttrs.avatarUrl = this.resolveAvatarUrl(obj, profileId);
          // Copy any profile attributes found on the sender
          for (const [key, value] of Object.entries(obj)) {
            const k = normalizeKey(key);
            if (typeof value === 'string' && value.length < 100) {
              if (/bodytype|body|build/.test(k)) senderAttrs.bodyType = value;
              if (/attitude|position|role/.test(k)) senderAttrs.position = value;
              if (/^age$/.test(k)) senderAttrs.age = value;
              if (/height/.test(k)) senderAttrs.height = value;
              if (/weight/.test(k)) senderAttrs.weight = value;
              if (/ethnicity/.test(k)) senderAttrs.ethnicity = value;
              if (/distance|miles|km/.test(k)) senderAttrs.distance = value;
            }
          }
          senderAttrs.senderId = profileId;
        }

        messages.push({
          id: `sniffies:${msgId}`,
          platform: 'sniffies',
          threadId: `sniffies:${threadKey}`,
          contactId: `sniffies:${isGlobal ? 'global-chat' : profileId}`,
          direction,
          body,
          timestamp: new Date(ts).toISOString(),
          read: direction === 'out',
          metadata: senderAttrs,
        });
      },
    });

    // ── Deduplication ────────────────────────────────────────────────────
    // Two levels of dedup:
    // 1. By message ID — catches exact same message from multiple API calls
    // 2. By content hash — catches same message with different IDs (e.g.,
    //    chat-data returns msg with id "abc", WS push returns same text
    //    with id "xyz"). Hash = contactId + body (first 100 chars) +
    //    timestamp rounded to 1-minute buckets (to handle slight time diffs).
    const newMessages = messages.filter(m => {
      if (this.seenMessageIds.has(m.id)) return false;
      // Content-based dedup: same person + same body text within 10 min.
      // Round timestamp to 10-minute buckets to catch messages captured
      // from different sources (API, DOM scrape, WS) seconds apart.
      const tsDate = new Date(m.timestamp);
      const bucket = new Date(Math.floor(tsDate.getTime() / 600_000) * 600_000).toISOString().slice(0, 16);
      const contentKey = `${m.contactId}|${m.body.slice(0, 60)}|${bucket}`;
      if (this.seenMessageIds.has(contentKey)) return false;
      // Also check body-only dedup for very recent messages (within session)
      // This catches exact duplicates regardless of timestamp
      const bodyKey = `${m.contactId}|${m.body.slice(0, 100)}`;
      if (this.seenMessageIds.has(bodyKey)) return false;
      this.seenMessageIds.add(m.id);
      this.seenMessageIds.add(contentKey);
      // Body-only key expires after we cap the set (effectively ~session-length)
      this.seenMessageIds.add(bodyKey);
      return true;
    });

    // Cap the seen-set to prevent unbounded memory growth. When it
    // exceeds 5000 entries, discard the oldest 2000 (keeping the most
    // recent 3000) so that very old duplicates can technically re-appear
    // but current traffic stays deduped.
    if (this.seenMessageIds.size > 5000) {
      const arr = [...this.seenMessageIds];
      this.seenMessageIds = new Set(arr.slice(-3000));
    }

    if (newMessages.length) {
      this.captureCount += newMessages.length;
      log.info(`Captured ${newMessages.length} new messages from ${url} (${messages.length - newMessages.length} dupes skipped, total: ${this.captureCount})`);
    }
    if (contacts.length) {
      this.emit({ type: 'contacts', payload: contacts });
    }

    endParseApi();
    return newMessages;
  }

  // ── WebSocket Frame Parsing ──────────────────────────────────────────────

  /**
   * Parse a single WebSocket frame into messages.
   *
   * WebSocket traffic is classified into three buckets:
   *  1. **Presence events** (userJoined, userAwake, etc.) -- skipped for
   *     messages but mined for contact data (especially userJoined which
   *     carries a full profile payload with avatar URL).
   *  2. **Global chat events** (newGlobalMsg, cruisingUpdate, etc.) --
   *     forwarded to parseApiResponse with the synthetic URL `[ws-global]`
   *     so the global-detection logic routes them correctly.
   *  3. **Everything else** -- assumed to be DM traffic and forwarded to
   *     parseApiResponse with the synthetic URL `[ws-dm]`.
   */
  protected parseWebSocketFrame(data: string | ArrayBuffer): UnifiedMessage[] {
    const text = typeof data === 'string' ? data : '';
    if (!text) return [];

    // ── Fast pre-filter: skip JSON.parse entirely for high-frequency presence ──
    // userAwake and userDisconnected make up ~80% of all WS frames and carry
    // no useful data (just a hex ID string). Checking for the event name as a
    // substring is ~100x faster than JSON.parse + isPresenceEvent.
    // We still parse userJoined (has profile data) and everything else.
    if (text.includes('"userAwake"') || text.includes('"userDisconnected"') ||
        text.includes('"userRemoved"') || text.includes('"userUpdated"')) {
      perf.count('ws:skippedPresence');
      return [];
    }

    const endWsFrame = perf.start('parseWebSocketFrame');
    const frame = parseSocketIOFrame(text);
    if (!frame) { endWsFrame(); return []; }

    // ── Presence events: skip for messages but extract contacts ──────────
    if (isPresenceEvent(frame.eventName)) {
      // userJoined events carry a full profile payload (avatar, attributes)
      // that we can use to populate the contact list. THROTTLED: these fire
      // hundreds of times per minute on busy maps. We process each profileId
      // at most once every 30 seconds to avoid CPU-intensive recursive avatar
      // searches on every single presence event.
      if (frame.eventName === 'userJoined' && frame.data && typeof frame.data === 'object') {
        const obj = frame.data as Record<string, unknown>;
        const profileId = normalizeProfileId(String(obj._id || ''));
        if (profileId && !this.selfIds.ids.has(profileId)) {
          const now = Date.now();
          const lastSeen = this.userJoinedThrottle.get(profileId) || 0;
          if (now - lastSeen > 60_000) {
            this.userJoinedThrottle.set(profileId, now);
            // Cap throttle map at 500 entries to prevent unbounded growth
            if (this.userJoinedThrottle.size > 500) {
              const oldest = [...this.userJoinedThrottle.entries()].sort((a, b) => a[1] - b[1]).slice(0, 200);
              for (const [k] of oldest) this.userJoinedThrottle.delete(k);
            }
            const profileData = obj.data as Record<string, unknown> | undefined;
            if (profileData && typeof profileData === 'object') {
              this.selfIds.detectFromPayload(profileData);
              const avatarUrl = this.resolveAvatarUrl(profileData, profileId);
              // Buffer contacts and flush every 5s to avoid flooding
              // with 25+ chrome.runtime.sendMessage calls per second
              this.userJoinedContactBuffer.push({
                id: `sniffies:${profileId}`,
                platform: 'sniffies' as const,
                platformUserId: profileId,
                displayName: '',
                profileUrl: `https://sniffies.com/profile/${profileId}`,
                avatarUrl,
                lastSeen: new Date().toISOString(),
                metadata: {},
              });
              if (!this.userJoinedFlushTimer) {
                this.userJoinedFlushTimer = setTimeout(() => {
                  if (this.userJoinedContactBuffer.length) {
                    this.emit({ type: 'contacts', payload: this.userJoinedContactBuffer });
                    this.userJoinedContactBuffer = [];
                  }
                  this.userJoinedFlushTimer = null;
                }, 5000);
              }
            }
          }
        }
      }
      endWsFrame(); return [];
    }

    // Skip frames with no data payload
    if (!frame.data) { endWsFrame(); return []; }

    // ── Global chat events: route with synthetic [ws-global] URL ─────────
    if (isGlobalChatEvent(frame.eventName)) {
      log.debug(`WS global event: "${frame.eventName}"`);
      const result = this.parseApiResponse('[ws-global]', frame.data);
      endWsFrame(); return result;
    }

    // Log unknown non-presence event names at debug level for discovery
    if (frame.eventName) {
      log.debug(`WS event: "${frame.eventName}"`);
    }

    // ── Default: assume DM traffic ──────────────────────────────────────
    const result = this.parseApiResponse('[ws-dm]', frame.data);
    endWsFrame(); return result;
  }

  // ── Self-ID Detection ────────────────────────────────────────────────────

  /**
   * Extract a profile ID from the current page URL if on a profile/chat page.
   * e.g. `https://sniffies.com/profile/abc123/chat` -> `abc123`
   */
  private getContextProfileId(): string | null {
    try {
      return extractProfileIdFromUrl(window.location.href) || null;
    } catch {
      return null;
    }
  }

  /**
   * Seed self-IDs from well-known window globals that Sniffies may set.
   * Called once during init().
   */
  private seedSelfIdsFromPage(): void {
    try {
      const w = window as any;
      for (const key of ['__sniffies_user_id', '__user', 'userId', 'currentUserId', 'myProfileId', 'selfId']) {
        const val = w[key];
        if (val && typeof val === 'string') {
          const id = normalizeProfileId(val);
          if (id) this.selfIds.ids.add(id);
        }
      }
    } catch { /* ignore -- window access can throw in edge cases */ }
  }

  /**
   * Detect self-IDs from an API response object.
   *
   * Checks for keys like `selfId`, `myProfileId`, `currentUserId`, and
   * also flags like `isMe: true`. Any matching hex ID is added to the
   * self-ID set for direction detection and profile-ID skipping.
   */
  private detectSelfIdsFromObj(obj: Record<string, unknown>): void {
    // Check explicit self-referencing key names
    for (const [key, value] of Object.entries(obj)) {
      const k = normalizeKey(key);
      if (['selfid', 'myid', 'myprofileid', 'currentuserid', 'viewerid', 'ownerid', 'loggedinuserid'].includes(k)) {
        const id = normalizeProfileId(String(value || ''));
        if (id) this.selfIds.ids.add(id);
      }
    }
    // Check boolean self-identification flags
    if (obj.isMe === true || obj.isSelf === true || obj.mine === true) {
      const id = normalizeProfileId(String(obj.id || obj._id || obj.profileId || obj.userId || ''));
      if (id) this.selfIds.ids.add(id);
    }
  }

  // ── Avatar Resolution ────────────────────────────────────────────────────

  /**
   * Resolve avatar URL from an API object.
   *
   * Sniffies stores profile photos on the CDN at
   * `profile.sniffiesassets.com/{profileId}/{num}`. However, the URL can
   * be buried in deeply nested structures like:
   * ```
   * { data: { profile: { extended: { photo: "https://..." } } } }
   * ```
   * So we search up to 4 levels deep via {@link deepFindAvatarUrl}.
   */
  private resolveAvatarUrl(obj: Record<string, unknown>, profileId: string): string {
    const found = this.deepFindAvatarUrl(obj, 0);
    if (found) return found;
    // Fallback: construct Sniffies CDN URL from the profile ID.
    // Pattern: https://profile.sniffiesassets.com/{profileId}/0
    // These are publicly accessible (no auth required — the Sniffies SPA
    // loads them cross-origin). If the profile has no photo, the CDN returns
    // a default avatar or 404, and the panel's image error handler hides it
    // gracefully (falls back to the letter initial).
    if (profileId && /^[0-9a-f]{10,}$/i.test(profileId)) {
      return `https://profile.sniffiesassets.com/${profileId}/0`;
    }
    return '';
  }

  /**
   * Recursively search an object for an avatar/photo URL up to 4 levels deep.
   *
   * Search priority at each level:
   *  1. Explicit avatar/photo field names (e.g. `avatarUrl`, `profilePhoto`)
   *  2. Photo arrays (e.g. `photos: ["https://...", ...]`)
   *  3. Sniffies CDN URL pattern in any string value (`sniffiesassets.com`)
   *  4. Any HTTP URL in a key whose name matches photo/image/avatar/etc.
   *  5. Recurse into nested sub-objects (skipping arrays)
   */
  private deepFindAvatarUrl(obj: Record<string, unknown>, depth: number): string {
    if (depth > 4) return '';

    // Level 1: check explicit avatar/photo field names
    for (const key of ['avatar', 'avatarUrl', 'photo', 'image', 'profilePhoto', 'profileImage', 'thumbnail', 'thumbUrl', 'photoUrl', 'imageUrl', 'pictureUrl']) {
      const val = obj[key];
      if (typeof val === 'string' && (val.startsWith('http') || val.startsWith('data:'))) return val;
    }
    // Level 2: check photo arrays — handle multiple nesting patterns:
    //   photos: ["url", ...], photos: [{url: "..."}, ...], photos: [{thumbnail: {url: "..."}}]
    for (const arrKey of ['photos', 'images', 'pictures', 'avatars', 'media']) {
      const arr = obj[arrKey];
      if (Array.isArray(arr) && arr.length > 0) {
        for (const item of arr.slice(0, 3)) { // check first 3 items
          if (typeof item === 'string' && item.startsWith('http')) return item;
          if (item && typeof item === 'object') {
            // Check common nested URL fields
            for (const urlKey of ['url', 'src', 'href', 'thumbnail', 'thumb', 'full', 'original', 'small']) {
              const u = (item as any)[urlKey];
              if (typeof u === 'string' && u.startsWith('http')) return u;
              // One more level: {thumbnail: {url: "..."}}
              if (u && typeof u === 'object' && typeof u.url === 'string') return u.url;
            }
            // Any sniffiesassets URL in the object
            for (const v of Object.values(item as Record<string, unknown>)) {
              if (typeof v === 'string' && v.includes('sniffiesassets.com')) return v;
            }
          }
        }
      }
    }
    // Level 3: look for Sniffies CDN URL pattern in any string value
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.includes('sniffiesassets.com')) return val;
      if (typeof val === 'string' && val.includes('sniffies') && (val.includes('.jpg') || val.includes('.png') || val.includes('.webp'))) return val;
    }
    // Level 4: any HTTP URL whose key name suggests a photo/image
    for (const [key, val] of Object.entries(obj)) {
      const k = normalizeKey(key);
      if (/photo|image|pic|thumb|avatar|media/.test(k) && typeof val === 'string' && val.startsWith('http')) return val;
    }
    // Level 5: recurse into nested objects AND arrays (first 5 elements)
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        if (Array.isArray(val)) {
          // Recurse into array elements (capped at first 5 to avoid huge payloads)
          for (const item of val.slice(0, 5)) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              const found = this.deepFindAvatarUrl(item as Record<string, unknown>, depth + 1);
              if (found) return found;
            }
          }
        } else {
          const found = this.deepFindAvatarUrl(val as Record<string, unknown>, depth + 1);
          if (found) return found;
        }
      }
    }
    return '';
  }

  // ── DOM Scraping ─────────────────────────────────────────────────────────

  /**
   * Scrape avatar URLs from visible map markers in the DOM.
   *
   * Sniffies renders map-marker avatars as CSS `background-image` properties
   * on DOM elements (e.g. `.maplibregl-marker`). The background-image URL
   * follows the pattern:
   *   `url("https://profile.sniffiesassets.com/{profileId}/{photoNum}")`
   *
   * We parse the profileId out of the CDN URL and emit a contact update so
   * the aggregator UI has an avatar for that profile, even before the user
   * opens a conversation with them.
   */
  private scrapeAvatarsFromDOM(): void {
    const endScrape = perf.start('scrapeAvatarsFromDOM');
    try {
      const markers = document.querySelectorAll('.maplibregl-marker, .marker-avatar-image, [style*="sniffiesassets"]');
      for (const el of markers) {
        const bg = (el as HTMLElement).style?.backgroundImage || getComputedStyle(el).backgroundImage || '';
        // Parse the URL out of `background-image: url("...")`
        const match = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (!match) continue;
        const url = match[1];
        // Extract the profile ID from the CDN path segment
        const idMatch = url.match(/sniffiesassets\.com\/([0-9a-f]{6,})\//i);
        if (idMatch) {
          const profileId = idMatch[1].toLowerCase();
          this.emit({
            type: 'contacts',
            payload: [{
              id: `sniffies:${profileId}`,
              platform: 'sniffies' as const,
              platformUserId: profileId,
              displayName: '',
              profileUrl: `https://sniffies.com/profile/${profileId}`,
              avatarUrl: url,
              lastSeen: new Date().toISOString(),
              metadata: {},
            }],
          });
        }
      }
    } catch { /* DOM access can fail in certain contexts */ }
    endScrape();
  }

  // ── localStorage Scanning ────────────────────────────────────────────────

  /**
   * Scan localStorage for cached conversation data.
   *
   * Sniffies may cache chat/conversation objects in localStorage. This
   * periodic scan looks for keys containing "chat", "message", "inbox", or
   * "conversation", parses the JSON, and runs it through the same
   * parseApiResponse pipeline as network traffic. Entries larger than 8 MB
   * are skipped to avoid blocking the main thread.
   */
  private scanStorage(): void {
    const endScan = perf.start('scanStorage');
    try {
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        // Only inspect keys that look chat-related
        if (!/chat|message|inbox|conversation/i.test(key)) continue;
        try {
          const raw = localStorage.getItem(key);
          if (!raw || raw.length > 8_000_000) continue; // skip oversized entries
          const data = JSON.parse(raw);
          if (data && typeof data === 'object') {
            const messages = this.parseApiResponse(`[storage:${key}]`, data);
            if (messages.length) this.emit({ type: 'messages', payload: messages });
          }
        } catch { /* not valid JSON -- skip */ }
      }
    } catch { /* localStorage not available in this context */ }
    endScan();
  }
}
