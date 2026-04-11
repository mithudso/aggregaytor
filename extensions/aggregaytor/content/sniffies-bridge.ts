/**
 * sniffies-bridge.ts — ISOLATED world bridge for Sniffies.
 *
 * Listens for CustomEvents dispatched by the MAIN world content script
 * and forwards them to the service worker via chrome.runtime.sendMessage.
 * Also injects the MAIN world script into the page.
 */

// Listen for messages from the MAIN world script
window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  const detail = event.detail;
  if (!detail?.type) return;

  try {
    chrome.runtime.sendMessage(detail).catch(() => {
      // Extension context may be invalidated on reload
    });
  } catch {
    // Extension context invalidated
  }
}) as EventListener);

// Inject the MAIN world script
const script = document.createElement('script');
script.src = chrome.runtime.getURL('content/sniffies.js');
script.type = 'module';
(document.head || document.documentElement).appendChild(script);
script.onload = () => script.remove();
