/**
 * yahoo-bridge.ts — ISOLATED world bridge for Yahoo Mail.
 */

const LOG = '[Aggregaytor:Bridge:Yahoo]';
let contextValid = true;

/**
 * Probe whether this content script's extension context is still live.
 *
 * WHY: after an extension reload/update, `chrome.runtime.id` throws
 * ("Extension context invalidated") in orphaned content scripts; every
 * `chrome.*` call from then on would throw. Gating relays on this check keeps
 * a stale bridge from spamming exceptions. Logs the transition exactly once
 * (guarded on `contextValid`) so the invalidation is visible without flooding.
 *
 * @returns `true` while the context is usable; `false` once invalidated.
 */
function checkContext(): boolean {
  try { void chrome.runtime.id; return true; }
  catch { if (contextValid) { console.warn(`${LOG} Context invalidated`); contextValid = false; } return false; }
}

// Trust boundary: `__aggregaytor_message` is a plain window CustomEvent, so
// ANY script on mail.yahoo.com can forge it — not just content/yahoo.js.
// Relaying `detail` verbatim would let the page reach every case of the
// service worker's message switch. Only the message types content/yahoo.js
// actually emits are forwarded.
const YAHOO_RELAY_TYPES = new Set(['ADAPTER_MESSAGES', 'ADAPTER_CONTACTS']);

// Relay MAIN-world adapter events to the service worker. `event.detail` is
// untrusted (forgeable page-side): validate it is an object with a string
// `type` on the allowlist before forwarding, and drop anything else with a log.
window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail || typeof detail.type !== 'string') return;
  if (!YAHOO_RELAY_TYPES.has(detail.type)) {
    console.warn(`${LOG} Dropped relay message with unexpected type: ${detail.type.slice(0, 40)}`);
    return;
  }
  try { chrome.runtime.sendMessage(detail).catch(() => {}); }
  catch { contextValid = false; }
}) as EventListener);

if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/yahoo.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
