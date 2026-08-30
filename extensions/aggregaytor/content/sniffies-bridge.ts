/**
 * sniffies-bridge.ts — ISOLATED world bridge for Sniffies.
 *
 * This script runs in Chrome's ISOLATED world, which is the only content-script
 * execution environment that has access to chrome.runtime.* APIs. The MAIN world
 * content script (sniffies.ts) can intercept page traffic but cannot talk to the
 * service worker directly. This bridge connects the two:
 *
 *   Page traffic  -->  sniffies.ts (MAIN)  --CustomEvent-->  this bridge (ISOLATED)
 *       --chrome.runtime.sendMessage-->  service worker  -->  context engine
 *
 * It also handles the reverse direction: service worker commands (auto-send,
 * navigation, scraping) arrive via chrome.runtime.onMessage and are either
 * executed directly against the DOM (scraping) or forwarded to the MAIN world
 * via CustomEvents (auto-send, log level changes).
 *
 * This is the most complex content script because it must:
 *  1. Relay adapter events (messages, contacts, errors) from MAIN to SW
 *  2. Handle SW commands: SPA navigation, auto-response, scraping
 *  3. Scrape Angular DOM for chat panel, conversations, avatars, global chat
 *  4. Detect SPA URL changes (pushState + polling) to track active profile
 *  5. Survive extension context invalidation (reload/update) gracefully
 *  6. Inject the MAIN world script into the page on startup
 */

// Profile-id / marker / global-chat / carousel / route resolution now delegates
// to the vendored @aggregaytor/sniffies-lib DOM helpers in place of this bridge's
// bespoke broad-fallback class selectors and inline regexes. (This ISOLATED-world
// bridge builds as an ES module, so a static import is fine.) Every CustomEvent
// name, the `event.source !== window` guards, the two-worlds protocol, and the
// localStorage keys are preserved unchanged.
import { dom } from '@aggregaytor/sniffies-lib';

const LOG = '[Aggregaytor:Bridge:Sniffies]';

// v0.57.44: forward every uncaught error / unhandled promise rejection
// from this ISOLATED-world bridge to the SW's error-log buffer. Cheap
// (one chrome.runtime.sendMessage per error). The SW persists to
// chrome.storage.local with a rolling 500-entry cap so a runaway error
// can't fill the disk. Wrapped in a top-level try/catch — if the
// extension is reloaded mid-session, `chrome.runtime` throws and we
// just lose the report.
/** Forward one uncaught error / rejection to the SW's error-log buffer (see block comment above). */
function _forwardError(level: 'unhandled' | 'rejection' | 'error', message: string, stack?: string): void {
  try {
    chrome.runtime.sendMessage({
      type: 'LOG_ERROR',
      entry: {
        source: 'bridge:sniffies',
        level, message, stack,
        url: location.href,
      },
    }).catch(() => {});
  } catch {}
}
window.addEventListener('error', (ev) => {
  _forwardError('unhandled', ev.message || String(ev.error || 'unknown error'),
    (ev.error && (ev.error as Error).stack) || undefined);
});
window.addEventListener('unhandledrejection', (ev) => {
  const r: any = ev.reason;
  _forwardError('rejection',
    typeof r === 'string' ? r : (r?.message || String(r)),
    r?.stack);
});

/**
 * Parse a relative time string ("2 hours ago", "3 months ago", "an hour ago")
 * into an approximate ISO 8601 timestamp. Returns current time if unparseable.
 * This is used by DOM scrapers that can only read relative time text from the UI.
 */
function parseRelativeTime(text: string): string {
  if (!text) return new Date().toISOString();
  const t = text.trim().toLowerCase();
  const now = Date.now();

  // "a few seconds/minutes/hours ago" — Sniffies UI uses this for very
  // recent messages. Approximate conservatively: seconds→10s, minutes→3m,
  // hours→2h. Not perfect but better than warning + defaulting to now().
  const fewMatch = t.match(/(a few|several|some|couple(?:\s+of)?)\s+(second|minute|hour|day)s?\s*(?:ago)?/i);
  if (fewMatch) {
    const unit = fewMatch[2].toLowerCase();
    if (unit.startsWith('s')) return new Date(now - 10_000).toISOString();
    if (unit.startsWith('m')) return new Date(now - 180_000).toISOString();
    if (unit.startsWith('h')) return new Date(now - 7_200_000).toISOString();
    if (unit.startsWith('d')) return new Date(now - 2 * 86400_000).toISOString();
  }

  const match = t.match(/(\d+)\s*(second|sec|month|mo|minute|min|hour|hr|week|year|day|s|m|h|d|w|y)s?\s*(?:ago)?/i)
    || t.match(/(a|an)\s+(minute|hour|day|week|month|year)s?\s*(?:ago)?/i);
  if (!match) {
    if (t.includes('just now') || t.includes('now')) return new Date(now).toISOString();
    if (t.includes('yesterday')) return new Date(now - 86400000).toISOString();
    // Silently default to now() for unparseable strings. The previous warn
    // was firing on "a few seconds ago" for every scraped chat row and
    // flooding the console — the fewMatch branch above handles that case
    // now, and anything else unparseable is rare enough that defaulting
    // silently to the current time is a reasonable fallback.
    return new Date().toISOString();
  }
  const num = match[1] === 'a' || match[1] === 'an' ? 1 : parseInt(match[1], 10);
  const unit = (match[2] || '').toLowerCase();
  let ms = 0;
  if (unit.startsWith('s')) ms = num * 1000;
  else if (unit.startsWith('mi') || unit === 'm') ms = num * 60_000;
  else if (unit.startsWith('h')) ms = num * 3600_000;
  else if (unit.startsWith('d')) ms = num * 86400_000;
  else if (unit.startsWith('w')) ms = num * 604800_000;
  else if (unit.startsWith('mo')) ms = num * 2592000_000; // ~30 days
  else if (unit.startsWith('y')) ms = num * 31536000_000; // ~365 days
  return new Date(now - ms).toISOString();
}

/**
 * Small unicode-safe string hash (FNV-1a, base36). Used for stable synthetic
 * ids where the input is arbitrary scraped text — unlike btoa() it accepts any
 * code point, so an emoji in a scraped profile line can't throw.
 */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

// Tracks whether the extension context is still valid. Once invalidated
// (e.g., extension reload/update), all chrome.runtime calls throw, so we
// flip this flag and stop trying until the user reloads the page.
let contextValid = true;

/**
 * Check if the extension context is still valid.
 *
 * When Chrome reloads or updates an extension, any content scripts from the
 * previous version become "orphaned" — their chrome.runtime.* calls throw
 * "Extension context invalidated". There's no event for this; the only way
 * to detect it is to try accessing chrome.runtime.id and catch the error.
 *
 * Once invalidated, we log a warning (once) and set contextValid=false so
 * all message handlers short-circuit. The bridge stays dead until the user
 * refreshes the page, which loads fresh content scripts from the new version.
 */
function checkContext(): boolean {
  try {
    void chrome.runtime.id; // throws if extension was reloaded/uninstalled
    return true;
  } catch {
    if (contextValid) {
      console.warn(`${LOG} Extension context invalidated — bridge disabled until page reload`);
      contextValid = false;
      shutdownBackgroundTimers();
    }
    return false;
  }
}

// v0.57.32: chrome.runtime.sendMessage can THROW SYNCHRONOUSLY when the
// extension is reloaded mid-session — that throw bypasses any .catch()
// chained onto the returned promise and surfaces as
// "Uncaught Error: Extension context invalidated".
//
// safeSendMessage wraps the call so:
//   1. Pre-flight: if context is already known dead, reject immediately
//      (no attempt → no throw → no Sentry-style noise).
//   2. Sync throw: caught and turned into a rejected promise, plus we
//      flip contextValid so subsequent calls short-circuit.
//   3. Async rejections (channel-closed, no-receiver, context-lost) flow
//      through normally; callers decide whether to retry or give up.
//
// "Receiving end does not exist" / "Could not establish connection" —
// these fire when the SW is asleep AND has no other tab keeping it warm,
// or when the extension was reloaded but the SW handler hasn't bound yet.
// They're transient by definition; treat them as cache-miss equivalents.
/**
 * Send a message to the service worker without ever throwing on a transient
 * failure. `chrome.runtime.sendMessage` throws *synchronously* on an invalidated
 * extension context and rejects with "Receiving end does not exist" when the SW
 * is asleep — both are expected during reloads/idle, so this normalizes them to
 * a resolved sentinel and only surfaces genuine errors to the caller.
 * @param message the message payload to deliver to the SW
 * @returns the SW response, or a benign fallback when the context is unavailable
 */
function safeSendMessage(message: any): Promise<any> {
  if (!contextValid) {
    return Promise.reject(new Error('Context invalidated'));
  }
  try {
    const p = chrome.runtime.sendMessage(message);
    // Some old polyfills returned undefined; normalise to a Promise.
    return p && typeof (p as any).then === 'function' ? p as Promise<any> : Promise.resolve(p);
  } catch (err) {
    // Sync throw — almost always context invalidation. Flip the flag so
    // subsequent calls short-circuit without re-throwing.
    contextValid = false;
    shutdownBackgroundTimers();
    return Promise.reject(err as Error);
  }
}

// Background timers (intervals) keep firing even after the extension is
// reloaded. Once contextValid flips to false they all become dead-letter
// CPU, and any sendMessage they retry will throw again. Track them in a
// registry so checkContext() / safeSendMessage() can clear them once.
const _backgroundTimers: ReturnType<typeof setInterval>[] = [];
/** Record a setInterval id so shutdownBackgroundTimers() can clear it on context loss. */
function registerBackgroundTimer(id: ReturnType<typeof setInterval>): void {
  _backgroundTimers.push(id);
}
/** Clear every registered background interval (called once when the extension context dies). */
function shutdownBackgroundTimers(): void {
  while (_backgroundTimers.length) {
    const id = _backgroundTimers.pop();
    if (id != null) clearInterval(id);
  }
}

// ── MAIN -> Service Worker Relay ─────────────────────────────────────────────
// Listen for CustomEvents dispatched by sniffies.ts in the MAIN world.
// The event name __aggregaytor_message is our cross-world communication channel.
// Each event's detail contains a typed message object (ADAPTER_MESSAGES,
// ADAPTER_CONTACTS, ADAPTER_ERROR) which we forward verbatim to the service
// worker via chrome.runtime.sendMessage.
window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail?.type) return;

  try {
    chrome.runtime.sendMessage(detail).catch(() => {
      // Silently ignore — extension may have reloaded between the check and send
    });
  } catch {
    // chrome.runtime.sendMessage itself threw — context is gone
    contextValid = false;
  }
}) as EventListener);

// ── Service Worker -> Content Script Message Handlers ────────────────────────
// The service worker sends commands to this bridge via chrome.runtime.onMessage.
// Each handler returns true to indicate async sendResponse usage (required by
// Chrome's messaging API even when we respond synchronously).
try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

    // ── SPA_NAVIGATE ──────────────────────────────────────────────────────
    // Navigate to a different page within the Sniffies SPA without triggering
    // a full page reload (which would destroy the adapter's WebSocket patches).
    // Strategy: pushState to update the URL bar, then fire popstate to tell the
    // Angular router to render the new route. As a fallback, we also try to find
    // and click an <a> tag matching the target path, and if all else fails, do
    // a hard navigation with location.href.
    if (message.type === 'SPA_NAVIGATE') {
      // Both fields optional in the wire format, so validate before use —
      // without a url the `catch` below used to "hard navigate" the tab to
      // the string "undefined".
      if (typeof message.url !== 'string' && typeof message.path !== 'string') {
        console.warn(`${LOG} SPA_NAVIGATE with neither url nor path — ignoring`);
        sendResponse({ ok: false, error: 'missing url/path' });
        return true;
      }
      try {
        const path = message.path || new URL(message.url).pathname;
        // Update the URL bar without a page reload
        window.history.pushState({}, '', path);
        // Fire popstate to notify the Angular/React router of the URL change.
        // Note: pushState does NOT fire popstate on its own — that only fires
        // when the user clicks Back/Forward. We must dispatch it manually.
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        window.dispatchEvent(new Event('popstate'));
        // Fallback: if the SPA router doesn't pick up the popstate (some Angular
        // apps need a real link click), find a matching <a> tag and click it
        setTimeout(() => {
          // `path` is interpolated into a CSS attribute-selector string, so
          // backslashes and double quotes must be escaped — otherwise a stray
          // quote makes querySelector throw a SyntaxError out of this timer
          // (uncaught, and the click fallback silently never runs).
          const q = String(path).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          let link: HTMLAnchorElement | null = null;
          try {
            link = document.querySelector(`a[href="${q}"], a[href*="${q}"]`) as HTMLAnchorElement | null;
          } catch { /* unusable selector — skip the click fallback */ }
          if (link) link.click();
        }, 500);
      } catch {
        // All SPA navigation strategies failed — hard navigate as last resort.
        // This will reload the page and re-initialize all content scripts.
        if (typeof message.url === 'string') window.location.href = message.url;
      }
      sendResponse({ ok: true });
      return true;
    }

    // ── SET_LOG_LEVEL ─────────────────────────────────────────────────────
    // Forward log-level changes to the MAIN world script via CustomEvent.
    // The MAIN world script calls setLogLevel() from @aggregaytor/adapter-core
    // to adjust adapter verbosity at runtime (e.g., from the popup settings).
    if (message.type === 'SET_LOG_LEVEL') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_set_log_level', { detail: message.level }));
      sendResponse({ ok: true });
      return true;
    }

    // ── SEND_AUTO_RESPONSE ────────────────────────────────────────────────
    // Forward auto-response text to the MAIN world, where the auto-send
    // mechanism types it into the chat input and clicks Send. This must go
    // to MAIN world because the chat input's React/Angular state can only be
    // manipulated from the page's own JS context.
    if (message.type === 'SEND_AUTO_RESPONSE') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
        detail: { text: message.text, contactId: message.contactId },
      }));
      sendResponse({ ok: true });
      return true;
    }
    // ── SCRAPE_CONVERSATION ─────────────────────────────────────────────
    // Scrape all visible message bubbles in the currently open 1:1 conversation.
    // This runs in ISOLATED world (not MAIN) because it only needs DOM access,
    // not API interception. The scraped messages are sent to the service worker
    // as ADAPTER_MESSAGES so they get stored in the context engine.
    //
    // Selector strategy: uses broad CSS class-substring selectors because
    // Sniffies (Angular) hashes class names. We look for common patterns like
    // "chat-bubble", "message-bubble", "message-row", etc. across multiple
    // possible naming conventions.
    if (message.type === 'SCRAPE_CONVERSATION') {
      const messages: any[] = [];
      const profileId = message.profileId || '';

      // Query all elements that look like chat message bubbles
      const bubbles = document.querySelectorAll(
        '[class*="chat-bubble"], [class*="message-bubble"], [class*="chat-message"], ' +
        '[class*="msg-bubble"], [data-testid*="message"], [class*="message-row"], ' +
        '.message, .chat-msg, [class*="MessageBubble"], [class*="chatMessage"]'
      );

      bubbles.forEach((bubble, i) => {
        try {
          const text = bubble.textContent?.trim() || '';
          if (!text || text.length < 2) return;
          // Reject UI metadata that Sniffies renders inline in chat view:
          // relative timestamps ("19 days ago"), status labels ("Seen"),
          // chat history headers, date separators
          const lower = text.toLowerCase();
          if (/^\d+\s+(second|minute|hour|day|week|month|year)s?\s*ago$/i.test(lower)) return;
          if (/^(just now|seen|delivered|sent|read|today|yesterday)$/i.test(lower)) return;
          if (/^(mon|tue|wed|thu|fri|sat|sun)/i.test(lower) && lower.length < 12) return;
          if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}$/i.test(lower)) return;
          if (lower.includes('beginning of your chat history')) return;
          // Rollup: timestamp + message text concatenated (starts with "N days ago" + has "Seen")
          if (/^\d+\s+(day|hour|minute)s?\s+ago\s+/i.test(text) && text.length > 30) return;
          // System messages about deleted conversations
          if (lower.includes('deleted previous messages in this conversation')) return;
          if (lower.includes('deleted the conversation') || lower.includes('conversation deleted')) return;
          if (lower.startsWith('this conversation') || lower.startsWith('you blocked') || lower.startsWith('you unblocked')) return;
          if (lower.startsWith('you reported') || lower.startsWith('message unsent') || lower.startsWith('this message was deleted')) return;

          // Determine message direction by checking CSS classes for common
          // "sent" indicators. Sniffies typically styles outgoing messages with
          // class names containing "sent", "mine", "outgoing", "self", "right",
          // or "from-me" on the bubble or its parent container.
          const bubbleClasses = bubble.className || '';
          const parentClasses = bubble.parentElement?.className || '';
          const allClasses = (bubbleClasses + ' ' + parentClasses).toLowerCase();
          const isSent = allClasses.includes('sent') || allClasses.includes('mine') ||
            allClasses.includes('outgoing') || allClasses.includes('self') ||
            allClasses.includes('right') || allClasses.includes('from-me');
          const direction = isSent ? 'out' : 'in';

          // Attempt to find a timestamp element near the bubble (child or sibling)
          const timeEl = bubble.querySelector('[class*="time"], [class*="date"], [class*="stamp"], time') ||
            bubble.parentElement?.querySelector('[class*="time"], [class*="date"]');
          const timeText = timeEl?.textContent?.trim() || '';

          // Build the contactId from the profileId (hex ID from the URL)
          const contactId = profileId ? `sniffies:${profileId}` : (message.contactId || '');
          if (!contactId) return;

          messages.push({
            id: `sniffies:conv-${profileId || 'unknown'}-${direction}-${text.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '')}-${i}`,
            platform: 'sniffies',
            threadId: contactId, // thread = contact for 1:1 conversations
            contactId,
            direction,
            body: text.slice(0, 2000), // cap body length
            timestamp: parseRelativeTime(timeText), // use actual send time, not download time
            read: true, // scraped messages are already visible, so mark read
            metadata: {
              source: 'conversation-scrape',
              profileId,
              timeText,
              index: i, // position in the visible bubble list
            },
          });
        } catch { /* skip individual bubble parse errors */ }
      });

      // Send scraped messages to service worker for storage
      if (messages.length) {
        chrome.runtime.sendMessage({
          type: 'ADAPTER_MESSAGES',
          platform: 'sniffies',
          payload: messages,
        }).catch(() => {});
      }

      console.log(`[Aggregaytor:Bridge:Sniffies] Conversation scraped: ${messages.length} messages from ${bubbles.length} bubbles`);
      sendResponse({ ok: true, count: messages.length });
      return true;
    }
    // ── SCRAPE_AVATARS ────────────────────────────────────────────────────
    // Extract profile avatar URLs from the Sniffies map view. Each map marker
    // displays a user's avatar as a CSS background-image on elements served
    // from profile.sniffiesassets.com. The URL path contains the user's hex
    // profile ID, which we extract to create contact records.
    //
    // Two-pronged approach: dispatch an event to MAIN world (in case the
    // adapter has additional scraping logic), AND scrape directly from
    // ISOLATED world since we have full DOM access here.
    // ── Quick phrase capture via Alt+Shift+right-click ──────────────────
    // When the user Alt+Shift+right-clicks in a chat, capture the selected
    // text and add it as a quick phrase. Works on any platform page.
    if (message.type === 'CAPTURE_PHRASE') {
      // Already handled below in the contextmenu listener
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'UNDO_LAST_HIDE') {
      // Relay to MAIN world's map filter undo function
      window.dispatchEvent(new CustomEvent('__aggregaytor_undo_hide'));
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'SET_ATTITUDE_OVERRIDE') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_set_attitude', {
        detail: { profileId: message.profileId, attitude: message.attitude },
      }));
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'SHOW_FLOATING_PANEL') {
      showFloatingPanel(message.contactId, message.platform || 'sniffies');
      sendResponse({ ok: true });
      return true;
    }
    // v0.57.35: side-panel-triggered bulk inbox refetch. Side panel sends
    // SNIFFIES_REFETCH_INBOX → SW broadcasts to every sniffies.com tab →
    // bridge here postMessages to MAIN world → adapter hits chat-data and
    // emits any newly-seen DMs through ADAPTER_MESSAGES. Result count
    // (SNIFFIES_REFETCH_RESULT) bubbles back to the panel via the existing
    // __aggregaytor_message relay below.
    if (message.type === 'SNIFFIES_REFETCH_INBOX') {
      window.postMessage({ type: '__aggregaytor_refetch_inbox' }, '*');
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'TEXT_EXPANDER_SETTINGS') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_text_expander_settings', {
        detail: { substitutions: message.substitutions },
      }));
      // Also persist to localStorage for next page load
      try { localStorage.setItem('aggregaytor_text_substitutions', JSON.stringify(message.substitutions)); } catch {}
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'MAP_FILTER_SETTINGS') {
      // Relay map filter settings from the side panel to the MAIN world.
      // postMessage crosses the ISOLATED→MAIN world boundary; CustomEvents
      // do NOT (which is why filters silently did nothing before v0.56.6).
      console.log('[Aggregaytor:Bridge:Sniffies] Relaying MAP_FILTER_SETTINGS to MAIN world:', Object.keys(message.settings || {}).length, 'keys');
      window.postMessage({ type: '__aggregaytor_map_filter_settings', update: message.settings }, '*');
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'SCRAPE_AVATARS') {
      // Notify MAIN world in case the adapter wants to do its own scraping
      window.dispatchEvent(new CustomEvent('__aggregaytor_scrape_avatars'));

      // Scrape map marker avatars from the DOM. Sniffies uses MapLibre GL for
      // the map, so markers are .maplibregl-marker elements with background-image
      // styles pointing to sniffiesassets.com CDN URLs.
      let count = 0;
      // Marker root selection now uses the lib's observed marker selectors.
      document.querySelectorAll(`[style*="sniffiesassets"], ${dom.MARKER_ROOT_SELECTOR}, ${dom.MARKER_AVATAR_IMAGE_SELECTOR}`).forEach(el => {
        const bg = (el as HTMLElement).style?.backgroundImage || '';
        // Extract the actual URL from the CSS background-image value
        const match = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (!match) return;
        const url = match[1];
        // Extract the hex profile ID from the CDN URL path — delegates to the
        // lib's dom.profileIdFromAssetUrl (canonical profile.sniffiesassets.com/
        // <hex>/ pattern, lowercased). Returns null for non-profile images.
        const profileId = dom.profileIdFromAssetUrl(url);
        if (!profileId) return; // skip non-profile images (site assets, defaults)
        // Send each avatar as a contact update to the service worker
        chrome.runtime.sendMessage({
          type: 'ADAPTER_CONTACTS',
          platform: 'sniffies',
          payload: [{
            id: `sniffies:${profileId}`,
            platform: 'sniffies',
            platformUserId: profileId,
            displayName: '', // name not available from map markers
            profileUrl: `https://sniffies.com/profile/${profileId}`,
            avatarUrl: url,
            lastSeen: new Date().toISOString(),
            metadata: {},
          }],
        }).catch(() => {});
        count++;
      });
      sendResponse({ ok: true, count });
      return true;
    }
    // ── SCRAPE_GLOBAL_CHAT ─────────────────────────────────────────────
    // Scrape the "Cruising" / global chat feed from the DOM. Unlike 1:1
    // conversations, global chat messages are displayed in a feed layout
    // where each item contains: avatar, profile attributes (age, height,
    // weight, etc.), timestamp/distance, and the message body.
    //
    // This is significantly more complex than conversation scraping because
    // we must disentangle the message body from surrounding metadata text.
    // Global chat messages all share a single threadId ('sniffies:global-chat')
    // but we extract per-sender profileIds from avatar URLs for contact records.
    if (message.type === 'SCRAPE_GLOBAL_CHAT') {
      const messages: any[] = [];
      const contacts: any[] = [];

      // Each global chat message is a feed item. The exact class names are
      // hashed by Angular, so we use substring matches for common patterns.
      document.querySelectorAll('[class*="cruising-update"], [class*="global-chat-message"], [class*="feed-item"], [class*="post"]').forEach(el => {
        try {
          // -- Avatar extraction --
          // Try <img> tag first, then fall back to background-image CSS
          const avatarEl = el.querySelector('img') as HTMLImageElement;
          const avatarUrl = avatarEl?.src || '';
          const bgEl = el.querySelector('[style*="background-image"]') as HTMLElement;
          const bgMatch = bgEl?.style?.backgroundImage?.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
          const bgAvatar = bgMatch?.[1] || '';

          // -- Profile attributes extraction --
          // Sniffies displays a stats line like "30m, 6'1", 185lb, 8", bi, vers top"
          // before the timestamp. We match this pattern to separate attrs from body.
          const allText = el.textContent || '';
          const attrMatch = allText.match(/(\d+m?,\s*\d+['"]\d*"?,\s*\d+lb.*?)(?:\d+\s*(?:minute|second|hour))/i);
          const attrs = attrMatch?.[1]?.trim() || '';

          // -- Timestamp and distance --
          const timeMatch = allText.match(/(\d+\s*(?:minutes?|seconds?|hours?)\s*ago)/i);
          const distMatch = allText.match(/([\d.]+\s*miles?)/i);
          const timeText = timeMatch?.[1] || '';
          const distance = distMatch?.[1] || '';

          // -- Message body extraction --
          // The body is the actual chat content, excluding metadata. We query for
          // likely body containers and filter out lines that look like attributes,
          // timestamps, or distance info.
          const bodyEls = el.querySelectorAll('[class*="message"], [class*="body"], [class*="content"], [class*="text"], p');
          const bodyParts: string[] = [];
          bodyEls.forEach(b => {
            const t = b.textContent?.trim();
            // Skip elements whose text matches the attribute/time/distance patterns
            if (t && t.length > 1 && !t.match(/^\d+m,/) && !t.includes('ago') && !t.includes('miles')) {
              bodyParts.push(t);
            }
          });
          // Fallback: if no distinct body elements found, derive body by stripping
          // known metadata substrings from the full element text
          let body = bodyParts.join('\n').trim();
          if (!body) {
            body = allText.replace(attrs, '').replace(timeText, '').replace(distance, '').trim();
            body = body.split('\n').filter(l => l.trim().length > 3).join('\n').trim();
          }
          if (!body || body.length < 3) return; // skip items with no meaningful body

          // -- Profile ID extraction --
          // Prefer extracting the hex ID from the avatar CDN URL (most reliable).
          // Fallback: generate a pseudo-ID by base64-encoding the attributes string.
          // This ensures each unique profile gets a stable-ish contactId.
          let profileId = '';
          // Prefer the lib's dom.profileIdFromAssetUrl (canonical avatar-CDN
          // pattern, lowercased) over an ad-hoc path regex.
          const idFromAvatar = dom.profileIdFromAssetUrl(avatarUrl || bgAvatar);
          if (idFromAvatar) profileId = idFromAvatar;
          // btoa() throws on any code point above U+00FF, so an emoji or
          // accented character anywhere in the attrs line used to drop the
          // whole feed item via the per-item catch. Hash the string instead —
          // same purpose (a stable pseudo-id), no encoding constraints.
          else profileId = `gc-${stableHash(attrs.slice(0, 30))}`;

          // All global chat messages share a single thread/contact ID
          messages.push({
            id: `sniffies:gc-${profileId}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            platform: 'sniffies',
            threadId: 'sniffies:global-chat',
            contactId: 'sniffies:global-chat',
            direction: 'in', // global chat is always inbound (read-only feed)
            body,
            timestamp: parseRelativeTime(timeText), // use post time, not download time
            read: true,
            metadata: {
              senderId: profileId,
              avatarUrl: avatarUrl || bgAvatar,
              displayName: attrs || profileId.slice(0, 10),
              bodyType: '', position: '', age: '',
              distance, timeText, attrs,
              source: 'global-chat-scrape',
            },
          });

          // Create a contact record for the sender if we have an avatar
          if (profileId && (avatarUrl || bgAvatar)) {
            contacts.push({
              id: `sniffies:${profileId}`,
              platform: 'sniffies',
              platformUserId: profileId,
              displayName: attrs || profileId.slice(0, 10),
              profileUrl: `https://sniffies.com/profile/${profileId}`,
              avatarUrl: avatarUrl || bgAvatar,
              lastSeen: new Date().toISOString(),
              metadata: { distance, attrs },
            });
          }
        } catch { /* skip individual feed item parse errors */ }
      });

      // Send scraped data to service worker
      if (messages.length) {
        chrome.runtime.sendMessage({ type: 'ADAPTER_MESSAGES', platform: 'sniffies', payload: messages }).catch(() => {});
      }
      if (contacts.length) {
        chrome.runtime.sendMessage({ type: 'ADAPTER_CONTACTS', platform: 'sniffies', payload: contacts }).catch(() => {});
      }

      sendResponse({ ok: true, count: messages.length });
      return true;
    }

    // Unknown message type — return false so Chrome knows we didn't handle it
    return false;
  });
} catch {
  // chrome.runtime.onMessage.addListener itself threw — context is already invalid
  contextValid = false;
}

