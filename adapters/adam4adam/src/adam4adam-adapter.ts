/**
 * adam4adam-adapter.ts — Adam4Adam platform adapter.
 *
 * Intercepts fetch/XHR traffic from adam4adam.com, extracts chat messages
 * and contact/profile data, and normalizes to UnifiedMessage format.
 *
 * A4A uses:
 *  - data-author attributes on DOM message elements
 *  - REST API endpoints (/api/, /mailbox, /message, /profile)
 *  - frontend-config meta tag with user info
 *  - Profile photos at their CDN (various patterns)
 */

import {
  BaseAdapter,
  createDOMExtractor,
  walkPayload,
  extractTimestamp,
  extractMessageText,
  parseRelativeTimeString,
  createLogger,
} from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';

const log = createLogger('[Aggregaytor:A4A]');

/** Hosts whose responses may legitimately be parsed as Adam4Adam data. */
const A4A_HOST_RE = /(^|\.)adam4adam\.com$/i;

/**
 * Test whether `url` resolves to an Adam4Adam-owned host.
 *
 * A bare `url.includes('adam4adam.com')` test also accepts third-party URLs
 * that merely mention the domain (`https://evil.example/?ref=adam4adam.com`),
 * letting anything running on the page feed forged JSON into the user's
 * message and contact store. Relative URLs resolve against the page origin;
 * anything unparseable is rejected.
 */
function isA4AHost(url: string): boolean {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    return A4A_HOST_RE.test(new URL(String(url), base).hostname);
  } catch {
    return false;
  }
}

// ── Profile attribute values to reject as message bodies ──────────────────
// A4A profiles have fields like body type, position, etc. that could be
// mistaken for message text. Same approach as the Sniffies adapter.
const PROFILE_ATTRIBUTE_VALUES = new Set([
  'slim', 'athletic', 'average', 'muscular', 'stocky', 'heavyset',
  'toned', 'fit', 'large', 'bear', 'otter', 'twink', 'jock',
  'top', 'bottom', 'vers', 'vers top', 'vers bottom', 'versatile',
  'dominant', 'submissive', 'switch',
  'single', 'partnered', 'married', 'dating', 'open relationship',
  'white', 'black', 'latino', 'asian', 'mixed', 'other',
  'negative', 'positive', 'undetectable', 'prep', 'on prep',
  'yes', 'no', 'sometimes', 'never',
]);

export class Adam4AdamAdapter extends BaseAdapter {
  readonly platform: Platform = 'adam4adam';
  private currentUser = '';
  private seenMessageIds = new Set<string>(); // dedup

  /**
   * Bring the adapter online. Seeds self-IDs (page globals, `frontend-config`
   * meta tag, localStorage, URL), wires a {@link createDOMExtractor} for
   * newly-rendered message elements, scans messages already on the page, and
   * installs fetch/XHR interception. A4A serves DMs through both server-rendered
   * DOM and a REST API, so both paths are needed.
   */
  async init(): Promise<void> {
    log.info('Initializing...');
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.detectCurrentUser();

    // DOM observation for message elements
    const cleanup = createDOMExtractor(document, {
      rootSelector: 'body',
      messageSelector: '[data-author], .message-item, .mail-message, [class*="message-row"], [class*="chat-message"]',
      onNewElements: (elements) => {
        const messages: UnifiedMessage[] = [];
        const contacts: UnifiedContact[] = [];
        for (const el of elements) {
          const result = this.parseMessageElement(el);
          if (result?.message) messages.push(result.message);
          if (result?.contact) contacts.push(result.contact);
        }
        if (messages.length) this.emit({ type: 'messages', payload: this.dedup(messages) });
        if (contacts.length) this.emit({ type: 'contacts', payload: contacts });
      },
    });
    this.addCleanup(cleanup);

    // Scan existing messages on page
    this.scanExistingMessages();

    // Intercept fetch/XHR for API responses
    this.setupNetworkInterception(window as Window & typeof globalThis);

    log.info(`Initialized. Self IDs: ${[...this.selfIds.ids].join(', ')}`);
  }

  // ── URL Interception ────────────────────────────────────────────────────

