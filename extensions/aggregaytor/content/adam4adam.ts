/**
 * adam4adam.ts — MAIN world content script for adam4adam.com.
 *
 * Runs in page context to intercept fetch/XHR and observe DOM.
 * Communicates with ISOLATED world bridge via CustomEvents.
 */

import { Adam4AdamAdapter } from '@aggregaytor/adapter-adam4adam';
import { initTextExpander } from './text-expander.js';

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
  sendToBridge({ type: 'ADAPTER_MESSAGES', platform: 'adam4adam', payload: event.payload });
});

adapter.on('contacts', (event) => {
  sendToBridge({ type: 'ADAPTER_CONTACTS', platform: 'adam4adam', payload: event.payload });
});

adapter.on('error', (event) => {
  const err = event.payload as Error;
  sendToBridge({ type: 'ADAPTER_ERROR', platform: 'adam4adam', error: err?.message || String(err) });
});

adapter.init().then(() => console.log(`${LOG} Adapter initialized`)).catch(err => console.error(`${LOG} Init failed:`, err));

// Text expander — type shortcuts in chat to auto-expand
initTextExpander();

// Auto-send handler (for auto-respond and quick phrases)
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  console.log(`${LOG} Auto-sending:`, text.slice(0, 30));

  // Find the chat input — try multiple selectors for A4A's UI
  const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    'textarea[placeholder*="message" i], textarea[placeholder*="type" i], ' +
    'textarea, [contenteditable="true"], ' +
    'input[placeholder*="message" i], input[type="text"]'
  );
  if (!input) { console.warn(`${LOG} Chat input not found`); return; }

  // Set value with React-compatible events
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSet) nativeSet.call(input, text);
  else (input as any).value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Find and click send button
  setTimeout(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      'button[type="submit"], .send-button, [class*="send" i], ' +
      'button[aria-label*="send" i], [data-testid*="send"]'
    );
    if (btn) { btn.click(); console.log(`${LOG} Send clicked`); }
    else console.warn(`${LOG} Send button not found`);
  }, 500);
}) as EventListener);
