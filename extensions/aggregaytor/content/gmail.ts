/**
 * gmail.ts — MAIN world content script for mail.google.com.
 */

import { GmailAdapter } from '@aggregaytor/adapter-gmail';

const LOG = '[Aggregaytor:Gmail]';

/**
 * Forward an adapter event to the ISOLATED-world bridge (MAIN world).
 *
 * WHY: MAIN-world scripts cannot call `chrome.*`, so the only channel to the
 * service worker is a `window` CustomEvent the bridge relays. The payload is
 * deep-cloned via JSON so it survives the structured-clone boundary and can
 * never smuggle a live DOM/function reference to the bridge.
 *
 * The catch is intentionally silent: a serialization failure (non-cloneable
 * payload) must never throw on this fire-and-forget path — losing one event is
 * preferable to breaking the adapter's emit loop. Logged failures here would be
 * pure noise on a path the caller cannot recover from.
 *
 * @param message - Plain, JSON-serializable message object to relay.
 */
function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent('__aggregaytor_message', {
      detail: JSON.parse(JSON.stringify(message)),
    }));
  } catch {}
}

const adapter = new GmailAdapter({ platform: 'gmail' });

// Relay parsed messages from the adapter (trusted source) to the bridge.
adapter.on('messages', (event) => {
  console.log(`${LOG} Messages:`, (event.payload as any[]).length);
  sendToBridge({ type: 'ADAPTER_MESSAGES', platform: 'gmail', payload: event.payload });
});

// Relay parsed contacts from the adapter (trusted source) to the bridge.
adapter.on('contacts', (event) => {
  sendToBridge({ type: 'ADAPTER_CONTACTS', platform: 'gmail', payload: event.payload });
});

// Boot the adapter's network interception; log the outcome either way so a
// failed init is visible in the page console rather than silently dead.
adapter.init().then(() => console.log(`${LOG} Initialized`)).catch(err => console.error(`${LOG} Failed:`, err));
