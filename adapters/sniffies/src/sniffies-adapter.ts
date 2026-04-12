/**
 * sniffies-adapter.ts — Sniffies platform adapter.
 *
 * Intercepts Sniffies network traffic (fetch, XHR, WebSocket),
 * extracts actual chat messages, and normalizes to UnifiedMessage format.
 *
 * Key challenge: Sniffies profiles have a `body` field for body type
 * ("athletic", "muscular") which must NOT be confused with message text.
 */

import {
  BaseAdapter,
  walkPayload,
  createLogger,
} from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';
import { parseSocketIOFrame } from './ws-parser.js';
import { findLikelyProfileId, normalizeProfileId, extractProfileIdFromUrl } from './profile-resolver.js';

const log = createLogger('[Aggregaytor:Sniffies]');

// ── Profile attribute values to reject as message bodies ────────────────────
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
  // Ethnicity, hair, eye values — common single/two-word values
  'white', 'black', 'latino', 'asian', 'mixed', 'other',
  'bald', 'blonde', 'brown', 'red', 'black', 'gray', 'grey',
  'blue', 'green', 'hazel', 'brown',
  // HIV status
  'negative', 'positive', 'undetectable', 'prep', 'on prep',
  // Misc profile fields
  'yes', 'no', 'sometimes', 'never', 'prefer not to say',
  'subscription added', 'subscription removed',
]);

// Keys that indicate this object IS a chat message (strong signals)
const MESSAGE_SIGNAL_KEYS = [
  'messageid', 'message_id', 'chatid', 'chat_id', 'conversationid',
  'conversation_id', 'senderid', 'sender_id', 'recipientid', 'recipient_id',
  'fromme', 'ismine', 'sentbyme', 'isoutgoing', 'isincoming',
  'messagetype', 'message_type', 'chattype', 'replyto', 'reply_to',
];

// Keys that indicate this is a PROFILE object (not a message)
const PROFILE_SIGNAL_KEYS = [
  'attitude', 'bodytype', 'body_type', 'ethnicity', 'height', 'weight',
  'age', 'hivstatus', 'hiv_status', 'position', 'tribe', 'pronouns',
  'lookingfor', 'looking_for', 'hosting', 'lastactive', 'last_active',
  'distance', 'distanceaway', 'miles', 'kilometers',
];

function normalizeKey(key: string): string {
  return String(key || '').replace(/[-_ ]/g, '').toLowerCase();
}

function parseTimestamp(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function extractTimestampFromObj(obj: Record<string, unknown>): number {
  for (const key of ['createdAt', 'sentAt', 'timestamp', 'time', 'updatedAt', 'date', 'lastMessageAt', 'ts', 'created_at', 'sent_at']) {
    if (key in obj) {
      const ts = parseTimestamp(obj[key]);
      if (ts) return ts;
    }
  }
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

/**
 * Check if this object looks like a chat message vs a profile/attribute object.
 */
function isLikelyMessage(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj).map(normalizeKey);

  // Strong positive signal: has message-specific keys
  const hasMessageKey = MESSAGE_SIGNAL_KEYS.some(mk => keys.includes(mk));
  if (hasMessageKey) return true;

  // Strong negative signal: has profile-specific keys
  const hasProfileKey = PROFILE_SIGNAL_KEYS.some(pk => keys.includes(pk));
  if (hasProfileKey) return false;

  // Weak signal: check the "body" value itself
  const bodyVal = String(obj.body || obj.text || obj.message || obj.content || '').trim().toLowerCase();
  if (PROFILE_ATTRIBUTE_VALUES.has(bodyVal)) return false;

  // Require the body text to be at least a short sentence (>= 2 words or >= 8 chars)
  // Single words are almost always profile attributes, not messages
  const wordCount = bodyVal.split(/\s+/).length;
  if (wordCount <= 1 && bodyVal.length < 8) return false;

  return true;
}

function extractBody(obj: Record<string, unknown>): string {
  // Only check message-appropriate keys (skip 'body' for profile objects)
  const textKeys = ['text', 'message', 'msg', 'messageText', 'messageBody'];
  for (const key of textKeys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length >= 2) return value.trim();
  }
  // Check 'body' and 'content' only if the object looks like a message
  if (isLikelyMessage(obj)) {
    for (const key of ['body', 'content', 'snippet', 'preview', 'lastMessage']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim().length >= 2) return value.trim();
    }
  }
  return '';
}

