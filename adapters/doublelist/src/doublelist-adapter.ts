/**
 * doublelist-adapter.ts — DoubleList platform adapter.
 *
 * DoubleList uses server-rendered HTML with jQuery + Pusher for real-time.
 * Messages have data-mess-id, data-mess-channel, data-receiver-id attributes.
 * Notifications in .notification-in-app-message-popup elements.
 */

import { BaseAdapter, createDOMExtractor, walkPayload, extractTimestamp, extractMessageText } from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';

const LOG = '[Aggregaytor:DList]';

export class DoubleListAdapter extends BaseAdapter {
  readonly platform: Platform = 'doublelist';

  async init(): Promise<void> {
    console.log(`${LOG} Initializing...`);

    // DOM observation for server-rendered messages
    const cleanup = createDOMExtractor(document, {
      rootSelector: 'body',
      messageSelector: '[data-mess-id], .notification-in-app-message-popup, .view_message',
      onNewElements: (elements) => {
        const messages: UnifiedMessage[] = [];
        const contacts: UnifiedContact[] = [];
        for (const el of elements) {
          const result = this.parseMessageElement(el);
          if (result?.message) messages.push(result.message);
          if (result?.contact) contacts.push(result.contact);
        }
        if (messages.length) this.emit({ type: 'messages', payload: messages });
        if (contacts.length) this.emit({ type: 'contacts', payload: contacts });
      },
    });
    this.addCleanup(cleanup);

    // Also scan existing notifications on page load
    this.scanExistingMessages();

    // Intercept any fetch/XHR API calls
    this.setupNetworkInterception(window as Window & typeof globalThis);

    console.log(`${LOG} Initialized`);
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    return s.includes('doublelist.com') && (s.includes('/user_notifications') || s.includes('/messages') || s.includes('/api/'));
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    if (!payload || typeof payload !== 'object') return [];
    const messages: UnifiedMessage[] = [];

    walkPayload(payload, null, {
      onObject: (obj) => {
        const body = extractMessageText(obj);
        if (!body) return;
        const ts = extractTimestamp(obj);
        const senderId = String(obj.sender_id || obj.senderId || obj.from_id || obj.userId || '');
        const receiverId = String(obj.receiver_id || obj.receiverId || obj.to_id || '');
        const msgId = String(obj.id || obj.message_id || obj.mess_id || '');
        const channel = String(obj.mess_channel || obj.channel || obj.conversation_id || '');

        if (!senderId && !channel) return;

        messages.push({
          id: `doublelist:${msgId || `${channel}:${Date.now()}`}`,
          platform: 'doublelist',
          threadId: `doublelist:${channel || senderId}`,
          contactId: `doublelist:${senderId || channel}`,
          direction: receiverId && this.selfIds.has(receiverId) ? 'in' : 'out',
          body,
          timestamp: ts || new Date().toISOString(),
          read: false,
          metadata: { url, channel, senderId, receiverId },
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
        return this.parseApiResponse('[pusher]', parsed);
      }
    } catch {}
    return [];
  }

  private scanExistingMessages(): void {
    const elements = document.querySelectorAll('[data-mess-id], .notification-in-app-message-popup');
    const messages: UnifiedMessage[] = [];
    const contacts: UnifiedContact[] = [];
    for (const el of elements) {
      const result = this.parseMessageElement(el as Element);
      if (result?.message) messages.push(result.message);
      if (result?.contact) contacts.push(result.contact);
    }
    if (messages.length) {
      console.log(`${LOG} Scanned ${messages.length} existing messages`);
      this.emit({ type: 'messages', payload: messages });
    }
    if (contacts.length) this.emit({ type: 'contacts', payload: contacts });
  }

  private parseMessageElement(el: Element): { message?: UnifiedMessage; contact?: UnifiedContact } | null {
    const messId = el.getAttribute('data-mess-id');
    const channel = el.getAttribute('data-mess-channel') || '';
    const receiverId = el.getAttribute('data-receiver-id') || '';

    // Extract username from h5.m-0 text like "New message (Robert)"
    const h5 = el.querySelector('h5.m-0, h5');
    let username = '';
    if (h5) {
      const match = h5.textContent?.match(/\(([^)]+)\)/);
      username = match ? match[1].trim() : h5.textContent?.trim() || '';
    }

    // Extract message body from <p> sibling
    const bodyEl = el.querySelector('p') || el.querySelector('.notification-list-div p');
    const body = bodyEl?.textContent?.trim() || '';

    // Extract timestamp
    const timeEl = el.querySelector('.notification-time, .time-dropdown');
    const timeText = timeEl?.textContent?.trim() || '';

    // Extract avatar
    const avatarEl = el.querySelector('.notificationUser-img, img') as HTMLImageElement;
    const avatarUrl = avatarEl?.src || '';

    if (!body || body.length < 2) return null;

    const contactId = channel ? `doublelist:${channel}` : `doublelist:${receiverId || messId || 'unknown'}`;

    const message: UnifiedMessage = {
      id: `doublelist:${messId || `dom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`}`,
      platform: 'doublelist',
      threadId: contactId,
      contactId,
      direction: 'in', // notifications are always incoming
      body,
      timestamp: new Date().toISOString(), // DoubleList shows relative times
      read: false,
      metadata: { channel, receiverId, timeText },
    };

    const contact: UnifiedContact | undefined = username ? {
      id: contactId,
      platform: 'doublelist',
      platformUserId: channel || receiverId || messId || '',
      displayName: username,
      profileUrl: `https://doublelist.com/messages?lastMessageKey=${channel}`,
      avatarUrl,
      lastSeen: new Date().toISOString(),
      metadata: {},
    } : undefined;

    return { message, contact };
  }
}
