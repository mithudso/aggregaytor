/**
 * network-interceptor.ts -- Fetch, XHR, and WebSocket interception.
 *
 * Generalized from sniffiesplus patchChatCaptureOnWindow() (lines 4182-4328).
 * Patches window globals to capture API responses and WebSocket messages.
 *
 * ## Why three separate mechanisms?
 *
 * Different platforms use different networking APIs:
 *  - **fetch**: Modern REST APIs (Grindr, most newer platforms).
 *  - **XMLHttpRequest**: Legacy REST APIs (some older platform code paths,
 *    or platforms whose SPAs still use jQuery / axios-XHR).
 *  - **WebSocket**: Real-time bidirectional messaging (Sniffies chat).
 *
 * We patch all three so we can passively capture traffic regardless of which
 * API the platform's own JavaScript chooses to use, without the adapter
 * author needing to know implementation details of the platform's network
 * layer.
 *
 * ## Monkey-patching strategy
 *
 * Each interceptor:
 *  1. Saves a reference to the original global/prototype method.
 *  2. Replaces it with a wrapper that calls the original then (on success)
 *     passes the response to the adapter's callback.
 *  3. Marks the patched function/prototype with `PATCH_FLAG` to prevent
 *     double-patching if `init()` is called twice.
 *  4. Returns a cleanup function that restores the original.
 *
 * ## Auth header capture
 *
 * As a side effect, the fetch interceptor opportunistically captures
 * authentication headers (cookies, bearer tokens, CSRF tokens) for
 * later API replay via `api-sender.ts`. This lets the "send message"
 * feature re-use the user's live session credentials.
 */

import type { InterceptorOptions } from './types.js';
import { captureAuthHeaders } from './api-sender.js';

/**
 * Sentinel property attached to patched functions/prototypes to prevent
 * double-patching. Checked before each install; set immediately after.
 */
const PATCH_FLAG = '__aggregaytorPatched';

// ---------------------------------------------------------------------------
// Fetch interceptor
// ---------------------------------------------------------------------------

/**
 * Replace `target.fetch` with a wrapper that captures JSON responses.
 *
 * The wrapper is transparent to callers -- it returns the same `Response`
 * object. We call `res.clone().json()` so the original consumer can still
 * read the body.
 *
 * @param target - The window whose `fetch` will be patched.
 * @param opts   - Callbacks from the adapter.
 * @returns A cleanup function that restores the original `fetch`.
 */
export function installFetchInterceptor(
  target: Window & typeof globalThis,
  opts: InterceptorOptions,
): () => void {
  const originalFetch = target.fetch;
  if (typeof originalFetch !== 'function') return () => {};
  // Guard: don't patch twice (e.g. if init() is called a second time).
  if ((originalFetch as any)[PATCH_FLAG]) return () => {};

  const wrappedFetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    // --- Auth header capture (best-effort) ---
    // We sniff outgoing request headers for auth tokens (Authorization,
    // cookies, CSRF tokens, platform-specific headers) and cache them
    // keyed by root domain. This lets api-sender.ts replay send-message
    // requests with the user's live credentials.
    try {
      const req = args[0];
      if (req instanceof Request) {
        // `new Request(url, init)` style -- headers are on the Request object.
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        const host = new URL(req.url).hostname.split('.').slice(-2).join('.');
        captureAuthHeaders(host, headers);
      } else if (args[1] && typeof args[1] === 'object' && (args[1] as any).headers) {
        // `fetch(url, { headers })` style -- headers are in the init object.
        const h = (args[1] as any).headers;
        const headers: Record<string, string> = {};
        if (h instanceof Headers) h.forEach((v: string, k: string) => { headers[k] = v; });
        else if (typeof h === 'object') Object.entries(h).forEach(([k, v]) => { headers[k] = String(v); });
        const url = String((req as any)?.url || req || '');
        try { const host = new URL(url).hostname.split('.').slice(-2).join('.'); captureAuthHeaders(host, headers); } catch {}
      }
    } catch {}

    // --- Call the real fetch ---
    const res = await originalFetch.apply(target, args);

    // --- Response interception ---
    try {
      const url = String((args[0] as any)?.url || args[0] || '');
      // Let the adapter decide if it cares about this URL.
      if (!opts.shouldInterceptUrl(url)) return res;
      // Only parse JSON responses -- skip HTML, images, etc.
      const ct = String(res.headers?.get('content-type') || '').toLowerCase();
      if (!ct.includes('json')) return res;
      // Clone before reading so the page's own .json() call still works.
      const data = await res.clone().json();
      opts.onFetchResponse(url, data);
    } catch {
      // Interception is best-effort; never break the page's own fetch.
    }
    return res;
  };

  // Mark as patched and swap onto the target window.
  (wrappedFetch as any)[PATCH_FLAG] = true;
  target.fetch = wrappedFetch as typeof fetch;

  // Cleanup: restore original only if nobody else has replaced us since.
  return () => {
    if (target.fetch === wrappedFetch) {
      target.fetch = originalFetch;
    }
  };
}