  /**
   * Gate which intercepted requests are parsed as Adam4Adam data.
   *
   * Cheap substring pre-check, then static-asset rejection, then a real host
   * check via {@link isA4AHost} so a look-alike third-party URL cannot inject
   * forged payloads.
   *
   * @param url - The request URL seen by the network interceptor.
   * @returns `true` only for genuinely A4A-owned, non-asset URLs.
   */
  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    if (!s.includes('adam4adam.com')) return false;
    // Skip static assets
    if (s.includes('/static/') || s.includes('.css') || s.includes('.js') ||
        s.includes('.png') || s.includes('.jpg') || s.includes('.gif') ||
        s.includes('.svg') || s.includes('.woff')) return false;
    // Host check so look-alike third-party URLs cannot inject forged
    // payloads. See isA4AHost().
    return isA4AHost(url);
  }

  // ── API Response Parsing ────────────────────────────────────────────────

  /**
   * Extract Adam4Adam messages and contacts from an intercepted JSON payload.
   *
   * Walks the (untrusted) response with {@link walkPayload}; each object node is
   * handled by {@link visitPayloadObject}, wrapped so a throw on one node cannot
   * abort the walk. Messages are deduplicated before return; contacts are
   * emitted directly as a `'contacts'` event.
   *
   * @param url     - Source URL, recorded in message metadata.
   * @param payload - The parsed JSON body; may be any shape.
   * @returns The deduplicated messages extracted from this payload.
   */
  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];
    const contacts: UnifiedContact[] = [];

    walkPayload(payload, null, {
      onObject: (obj) => {
        // Payload objects are untrusted. One unrenderable value — e.g. a
        // numeric timestamp outside the Date range, which makes the shared
        // extractTimestamp() throw `RangeError: Invalid time value` — must
        // not abort the rest of the walk and silently drop every message
        // later in the same response.
        try {
          this.visitPayloadObject(obj, url, messages, contacts);
        } catch (err) {
          log.debug('Skipped unparseable payload object:', err);
        }
      },
    });

    if (contacts.length) this.emit({ type: 'contacts', payload: contacts });
    return this.dedup(messages);
  }

  /**
   * Inspect a single object node from an API payload, appending any message
   * and/or contact it yields to the supplied accumulators.
   *
   * Split out of {@link parseApiResponse} so the walker can isolate a throw
   * to one node instead of losing the remainder of the response.
   *
   * @param obj      - The object node being visited.
   * @param url      - Source URL, recorded in message metadata.
   * @param messages - Accumulator for extracted messages.
   * @param contacts - Accumulator for extracted contacts.
   */
  private visitPayloadObject(
    obj: Record<string, unknown>,
    url: string,
    messages: UnifiedMessage[],
    contacts: UnifiedContact[],
  ): void {
    this.selfIds.detectFromPayload(obj);

    // ── Extract contact/profile info ────────────────────────────────
    const profileId = String(obj.userId || obj.user_id || obj.profileId ||
      obj.profile_id || obj.username || obj.author || obj.senderId || '');

    if (profileId && !this.selfIds.has(profileId)) {
      const displayName = String(obj.displayName || obj.display_name ||
        obj.name || obj.username || obj.nickname || '').trim();

      // Avatar: check multiple URL patterns
      let avatarUrl = '';
      for (const key of ['avatar', 'avatarUrl', 'avatar_url', 'photo',
        'photoUrl', 'photo_url', 'profilePhoto', 'image', 'thumbnail', 'thumb']) {
        const v = obj[key];
        if (typeof v === 'string' && (v.startsWith('http') || v.startsWith('//'))) {
          avatarUrl = v.startsWith('//') ? 'https:' + v : v;
          break;
        }
      }
      // Check photos array
      if (!avatarUrl && Array.isArray(obj.photos)) {
        const first = obj.photos[0];
        if (typeof first === 'string' && first.startsWith('http')) avatarUrl = first;
        else if (first && typeof first === 'object') {
          avatarUrl = String((first as any).url || (first as any).src || (first as any).thumb || '');
        }
      }

      // Extract metadata
      const md: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        const k = key.toLowerCase();
        if (typeof value === 'string' && value.length < 100) {
          if (/bodytype|body_type|build/.test(k)) md.bodyType = value;
          if (/position|attitude|role|sexual/.test(k)) md.position = value;
          if (/^age$/.test(k)) md.age = value;
          if (/ethnicity|race/.test(k)) md.ethnicity = value;
          if (/height/.test(k)) md.height = value;
          if (/weight/.test(k)) md.weight = value;
          if (/location|city|region/.test(k)) md.location = value;
          if (/hiv|status/.test(k)) md.hivStatus = value;
          if (/looking|seeking/.test(k)) md.lookingFor = value;
          if (/about|bio|description/.test(k)) md.profileText = value;
        }
        if (typeof value === 'number') {
          if (k === 'age') md.age = String(value);
          if (k === 'distance') md.distance = String(value);
        }
      }

      if (avatarUrl || displayName || Object.keys(md).length > 0) {
        contacts.push({
          id: `adam4adam:${profileId}`,
          platform: 'adam4adam',
          platformUserId: profileId,
          displayName: displayName || '',
          profileUrl: `https://www.adam4adam.com/profile/${profileId}`,
          avatarUrl,
          lastSeen: new Date().toISOString(),
          metadata: md,
        });
      }
    }

    // ── Extract messages ────────────────────────────────────────────
    const body = extractMessageText(obj);
    if (!body || body.length < 2) return;
    // Reject profile attribute values
    if (PROFILE_ATTRIBUTE_VALUES.has(body.toLowerCase().trim())) return;

    const ts = extractTimestamp(obj);
    const senderId = String(obj.senderId || obj.sender_id || obj.from || obj.author || obj.username || '');
    const recipientId = String(obj.recipientId || obj.recipient_id || obj.to || '');
    const msgId = String(obj.id || obj.message_id || obj.messageId || `${senderId}:${ts || Date.now()}`);
    const direction = (senderId && (this.selfIds.has(senderId) || senderId === this.currentUser)) ? 'out' : 'in';
    const contactId = direction === 'out' ? recipientId : senderId;

    if (!contactId) return;

    messages.push({
      id: `adam4adam:${msgId}`,
      platform: 'adam4adam',
      threadId: `adam4adam:${contactId}`,
      contactId: `adam4adam:${contactId}`,
      direction,
      body: body.slice(0, 500),
      timestamp: ts || new Date().toISOString(),
      read: direction === 'out',
      metadata: { senderId, recipientId, url },
    });
  }

  /**
   * Parse a WebSocket frame — always returns `[]`.
   *
   * Adam4Adam delivers messages over its REST API, not WebSockets, so there is
   * nothing to parse. Present only to satisfy the {@link BaseAdapter} contract.
   *
   * @returns An empty array (always).
   */
  protected parseWebSocketFrame(): UnifiedMessage[] {
    return []; // A4A uses REST, not WebSocket
  }

  // ── Deduplication ────────────────────────────────────────────────────────

  /**
   * Filter out messages already seen this session (by exact id and by a
   * contact+body+minute content key), then cap the seen-set to bound memory.
   *
   * The same message can arrive via the DOM scan and the REST API with
   * different ids, so content-keying catches near-duplicates the id check
   * misses. When the seen-set passes 3000 entries the oldest ~1000 are dropped.
   *
   * @param messages - Freshly extracted messages, possibly containing dupes.
   * @returns Only the messages not previously emitted.
   */
  private dedup(messages: UnifiedMessage[]): UnifiedMessage[] {
    const result = messages.filter(m => {
      if (this.seenMessageIds.has(m.id)) return false;
      // Content-based dedup: same contact + body + minute
      const contentKey = `${m.contactId}|${m.body.slice(0, 80)}|${m.timestamp.slice(0, 16)}`;
      if (this.seenMessageIds.has(contentKey)) return false;
      this.seenMessageIds.add(m.id);
      this.seenMessageIds.add(contentKey);
      return true;
    });
    // Cap dedup set
    if (this.seenMessageIds.size > 3000) {
      const arr = [...this.seenMessageIds];
      this.seenMessageIds = new Set(arr.slice(-2000));
    }
    return result;
  }

  // ── Self-ID Detection ────────────────────────────────────────────────────

  /**
   * Populate {@link selfIds} (and `currentUser`) with the logged-in user's ID so
   * outgoing messages can be direction-detected and the user's own profile is
   * skipped during contact extraction.
   *
   * Three strategies in order: the `frontend-config` meta tag, user/profile/
   * auth/session keys in localStorage, and the profile ID in the URL when an
   * "own-profile" marker is present. Best-effort — the whole scan is wrapped so
   * a hostile DOM or unreadable storage can't abort init(); a failure is logged
   * at debug and leaves self-IDs unseeded from this source.
   */
  private detectCurrentUser(): void {
    try {
      // Strategy 1: frontend-config meta tag
      const meta = document.querySelector('meta[name="frontend-config"]');
      if (meta) {
        const config = JSON.parse(meta.getAttribute('content') || '{}');
        for (const key of ['userId', 'username', 'profile_name', 'user_id', 'profileId']) {
          const val = config[key];
          if (val) { this.selfIds.ids.add(String(val)); this.currentUser = this.currentUser || String(val); }
        }
      }
      // Strategy 2: scan localStorage for user data
      for (const key of Object.keys(localStorage)) {
        if (!/user|profile|auth|session/i.test(key)) continue;
        try {
          const val = localStorage.getItem(key);
          if (!val || val.length > 1000) continue;
          const data = JSON.parse(val);
          if (data && typeof data === 'object') {
            for (const k of ['userId', 'username', 'profileId', 'user_id', 'id']) {
              if (data[k] && typeof data[k] === 'string') {
                this.selfIds.ids.add(data[k]);
                this.currentUser = this.currentUser || data[k];
              }
            }
          }
        } catch { /* localStorage value not JSON — expected, skip this key */ }
      }
      // Strategy 3: check URL for profile
      const urlMatch = location.href.match(/\/profile\/([^/?#]+)/);
      if (urlMatch && document.querySelector('[class*="my-profile"], [class*="own-profile"]')) {
        this.selfIds.ids.add(urlMatch[1]);
        this.currentUser = this.currentUser || urlMatch[1];
      }
    } catch (err) {
      log.debug('Self-ID detection failed:', err);
    }
  }

  // ── DOM Message Parsing ──────────────────────────────────────────────────

  /**
   * Parse messages already present in the DOM at init time (the DOM extractor
   * only fires on subsequently-added nodes). Emits any messages (deduplicated)
   * and contacts found, and logs the count so a session can confirm the initial
   * scan ran.
   */
  private scanExistingMessages(): void {
    const elements = document.querySelectorAll('[data-author], .message-item, .mail-message');
    const messages: UnifiedMessage[] = [];
    const contacts: UnifiedContact[] = [];
    for (const el of elements) {
      const result = this.parseMessageElement(el as Element);
      if (result?.message) messages.push(result.message);
      if (result?.contact) contacts.push(result.contact);
    }
    if (messages.length) {
      log.info(`Scanned ${messages.length} existing DOM messages`);
      this.emit({ type: 'messages', payload: this.dedup(messages) });
    }
    if (contacts.length) this.emit({ type: 'contacts', payload: contacts });
  }

  /**
   * Turn one Adam4Adam message DOM element into a normalized message (and, for
   * inbound messages, the sender contact).
   *
   * Reads the sender from `data-author`, the body from element text (rejecting
   * profile-attribute enum values that aren't real messages), an absolute or
   * relative timestamp from a nearby time element, and a nearby avatar image.
   * Direction is outbound when the author matches a known self-ID. The whole
   * body is wrapped so a malformed element yields `null` instead of throwing out
   * of the caller's batch loop.
   *
   * @param el - A candidate message element from the DOM.
   * @returns `{ message, contact? }`, or `null` when the element has no author/
   *          usable body, the body is a profile attribute, or parsing threw.
   */
  private parseMessageElement(el: Element): { message?: UnifiedMessage; contact?: UnifiedContact } | null {
    try {
    const author = (el.getAttribute('data-author') || '').replace(/:$/, '').trim();
    if (!author) return null;
    const body = el.textContent?.trim();
    if (!body || body.length < 2) return null;
    if (PROFILE_ATTRIBUTE_VALUES.has(body.toLowerCase())) return null;

    const direction = author && (this.selfIds.has(author) || author === this.currentUser) ? 'out' : 'in';
    const contactId = `adam4adam:${author}`;
    const id = el.getAttribute('data-message-id') || `dom-${author}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Try to extract timestamp from nearby time elements
    const timeEl = el.querySelector('[class*="time"], [class*="date"], time, .timestamp') ||
      el.closest('[class*="message"]')?.querySelector('[class*="time"], [class*="date"]');
    const timeText = timeEl?.textContent?.trim() || '';
    let timestamp = new Date().toISOString();
    if (timeText) {
      const parsed = Date.parse(timeText);
      if (!isNaN(parsed)) {
        timestamp = new Date(parsed).toISOString();
      } else {
        // A4A renders relative labels ("5 min ago", "2 hours ago") that
        // Date.parse cannot read. Previously those fell through to "now",
        // so every DOM-scraped message was stamped with the scrape time and
        // sorted to the top of the thread.
        const rel = parseRelativeTimeString(timeText);
        if (rel) timestamp = new Date(rel).toISOString();
      }
    }

    // Get avatar from nearby elements
    const container = el.closest('.message-container, .mail-message, [class*="message-row"], [class*="chat-item"]');
    const avatarEl = (container?.querySelector('.avatar img, .tooltip-inner img, [class*="avatar"] img, img[class*="photo"]') ||
      container?.querySelector('img')) as HTMLImageElement;
    let avatarUrl = avatarEl?.src || '';
    if (avatarUrl && !avatarUrl.startsWith('http')) avatarUrl = '';

    const message: UnifiedMessage = {
      id: `adam4adam:${id}`,
      platform: 'adam4adam',
      threadId: contactId,
      contactId,
      direction,
      body: body.slice(0, 500),
      timestamp,
      read: direction === 'out',
      metadata: { author, source: 'dom', timeText },
    };

    const contact: UnifiedContact | undefined = (direction === 'in' && author) ? {
      id: contactId,
      platform: 'adam4adam',
      platformUserId: author,
      displayName: author,
      profileUrl: `https://www.adam4adam.com/profile/${author}`,
      avatarUrl,
      lastSeen: new Date().toISOString(),
      metadata: {},
    } : undefined;

    return { message, contact };
    } catch (err) {
      log.debug('Skipped unparseable Adam4Adam DOM element:', err);
      return null;
    }
  }
}
