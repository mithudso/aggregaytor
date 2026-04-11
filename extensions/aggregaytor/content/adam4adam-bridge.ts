/**
 * adam4adam-bridge.ts — ISOLATED world bridge for Adam4Adam.
 */

const LOG = '[Aggregaytor:Bridge:A4A]';
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

// Watch URL changes
let lastUrl = location.href;
setInterval(() => {
  if (!contextValid) return;
  const url = location.href;
  if (url === lastUrl) return;
  lastUrl = url;
  const match = url.match(/\/messages\/([^/?#]+)/i) || url.match(/\/profile\/([^/?#]+)/i);
  if (match) {
    try {
      chrome.runtime.sendMessage({ type: 'ACTIVE_PROFILE_CHANGED', contactId: `adam4adam:${match[1]}`, platform: 'adam4adam' }).catch(() => {});
    } catch {}
  }
}, 1000);

if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/adam4adam.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
