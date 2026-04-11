/**
 * network-interceptor.ts — Fetch, XHR, and WebSocket interception.
 *
 * Generalized from sniffiesplus patchChatCaptureOnWindow() (lines 4182-4328).
 * Patches window globals to capture API responses and WebSocket messages.
 */

import type { InterceptorOptions } from './types.js';
import { captureAuthHeaders } from './api-sender.js';

const PATCH_FLAG = '__aggregaytorPatched';

export function installFetchInterceptor(
  target: Window & typeof globalThis,
  opts: InterceptorOptions,
): () => void {
  const originalFetch = target.fetch;
  if (typeof originalFetch !== 'function') return () => {};
  if ((originalFetch as any)[PATCH_FLAG]) return () => {};

  const wrappedFetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    // Capture auth headers from the request for API replay
    try {
      const req = args[0];
      if (req instanceof Request) {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        const host = new URL(req.url).hostname.split('.').slice(-2).join('.');
        captureAuthHeaders(host, headers);
      } else if (args[1] && typeof args[1] === 'object' && (args[1] as any).headers) {
        const h = (args[1] as any).headers;
        const headers: Record<string, string> = {};
        if (h instanceof Headers) h.forEach((v: string, k: string) => { headers[k] = v; });
        else if (typeof h === 'object') Object.entries(h).forEach(([k, v]) => { headers[k] = String(v); });
        const url = String((req as any)?.url || req || '');
        try { const host = new URL(url).hostname.split('.').slice(-2).join('.'); captureAuthHeaders(host, headers); } catch {}
      }
    } catch {}

    const res = await originalFetch.apply(target, args);
    try {
      const url = String((args[0] as any)?.url || args[0] || '');
      if (!opts.shouldInterceptUrl(url)) return res;
      const ct = String(res.headers?.get('content-type') || '').toLowerCase();
      if (!ct.includes('json')) return res;
      const data = await res.clone().json();
      opts.onFetchResponse(url, data);
    } catch {
      // silently ignore interception errors
    }
    return res;
  };
  (wrappedFetch as any)[PATCH_FLAG] = true;
  target.fetch = wrappedFetch as typeof fetch;

  return () => {
    if (target.fetch === wrappedFetch) {
      target.fetch = originalFetch;
    }
  };
}

export function installXHRInterceptor(
  target: Window & typeof globalThis,
  opts: InterceptorOptions,
): () => void {
  const XHR = target.XMLHttpRequest;
  if (!XHR?.prototype || (XHR.prototype as any)[PATCH_FLAG]) return () => {};

  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;

  XHR.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__aggregaytorUrl = String(url || '');
    return (originalOpen as any).apply(this, [method, url, ...rest]);
  };

  XHR.prototype.send = function (...args: any[]) {
    this.addEventListener(
      'load',
      () => {
        try {
          const url = String((this as any).__aggregaytorUrl || this.responseURL || '');
          if (!opts.shouldInterceptUrl(url)) return;
          const ct = String(this.getResponseHeader('content-type') || '').toLowerCase();
          if (!ct.includes('json')) return;
          let payload: unknown = null;
          if (this.responseType === 'json' && this.response && typeof this.response === 'object') {
            payload = this.response;
          } else if (!this.responseType || this.responseType === 'text') {
            const text = this.responseText || '';
            if (!text || text.length > 1_500_000) return;
            payload = JSON.parse(text);
          }
          if (payload) opts.onXHRResponse(url, payload);
        } catch {
          // silently ignore
        }
      },
      { once: true },
    );
    return (originalSend as any).apply(this, args);
  };

  (XHR.prototype as any)[PATCH_FLAG] = true;

  return () => {
    XHR.prototype.open = originalOpen;
    XHR.prototype.send = originalSend;
    delete (XHR.prototype as any)[PATCH_FLAG];
  };
}

export function installWebSocketInterceptor(
  target: Window & typeof globalThis,
  opts: InterceptorOptions,
): () => void {
  const NativeWebSocket = target.WebSocket;
  if (typeof NativeWebSocket !== 'function' || (NativeWebSocket as any)[PATCH_FLAG]) {
    return () => {};
  }

  const WrappedWebSocket = function (this: any, ...args: ConstructorParameters<typeof WebSocket>) {
    const ws = new NativeWebSocket(...args);
    ws.addEventListener('message', (event) => {
      try {
        opts.onWebSocketMessage(event?.data, 'ws-constructor');
      } catch {
        // silently ignore
      }
    });
    return ws;
  } as unknown as typeof WebSocket;

  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  Object.defineProperties(WrappedWebSocket, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED },
  });
  (WrappedWebSocket as any)[PATCH_FLAG] = true;
  target.WebSocket = WrappedWebSocket;

  return () => {
    if (target.WebSocket === WrappedWebSocket) {
      target.WebSocket = NativeWebSocket;
    }
  };
}

export function installAllInterceptors(
  target: Window & typeof globalThis,
  opts: InterceptorOptions,
): () => void {
  const cleanups = [
    installFetchInterceptor(target, opts),
    installXHRInterceptor(target, opts),
    installWebSocketInterceptor(target, opts),
  ];
  return () => cleanups.forEach(fn => fn());
}
