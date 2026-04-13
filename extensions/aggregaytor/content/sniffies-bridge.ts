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

const LOG = '[Aggregaytor:Bridge:Sniffies]';

/**
 * Parse a relative time string ("2 hours ago", "3 months ago", "an hour ago")
 * into an approximate ISO 8601 timestamp. Returns current time if unparseable.
 * This is used by DOM scrapers that can only read relative time text from the UI.
 */
function parseRelativeTime(text: string): string {
  if (!text) return new Date().toISOString();
  const t = text.trim().toLowerCase();
  const now = Date.now();
  // Match patterns like "5m ago", "2 hours ago", "3 months ago", "a minute ago"
  const match = t.match(/(\d+)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day|w|week|mo|month|y|year)s?\s*(?:ago)?/i)
    || t.match(/(a|an)\s+(minute|hour|day|week|month|year)s?\s*(?:ago)?/i);
  if (!match) {
    if (t.includes('just now') || t.includes('now')) return new Date(now).toISOString();
    if (t.includes('yesterday')) return new Date(now - 86400000).toISOString();
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
    }
    return false;
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
          const link = document.querySelector(`a[href="${path}"], a[href*="${path}"]`) as HTMLAnchorElement;
          if (link) link.click();
        }, 500);
      } catch {
        // All SPA navigation strategies failed — hard navigate as last resort.
        // This will reload the page and re-initialize all content scripts.
        window.location.href = message.url;
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
          if (lower.startsWith('this conversation') || lower.startsWith('you blocked')) return;

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
            id: `sniffies:conv-${profileId || 'unknown'}-${Date.now()}-${i}`,
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
      // Relay map filter settings from the side panel to the MAIN world
      window.dispatchEvent(new CustomEvent('__aggregaytor_map_filter_settings', {
        detail: message.settings,
      }));
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
      document.querySelectorAll('[style*="sniffiesassets"], .maplibregl-marker, .marker-avatar-image').forEach(el => {
        const bg = (el as HTMLElement).style?.backgroundImage || '';
        // Extract the actual URL from the CSS background-image value
        const match = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (!match) return;
        const url = match[1];
        // Extract the hex profile ID from the CDN URL path
        // e.g., https://profile.sniffiesassets.com/abc123def456/photo.jpg -> abc123def456
        const idMatch = url.match(/sniffiesassets\.com\/([0-9a-f]{6,})\//i);
        if (!idMatch) return; // skip non-profile images (site assets, defaults)
        const profileId = idMatch[1].toLowerCase();
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
          const idFromAvatar = (avatarUrl || bgAvatar).match(/\/([0-9a-f]{6,})\//i);
          if (idFromAvatar) profileId = idFromAvatar[1].toLowerCase();
          else profileId = `gc-${btoa(attrs.slice(0, 30)).slice(0, 12)}`;

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

function injectFloatingCSS(): void {
  if (document.getElementById('aggregaytor-fp-css')) return;
  const s = document.createElement('style');
  s.id = 'aggregaytor-fp-css';
  s.textContent = `
    #${FP_ID}{position:fixed;z-index:99999;width:250px;background:rgba(15,20,25,0.95);border:1px solid rgba(59,130,246,0.3);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.5);font-family:system-ui,sans-serif;font-size:12px;color:#e7e9ea;overflow:hidden}
    #${FP_ID}.collapsed .fp-body{display:none}#${FP_ID}.collapsed{width:150px}
    .fp-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:rgba(59,130,246,0.15);cursor:move;user-select:none;border-bottom:1px solid rgba(59,130,246,0.2)}
    .fp-header-title{font-weight:600;font-size:11px;color:#93c5fd}.fp-header-btns{display:flex;gap:4px}
    .fp-header-btn{background:none;border:none;color:#6b7280;cursor:pointer;font-size:14px;padding:0 2px}.fp-header-btn:hover{color:#e7e9ea}
    .fp-body{padding:8px 10px}.fp-actions{display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
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
  `;
  (document.head || document.documentElement).appendChild(s);
}

function showFloatingPanel(contactId: string, platform: string): void {
  if (!contactId || !contextValid) return;
  if (document.getElementById(FP_ID) && fpContactId === contactId) return;
  fpContactId = contactId;
  fpPlatform = platform;

  injectFloatingCSS();
  const existing = document.getElementById(FP_ID);
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = FP_ID;

  // Load position
  let pos = { x: 20, y: 120 };
  try { const s = localStorage.getItem('aggregaytor_fp_pos'); if (s) pos = JSON.parse(s); } catch {}
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
        <button class="fp-action-btn danger fp-block-btn" title="Block/hide this profile">🚫 Block Profile</button>
        <button class="fp-action-btn fp-notes-btn">📝 Notes</button>
        <div class="fp-stars">${[1,2,3,4,5].map(n => `<span class="fp-star" data-star="${n}">★</span>`).join('')}</div>
      </div>
      <div class="fp-phrases" id="fp-phrases"></div>
      <div class="fp-notes-area" id="fp-notes-area" style="display:none">
        <textarea class="fp-notes-input" id="fp-notes-input" placeholder="Add notes..."></textarea>
        <div class="fp-status" id="fp-status"></div>
      </div>
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

  // Minimize — collapse to just the header bar
  panel.querySelector('.fp-minimize-btn')!.addEventListener('click', () => {
    const c = panel.classList.toggle('collapsed');
    try { localStorage.setItem('aggregaytor_fp_collapsed', String(c)); } catch {}
  });

  // Close — hide the panel entirely (can be re-opened from side panel)
  panel.querySelector('.fp-close-btn')!.addEventListener('click', () => hideFloatingPanel());

  // Block
  panel.querySelector('.fp-block-btn')!.addEventListener('click', () => {
    const pid = fpContactId.replace(/^[a-z]+:/, '');
    window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', { detail: { profileId: pid } }));
    chrome.runtime.sendMessage({ type: 'PROFILE_BLOCKED', contactId: fpContactId, platform: fpPlatform }).catch(() => {});
    hideFloatingPanel();
  });

  // Notes toggle
  panel.querySelector('.fp-notes-btn')!.addEventListener('click', () => {
    const a = panel.querySelector('#fp-notes-area') as HTMLElement;
    a.style.display = a.style.display === 'none' ? '' : 'none';
  });

  // Notes save (debounced)
  let nt: ReturnType<typeof setTimeout> | null = null;
  panel.querySelector('#fp-notes-input')!.addEventListener('input', (e) => {
    if (nt) clearTimeout(nt);
    nt = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'UPSERT_THREAD_META', contactId: fpContactId, platform: fpPlatform, updates: { notes: (e.target as HTMLTextAreaElement).value } }).catch(() => {});
      const st = panel.querySelector('#fp-status') as HTMLElement;
      if (st) { st.textContent = 'Saved'; setTimeout(() => { st.textContent = ''; }, 1500); }
    }, 800);
  });

  // Stars
  panel.querySelectorAll('.fp-star').forEach(star => {
    star.addEventListener('click', () => {
      const r = parseInt((star as HTMLElement).dataset.star || '0');
      const cur = panel.querySelectorAll('.fp-star.active').length;
      const nr = r === cur ? 0 : r;
      panel.querySelectorAll('.fp-star').forEach((s, i) => s.classList.toggle('active', i < nr));
      chrome.runtime.sendMessage({ type: 'SET_RATING', contactId: fpContactId, platform: fpPlatform, rating: nr }).catch(() => {});
    });
  });

  // Populate data
  chrome.runtime.sendMessage({ type: 'GET_THREAD_META', contactId }).then((res: any) => {
    const m = res?.meta || {};
    (panel.querySelector('#fp-notes-input') as HTMLTextAreaElement).value = m.notes || '';
    const rating = m.rating || 0;
    panel.querySelectorAll('.fp-star').forEach((s, i) => s.classList.toggle('active', i < rating));
    if (m.notes) (panel.querySelector('#fp-notes-area') as HTMLElement).style.display = '';
  }).catch(() => {});

  // Phrases
  chrome.storage.local.get('aggregaytor_quick_phrases', (data: any) => {
    const phrases = (data.aggregaytor_quick_phrases || ['Hey there!', "What's up?", 'Looking?']).slice(0, 3);
    const c = panel.querySelector('#fp-phrases') as HTMLElement;
    if (!c) return;
    c.innerHTML = phrases.map((p: string) => `<button class="fp-phrase-btn" title="${p}">${p.length > 18 ? p.slice(0, 16) + '…' : p}</button>`).join('');
    c.querySelectorAll('.fp-phrase-btn').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', { detail: { text: phrases[i], contactId: fpContactId } }));
        (btn as HTMLElement).style.background = 'rgba(34,197,94,0.2)';
        setTimeout(() => { (btn as HTMLElement).style.background = ''; }, 500);
      });
    });
  });
}

