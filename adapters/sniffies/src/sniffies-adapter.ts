/**
 * sniffies-adapter.ts — Sniffies platform adapter.
 *
 * Intercepts ALL Sniffies network traffic (fetch, XHR, WebSocket),
 * extracts message-like objects, and normalizes to UnifiedMessage format.
 */

import {
  BaseAdapter,
  walkPayload,
} from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';
import { parseSocketIOFrame } from './ws-parser.js';
import { findLikelyProfileId, normalizeProfileId, extractProfileIdFromUrl } from './profile-resolver.js';

const LOG = '[Aggregaytor:Sniffies]';

// Keys that indicate a timestamp (case-insensitive match via normalizeKey)
const TS_PATTERNS = /^(createdat|sentat|timestamp|time|updatedat|date|lastmessageat|lastchatat|latestmessageat|ts|sent_at|created_at|updated_at)$/i;

// Keys that indicate message body text
const BODY_KEYS = ['body', 'text', 'message', 'content', 'msg', 'snippet', 'messageText', 'messageBody', 'lastMessage', 'preview'];

// Keys indicating direction
const OUT_KEYS = ['fromme', 'ismine', 'mine', 'sentbyme', 'outgoing', 'isoutgoing', 'mymessage'];
const IN_KEYS = ['incoming', 'isincoming', 'fromthem', 'received', 'isreceived', 'theirmessage'];

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
  // Priority keys first
  for (const key of ['createdAt', 'sentAt', 'timestamp', 'time', 'updatedAt', 'date', 'lastMessageAt', 'ts', 'created_at', 'sent_at']) {
    if (key in obj) {
      const ts = parseTimestamp(obj[key]);
      if (ts) return ts;
    }
  }
  // Fallback: any key ending in time/date/at/ts
  let latest = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (TS_PATTERNS.test(normalizeKey(key))) {
      const ts = parseTimestamp(value);
      if (ts > latest) latest = ts;
    }
  }
  return latest;
}