// ── Block Detection Relay ────────────────────────────────────────────────────
// The MAIN world adapter emits ADAPTER_ERROR events when it detects that the
// user has been blocked by a profile (the API returns a specific error pattern).
// This second __aggregaytor_message listener specifically watches for these
// block errors and transforms them into PROFILE_BLOCKED messages for the service
// worker, which updates the contact's blocked status in the context engine.
//
// Note: this is a SEPARATE listener from the main relay above because block
// detection requires inspecting the error string, whereas the main relay
// forwards all events verbatim. Having two listeners is cleaner than branching.
window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  // Check for ADAPTER_ERROR events whose error string starts with "BLOCKED:"
  // followed by the hex profile ID of the user who blocked us
  if (detail?.type === 'ADAPTER_ERROR' && detail?.error?.startsWith?.('BLOCKED:')) {
    const profileId = detail.error.replace('BLOCKED:', '');
    try {
      chrome.runtime.sendMessage({
        type: 'PROFILE_BLOCKED',
        contactId: `sniffies:${profileId}`,
        platform: 'sniffies',
      }).catch(() => {});
    } catch { /* context invalidated */ }
  }
}) as EventListener);

// ── Floating Quick-Action Panel ────────────────────────────────────────────
// Injected directly on the platform page when a profile is opened.
// Provides block, notes, ratings, and quick phrase buttons.

const FP_ID = 'aggregaytor-floating-actions';
let fpContactId = '';
let fpPlatform = '';
let _fpDragCleanup: (() => void) | null = null;
let _fpEscapeCleanup: (() => void) | null = null;

/** Inject the floating quick-action / map-filter panel stylesheet once per page. */
function injectFloatingCSS(): void {
  if (document.getElementById('aggregaytor-fp-css')) return;
  const s = document.createElement('style');
  s.id = 'aggregaytor-fp-css';
  s.textContent = `
    #${FP_ID}{position:fixed;z-index:99999;width:320px;background:rgba(15,20,25,0.95);border:1px solid rgba(59,130,246,0.3);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.5);font-family:system-ui,sans-serif;font-size:12px;color:#e7e9ea;overflow:hidden}
    #${FP_ID}.collapsed .fp-body{display:none}#${FP_ID}.collapsed{width:170px}
    .fp-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:rgba(59,130,246,0.15);cursor:move;user-select:none;border-bottom:1px solid rgba(59,130,246,0.2)}
    .fp-header-title{font-weight:600;font-size:11px;color:#93c5fd}.fp-header-btns{display:flex;gap:4px}
    .fp-header-btn{background:none;border:none;color:#6b7280;cursor:pointer;font-size:14px;padding:0 2px}.fp-header-btn:hover{color:#e7e9ea}
    .fp-body{padding:8px 10px}.fp-actions{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:nowrap}
    .fp-action-btn{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 8px;color:#e7e9ea;cursor:pointer;font-size:11px;font-family:inherit;transition:background 0.15s}
    .fp-action-btn:hover{background:rgba(59,130,246,0.2);border-color:rgba(59,130,246,0.4)}
    .fp-action-btn.danger{border-color:rgba(239,68,68,0.3);color:#f87171}.fp-action-btn.danger:hover{background:rgba(239,68,68,0.15)}
    .fp-stars{display:flex;gap:1px;margin-left:auto}.fp-star{font-size:14px;cursor:pointer;color:#4b5563;user-select:none}.fp-star.active{color:#fbbf24}.fp-star:hover{color:#f59e0b}
    .fp-phrases{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
    .fp-phrase-btn{background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.25);color:#93c5fd;border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:inherit;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .fp-phrase-btn:hover{background:rgba(59,130,246,0.2)}
    .fp-notes-area{border-top:1px solid rgba(255,255,255,0.06);padding-top:6px}
    .fp-notes-input{width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:5px 7px;color:#e7e9ea;font-size:11px;font-family:inherit;resize:vertical;min-height:32px;box-sizing:border-box}
    .fp-notes-input:focus{border-color:rgba(59,130,246,0.5);outline:none}
    .fp-status{font-size:9px;color:#22c55e;margin-top:2px;min-height:11px}
    #${FP_ID} button:focus-visible,#${FP_ID} .fp-phrase-btn:focus-visible{outline:2px solid #60a5fa;outline-offset:1px}
    #${FP_ID} .fp-star:focus-visible{outline:2px solid #f59e0b;outline-offset:1px;border-radius:2px}
  `;
  (document.head || document.documentElement).appendChild(s);
}

/**
 * Build and show the draggable floating quick-action panel for a contact
 * (block, notes, rating, reminder, quick phrases). Idempotent for the same
 * contact. Reads persisted position/collapsed state and quick phrases from
 * (untrusted) localStorage + chrome.storage with try/catch and shape coercion;
 * button actions route through safeSendMessage so a mid-session extension reload
 * can't throw uncaught. Still used by other platforms (Grindr SHOW_FLOATING_PANEL);
 * Sniffies now uses the inline injectProfileActions bar instead.
 *
 * @param contactId - Namespaced contact id, e.g. "sniffies:abc123".
 * @param platform - Platform key for SW messages (defaults handled by caller).
 */
function showFloatingPanel(contactId: string, platform: string): void {
  if (!contactId || !contextValid) return;
  const existing = document.getElementById(FP_ID);
  if (existing && fpContactId === contactId) return;
  fpContactId = contactId;
  fpPlatform = platform;

  injectFloatingCSS();
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = FP_ID;

  // Load position with bounds validation
  let pos = { x: 20, y: 120 };
  try {
    const s = localStorage.getItem('aggregaytor_fp_pos');
    if (s) {
      const parsed = JSON.parse(s);
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number' &&
          isFinite(parsed.x) && isFinite(parsed.y)) {
        pos.x = Math.max(0, Math.min(parsed.x, window.innerWidth - 100));
        pos.y = Math.max(0, Math.min(parsed.y, window.innerHeight - 40));
      }
    }
  } catch {}
  panel.style.left = `${pos.x}px`;
  panel.style.top = `${pos.y}px`;

  const collapsed = localStorage.getItem('aggregaytor_fp_collapsed') === 'true';
  if (collapsed) panel.classList.add('collapsed');

  panel.innerHTML = `
    <div class="fp-header">
      <span class="fp-header-title">⚡ Quick Actions</span>
      <div class="fp-header-btns">
        <button class="fp-header-btn fp-minimize-btn" title="Minimize">−</button>
        <button class="fp-header-btn fp-close-btn" title="Close panel">×</button>
      </div>
    </div>
    <div class="fp-body">
      <div class="fp-actions">
        <button class="fp-action-btn danger fp-block-btn" title="Block/hide this profile">🚫</button>
        <button class="fp-action-btn fp-notes-btn" title="Notes">📝</button>
        <button class="fp-action-btn fp-reminder-btn" title="Set reminder">⏰</button>
        <div class="fp-stars">${[1,2,3,4,5].map(n => `<span class="fp-star" data-star="${n}">★</span>`).join('')}</div>
      </div>
      <div class="fp-phrases" id="fp-phrases"></div>
      <div class="fp-notes-area" id="fp-notes-area" style="display:none">
        <textarea class="fp-notes-input" id="fp-notes-input" placeholder="Add notes..." maxlength="10000"></textarea>
        <div class="fp-status" id="fp-status"></div>
      </div>
    </div>`;

  document.body.appendChild(panel);

  // Drag — named handlers so hideFloatingPanel can clean them up
  let dragging = false, dx = 0, dy = 0;
  panel.querySelector('.fp-header')!.addEventListener('mousedown', (e: Event) => {
    const me = e as MouseEvent;
    if ((me.target as HTMLElement).closest('.fp-header-btn')) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    dx = me.clientX - r.left; dy = me.clientY - r.top;
    me.preventDefault();
  });
  const onDragMove = (e: MouseEvent) => {
    if (!dragging) return;
    panel.style.left = `${Math.max(0, Math.min(e.clientX - dx, window.innerWidth - 100))}px`;
    panel.style.top = `${Math.max(0, Math.min(e.clientY - dy, window.innerHeight - 40))}px`;
  };
  const onDragEnd = () => {
    if (!dragging) return;
    dragging = false;
    try { localStorage.setItem('aggregaytor_fp_pos', JSON.stringify({ x: parseInt(panel.style.left), y: parseInt(panel.style.top) })); } catch {}
  };
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  _fpDragCleanup = () => {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
  };

  // Minimize — collapse to just the header bar
  panel.querySelector('.fp-minimize-btn')!.addEventListener('click', () => {
    const c = panel.classList.toggle('collapsed');
    try { localStorage.setItem('aggregaytor_fp_collapsed', String(c)); } catch {}
  });

  panel.querySelector('.fp-close-btn')!.addEventListener('click', () => hideFloatingPanel());
  // Escape-to-close. This used to be registered with `{ once: true }`, which
  // detached the handler on the FIRST keydown of any kind — so Escape only
  // worked if it happened to be the very next key the user pressed. The
  // listener is now explicitly removed when the panel goes away instead.
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && document.getElementById(FP_ID)) hideFloatingPanel();
  };
  document.addEventListener('keydown', onEscape);
  _fpEscapeCleanup = () => document.removeEventListener('keydown', onEscape);

  // Block — hide the profile on Sniffies map AND mark in aggregator.
  // When the user is viewing a profile (which is when this panel is shown),
  // we also navigate back to the map so they get immediate visual confirmation
  // that the marker is now hidden.
  panel.querySelector('.fp-block-btn')!.addEventListener('click', () => {
    const pid = fpContactId.replace(/^[a-z]+:/, '');
    console.log('[Aggregaytor:Bridge:Sniffies] Block button clicked, pid:', pid, 'fpContactId:', fpContactId);
    // Use postMessage to cross the ISOLATED→MAIN world boundary.
    // postMessage works across worlds (unlike CustomEvent which is per-world).
    // The MAIN world listens for these via window.addEventListener('message').
    window.postMessage({ type: '__aggregaytor_block', profileId: pid }, '*');
    // Mark as blocked in the aggregator service worker
    // v0.57.51: safeSendMessage swallows the sync throw on context loss.
    safeSendMessage({
      type: 'PROFILE_BLOCKED',
      contactId: fpContactId,
      platform: fpPlatform,
    }).catch(() => {});
    // Show a brief toast so the user knows the block succeeded
    showBlockToast(pid);
    // Navigate back to the map so the user can see the marker is hidden.
    // Only do this if we're currently on a /profile/ URL (the typical case
    // when the floating panel is shown on Sniffies).
    if (location.pathname.match(/\/profile\//)) {
      console.log('[Aggregaytor:Bridge:Sniffies] Navigating back from profile view after block');
      // Prefer history.back() when there's history to go back to;
      // fall back to navigating to the root of the platform otherwise.
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = 'https://sniffies.com/';
      }
    }
    hideFloatingPanel();
  });

  // Reminder — quick 1-hour reminder
  panel.querySelector('.fp-reminder-btn')!.addEventListener('click', () => {
    const dueAt = new Date(Date.now() + 3600_000).toISOString(); // 1 hour from now
    safeSendMessage({
      type: 'CREATE_REMINDER',
      contactId: fpContactId,
      platform: fpPlatform,
      note: 'Follow up',
      dueAt,
    }).catch(() => {});
    const btn = panel.querySelector('.fp-reminder-btn') as HTMLElement;
    btn.textContent = '✅';
    setTimeout(() => { btn.textContent = '⏰'; }, 1500);
  });

  // Notes toggle
  panel.querySelector('.fp-notes-btn')!.addEventListener('click', () => {
    const a = panel.querySelector('#fp-notes-area') as HTMLElement;
    a.style.display = a.style.display === 'none' ? '' : 'none';
  });

  // Notes save (debounced).
  // The contactId/platform are captured at INPUT time, not at flush time:
  // fpContactId is module-level and showFloatingPanel rewrites it, so a
  // profile switch inside the 800ms debounce window used to write the note
  // the user typed for profile A onto profile B's thread_meta.
  let nt: ReturnType<typeof setTimeout> | null = null;
  panel.querySelector('#fp-notes-input')!.addEventListener('input', (e) => {
    if (nt) clearTimeout(nt);
    const forContactId = fpContactId;
    const forPlatform = fpPlatform;
    const notes = (e.target as HTMLTextAreaElement).value;
    nt = setTimeout(() => {
      if (!forContactId) return;
      safeSendMessage({ type: 'UPSERT_THREAD_META', contactId: forContactId, platform: forPlatform, updates: { notes } }).catch(() => {});
      const st = panel.querySelector('#fp-status') as HTMLElement;
      if (st) { st.textContent = 'Saved'; setTimeout(() => { st.textContent = ''; }, 1500); }
    }, 800);
  });

  // Stars — v0.57.51: routed through safeSendMessage. Direct
  // chrome.runtime.sendMessage was throwing synchronously when the
  // extension was reloaded mid-session; the throw escaped the .catch()
  // chain because .catch only catches async rejections. Same fix
  // class as v0.57.32's seedChatTimestamps and scrapeChatPanel.
  panel.querySelectorAll('.fp-star').forEach(star => {
    star.addEventListener('click', () => {
      try {
        const r = parseInt((star as HTMLElement).dataset.star || '0');
        const cur = panel.querySelectorAll('.fp-star.active').length;
        const nr = r === cur ? 0 : r;
        panel.querySelectorAll('.fp-star').forEach((s, i) => s.classList.toggle('active', i < nr));
        safeSendMessage({ type: 'SET_RATING', contactId: fpContactId, platform: fpPlatform, rating: nr }).catch(() => {});
      } catch (err) {
        // Defensive — if the panel was orphaned by a reload mid-click, we
        // don't want the error to bubble up as Uncaught and fill the log.
        console.warn(`${LOG} fp star click error:`, (err as Error).message);
      }
    });
  });

  // Populate data
  safeSendMessage({ type: 'GET_THREAD_META', contactId }).then((res: any) => {
    const m = res?.meta || {};
    (panel.querySelector('#fp-notes-input') as HTMLTextAreaElement).value = m.notes || '';
    const rating = m.rating || 0;
    panel.querySelectorAll('.fp-star').forEach((s, i) => s.classList.toggle('active', i < rating));
    if (m.notes) (panel.querySelector('#fp-notes-area') as HTMLElement).style.display = '';
  }).catch(() => {});

  // Phrases
  chrome.storage.local.get('aggregaytor_quick_phrases', (data: any) => {
    // Stored user data of unknown shape — coerce before any .length/.slice.
    const rawPhrases = data?.aggregaytor_quick_phrases;
    const phrases: string[] = (Array.isArray(rawPhrases) && rawPhrases.length
      ? rawPhrases : ['Hey there!', "What's up?", 'Looking?'])
      .filter((p: unknown) => typeof p === 'string' && p !== '')
      .slice(0, 3);
    const c = panel.querySelector('#fp-phrases') as HTMLElement;
    if (!c) return;
    // escHtml (module scope) is byte-for-byte the same escaper this used to
    // redeclare locally.
    c.innerHTML = phrases.map((p: string) => `<button class="fp-phrase-btn" title="${escHtml(p)}">${escHtml(p.length > 18 ? p.slice(0, 16) + '…' : p)}</button>`).join('');
    c.querySelectorAll('.fp-phrase-btn').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        // Use postMessage to cross ISOLATED→MAIN world boundary
        window.postMessage({
          type: '__aggregaytor_send',
          text: phrases[i],
          contactId: fpContactId,
        }, '*');
        (btn as HTMLElement).style.background = 'rgba(34,197,94,0.2)';
        setTimeout(() => { (btn as HTMLElement).style.background = ''; }, 500);
      });
    });
  });
}

