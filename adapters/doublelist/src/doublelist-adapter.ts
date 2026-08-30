/**
 * doublelist-adapter.ts — DoubleList platform adapter.
 *
 * DoubleList is a classifieds site (Craigslist personals replacement).
 * Messages come through both in-app notifications and email-routed replies.
 * The site uses server-rendered HTML with jQuery + Pusher for real-time.
 *
 * Key DOM selectors:
 *  - [data-mess-id] — message elements with unique ID
 *  - [data-mess-channel] — conversation channel ID
 *  - [data-receiver-id] — recipient user ID
 *  - .notification-in-app-message-popup — notification containers
 *  - .notificationUser-img — avatar images
 *  - .notification-time — timestamp elements
 *  - h5 with (username) pattern — sender name
 */

import {
  BaseAdapter,
  createDOMExtractor,
  walkPayload,
  extractTimestamp,
  extractMessageText,
  createLogger,
} from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';

const log = createLogger('[Aggregaytor:DList]');

/** Hosts whose responses may legitimately be parsed as DoubleList data. */
const DOUBLELIST_HOST_RE = /(^|\.)doublelist\.com$/i;

/**
 * Test whether `url` resolves to a DoubleList-owned host.
 *
 * A bare `url.includes('doublelist.com')` test also accepts third-party URLs
 * that merely mention the domain (`https://evil.example/?ref=doublelist.com`),
 * letting anything running on the page feed forged JSON into the user's
 * message and contact store. Relative URLs resolve against the page origin;
 * anything unparseable is rejected.
 */
function isDoubleListHost(url: string): boolean {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    return DOUBLELIST_HOST_RE.test(new URL(String(url), base).hostname);
  } catch {
    return false;
  }
}

export class DoubleListAdapter extends BaseAdapter {
  readonly platform: Platform = 'doublelist';
  private currentUser = '';
  private seenMessageIds = new Set<string>();