function extractBody(obj: Record<string, unknown>): string {
  for (const key of BODY_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length >= 1) return value.trim();
  }
  // Also check normalized keys
  for (const [key, value] of Object.entries(obj)) {
    const nk = normalizeKey(key);
    if ((nk === 'body' || nk === 'text' || nk === 'message' || nk === 'content' || nk === 'msg') && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function detectDirection(obj: Record<string, unknown>, selfIds: Set<string>): 'in' | 'out' {
  for (const [key, value] of Object.entries(obj)) {
    const k = normalizeKey(key);
    if (value === true) {
      if (OUT_KEYS.includes(k)) return 'out';
      if (IN_KEYS.includes(k)) return 'in';
    }
    if (typeof value === 'string' && ['direction', 'messagedirection', 'type', 'msgtype'].includes(k)) {
      const s = value.toLowerCase();
      if (/(out|sent|fromme|mine)/.test(s)) return 'out';
      if (/(in|received|fromthem)/.test(s)) return 'in';
    }
  }
  // Check sender against self IDs
  const senderId = normalizeProfileId(String(obj.senderId || obj.sender_id || obj.from || obj.fromId || obj.from_id || ''));
  if (senderId && selfIds.has(senderId)) return 'out';
  return 'in';
}

export class SniffiesAdapter extends BaseAdapter {
  readonly platform: Platform = 'sniffies';
  private storageTimer: ReturnType<typeof setInterval> | null = null;
  private captureCount = 0;

  async init(): Promise<void> {
    console.log(`${LOG} Initializing adapter...`);

    // Seed self-IDs from window globals
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.seedSelfIdsFromPage();

    // Set up network interception
    this.setupNetworkInterception(window as Window & typeof globalThis);

    // Periodic localStorage scan
    this.storageTimer = setInterval(() => this.scanStorage(), 60_000);
    this.scanStorage();

    console.log(`${LOG} Adapter initialized. Self IDs:`, [...this.selfIds.ids]);
  }

  async destroy(): Promise<void> {
    if (this.storageTimer) {
      clearInterval(this.storageTimer);
      this.storageTimer = null;
    }
    await super.destroy();
  }

  protected shouldInterceptUrl(url: string): boolean {
    // Intercept ALL sniffies.com traffic, not just /api/
    const s = String(url).toLowerCase();
    return s.includes('sniffies.com') || s.includes('sniffies');
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];
    const contacts: UnifiedContact[] = [];
    const contextId = this.getContextProfileId();

    walkPayload(payload, contextId, {
      onObject: (obj, ctx, _depth) => {
        // Always try to detect self IDs
        this.selfIds.detectFromPayload(obj);
        this.detectSelfIdsFromObj(obj);

        // Look for message-like objects (has body text + some kind of ID or timestamp)
        const body = extractBody(obj);
        const ts = extractTimestampFromObj(obj);
        const profileId = findLikelyProfileId(obj, ctx || '');

        if (body && (ts || profileId)) {
          const direction = detectDirection(obj, this.selfIds.ids);
          const msgId = String(obj.id || obj._id || obj.messageId || obj.message_id || `${profileId}:${ts || Date.now()}`);
          const timestamp = ts ? new Date(ts).toISOString() : new Date().toISOString();

          messages.push({
            id: `sniffies:${msgId}`,
            platform: 'sniffies',
            threadId: `sniffies:${profileId || 'unknown'}`,
            contactId: `sniffies:${profileId || 'unknown'}`,
            direction,
            body,
            timestamp,
            read: direction === 'out',
            metadata: { profileId, url },
          });
        }

        // Also extract contact-like objects (has displayName/username + profileId)
        const displayName = String(obj.displayName || obj.username || obj.name || obj.label || '').trim();
        if (profileId && displayName && displayName !== profileId) {
          contacts.push({
            id: `sniffies:${profileId}`,
            platform: 'sniffies',
            platformUserId: profileId,
            displayName,
            profileUrl: `https://sniffies.com/profile/${profileId}`,
            avatarUrl: String(obj.avatar || obj.avatarUrl || obj.photo || obj.image || ''),
            lastSeen: ts ? new Date(ts).toISOString() : new Date().toISOString(),
            metadata: {},
          });
        }
      },
    });

    if (messages.length) {
      this.captureCount += messages.length;
      console.log(`${LOG} Captured ${messages.length} messages from ${url} (total: ${this.captureCount})`);
    }
    if (contacts.length) {
      console.log(`${LOG} Captured ${contacts.length} contacts from ${url}`);
      this.emit({ type: 'contacts', payload: contacts });
    }

    return messages;
  }

  protected parseWebSocketFrame(data: string | ArrayBuffer): UnifiedMessage[] {
    const text = typeof data === 'string' ? data : '';
    if (!text) return [];

    const parsed = parseSocketIOFrame(text);
    if (!parsed) return [];

    console.log(`${LOG} WebSocket frame parsed:`, typeof parsed, Array.isArray(parsed) ? 'array' : 'object');
    return this.parseApiResponse('[ws]', parsed);
  }

  private getContextProfileId(): string | null {
    try {
      return extractProfileIdFromUrl(window.location.href) || null;
    } catch {
      return null;
    }
  }

  private seedSelfIdsFromPage(): void {
    // Try to find self ID from page globals that Sniffies sets
    try {
      const w = window as any;
      for (const key of ['__sniffies_user_id', '__user', 'userId', 'currentUserId', 'myProfileId', 'selfId']) {
        const val = w[key];
        if (val && typeof val === 'string') {
          const id = normalizeProfileId(val);
          if (id) this.selfIds.ids.add(id);
        }
      }
      // Check for React fiber state
      const root = document.getElementById('root') || document.getElementById('app');
      if (root && (root as any)._reactRootContainer) {
        console.log(`${LOG} React root detected, will capture self ID from API responses`);
      }
    } catch {
      // ignore
    }
  }

  private detectSelfIdsFromObj(obj: Record<string, unknown>): void {
    // Sniffies-specific self ID patterns
    for (const [key, value] of Object.entries(obj)) {
      const k = normalizeKey(key);
      if (['selfid', 'myid', 'myprofileid', 'currentuserid', 'viewerid', 'ownerid', 'loggedinuserid'].includes(k)) {
        const id = normalizeProfileId(String(value || ''));
        if (id) {
          this.selfIds.ids.add(id);
        }
      }
    }
    // Check for isMe: true pattern
    if (obj.isMe === true || obj.isSelf === true || obj.mine === true) {
      const id = normalizeProfileId(String(obj.id || obj._id || obj.profileId || obj.userId || ''));
      if (id) this.selfIds.ids.add(id);
    }
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
            if (messages.length) {
              this.emit({ type: 'messages', payload: messages });
            }
          }
        } catch {
          // not JSON or too large
        }
      }
    } catch {
      // localStorage not available
    }
  }
}
