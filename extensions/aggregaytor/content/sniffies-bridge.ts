/**
 * sniffies-bridge.ts — ISOLATED world bridge for Sniffies.
 *
 * Listens for CustomEvents from MAIN world, forwards to service worker.
 * Handles extension context invalidation gracefully (extension reloads).
 */

const LOG = '[Aggregaytor:Bridge:Sniffies]';
let contextValid = true;

function checkContext(): boolean {
  try {
    // This throws if extension was reloaded/uninstalled
    void chrome.runtime.id;
    return true;
  } catch {
    if (contextValid) {
      console.warn(`${LOG} Extension context invalidated — bridge disabled until page reload`);
      contextValid = false;
    }
    return false;
  }
}

window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail?.type) return;

  try {
    chrome.runtime.sendMessage(detail).catch(() => {
      // Silently ignore — extension may have reloaded
    });
  } catch {
    contextValid = false;
  }
}) as EventListener);

// Listen for auto-send requests from the service worker
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
} catch {
  contextValid = false;
}

// Inject MAIN world script
if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/sniffies.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
