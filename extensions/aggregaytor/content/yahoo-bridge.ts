/**
 * yahoo-bridge.ts — ISOLATED world bridge for Yahoo Mail.
 */

const LOG = '[Aggregaytor:Bridge:Yahoo]';
let contextValid = true;

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
