/**
 * grindr-adapter.ts — Grindr Web platform adapter.
 *
 * Grindr Web (web.grindr.com) is a React/Vite SPA.
 * API endpoints: /v3/inbox, /v4/chat/conversation/{id}
 * WebSocket: /v1/ws
 *
 * Key message fields: isFromMe, conversationId, profileId,
 * messageId, body, text, timestamp, messageType, senderId.
 */

import {
  BaseAdapter,
  walkPayload,
  extractTimestamp,
  extractMessageText,
} from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage } from '@aggregaytor/adapter-core';

const GRINDR_API_PATTERNS = [
  '/v3/inbox',
  '/v4/chat/conversation',
  '/v1/inbox/conversation',
];

export class GrindrAdapter extends BaseAdapter {
  readonly platform: Platform = 'grindr';

  async init(): Promise<void> {
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.setupNetworkInterception(window as Window & typeof globalThis);
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    if (!s.includes('grindr.com')) return false;
    return GRINDR_API_PATTERNS.some(pattern => s.includes(pattern));
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];

    walkPayload(payload, null, {
      onObject: (obj, _ctx, _depth) => {
        this.selfIds.detectFromPayload(obj);

        const body = extractMessageText(obj);
        if (!body) return;

        const timestamp = extractTimestamp(obj);
        if (!timestamp) return;

        const conversationId = String(obj.conversationId || obj.conversation_id || '');
        const profileId = String(obj.profileId || obj.senderId || obj.sender_id || '');
        const messageId = String(obj.messageId || obj.message_id || obj.id || '');

        if (!conversationId && !profileId) return;

        // Grindr uses isFromMe boolean for direction
        let direction: 'in' | 'out' = 'in';
        if (obj.isFromMe === true || obj.is_from_me === true) {
          direction = 'out';
        } else if (obj.isFromMe === false || obj.is_from_me === false) {
          direction = 'in';
        } else if (profileId && this.selfIds.has(profileId)) {
          direction = 'out';
        }

        const contactId = direction === 'out'
          ? `grindr:${conversationId || profileId}`
          : `grindr:${profileId || conversationId}`;

        messages.push({
          id: `grindr:${messageId || `${conversationId}:${timestamp}`}`,
          platform: 'grindr',
          threadId: `grindr:${conversationId || profileId}`,
          contactId,
          direction,
          body,
          timestamp,
          read: direction === 'out',
          metadata: {
            conversationId,
            profileId,
            messageType: String(obj.messageType || obj.type || ''),
            url,
          },
        });
      },
    });

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
