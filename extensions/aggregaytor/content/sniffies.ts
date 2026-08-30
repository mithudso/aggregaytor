/**
 * sniffies.ts — MAIN world content script for sniffies.com.
 *
 * This script MUST run in the MAIN world (the page's own JS context) because
 * it needs to monkey-patch native browser APIs — specifically fetch, XHR, and
 * WebSocket — at the prototype level. The ISOLATED world has its own set of
 * these globals, so patching there would never intercept the page's network
 * traffic. Running in MAIN world lets us sit between the Sniffies SPA and the
 * browser, capturing all message/chat data as it flows through.
 *
 * Communication with the extension (which needs chrome.runtime access) happens
 * via CustomEvents on `window`. This script dispatches __aggregaytor_message
 * events that the ISOLATED world bridge (sniffies-bridge.ts) picks up and
 * forwards to the service worker.
 */

import { SniffiesAdapter } from '@aggregaytor/adapter-sniffies';
import { setLogLevel, perf } from '@aggregaytor/adapter-core';
import { initMapFilters } from './sniffies-map-filters.js';
import { initTextExpander } from './text-expander.js';

// ── Performance Counters ────────────────────────────────────────────────────
// Expose perf counters on window so you can inspect from DevTools console:
//   __aggregaytor_perf.stats()   — show all counters sorted by CPU time
//   __aggregaytor_perf.reset()   — clear all counters
//   __aggregaytor_perf.uptimeMin() — minutes since page load
(window as any).__aggregaytor_perf = perf;

// ── Bridge Communication ─────────────────────────────────────────────────────
// The MAIN world cannot call chrome.runtime.*, so all communication with the
// extension goes through CustomEvents on `window`. The bridge (sniffies-bridge.ts)
// in ISOLATED world listens for __aggregaytor_message events and relays them
// to the service worker via chrome.runtime.sendMessage.

// Receive log-level changes forwarded by the bridge (originating from the service
// worker / popup). This lets us dynamically adjust adapter verbosity at runtime.
window.addEventListener('__aggregaytor_set_log_level', ((event: CustomEvent) => {
  if (event.detail) setLogLevel(event.detail);
}) as EventListener);

/**
 * Send a message to the ISOLATED world bridge via CustomEvent.
 * JSON.parse(JSON.stringify(...)) is used to create a structured-clone-safe
 * copy of the payload — CustomEvent.detail must be serializable across
 * world boundaries (MAIN -> ISOLATED).
 */
function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(
      new CustomEvent('__aggregaytor_message', {
        detail: JSON.parse(JSON.stringify(message)),
      }),
    );
  } catch {
    // Silently ignore — bridge may not be loaded yet or context invalidated
  }
}

// ── Adapter Initialization ──────────────────────────────────────────────────
// The SniffiesAdapter patches fetch/XHR/WebSocket to intercept Sniffies API
// calls and WebSocket events. It emits normalized 'messages', 'contacts', and
// 'error' events that we relay to the bridge below.
const adapter = new SniffiesAdapter({ platform: 'sniffies' });

// ── Adapter Event Listeners ─────────────────────────────────────────────────
// The adapter emits three event types. Each handler wraps the payload in a
// typed message and dispatches it to the bridge, which relays it to the
// service worker for storage in PouchDB.

// 'messages' — normalized chat messages extracted from intercepted API responses.
adapter.on('messages', (event) => {
  sendToBridge({
    type: 'ADAPTER_MESSAGES',
    platform: 'sniffies',
    payload: event.payload,
  });
  // Relay chat timestamps + message body to map filter module for badges + preview.
  // The payload comes from adapter parsing of page-controlled API responses, so
  // never assume it is an array — a non-array here would throw inside the
  // adapter's emit loop and kill every later listener on the same event.
  const emitted = Array.isArray(event.payload) ? (event.payload as any[]) : [];
  for (const m of emitted) {
    if (m && m.contactId && m.timestamp) {
      const profileId = m.contactId.replace('sniffies:', '');
      window.dispatchEvent(new CustomEvent('__aggregaytor_chat_timestamp', {
        detail: {
          profileId,
          timestamp: new Date(m.timestamp).getTime(),
          body: m.body,
          direction: m.direction,
        },
      }));
    }
  }
});

