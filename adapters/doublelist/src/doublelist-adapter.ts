/**
 * doublelist-adapter.ts — DoubleList platform adapter.
 *
 * DoubleList (doublelist.com) is a server-rendered site with some JS.
 * Messages are in the DOM with class "notification-in-app-message".
 * Uses DOM-based extraction as primary, fetch interception as secondary.
 */

import { BaseAdapter, createDOMExtractor } from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage } from '@aggregaytor/adapter-core';

export class DoubleListAdapter extends BaseAdapter {
  readonly platform: Platform = 'doublelist';

  async init(): Promise<void> {
    // DOM observation for server-rendered messages
    if (this.config.observeDOM) {
      const cleanup = createDOMExtractor(document, {
        rootSelector: '.notification-in-app-message, .inbox-messages, .message-list',
        messageSelector: '.message, .notification-in-app-message',
        onNewElements: (elements) => {
          const messages = elements.map(el => this.parseMessageElement(el)).filter(Boolean) as UnifiedMessage[];
          if (messages.length) this.emit({ type: 'messages', payload: messages });
        },
      });
      this.addCleanup(cleanup);
    }

    // Also intercept any fetch/XHR API calls
    this.setupNetworkInterception(window as Window & typeof globalThis);
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    return s.includes('doublelist.com') && (s.includes('/api/') || s.includes('/message') || s.includes('/inbox'));
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    // DoubleList may use fetch for message loading — parse if JSON
    if (!payload || typeof payload !== 'object') return [];
    const messages: UnifiedMessage[] = [];
    const arr = Array.isArray(payload) ? payload : [payload];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const body = String(obj.body || obj.message || obj.text || '').trim();
      if (!body) continue;
      messages.push({
        id: `doublelist:${obj.id || obj.message_id || Date.now()}`,
        platform: 'doublelist',
        threadId: `doublelist:${obj.thread_id || obj.conversation_id || obj.sender_id || 'unknown'}`,
        contactId: `doublelist:${obj.sender_id || obj.from_id || obj.user_id || 'unknown'}`,
        direction: obj.is_mine || obj.isMine ? 'out' : 'in',
        body,
        timestamp: new Date(String(obj.created_at || obj.timestamp || '')).toISOString() || new Date().toISOString(),
        read: !!obj.read,
        metadata: { url },
      });
    }
    return messages;
  }

  protected parseWebSocketFrame(): UnifiedMessage[] {
    return []; // DoubleList doesn't use WebSocket
  }

  private parseMessageElement(el: Element): UnifiedMessage | null {
    const body = el.textContent?.trim();
    if (!body || body.length < 2) return null;

    const id = el.getAttribute('data-message-id') || el.getAttribute('data-id') || `dom-${Date.now()}-${Math.random()}`;

    return {
      id: `doublelist:${id}`,
      platform: 'doublelist',
      threadId: `doublelist:dom-thread`,
      contactId: `doublelist:dom-contact`,
      direction: 'in',
      body: body.slice(0, 2000),
      timestamp: new Date().toISOString(),
      read: false,
      metadata: { source: 'dom' },
    };
  }
}