/** Remove the floating panel (or map-filter panel, which reuses FP_ID) and tear
 * down its drag/escape/message listeners so none leak against a detached node. */
function hideFloatingPanel(): void {
  document.getElementById(FP_ID)?.remove();
  fpContactId = '';
  if (_fpDragCleanup) { _fpDragCleanup(); _fpDragCleanup = null; }
  if (_fpEscapeCleanup) { _fpEscapeCleanup(); _fpEscapeCleanup = null; }
  // showMapFilterPanel reuses FP_ID, so removing "the" panel here can also be
  // removing the map-filter panel — take its listener down with it.
  if (_mapFilterPanelCleanup) { _mapFilterPanelCleanup(); _mapFilterPanelCleanup = null; }
}

// ── Inline Profile Actions ─────────────────────────────────────────────────
// Injected directly into the Sniffies profile DOM (.his-profile) as an
// alternative to the floating panel. More reliable since it's anchored to
// the profile container rather than floating over it.

const PROFILE_ACTIONS_ID = 'aggregaytor-profile-actions';
const PROFILE_ACTIONS_CSS_ID = 'aggregaytor-profile-actions-css';

// ── Local Storage for Notes + Reminders ────────────────────────────────────
// v0.57.70: ported from the userscript v0.7.46 pattern. Notes and reminders
// are now mirrored to localStorage SYNCHRONOUSLY on every save — the SW
// PouchDB write is best-effort secondary. This is what made the userscript
// version bulletproof: no IPC race, no debounce-then-navigate-loses-data,
// no silent SW handler errors. The next page load reads localStorage first
// (instant) then reconciles with whatever the SW returns from PouchDB.
//
// Schema:
//   aggregaytor_sniffies_notes_v1 = { [profileId]: noteText }
//   aggregaytor_sniffies_reminders_v1 = LocalReminder[]
//
// LocalReminder mirrors what the SW persists, plus a snapshot for offline
// rendering (the Reminders panel doesn't have to wait for the SW to load).

const SNIFFIES_NOTES_KEY = 'aggregaytor_sniffies_notes_v1';
const SNIFFIES_REMINDERS_KEY = 'aggregaytor_sniffies_reminders_v1';

/**
 * Read + JSON.parse a page-origin localStorage key, never throwing.
 *
 * localStorage on sniffies.com is shared with the host page, so every value we
 * read back is untrusted input: it can be absent, corrupt, or deliberately
 * poisoned. A bare `JSON.parse(localStorage.getItem(k) || '{}')` at the top of
 * a UI builder used to abort that whole builder (the filter bar / filter panel
 * simply never rendered) and surface as an uncaught error.
 *
 * The result is only accepted when it passes `isValid`; otherwise the caller's
 * fallback is returned.
 */
function readLocalJson<T>(key: string, fallback: T, isValid: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return isValid(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}
/** Shape guard for readLocalJson: true for a non-null, non-array object. */
const isPlainObject = (v: unknown): boolean =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON.stringify + write to localStorage, never throwing (quota, private mode). */
function writeLocalJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

interface LocalReminder {
  id: string;            // matches SW reminder._id when round-tripped
  profileId: string;
  contactId: string;     // 'sniffies:abc123'
  platform: string;
  note: string;
  dueAt: string;         // ISO 8601
  createdAt: string;     // ISO 8601
  contactSnapshot?: {
    displayName?: string;
    avatarUrl?: string;
    metadata?: Record<string, unknown>;
  };
}

/** Read the {profileId: noteText} map from page localStorage (untrusted); {} on parse failure. */
function loadLocalNotes(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SNIFFIES_NOTES_KEY) || '{}') || {}; } catch { return {}; }
}
/** Persist the notes map to localStorage; swallows quota/private-mode errors. */
function saveLocalNotes(notes: Record<string, string>): void {
  try { localStorage.setItem(SNIFFIES_NOTES_KEY, JSON.stringify(notes)); } catch {}
}
/** Set (or clear, when blank) the local note for one profile. */
function setLocalNote(profileId: string, note: string): void {
  const all = loadLocalNotes();
  if (note.trim()) all[profileId] = note;
  else delete all[profileId];
  saveLocalNotes(all);
}
/** Get the locally-stored note for a profile, or '' if none. */
function getLocalNote(profileId: string): string {
  return loadLocalNotes()[profileId] || '';
}
/** Read the reminders array from page localStorage (untrusted); [] on parse failure or non-array. */
function loadLocalReminders(): LocalReminder[] {
  try {
    const arr = JSON.parse(localStorage.getItem(SNIFFIES_REMINDERS_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
/** Persist reminders (capped to the newest 200) to localStorage; swallows storage errors. */
function saveLocalReminders(arr: LocalReminder[]): void {
  try { localStorage.setItem(SNIFFIES_REMINDERS_KEY, JSON.stringify(arr.slice(-200))); } catch {}
}
/** Append one reminder to the local store. */
function addLocalReminder(r: LocalReminder): void {
  const arr = loadLocalReminders();
  arr.push(r);
  saveLocalReminders(arr);
}
/** Remove the reminder with the given id from the local store. */
function removeLocalReminder(id: string): void {
  saveLocalReminders(loadLocalReminders().filter((r) => r.id !== id));
}
/** All local reminders for one profile, sorted by due time ascending. */
function getLocalRemindersForProfile(profileId: string): LocalReminder[] {
  return loadLocalReminders()
    .filter((r) => r.profileId === profileId)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}
/** Earliest still-pending (or recently overdue) reminder for a profile, or null. */
function getNextReminderForProfile(profileId: string): LocalReminder | null {
  const now = Date.now();
  const list = getLocalRemindersForProfile(profileId).filter((r) => {
    const t = new Date(r.dueAt).getTime();
    // Show overdue ones from the last 7 days too — they're still actionable
    return t >= now - 7 * 86_400_000;
  });
  return list[0] || null;
}
/**
 * HTML-escape a string for safe interpolation into innerHTML.
 * WHY: notes, phrases, reminder text and filter terms all originate from
 * untrusted user/page input and are rendered via innerHTML; without escaping,
 * a value containing markup (or "</textarea>") would break out and inject DOM.
 * @param s - Arbitrary (possibly untrusted) string. @returns Escaped string.
 */
function escHtml(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Format a reminder's ISO due time as a short relative label ("in 2h", "3d ago"). */
function fmtRelativeReminder(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const past = ms < 0;
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  if (mins < 60) return past ? `${mins}m ago` : `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}

/** Inject the inline profile-action bar stylesheet once per page. */
function injectProfileActionsCSS(): void {
  if (document.getElementById(PROFILE_ACTIONS_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = PROFILE_ACTIONS_CSS_ID;
  s.textContent = `
    /* v0.57.69: vertical column layout. Bar is a narrow column placed to
       the LEFT of the chat window. Buttons stack vertically and stretch to
       full column width; stars stay horizontal as a single row inside the
       column. Width is fixed (140px) so the anchor follower can compute
       left = chat.left - barWidth - 4 deterministically. The notes and
       reminder collapse panels fit naturally inside the column since they
       were already width:100%. */
    #${PROFILE_ACTIONS_ID} {
      display:flex; flex-direction:column; gap:5px; align-items:stretch;
      padding:8px 7px; margin:0;
      width:140px; box-sizing:border-box;
      background:rgba(15,20,25,0.92); border:1px solid rgba(59,130,246,0.35);
      border-radius:8px; font-family:system-ui,sans-serif; font-size:12px; color:#e7e9ea;
      backdrop-filter:blur(6px);
      max-height:calc(100vh - 16px); overflow-y:auto;
    }
    /* Floating fallback when no chat container is detected. Pinned to the
       LEFT side of the viewport, vertically centered, since the bar is a
       column now. Saved-drag positions still win via the restore code. */
    #${PROFILE_ACTIONS_ID}.pa-floating {
      position:fixed; top:50%; left:8px; transform:translateY(-50%);
      z-index:2147483646; margin:0;
      box-shadow:0 4px 16px rgba(0,0,0,0.5);
    }
    /* Anchored mode — pinned to the left of the active chat/profile
       window. left/top set inline by the follower; height is bounded by
       the chat's own height (set inline) so the column never overflows. */
    #${PROFILE_ACTIONS_ID}.pa-anchored {
      position:fixed; z-index:2147483646; margin:0;
      box-shadow:0 4px 16px rgba(0,0,0,0.5);
      border-radius:8px;
    }
    #${PROFILE_ACTIONS_ID} .pa-grip {
      cursor:move; color:#6b7280; font-size:14px; user-select:none;
      padding:2px 0; display:none; text-align:center; letter-spacing:2px;
    }
    #${PROFILE_ACTIONS_ID}.pa-floating .pa-grip { display:block; }
    #${PROFILE_ACTIONS_ID}.pa-anchored .pa-grip { display:none; }
    /* v0.57.71: collapse toggle. Visible when expanded as a small ◀
       button at the top of the column. When the column is collapsed
       (.pa-collapsed) every other child is hidden and the toggle is the
       only visible thing — it grows to a vertical handle the user can
       click to re-expand. */
    #${PROFILE_ACTIONS_ID} .pa-collapse-btn {
      align-self:flex-end; background:rgba(255,255,255,0.04);
      border:1px solid rgba(255,255,255,0.1); color:#9ca3af;
      border-radius:4px; cursor:pointer; padding:2px 6px;
      font-size:11px; line-height:1; transition:background 0.15s;
      width:auto;
    }
    #${PROFILE_ACTIONS_ID} .pa-collapse-btn:hover { background:rgba(59,130,246,0.18); color:#bfdbfe; border-color:rgba(59,130,246,0.4); }
    #${PROFILE_ACTIONS_ID}.pa-collapsed {
      width:30px; padding:6px 4px; gap:0;
      align-items:center; cursor:pointer;
    }
    #${PROFILE_ACTIONS_ID}.pa-collapsed .pa-collapse-btn {
      align-self:center; padding:6px 4px; font-size:13px;
      width:100%; box-sizing:border-box;
      background:rgba(59,130,246,0.15); border-color:rgba(59,130,246,0.4);
      color:#bfdbfe;
    }
    /* Hide everything else inside the collapsed column. The bar becomes
       a vertical sliver with just the ▶ expand button visible. */
    #${PROFILE_ACTIONS_ID}.pa-collapsed .pa-btn:not(.pa-collapse-btn),
    #${PROFILE_ACTIONS_ID}.pa-collapsed .pa-stars,
    #${PROFILE_ACTIONS_ID}.pa-collapsed .pa-notes-wrap,
    #${PROFILE_ACTIONS_ID}.pa-collapsed .pa-reminder-wrap,
    #${PROFILE_ACTIONS_ID}.pa-collapsed .pa-reminder-badge,
    #${PROFILE_ACTIONS_ID}.pa-collapsed .pa-grip {
      display:none !important;
    }
    /* Buttons fill the column width; tighter padding suits the narrower
       footprint than the previous wide-row layout. text-align:left so the
       emoji + label read as natural action items. */
    #${PROFILE_ACTIONS_ID} .pa-btn {
      background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);
      border-radius:6px; padding:5px 8px; color:#e7e9ea; cursor:pointer;
      font-size:11px; font-family:inherit; transition:background 0.15s;
      width:100%; box-sizing:border-box; text-align:left; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis;
    }
    #${PROFILE_ACTIONS_ID} .pa-btn:hover { background:rgba(59,130,246,0.2); border-color:rgba(59,130,246,0.4); }
    #${PROFILE_ACTIONS_ID} .pa-btn.danger { border-color:rgba(239,68,68,0.3); color:#f87171; }
    #${PROFILE_ACTIONS_ID} .pa-btn.danger:hover { background:rgba(239,68,68,0.15); }
    #${PROFILE_ACTIONS_ID} .pa-btn:disabled { opacity:0.5; cursor:default; }
    /* Stars row stays horizontal — 5 stars in one line, centered inside
       the column. margin-left:auto from the old wide layout would push
       them off the right edge of a 140px column, so we drop it. */
    #${PROFILE_ACTIONS_ID} .pa-stars {
      display:flex; gap:1px; justify-content:center;
      padding:2px 0; border-top:1px solid rgba(255,255,255,0.06);
    }
    #${PROFILE_ACTIONS_ID} .pa-star { font-size:15px; cursor:pointer; color:#4b5563; user-select:none; background:none; border:none; padding:0 1px; }
    #${PROFILE_ACTIONS_ID} .pa-star.active { color:#fbbf24; }
    #${PROFILE_ACTIONS_ID} .pa-star:hover { color:#f59e0b; }
    /* Reminder + notes wraps already had width:100% which works fine in
       the vertical column. The preset row inside reminder-wrap wraps to
       multiple lines because 5 chips don't fit one row at 140px wide. */
    #${PROFILE_ACTIONS_ID} .pa-reminder-wrap,
    #${PROFILE_ACTIONS_ID} .pa-notes-wrap {
      width:100%; box-sizing:border-box;
    }
    #${PROFILE_ACTIONS_ID} .pa-notes-input {
      width:100%; box-sizing:border-box; background:rgba(255,255,255,0.05);
      border:1px solid rgba(255,255,255,0.1); border-radius:5px;
      padding:5px 8px; color:#e7e9ea; font-size:11px; font-family:inherit;
      resize:vertical; min-height:28px; outline:none;
    }
    #${PROFILE_ACTIONS_ID} .pa-notes-input:focus { border-color:rgba(59,130,246,0.5); }
    #${PROFILE_ACTIONS_ID} .pa-status { font-size:9px; color:#22c55e; min-height:11px; margin-top:2px; }
  `;
  (document.head || document.documentElement).appendChild(s);
}

/**
 * Find the Sniffies profile container DOM element.
 * Checks `.his-profile` (Angular profile overlay) and `#sniffies-infowindow`.
 */
function findProfileContainer(): HTMLElement | null {
  const hisProfile = document.querySelector('.his-profile') as HTMLElement | null;
  if (hisProfile) {
    const cs = window.getComputedStyle(hisProfile);
    if (cs.visibility !== 'hidden' && cs.display !== 'none') {
      // Find the scrollable content area inside
      const scrollable = hisProfile.querySelector('div[style*="overflow"], [class*="content"], [class*="scroll"]') as HTMLElement | null;
      if (scrollable && scrollable.getBoundingClientRect().height > 100) return scrollable;
      return hisProfile;
    }
  }
  const iw = document.querySelector('#sniffies-infowindow') as HTMLElement | null;
  if (iw) {
    const cs = window.getComputedStyle(iw);
    if (cs.visibility !== 'hidden' && cs.display !== 'none') return iw;
  }
  // v0.57.37: Sniffies' chat overlay uses different markup than the
  // profile overlay (.his-profile / #sniffies-infowindow). Try a broad
  // set of plausible selectors for the chat-window container so the
  // action bar shows up there too. We sanity-check that the container
  // is actually visible and big enough to be the chat panel (not a
  // tiny tooltip). First match wins.
  const candidates = [
    'app-chat-overlay', 'app-chat-window', 'app-chat-container',
    'chat-overlay', 'chat-window', 'chat-container',
    '[class*="chat-overlay" i]', '[class*="chat-window" i]',
    '[class*="conversation-overlay" i]', '[class*="conversation-window" i]',
    '[class*="ChatOverlay"]', '[class*="ChatWindow"]',
    '[role="dialog"][class*="chat" i]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    try {
      const cs = window.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      if (rect.height < 200 || rect.width < 200) continue; // too small to be the chat
      return el;
    } catch { /* getComputedStyle on detached node */ }
  }
  // Last-resort heuristic: the element that contains the "Say something..."
  // composer textarea is almost certainly the chat panel root. Walk up
  // from the textarea to the nearest sized container.
  const composer = document.querySelector('textarea[placeholder*="Say something" i]') as HTMLElement | null;
  if (composer) {
    let node: HTMLElement | null = composer;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.height > 300 && r.width > 250) return node;
    }
  }
  return null;
}

/** Remove previously injected profile actions.
 *
 * v0.57.63: before detaching, flush any pending notes save so that switching
 * profiles within the debounce window doesn't drop the user's typing. The
 * panel exposes _flushNotes via wireProfileActionsHandlers; we call it
 * synchronously here, which fires off a chrome.runtime.sendMessage that
 * survives the panel's removal (the closure keeps the data alive).
 * v0.57.66: also tear down the anchor follower loop. */
function removeProfileActions(): void {
  const el = document.getElementById(PROFILE_ACTIONS_ID);
  if (!el) return;
  try { (el as any)._flushNotes?.(); } catch {}
  try { (el as any)._cancelAnchor?.(); } catch {}
  el.remove();
}

/**
 * Inject action buttons (hide, notes, stars) directly into the Sniffies
 * profile DOM. Called after a short delay on profile URL navigation so the
 * Angular DOM has time to render.
 */
