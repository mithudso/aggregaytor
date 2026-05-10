/**
 * doublelist.ts — MAIN world content script for doublelist.com.
 *
 * DoubleList uses server-rendered pages with jQuery/Pusher.
 * Messages are in notification elements with data-mess-id, data-mess-channel, data-receiver-id.
 */

import { DoubleListAdapter } from '@aggregaytor/adapter-doublelist';
import { initTextExpander } from './text-expander.js';

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
  sendToBridge({ type: 'ADAPTER_MESSAGES', platform: 'doublelist', payload: event.payload });
});

adapter.on('contacts', (event) => {
  sendToBridge({ type: 'ADAPTER_CONTACTS', platform: 'doublelist', payload: event.payload });
});

adapter.on('error', (event) => {
  const err = event.payload as Error;
  sendToBridge({ type: 'ADAPTER_ERROR', platform: 'doublelist', error: err?.message || String(err) });
});

adapter.init().then(() => console.log(`${LOG} Adapter initialized`)).catch(err => console.error(`${LOG} Init failed:`, err));

// Text expander
initTextExpander();

// Auto-send handler
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  console.log(`${LOG} Auto-sending:`, text.slice(0, 30));
  const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    'textarea.message-textarea, textarea[name="message"], #message-input, ' +
    'textarea[placeholder*="message" i], textarea, [contenteditable="true"]'
  );
  if (!input) { console.warn(`${LOG} Chat input not found`); return; }
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSet) nativeSet.call(input, text);
  else (input as any).value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  setTimeout(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      'button[type="submit"], .send-button, button.btn-primary, ' +
      'button[aria-label*="send" i], [class*="send" i]'
    );
    if (btn) { btn.click(); console.log(`${LOG} Send clicked`); }
    else console.warn(`${LOG} Send button not found`);
  }, 500);
}) as EventListener);
