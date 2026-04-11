/**
 * doublelist.ts — MAIN world content script for doublelist.com.
 *
 * DoubleList uses server-rendered pages with jQuery/Pusher.
 * Messages are in notification elements with data-mess-id, data-mess-channel, data-receiver-id.
 */

import { DoubleListAdapter } from '@aggregaytor/adapter-doublelist';

const LOG = '[Aggregaytor:DList]';

function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent('__aggregaytor_message', {
      detail: JSON.parse(JSON.stringify(message)),
    }));
  } catch {}
}

const adapter = new DoubleListAdapter({ platform: 'doublelist', observeDOM: true });

adapter.on('messages', (event) => {
  console.log(`${LOG} Messages captured:`, (event.payload as any[]).length);
  sendToBridge({ type: 'ADAPTER_MESSAGES', platform: 'doublelist', payload: event.payload });
});

adapter.on('contacts', (event) => {
  sendToBridge({ type: 'ADAPTER_CONTACTS', platform: 'doublelist', payload: event.payload });
});

adapter.init().then(() => console.log(`${LOG} Adapter initialized`)).catch(err => console.error(`${LOG} Init failed:`, err));

// Auto-send handler
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  const input = document.querySelector<HTMLTextAreaElement>('textarea.message-textarea, textarea[name="message"], #message-input, textarea');
  if (!input) { console.warn(`${LOG} Chat input not found`); return; }
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  setTimeout(() => {
    const btn = document.querySelector<HTMLButtonElement>('button[type="submit"], .send-button, button.btn-primary');
    if (btn) btn.click();
  }, 500);
}) as EventListener);