function injectProfileActions(contactId: string, platform: string): void {
  removeProfileActions();
  injectProfileActionsCSS();

  // v0.57.66: anchor mode. Earlier versions inserted the bar AS A CHILD of
  // .his-profile / the chat overlay so Sniffies' Angular tree would clobber
  // it on every re-render, and v0.57.43 reverted to a fully-free-floating
  // bar with a drag grip. The compromise here keeps the bar in document.body
  // (which Angular never touches) but VISUALLY pins it to the bottom of the
  // chat/profile container via fixed positioning. A rAF-throttled follower
  // recomputes left/bottom/width each frame so the bar tracks the container
  // as Sniffies' UI animates open/closed; if the container disappears, the
  // follower flips the bar back to centered-floating mode automatically.
  const anchorContainer = findProfileContainer();
  const useAnchor = !!anchorContainer;

  const profileId = contactId.replace(/^[a-z]+:/, '');
  const el = document.createElement('div');
  el.id = PROFILE_ACTIONS_ID;
  el.className = useAnchor ? 'pa-anchored' : 'pa-floating';

  // Check if already blocked in the local map-filter blocklist
  const blockedIds = readLocalJson<string[]>('aggregaytor_map_blocked', [], Array.isArray);
  const isBlocked = blockedIds.includes(profileId);

  el.innerHTML = `
    <span class="pa-grip" title="Drag to reposition">⋮⋮</span>
    <!-- v0.57.71: collapse toggle at top of column. ◀ collapses to a thin
         strip; the strip shows ▶ to expand back. State persists in
         localStorage so the bar starts in the user's preferred mode every
         reload. -->
    <button class="pa-collapse-btn" title="Collapse the action bar (click again to expand)" type="button">◀</button>
    <button class="pa-btn danger pa-hide-btn" ${isBlocked ? 'disabled' : ''}>${isBlocked ? '🚫 Hidden' : '🚫 Hide'}</button>
    <button class="pa-btn pa-notes-btn" title="Toggle notes editor">📝 Notes</button>
    <button class="pa-btn pa-reminder-btn" title="Set a reminder to follow up with this person">⏰ Remind</button>
    <button class="pa-btn pa-intro-btn" title="Send a random AI-generated intro after a 5-15s human-like delay">🎲 Intro</button>
    <div class="pa-stars">
      <button class="pa-star" data-star="1">★</button>
      <button class="pa-star" data-star="2">★</button>
      <button class="pa-star" data-star="3">★</button>
      <button class="pa-star" data-star="4">★</button>
      <button class="pa-star" data-star="5">★</button>
    </div>
    <!-- v0.57.70: profile-level reminder badge. Surfaces the next pending
         reminder for this profile right inside the action bar so the user
         sees "Reminder: in 2h" the moment they open the profile, not only
         in the global Reminders viewer. Hidden when no reminder exists. -->
    <div class="pa-reminder-badge" style="display:none;font-size:10px;color:#fbbf24;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:5px;padding:4px 6px;line-height:1.3"></div>
    <div class="pa-reminder-wrap" style="display:none;width:100%;margin-top:4px">
      <input type="text" class="pa-notes-input pa-reminder-note" placeholder="Reminder note..." maxlength="200">
      <!-- v0.57.65: replaced preset dropdown with a datetime-local input so
           the user can pick exactly when. Also kept a quick-preset row of
           buttons for one-tap common cases. -->
      <input type="datetime-local" class="pa-notes-input pa-reminder-when" style="margin-top:4px;color-scheme:dark">
      <div class="pa-reminder-presets" style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">
        <button class="pa-btn pa-reminder-preset" data-offset="3600000" style="font-size:10px;padding:2px 6px;width:auto">+1h</button>
        <button class="pa-btn pa-reminder-preset" data-offset="14400000" style="font-size:10px;padding:2px 6px;width:auto">+4h</button>
        <button class="pa-btn pa-reminder-preset" data-offset="86400000" style="font-size:10px;padding:2px 6px;width:auto">Tomorrow</button>
        <button class="pa-btn pa-reminder-preset" data-offset="259200000" style="font-size:10px;padding:2px 6px;width:auto">+3d</button>
        <button class="pa-btn pa-reminder-preset" data-offset="604800000" style="font-size:10px;padding:2px 6px;width:auto">+1w</button>
      </div>
      <button class="pa-btn pa-reminder-save" style="margin-top:4px">Save reminder</button>
      <div class="pa-status pa-reminder-status"></div>
    </div>
    <!-- v0.57.70: notes wrap is now always visible. The userscript v0.7.46
         showed notes inline at the top of the profile container; we mirror
         that idea here by keeping the textarea expanded under the buttons.
         Click 📝 Notes to FOCUS the textarea (toggling visibility is no
         longer necessary since it's always shown). -->
    <div class="pa-notes-wrap" style="display:block">
      <textarea class="pa-notes-input pa-notes-textarea" placeholder="Notes about this person..." maxlength="10000"></textarea>
      <div class="pa-status pa-notes-status"></div>
    </div>
  `;

  // Always lives in document.body so Sniffies' Angular tree doesn't clobber
  // it on re-render. Visual placement is driven by either the anchor
  // follower (anchored to a chat/profile container) or saved floating coords.
  document.body.appendChild(el);

  if (useAnchor && anchorContainer) {
    // Pin to the bottom of the container; rAF-throttled so the bar tracks
    // open/close animations and resizes without burning CPU on idle frames.
    let rafId: number | null = null;
    let lastL = -1, lastB = -1, lastW = -1;
    const tick = (): void => {
      rafId = null;
      // Container vanished or got hidden — flip back to centered floating
      // mode so the bar doesn't strand in mid-air.
      if (!anchorContainer.isConnected) {
        el.classList.remove('pa-anchored');
        el.classList.add('pa-floating');
        // Clear every inline coordinate so the .pa-floating CSS defaults
        // (top:50% / left:8px / translateY(-50%)) take over. Width is
        // driven by the column rule too, so explicit clear is fine.
        el.style.left = ''; el.style.bottom = ''; el.style.width = '';
        el.style.top = ''; el.style.transform = ''; el.style.height = '';
        return;
      }
      const rect = anchorContainer.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) {
        el.classList.remove('pa-anchored');
        el.classList.add('pa-floating');
        // Clear every inline coordinate so the .pa-floating CSS defaults
        // (top:50% / left:8px / translateY(-50%)) take over. Width is
        // driven by the column rule too, so explicit clear is fine.
        el.style.left = ''; el.style.bottom = ''; el.style.width = '';
        el.style.top = ''; el.style.transform = ''; el.style.height = '';
        return;
      }
      // v0.57.69: vertical column placed to the LEFT of the chat container.
      // The bar is a fixed-width column (matched in CSS); we just compute
      // left = chat.left - barWidth - 4 each frame so it tracks the chat
      // panel as Sniffies animates it open/closed. Two fallbacks:
      //   - If gapLeft is too small (chat hugs the viewport's left edge),
      //     try the RIGHT side (left = rect.right + 4)
      //   - If neither side has room, give up the anchor and dock to the
      //     viewport's top-left corner (free-floating column with grip).
      const barW = el.offsetWidth || 140;
      const gapLeft = rect.left;
      const gapRight = window.innerWidth - rect.right;
      let left: number;
      let mode: string;
      if (gapLeft >= barW + 8) {
        left = Math.round(rect.left - barW - 4);
        mode = 'left';
      } else if (gapRight >= barW + 8) {
        left = Math.round(rect.right + 4);
        mode = 'right';
      } else {
        // No room either side — detach to floating top-left. The column
        // doesn't fit alongside the chat, so we let the user drag it.
        el.classList.remove('pa-anchored');
        el.classList.add('pa-floating');
        el.style.left = '8px';
        el.style.top = '8px';
        el.style.bottom = 'auto';
        el.style.transform = 'none';
        el.style.width = '';
        el.style.height = '';
        return;
      }
      // Vertical alignment: pin the column's top to the chat's top edge,
      // then cap its height at the chat's height so it never extends
      // past the bottom of the chat (and never grows taller than the
      // viewport with the max-height in CSS).
      const top = Math.round(Math.max(8, rect.top));
      const height = Math.round(Math.max(120, Math.min(rect.height, window.innerHeight - 16)));
      if (left !== lastL || top !== lastB || height !== lastW) {
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.bottom = 'auto';
        el.style.height = `${height}px`;
        // Width stays driven by the CSS rule (140px); clear any inline
        // width set by an earlier-version build.
        el.style.width = '';
        lastL = left; lastB = top; lastW = height;
      }
      // One-shot diagnostic when placement shape changes — useful if the
      // bar still ends up wrong on a layout we haven't seen, the log
      // tells us the chat container's rect and which branch we picked.
      if (!(el as any)._lastDiagSig || (el as any)._lastDiagSig !== `${mode}_${left}_${top}_${height}`) {
        (el as any)._lastDiagSig = `${mode}_${left}_${top}_${height}`;
        console.log('[Aggregaytor] anchor placement', {
          containerRect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) },
          gaps: { left: Math.round(gapLeft), right: Math.round(gapRight) },
          barW,
          placed: { top, left, height },
          mode,
          containerTag: anchorContainer.tagName + (anchorContainer.className ? '.' + String(anchorContainer.className).split(' ').slice(0, 2).join('.') : ''),
        });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    (el as any)._cancelAnchor = (): void => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    };
  } else {
    // Fallback: free-float at bottom-center, with a drag grip the user
    // can pull to reposition. Last position is remembered across reloads.
    // v0.57.67: one-shot migration. Earlier versions saved x/y locations
    // that the user had dragged to (often overlapping the chat composer
    // when anchored mode wasn't picking up the right container). Clear
    // any stale saved position once so the new bottom-center default
    // takes effect for everyone. Future user drags re-save under the
    // version-keyed scheme.
    const POS_VERSION = 'v0.57.69';
    try {
      if (localStorage.getItem('aggregaytor_pa_floating_pos_version') !== POS_VERSION) {
        localStorage.removeItem('aggregaytor_pa_floating_pos');
        localStorage.setItem('aggregaytor_pa_floating_pos_version', POS_VERSION);
      }
    } catch {}
    try {
      const raw = localStorage.getItem('aggregaytor_pa_floating_pos');
      if (raw) {
        const pos = JSON.parse(raw);
        if (typeof pos.x === 'number' && typeof pos.y === 'number') {
          el.style.left = `${Math.max(0, Math.min(pos.x, window.innerWidth - 100))}px`;
          el.style.top = `${Math.max(0, Math.min(pos.y, window.innerHeight - 40))}px`;
          // The saved position is absolute — cancel both the bottom anchor
          // AND the centering transform that .pa-floating defaults to.
          el.style.bottom = 'auto';
          el.style.transform = 'none';
        }
      }
    } catch {}
    const grip = el.querySelector('.pa-grip') as HTMLElement | null;
    if (grip) {
      let dragging = false; let dx = 0; let dy = 0;
      grip.addEventListener('mousedown', (ev) => {
        const r = el.getBoundingClientRect();
        dragging = true; dx = (ev as MouseEvent).clientX - r.left; dy = (ev as MouseEvent).clientY - r.top;
        ev.preventDefault();
      });
      const move = (ev: MouseEvent): void => {
        if (!dragging) return;
        const x = Math.max(0, Math.min(ev.clientX - dx, window.innerWidth - 100));
        const y = Math.max(0, Math.min(ev.clientY - dy, window.innerHeight - 40));
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        // Drag overrides the bottom-anchor default — switch to absolute top.
        el.style.bottom = 'auto';
        el.style.transform = 'none';
      };
      const end = (): void => {
        if (!dragging) return;
        dragging = false;
        try {
          localStorage.setItem('aggregaytor_pa_floating_pos', JSON.stringify({
            x: parseInt(el.style.left), y: parseInt(el.style.top),
          }));
        } catch {}
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', end);
    }
  }

  // ── Collapse / expand toggle ──
  // v0.57.71: state persists in localStorage so the bar starts in the
  // user's preferred mode every reload. Click anywhere on the collapsed
  // strip (not just the button) expands it back, since the strip is
  // tiny and "click anywhere on this thing" is the most discoverable
  // re-expand interaction.
  const COLLAPSED_KEY = 'aggregaytor_pa_collapsed';
  const collapseBtn = el.querySelector('.pa-collapse-btn') as HTMLButtonElement;
  function setCollapsed(collapsed: boolean): void {
    el.classList.toggle('pa-collapsed', collapsed);
    collapseBtn.textContent = collapsed ? '▶' : '◀';
    collapseBtn.title = collapsed ? 'Expand the action bar' : 'Collapse the action bar';
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
  }
  // Restore collapsed state from localStorage on inject.
  try {
    if (localStorage.getItem(COLLAPSED_KEY) === '1') setCollapsed(true);
  } catch {}
  collapseBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setCollapsed(!el.classList.contains('pa-collapsed'));
  });
  // Click on the collapsed strip itself (anywhere) expands it. We bind
  // to the whole element but only act when collapsed AND the click
  // wasn't on the button (its handler already toggled).
  el.addEventListener('click', (ev) => {
    if (!el.classList.contains('pa-collapsed')) return;
    if ((ev.target as HTMLElement).closest('.pa-collapse-btn')) return;
    setCollapsed(false);
  });

  // ── Hide button ──
  const hideBtn = el.querySelector('.pa-hide-btn') as HTMLButtonElement;
  hideBtn.addEventListener('click', () => {
    window.postMessage({ type: '__aggregaytor_block', profileId }, '*');
    // safeSendMessage, not a bare chrome.runtime.sendMessage: this bar lives in
    // the page until the user refreshes, so it routinely outlives an extension
    // reload, and the resulting sync throw escapes .catch().
    safeSendMessage({ type: 'PROFILE_BLOCKED', contactId, platform }).catch(() => {});
    hideBtn.textContent = '🚫 Hidden';
    hideBtn.disabled = true;
    showBlockToast(profileId);
  });

  // ── Notes always-visible editor with localStorage backing ──
  // v0.57.70: ported the userscript v0.7.46 storage pattern. Notes are
  // written to localStorage SYNCHRONOUSLY on every keystroke (debounced to
  // 200ms) AND mirrored to PouchDB via the SW. localStorage save is the
  // bulletproof fast path; the SW write is best-effort. Key insight from
  // the userscript: never wait on IPC for the source of truth — write
  // local first, then mirror.
  const notesWrap = el.querySelector('.pa-notes-wrap') as HTMLElement;
  const notesInput = el.querySelector('.pa-notes-textarea') as HTMLTextAreaElement;
  const notesStatus = el.querySelector('.pa-notes-status') as HTMLElement;
  // 📝 Notes button focuses the textarea (the wrap is now always shown).
  el.querySelector('.pa-notes-btn')!.addEventListener('click', () => {
    notesInput.focus();
    notesInput.select();
  });

  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSavedValue = '';
  /**
   * Commit the notes textarea: write to localStorage synchronously (bulletproof
   * fast path; a quota throw is logged), then best-effort mirror to PouchDB via
   * the SW. No-op when the value is unchanged. Exposed as el._flushNotes so the
   * URL-change handler can flush before the panel is torn down.
   */
  function flushNotes(): void {
    if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
    const value = notesInput.value;
    if (value === lastSavedValue) return;
    lastSavedValue = value;
    // 1. localStorage (synchronous, can't fail silently in a way that
    //    loses data — at worst we hit the storage quota and throw, which
    //    we'd see in the dev console).
    try {
      setLocalNote(profileId, value);
    } catch (err) {
      console.warn('[Aggregaytor] Notes localStorage save failed:', err);
    }
    // 2. SW mirror to PouchDB (async, best-effort, primarily for the
    //    side-panel inbox view to see notes across reloads).
    safeSendMessage({
      type: 'UPSERT_THREAD_META', contactId, platform,
      updates: { notes: value },
    }).catch(() => {});
    notesStatus.style.color = '#22c55e';
    notesStatus.textContent = '✓ Saved';
    setTimeout(() => { notesStatus.textContent = ''; }, 1500);
  }
  // Expose for URL-change handler to flush before the panel is removed.
  (el as any)._flushNotes = flushNotes;

  notesInput.addEventListener('input', () => {
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNotes, 200);
  });
  notesInput.addEventListener('blur', flushNotes);

  // Restore notes from localStorage IMMEDIATELY (instant, before any SW
  // round-trip). The SW GET_THREAD_META below also runs and can override
  // with a newer value if the user edited from a different surface
  // (e.g. side panel) since this profile was last opened.
  const localNote = getLocalNote(profileId);
  if (localNote) {
    notesInput.value = localNote;
    lastSavedValue = localNote;
  }

  // ── Star rating ──
  const stars = el.querySelectorAll('.pa-star');
  stars.forEach(star => {
    star.addEventListener('click', () => {
      const r = parseInt((star as HTMLElement).dataset.star || '0');
      const cur = el.querySelectorAll('.pa-star.active').length;
      const nr = r === cur ? 0 : r;
      stars.forEach((s, i) => s.classList.toggle('active', i < nr));
      safeSendMessage({ type: 'SET_RATING', contactId, platform, rating: nr }).catch(() => {});
    });
  });

  // ── Reminder toggle + saver ──
  // v0.57.65: real save-failure surfacing. Previously the .then ran on ANY
  // resolved Promise — including { ok: false } — so the user saw "Reminder
  // set for ..." even when the SW handler failed (silent data loss). Now
  // we check res.ok explicitly. Also: snapshot the current profile (name,
  // photo, prefs) into the request so the SW persists it on the reminder
  // doc even if the contact lookup at SW-side fails or the user later
  // blocks/deletes the contact. The Reminders viewer renders from this
  // snapshot so reminders never become "who was this again?".
  const remWrap = el.querySelector('.pa-reminder-wrap') as HTMLElement;
  const remInput = el.querySelector('.pa-reminder-note') as HTMLInputElement;
  const remWhen = el.querySelector('.pa-reminder-when') as HTMLInputElement;
  const remStatus = el.querySelector('.pa-reminder-status') as HTMLElement;
  el.querySelector('.pa-reminder-btn')!.addEventListener('click', () => {
    remWrap.style.display = remWrap.style.display === 'none' ? '' : 'none';
    if (remWrap.style.display !== 'none') {
      remInput.focus();
      // Default the datetime picker to "tomorrow at 9 AM" so the user has a
      // sensible starting point; they can pick any future moment.
      if (!remWhen.value) {
        const t = new Date();
        t.setDate(t.getDate() + 1);
        t.setHours(9, 0, 0, 0);
        // datetime-local needs YYYY-MM-DDTHH:mm format (no seconds, no TZ)
        const pad = (n: number) => String(n).padStart(2, '0');
        remWhen.value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
      }
    }
  });
  // Quick-preset buttons: set the datetime input to now + offset
  el.querySelectorAll('.pa-reminder-preset').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const offsetMs = parseInt((btn as HTMLElement).dataset.offset || '86400000', 10);
      const t = new Date(Date.now() + offsetMs);
      const pad = (n: number) => String(n).padStart(2, '0');
      remWhen.value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
    });
  });

  // Best-effort profile snapshot from the visible page DOM. Sniffies renders
  // the avatar URL into a background-image style; the displayName usually
  // appears in the page header. Falls back gracefully if anything is missing —
  // the SW will also try to fill from the contact store as a backup.
  function snapshotCurrentProfile(): { displayName?: string; avatarUrl?: string; metadata?: Record<string, unknown> } {
    const out: { displayName?: string; avatarUrl?: string; metadata?: Record<string, unknown> } = {};
    try {
      // Try common header/title selectors — Sniffies hashes class names so we
      // search broadly for an h1/h2 with text matching a profile name pattern.
      const headerEl = document.querySelector('h1, h2, [class*="profile-name"], [class*="username"]');
      const headerText = headerEl?.textContent?.trim();
      if (headerText && headerText.length < 64) out.displayName = headerText;
    } catch {}
    try {
      // Avatars on Sniffies are CSS background-image url(...) on a marker or
      // header avatar div. Find the most recent profile-id-bearing image.
      const profileId = contactId.replace(/^[a-z]+:/, '');
      const styled = Array.from(document.querySelectorAll('[style*="sniffiesassets"]'))
        .map((e) => (e as HTMLElement).style.backgroundImage || '')
        .find((bg) => bg.includes(profileId));
      const m = styled?.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
      if (m) out.avatarUrl = m[1];
    } catch {}
    try {
      // Profile metadata text (position, body, age) often appears in stats
      // pills near the avatar. Quick-and-dirty: scan a few known heuristics
      // from page text. Don't block save if this fails.
      const pillText = Array.from(document.querySelectorAll('[class*="stat"], [class*="pill"], [class*="badge"]'))
        .map((e) => e.textContent?.trim() || '').filter(Boolean).slice(0, 8).join(' · ');
      if (pillText) out.metadata = { summary: pillText.slice(0, 240) };
    } catch {}
    return out;
  }

  el.querySelector('.pa-reminder-save')!.addEventListener('click', async () => {
    let dueAt: string;
    if (remWhen.value) {
      // datetime-local returns YYYY-MM-DDTHH:mm in LOCAL time — new Date()
      // interprets that as local, then toISOString() converts to UTC.
      const local = new Date(remWhen.value);
      if (Number.isNaN(local.getTime())) {
        remStatus.textContent = 'Invalid date/time';
        remStatus.style.color = '#f87171';
        return;
      }
      if (local.getTime() <= Date.now()) {
        remStatus.textContent = 'Pick a time in the future';
        remStatus.style.color = '#fbbf24';
        return;
      }
      dueAt = local.toISOString();
    } else {
      // No explicit time — default to 24h from now
      dueAt = new Date(Date.now() + 86_400_000).toISOString();
    }
    const note = remInput.value.trim() || `Follow up with profile`;
    const contactSnapshot = snapshotCurrentProfile();
    remStatus.style.color = '';
    remStatus.textContent = 'Saving…';
    try {
      // v0.57.66: route through safeSendMessage so a sync throw on context
      // invalidation flips the global flag and surfaces a real error string
      // instead of an "Uncaught Error: Extension context invalidated" that
      // hits window.onerror and never updates the status line.
      // v0.57.70: write to localStorage IMMEDIATELY so the reminder is
      // persisted even if the SW round-trip fails. The SW write below
      // is best-effort; localStorage is the source of truth for the
      // Sniffies-page Reminders viewer + the in-bar reminder badge.
      // Generate a stable id we'll use both locally and as the SW _id
      // hint (the SW currently makes its own id but we keep ours for
      // local matching by composite-key equality).
      const localId = `local:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localReminder: LocalReminder = {
        id: localId,
        profileId,
        contactId,
        platform,
        note,
        dueAt,
        createdAt: new Date().toISOString(),
        contactSnapshot,
      };
      try { addLocalReminder(localReminder); } catch {}
      // Refresh the in-bar badge right away — the user sees the
      // reminder before the SW even responds.
      updateReminderBadge();
      // Notify the top filter bar so its Reminders chip can update
      // its count without a refresh.
      try { window.postMessage({ type: '__aggregaytor_reminders_changed' }, '*'); } catch {}

      const res: any = await safeSendMessage({
        type: 'CREATE_REMINDER', contactId, platform, note, dueAt, contactSnapshot,
      });
      if (res?.ok) {
        // Promote the local reminder's id to the SW-issued id so future
        // deletes (from the global Reminders viewer) match in localStorage.
        if (res.reminder?._id) {
          try {
            const list = loadLocalReminders();
            const idx = list.findIndex((r) => r.id === localId);
            if (idx >= 0) {
              list[idx].id = res.reminder._id;
              saveLocalReminders(list);
            }
          } catch {}
        }
        remStatus.style.color = '#34d399';
        remStatus.textContent = `✓ Reminder set for ${new Date(dueAt).toLocaleString()}`;
        setTimeout(() => { remStatus.textContent = ''; remWrap.style.display = 'none'; remInput.value = ''; remWhen.value = ''; }, 2500);
      } else {
        // SW save failed but localStorage still has the reminder. Tell
        // the user the local copy is safe so they don't think it was
        // dropped entirely.
        remStatus.style.color = '#fbbf24';
        remStatus.textContent = `Saved locally (SW: ${res?.error || 'failed'})`;
      }
    } catch (err) {
      remStatus.style.color = '#fbbf24';
      remStatus.textContent = `Saved locally (SW threw: ${(err as Error)?.message || String(err)})`;
    }
  });

  // ── Reminder badge updater ──
  // Reads from localStorage (no IPC) and renders the next-pending reminder
  // for this profile inside the bar. Called on inject, after every save,
  // and once per minute so "in 5h" ticks down to "in 4h" without a reload.
  const reminderBadge = el.querySelector('.pa-reminder-badge') as HTMLElement;
  function updateReminderBadge(): void {
    const next = getNextReminderForProfile(profileId);
    if (!next) {
      reminderBadge.style.display = 'none';
      reminderBadge.textContent = '';
      return;
    }
    const due = new Date(next.dueAt);
    const past = due.getTime() < Date.now();
    reminderBadge.style.display = '';
    reminderBadge.style.color = past ? '#f87171' : '#fbbf24';
    reminderBadge.style.borderColor = past ? 'rgba(239,68,68,0.3)' : 'rgba(251,191,36,0.3)';
    reminderBadge.style.background = past ? 'rgba(239,68,68,0.08)' : 'rgba(251,191,36,0.08)';
    const noteSnippet = next.note && next.note !== 'Follow up with profile' ? ` — ${next.note}` : '';
    reminderBadge.innerHTML = `🔔 <strong>${past ? 'Overdue' : 'Reminder'} ${escHtml(fmtRelativeReminder(next.dueAt))}</strong>${noteSnippet ? `<span style="color:#d1d5db">${escHtml(noteSnippet)}</span>` : ''}<div style="font-size:9px;color:#9ca3af;margin-top:1px">${escHtml(due.toLocaleString())}</div>`;
  }
  updateReminderBadge();
  const badgeInterval = setInterval(() => {
    if (!el.isConnected) { clearInterval(badgeInterval); return; }
    updateReminderBadge();
  }, 60_000);

  // ── Random Intro button ──
  // Fires SEND_GREETING which generates an LLM intro and queues it with a
  // randomised 5-15s delay (human-like timing). The SW handles the actual
  // platform send via sendMessageToTab → SEND_AUTO_RESPONSE relay.
  const introBtn = el.querySelector('.pa-intro-btn') as HTMLButtonElement;
  introBtn.addEventListener('click', () => {
    const orig = introBtn.textContent || '';
    introBtn.disabled = true;
    introBtn.textContent = '🎲 Sending…';
    safeSendMessage({ type: 'SEND_GREETING', contactId, platform }).then((res: any) => {
      const delaySec = Math.round(((res?.delay) || 0) / 1000);
      introBtn.textContent = `✓ Queued (${delaySec}s)`;
      setTimeout(() => { introBtn.textContent = orig; introBtn.disabled = false; }, 3000);
    }).catch(() => {
      introBtn.textContent = '✗ Failed';
      setTimeout(() => { introBtn.textContent = orig; introBtn.disabled = false; }, 2000);
    });
  });

  // ── Load existing data ──
  // v0.57.70: localStorage notes were already restored above (synchronously).
  // The SW lookup here only OVERRIDES the textarea if the SW value is newer
  // OR present while local is empty (cross-device sync case). We never
  // overwrite a non-empty local value with an empty SW value because that
  // would erase a note the user just typed.
  safeSendMessage({ type: 'GET_THREAD_META', contactId }).then((res: any) => {
    const m = res?.meta || {};
    if (m.notes && !notesInput.value) {
      notesInput.value = m.notes;
      lastSavedValue = m.notes;
      // Mirror back to localStorage so future reads are local-fast.
      try { setLocalNote(profileId, m.notes); } catch {}
    }
    const rating = m.rating || 0;
    stars.forEach((s, i) => s.classList.toggle('active', i < rating));
  }).catch(() => {});
}

// ── Top Filter Bar ─────────────────────────────────────────────────────────
// A compact horizontal strip injected at the very top of the Sniffies page
// providing quick-toggle position filters + hide counts. Complementary to
// the full floating filter panel.

const FILTER_BAR_ID = 'aggregaytor-top-filter-bar';
const FILTER_BAR_CSS_ID = 'aggregaytor-top-filter-bar-css';

/** Inject the top filter-bar stylesheet once per page. */
function injectFilterBarCSS(): void {
  if (document.getElementById(FILTER_BAR_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = FILTER_BAR_CSS_ID;
  s.textContent = `
    /* v0.57.40: z-index bumped to ~max-int so Sniffies' chat/profile
       overlay (which renders above our previous 99998) stops covering
       the bar when the user opens a profile or chat. */
    #${FILTER_BAR_ID} {
      position:fixed; top:0; left:0; right:0; z-index:2147483645;
      display:flex; align-items:center; gap:4px; padding:4px 10px;
      background:rgba(15,20,25,0.92); border-bottom:1px solid rgba(59,130,246,0.2);
      font-family:system-ui,sans-serif; font-size:10px; color:#9ca3af;
      backdrop-filter:blur(6px); flex-wrap:wrap;
    }
    #${FILTER_BAR_ID} .fb-label { font-weight:600; color:#93c5fd; margin-right:2px; font-size:10px; }
    #${FILTER_BAR_ID} .fb-chip {
      display:inline-flex; align-items:center; gap:2px; padding:2px 6px;
      background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);
      border-radius:10px; cursor:pointer; user-select:none;
      transition:background 0.12s, border-color 0.12s; font-size:10px;
    }
    #${FILTER_BAR_ID} .fb-chip input { display:none; }
    #${FILTER_BAR_ID} .fb-chip:hover { background:rgba(59,130,246,0.10); border-color:rgba(59,130,246,0.25); }
    #${FILTER_BAR_ID} .fb-chip.on { background:rgba(59,130,246,0.18); border-color:rgba(59,130,246,0.55); color:#bfdbfe; }
    #${FILTER_BAR_ID} .fb-sep { width:1px; height:14px; background:rgba(255,255,255,0.1); margin:0 2px; }
    #${FILTER_BAR_ID} .fb-hide-count { font-size:9px; color:#6b7280; margin-left:auto; }
    #${FILTER_BAR_ID} .fb-close { background:none; border:none; color:#6b7280; cursor:pointer; font-size:12px; margin-left:4px; padding:0 2px; }
    #${FILTER_BAR_ID} .fb-close:hover { color:#e7e9ea; }
    #${FILTER_BAR_ID} .fb-undo {
      background:none; border:1px solid rgba(255,255,255,0.1); border-radius:6px;
      color:#9ca3af; cursor:pointer; font-size:10px; padding:2px 6px;
    }
    #${FILTER_BAR_ID} .fb-undo:hover { background:rgba(255,255,255,0.06); color:#e7e9ea; }
    #${FILTER_BAR_ID} .fb-chip:focus-within { outline:2px solid #60a5fa; outline-offset:1px; border-radius:10px; }
    #${FILTER_BAR_ID} .fb-undo:focus-visible, #${FILTER_BAR_ID} .fb-close:focus-visible { outline:2px solid #60a5fa; outline-offset:1px; }
  `;
  (document.head || document.documentElement).appendChild(s);
}

// v0.57.20: track the paddingTop value that was on <body> before we applied
// our offset, so removeTopFilterBar() can restore it rather than clobbering
// any user/Sniffies-applied padding back to ''. This matters because some
// Sniffies layouts set `padding-top: env(safe-area-inset-top)` on iOS —
// resetting to '' there loses the inset and tiles the map under the
// status bar.
let _originalBodyPaddingTop: string | null = null;

// Detaches the three `window.addEventListener('message', …)` handlers that
// showTopFilterBar() registers. Without this, every re-create of the bar (close
// it, re-open it from the filter panel, navigate, …) left the previous set
// attached to a bar that no longer exists — they kept running querySelector on
// a detached tree for the life of the page.
let _filterBarCleanup: (() => void) | null = null;

/**
 * Build and show the compact top filter bar (position toggles, chat-activity
 * toggles, text-filter toggles, undo, reminders chip, hide-count). Idempotent.
 *
 * Reads filter settings + blocklist from untrusted page localStorage via
 * readLocalJson (shape-checked, never throws). Registers three window 'message'
 * listeners (topbar sync, reminders-changed, filter stats) — all guarded on
 * event.source === window so a third-party iframe can't drive the UI — and
 * tracks them in _filterBarCleanup so re-creating the bar never leaks handlers
 * onto a detached node.
 */
function showTopFilterBar(): void {
  if (document.getElementById(FILTER_BAR_ID)) return;
  // Drop any listeners left over from a previous bar before wiring new ones.
  if (_filterBarCleanup) { _filterBarCleanup(); _filterBarCleanup = null; }
  injectFilterBarCSS();

  const settings = readLocalJson<Record<string, unknown>>('aggregaytor_map_filter_settings', {}, isPlainObject);
  const blockedCount = readLocalJson<string[]>('aggregaytor_map_blocked', [], Array.isArray).length;

  const positions = [
    { key: 'hideBottom',     label: 'Btm' },
    { key: 'hideVersBottom', label: 'V-Btm' },
    { key: 'hideVers',       label: 'Vers' },
    { key: 'hideVersTop',    label: 'V-Top' },
    { key: 'hideTop',        label: 'Top' },
    { key: 'hideSide',       label: 'Side' },
    { key: 'hideUnspecified', label: '?' },
  ];
  const extras = [
    { key: 'showChatAgeBadges', label: '🕐 Ages' },
    { key: 'excludeEnabled', label: '🚫 Text' },
    { key: 'includeEnabled', label: '⭐ Text' },
  ];
  // "Waiting on response" filters — hide profiles whose most recent message
  // is mine (outbound). The marker reappears the moment they reply.
  // Plus the v0.57.29 "platform inactivity" filter: hide markers whose last-
  // active timestamp is older than 2h. Profiles with no last-active signal
  // are LEFT VISIBLE so unknowns aren't penalised.
  const chatHistory = [
    { key: 'hideRecentChats', label: '⏳ <24h' },
    { key: 'hideAnyChats', label: '⏳ Ghosted' },
    { key: 'hideInactiveOver2h', label: '🟢 ≤2h' },
  ];

  const bar = document.createElement('div');
  bar.id = FILTER_BAR_ID;

  const activeCount = [...positions, ...chatHistory, ...extras].filter(p => settings[p.key]).length;
  bar.innerHTML = `
    <span class="fb-label">Filter${activeCount ? ` (${activeCount})` : ''}:</span>
    ${positions.map(p => `<label class="fb-chip ${settings[p.key] ? 'on' : ''}"><input type="checkbox" data-key="${p.key}" ${settings[p.key] ? 'checked' : ''}>${p.label}</label>`).join('')}
    <span class="fb-sep"></span>
    ${chatHistory.map(p => {
      const tip = p.key === 'hideRecentChats'
        ? 'Hide profiles you\'ve chatted with in the last 24h, in either direction. Use this to declutter the map of people you\'re already talking to.'
        : p.key === 'hideAnyChats'
          ? 'Hide profiles where your last message went unanswered (waiting on their reply), any age. They reappear the moment they respond.'
          : 'Hide markers whose last platform activity is more than 2 hours ago. Profiles with no last-active signal are left visible — the partials API backfills timestamps as the map loads.';
      return `<label class="fb-chip ${settings[p.key] ? 'on' : ''}" title="${tip}"><input type="checkbox" data-key="${p.key}" ${settings[p.key] ? 'checked' : ''}><span class="fb-chip-label" data-chip="${p.key}">${p.label}</span></label>`;
    }).join('')}
    <span class="fb-sep"></span>
    ${extras.map(p => `<label class="fb-chip ${settings[p.key] ? 'on' : ''}"><input type="checkbox" data-key="${p.key}" ${settings[p.key] ? 'checked' : ''}>${p.label}</label>`).join('')}
    <span class="fb-sep"></span>
    <button class="fb-undo" title="Undo last hide">Undo</button>
    <button class="fb-undo fb-settings" title="Open full filter settings (text terms, position highlights, save/restore)">⚙ Settings</button>
    <!-- v0.57.70: Reminders chip — opens a popup with all upcoming + recently-
         overdue reminders for this device. Reads from localStorage so it
         works even when the SW is asleep. Click a row to open that profile. -->
    <button class="fb-undo fb-reminders" title="Show reminders set on Sniffies profiles">⏰ <span class="fb-reminders-count"></span></button>
    <span class="fb-hide-count">${blockedCount} hidden</span>
    <button class="fb-close" title="Close filter bar">✕</button>
  `;

  document.body.appendChild(bar);

  // Preserve whatever padding was already on the body, then push content down.
  if (_originalBodyPaddingTop === null) {
    _originalBodyPaddingTop = document.body.style.paddingTop || '';
  }
  document.body.style.paddingTop = `${bar.offsetHeight}px`;

  // ── Auto-apply on toggle ──
  function applyFromBar() {
    const update: Record<string, unknown> = {};
    let onCount = 0;
    bar.querySelectorAll('input[data-key]').forEach((cb) => {
      const el = cb as HTMLInputElement;
      update[el.dataset.key as string] = el.checked;
      el.closest('.fb-chip')?.classList.toggle('on', el.checked);
      if (el.checked) onCount++;
    });
    const label = bar.querySelector('.fb-label');
    if (label) label.textContent = `Filter${onCount ? ` (${onCount})` : ''}:`;
    // Merge with existing settings (preserve text terms, blocked list, etc.)
    const prev = readLocalJson<Record<string, unknown>>('aggregaytor_map_filter_settings', {}, isPlainObject);
    delete (prev as any).blockedIds;
    const merged = { ...prev, ...update };
    delete (merged as any).blockedIds;
    writeLocalJson('aggregaytor_map_filter_settings', merged);
    // v0.57.57: tag with source so the floating Map Filters window
    // (also listening on this message) can ignore its own echoes and
    // re-render only when the OTHER UI changed settings.
    window.postMessage({ type: '__aggregaytor_map_filter_settings', update: merged, _source: 'topbar' }, '*');
  }

  bar.querySelectorAll('input[data-key]').forEach(cb => {
    cb.addEventListener('change', applyFromBar);
  });

  // v0.57.57: receive settings updates from the floating Map Filters
  // window and re-sync our chips. We ignore our own broadcasts via
  // the _source check so we don't loop. localStorage is the source of
  // truth; we just re-read and update checkbox + chip-on states.
  const topbarSyncListener = (event: MessageEvent) => {
    // Same-frame posts only. Every legitimate sender (this bridge, the MAIN
    // world script) posts into this window; without the check any embedded
    // iframe could drive our filter UI.
    if (event.source !== window) return;
    if (!event.data || event.data.type !== '__aggregaytor_map_filter_settings') return;
    if (event.data._source === 'topbar') return; // own post, skip
    const settings = event.data.update || {};
    let onCount = 0;
    bar.querySelectorAll('input[data-key]').forEach((cb) => {
      const el = cb as HTMLInputElement;
      const key = el.dataset.key as string;
      const v = !!settings[key];
      el.checked = v;
      el.closest('.fb-chip')!.classList.toggle('on', v);
      if (v) onCount++;
    });
    const label = bar.querySelector('.fb-label');
    if (label) label.textContent = `Filter${onCount ? ` (${onCount})` : ''}:`;
  };
  window.addEventListener('message', topbarSyncListener);

  // Undo last hide
  bar.querySelector('.fb-undo')!.addEventListener('click', () => {
    window.postMessage({ type: '__aggregaytor_undo_hide' }, '*');
    // Update count after a brief delay
    setTimeout(() => {
      const count = readLocalJson<string[]>('aggregaytor_map_blocked', [], Array.isArray).length;
      const countEl = bar.querySelector('.fb-hide-count');
      if (countEl) countEl.textContent = `${count} hidden`;
    }, 200);
  });

  // Settings — bring the full floating filter panel to the foreground.
  // The panel has all the controls the top bar doesn't: position highlights,
  // text term editors, save/restore, undo. We re-show it (idempotent) and
  // un-collapse it so it lands open even if the user had minimised it.
  bar.querySelector('.fb-settings')!.addEventListener('click', () => {
    showMapFilterPanel();
    const fp = document.getElementById(FP_ID);
    if (fp) {
      fp.classList.remove('collapsed');
      try { localStorage.setItem('aggregaytor_fp_collapsed', 'false'); } catch {}
      // Pop above other UI
      fp.style.zIndex = '99999';
    }
  });

  // v0.57.70: Reminders chip — opens a popup listing all upcoming +
  // recently-overdue reminders. Reads from localStorage so the panel
  // renders instantly (no SW round-trip needed). Each row is clickable
  // to open the profile, with a ✕ delete that fires both locally and to
  // the SW. The chip label shows the count of pending reminders.
  function refreshRemindersChipCount(): void {
    try {
      const list = loadLocalReminders();
      const now = Date.now();
      const pending = list.filter((r) => new Date(r.dueAt).getTime() >= now - 7 * 86_400_000);
      const countEl = bar.querySelector('.fb-reminders-count') as HTMLElement | null;
      if (countEl) countEl.textContent = pending.length ? `(${pending.length})` : '';
    } catch {}
  }
  refreshRemindersChipCount();
  // Listen for reminder-changed events (e.g. when a profile saves a new
  // reminder via the action bar) so the chip count stays in sync.
  const remindersChangedListener = (ev: MessageEvent) => {
    if (ev.source !== window) return;
    if (ev.data?.type === '__aggregaytor_reminders_changed') refreshRemindersChipCount();
  };
  window.addEventListener('message', remindersChangedListener);
  bar.querySelector('.fb-reminders')!.addEventListener('click', () => {
    showRemindersPanel();
  });

  // Close bar
  bar.querySelector('.fb-close')!.addEventListener('click', () => {
    bar.remove();
    removeBarListeners();
    document.body.style.paddingTop = _originalBodyPaddingTop ?? '';
    _originalBodyPaddingTop = null;
    try { localStorage.setItem('aggregaytor_top_filter_bar_hidden', 'true'); } catch {}
  });

  // Listen for filter stats broadcasts from the MAIN-world map-filters
  // and update the waiting-on-response chip labels in real time. This
  // makes it obvious when the filter is actually doing something —
  // previously with only ~41 waiting profiles out of 3000+ and <5
  // visible on screen at a time, it felt like the filter wasn't working.
  const statsListener = (event: MessageEvent) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== '__aggregaytor_filter_stats') return;
    const s = event.data.stats;
    if (!s) return;
    const bar = document.getElementById(FILTER_BAR_ID);
    if (!bar) { removeBarListeners(); return; }
    // Update chip labels — show "⏳ <24h (3)" when 3 markers are hidden
    const chip24 = bar.querySelector('[data-chip="hideRecentChats"]');
    const chipEver = bar.querySelector('[data-chip="hideAnyChats"]');
    if (chip24) {
      chip24.textContent = s.hiddenByWaiting24h > 0 ? `⏳ <24h (${s.hiddenByWaiting24h})` : '⏳ <24h';
    }
    if (chipEver) {
      chipEver.textContent = s.hiddenByWaitingEver > 0 ? `⏳ Ghosted (${s.hiddenByWaitingEver})` : '⏳ Ghosted';
    }
    const chipInactive = bar.querySelector('[data-chip="hideInactiveOver2h"]');
    if (chipInactive) {
      chipInactive.textContent = s.hiddenByInactive > 0 ? `🟢 ≤2h (${s.hiddenByInactive})` : '🟢 ≤2h';
    }
    // Also update the right-side "N hidden" counter to show the total
    // across all filter types (block + text + attitude + waiting + inactive).
    const total = (s.hiddenByBlock || 0) + (s.hiddenByText || 0) + (s.hiddenByAttitude || 0)
                + (s.hiddenByWaiting24h || 0) + (s.hiddenByWaitingEver || 0)
                + (s.hiddenByInactive || 0);
    const countEl = bar.querySelector('.fb-hide-count');
    if (countEl) countEl.textContent = `${total} hidden${s.waiting ? ` · ${s.waiting} waiting` : ''}`;
  };
  window.addEventListener('message', statsListener);

  function removeBarListeners(): void {
    window.removeEventListener('message', topbarSyncListener);
    window.removeEventListener('message', remindersChangedListener);
    window.removeEventListener('message', statsListener);
    _filterBarCleanup = null;
  }
  _filterBarCleanup = removeBarListeners;
}

/** Remove the top filter bar, restore the body's original padding-top, and
 * detach its window message listeners. */
function removeTopFilterBar(): void {
  const bar = document.getElementById(FILTER_BAR_ID);
  if (bar) {
    bar.remove();
    document.body.style.paddingTop = _originalBodyPaddingTop ?? '';
    _originalBodyPaddingTop = null;
  }
  if (_filterBarCleanup) { _filterBarCleanup(); _filterBarCleanup = null; }
}

/** Show a brief toast in the bottom-right to confirm a block action. */
function showBlockToast(profileId: string): void {
  const ID = 'aggregaytor-block-toast';
  document.getElementById(ID)?.remove();
  const toast = document.createElement('div');
  toast.id = ID;
  toast.style.cssText =
    'position:fixed;bottom:20px;right:20px;z-index:999999;' +
    'background:rgba(220,38,38,0.95);color:#fff;padding:10px 16px;' +
    'border-radius:8px;font-family:system-ui,sans-serif;font-size:13px;' +
    'box-shadow:0 4px 12px rgba(0,0,0,0.4);transition:opacity 0.3s';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.textContent = `🚫 Profile blocked${profileId ? ' (' + profileId.slice(0, 8) + '…)' : ''}`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; }, 1600);
  setTimeout(() => toast.remove(), 2000);
}

// ── Reminders Panel ────────────────────────────────────────────────────────
// v0.57.70: in-page reminders viewer triggered from the ⏰ chip in the top
// filter bar. Reads from localStorage (instant) and renders a card per
// reminder with the snapshotted profile photo + name + relative due time.
// Click a card → navigate to the profile (Sniffies SPA pushState). Click ✕
// → delete both locally and via SW.

const REMINDERS_PANEL_ID = 'aggregaytor-reminders-panel';

/**
 * Toggle the in-page reminders viewer: a card per upcoming / recently-overdue
 * reminder, rendered from (untrusted) localStorage — every interpolated field
 * goes through escHtml. Cards navigate to the profile via SPA pushState; the ✕
 * deletes locally and, unless the id is a local-only "local:" id, fires
 * DELETE_REMINDER to the SW via safeSendMessage. Closes on outside click.
 */
function showRemindersPanel(): void {
  // Toggle: if already open, close.
  const existing = document.getElementById(REMINDERS_PANEL_ID);
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.id = REMINDERS_PANEL_ID;
  panel.style.cssText = [
    'position:fixed', 'top:36px', 'right:8px', 'z-index:2147483646',
    'width:340px', 'max-height:calc(100vh - 60px)',
    'background:rgba(15,20,25,0.97)',
    'border:1px solid rgba(59,130,246,0.4)',
    'border-radius:8px',
    'box-shadow:0 8px 24px rgba(0,0,0,0.6)',
    'font-family:system-ui,sans-serif', 'color:#e7e9ea', 'font-size:12px',
    'overflow:hidden', 'display:flex', 'flex-direction:column',
  ].join(';');

  const list = loadLocalReminders().sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const now = Date.now();
  const upcoming = list.filter((r) => new Date(r.dueAt).getTime() >= now);
  const overdue = list.filter((r) => {
    const t = new Date(r.dueAt).getTime();
    return t < now && t >= now - 7 * 86_400_000;
  });

  const header = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:rgba(59,130,246,0.15);border-bottom:1px solid rgba(59,130,246,0.25)">
      <strong style="color:#bfdbfe;font-size:13px">⏰ Reminders</strong>
      <button class="aggregaytor-rp-close" style="background:none;border:none;color:#9ca3af;font-size:16px;cursor:pointer;padding:0 4px" title="Close">✕</button>
    </div>
  `;
  const renderRow = (r: LocalReminder): string => {
    const snap = r.contactSnapshot || {};
    const meta = (snap.metadata as Record<string, unknown>) || {};
    const avatar = snap.avatarUrl
      ? `<img src="${escHtml(snap.avatarUrl)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex:0 0 36px" alt="">`
      : `<div style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;flex:0 0 36px;font-size:16px">👤</div>`;
    const name = snap.displayName || r.profileId.slice(0, 10);
    const summary = String((meta as { summary?: string }).summary || '').slice(0, 60);
    const due = new Date(r.dueAt);
    const past = due.getTime() < Date.now();
    const relTime = fmtRelativeReminder(r.dueAt);
    return `
      <div class="aggregaytor-rp-card" data-id="${escHtml(r.id)}" data-profile-id="${escHtml(r.profileId)}" style="display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;align-items:center">
        ${avatar}
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;gap:6px;align-items:baseline">
            <strong style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(name)}</strong>
            <span style="color:${past ? '#f87171' : '#34d399'};font-size:10px;flex:0 0 auto" title="${escHtml(due.toLocaleString())}">${escHtml(relTime)}</span>
          </div>
          ${summary ? `<div style="font-size:9px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(summary)}</div>` : ''}
          ${r.note && r.note !== 'Follow up with profile' ? `<div style="font-size:11px;color:#d1d5db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.note)}</div>` : ''}
          <div style="font-size:9px;color:#6b7280">${escHtml(due.toLocaleString())}</div>
        </div>
        <button class="aggregaytor-rp-del" data-id="${escHtml(r.id)}" title="Delete reminder" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#f87171;border-radius:4px;padding:3px 7px;font-size:11px;cursor:pointer;flex:0 0 auto">✕</button>
      </div>
    `;
  };

  let body = '<div style="flex:1;overflow-y:auto">';
  if (overdue.length) {
    body += `<div style="font-size:10px;color:#f87171;text-transform:uppercase;letter-spacing:0.5px;padding:8px 12px 4px">Overdue (${overdue.length})</div>`;
    body += overdue.map(renderRow).join('');
  }
  if (upcoming.length) {
    body += `<div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;padding:8px 12px 4px">Upcoming (${upcoming.length})</div>`;
    body += upcoming.map(renderRow).join('');
  }
  if (!overdue.length && !upcoming.length) {
    body += '<div style="padding:24px 12px;color:#9ca3af;font-size:11px;text-align:center;line-height:1.5">No reminders yet.<br>Open a profile and click <strong>⏰ Remind</strong> on the action bar to set one.</div>';
  }
  body += '</div>';

  panel.innerHTML = header + body;
  document.body.appendChild(panel);

  panel.querySelector('.aggregaytor-rp-close')!.addEventListener('click', () => panel.remove());
  // Click outside closes
  setTimeout(() => {
    const offClick = (ev: MouseEvent): void => {
      if (!panel.contains(ev.target as Node)) {
        panel.remove();
        document.removeEventListener('mousedown', offClick, true);
      }
    };
    document.addEventListener('mousedown', offClick, true);
  }, 50);

  // Card click → navigate to the profile (avoid clicks on the delete btn).
  panel.querySelectorAll('.aggregaytor-rp-card').forEach((card) => {
    card.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('.aggregaytor-rp-del')) return;
      const pid = (card as HTMLElement).dataset.profileId;
      if (pid) {
        // Navigate via SPA history pushState — Sniffies' Angular router
        // listens for popstate and re-renders without a hard reload.
        try {
          history.pushState({}, '', `/profile/${pid}`);
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        } catch {
          location.href = `/profile/${pid}`;
        }
        panel.remove();
      }
    });
  });

  // Delete button — drops localStorage entry + fires SW DELETE_REMINDER.
  panel.querySelectorAll('.aggregaytor-rp-del').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = (btn as HTMLElement).dataset.id;
      if (!id) return;
      removeLocalReminder(id);
      // SW delete is best-effort. If id starts with 'local:' the SW never
      // saw it (failed initial save) so skip the IPC.
      if (!id.startsWith('local:')) {
        safeSendMessage({ type: 'DELETE_REMINDER', id }).catch(() => {});
      }
      // Re-render the panel to reflect the removal.
      panel.remove();
      showRemindersPanel();
      // Bump the chip count.
      try { window.postMessage({ type: '__aggregaytor_reminders_changed' }, '*'); } catch {}
    });
  });
}