// ---------------------------------------------------------------------------
// XHR interceptor
// ---------------------------------------------------------------------------

/**
 * Patch `XMLHttpRequest.prototype.open` and `.send` to capture JSON responses.
 *
 * Unlike fetch (where we can wrap a single function), XHR requires patching
 * two prototype methods:
 *  - `open()`: We stash the request URL on the instance as a private property
 *    (`__aggregaytorUrl`) because `responseURL` is not always populated at the
 *    time we need it (some browsers only set it after redirect resolution).
 *  - `send()`: We attach a one-shot `load` listener that reads the response
 *    body after the request completes, then call the original `send`.
 *
 * @param target - The window whose `XMLHttpRequest` prototype will be patched.
 * @param opts   - Callbacks from the adapter.
 * @returns A cleanup function that restores the original prototype methods.
 */
export function installXHRInterceptor(
  target: Window & typeof globalThis,
  opts: InterceptorOptions,
): () => void {
  const XHR = target.XMLHttpRequest;
  if (!XHR?.prototype || (XHR.prototype as any)[PATCH_FLAG]) return () => {};

  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;

  // Patch open() to remember the URL for later use in the load handler.
  XHR.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__aggregaytorUrl = String(url || '');
    return (originalOpen as any).apply(this, [method, url, ...rest]);
  };

  // Patch send() to attach a response listener before the real send fires.
  XHR.prototype.send = function (...args: any[]) {
    this.addEventListener(
      'load',
      () => {
        try {
          const url = String((this as any).__aggregaytorUrl || this.responseURL || '');
          if (!opts.shouldInterceptUrl(url)) return;
          const ct = String(this.getResponseHeader('content-type') || '').toLowerCase();
          if (!ct.includes('json')) return;

          // Handle both `responseType: 'json'` (pre-parsed) and default/text modes.
          let payload: unknown = null;
          if (this.responseType === 'json' && this.response && typeof this.response === 'object') {
            payload = this.response;
          } else if (!this.responseType || this.responseType === 'text') {
            const text = this.responseText || '';
            // Safety valve: skip absurdly large payloads to avoid freezing.
            if (!text || text.length > 1_500_000) return;
            payload = JSON.parse(text);
          }
          if (payload) opts.onXHRResponse(url, payload);
        } catch {
          // Best-effort: never break the page's own XHR.
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

// ---------------------------------------------------------------------------
// WebSocket interceptor
// ---------------------------------------------------------------------------

/**
 * Intercept all incoming WebSocket messages on the target window.
 *
 * WebSocket interception is significantly harder than fetch/XHR because there
 * are three distinct code patterns a page can use to receive messages, and we
 * need to catch ALL of them:
 *
 *  1. **`new WebSocket(url)`** -- socket created after our patch.
 *     We wrap the constructor so every newly-created socket is automatically
 *     hooked with our message listener.
 *
 *  2. **`ws.addEventListener('message', fn)`** -- the page registers a
 *     listener on a socket that may have been created BEFORE our constructor
 *     wrapper was installed (e.g. the page's module-scope code ran first).
 *     We patch `WebSocket.prototype.addEventListener` to piggyback.
 *
 *  3. **`ws.onmessage = fn`** -- old-school property-assignment style.
 *     We intercept the `onmessage` setter on the prototype to piggyback.
 *
 * ## The WeakSet pattern (`hookedSockets`)
 *
 * A single WebSocket instance might be touched by multiple hooks (e.g. created
 * via the wrapped constructor AND later has `addEventListener` called on it).
 * The `hookedSockets` WeakSet ensures we attach our pipeline listener exactly
 * once per socket, regardless of which hook fires first. Using a WeakSet
 * means we do not prevent garbage collection of closed sockets.
 *
 * ## Why `hookSocket` uses `EventTarget.prototype.addEventListener`
 *
 * Inside `hookSocket` we need to add our own `'message'` listener to the
 * socket. If we called `ws.addEventListener(...)` directly, it would re-enter
 * our patched prototype method and trigger another `hookSocket` call. To avoid
 * that recursion, we call the native `EventTarget.prototype.addEventListener`
 * directly.
 *
 * @param target - The window whose `WebSocket` will be wrapped.
 * @param opts   - Callbacks from the adapter.
 * @returns A cleanup function that restores the original `WebSocket` and
 *          prototype methods.
 */
export function installWebSocketInterceptor(
  target: Window & typeof globalThis,
  opts: InterceptorOptions,
): () => void {
  const NativeWebSocket = target.WebSocket;
  if (typeof NativeWebSocket !== 'function' || (NativeWebSocket as any)[PATCH_FLAG]) {
    return () => {};
  }

  /**
   * WeakSet of sockets that already have our pipeline listener attached.
   * Prevents duplicate listeners when multiple hooks fire for the same socket.
   * WeakSet allows GC of closed sockets without manual cleanup.
   */
  const hookedSockets = new WeakSet<WebSocket>();

  /**
   * Attach a single `'message'` listener to `ws` that forwards frame data
   * to the adapter's callback. No-ops if this socket was already hooked.
   *
   * @param ws      - The WebSocket instance to hook.
   * @param _source - Debug tag for logging which hook path caught this socket.
   */
  function hookSocket(ws: WebSocket, _source: string): void {
    if (hookedSockets.has(ws)) return;
    hookedSockets.add(ws);
    // Walk up the prototype chain to get the unpatched EventTarget method,
    // bypassing our own addEventListener wrapper to avoid infinite recursion.
    const nativeAddListener = Object.getPrototypeOf(Object.getPrototypeOf(ws))?.addEventListener
      || EventTarget.prototype.addEventListener;
    nativeAddListener.call(ws, 'message', (event: MessageEvent) => {
      try {
        opts.onWebSocketMessage(event?.data, _source);
      } catch {
        // Best-effort: never break the page's own WebSocket handling.
      }
    });
  }

  // --- Hook 1: Constructor wrapper ---
  // Catches sockets created AFTER our patch is installed.
  // We build a wrapper function that calls the real constructor, then hooks
  // the resulting socket before returning it to the caller.
  const WrappedWebSocket = function (this: any, ...args: ConstructorParameters<typeof WebSocket>) {
    const ws = new NativeWebSocket(...args);
    hookSocket(ws, 'ws-constructor');
    return ws;
  } as unknown as typeof WebSocket;

  // The wrapper must look like the real WebSocket to `instanceof` checks and
  // code that reads static constants like WebSocket.OPEN.
  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  Object.defineProperties(WrappedWebSocket, {
    CONNECTING: { value: NativeWebSocket.CONNECTING },
    OPEN: { value: NativeWebSocket.OPEN },
    CLOSING: { value: NativeWebSocket.CLOSING },
    CLOSED: { value: NativeWebSocket.CLOSED },
  });
  (WrappedWebSocket as any)[PATCH_FLAG] = true;
  target.WebSocket = WrappedWebSocket;

  // --- Hook 2: Prototype addEventListener ---
  // Catches sockets that were created BEFORE our constructor wrapper existed.
  // When the page calls `ws.addEventListener('message', handler)` on a
  // pre-existing socket, we piggyback and hook it.
  const origAddListener = NativeWebSocket.prototype.addEventListener;
  NativeWebSocket.prototype.addEventListener = function(
    this: WebSocket, type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type === 'message') hookSocket(this, 'ws-proto-addEventListener');
    return origAddListener.call(this, type, listener, options);
  };

  // --- Hook 3: onmessage property setter ---
  // Catches the `ws.onmessage = function(e) { ... }` assignment pattern.
  // We intercept the setter on the prototype descriptor and piggyback.
  const origOnMsgDesc = Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, 'onmessage');
  if (origOnMsgDesc?.set) {
    Object.defineProperty(NativeWebSocket.prototype, 'onmessage', {
      set(fn) {
        if (fn) hookSocket(this, 'ws-proto-onmessage');
        origOnMsgDesc!.set!.call(this, fn);
      },
      get() { return origOnMsgDesc!.get!.call(this); },
      configurable: true,
    });
  }

  // --- Cleanup ---
  // Restore everything. Only replaces if nobody else has swapped things
  // out since we installed (defensive against other extensions).
  return () => {
    if (target.WebSocket === WrappedWebSocket) {
      target.WebSocket = NativeWebSocket;
    }
    NativeWebSocket.prototype.addEventListener = origAddListener;
    if (origOnMsgDesc) {
      Object.defineProperty(NativeWebSocket.prototype, 'onmessage', origOnMsgDesc);
    }
  };
}

// ---------------------------------------------------------------------------
// Combined installer
// ---------------------------------------------------------------------------

/**
 * Install all three interceptors (fetch, XHR, WebSocket) in one call.
 *
 * This is the primary entry point used by `BaseAdapter.setupNetworkInterception`.
 * Returns a single cleanup function that tears down all three.
 *
 * @param target - The MAIN-world window to patch.
 * @param opts   - Callbacks from the adapter.
 * @returns A single cleanup function that restores all original globals.
 */
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
