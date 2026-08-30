/**
 * adam4adam.ts — MAIN world content script for adam4adam.com.
 *
 * Runs in page context to intercept fetch/XHR and observe DOM.
 * Communicates with ISOLATED world bridge via CustomEvents.
 */

import { Adam4AdamAdapter } from '@aggregaytor/adapter-adam4adam';
import { initTextExpander } from './text-expander.js';

const LOG = '[Aggregaytor:A4A]';

/**
 * Forward an adapter event to the ISOLATED-world bridge (MAIN world).
 *
 * WHY: MAIN-world scripts cannot call `chrome.*`, so the only channel to the
 * service worker is a `window` CustomEvent the bridge relays. The payload is
 * deep-cloned via JSON so it survives the structured-clone boundary and can
 * never smuggle a live DOM/function reference to the bridge. The catch is
 * intentionally silent — a serialization failure on this fire-and-forget path
 * must not throw and break the adapter's emit loop.
 *
 * @param message - Plain, JSON-serializable message object to relay.
 */
function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent('__aggregaytor_message', {
      detail: JSON.parse(JSON.stringify(message)),
    }));
  } catch {}
}

const adapter = new Adam4AdamAdapter({ platform: 'adam4adam', observeDOM: true });

// Relay parsed messages from the adapter (trusted source) to the bridge.
adapter.on('messages', (event) => {
  sendToBridge({ type: 'ADAPTER_MESSAGES', platform: 'adam4adam', payload: event.payload });
});

// Relay parsed contacts from the adapter (trusted source) to the bridge.
adapter.on('contacts', (event) => {
  sendToBridge({ type: 'ADAPTER_CONTACTS', platform: 'adam4adam', payload: event.payload });
});

// Relay adapter errors to the bridge as a normalized message string; `payload`
// may be an Error or an arbitrary throw value.
adapter.on('error', (event) => {
  const err = event.payload as Error;
  sendToBridge({ type: 'ADAPTER_ERROR', platform: 'adam4adam', error: err?.message || String(err) });
});

// Boot the adapter's network/DOM interception; log the outcome either way.
adapter.init().then(() => console.log(`${LOG} Adapter initialized`)).catch(err => console.error(`${LOG} Init failed:`, err));

// Text expander — type shortcuts in chat to auto-expand
initTextExpander();

// ── Block Profile (MAIN world hook) ─────────────────────────────────────────
// The bridge does the heavy lifting (local blocklist + DOM hide) in ISOLATED
// world. This handler is a hook point for anything that needs MAIN-world
// access — e.g. intercepted auth headers for a future platform-side block
// API call. Local-only mode is the default; no A4A API is called here.
// `event.detail` is a plain window CustomEvent and forgeable by any page
// script, so `username` is validated as a non-empty string before it is
// interpolated into the toast.
window.addEventListener('__aggregaytor_block_profile', ((event: CustomEvent) => {
  const { username } = event.detail || {};
  if (!username || typeof username !== 'string') return;
  console.log(`${LOG} Block hook for ${username} (local-only — nothing more to do unless platform-block is enabled)`);
  // Toast for visual confirmation
  try {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;' +
      'background:rgba(220,38,38,0.95);color:#fff;padding:10px 14px;border-radius:8px;' +
      'font-family:system-ui,sans-serif;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.4);' +
      'transition:opacity 0.3s';
    t.textContent = `🚫 ${username} blocked`;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; }, 1500);
    setTimeout(() => t.remove(), 1900);
  } catch {}
}) as EventListener);

// Auto-send handler (for auto-respond and quick phrases). `event.detail` is
// forgeable page-side, so `text` is validated as a non-empty string before it
// reaches `.slice()`/the DOM composer.
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text || typeof text !== 'string') return;
  console.log(`${LOG} Auto-sending:`, text.slice(0, 30));

  // Find the chat input — try multiple selectors for A4A's UI
  const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    'textarea[placeholder*="message" i], textarea[placeholder*="type" i], ' +
    'textarea, [contenteditable="true"], ' +
    'input[placeholder*="message" i], input[type="text"]'
  );
  if (!input) { console.warn(`${LOG} Chat input not found`); return; }

  // Set value with React-compatible events
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSet) nativeSet.call(input, text);
  else (input as any).value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Find and click send button
  setTimeout(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      'button[type="submit"], .send-button, [class*="send" i], ' +
      'button[aria-label*="send" i], [data-testid*="send"]'
    );
    if (btn) { btn.click(); console.log(`${LOG} Send clicked`); }
    else console.warn(`${LOG} Send button not found`);
  }, 500);
}) as EventListener);

// ── Console Helpers (MAIN world) ────────────────────────────────────────────
// v0.57.39: previously the bridge tried to expose these via an inline
// <script>{...}</script> tag injected into the page. A4A's CSP forbids
// inline scripts, so the page console threw "Executing inline script
// violates the following Content Security Policy directive ..." up to a
// dozen times per minute (the bridge re-tried on every page load).
//
// The MAIN-world content script (this file) is loaded via src= which
// IS allowed by every CSP. Define the helpers here directly — they're
// reachable from the page's default DevTools console without any inline
// script injection. Bridge-side helpers still exist on the ISOLATED-world
// `window`, but the user typically types into the MAIN-world prompt by
// default, so these are the ones that "just work."
const A4A_BLOCKED_KEY = 'aggregaytor_a4a_blocked';

// NOTE: these three `window.__aggregaytor_a4a_*` names are pre-existing debug
// helpers (not a new window exposure). They expose only DevTools recovery
// affordances — no auth/privileged state — and shared work happens ISOLATED-
// side via localStorage + the `__aggregaytor_a4a_console_*` CustomEvents.

/**
 * DevTools recovery: clear the local A4A blocklist and ask the ISOLATED bridge
 * to un-hide every card. `localStorage.removeItem` is guarded (private mode).
 */
(window as any).__aggregaytor_a4a_reset = function (): void {
  try { localStorage.removeItem(A4A_BLOCKED_KEY); } catch {}
  window.dispatchEvent(new CustomEvent('__aggregaytor_a4a_console_reset'));
  console.log('[Aggregaytor:A4A] Reset dispatched — page will refresh hide state shortly.');
};

/** DevTools recovery: un-hide currently-hidden cards but keep the blocklist. */
(window as any).__aggregaytor_a4a_unhide_all = function (): void {
  window.dispatchEvent(new CustomEvent('__aggregaytor_a4a_console_unhide_all'));
};

/**
 * DevTools helper: print and return the stored A4A blocklist. Reads and
 * JSON-parses localStorage (untrusted/corruptible), returning `[]` on any read
 * or parse failure so a bad value never throws in the console.
 *
 * @returns The array of blocked usernames, or `[]` if none/unreadable.
 */
(window as any).__aggregaytor_a4a_list_blocked = function (): string[] {
  try {
    const raw = localStorage.getItem(A4A_BLOCKED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    console.log('[Aggregaytor:A4A]', list.length, 'blocked username(s):', list);
    return list;
  } catch { return []; }
};