// ── Map Filter Floating Panel ─────────────────────────────────────────────
// Shows filter controls instead of profile actions when on the map view

/** Detaches showMapFilterPanel's window message listener. See fp-close-btn. */
let _mapFilterPanelCleanup: (() => void) | null = null;

/**
 * Build and show the full floating Map Filters panel (position/chat/text
 * filters with live auto-save). Reuses FP_ID, so it's mutually exclusive with
 * the floating quick-action panel. Settings come from untrusted page
 * localStorage (shape-checked via readLocalJson; term lists escHtml'd before
 * innerHTML). Applies changes to the MAIN world via postMessage (CustomEvents
 * don't cross worlds) tagged with _source to avoid echo loops, and registers a
 * window 'message' sync listener (guarded on event.source === window) tracked
 * in _mapFilterPanelCleanup so it can't leak.
 */
function showMapFilterPanel(): void {
  if (document.getElementById(FP_ID)) return; // already showing something
  if (_mapFilterPanelCleanup) { _mapFilterPanelCleanup(); _mapFilterPanelCleanup = null; }

  injectFloatingCSS();
  const panel = document.createElement('div');
  panel.id = FP_ID;

  let pos = { x: 20, y: 120 };
  try {
    const s = localStorage.getItem('aggregaytor_fp_pos');
    if (s) {
      const parsed = JSON.parse(s);
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number' &&
          isFinite(parsed.x) && isFinite(parsed.y)) {
        pos.x = Math.max(0, Math.min(parsed.x, window.innerWidth - 100));
        pos.y = Math.max(0, Math.min(parsed.y, window.innerHeight - 40));
      }
    }
  } catch {}
  panel.style.left = `${pos.x}px`;
  panel.style.top = `${pos.y}px`;

  const collapsed = localStorage.getItem('aggregaytor_fp_collapsed') === 'true';
  if (collapsed) panel.classList.add('collapsed');

  const settings = readLocalJson<Record<string, any>>('aggregaytor_map_filter_settings', {}, isPlainObject);

  // Inject the CSS for the redesigned filter panel (only once per page load).
  if (!document.getElementById('aggregaytor-fp-filters-css')) {
    const st = document.createElement('style');
    st.id = 'aggregaytor-fp-filters-css';
    st.textContent = `
      #${FP_ID} .fp-section { margin-bottom:10px }
      #${FP_ID} .fp-section-hdr { display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;color:#9ca3af;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em }
      #${FP_ID} .fp-switch { display:inline-flex;align-items:center;gap:4px;color:#9ca3af;font-size:10px;cursor:pointer;text-transform:none;font-weight:400;letter-spacing:0 }
      #${FP_ID} .fp-switch input { margin:0 }
      #${FP_ID} .fp-switch.on { color:#3b82f6 }
      #${FP_ID} .fp-chips { display:flex;flex-wrap:wrap;gap:3px }
      #${FP_ID} .fp-chip { display:inline-flex;align-items:center;gap:3px;padding:2px 6px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;font-size:10px;color:#9ca3af;cursor:pointer;user-select:none;transition:background 0.12s,border-color 0.12s }
      #${FP_ID} .fp-chip input { display:none }
      #${FP_ID} .fp-chip:hover { background:rgba(59,130,246,0.10);border-color:rgba(59,130,246,0.25) }
      #${FP_ID} .fp-chip.checked { background:rgba(59,130,246,0.18);border-color:rgba(59,130,246,0.55);color:#bfdbfe }
      #${FP_ID} .fp-terms { width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:5px 7px;color:#e7e9ea;font-size:10px;font-family:inherit;resize:vertical;min-height:32px }
      #${FP_ID} .fp-terms:focus { border-color:rgba(59,130,246,0.5);outline:none }
      #${FP_ID} .fp-disabled { opacity:0.35;pointer-events:none }
      #${FP_ID} .fp-hint { color:#6b7280;font-size:9px;font-style:italic;margin-top:2px }
      #${FP_ID} .fp-save-state { font-size:9px;color:#22c55e;min-height:11px;margin-top:4px;text-align:center }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  const posAttributes = ['Bottom', 'VersBottom', 'Vers', 'VersTop', 'Top', 'Side', 'Unspecified'];

  // Filter terms are rendered into a <textarea> below via innerHTML. They come
  // from page-origin localStorage, so they must be (a) shape-checked — a
  // non-array would throw on .join and kill the whole panel — and (b) HTML
  // escaped, or a term containing "</textarea>" breaks out of the element and
  // injects markup into our own UI.
  const termLines = (v: unknown): string =>
    escHtml((Array.isArray(v) ? v : []).filter((t) => typeof t === 'string').join('\n'));

  panel.innerHTML = `
    <div class="fp-header">
      <span class="fp-header-title">⚡ Map Filters</span>
      <div class="fp-header-btns">
        <button class="fp-header-btn fp-minimize-btn" title="Minimize">−</button>
        <button class="fp-header-btn fp-close-btn" title="Close panel">×</button>
      </div>
    </div>
    <div class="fp-body" style="font-size:11px">
      <div class="fp-section">
        <div class="fp-section-hdr">Hide by position</div>
        <div class="fp-chips">
          ${posAttributes.map(att => {
            const key = `hide${att}`;
            const isOn = !!settings[key];
            const label = att.replace('VersBottom','Vers-Btm').replace('VersTop','Vers-Top').replace('Unspecified','Unspec.');
            return `<label class="fp-chip ${isOn ? 'checked' : ''}">
              <input type="checkbox" class="fp-filter-cb" data-key="${key}" ${isOn ? 'checked' : ''}> ${label}
            </label>`;
          }).join('')}
        </div>
      </div>

      <div class="fp-section">
        <div class="fp-section-hdr">Chat activity</div>
        <div class="fp-chips">
          <label class="fp-chip ${settings.hideRecentChats ? 'checked' : ''}">
            <input type="checkbox" class="fp-filter-cb" data-key="hideRecentChats" ${settings.hideRecentChats ? 'checked' : ''}> Hide chatted &lt;24h
          </label>
          <label class="fp-chip ${settings.showChatAgeBadges ? 'checked' : ''}">
            <input type="checkbox" class="fp-filter-cb" data-key="showChatAgeBadges" ${settings.showChatAgeBadges ? 'checked' : ''}> Show age badges
          </label>
        </div>
      </div>

      <div class="fp-section">
        <div class="fp-section-hdr">
          <span>🚫 Hide profiles containing…</span>
          <label class="fp-switch ${settings.excludeEnabled ? 'on' : ''}" data-switch="excludeEnabled">
            <input type="checkbox" class="fp-filter-cb" data-key="excludeEnabled" ${settings.excludeEnabled ? 'checked' : ''}>
            <span>${settings.excludeEnabled ? 'ON' : 'off'}</span>
          </label>
        </div>
        <div class="fp-filter-wrap ${settings.excludeEnabled ? '' : 'fp-disabled'}" data-wrap-for="excludeEnabled">
          <textarea class="fp-terms" id="fp-exclude-terms" rows="2" placeholder="one term per line — e.g.&#10;trans&#10;no fats">${termLines(settings.excludeTerms)}</textarea>
        </div>
      </div>

      <div class="fp-section">
        <div class="fp-section-hdr">
          <span>⭐ Highlight profiles containing…</span>
          <label class="fp-switch ${settings.includeEnabled ? 'on' : ''}" data-switch="includeEnabled">
            <input type="checkbox" class="fp-filter-cb" data-key="includeEnabled" ${settings.includeEnabled ? 'checked' : ''}>
            <span>${settings.includeEnabled ? 'ON' : 'off'}</span>
          </label>
        </div>
        <div class="fp-filter-wrap ${settings.includeEnabled ? '' : 'fp-disabled'}" data-wrap-for="includeEnabled">
          <textarea class="fp-terms" id="fp-include-terms" rows="2" placeholder="one term per line — e.g.&#10;bbc&#10;daddy">${termLines(settings.includeTerms)}</textarea>
        </div>
      </div>

      <div class="fp-hint">Changes save automatically as you type.</div>
      <button class="fp-action-btn" id="fp-show-topbar" style="margin-top:4px;width:100%;font-size:10px">Show top filter bar</button>
      <div class="fp-save-state" id="fp-save-state"></div>
    </div>`;

  document.body.appendChild(panel);

  // Drag
  let dragging = false, dx = 0, dy = 0;
  panel.querySelector('.fp-header')!.addEventListener('mousedown', (e: Event) => {
    const me = e as MouseEvent;
    if ((me.target as HTMLElement).closest('.fp-header-btn')) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    dx = me.clientX - r.left; dy = me.clientY - r.top;
    me.preventDefault();
  });
  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    panel.style.left = `${Math.max(0, e.clientX - dx)}px`;
    panel.style.top = `${Math.max(0, e.clientY - dy)}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    try { localStorage.setItem('aggregaytor_fp_pos', JSON.stringify({ x: parseInt(panel.style.left), y: parseInt(panel.style.top) })); } catch {}
  });

  panel.querySelector('.fp-minimize-btn')!.addEventListener('click', () => {
    const c = panel.classList.toggle('collapsed');
    try { localStorage.setItem('aggregaytor_fp_collapsed', String(c)); } catch {}
  });
  panel.querySelector('.fp-close-btn')!.addEventListener('click', () => {
    panel.remove();
    // The panel can be re-created on every return to the map view, so its
    // window message listener has to go with it — otherwise each open/close
    // cycle left another handler bound to a detached panel.
    if (_mapFilterPanelCleanup) { _mapFilterPanelCleanup(); _mapFilterPanelCleanup = null; }
  });

  // ── Auto-Apply Filters ──────────────────────────────────────────────────
  // Everything auto-saves: checkboxes apply immediately, textareas apply
  // after a 400ms debounce so you can type without reapplying on every key.
  // postMessage is used to cross the ISOLATED→MAIN world boundary (CustomEvents
  // don't cross worlds, which is why the old Apply Filters button did nothing).
  function collectAndApply(flashLabel: string = 'Saved') {
    const update: Record<string, unknown> = {};
    panel.querySelectorAll('.fp-filter-cb').forEach((cb) => {
      const el = cb as HTMLInputElement;
      update[el.dataset.key as string] = el.checked;
    });
    update.excludeTerms = ((panel.querySelector('#fp-exclude-terms') as HTMLTextAreaElement)?.value || '')
      .split('\n').map((l) => l.trim()).filter((l) => l);
    update.includeTerms = ((panel.querySelector('#fp-include-terms') as HTMLTextAreaElement)?.value || '')
      .split('\n').map((l) => l.trim()).filter((l) => l);

    // Merge with existing settings in localStorage so we don't clobber
    // anything that the side panel wrote but this panel doesn't expose.
    const prev = readLocalJson<Record<string, unknown>>('aggregaytor_map_filter_settings', {}, isPlainObject);
    // Never carry blockedIds through the filter-panel path. BLOCKED_KEY is
    // the single source of truth for hides — letting a stale array leak
    // through here caused freshly-hidden profiles to reappear seconds later.
    delete (prev as any).blockedIds;
    const merged = { ...prev, ...update };
    delete (merged as any).blockedIds;
    writeLocalJson('aggregaytor_map_filter_settings', merged);

    // Cross the ISOLATED→MAIN world boundary via postMessage.
    // sniffies.ts relays this to the map-filters CustomEvent listener.
    // v0.57.57: tag _source so the top filter bar can re-sync its
    // chips without echoing our own broadcasts back at us.
    window.postMessage({ type: '__aggregaytor_map_filter_settings', update: merged, _source: 'mapfilters' }, '*');

    const state = panel.querySelector('#fp-save-state') as HTMLElement;
    if (state) {
      state.textContent = `✓ ${flashLabel}`;
      setTimeout(() => { if (state.textContent === `✓ ${flashLabel}`) state.textContent = ''; }, 1200);
    }

    // Update each on/off switch label and the textarea disabled styling
    panel.querySelectorAll('.fp-switch').forEach((sw) => {
      const key = (sw as HTMLElement).dataset.switch;
      const cb = sw.querySelector('input') as HTMLInputElement;
      if (!cb) return;
      sw.classList.toggle('on', cb.checked);
      const label = sw.querySelector('span');
      if (label) label.textContent = cb.checked ? 'ON' : 'off';
      const wrap = panel.querySelector(`[data-wrap-for="${key}"]`);
      if (wrap) wrap.classList.toggle('fp-disabled', !cb.checked);
    });

    // Update chip styling
    panel.querySelectorAll('.fp-chip').forEach((chip) => {
      const cb = chip.querySelector('input') as HTMLInputElement;
      if (cb) chip.classList.toggle('checked', cb.checked);
    });
  }

  // Checkbox change → apply immediately
  panel.querySelectorAll('.fp-filter-cb').forEach((cb) => {
    cb.addEventListener('change', () => collectAndApply('Applied'));
  });

  // Textareas → debounced save (400ms after user stops typing)
  let textTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedApply = () => {
    if (textTimer) clearTimeout(textTimer);
    textTimer = setTimeout(() => collectAndApply('Saved'), 400);
  };
  panel.querySelector('#fp-exclude-terms')?.addEventListener('input', debouncedApply);
  panel.querySelector('#fp-include-terms')?.addEventListener('input', debouncedApply);
  // Also apply on blur so clicking away commits any pending changes
  panel.querySelector('#fp-exclude-terms')?.addEventListener('blur', () => collectAndApply('Saved'));
  panel.querySelector('#fp-include-terms')?.addEventListener('blur', () => collectAndApply('Saved'));

  // Show top filter bar button
  panel.querySelector('#fp-show-topbar')?.addEventListener('click', () => {
    try { localStorage.removeItem('aggregaytor_top_filter_bar_hidden'); } catch {}
    showTopFilterBar();
  });

  // Sync on first render in case settings drifted between panel opens
  collectAndApply('Synced');

  // v0.57.57: receive settings updates from the top filter bar (or any
  // other source) and re-render our checkboxes / textareas without
  // echoing back. The _source check prevents the loop. localStorage is
  // the source of truth — we just re-read it and refresh the controls.
  const mapfiltersSyncListener = (event: MessageEvent) => {
    // Same-frame posts only — see the note on topbarSyncListener.
    if (event.source !== window) return;
    if (!event.data || event.data.type !== '__aggregaytor_map_filter_settings') return;
    if (event.data._source === 'mapfilters') return;
    const settings = event.data.update || {};
    panel.querySelectorAll('.fp-filter-cb').forEach((cb) => {
      const el = cb as HTMLInputElement;
      const key = el.dataset.key as string;
      el.checked = !!settings[key];
    });
    // `.value` is a safe sink (no markup parsing) but the shape still has to
    // be checked — settings arrive on a window message any page script can post.
    const asLines = (v: unknown): string =>
      (Array.isArray(v) ? v : []).filter((t) => typeof t === 'string').join('\n');
    const exTerms = panel.querySelector('#fp-exclude-terms') as HTMLTextAreaElement;
    if (exTerms) exTerms.value = asLines(settings.excludeTerms);
    const inTerms = panel.querySelector('#fp-include-terms') as HTMLTextAreaElement;
    if (inTerms) inTerms.value = asLines(settings.includeTerms);
    // Refresh visual switch / chip states without re-broadcasting
    panel.querySelectorAll('.fp-switch').forEach((sw) => {
      const key = (sw as HTMLElement).dataset.switch;
      const cb = sw.querySelector('input') as HTMLInputElement | null;
      if (!cb) return;
      sw.classList.toggle('on', cb.checked);
      const label = sw.querySelector('span');
      if (label) label.textContent = cb.checked ? 'ON' : 'off';
      const wrap = panel.querySelector(`[data-wrap-for="${key}"]`);
      if (wrap) wrap.classList.toggle('fp-disabled', !cb.checked);
    });
    panel.querySelectorAll('.fp-chip').forEach((chip) => {
      const cb = chip.querySelector('input') as HTMLInputElement | null;
      if (cb) chip.classList.toggle('checked', cb.checked);
    });
  };
  window.addEventListener('message', mapfiltersSyncListener);
  _mapFilterPanelCleanup = () => window.removeEventListener('message', mapfiltersSyncListener);
}

