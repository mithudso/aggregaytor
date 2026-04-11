/**
 * grindr-bridge.ts — ISOLATED world bridge for Grindr Web.
 */

const LOG = '[Aggregaytor:Bridge:Grindr]';
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

try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SEND_AUTO_RESPONSE') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
        detail: { text: message.text, contactId: message.contactId },
      }));
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
} catch { contextValid = false; }

if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/grindr.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
