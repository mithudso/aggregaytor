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
  // Relay chat timestamps + message body to map filter module for badges + preview
  for (const m of event.payload as any[]) {
    if (m.contactId && m.timestamp) {
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
    console.log('[Aggregaytor:Sniffies] Cross-world filter settings received:', Object.keys(event.data.update || {}).length, 'keys');
    window.dispatchEvent(new CustomEvent('__aggregaytor_map_filter_settings', {
      detail: event.data.update,
    }));
  }
});

// ── Auto-Send Mechanism ────────────────────────────────────────────────────
// When the service worker wants to auto-send a message (from the auto-respond
// system), it sends a command through the bridge, which dispatches this event.
// We type the text into the chat input using React-compatible event dispatching
// (native setter + input/change events), then find and click the send button.
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  console.log('[Aggregaytor:Sniffies] Auto-sending:', text.slice(0, 30));
  // Find the chat input — try multiple selectors for different UI states
  const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    'textarea[placeholder*="message"], textarea[placeholder*="Message"], ' +
    '[contenteditable="true"], ' +
    'input[placeholder*="message"], input[placeholder*="Message"]'
  );
  if (!input) { console.warn('[Aggregaytor:Sniffies] Chat input not found'); return; }
  // Set value with React-compatible events (React overrides the native setter,
  // so we must use the original HTMLTextAreaElement.prototype.value setter to
  // bypass React's synthetic event system and actually update the DOM value).
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSet) nativeSet.call(input, text);
  else (input as any).value = text;
  // Dispatch input + change events so React/Angular picks up the new value
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // Find and click the send button after a short delay (allows UI to update)
  setTimeout(() => {
    const sendBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label*="send" i], button[aria-label*="Send"], ' +
      'button[type="submit"], button.send-button, ' +
      '[data-testid*="send"], [class*="send" i]'
    );
    if (sendBtn) { sendBtn.click(); console.log('[Aggregaytor:Sniffies] Send clicked'); }
    else console.warn('[Aggregaytor:Sniffies] Send button not found');
  }, 500);
}) as EventListener);
