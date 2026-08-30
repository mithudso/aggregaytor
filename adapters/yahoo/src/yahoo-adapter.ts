/**
 * yahoo-adapter.ts -- Yahoo Mail platform adapter.
 *
 * Uses network interception on mail.yahoo.com to capture email data from
 * Yahoo's REST API responses, plus DOM observation to extract email content
 * rendered in the Yahoo Mail web interface.
 *
 * Yahoo Mail uses a standard REST API (no WebSockets for mail data), so
 * `parseWebSocketFrame` returns an empty array. All message extraction
 * happens via `parseApiResponse` and the DOM MutationObserver.
 *
 * ## Network interception
 *
 * Yahoo Mail's web client fetches message data from endpoints on
 * `mail.yahoo.com`. Responses are JSON objects containing message metadata
 * (from, to, subject, date) and body content. The adapter walks these
 * payloads looking for objects with email-like keys and normalizes them
 * into `UnifiedMessage` records.
 *
 * ## DOM observation
 *
 * When a user opens an email thread, Yahoo renders the message body into
 * the DOM. A `MutationObserver` watches for these elements and emits
 * messages + contacts as they appear. This captures content that may not
 * appear in intercepted API responses (e.g. cached/pre-rendered threads).
 *
 * The observer is started with a 5-second delay after `init()` to allow
 * Yahoo Mail's SPA to finish its initial render before we start watching.
 */

import { BaseAdapter, walkPayload, extractTimestamp, extractMessageText, createLogger } from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';

// Level-gated logger. Bare console.* ran unconditionally inside a page we do
// not control and could not be silenced.
const log = createLogger('[Aggregaytor:Yahoo]');

/**
 * Path prefixes that indicate a Yahoo Mail API response worth intercepting.
 * These cover the primary endpoints Yahoo's web client uses to fetch
 * message lists, thread contents, and search results. Only ever tested
 * AFTER the host check below.
 */
const YAHOO_API_PATH_PATTERNS = [
  '/ws/v3/',
  '/api/',
  '/neo/',
  '/yql/',
  '/mc/',
];

/** Hosts whose responses may legitimately be parsed as Yahoo Mail data. */
const YAHOO_HOST_RE = /(^|\.)mail\.yahoo\.com$/i;

/**
 * Test whether `url` resolves to a Yahoo Mail host.
 *
 * The previous filter matched "mail.yahoo.com/ws/v3/" as a plain SUBSTRING
 * of the whole URL, so `https://evil.example/mail.yahoo.com/api/x` passed and
 * the attacker's JSON was parsed into the user's message store. Matching on
 * the parsed hostname plus the pathname closes that. Relative URLs resolve
 * against the page origin; anything unparseable is rejected.
 */
function isYahooMailApiUrl(url: string): boolean {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const parsed = new URL(String(url), base);
    if (!YAHOO_HOST_RE.test(parsed.hostname)) return false;
    const path = parsed.pathname.toLowerCase();
    return YAHOO_API_PATH_PATTERNS.some(p => path.includes(p));
  } catch {
    return false;
  }
}

/**
 * File extensions and path segments to skip during URL filtering.
 * Yahoo Mail loads many static assets alongside API calls; intercepting
 * those would waste cycles and produce no useful message data.
 */
const SKIP_EXTENSIONS = [
  '.css', '.js', '.woff', '.woff2', '.ttf', '.eot',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.map', '.br', '.gz',
];

/**
 * Path segments that indicate static/non-message resources.
 * Skipping these avoids parsing asset manifests, analytics payloads, etc.
 */
const SKIP_PATH_SEGMENTS = [
  '/static/', '/assets/', '/fonts/', '/images/', '/icons/',
  '/analytics/', '/beacon/', '/tracker/', '/log/',
];

export class YahooAdapter extends BaseAdapter {
  readonly platform: Platform = 'yahoo';

  /**
   * Initialize the Yahoo Mail adapter.
   *
   * Sets up network interception immediately (to catch API calls made
   * during page load), then schedules DOM observation after a 5-second
   * delay to let Yahoo Mail's SPA finish its initial render cycle.
   */
  async init(): Promise<void> {
    log.info('Initializing...');

    // Intercept Yahoo Mail's REST API calls
    this.setupNetworkInterception(window as Window & typeof globalThis);

    // DOM observation for email content -- delayed to let the SPA render
    const timer = setTimeout(() => this.observeEmailContent(), 5000);
    this.addCleanup(() => clearTimeout(timer));

    log.info('Initialized');
  }

  /**
   * Determine whether a URL should be intercepted for message extraction.
   *
   * Returns `true` for Yahoo Mail API endpoints and `false` for static
   * assets (CSS, JS, fonts, images) and non-message paths (analytics,
   * beacons, trackers).
   *
   * @param url - The request URL being evaluated.
   * @returns Whether the interceptor should capture this URL's response.
   */
  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();

