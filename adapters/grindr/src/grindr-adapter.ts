/**
 * grindr-adapter.ts — Grindr Web platform adapter.
 *
 * Grindr Web (web.grindr.com) is a React/Vite SPA.
 * API: /v3/inbox, /v4/chat/conversation/{id}, /v1/inbox/conversation
 * WebSocket: /v1/ws
 *
 * Message fields: isFromMe, conversationId, profileId, messageId, body, text, timestamp
 */

import {
  BaseAdapter,
  walkPayload,
} from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';

const LOG = '[Aggregaytor:Grindr]';

const GRINDR_API_PATTERNS = [
  '/v3/inbox',
  '/v4/chat/conversation',
  '/v1/inbox/conversation',
  '/v1/ws',
  '/chat/',
  '/inbox',
];

const BODY_KEYS = ['body', 'text', 'message', 'content', 'snippet', 'messageBody', 'lastMessage', 'preview'];

function parseTs(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') { const p = Date.parse(value); return isNaN(p) ? 0 : p; }
  return 0;
}

function extractBody(obj: Record<string, unknown>): string {
  for (const key of BODY_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length >= 1) return value.trim();
  }
  return '';
}

export class GrindrAdapter extends BaseAdapter {
  readonly platform: Platform = 'grindr';
  private captureCount = 0;

  async init(): Promise<void> {
    console.log(`${LOG} Initializing adapter...`);
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.setupNetworkInterception(window as Window & typeof globalThis);
    console.log(`${LOG} Adapter initialized. Self IDs:`, [...this.selfIds.ids]);
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    // Intercept all grindr.com API traffic
    return s.includes('grindr.com');
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];
    const contacts: UnifiedContact[] = [];

    walkPayload(payload, null, {
      onObject: (obj, _ctx, _depth) => {
        this.selfIds.detectFromPayload(obj);

        const body = extractBody(obj);
        const conversationId = String(obj.conversationId || obj.conversation_id || '');
        const profileId = String(obj.profileId || obj.senderId || obj.sender_id || '');
        const messageId = String(obj.messageId || obj.message_id || obj.id || obj.chatMessageId || '');

        // Extract timestamp
        let ts = parseTs(obj.timestamp || obj.createdAt || obj.created_at || obj.sentAt || obj.sent_at || obj.date || obj.ts);

        // Need body text or at least a conversation/profile context
        if (body && (conversationId || profileId || ts)) {
          // Direction: Grindr uses isFromMe boolean
          let direction: 'in' | 'out' = 'in';
          if (obj.isFromMe === true || obj.is_from_me === true) {
            direction = 'out';
          } else if (profileId && this.selfIds.has(profileId)) {
            direction = 'out';
          }

          const contactKey = direction === 'out'
            ? (conversationId || profileId)
            : (profileId || conversationId);

          if (!ts) ts = Date.now();

          messages.push({
            id: `grindr:${messageId || `${contactKey}:${ts}`}`,
            platform: 'grindr',
            threadId: `grindr:${conversationId || profileId || 'unknown'}`,
            contactId: `grindr:${contactKey || 'unknown'}`,
            direction,
            body,
            timestamp: new Date(ts).toISOString(),
            read: direction === 'out',
            metadata: { conversationId, profileId, messageType: String(obj.messageType || obj.type || ''), url },
          });
        }

        // Extract contact info — from any object with a profile ID
        if (profileId) {
          const displayName = String(obj.displayName || obj.name || obj.username || '').trim();
          const photoHash = String(obj.photoHash || obj.profileImageMediaHash || obj.mediahash || obj.primaryPhotoHash || '');
          // Grindr CDN: https://cdns.grindr.com/images/profile/1024x1024/{hash}
          const avatarUrl = photoHash
            ? `https://cdns.grindr.com/images/profile/1024x1024/${photoHash}`
            : String(obj.avatar || obj.avatarUrl || obj.photoUrl || '');
          const md: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(obj)) {
            const k = key.toLowerCase();
            if (typeof value === 'string' && value.length < 100) {
              if (/bodytype|build/.test(k)) md.bodyType = value;
              if (/position|tribe/.test(k)) md.position = value;
              if (k === 'age' || k === 'showage') md.age = value;
              if (/ethnicity/.test(k)) md.ethnicity = value;
              if (/height/.test(k)) md.height = value;
              if (/distance/.test(k)) md.distance = value;
            }
          }
          contacts.push({
            id: `grindr:${profileId}`,
            platform: 'grindr',
            platformUserId: profileId,
            displayName,
            profileUrl: `https://web.grindr.com/chat/${conversationId || profileId}`,
            avatarUrl,
            lastSeen: ts ? new Date(ts).toISOString() : new Date().toISOString(),
            metadata: md,
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
    if (typeof data !== 'string') return [];
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') {
        return this.parseApiResponse('[ws]', parsed);
      }
    } catch {
      // not JSON
    }
    return [];
  }
}