// ── URL Change Detection ────────────────────────────────────────────────────
// Sniffies is an SPA (Angular) that uses pushState for navigation. When the
// user opens a profile or conversation, the URL changes but NO page load or
// popstate event fires — pushState does NOT trigger popstate. popstate only
// fires when the user clicks the browser Back/Forward buttons.
//
// To detect URL changes from in-app navigation (clicking on profiles, opening
// chats), we poll with setInterval (below) and compare against the last known
// URL. When we detect a change to a profile URL, we notify the service worker
// so the popup/sidebar can show the active conversation. When the user opens
// the chat list (/chat), we trigger a scrape of visible conversations.

let lastUrl = location.href;

/** Check if the URL has changed since last poll and handle the new route. */
// v0.57.20: track the pending profile-action retry timers so a rapid SPA
// navigation (user flicks through profiles on the map) doesn't stack up
// closures that each try to re-render actions for a profile the user has
// already left. Without cancellation, clicking through 5 profiles in 2s
// could leave behind 10 pending retries that all fight over the DOM.
const _profileActionTimers: ReturnType<typeof setTimeout>[] = [];
const _PROFILE_ACTION_TIMERS_MAX = 10;
/** Cancel every pending profile-action retry timer (called on SPA navigation so
 * stale retries don't paint actions for a profile the user already left). */