// 'contacts' — user profile data extracted from API responses and WebSocket events.
adapter.on('contacts', (event) => {
  sendToBridge({
    type: 'ADAPTER_CONTACTS',
    platform: 'sniffies',
    payload: event.payload,
  });
  // Also relay contact data to the map filter module for attitude/text caching
  window.dispatchEvent(new CustomEvent('__aggregaytor_contact_data', {
    detail: { contacts: event.payload },
  }));
});

// 'error' — adapter-level errors (network failures, parse errors, block detection).
adapter.on('error', (event) => {
  const err = event.payload as Error;
  sendToBridge({
    type: 'ADAPTER_ERROR',
    platform: 'sniffies',
    error: err?.message || String(err),
  });
});

adapter.init().catch((err) => {
  console.error('[Aggregaytor] Sniffies adapter init failed:', err);
});

// ── Map Filter Module ────────────────────────────────────────────────────
initMapFilters();

// ── Text Expander ────────────────────────────────────────────────────────
// Type a shortcut (e.g. "hg ") and it auto-expands to the full phrase.
initTextExpander();

// ── Cross-World Message Handler ────────────────────────────────────────────
// The floating panel runs in ISOLATED world and can't dispatch CustomEvents
// to MAIN world. Instead it uses postMessage which crosses world boundaries.
// We listen here in MAIN world and dispatch the appropriate CustomEvents.
window.addEventListener('message', (event) => {
  // Only accept posts from THIS window. The bridge posts with
  // `window.postMessage(..., '*')` from the ISOLATED world of the same frame,
  // so `event.source === window` holds for every legitimate sender. Without
  // this check any iframe on the page (including third-party ad/embed frames)
  // could forge `__aggregaytor_send` and make the extension type + send an
  // arbitrary chat message as the user.
  if (event.source !== window) return;
  if (!event.data || typeof event.data !== 'object') return;
  if (event.data.type === '__aggregaytor_block') {
    const pid = event.data.profileId;
    console.log('[Aggregaytor:Sniffies] Cross-world block message received, pid:', pid);
    if (pid) {
      window.dispatchEvent(new CustomEvent('__aggregaytor_block_by_map_filter', {
        detail: { profileId: pid },
      }));
      window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
        detail: { profileId: pid },
      }));
    }
  }
  if (event.data.type === '__aggregaytor_send') {
    window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
      detail: { text: event.data.text, contactId: event.data.contactId },
    }));
  }
  if (event.data.type === '__aggregaytor_map_filter_settings') {
    // Re-dispatch as a CustomEvent so the map-filters module (also in MAIN
    // world) picks it up. CustomEvents don't cross ISOLATED/MAIN worlds,
    // which is why the floating filter panel has to route through postMessage.
    // Quiet this log — the floating panel / top bar both echo settings on
    // every "Sync" tick which fired this log repeatedly with no real
    // state change. The downstream map-filters listener has its own
    // signature-based dedup.
    window.dispatchEvent(new CustomEvent('__aggregaytor_map_filter_settings', {
      detail: event.data.update,
    }));
  }
  if (event.data.type === '__aggregaytor_chat_activity_seed') {
    // Bridge seeds chat activity from the SW every 60s. Relay here so the
    // MAIN-world map-filters picks up historical {myLastTs, theirLastTs}
    // and the "waiting on response" chips start working immediately
    // (without needing a page reload).
    window.dispatchEvent(new CustomEvent('__aggregaytor_chat_activity_seed', {
      detail: event.data.activity,
    }));
  }
  if (event.data.type === '__aggregaytor_refresh_conversation') {
    // Bridge detected a /profile/{id}/chat navigation. Force-fetch the
    // chat-data endpoint so our side panel shows full history even when
    // Sniffies' native UI leaves the chat blank until the first send.
    const pid = event.data.profileId;
    if (pid) adapter.forceRefreshConversation(pid).catch(() => {});
  }
  if (event.data.type === '__aggregaytor_refetch_inbox') {
    // v0.57.35: side-panel-triggered bulk refetch. The chat-data endpoint
    // returns ALL DMs in one shot, no profileId required. Same-origin
    // fetch goes through our patched window.fetch → parseApiResponse
    // pipeline, so any new messages get emitted as ADAPTER_MESSAGES via
    // the existing event flow. We respond with the delta in captureCount
    // so the panel can confirm whether the adapter is actually capturing.
    (async () => {
      const before = (adapter as any).captureCount || 0;
      try {
        // forceRefreshConversation gates on a hex profileId, so we bypass
        // it and hit the endpoint directly — patched fetch still intercepts.
        // Auth rides on the session cookie via `credentials: 'include'`; we
        // deliberately do NOT read captured auth headers off `window.*` —
        // the host page can read anything we put there (see the MAIN-world
        // security note in docs/ARCHITECTURE.md).
        await fetch('https://sniffies.com/api/v2/post-authentication/chat-data', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'include',
        }).catch(() => {});
      } catch {}
      // Allow parseApiResponse to finish + emit before we read the counter.
      await new Promise(r => setTimeout(r, 2000));
      const after = (adapter as any).captureCount || 0;
      window.dispatchEvent(new CustomEvent('__aggregaytor_message', {
        detail: {
          type: 'SNIFFIES_REFETCH_RESULT',
          captured: after - before,
          totalLifetime: after,
        },
      }));
    })();
  }
});

