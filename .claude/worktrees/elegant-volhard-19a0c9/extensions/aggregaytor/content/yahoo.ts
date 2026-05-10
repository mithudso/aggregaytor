/**
 * yahoo.ts — MAIN world content script for mail.yahoo.com.
 */

import { YahooAdapter } from '@aggregaytor/adapter-yahoo';

const LOG = '[Aggregaytor:Yahoo]';

function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent('__aggregaytor_message', {
      detail: JSON.parse(JSON.stringify(message)),
    }));
  } catch {}
}

const adapter = new YahooAdapter({ platform: 'yahoo' });

adapter.on('messages', (event) => {
  console.log(`${LOG} Messages:`, (event.payload as any[]).length);
  sendToBridge({ type: 'ADAPTER_MESSAGES', platform: 'yahoo', payload: event.payload });
});

adapter.on('contacts', (event) => {
  sendToBridge({ type: 'ADAPTER_CONTACTS', platform: 'yahoo', payload: event.payload });
});

adapter.init().then(() => console.log(`${LOG} Initialized`)).catch(err => console.error(`${LOG} Failed:`, err));
