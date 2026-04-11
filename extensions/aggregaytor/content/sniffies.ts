/**
 * sniffies.ts — MAIN world content script for sniffies.com.
 *
 * Runs in the page's JS context so it can patch fetch/XHR/WebSocket.
 * Communicates with the ISOLATED world bridge via CustomEvents.
 */

import { SniffiesAdapter } from '@aggregaytor/adapter-sniffies';

function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(
      new CustomEvent('__aggregaytor_message', {
        detail: JSON.parse(JSON.stringify(message)), // structured clone safe
      }),
    );
  } catch {
    // silently ignore
  }
}

const adapter = new SniffiesAdapter({ platform: 'sniffies' });

adapter.on('messages', (event) => {
  sendToBridge({
    type: 'ADAPTER_MESSAGES',
    platform: 'sniffies',
    payload: event.payload,
  });
});

adapter.on('contacts', (event) => {
  sendToBridge({
    type: 'ADAPTER_CONTACTS',
    platform: 'sniffies',
    payload: event.payload,
  });
});

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

// Listen for auto-send requests from bridge
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  console.log('[Aggregaytor:Sniffies] Auto-sending:', text.slice(0, 30));
  // Find the chat input — try multiple selectors
  const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    'textarea[placeholder*="message"], textarea[placeholder*="Message"], ' +
    '[contenteditable="true"], ' +
    'input[placeholder*="message"], input[placeholder*="Message"]'
  );
  if (!input) { console.warn('[Aggregaytor:Sniffies] Chat input not found'); return; }
  // Set value with React-compatible events
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSet) nativeSet.call(input, text);
  else (input as any).value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // Find and click the send button after a short delay
  setTimeout(() => {
    const sendBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label*="send" i], button[aria-label*="Send"], ' +
      'button[type="submit"], button.send-button, ' +
      '[data-testid*="send"], [class*="send" i]'
    );
    if (sendBtn) { sendBtn.click(); console.log('[Aggregaytor:Sniffies] Send clicked'); }
    else console.warn('[Aggregaytor:Sniffies] Send button not found');
  }, 500);
}) as EventListener);