// ── Auto-Send Mechanism ────────────────────────────────────────────────────
// v0.57.63: rewritten to port the userscript v0.7.46 strategy after users
// reported the random-intro button doing nothing. The previous one-shot
// querySelector + 500ms-then-click was too fragile for Sniffies' Angular
// re-renders — the chat composer can take 1-3s to fully mount when switching
// profiles, and the send button isn't always discoverable by class name.
//
// New approach (mirrors userscript fillChatInput + clickChatSendButton +
// pressEnterToSend):
//   1. Score-based input search: prefer textarea/contentEditable with
//      placeholder/aria mentioning "message" or "chat", positioned in the
//      lower half of the viewport. Excludes our own injected panels.
//   2. Retry up to 8x at 400ms intervals for both input AND send button.
//   3. Send via button.click(); if no button matches, fall back to dispatching
//      Enter keydown/keypress/keyup on the input (Sniffies' React form often
//      submits on Enter).
//   4. Use the native value setter for textarea/input (React overrides it);
//      for contenteditable, set textContent.
/**
 * Whether an element is actually visible + interactable (not display:none,
 * visibility:hidden, ~zero opacity, or zero-sized). Used to filter auto-send
 * input/button candidates down to ones the user could really click. Pure DOM
 * read; MAIN world. @param el - Candidate element. @returns true if visible.
 */
function isElementVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') < 0.01) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

const OUR_PANEL_SELECTORS = '#aggregaytor-profile-actions, #aggregaytor-floating-actions, #aggregaytor-top-filter-bar, .aggregaytor-toast, .aggregaytor-map-filter-panel';

/**
 * Score-based search for the Sniffies chat composer input among all visible
 * textareas/text-inputs/contenteditables, excluding our own injected panels.
 *
 * WHY score-based: Sniffies (Angular) hashes class names and re-mounts the
 * composer, so no stable selector exists. We prefer elements whose
 * placeholder/aria mentions "message"/"chat", that are textarea/contenteditable,
 * and that sit in the lower half of the viewport. MAIN world.
 *
 * @returns The best-scoring input element, or null if none are visible.
 */
