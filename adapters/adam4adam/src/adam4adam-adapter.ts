/**
 * adam4adam-adapter.ts — Adam4Adam platform adapter.
 *
 * Adam4Adam uses data-author attributes on message elements.
 * Hybrid approach: DOM extraction (primary) + fetch interception (secondary).
 */

import { BaseAdapter, createDOMExtractor, walkPayload, extractTimestamp, extractMessageText } from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage } from '@aggregaytor/adapter-core';

export class Adam4AdamAdapter extends BaseAdapter {
  readonly platform: Platform = 'adam4adam';
  private currentUser = '';

  async init(): Promise<void> {
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.detectCurrentUser();

    // DOM observation for data-author message elements
    if (this.config.observeDOM) {
      const cleanup = createDOMExtractor(document, {
        rootSelector: '.chat-messages, .message-list, [class*="message"]',
        messageSelector: '[data-author]',
        onNewElements: (elements) => {
          const messages = elements.map(el => this.parseMessageElement(el)).filter(Boolean) as UnifiedMessage[];
          if (messages.length) this.emit({ type: 'messages', payload: messages });
        },
      });
      this.addCleanup(cleanup);
    }

    this.setupNetworkInterception(window as Window & typeof globalThis);
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    return s.includes('adam4adam.com') && (s.includes('/api/') || s.includes('/message') || s.includes('/chat'));
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

        const senderId = String(obj.senderId || obj.sender_id || obj.from || obj.author || '');
        const recipientId = String(obj.recipientId || obj.recipient_id || obj.to || '');
        const msgId = String(obj.id || obj.message_id || obj.messageId || '');
        const direction = senderId && this.selfIds.has(senderId) ? 'out' : 'in';
        const contactId = direction === 'out' ? recipientId : senderId;

        messages.push({
          id: `adam4adam:${msgId || `${contactId}:${timestamp}`}`,
          platform: 'adam4adam',
          threadId: `adam4adam:${contactId || 'unknown'}`,
          contactId: `adam4adam:${contactId || 'unknown'}`,
          direction,
          body,
          timestamp,
          read: direction === 'out',
          metadata: { senderId, recipientId, url },
        });
      },
    });
    return messages;
  }

  protected parseWebSocketFrame(): UnifiedMessage[] {
    return [];
  }

  private detectCurrentUser(): void {
    // A4A embeds user config in a meta tag
    try {
      const meta = document.querySelector('meta[name="frontend-config"]');
      if (meta) {
        const config = JSON.parse(meta.getAttribute('content') || '{}');
        if (config.userId) {
          this.selfIds.ids.add(String(config.userId));
          this.currentUser = String(config.userId);
        }
        if (config.username) {
          this.selfIds.ids.add(config.username);
          this.currentUser = this.currentUser || config.username;
        }
      }
    } catch {
      // meta tag not present or not JSON
    }
  }

  private parseMessageElement(el: Element): UnifiedMessage | null {
    const author = el.getAttribute('data-author')?.replace(/:$/, '').trim();
    const body = el.textContent?.trim();
    if (!body || body.length < 2) return null;

    const direction = author && (this.selfIds.has(author) || author === this.currentUser) ? 'out' : 'in';
    const id = el.getAttribute('data-message-id') || el.getAttribute('data-id') || `dom-${Date.now()}-${Math.random()}`;

    return {
      id: `adam4adam:${id}`,
      platform: 'adam4adam',
      threadId: `adam4adam:${author || 'unknown'}`,
      contactId: `adam4adam:${author || 'unknown'}`,
      direction,
      body: body.slice(0, 2000),
      timestamp: new Date().toISOString(),
      read: false,
      metadata: { author, source: 'dom' },
    };
  }
}
