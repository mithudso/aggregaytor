/**
 * adam4adam-adapter.ts — Adam4Adam platform adapter.
 *
 * A4A uses data-author attributes on messages, /api/v2/ endpoints,
 * and a frontend-config meta tag with user info.
 * Unread counter in .unread-message-counter .number.
 */

import { BaseAdapter, createDOMExtractor, walkPayload, extractTimestamp, extractMessageText } from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';

const LOG = '[Aggregaytor:A4A]';

export class Adam4AdamAdapter extends BaseAdapter {
  readonly platform: Platform = 'adam4adam';
  private currentUser = '';

  async init(): Promise<void> {
    console.log(`${LOG} Initializing...`);
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.detectCurrentUser();

    // DOM observation for data-author message elements
    const cleanup = createDOMExtractor(document, {
      rootSelector: 'body',
      messageSelector: '[data-author], .message-item, .mail-message',
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

    // Scan existing messages
    this.scanExistingMessages();

    // Intercept fetch/XHR
    this.setupNetworkInterception(window as Window & typeof globalThis);

    console.log(`${LOG} Initialized. Current user: ${this.currentUser}`);
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    return s.includes('adam4adam.com') && (s.includes('/api/') || s.includes('/mailbox') || s.includes('/message'));
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];
    walkPayload(payload, null, {
      onObject: (obj) => {
        this.selfIds.detectFromPayload(obj);
        const body = extractMessageText(obj);
        if (!body) return;
        const ts = extractTimestamp(obj);

        const senderId = String(obj.senderId || obj.sender_id || obj.from || obj.author || obj.username || '');
        const recipientId = String(obj.recipientId || obj.recipient_id || obj.to || '');
        const msgId = String(obj.id || obj.message_id || obj.messageId || '');
        const direction = (senderId && (this.selfIds.has(senderId) || senderId === this.currentUser)) ? 'out' : 'in';
        const contactId = direction === 'out' ? recipientId : senderId;

        if (!contactId) return;

        messages.push({
          id: `adam4adam:${msgId || `${contactId}:${Date.now()}`}`,
          platform: 'adam4adam',
          threadId: `adam4adam:${contactId}`,
          contactId: `adam4adam:${contactId}`,
          direction,
          body,
          timestamp: ts || new Date().toISOString(),
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
    try {
      const meta = document.querySelector('meta[name="frontend-config"]');
      if (meta) {
        const config = JSON.parse(meta.getAttribute('content') || '{}');
        if (config.userId) { this.selfIds.ids.add(String(config.userId)); this.currentUser = String(config.userId); }
        if (config.username) { this.selfIds.ids.add(config.username); this.currentUser = this.currentUser || config.username; }
        if (config.profile_name) { this.selfIds.ids.add(config.profile_name); this.currentUser = this.currentUser || config.profile_name; }
      }
    } catch {}
  }

  private scanExistingMessages(): void {
    const elements = document.querySelectorAll('[data-author]');
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
    const author = el.getAttribute('data-author')?.replace(/:$/, '').trim();
    if (!author) return null; // skip elements without author — can't attribute them
    const body = el.textContent?.trim();
    if (!body || body.length < 2) return null;

    const direction = author && (this.selfIds.has(author) || author === this.currentUser) ? 'out' : 'in';
    const contactName = direction === 'in' ? (author || 'Unknown') : '';
    const contactId = `adam4adam:${author || 'unknown'}`;
    const id = el.getAttribute('data-message-id') || `dom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Get avatar from nearby elements
    const avatarEl = el.closest('.message-container, .mail-message')?.querySelector('.avatar img, .tooltip-inner img') as HTMLImageElement;
    const avatarUrl = avatarEl?.src || '';

    const message: UnifiedMessage = {
      id: `adam4adam:${id}`,
      platform: 'adam4adam',
      threadId: contactId,
      contactId,
      direction,
      body: body.slice(0, 2000),
      timestamp: new Date().toISOString(),
      read: direction === 'out',
      metadata: { author, source: 'dom' },
    };

    const contact: UnifiedContact | undefined = contactName ? {
      id: contactId,
      platform: 'adam4adam',
      platformUserId: author || '',
      displayName: contactName,
      profileUrl: `https://www.adam4adam.com/profile/${author || ''}`,
      avatarUrl,
      lastSeen: new Date().toISOString(),
      metadata: {},
    } : undefined;

    return { message, contact };
  }
}
