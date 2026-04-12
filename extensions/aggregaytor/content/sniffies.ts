/**
 * sniffies.ts — MAIN world content script for sniffies.com.
 *
 * Runs in the page's JS context so it can patch fetch/XHR/WebSocket.
 * Communicates with the ISOLATED world bridge via CustomEvents.
 */

import { SniffiesAdapter } from '@aggregaytor/adapter-sniffies';
import { isGlobalChatEvent, isPresenceEvent } from '@aggregaytor/adapter-sniffies';
import { setLogLevel } from '@aggregaytor/adapter-core';

// ── WS Debug Logger ──────────────────────────────────────────────────────────
// Writes WebSocket frames to localStorage so we can inspect them later
// (DevTools can't be open during page load on Sniffies without blocking it)
const WS_DEBUG_KEY = '__aggregaytor_ws_debug';
const WS_DEBUG_MAX = 150; // keep last 150 frames

function wsDebugLog(entry: Record<string, unknown>): void {
  try {
    const raw = localStorage.getItem(WS_DEBUG_KEY);
    const log: unknown[] = raw ? JSON.parse(raw) : [];
    log.push({ ...entry, t: new Date().toISOString() });
    // Keep only the last N entries
    while (log.length > WS_DEBUG_MAX) log.shift();
    localStorage.setItem(WS_DEBUG_KEY, JSON.stringify(log));
  } catch { /* localStorage full or unavailable */ }
}

function parseFrameForDebug(text: string): { event: string; keys: string[]; hasBody: boolean; snippet: string } | null {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || /^\d{1,2}$/.test(t)) return null; // heartbeat
  try {
    if (t.startsWith('42')) {
      const arr = JSON.parse(t.slice(2));
      if (Array.isArray(arr)) {
        const event = typeof arr[0] === 'string' ? arr[0] : '';
        const data = arr[1];
        const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : [];
        const hasBody = data && typeof data === 'object' && ('body' in data || 'text' in data || 'message' in data || 'content' in data);
        return { event, keys, hasBody, snippet: t.slice(0, 300) };
      }
    }
    if (t.startsWith('{')) {
      const data = JSON.parse(t);
      if (data && typeof data === 'object') {
        // Sniffies format: {"eventName":"...", "data":{...}}
        const event = typeof data.eventName === 'string' ? data.eventName : '(json-obj)';
        const innerData = data.data;
        const innerKeys = innerData && typeof innerData === 'object' && !Array.isArray(innerData)
          ? Object.keys(innerData).slice(0, 20) : [];
        const outerKeys = Object.keys(data).slice(0, 20);
        const hasBody = (innerData && typeof innerData === 'object' &&
          ('body' in innerData || 'text' in innerData || 'message' in innerData || 'content' in innerData));
        return { event, keys: innerKeys.length ? innerKeys : outerKeys, hasBody, snippet: t.slice(0, 400) };
      }
    }
    if (t.startsWith('[')) {
      const data = JSON.parse(t);
      if (Array.isArray(data) && data.length >= 2 && typeof data[0] === 'string') {
        return { event: data[0], keys: [], hasBody: false, snippet: t.slice(0, 400) };
      }
      return { event: '(array)', keys: [], hasBody: false, snippet: t.slice(0, 300) };
    }
  } catch { /* not parseable */ }
  return null;
}

// Install a STANDALONE WebSocket interceptor for debug logging
// This must run BEFORE the adapter patches WebSocket so we get the native constructor
const _NativeWS = window.WebSocket;
const _OrigProtoAddListener = WebSocket.prototype.addEventListener;

// Prototype-level hook: catches ALL sockets (even created before our constructor wrapper)
const hookedSockets = new WeakSet<WebSocket>();
WebSocket.prototype.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
  if (type === 'message' && !hookedSockets.has(this)) {
    hookedSockets.add(this);
    // Piggyback a debug logger — skip presence spam, log everything else
    _OrigProtoAddListener.call(this, 'message', function(ev: MessageEvent) {
      const frame = parseFrameForDebug(ev.data);
      if (!frame) return;
      const presence = isPresenceEvent(frame.event);
      // Only log non-presence events (chat, DM, global, unknown) to avoid spam
      // Also log presence events with hasBody (unusual — might be a mis-classification)
      if (!presence || frame.hasBody) {
        const isGlobal = isGlobalChatEvent(frame.event);
        wsDebugLog({
          src: 'proto-hook',
          event: frame.event,
          isGlobal,
          isPresence: presence,
          keys: frame.keys,
          hasBody: frame.hasBody,
          snippet: frame.snippet,
        });
      }
    });
  }
  return _OrigProtoAddListener.call(this, type, listener, options);
};

// Also hook onmessage setter for sockets that use ws.onmessage = fn
const origOnMsgDesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
if (origOnMsgDesc) {
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    set(fn) {
      if (!hookedSockets.has(this) && fn) {
        hookedSockets.add(this);
        _OrigProtoAddListener.call(this, 'message', function(ev: MessageEvent) {
          const frame = parseFrameForDebug(ev.data);
          if (!frame) return;
          const presence = isPresenceEvent(frame.event);
          if (!presence || frame.hasBody) {
            const isGlobal = isGlobalChatEvent(frame.event);
            wsDebugLog({
              src: 'onmsg-hook',
              event: frame.event,
              isGlobal,
              isPresence: presence,
              keys: frame.keys,
              hasBody: frame.hasBody,
              snippet: frame.snippet,
            });
          }
        });
      }
      origOnMsgDesc!.set!.call(this, fn);
    },
    get() { return origOnMsgDesc!.get!.call(this); },
    configurable: true,
  });
}

wsDebugLog({ src: 'init', msg: 'WS debug logger installed', hookType: 'proto+onmsg' });

// Listen for log level changes from bridge
window.addEventListener('__aggregaytor_set_log_level', ((event: CustomEvent) => {
  if (event.detail) setLogLevel(event.detail);
}) as EventListener);

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
