/**
 * grindr.ts — MAIN world content script for web.grindr.com.
 *
 * Runs in page context to intercept fetch/XHR/WebSocket.
 * Communicates with ISOLATED world bridge via CustomEvents.
 */

import { GrindrAdapter } from '@aggregaytor/adapter-grindr';

const LOG = '[Aggregaytor:Grindr]';

function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(
      new CustomEvent('__aggregaytor_message', {
        detail: JSON.parse(JSON.stringify(message)),
      }),
    );
  } catch {
    // silently ignore
  }
}

const adapter = new GrindrAdapter({ platform: 'grindr' });

adapter.on('messages', (event) => {
  console.log(`${LOG} Messages captured:`, (event.payload as any[]).length);
  sendToBridge({
    type: 'ADAPTER_MESSAGES',
    platform: 'grindr',
    payload: event.payload,
  });
});

adapter.on('contacts', (event) => {
  console.log(`${LOG} Contacts captured:`, (event.payload as any[]).length);
  sendToBridge({
    type: 'ADAPTER_CONTACTS',
    platform: 'grindr',
    payload: event.payload,
  });
});

adapter.init().then(() => {
  console.log(`${LOG} Adapter initialized`);
}).catch((err) => {
  console.error(`${LOG} Adapter init failed:`, err);
});

// Auto-send handler
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  console.log(`${LOG} Auto-sending:`, text.slice(0, 30));
  const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    'textarea, [contenteditable="true"], input[type="text"]'
  );
  if (!input) { console.warn(`${LOG} Chat input not found`); return; }
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSet) nativeSet.call(input, text);
  else (input as any).value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  setTimeout(() => {
    const sendBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label*="send" i], button[type="submit"], [data-testid*="send"]'
    );
    if (sendBtn) { sendBtn.click(); console.log(`${LOG} Send clicked`); }
    else console.warn(`${LOG} Send button not found`);
  }, 500);
}) as EventListener);
