/**
 * sniffies-bridge.ts — ISOLATED world bridge for Sniffies.
 *
 * Listens for CustomEvents from MAIN world, forwards to service worker.
 */

const LOG = '[Aggregaytor:Bridge:Sniffies]';

window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  const detail = event.detail;
  if (!detail?.type) return;

  console.log(`${LOG} Forwarding ${detail.type}:`, detail.platform, Array.isArray(detail.payload) ? `${detail.payload.length} items` : '');

  try {
    chrome.runtime.sendMessage(detail).then((response) => {
      if (response?.ok) {
        console.log(`${LOG} Service worker confirmed:`, response);
      } else {
        console.warn(`${LOG} Service worker error:`, response);
      }
    }).catch((err) => {
      console.warn(`${LOG} sendMessage failed:`, err?.message);
    });
  } catch (err) {
    console.warn(`${LOG} Extension context invalidated`);
  }
}) as EventListener);

// Inject MAIN world script
// Listen for auto-send requests from the service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SEND_AUTO_RESPONSE') {
    console.log(`${LOG} Auto-send request:`, message.text?.slice(0, 30));
    // Dispatch to MAIN world to interact with the DOM
    window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
      detail: { text: message.text, contactId: message.contactId },
    }));
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

console.log(`${LOG} Injecting MAIN world script...`);
const script = document.createElement('script');
script.src = chrome.runtime.getURL('content/sniffies.js');
(document.head || document.documentElement).appendChild(script);
script.onload = () => {
  console.log(`${LOG} MAIN world script loaded`);
  script.remove();
};
script.onerror = (err) => {
  console.error(`${LOG} MAIN world script failed to load:`, err);
};
