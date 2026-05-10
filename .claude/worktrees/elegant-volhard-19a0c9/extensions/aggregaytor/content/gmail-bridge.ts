/**
 * gmail-bridge.ts — ISOLATED world bridge for Gmail.
 */

const LOG = '[Aggregaytor:Bridge:Gmail]';
let contextValid = true;

function checkContext(): boolean {
  try { void chrome.runtime.id; return true; }
  catch { if (contextValid) { console.warn(`${LOG} Context invalidated`); contextValid = false; } return false; }
}

window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail?.type) return;
  try { chrome.runtime.sendMessage(detail).catch(() => {}); }
  catch { contextValid = false; }
}) as EventListener);

if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/gmail.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
