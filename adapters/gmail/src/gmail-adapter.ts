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

  /**
   * Bring the adapter online: install network interception for Gmail's internal
   * API, then start the DOM MutationObserver for rendered email content. Called
   * once by the content-script bootstrap. Both mechanisms feed the same
   * message/contact store, covering API responses and cached/pre-rendered
   * threads respectively.
   */
  async init(): Promise<void> {
    log.info('Initializing...');

    // Intercept Gmail's internal API calls
    this.setupNetworkInterception(window as Window & typeof globalThis);

    // DOM observation for email content
    this.observeEmailContent();

    log.info('Initialized');
  }

  /**
   * Gate which intercepted requests are parsed as Gmail data.
   *
   * Host-anchored FIRST: two of {@link GMAIL_API_PATTERNS} (`/sync/`, `/bv?`)
   * are bare path fragments that match on any host, so {@link isGmailHost} must
   * reject non-Gmail origins before the pattern test — otherwise a third-party
   * request from the Gmail tab could be parsed into the store.
   *
   * @param url - The request URL seen by the network interceptor.
   * @returns `true` only for Gmail-owned hosts hitting a known API pattern.
   */
  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    // Host first: the path-fragment patterns below match on any host.
    if (!isGmailHost(url)) return false;
    return GMAIL_API_PATTERNS.some(p => s.includes(p));
  }

  /**
   * Extract Gmail messages from an intercepted API payload.
   *
   * Gmail's internal API uses a protobuf-like JSON shape with no stable schema,
   * so we {@link walkPayload}-traverse it and pull messages from whatever object
   * nodes carry recognisable fields (body text, from/to, subject, ids). The
   * parse contract: non-object payloads and nodes without usable fields yield
   * nothing, and a throw in any single node is isolated so it cannot abort the
   * remainder of the walk.
   *
   * @param url     - Source URL, recorded in message metadata.
   * @param payload - The parsed JSON body; may be any shape.
   * @returns The messages extracted from this payload (possibly empty).
   */
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

  /**
   * Parse a WebSocket frame — always returns `[]`.
   *
   * Gmail delivers mail data over its REST/long-poll API, not WebSockets, so
   * there is nothing to parse here. Present only to satisfy the
   * {@link BaseAdapter} contract.
   *
   * @returns An empty array (always).
   */
  protected parseWebSocketFrame(): UnifiedMessage[] {
    return [];
  }

  /**
   * Watch the Gmail DOM for opened email threads and extract their content.
   *
   * Gmail is an SPA that renders message bodies into the DOM after XHR fetches;
   * a {@link MutationObserver} catches those nodes and emits `messages` and
   * `contacts` events, covering threads that never appear as a cleanly parseable
   * API response. Each added-node batch is processed defensively so one
   * malformed subtree cannot tear down the observer callback.
   *
   * Guards against a null document root (content script may run at
   * `document_start` before `<body>` exists) and registers observer disconnect
   * as adapter cleanup.
   */
  private observeEmailContent(): void {
    // Watch for email thread views opening
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;

          // The added subtree is untrusted host DOM. Isolate any throw to this
          // node so one malformed element can't kill the observer callback and
          // stop all further extraction.
          try {

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
          } catch (err) {
            log.debug('Skipped unparseable Gmail DOM node:', err);
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