function clearProfileActionTimers(): void {
  while (_profileActionTimers.length) {
    const t = _profileActionTimers.pop();
    if (t) clearTimeout(t);
  }
}
/** Track a profile-action retry timer, evicting the oldest past a hard cap of
 * _PROFILE_ACTION_TIMERS_MAX so rapid navigation can't accumulate closures. */
function addProfileActionTimer(t: ReturnType<typeof setTimeout>): void {
  if (_profileActionTimers.length >= _PROFILE_ACTION_TIMERS_MAX) {
    const old = _profileActionTimers.shift();
    if (old) clearTimeout(old);
  }
  _profileActionTimers.push(t);
}

/**
 * Detect an SPA URL change since the last tick and, when it changed, refresh
 * the profile-action UI for the new route. Cheap to call on an interval.
 * @returns nothing
 */
function checkUrlChange() {
  if (!contextValid) return;
  const url = location.href;
  if (url === lastUrl) return;
  lastUrl = url;

  // Check if the new URL is a profile page: /profile/{hexId} or /profile/{hexId}/chat.
  // dom.profileIdFromHref captures the same hex for both shapes (its match stops
  // at the hex, so a trailing /chat is irrelevant).
  const profileId = dom.profileIdFromHref(url);
  if (profileId) {
    const contactId = `sniffies:${profileId}`;
    try {
      chrome.runtime.sendMessage({ type: 'ACTIVE_PROFILE_CHANGED', contactId, platform: 'sniffies' }).catch(() => {});
    } catch {}
    // Force a conversation-history refresh: Sniffies' own UI sometimes leaves
    // the chat panel blank until the user sends a message, which can lead to
    // messaging over prior context the user can't see. The adapter (MAIN
    // world) hits the chat-data endpoint itself and relies on the existing
    // fetch interceptor to extract messages from the response. Debounced
    // per-profile inside the adapter, so rapid SPA navigation is safe.
    // postMessage crosses the ISOLATED→MAIN world boundary.
    window.postMessage({ type: '__aggregaytor_refresh_conversation', profileId }, '*');
    // v0.57.30: dropped the showFloatingPanel(contactId, 'sniffies') call —
    // the inline profile-action bar (injectProfileActions below) now carries
    // hide/notes/stars/reminder/intro in a row anchored to the profile DOM
    // rather than a draggable overlay. Floating panel is still defined and
    // used by other platforms (Grindr SHOW_FLOATING_PANEL relay) but no
    // longer auto-shown on Sniffies profile navigation.
    // Inject actions directly into the profile DOM. Delay to allow Angular
    // to render the profile view.
    // Cancel any pending retries from a previous profile — otherwise we'd
    // paint actions for stale contacts over the current profile container.
    clearProfileActionTimers();
    removeProfileActions();
    addProfileActionTimer(setTimeout(() => injectProfileActions(contactId, 'sniffies'), 600));
    addProfileActionTimer(setTimeout(() => {
      if (!document.getElementById(PROFILE_ACTIONS_ID)) injectProfileActions(contactId, 'sniffies');
    }, 1500));
  } else {
    // Left profile view — clean up profile-specific UI
    hideFloatingPanel();
    clearProfileActionTimers();
    removeProfileActions();
    // v0.57.40: keep the top filter bar visible on EVERY sniffies.com URL
    // (not just /map) so it doesn't blink out when the user clicks a
    // profile, opens a chat, or navigates to /messages. Previously the
    // bar was only re-shown on /map matches and removed everywhere else.
    // showMapFilterPanel still gates on the map view because the floating
    // filter editor only makes sense there.
    if (url.match(/sniffies\.com\/?(\?|$|#)/i) || url.match(/sniffies\.com\/map/i)) {
      showMapFilterPanel();
    }
    const barHidden = localStorage.getItem('aggregaytor_top_filter_bar_hidden') === 'true';
    if (!barHidden) showTopFilterBar();
    try {
      chrome.runtime.sendMessage({ type: 'PROFILE_CLOSED', platform: 'sniffies' }).catch(() => {});
    } catch {}
  }

  // Scrape the Recents panel whenever the URL changes. The panel can appear
  // on both /chat and the map view as a drawer, so we try scraping on any
  // Sniffies URL — scrapeChatPanel is a no-op if no rows are found.
  setTimeout(() => scrapeChatPanel(), 1500);
}
/**
 * Scrape the Sniffies chat panel (/chat) for the conversation list.
 *
 * This function reads the Angular-rendered DOM to extract contacts and their
 * most recent message preview. Unlike the adapter's fetch/WS interception
 * (which captures messages in transit), this scrapes what's already rendered
 * on screen — useful for populating the context engine on first load or when
 * the user opens the chat panel.
 *
 * DOM structure (Sniffies Angular components):
 *   <chat-list-vertical-item>          — one per conversation row
 *     .avatar-img                      — background-image CSS with CDN URL
 *       URL: profile.sniffiesassets.com/{hexId}/...  (real user avatar)
 *       URL: site.sniffiesassets.com/...              (default avatar, skipped)
 *     [data-testid="msgConversationPreview"] span  — message preview text
 *       (or .content-preview span as fallback)
 *     .message-date                    — relative timestamp ("2h ago", etc.)
 *     .fa-reply                        — Font Awesome icon, present = you sent the last message
 *     .fa-thumbtack                    — Font Awesome icon, present = conversation is pinned
 *     .unread-count                    — badge with unread message count
 */
// v0.57.41: scraper went stale. Sniffies renamed/restructured the Recents
// drawer at some point and `chat-list-vertical-item` no longer matches —
// scrapeChatPanel returned 0 rows for ~13 days while the user's own UI
// kept showing fresh DMs. The new scraper:
//   1. Tries the original selector first, then falls back to anything that
//      looks like a chat row (custom-element pattern, role=listitem, .row-
//      class with an avatar image, etc.)
//   2. Pulls the avatar URL from EITHER background-image OR <img src> OR
//      child of the row matching the sniffiesassets pattern
//   3. Pulls the preview from any descendant span/div with non-trivial
//      text that's not the timestamp
//   4. Always logs result counts so we can see in the console whether the
//      scrape is finding rows even when 0 messages are emitted
/**
 * Scrape the currently-open chat panel's messages from the DOM as a fallback
 * when the WebSocket feed missed them, returning normalized rows for upsert.
 * Guarded so a malformed DOM node can't abort the scan.
 * @returns an array of scraped message rows (possibly empty)
 */
function scrapeChatPanel() {
  if (!contextValid || !checkContext()) return;

  const contacts: any[] = [];
  const messages: any[] = [];
  let selectorUsed = '';

  // Selector cascade — first hit wins.
  let rows: NodeListOf<Element> = document.querySelectorAll('chat-list-vertical-item');
  if (rows.length) selectorUsed = 'chat-list-vertical-item';
  if (!rows.length) {
    rows = document.querySelectorAll('[class*="chat-list-vertical-item" i]');
    if (rows.length) selectorUsed = '[class*="chat-list-vertical-item"]';
  }
  if (!rows.length) {
    rows = document.querySelectorAll('app-chat-list-item, app-conversation-row, app-recent-conversation');
    if (rows.length) selectorUsed = 'app-chat-list-item|app-conversation-row|app-recent-conversation';
  }
  if (!rows.length) {
    // Custom elements with "chat" or "conversation" in their tag name
    const all = document.querySelectorAll('*');
    const matches: Element[] = [];
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (tag.includes('-') && (/chat-list|chat-row|conversation-row|conversation-item|recent-conversation/.test(tag))) {
        matches.push(el);
      }
    }
    if (matches.length) {
      // Build a NodeList-like wrapper so the rest of the function works
      rows = (matches as unknown) as NodeListOf<Element>;
      selectorUsed = `tag-name-heuristic (${matches.length} elements: ${matches[0].tagName.toLowerCase()})`;
    }
  }
  if (!rows.length) {
    // Last resort: any element that contains a sniffiesassets profile avatar
    // AND has at least one descendant text node — that's probably a chat row.
    const avatarParents = new Set<Element>();
    document.querySelectorAll('[style*="profile.sniffiesassets" i], img[src*="profile.sniffiesassets" i]').forEach(el => {
      // Walk up to a reasonable container ancestor
      let node: Element | null = el;
      for (let i = 0; node && i < 6; i++, node = node.parentElement) {
        if (!node.parentElement) break;
        // Stop at a container that has at least 2 siblings sharing a tag
        const parent = node.parentElement;
        if (parent.children.length >= 2) {
          avatarParents.add(node);
          break;
        }
      }
    });
    if (avatarParents.size) {
      rows = (Array.from(avatarParents) as unknown) as NodeListOf<Element>;
      selectorUsed = `avatar-walk-up (${avatarParents.size} parents)`;
    }
  }

  rows.forEach(row => {
    try {
      // -- Profile ID from avatar URL --
      // Try background-image on .avatar-img first (legacy), then any element
      // with a sniffiesassets profile URL in its style or src.
      let bgStyle = '';
      let avatarUrl = '';
      const avatarEl = (row.querySelector('.avatar-img') || row.querySelector('[class*="avatar" i]')) as HTMLElement | null;
      if (avatarEl) {
        bgStyle = avatarEl.style?.backgroundImage || '';
        if (!bgStyle) {
          try { bgStyle = getComputedStyle(avatarEl).backgroundImage || ''; } catch {}
        }
      }
      // Fallback: search the entire row for a profile.sniffiesassets URL in any attribute
      let idMatch = bgStyle.match(/profile\.sniffiesassets\.com\/([0-9a-f]{6,})\//i);
      if (!idMatch) {
        const rowHtml = (row as HTMLElement).outerHTML || '';
        idMatch = rowHtml.match(/profile\.sniffiesassets\.com\/([0-9a-f]{6,})\//i);
        if (idMatch) {
          // Pull avatar URL out of the full HTML too
          const urlMatch = rowHtml.match(/(https?:\/\/profile\.sniffiesassets\.com\/[^\s"'<>]+)/i);
          if (urlMatch) avatarUrl = urlMatch[1];
        }
      } else {
        avatarUrl = bgStyle.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/)?.[1] || '';
      }
      if (!idMatch) return; // default avatar — no profile ID extractable
      const profileId = idMatch[1].toLowerCase();

      // -- Message preview text --
      // Original selectors first, then any text container.
      const previewEl = row.querySelector('[data-testid="msgConversationPreview"] span')
        || row.querySelector('.content-preview span')
        || row.querySelector('[class*="preview" i] span')
        || row.querySelector('[class*="preview" i]')
        || row.querySelector('[class*="snippet" i]');
      let preview = previewEl?.textContent?.trim() || '';
      preview = preview.replace(/\s+/g, ' ').trim();

      // -- Direction detection --
      const sentByYou = !!row.querySelector('.fa-reply, [class*="reply" i] i, [aria-label*="sent" i]');
      const direction = sentByYou ? 'out' : 'in';

      // -- Timestamp --
      const timeEl = row.querySelector('.message-date')
        || row.querySelector('[class*="message-date" i]')
        || row.querySelector('[class*="timestamp" i]')
        || row.querySelector('time');
      const timeText = timeEl?.textContent?.trim() || '';

      // -- Pinned status --
      const isPinned = !!row.querySelector('.fa-thumbtack, [class*="pin" i]');

      // -- Unread count --
      const unreadEl = row.querySelector('.unread-count, [class*="unread-count" i], [class*="badge-unread" i]');
      const unreadCount = parseInt(unreadEl?.textContent?.trim() || '0') || 0;

      // Create a contact record for this conversation partner
      contacts.push({
        id: `sniffies:${profileId}`,
        platform: 'sniffies',
        platformUserId: profileId,
        displayName: '', // display name not available from chat panel
        profileUrl: `https://sniffies.com/profile/${profileId}`,
        avatarUrl,
        lastSeen: new Date().toISOString(),
        metadata: { isPinned },
      });

      // Create a message record from the preview (if non-empty). We use a
      // DETERMINISTIC id based on preview content + timestamp so repeated
      // scrapes of the same row don't create duplicate message docs — the
      // adapter's store-level dedup also catches this but a stable id is
      // cheaper.
      if (preview.length > 1) {
        const ts = parseRelativeTime(timeText);
        // 5-minute bucket so minor parse drift collapses together
        const bucket = Math.floor(new Date(ts).getTime() / 300000);
        const bodyHash = preview.slice(0, 40).replace(/\s+/g, '').toLowerCase();
        messages.push({
          id: `sniffies:chatpanel-${profileId}-${bucket}-${bodyHash}`,
          platform: 'sniffies',
          threadId: `sniffies:${profileId}`, // thread = contact for 1:1
          contactId: `sniffies:${profileId}`,
          direction,
          body: preview.slice(0, 200),
          timestamp: ts, // use message time, not download time
          read: unreadCount === 0, // mark as read only if unread badge is absent
          metadata: {
            profileId, source: 'chat-panel', avatarUrl,
            isPinned, unreadCount, timeText,
          },
        });
      }
    } catch { /* skip individual row parse errors */ }
  });

  // v0.57.41: log EVERY scrape, even when 0 rows found. The Apr 15 → Apr 28
  // freeze went undetected for 13 days because the previous code suppressed
  // empty-result logs — the scraper had silently stopped finding rows after
  // a Sniffies DOM rename and we had no signal in the console. Per-scrape
  // logging is cheap (~1 line / 15s) and is the only way to notice the
  // selector going stale next time.
  console.log(`[Aggregaytor:Bridge:Sniffies] scrape: ${rows.length} rows, ${contacts.length} contacts, ${messages.length} messages${selectorUsed ? ` (selector: ${selectorUsed})` : ''}`);

  // Send scraped contacts and messages to the service worker. safeSendMessage
  // catches the sync throw that fires when the extension is reloaded mid-
  // session (the bridge interval keeps running in the orphaned page until
  // the user refreshes — without the wrap, the throw escapes here as the
  // top-level "Uncaught Error: Extension context invalidated" we saw on
  // sniffies chat pages).
  if (contacts.length) {
    safeSendMessage({ type: 'ADAPTER_CONTACTS', platform: 'sniffies', payload: contacts }).catch(() => {});
  }
  if (messages.length) {
    safeSendMessage({ type: 'ADAPTER_MESSAGES', platform: 'sniffies', payload: messages }).catch(() => {});
  }
}

// Scrape immediately at extension load (with a short delay for Angular to
// render) so we pick up any rows already visible. scrapeChatPanel is a
// no-op when no rows are found, so running it unconditionally is safe.
setTimeout(() => scrapeChatPanel(), 3000);

// Also scrape every 15s while the page is open. The Sniffies Recents panel
// updates in-place via Angular bindings — new conversations appear without
// any route change. Periodic scraping is the only way to catch them promptly.
// 15s is a balance between freshness and CPU — the scrape itself is ~1-3ms
// per row and a typical Recents panel has <30 rows.
registerBackgroundTimer(setInterval(() => scrapeChatPanel(), 15_000));

// Additionally, watch for new chat-list-vertical-item elements appearing in
// the DOM and re-scrape immediately. This covers the case where a new
// conversation arrives while the user is idle on the map view.
try {
  const chatPanelObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof Element && (
          node.tagName === 'CHAT-LIST-VERTICAL-ITEM' ||
          node.querySelector?.('chat-list-vertical-item')
        )) {
          // Debounce: a burst of mutations should only trigger one scrape.
          if (!(window as any).__aggregaytor_scrape_pending) {
            (window as any).__aggregaytor_scrape_pending = true;
            setTimeout(() => {
              (window as any).__aggregaytor_scrape_pending = false;
              scrapeChatPanel();
            }, 800);
          }
          return;
        }
      }
    }
  });
  // This bridge is registered with `run_at: document_start`, so at this point
  // in the module body `document.body` is still null — `observe(null)` threw a
  // TypeError that the catch below swallowed, and the observer was never
  // installed at all. Observing <html> covers <body> once the parser creates
  // it, and subtree:true means we still see every chat row insertion.
  chatPanelObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
} catch (err) {
  console.warn(`${LOG} chat-panel MutationObserver setup failed:`, (err as Error)?.message || err);
}