function detectDirection(obj: Record<string, unknown>, selfIds: Set<string>): 'in' | 'out' {
  for (const [key, value] of Object.entries(obj)) {
    const k = normalizeKey(key);
    if (value === true) {
      if (['fromme', 'ismine', 'mine', 'sentbyme', 'outgoing', 'isoutgoing', 'mymessage'].includes(k)) return 'out';
      if (['incoming', 'isincoming', 'fromthem', 'received', 'isreceived', 'theirmessage'].includes(k)) return 'in';
    }
    if (typeof value === 'string' && ['direction', 'messagedirection', 'type', 'msgtype'].includes(k)) {
      const s = value.toLowerCase();
      if (/(out|sent|fromme|mine)/.test(s)) return 'out';
      if (/(in|received|fromthem)/.test(s)) return 'in';
    }
  }
  const senderId = normalizeProfileId(String(obj.senderId || obj.sender_id || obj.from || obj.fromId || obj.from_id || ''));
  if (senderId && selfIds.has(senderId)) return 'out';
  return 'in';
}

export class SniffiesAdapter extends BaseAdapter {
  readonly platform: Platform = 'sniffies';
  private storageTimer: ReturnType<typeof setInterval> | null = null;
  private captureCount = 0;
  private seenMessageIds = new Set<string>(); // dedupe — don't re-emit captured messages

  async init(): Promise<void> {
    log.info('Initializing adapter...');
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.seedSelfIdsFromPage();
    this.setupNetworkInterception(window as Window & typeof globalThis);
    this.storageTimer = setInterval(() => {
      this.scanStorage();
      this.scrapeAvatarsFromDOM();
    }, 60_000);
    // Initial avatar scrape after DOM settles
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

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    // Skip explicit global chat pages — the bridge DOM scraper handles those
    if (s.includes('global-chat') || s.includes('cruising-update')) return false;
    return s.includes('sniffies.com') || s.includes('sniffies');
  }

