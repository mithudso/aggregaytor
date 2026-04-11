/**
 * adam4adam.ts — MAIN world content script for adam4adam.com.
 *
 * A4A uses data-author attributes on message elements and /api/v2/ endpoints.
 */

import { Adam4AdamAdapter } from '@aggregaytor/adapter-adam4adam';

const LOG = '[Aggregaytor:A4A]';

function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent('__aggregaytor_message', {
      detail: JSON.parse(JSON.stringify(message)),
    }));
  } catch {}
}

const adapter = new Adam4AdamAdapter({ platform: 'adam4adam', observeDOM: true });

adapter.on('messages', (event) => {
  console.log(`${LOG} Messages captured:`, (event.payload as any[]).length);
  sendToBridge({ type: 'ADAPTER_MESSAGES', platform: 'adam4adam', payload: event.payload });
});

adapter.on('contacts', (event) => {
  sendToBridge({ type: 'ADAPTER_CONTACTS', platform: 'adam4adam', payload: event.payload });
});

adapter.init().then(() => console.log(`${LOG} Adapter initialized`)).catch(err => console.error(`${LOG} Init failed:`, err));

// Auto-send handler
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  const input = document.querySelector<HTMLTextAreaElement>('textarea, [contenteditable="true"], input[type="text"]');
  if (!input) { console.warn(`${LOG} Chat input not found`); return; }
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSet) nativeSet.call(input, text);
  else (input as any).value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  setTimeout(() => {
    const btn = document.querySelector<HTMLButtonElement>('button[type="submit"], .send-button, [data-testid*="send"]');
    if (btn) btn.click();
  }, 500);
}) as EventListener);
