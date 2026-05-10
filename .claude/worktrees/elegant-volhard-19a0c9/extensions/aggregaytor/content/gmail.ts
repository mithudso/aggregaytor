/**
 * gmail.ts — MAIN world content script for mail.google.com.
 */

import { GmailAdapter } from '@aggregaytor/adapter-gmail';

const LOG = '[Aggregaytor:Gmail]';

function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent('__aggregaytor_message', {
      detail: JSON.parse(JSON.stringify(message)),
    }));
  } catch {}
}

const adapter = new GmailAdapter({ platform: 'gmail' });

adapter.on('messages', (event) => {
  console.log(`${LOG} Messages:`, (event.payload as any[]).length);
  sendToBridge({ type: 'ADAPTER_MESSAGES', platform: 'gmail', payload: event.payload });
});

adapter.on('contacts', (event) => {
  sendToBridge({ type: 'ADAPTER_CONTACTS', platform: 'gmail', payload: event.payload });
});

adapter.init().then(() => console.log(`${LOG} Initialized`)).catch(err => console.error(`${LOG} Failed:`, err));