  /**
   * Detect if a profile/conversation is blocked or deleted.
   * Override the base parseApiResponse to also check for block signals.
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

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    // Check for block/error responses first
    this.detectBlockSignals(url, payload);

    const messages: UnifiedMessage[] = [];
    const contacts: UnifiedContact[] = [];
    const contextId = this.getContextProfileId();

    const seenContacts = new Set<string>();

    walkPayload(payload, contextId, {
      onObject: (obj, ctx, _depth) => {
        this.selfIds.detectFromPayload(obj);
        this.detectSelfIdsFromObj(obj);

        const profileId = findLikelyProfileId(obj, ctx || '', this.selfIds.ids);

        // ── Extract contact/profile info from ANY object with a profile ID ──
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

        // ── Extract messages only from message-like objects ──
        if (!isLikelyMessage(obj)) return;

        const body = extractBody(obj);
        if (!body) return;
        if (PROFILE_ATTRIBUTE_VALUES.has(body.toLowerCase())) return;

        const ts = extractTimestampFromObj(obj);
        if (!ts || !profileId) {
          log.debug('Skipped message-like object: missing', !ts ? 'timestamp' : 'profileId', 'body:', body.slice(0, 40), 'keys:', Object.keys(obj).join(','));
          return;
        }

        const direction = detectDirection(obj, this.selfIds.ids);
        const msgId = String(obj.id || obj._id || obj.messageId || obj.message_id || `${profileId}:${ts}`);
        log.debug(`Message: contactId=sniffies:${profileId} dir=${direction} body="${body.slice(0, 30)}..." keys=${Object.keys(obj).slice(0, 8).join(',')}`);

        // Detect global/group chat context — only based on explicit signals
        const isGlobal = url.includes('global') || url.includes('group') ||
          url.includes('cruising') || url === '[ws-global]' ||
          (typeof obj.channel === 'string' && (obj.channel.includes('global') || obj.channel.includes('group'))) ||
          (typeof obj.type === 'string' && (obj.type.includes('cruising') || obj.type.includes('global') || obj.type.includes('broadcast'))) ||
          (typeof obj.feedType === 'string') ||
          (typeof obj.cruisingUpdate === 'object');
        const threadKey = isGlobal ? 'global-chat' : profileId;

        // Collect sender attributes for global chat rendering
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

    // Deduplicate — only emit messages we haven't seen before
    const newMessages = messages.filter(m => {
      if (this.seenMessageIds.has(m.id)) return false;
      this.seenMessageIds.add(m.id);
      return true;
    });

    // Cap the seen set to prevent unbounded growth
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

    return newMessages;
  }

  protected parseWebSocketFrame(data: string | ArrayBuffer): UnifiedMessage[] {
    const text = typeof data === 'string' ? data : '';
    if (!text) return [];
    const parsed = parseSocketIOFrame(text);
    if (!parsed) return [];

    // Check if user is currently viewing the global chat page
    // If so, WebSocket messages are cruising updates, not DMs
    const isOnGlobalChat = this.isGlobalChatPage();
    const url = isOnGlobalChat ? '[ws-global]' : '[ws-dm]';
    return this.parseApiResponse(url, parsed);
  }

  private isGlobalChatPage(): boolean {
    try {
      const path = window.location.pathname.toLowerCase();
      // The global chat is NOT at /chat (that's the DM inbox)
      // It's the main map view where cruising updates appear in the feed
      // When the chat panel is open at /chat, WS messages are DMs
      return !path.includes('/chat') && !path.includes('/profile/');
    } catch {
      return false;
    }
  }

  private getContextProfileId(): string | null {
    try {
      return extractProfileIdFromUrl(window.location.href) || null;
    } catch {
      return null;
    }
  }

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
    } catch { /* ignore */ }
  }

  private detectSelfIdsFromObj(obj: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(obj)) {
      const k = normalizeKey(key);
      if (['selfid', 'myid', 'myprofileid', 'currentuserid', 'viewerid', 'ownerid', 'loggedinuserid'].includes(k)) {
        const id = normalizeProfileId(String(value || ''));
        if (id) this.selfIds.ids.add(id);
      }
    }
    if (obj.isMe === true || obj.isSelf === true || obj.mine === true) {
      const id = normalizeProfileId(String(obj.id || obj._id || obj.profileId || obj.userId || ''));
      if (id) this.selfIds.ids.add(id);
    }
  }

  /**
   * Resolve avatar URL from an API object.
   * Sniffies stores photos at profile.sniffiesassets.com/{id}/
   * and may also include direct URLs in various fields.
   */
  private resolveAvatarUrl(obj: Record<string, unknown>, profileId: string): string {
    // Check explicit avatar/photo fields
    for (const key of ['avatar', 'avatarUrl', 'photo', 'image', 'profilePhoto', 'profileImage', 'thumbnail', 'thumbUrl', 'photoUrl', 'imageUrl', 'pictureUrl']) {
      const val = obj[key];
      if (typeof val === 'string' && (val.startsWith('http') || val.startsWith('data:'))) return val;
    }
    // Check nested photo objects
    if (obj.photos && Array.isArray(obj.photos)) {
      const first = obj.photos[0];
      if (typeof first === 'string' && first.startsWith('http')) return first;
      if (first && typeof first === 'object' && typeof (first as any).url === 'string') return (first as any).url;
    }
    // Check for Sniffies CDN pattern in any string value
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.includes('sniffiesassets.com')) return val;
      if (typeof val === 'string' && val.includes('sniffies') && (val.includes('.jpg') || val.includes('.png') || val.includes('.webp'))) return val;
    }
    // Check for any URL-like string in common photo key patterns
    for (const [key, val] of Object.entries(obj)) {
      const k = normalizeKey(key);
      if (/photo|image|pic|thumb|avatar|media/.test(k) && typeof val === 'string' && val.startsWith('http')) return val;
    }
    // Don't construct CDN URL — it likely requires auth. Return empty.
    return '';
  }

  /**
   * Scrape avatar URLs from visible map markers on the page.
   * Sniffies renders marker avatars as background-image CSS on DOM elements.
   */
  private scrapeAvatarsFromDOM(): void {
    try {
      const markers = document.querySelectorAll('.maplibregl-marker, .marker-avatar-image, [style*="sniffiesassets"]');
      for (const el of markers) {
        const bg = (el as HTMLElement).style?.backgroundImage || getComputedStyle(el).backgroundImage || '';
        // Extract URL from background-image: url("https://profile.sniffiesassets.com/{id}/{num}")
        const match = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (!match) continue;
        const url = match[1];
        const idMatch = url.match(/sniffiesassets\.com\/([0-9a-f]{6,})\//i);
        if (idMatch) {
          const profileId = idMatch[1].toLowerCase();
          // Emit as a contact update with the real avatar URL
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
    } catch {}
  }

  private scanStorage(): void {
    try {
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        if (!/chat|message|inbox|conversation/i.test(key)) continue;
        try {
          const raw = localStorage.getItem(key);
          if (!raw || raw.length > 8_000_000) continue;
          const data = JSON.parse(raw);
          if (data && typeof data === 'object') {
            const messages = this.parseApiResponse(`[storage:${key}]`, data);
            if (messages.length) this.emit({ type: 'messages', payload: messages });
          }
        } catch { /* not JSON */ }
      }
    } catch { /* localStorage not available */ }
  }
}
