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

adapter.init().catch((err) => {
  console.error('[Aggregaytor] Sniffies adapter init failed:', err);
});