function findChatInput(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    'textarea, input[type="text"], [contenteditable="true"]'
  )).filter(isElementVisible).filter((el) => !el.closest(OUR_PANEL_SELECTORS));
  if (!candidates.length) return null;
  let best: HTMLElement | null = null;
  let bestScore = -1;
  for (const el of candidates) {
    const ph = (el.getAttribute('placeholder') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    let score = 0;
    if (ph.includes('message') || ph.includes('chat')) score += 4;
    if (aria.includes('message') || aria.includes('chat')) score += 4;
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) score += 2;
    if (el.getBoundingClientRect().bottom > window.innerHeight * 0.45) score += 1;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

/**
 * Set text into a chat input in a way React/Angular's value tracker will notice,
 * then fire input/change events so the framework enables the send button.
 *
 * WHY the native setter dance: React overrides the element's `value` property,
 * so a plain assignment doesn't register; we call the element prototype's own
 * native setter. For contenteditable we set textContent + dispatch an InputEvent.
 * Any DOM exception is swallowed and reported as a failed fill. MAIN world.
 *
 * @param el - Target input (textarea/input/contenteditable) from findChatInput.
 * @param text - Message text to insert.
 * @returns true if the value was set and events dispatched; false on failure.
 */
function fillChatInput(el: HTMLElement, text: string): boolean {
  try {
    if (el.isContentEditable) {
      el.focus();
      el.textContent = text;
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); }
      catch { el.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    }
    if ('value' in el) {
      el.focus();
      // Use the native setter so React's value tracker sees the change.
      // The setter MUST come from the element's own prototype — calling
      // HTMLTextAreaElement's `value` setter on an <input> (or vice versa)
      // throws "Illegal invocation", which used to make every auto-send
      // into an <input type="text"> composer fail silently.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement ? HTMLInputElement.prototype
        : null;
      const nativeSet = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined;
      if (nativeSet) nativeSet.call(el, text);
      else (el as any).value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  } catch {}
  return false;
}

/**
 * Find and click the Send button for a chat composer, scoped to the input's
 * own form/chat/message/composer container so we never click a send button in
 * an unrelated widget. Matches on button text/aria-label/title === "send" and
 * skips our own injected panels. MAIN world.
 *
 * @param inputEl - The composer input the button belongs to.
 * @returns true if a matching send button was found and clicked; false otherwise.
 */
function clickSendButton(inputEl: HTMLElement): boolean {
  // Scope to the input's containing form/chat panel so we don't click some
  // unrelated send button in another widget.
  const scope = inputEl.closest('form, [class*="chat"], [class*="message"], [class*="composer"]') || document;
  const buttons = Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]'))
    .filter(isElementVisible)
    .filter((b) => !b.closest(OUR_PANEL_SELECTORS));
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim().toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();
    if (text === 'send' || aria.includes('send') || title.includes('send')) {
      (btn as HTMLButtonElement).click();
      return true;
    }
  }
  return false;
}

/**
 * Fallback send path: dispatch a full Enter keydown/keypress/keyup sequence on
 * the composer input, used when no Send button matches (Sniffies' React form
 * often submits on Enter). Exceptions are swallowed. MAIN world.
 * @param el - The composer input to focus and press Enter on.
 */
function pressEnter(el: HTMLElement): void {
  try {
    el.focus();
    for (const t of ['keydown', 'keypress', 'keyup'] as const) {
      el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    }
  } catch {}
}

window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  console.log('[Aggregaytor:Sniffies] Auto-sending:', text.slice(0, 50));

  let attempts = 0;
  const MAX_ATTEMPTS = 8;
  const INTERVAL_MS = 400;
  const tick = (): void => {
    attempts++;
    const input = findChatInput();
    if (!input) {
      if (attempts >= MAX_ATTEMPTS) console.warn('[Aggregaytor:Sniffies] Auto-send: chat input never appeared');
      else setTimeout(tick, INTERVAL_MS);
      return;
    }
    if (!fillChatInput(input, text)) {
      if (attempts >= MAX_ATTEMPTS) console.warn('[Aggregaytor:Sniffies] Auto-send: fillChatInput failed');
      else setTimeout(tick, INTERVAL_MS);
      return;
    }
    // Give React/Angular ~250ms to enable the send button after the value change
    setTimeout(() => {
      if (!clickSendButton(input)) {
        console.log('[Aggregaytor:Sniffies] Send button not found, falling back to Enter key');
        pressEnter(input);
      } else {
        console.log('[Aggregaytor:Sniffies] Send clicked');
      }
    }, 250);
  };
  tick();
}) as EventListener);