  async init(): Promise<void> {
    log.info('Initializing...');
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.detectCurrentUser();

    const cleanup = createDOMExtractor(document, {
      rootSelector: 'body',
      messageSelector: '[data-mess-id], .notification-in-app-message-popup, .view_message, [class*="message-item"]',
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

    this.scanExistingMessages();
    this.setupNetworkInterception(window as Window & typeof globalThis);
    log.info(`Initialized. Self IDs: ${[...this.selfIds.ids].join(', ')}`);
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    if (!s.includes('doublelist.com')) return false;
    if (s.includes('/static/') || s.includes('.css') || s.includes('.js') ||
        s.includes('.png') || s.includes('.jpg') || s.includes('.svg') || s.includes('.woff')) return false;
    // Host check so look-alike third-party URLs cannot inject forged
    // payloads. See isDoubleListHost().
    return isDoubleListHost(url);
  }

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
   */
  private visitPayloadObject(
    obj: Record<string, unknown>,
    url: string,
    messages: UnifiedMessage[],
    contacts: UnifiedContact[],
  ): void {
    this.selfIds.detectFromPayload(obj);

    const userId = String(obj.userId || obj.user_id || obj.senderId || obj.sender_id || obj.from || obj.author || obj.username || '');
    if (userId && !this.selfIds.has(userId)) {
      const displayName = String(obj.displayName || obj.name || obj.username || '').trim();
      let avatarUrl = '';
      for (const key of ['avatar', 'avatarUrl', 'photo', 'photoUrl', 'image', 'thumbnail']) {
        const v = obj[key];
        if (typeof v === 'string' && v.startsWith('http')) { avatarUrl = v; break; }
      }
      if (displayName || avatarUrl) {
        contacts.push({
          id: `doublelist:${userId}`, platform: 'doublelist', platformUserId: userId,
          displayName, profileUrl: `https://doublelist.com/profile/${userId}`,
          avatarUrl, lastSeen: new Date().toISOString(), metadata: {},
        });
      }
    }

    const body = extractMessageText(obj);
    if (!body || body.length < 2) return;
    const ts = extractTimestamp(obj);
    const senderId = String(obj.senderId || obj.sender_id || obj.from || obj.author || '');
    const recipientId = String(obj.recipientId || obj.recipient_id || obj.to || '');
    const channel = String(obj.channel || obj.conversation_id || obj.thread_id || '');
    const msgId = String(obj.id || obj.message_id || obj.messageId || `${senderId || channel}:${ts || Date.now()}`);
    const direction = (senderId && (this.selfIds.has(senderId) || senderId === this.currentUser)) ? 'out' : 'in';
    const contactKey = direction === 'out' ? recipientId : senderId;
    // NOTE: when a channel is present this keys the thread by channel, while
    // the contact pushed above is keyed by userId — see the review notes; the
    // two identities do not join today.
    const contactId = channel ? `doublelist:${channel}` : `doublelist:${contactKey || 'unknown'}`;

    messages.push({
      id: `doublelist:${msgId}`, platform: 'doublelist', threadId: contactId, contactId,
      direction, body: body.slice(0, 500), timestamp: ts || new Date().toISOString(),
      read: direction === 'out', metadata: { senderId, recipientId, channel, url },
    });
  }

  protected parseWebSocketFrame(data: string | ArrayBuffer): UnifiedMessage[] {
    const text = typeof data === 'string' ? data : '';
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return this.parseApiResponse('[ws]', parsed);
    } catch {}
    return [];
  }

  private dedup(messages: UnifiedMessage[]): UnifiedMessage[] {
    const result = messages.filter(m => {
      if (this.seenMessageIds.has(m.id)) return false;
      const ck = `${m.contactId}|${m.body.slice(0, 80)}|${m.timestamp.slice(0, 16)}`;
      if (this.seenMessageIds.has(ck)) return false;
      this.seenMessageIds.add(m.id);
      this.seenMessageIds.add(ck);
      return true;
    });
    if (this.seenMessageIds.size > 3000) {
      const arr = [...this.seenMessageIds];
      this.seenMessageIds = new Set(arr.slice(-2000));
    }
    return result;
  }

  private detectCurrentUser(): void {
    try {
      const links = document.querySelectorAll('a[href*="/profile/"], [class*="my-profile"], [class*="user-name"]');
      for (const el of links) {
        const href = (el as HTMLAnchorElement).href || '';
        const match = href.match(/\/profile\/([^/?#]+)/);
        if (match) { this.selfIds.ids.add(match[1]); this.currentUser = this.currentUser || match[1]; }
      }
      for (const key of Object.keys(localStorage)) {
        if (!/user|auth|session/i.test(key)) continue;
        try {
          const val = localStorage.getItem(key);
          if (!val || val.length > 1000) continue;
          const data = JSON.parse(val);
          if (data && typeof data === 'object') {
            for (const k of ['userId', 'username', 'id']) {
              if (data[k] && typeof data[k] === 'string') { this.selfIds.ids.add(data[k]); this.currentUser = this.currentUser || data[k]; }
            }
          }
        } catch {}
      }
    } catch {}
  }

  private scanExistingMessages(): void {
    const elements = document.querySelectorAll('[data-mess-id], .notification-in-app-message-popup, .view_message');
    const messages: UnifiedMessage[] = [];
    const contacts: UnifiedContact[] = [];
    for (const el of elements) {
      const result = this.parseMessageElement(el);
      if (result?.message) messages.push(result.message);
      if (result?.contact) contacts.push(result.contact);
    }
    if (messages.length) {
      log.info(`Scanned ${messages.length} existing DOM messages`);
      this.emit({ type: 'messages', payload: this.dedup(messages) });
    }
    if (contacts.length) this.emit({ type: 'contacts', payload: contacts });
  }

  private parseMessageElement(el: Element): { message?: UnifiedMessage; contact?: UnifiedContact } | null {
    const messId = el.getAttribute('data-mess-id');
    const channel = el.getAttribute('data-mess-channel') || '';
    const receiverId = el.getAttribute('data-receiver-id') || '';

    const h5 = el.querySelector('h5.m-0, h5');
    let username = '';
    if (h5) {
      const match = h5.textContent?.match(/\(([^)]+)\)/);
      username = match ? match[1].trim() : h5.textContent?.trim() || '';
    }

    const bodyEl = el.querySelector('p') || el.querySelector('.notification-list-div p') || el.querySelector('[class*="message-body"]');
    const body = bodyEl?.textContent?.trim() || '';
    if (!body || body.length < 2) return null;

    const timeEl = el.querySelector('.notification-time, .time-dropdown, [class*="time"], time');
    const timeText = timeEl?.textContent?.trim() || '';
    let timestamp = new Date().toISOString();
    if (timeText) {
      const parsed = Date.parse(timeText);
      if (!isNaN(parsed)) timestamp = new Date(parsed).toISOString();
      else {
        const rel = this.parseRelativeTime(timeText);
        if (rel) timestamp = rel;
      }
    }

    const direction = username && (this.selfIds.has(username) || username === this.currentUser) ? 'out' : 'in';
    const contactId = channel ? `doublelist:${channel}` : `doublelist:${receiverId || username || messId || 'unknown'}`;
    const id = messId || `dom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const container = el.closest('.notification-in-app-message-popup, .view_message, [class*="message"]');
    const avatarEl = (container?.querySelector('.notificationUser-img, [class*="avatar"] img, img') || null) as HTMLImageElement;
    let avatarUrl = avatarEl?.src || '';
    if (avatarUrl && !avatarUrl.startsWith('http')) avatarUrl = '';

    const message: UnifiedMessage = {
      id: `doublelist:${id}`, platform: 'doublelist', threadId: contactId, contactId,
      direction, body: body.slice(0, 500), timestamp, read: direction === 'out',
      metadata: { channel, receiverId, timeText, username },
    };

    const contact: UnifiedContact | undefined = (direction === 'in' && username) ? {
      id: contactId, platform: 'doublelist', platformUserId: username,
      displayName: username, profileUrl: `https://doublelist.com/profile/${username}`,
      avatarUrl, lastSeen: new Date().toISOString(), metadata: {},
    } : undefined;

    return { message, contact };
  }

  private parseRelativeTime(text: string): string | null {
    if (!text) return null;
    const t = text.trim().toLowerCase();
    const now = Date.now();
    if (t.includes('just now') || t === 'now') return new Date(now).toISOString();
    if (t.includes('yesterday')) return new Date(now - 86400000).toISOString();
    // Unit alternatives MUST be ordered longest-prefix-first. The previous
    // order put the bare `m` ahead of `mo`/`month`, so JS alternation matched
    // the `m` in "months" first and "5 months ago" was resolved as 5 MINUTES
    // ago — off by four orders of magnitude on every month-old message.
    const match = t.match(/(\d+)\s*(sec|min|mo(?:nth)?|hour|day|week|year|s|m|h|d|w|y)/i);
    if (!match) return null;
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith('s')) ms = num * 1000;
    else if (unit === 'm' || unit.startsWith('min')) ms = num * 60_000;
    else if (unit.startsWith('h')) ms = num * 3600_000;
    else if (unit.startsWith('d')) ms = num * 86400_000;
    else if (unit.startsWith('w')) ms = num * 604800_000;
    else if (unit.startsWith('mo')) ms = num * 2592000_000;
    else if (unit.startsWith('y')) ms = num * 31536000_000;
    return new Date(now - ms).toISOString();
  }
}