function hideFloatingPanel(): void {
  document.getElementById(FP_ID)?.remove();
  fpContactId = '';
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
function checkUrlChange() {
  if (!contextValid) return;
  const url = location.href;
  if (url === lastUrl) return;
  lastUrl = url;

  // Check if the new URL is a profile page: /profile/{hexId} or /profile/{hexId}/chat
  const match = url.match(/\/profile\/([0-9a-f]{6,})(?:\/chat)?/i);
  if (match) {
    const contactId = `sniffies:${match[1].toLowerCase()}`;
    try {
      chrome.runtime.sendMessage({ type: 'ACTIVE_PROFILE_CHANGED', contactId, platform: 'sniffies' }).catch(() => {});
    } catch {}
    // Show floating quick-action panel on the page
    showFloatingPanel(contactId, 'sniffies');
  } else {
    // Left profile view — hide the floating panel and tell the side panel
    // to go back to inbox (restores the pre-v0.51.1 behavior where clicking
    // the map closed the conversation view)
    hideFloatingPanel();
    try {
      chrome.runtime.sendMessage({ type: 'PROFILE_CLOSED', platform: 'sniffies' }).catch(() => {});
    } catch {}
  }

  // If the user navigated to the chat panel (/chat), scrape the conversation
  // list after a delay to let Angular render the chat items
  if (url.match(/sniffies\.com\/chat\/?$/i)) {
    setTimeout(() => scrapeChatPanel(), 2000);
  }
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
function scrapeChatPanel() {
  if (!contextValid || !checkContext()) return;

  const contacts: any[] = [];
  const messages: any[] = [];

  // Each conversation row is a custom Angular element
  const rows = document.querySelectorAll('chat-list-vertical-item');

  rows.forEach(row => {
    try {
      // -- Profile ID from avatar URL --
      // The avatar is rendered as a CSS background-image on a .avatar-img div.
      // Real user avatars come from profile.sniffiesassets.com/{hexId}/...,
      // while default avatars come from site.sniffiesassets.com (no hex ID).
      // We skip default avatars since they don't give us a usable profile ID.
      const avatarEl = row.querySelector('.avatar-img') as HTMLElement;
      if (!avatarEl) return;
      const bgStyle = avatarEl.style?.backgroundImage || '';
      const idMatch = bgStyle.match(/profile\.sniffiesassets\.com\/([0-9a-f]{6,})\//i);
      if (!idMatch) return; // default avatar — no profile ID extractable
      const profileId = idMatch[1].toLowerCase();
      const avatarUrl = bgStyle.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/)?.[1] || '';

      // -- Message preview text --
      // The last message preview is inside a data-testid="msgConversationPreview"
      // element (Angular test attribute), with the text in a child <span>.
      const previewEl = row.querySelector('[data-testid="msgConversationPreview"] span')
        || row.querySelector('.content-preview span');
      let preview = previewEl?.textContent?.trim() || '';
      // Angular template bindings sometimes leave extra whitespace
      preview = preview.replace(/\s+/g, ' ').trim();

      // -- Direction detection --
      // A .fa-reply icon (Font Awesome reply arrow) is present when the last
      // message in the conversation was sent by the current user.
      const sentByYou = !!row.querySelector('.fa-reply');
      const direction = sentByYou ? 'out' : 'in';

      // -- Timestamp --
      const timeEl = row.querySelector('.message-date');
      const timeText = timeEl?.textContent?.trim() || '';

      // -- Pinned status --
      // A .fa-thumbtack icon indicates the user has pinned this conversation
      const isPinned = !!row.querySelector('.fa-thumbtack');

      // -- Unread count --
      // The .unread-count element contains a number badge (e.g., "3")
      const unreadEl = row.querySelector('.unread-count');
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

      // Create a message record from the preview (if non-empty)
      if (preview.length > 1) {
        messages.push({
          id: `sniffies:chatpanel-${profileId}-${Date.now()}`,
          platform: 'sniffies',
          threadId: `sniffies:${profileId}`, // thread = contact for 1:1
          contactId: `sniffies:${profileId}`,
          direction,
          body: preview.slice(0, 200),
          timestamp: parseRelativeTime(timeText), // use message time, not download time
          read: unreadCount === 0, // mark as read only if unread badge is absent
          metadata: {
            profileId, source: 'chat-panel', avatarUrl,
            isPinned, unreadCount, timeText,
          },
        });
      }
    } catch { /* skip individual row parse errors */ }
  });

  console.log(`[Aggregaytor:Bridge:Sniffies] Chat panel scraped: ${contacts.length} contacts, ${messages.length} messages from ${rows.length} rows`);

  // Send scraped contacts and messages to the service worker
  if (contacts.length) {
    chrome.runtime.sendMessage({ type: 'ADAPTER_CONTACTS', platform: 'sniffies', payload: contacts }).catch(() => {});
  }
  if (messages.length) {
    chrome.runtime.sendMessage({ type: 'ADAPTER_MESSAGES', platform: 'sniffies', payload: messages }).catch(() => {});
  }
}

// If the page is already on /chat when the extension loads (e.g., user refreshed
// the chat page), scrape immediately with a longer delay to let Angular finish
// rendering the conversation list.
if (location.href.match(/sniffies\.com\/chat\/?$/i)) {
  setTimeout(() => scrapeChatPanel(), 3000);
}

// ── URL Change Polling ──────────────────────────────────────────────────────
// Poll every 3 seconds because pushState (used by Angular Router for in-app
// navigation) does NOT fire any native DOM event. popstate only fires for
// browser Back/Forward buttons. Polling is the only reliable way to detect
// when the user clicks a profile or opens a conversation within the SPA.
setInterval(checkUrlChange, 3000);
window.addEventListener('popstate', checkUrlChange);

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
