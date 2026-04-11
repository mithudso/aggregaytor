/**
 * gmail-adapter.ts — Gmail platform adapter.
 *
 * Uses DOM observation on mail.google.com to extract email threads.
 * Captures messages from the Gmail web interface.
 *
 * Note: InboxSDK requires registration at inboxsdk.com for an appId.
 * Until configured, falls back to basic DOM observation + Gmail API interception.
 */

import { BaseAdapter, walkPayload, extractTimestamp, extractMessageText } from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';

const LOG = '[Aggregaytor:Gmail]';

// Gmail API endpoints we intercept
const GMAIL_API_PATTERNS = [
  'mail.google.com/mail/u/',
  'gmail.googleapis.com',
  '/sync/',
  '/bv?',
];

export class GmailAdapter extends BaseAdapter {
  readonly platform: Platform = 'gmail';

  async init(): Promise<void> {
    console.log(`${LOG} Initializing...`);

    // Intercept Gmail's internal API calls
    this.setupNetworkInterception(window as Window & typeof globalThis);

    // DOM observation for email content
    this.observeEmailContent();

    console.log(`${LOG} Initialized`);
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    return GMAIL_API_PATTERNS.some(p => s.includes(p));
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    // Gmail's internal API uses a complex protobuf-like format
    // For now, we extract what we can from JSON responses
    if (!payload || typeof payload !== 'object') return [];
    const messages: UnifiedMessage[] = [];

    walkPayload(payload, null, {
      onObject: (obj) => {
        const body = extractMessageText(obj);
        if (!body || body.length < 3) return;
        const ts = extractTimestamp(obj);
        const from = String(obj.from || obj.sender || obj.fromAddress || '');
        const to = String(obj.to || obj.recipient || obj.toAddress || '');
        const subject = String(obj.subject || obj.title || '');
        const threadId = String(obj.threadId || obj.thread_id || obj.id || '');

        if (!from && !threadId) return;

        // Determine direction based on "me" in from field
        const direction = from.includes('@') && !to.includes('@') ? 'out' : 'in';
        const contactEmail = direction === 'in' ? from : to;

        messages.push({
          id: `gmail:${threadId || Date.now()}`,
          platform: 'gmail',
          threadId: `gmail:${threadId}`,
          contactId: `gmail:${contactEmail || threadId}`,
          direction,
          body: subject ? `${subject}: ${body.slice(0, 200)}` : body.slice(0, 500),
          timestamp: ts || new Date().toISOString(),
          read: false,
          metadata: { from, to, subject, url },
        });
      },
    });

    return messages;
  }

  protected parseWebSocketFrame(): UnifiedMessage[] {
    return [];
  }

  private observeEmailContent(): void {
    // Watch for email thread views opening
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;

          // Gmail message body containers
          const bodies = el.querySelectorAll('.a3s.aiL, [data-message-id], .ii.gt');
          for (const body of bodies) {
            const text = body.textContent?.trim();
            if (!text || text.length < 10) continue;

            // Extract sender from nearby elements
            const container = body.closest('[data-message-id], .gs');
            const senderEl = container?.querySelector('.gD, [email], .go') as HTMLElement;
            const sender = senderEl?.getAttribute('email') || senderEl?.textContent?.trim() || '';

            const threadEl = body.closest('[data-thread-perm-id], .nH');
            const threadId = threadEl?.getAttribute('data-thread-perm-id') || `dom-${Date.now()}`;

            if (sender) {
              this.emit({
                type: 'messages',
                payload: [{
                  id: `gmail:dom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  platform: 'gmail' as Platform,
                  threadId: `gmail:${threadId}`,
                  contactId: `gmail:${sender}`,
                  direction: 'in' as const,
                  body: text.slice(0, 500),
                  timestamp: new Date().toISOString(),
                  read: true,
                  metadata: { sender, source: 'dom' },
                }],
              });

              this.emit({
                type: 'contacts',
                payload: [{
                  id: `gmail:${sender}`,
                  platform: 'gmail' as Platform,
                  platformUserId: sender,
                  displayName: senderEl?.textContent?.trim() || sender.split('@')[0],
                  profileUrl: `https://mail.google.com`,
                  avatarUrl: '',
                  lastSeen: new Date().toISOString(),
                  metadata: { email: sender },
                }],
              });
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    this.addCleanup(() => observer.disconnect());
  }
}