    // Skip static assets by extension
    if (SKIP_EXTENSIONS.some(ext => s.includes(ext))) return false;

    // Skip non-message path segments
    if (SKIP_PATH_SEGMENTS.some(seg => s.includes(seg))) return false;

    // Must be a Yahoo-Mail-hosted API path (host-anchored, not substring)
    return isYahooMailApiUrl(url);
  }

  /**
   * Parse a captured Yahoo Mail API response into normalized messages.
   *
   * Yahoo's API returns JSON payloads containing message objects with
   * varying key names depending on the endpoint. This method uses
   * `walkPayload` to traverse the response tree and find objects that
   * look like email messages based on common key patterns:
   *
   *  - Body content: `snippet`, `body`, `textBody`, `subject`
   *  - Timestamps: `receivedDate`, `date`, `sentDate`
   *  - Identifiers: `id`, `mid`, `threadId`, `conversationId`
   *  - Participants: `from`, `to`, `sender`, `recipient`
   *
   * Direction is inferred by checking whether `from` matches any of the
   * user's known email addresses (tracked via `selfIds`).
   *
   * @param url     - The API endpoint URL that produced this response.
   * @param payload - The parsed JSON body of the response.
   * @returns An array of normalized messages (empty array if none found).
   */
  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
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
    // Extract body text from known Yahoo fields
    const body = extractMessageText(obj)
      || String(obj.snippet || obj.body || obj.textBody || '');
    if (!body || body.length < 3) return;

    // Extract timestamp from known Yahoo date fields
    const ts = extractTimestamp(obj)
      || this.extractYahooTimestamp(obj);

    // Extract participant and identity fields
    const from = this.extractEmailAddress(obj.from || obj.sender || obj.fromAddress || '');
    const to = this.extractEmailAddress(obj.to || obj.recipient || obj.toAddress || '');
    const subject = String(obj.subject || obj.title || '');
    const threadId = String(
      obj.conversationId || obj.threadId || obj.thread_id || obj.mid || obj.id || ''
    );

    // Require at least a sender or thread identifier to be useful
    if (!from && !threadId) return;

    // Determine direction: outbound if `from` matches one of our selfIds
    const isSelf = from ? this.selfIds.has(from) : false;
    const direction = isSelf ? 'out' : 'in';
    const contactEmail = direction === 'in' ? from : to;

    messages.push({
      id: `yahoo:${threadId || Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      platform: 'yahoo',
      threadId: `yahoo:${threadId}`,
      contactId: `yahoo:${contactEmail || threadId}`,
      direction,
      body: subject ? `${subject}: ${body.slice(0, 200)}` : body.slice(0, 500),
      timestamp: ts || new Date().toISOString(),
      read: false,
      metadata: { from, to, subject, url },
    });
  }

  /**
   * Parse a WebSocket frame -- returns empty array.
   *
   * Yahoo Mail uses REST APIs exclusively for mail data; there are no
   * WebSocket-based message streams to parse. This method satisfies the
   * `BaseAdapter` contract without doing any work.
   *
   * @param _data - Unused WebSocket frame data.
   * @returns An empty array (always).
   */
  protected parseWebSocketFrame(_data: string | ArrayBuffer): UnifiedMessage[] {
    return [];
  }

  // ---------------------------------------------------------------------------
  // DOM observation
  // ---------------------------------------------------------------------------

  /**
   * Set up a MutationObserver to watch for Yahoo Mail email content in the DOM.
   *
   * Yahoo Mail renders message bodies into elements with class `.msg-body`,
   * or with `[data-test-id]` attributes on message containers. The observer
   * watches for these nodes being added and extracts sender, subject, and
   * body text from the surrounding DOM structure.
   *
   * Emits both `messages` and `contacts` events for each extracted email so
   * the store layer stays in sync.
   */
  private observeEmailContent(): void {
    log.info('Setting up DOM observer...');

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;

          // Yahoo Mail message body containers:
          //  - `.msg-body` is the primary message content wrapper
          //  - `[data-test-id="message-view-body"]` on newer Yahoo Mail builds
          //  - `.thread-body` for thread-level content
          const bodies = el.querySelectorAll(
            '.msg-body, [data-test-id="message-view-body"], [data-test-id*="message"], .thread-body'
          );
          for (const body of bodies) {
            this.extractFromDOMNode(body);
          }

          // Also check if the added node itself is a message body
          if (
            el.classList?.contains('msg-body') ||
            el.getAttribute('data-test-id')?.includes('message')
          ) {
            this.extractFromDOMNode(el);
          }
        }
      }
    });

    // Defensive: `observer.observe(null, ...)` throws. The 5s init delay
    // normally guarantees a body, but a torn-down or reloading document would
    // otherwise take the adapter down with it.
    const root = document.body || document.documentElement;
    if (!root) {
      log.warn('No document root yet; skipping DOM observation.');
      return;
    }
    observer.observe(root, { childList: true, subtree: true });
    this.addCleanup(() => observer.disconnect());
  }

  /**
   * Extract message and contact data from a Yahoo Mail DOM node.
   *
   * Walks up the DOM tree from the message body to find sender information,
   * subject line, and other metadata. Emits `messages` and `contacts`
   * events with the extracted data.
   *
   * @param body - The DOM element containing the email body text.
   */
  private extractFromDOMNode(body: Element): void {
    const text = body.textContent?.trim();
    if (!text || text.length < 10) return;

    // Walk up to find the message container
    const container = body.closest(
      '[data-test-id*="message"], .thread-item, .msg-container, .message-view'
    );

    // Extract sender from Yahoo's header area.
    // Yahoo uses various selectors for the sender display:
    //  - `[data-test-id="message-from"]` in newer builds
    //  - `.sender` or `.from` in the message header
    //  - `[data-test-id="message-group-sender-name"]`
    const senderEl = (
      container?.querySelector('[data-test-id="message-from"], [data-test-id*="sender"], .sender, .from') ||
      container?.querySelector('.D_F .fLmail_subject')?.closest('.D_F')?.querySelector('.fLmail_from')
    ) as HTMLElement | null;

    const sender = senderEl?.getAttribute('title')
      || senderEl?.getAttribute('email')
      || senderEl?.textContent?.trim()
      || '';

    // Extract subject from the header area
    const subjectEl = container?.querySelector(
      '[data-test-id="message-subject"], .subject, .D_F .fLmail_subject'
    ) as HTMLElement | null;
    const subject = subjectEl?.textContent?.trim() || '';

    // Extract thread/message identifier from data attributes
    const threadId = container?.getAttribute('data-mid')
      || container?.getAttribute('data-test-id')
      || `dom-${Date.now()}`;

    if (sender) {
      const senderEmail = this.extractEmailAddress(sender);

      this.emit({
        type: 'messages',
        payload: [{
          id: `yahoo:dom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          platform: 'yahoo' as Platform,
          threadId: `yahoo:${threadId}`,
          contactId: `yahoo:${senderEmail || sender}`,
          direction: 'in' as const,
          body: subject ? `${subject}: ${text.slice(0, 200)}` : text.slice(0, 500),
          timestamp: new Date().toISOString(),
          read: true,
          metadata: { sender: senderEmail || sender, subject, source: 'dom' },
        }],
      });

      this.emit({
        type: 'contacts',
        payload: [{
          id: `yahoo:${senderEmail || sender}`,
          platform: 'yahoo' as Platform,
          platformUserId: senderEmail || sender,
          displayName: senderEl?.textContent?.trim() || sender.split('@')[0],
          profileUrl: 'https://mail.yahoo.com',
          avatarUrl: '',
          lastSeen: new Date().toISOString(),
          metadata: { email: senderEmail || sender },
        }],
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract a bare email address from a Yahoo participant field.
   *
   * Yahoo's API may return participant data as a plain string email, an
   * object with an `email` or `address` key, or a display-name string
   * like `"John Doe <john@example.com>"`. This method normalizes all
   * forms into a bare email address.
   *
   * @param value - The raw participant field value (string or object).
   * @returns A bare email address string, or empty string if not found.
   */
  private extractEmailAddress(value: unknown): string {
    if (!value) return '';

    // Object with email/address key (Yahoo API format)
    if (typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      return String(obj.email || obj.address || obj.emailAddress || '').trim();
    }

    const str = String(value).trim();

    // "Display Name <email@example.com>" format
    const angleMatch = str.match(/<([^>]+@[^>]+)>/);
    if (angleMatch) return angleMatch[1].trim();

    // Already a bare email address
    if (str.includes('@')) return str;

    return '';
  }

  /**
   * Attempt to extract a timestamp from Yahoo-specific date fields.
   *
   * Falls back through `receivedDate`, `date`, and `sentDate`, trying
   * both numeric (epoch milliseconds) and string (ISO 8601) formats.
   *
   * @param obj - The raw API response object to inspect.
   * @returns An ISO 8601 timestamp string, or `null` if no valid date found.
   */
  private extractYahooTimestamp(obj: Record<string, unknown>): string | null {
    const candidates = [obj.receivedDate, obj.date, obj.sentDate, obj.createdDate];

    for (const val of candidates) {
      if (!val) continue;

      // Numeric epoch (seconds or milliseconds)
      if (typeof val === 'number') {
        // Yahoo sometimes uses seconds, sometimes milliseconds
        const ms = val > 1e12 ? val : val * 1000;
        const d = new Date(ms);
        if (!isNaN(d.getTime())) return d.toISOString();
      }

      // String date
      if (typeof val === 'string') {
        const d = new Date(val);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
    }

    return null;
  }
}
