/**
 * gmail-adapter.ts — Gmail platform adapter.
 *
 * Uses DOM observation on mail.google.com to extract email threads.
 * Captures messages from the Gmail web interface.
 *
 * Note: InboxSDK requires registration at inboxsdk.com for an appId.
 * Until configured, falls back to basic DOM observation + Gmail API interception.
 */

import { BaseAdapter, walkPayload, extractTimestamp, extractMessageText, createLogger } from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';

// Level-gated logger. Bare console.* ran unconditionally inside a page we do
// not control and could not be silenced.
const log = createLogger('[Aggregaytor:Gmail]');

// Gmail API endpoints we intercept. Note the last two are bare path
// fragments — they are only ever tested AFTER the host check below.
const GMAIL_API_PATTERNS = [
  'mail.google.com/mail/u/',
  'gmail.googleapis.com',
  '/sync/',
  '/bv?',
];

/** Hosts whose responses may legitimately be parsed as Gmail data. */
const GMAIL_HOST_RE = /^(mail\.google\.com|gmail\.googleapis\.com)$/i;

/**
 * Test whether `url` resolves to a Gmail-owned host.
 *
 * Required because two of GMAIL_API_PATTERNS ("/sync/", "/bv?") are bare path
 * fragments that match on ANY host — so before this check, a request to
 * `https://evil.example/sync/x` made from the Gmail tab was intercepted and
 * its JSON parsed into the user's message store. Relative URLs resolve
 * against the page origin; anything unparseable is rejected.
 */
function isGmailHost(url: string): boolean {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    return GMAIL_HOST_RE.test(new URL(String(url), base).hostname);
  } catch {
    return false;
  }
}

export class GmailAdapter extends BaseAdapter {
  readonly platform: Platform = 'gmail';

  async init(): Promise<void> {
    log.info('Initializing...');

    // Intercept Gmail's internal API calls
    this.setupNetworkInterception(window as Window & typeof globalThis);

    // DOM observation for email content
    this.observeEmailContent();

    log.info('Initialized');
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    // Host first: the path-fragment patterns below match on any host.
    if (!isGmailHost(url)) return false;
    return GMAIL_API_PATTERNS.some(p => s.includes(p));
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    // Gmail's internal API uses a complex protobuf-like format
    // For now, we extract what we can from JSON responses
    if (!payload || typeof payload !== 'object') return [];
    const messages: UnifiedMessage[] = [];

    walkPayload(payload, null, {
      onObject: (obj) => {
        // Payload objects are untrusted. One unrenderable value — e.g. a
        // numeric timestamp outside the Date range, which makes the shared
        // extractTimestamp() throw `RangeError: Invalid time value` — must
        // not abort the rest of the walk and silently drop every message
        // later in the same response.
        try {
          this.visitPayloadObject(obj, url, messages);
        } catch (err) {
          log.debug('Skipped unparseable payload object:', err);
        }
      },
    });

    return messages;
  }

  /**
   * Inspect a single object node from an API payload, appending any message
   * it yields to `messages`.
   *
   * Split out of {@link parseApiResponse} so the walker can isolate a throw
   * to one node instead of losing the remainder of the response.
   */
  private visitPayloadObject(
    obj: Record<string, unknown>,
    url: string,
    messages: UnifiedMessage[],
  ): void {
    const body = extractMessageText(obj);
    if (!body || body.length < 3) return;
    const ts = extractTimestamp(obj);
    const from = String(obj.from || obj.sender || obj.fromAddress || '');
    const to = String(obj.to || obj.recipient || obj.toAddress || '');
    const subject = String(obj.subject || obj.title || '');
    const threadId = String(obj.threadId || obj.thread_id || obj.id || '');
    // Prefer a per-MESSAGE identifier. Keying solely on threadId gave every
    // message in a conversation the same document id, so a thread collapsed
    // to a single stored message.
    const messageId = String(obj.messageId || obj.message_id || obj.mid || obj.id || '');

    if (!from && !threadId) return;

    // Direction: outbound only when the sender is a known self address.
    // The previous test — "has an @ in `from` and none in `to`" — labelled
    // ordinary inbound mail as OUTBOUND, because most walked objects carry a
    // sender and no recipient field at all.
    const direction: 'in' | 'out' = from && this.selfIds.has(from) ? 'out' : 'in';
    const contactEmail = direction === 'in' ? from : to;

    messages.push({
      id: `gmail:${messageId || threadId || Date.now()}`,
      platform: 'gmail',
      threadId: `gmail:${threadId}`,
      contactId: `gmail:${contactEmail || threadId}`,
      direction,
      body: subject ? `${subject}: ${body.slice(0, 200)}` : body.slice(0, 500),
      timestamp: ts || new Date().toISOString(),
      read: false,
      metadata: { from, to, subject, url },
    });
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

    // `observeEmailContent()` is called synchronously from init(). If the
    // content script runs at document_start, document.body is still null and
    // `observer.observe(null, ...)` throws out of init(), aborting adapter
    // setup entirely (including the network interception installed above).
    const root = document.body || document.documentElement;
    if (!root) {
      log.warn('No document root yet; skipping DOM observation.');
      return;
    }
    observer.observe(root, { childList: true, subtree: true });
    this.addCleanup(() => observer.disconnect());
  }
}