// ── URL Change Polling ──────────────────────────────────────────────────────
// Poll every 3 seconds because pushState (used by Angular Router for in-app
// navigation) does NOT fire any native DOM event. popstate only fires for
// browser Back/Forward buttons. Polling is the only reliable way to detect
// when the user clicks a profile or opens a conversation within the SPA.
registerBackgroundTimer(setInterval(checkUrlChange, 3000));
window.addEventListener('popstate', checkUrlChange);

// v0.57.40: top filter bar on ALL sniffies.com URLs at initial load,
// not just the map. The user wants the chips visible while they click
// through profiles and chats too. Honors the "explicitly closed" flag.
{
  const barHidden = localStorage.getItem('aggregaytor_top_filter_bar_hidden') === 'true';
  if (!barHidden) setTimeout(() => showTopFilterBar(), 1000);
}

// v0.57.40: DOM-driven profile-actions injector. The URL-based path in
// checkUrlChange only fires on /profile/{hex}(/chat)? matches, which
// silently misses anonymous-cruiser overlays and any URL-shape drift
// from Sniffies' SPA router. This poller runs every 1.5s and asks
// "is a Sniffies profile/chat container open right now?" via the same
// findProfileContainer() heuristics injectProfileActions uses. If yes
// AND the bar isn't already painted, inject. If the container goes
// away, remove the bar. Independent of the URL path entirely — works
// on every overlay variant.
/**
 * Resolve the profile the user is currently viewing from the DOM/route, with
 * its container element for anchoring the action bar. Serializes DOM on a
 * throttled path; returns null when no profile is confidently identified.
 * @returns `{ contactId, container }` or null
 */
function activeProfileFromDom(): { contactId: string; container: HTMLElement | null } | null {
  // v0.57.43: composer-first detection. The previous URL+container path
  // missed the case the user keeps hitting — Sniffies' /chat route renders
  // a chat overlay WITHOUT a /profile/{hex} URL, AND the chat overlay
  // markup keeps drifting so findProfileContainer() returns null. The one
  // signal that has stayed stable across every Sniffies UI revision is
  // the "Say something..." composer textarea — it's on every chat view.
  // If we see it, a chat is open.

  // 1. Hex URL — authoritative when present. Delegates to dom.profileIdFromHref.
  const urlId = dom.profileIdFromHref(location.pathname);
  if (urlId) {
    return { contactId: `sniffies:${urlId}`, container: findProfileContainer() };
  }

  // 2. Composer textarea on screen → a chat is being viewed even without
  //    a /profile URL. Try to extract the profile id from any avatar hex
  //    in the same chat container; fall back to a stable synthetic id.
  const composer = document.querySelector('textarea[placeholder*="Say something" i]') as HTMLElement | null;
  if (composer) {
    let root: HTMLElement | null = composer;
    for (let i = 0; root && i < 10; i++) {
      const r = root.getBoundingClientRect();
      if (r.height > 300 && r.width > 250) break;
      root = root.parentElement;
    }
    const html = (root || document.body).outerHTML || '';
    const avatarHex = dom.profileIdFromAssetUrl(html);
    return {
      contactId: avatarHex ? `sniffies:${avatarHex}` : 'sniffies:active-chat',
      container: root,
    };
  }

  // 3. Standalone profile container (no chat composer, just a profile card).
  const container = findProfileContainer();
  if (!container) return null;
  const avatarHex = dom.profileIdFromAssetUrl(container.outerHTML);
  return {
    contactId: avatarHex ? `sniffies:${avatarHex}` : 'sniffies:anonymous-overlay',
    container,
  };
}

let _lastDomInjectId = '';
/**
 * DOM-driven poll (every 1.5s) that injects/removes the inline profile-action
 * bar based on whether a Sniffies profile/chat container is currently open —
 * independent of the URL path, so it catches overlay variants the URL matcher
 * in checkUrlChange misses. Re-injects only when the active contact changes.
 */
function tickDomDrivenProfileActions(): void {
  if (!contextValid) return;
  const found = activeProfileFromDom();
  if (!found) {
    // Container went away — clean up so we don't leak a stale bar over the map.
    if (document.getElementById(PROFILE_ACTIONS_ID)) {
      removeProfileActions();
      _lastDomInjectId = '';
    }
    return;
  }
  // Already painted for this contact? leave it alone.
  if (_lastDomInjectId === found.contactId && document.getElementById(PROFILE_ACTIONS_ID)) return;
  _lastDomInjectId = found.contactId;
  injectProfileActions(found.contactId, 'sniffies');
}
registerBackgroundTimer(setInterval(tickDomDrivenProfileActions, 1500));
setTimeout(tickDomDrivenProfileActions, 1200);

// v0.57.41: console-callable diagnostic. Run __aggregaytor_diagnose() in
// the Sniffies tab DevTools to print:
//   - which scraper selector matches the current DOM (or "no rows found")
//   - whether the MAIN-world adapter is loaded and how many API responses
//     it has parsed (window.__aggregaytor_perf.stats() shape)
//   - the latest scrape numbers, captured into a {sample} object so the
//     user can paste the result into a bug report
// Lives on ISOLATED window — the user runs it from the page console after
// switching the execution-context dropdown to the Aggregaytor bridge.
(window as any).__aggregaytor_diagnose = function (): unknown {
  const out: Record<string, unknown> = { ts: new Date().toISOString(), url: location.href };
  // 1. Probe each scrape selector and record the row count.
  const selectors = [
    'chat-list-vertical-item',
    '[class*="chat-list-vertical-item" i]',
    'app-chat-list-item',
    'app-conversation-row',
    'app-recent-conversation',
    '[class*="conversation" i]',
  ];
  out.selectors = selectors.reduce((acc: Record<string, number>, s) => {
    try { acc[s] = document.querySelectorAll(s).length; } catch { acc[s] = -1; }
    return acc;
  }, {});
  // 2. Custom elements with chat/conversation in tag name
  const customTags = new Set<string>();
  document.querySelectorAll('*').forEach(el => {
    const t = el.tagName.toLowerCase();
    if (t.includes('-') && /chat|conv|message|recent/.test(t)) customTags.add(t);
  });
  out.relevantCustomTags = [...customTags].sort();
  // 3. Avatar element count
  out.avatarsOnPage = document.querySelectorAll('[style*="profile.sniffiesassets" i], img[src*="profile.sniffiesassets" i]').length;
  // 4. Composer presence
  out.hasComposer = !!document.querySelector('textarea[placeholder*="Say something" i]');
  // 5. Adapter health from MAIN world (if available)
  const w = window as any;
  out.adapterPerf = w.__aggregaytor_perf?.stats?.() || 'unavailable (MAIN world script not loaded?)';
  console.log('[Aggregaytor:Diagnose]', out);
  return out;
};

// ── Seed Chat Activity for Map Filters ─────────────────────────────────────
// map-filters.ts (MAIN world) uses a per-profile {myLastTs, theirLastTs}
// record to drive the "waiting on response" filters. Without a seed it
// would only know about messages received during this session.
//
// Format written: { [profileId]: { my: <ms>, them: <ms> } }
// Re-seeded every 60s so newly-received responses flip the "waiting"
// predicate and unhide the marker without requiring a page reload.
//
// Uses GET_CHAT_ACTIVITY which scans the full Sniffies message corpus in
// the SW to produce per-direction timestamps (vs. GET_THREAD_SUMMARIES
// which only gives the single most-recent message's direction).
// In-flight guard — setInterval fires every 60s regardless of whether the
// previous call completed. Before the allDocs optimization, scans took up
// to 400s and 6+ overlapping seeds would pile up, paralysing PouchDB.
// This flag ensures at most one seed is running at a time; subsequent
// ticks are skipped if the previous hasn't returned yet.
let seedInFlight = false;
let _lastSeedProfileCount = -1;  // skip log when count unchanged

/**
 * Seed synthetic timestamps for chat rows lacking them so ordering stays
 * stable before the WebSocket supplies real times. Best-effort; never throws.
 * @returns nothing
 */
function seedChatTimestamps(): void {
  if (!contextValid) return;
  if (seedInFlight) {
    console.log(`${LOG} Skipping seed — previous still in flight`);
    return;
  }
  seedInFlight = true;
  const t0 = performance.now();
  safeSendMessage({ type: 'GET_CHAT_ACTIVITY', platform: 'sniffies' }).then((res: any) => {
    if (!res?.ok) {
      console.warn(`${LOG} GET_CHAT_ACTIVITY failed:`, res?.error || 'no response');
      return;
    }
    if (!res.activity || typeof res.activity !== 'object') {
      console.warn(`${LOG} GET_CHAT_ACTIVITY returned invalid shape:`, typeof res.activity);
      return;
    }
    const map: Record<string, { my: number; them: number }> = {};
    let profileCount = 0;
    for (const [id, val] of Object.entries(res.activity)) {
      const v = val as { myLastTs?: number; theirLastTs?: number };
      const my = typeof v.myLastTs === 'number' && isFinite(v.myLastTs) ? v.myLastTs : 0;
      const them = typeof v.theirLastTs === 'number' && isFinite(v.theirLastTs) ? v.theirLastTs : 0;
      if (my > 0 || them > 0) {
        map[String(id).toLowerCase()] = { my, them };
        profileCount++;
      }
    }
    // Write to localStorage so fresh page loads have the data at init.
    try { localStorage.setItem('aggregaytor_sniffies_chat_ts', JSON.stringify(map)); } catch {}
    // Also push live to the MAIN-world map-filters so the current session
    // picks up historical data immediately (without waiting for a page
    // reload). postMessage crosses the ISOLATED→MAIN world boundary.
    window.postMessage({ type: '__aggregaytor_chat_activity_seed', activity: map }, '*');
    const elapsed = Math.round(performance.now() - t0);
    // Only log when the profile count changes or the scan is slow (>500ms).
    // Steady-state noise was one line per minute with no useful signal —
    // now we only surface genuine state changes or performance regressions.
    if (profileCount !== _lastSeedProfileCount || elapsed > 500) {
      console.log(`${LOG} Seeded chat activity for ${profileCount} Sniffies profiles (${elapsed}ms)`);
      _lastSeedProfileCount = profileCount;
    }
  }).catch((err: Error) => {
    // Three transient patterns — all benign, all self-heal on the next tick:
    //   1. "message channel closed"        — SW suspended mid-allDocs scan.
    //   2. "Receiving end does not exist"  — SW asleep with no other warm tab.
    //   3. "Could not establish connection" — same family as #2 on Chromium.
    // For these we silent-retry once after 2s (faster than the 60s interval).
    //
    // One PERMANENT pattern: "Extension context invalidated". The page-side
    // bridge is now orphaned and no chrome.runtime call will work until the
    // user refreshes the page. shutdownBackgroundTimers() stops the seed
    // interval so we don't keep firing dead-letter calls.
    const msg = String(err?.message || err || '');
    const transient = /(message channel closed|Receiving end does not exist|Could not establish connection)/i.test(msg);
    const permanent = /Extension context invalidated|Context invalidated/i.test(msg);
    if (permanent) {
      contextValid = false;
      shutdownBackgroundTimers();
      return; // silent — checkContext already logged the one-time warning
    }
    if (transient) {
      setTimeout(() => { if (contextValid && !seedInFlight) seedChatTimestamps(); }, 2000);
      return;
    }
    console.warn(`${LOG} seedChatTimestamps error:`, msg);
  }).finally(() => {
    seedInFlight = false;
  });
}
setTimeout(seedChatTimestamps, 1500);      // initial seed after 1.5s
registerBackgroundTimer(setInterval(seedChatTimestamps, 60_000));    // refresh every 60s

// ── Random Intro Gestures (middle-click / Shift+right-click) ─────────────
// On a Sniffies chat window, middle-click or Shift+right-click anywhere
// inside the chat composer area sends a random AI-generated intro after
// the same 5–15s human-like delay the 🎲 Intro button uses. The gesture
// only fires when:
//   1. We're on a /profile/{id}/chat URL (so we have a target contact)
//   2. The click target is inside a chat-input region — placeholder text
//      "Say something…" or a textarea/contenteditable in the composer.
// Outside that region the events fall through and any existing handlers
// (Alt+Shift+right-click for phrase capture, native context menu) keep
// working. This is the trackpad-friendly equivalent of middle-click.
/**
 * Whether an event target sits inside the Sniffies chat composer, so a
 * middle-click / Shift+right-click gesture there should trigger a random intro.
 * Matches the "Say something…" placeholder, composer wrapper classes, or an
 * ancestor placeholder. @param target - Event target. @returns true if in-composer.
 */
function isChatComposerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // Direct match: Sniffies' chat input has placeholder "Say something…"
  if (target.matches?.('textarea, [contenteditable="true"], input[type="text"]')) {
    const ph = target.getAttribute('placeholder') || '';
    if (/say something/i.test(ph)) return true;
  }
  // Ancestor match: any chat-composer wrapper
  const composer = target.closest?.(
    '[class*="chat-composer" i], [class*="composer" i], [class*="message-input" i], ' +
    '[class*="chat-input" i], [class*="say-something" i]'
  );
  if (composer) return true;
  // Fallback: text "Say something" anywhere in an ancestor's placeholder
  let node: HTMLElement | null = target;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    const ph = node.getAttribute?.('placeholder') || '';
    if (/say something/i.test(ph)) return true;
  }
  return false;
}

/**
 * Fire a SEND_GREETING for the profile in the current /profile/{hex} URL and
 * show a confirmation toast with the queued delay. No-op (returns false) when
 * not on a profile URL. The sendMessage is wrapped so a context-invalidated
 * throw can't escape. @returns true if a greeting was dispatched.
 */
function dispatchRandomIntroFromGesture(): boolean {
  const introId = dom.profileIdFromHref(location.pathname);
  if (!introId) return false;
  const contactId = `sniffies:${introId}`;
  try {
    chrome.runtime.sendMessage({ type: 'SEND_GREETING', contactId, platform: 'sniffies' }).then((res: any) => {
      const delaySec = Math.round(((res?.delay) || 0) / 1000);
      const toast = document.createElement('div');
      toast.textContent = `🎲 Intro queued${delaySec ? ` (~${delaySec}s)` : ''}`;
      toast.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:999999;background:rgba(34,197,94,0.95);color:#fff;padding:8px 14px;border-radius:8px;font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.4);transition:opacity 0.3s;';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; }, 1800);
      setTimeout(() => toast.remove(), 2200);
    }).catch(() => {});
  } catch {}
  return true;
}

document.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return; // middle-click only
  if (!contextValid || !checkContext()) return;
  if (!isChatComposerTarget(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  dispatchRandomIntroFromGesture();
}, true);

document.addEventListener('contextmenu', (e) => {
  // Shift+right-click — but NOT Alt+Shift (which is the phrase-capture
  // gesture handled by the listener below). The Alt check keeps the two
  // gestures from colliding.
  if (!e.shiftKey || e.altKey) return;
  if (!contextValid || !checkContext()) return;
  if (!isChatComposerTarget(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  dispatchRandomIntroFromGesture();
}, true);

// ── Quick Phrase Capture (Alt+Shift+Right-Click) ──────────────────────────
// When the user Alt+Shift+right-clicks in a chat, capture selected text
// as a quick phrase. This lets you quickly save commonly used phrases
// by highlighting text in a conversation and Alt+Shift+right-clicking.
document.addEventListener('contextmenu', (e) => {
  if (!e.altKey || !e.shiftKey) return;
  if (!contextValid || !checkContext()) return;

  const selection = window.getSelection()?.toString().trim();
  if (!selection || selection.length < 2) return;

  e.preventDefault();
  // Send the captured text to the service worker to save as a quick phrase
  chrome.runtime.sendMessage({
    type: 'CAPTURE_QUICK_PHRASE',
    text: selection.slice(0, 200),
  }).catch(() => {});

  // Visual feedback
  const toast = document.createElement('div');
  toast.textContent = `Phrase saved: "${selection.slice(0, 40)}${selection.length > 40 ? '...' : ''}"`;
  toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1a1f2e;color:#93c5fd;padding:8px 16px;border-radius:8px;font-size:12px;z-index:99999;border:1px solid rgba(59,130,246,0.3);pointer-events:none;';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}, true);

// ── MAIN World Script Injection ─────────────────────────────────────────────
// The last thing the bridge does is inject the MAIN world content script
// (sniffies.ts, compiled to sniffies.js) into the page. This is done by
// creating a <script> tag with src pointing to the extension's bundled JS
// via chrome.runtime.getURL. The script runs in the page's JS context (MAIN
// world) and can patch fetch/XHR/WebSocket. We remove the <script> tag after
// load to keep the DOM clean — the code is already executing by then.
if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/sniffies.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove(); // clean up — code is already executing
}

// ── Memory Self-Reporting ──────────────────────────────────────────────────
// v0.57.62: every 60s (and immediately on first load) ask the MAIN world for
// its cache sizes via postMessage round-trip, then write the report to
// chrome.storage.session under `mem:sniffies:<tabId>` so the SW's
// GET_MEMORY_BREAKDOWN can read it. Tab-id keyed so multiple sniffies tabs
// each report independently. Stale entries (>3 min) are GCd by the SW on
// read. Cheap (one Map iteration + one storage write per minute).
(function startMemoryReporter() {
  if (!checkContext()) return;
  let latestCaches: Record<string, number> = {};
  // Listen for the MAIN-world reply
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== '__aggregaytor_memory_response') return;
    latestCaches = (event.data.caches && typeof event.data.caches === 'object') ? event.data.caches : {};
  });

  async function reportOnce() {
    if (!checkContext()) return;
    // Ask MAIN world for fresh sizes
    window.postMessage({ type: '__aggregaytor_memory_request' }, '*');
    // Brief delay for the synchronous reply to land before we read
    await new Promise((r) => setTimeout(r, 100));
    try {
      // Resolve our tab id once via background — chrome.tabs is unavailable
      // in content scripts, so we ask the SW which sender it sees us as.
      // For simplicity, key by URL+startTime as a tab-uid surrogate.
      const tabKey = `${location.origin}_${Math.floor(performance.timeOrigin / 1000)}`;
      await chrome.storage.session.set({
        [`mem:sniffies:${tabKey}`]: { ts: Date.now(), caches: latestCaches },
      });
    } catch { /* SW gone — next tick will retry */ }
  }
  // First report after 5s (let MAIN world initialize), then every 60s.
  // Registered so shutdownBackgroundTimers() clears it once the extension
  // context is invalidated — otherwise it kept ticking (and postMessaging to
  // the page) for the life of the orphaned tab.
  setTimeout(reportOnce, 5000);
  registerBackgroundTimer(setInterval(reportOnce, 60_000));
})();
