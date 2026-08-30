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
import { compose } from '@aggregaytor/sniffies-lib';
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
// Composer resolution + fill + send now DELEGATE to @aggregaytor/sniffies-lib's
// `compose.*` (findComposer / fill / clickSend / pressEnter). The bespoke
// score-based finder, the native-value-setter fill, and the scoped send-button
// click were removed in favor of the canonical library implementation.
//
// The retry loop (up to 8× at 400ms) is preserved here — Sniffies' Angular chat
// composer can take 1-3s to mount when switching profiles, and the library's
// findComposer/fill/clickSend are single-shot; the loop keeps re-attempting
// until the composer appears.
//
// ⚠ ACCEPTED REGRESSION RISK: `compose.fill` sets `el.value = text` directly
// rather than calling the element prototype's native value setter. On React/
// Angular composers whose value tracker only observes the native setter, a plain
// assignment may not register, so the framework may leave the Send button
// disabled and auto-send can silently no-op. This behavior change was explicitly
// accepted as part of full library adoption.

// Our own injected panels — passed as the library's `skipSelector` so the
// composer/send-button search never selects one of our inputs or buttons.
const OUR_PANEL_SELECTORS = '#aggregaytor-profile-actions, #aggregaytor-floating-actions, #aggregaytor-top-filter-bar, .aggregaytor-toast, .aggregaytor-map-filter-panel';

window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  console.log('[Aggregaytor:Sniffies] Auto-sending:', text.slice(0, 50));

  let attempts = 0;
  const MAX_ATTEMPTS = 8;
  const INTERVAL_MS = 400;
  const tick = (): void => {
    attempts++;
    // Delegates to @aggregaytor/sniffies-lib compose.findComposer.
    const input = compose.findComposer({ skipSelector: OUR_PANEL_SELECTORS });
    if (!input) {
      if (attempts >= MAX_ATTEMPTS) console.warn('[Aggregaytor:Sniffies] Auto-send: chat input never appeared');
      else setTimeout(tick, INTERVAL_MS);
      return;
    }
    // Delegates to @aggregaytor/sniffies-lib compose.fill (plain el.value =).
    if (!compose.fill(input, text)) {
      if (attempts >= MAX_ATTEMPTS) console.warn('[Aggregaytor:Sniffies] Auto-send: compose.fill failed');
      else setTimeout(tick, INTERVAL_MS);
      return;
    }
    // Give React/Angular ~250ms to enable the send button after the value change
    setTimeout(() => {
      // Delegates to @aggregaytor/sniffies-lib compose.clickSend / pressEnter.
      if (!compose.clickSend(input, { skipSelector: OUR_PANEL_SELECTORS })) {
        console.log('[Aggregaytor:Sniffies] Send button not found, falling back to Enter key');
        compose.pressEnter(input);
      } else {
        console.log('[Aggregaytor:Sniffies] Send clicked');
      }
    }, 250);
  };
  tick();
}) as EventListener);
