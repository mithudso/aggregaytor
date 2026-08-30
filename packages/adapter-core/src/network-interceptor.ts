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
import { perf } from './perf.js';

/**
 * Sentinel property attached to patched functions/prototypes to prevent
 * double-patching. Checked before each install; set immediately after.
 */
const PATCH_FLAG = '__aggregaytorPatched';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Reduce a request URL to the registrable-domain-ish key that `api-sender`
 * caches auth headers under (e.g. `https://web.grindr.com/v4/x` ->
 * `grindr.com`).
 *
 * `base` matters: SPAs overwhelmingly issue relative-path fetches
 * (`fetch('/api/messages')`). Without a base those throw inside `new URL()`,
 * which previously meant auth capture silently never fired for the most
 * common request shape on the page.
 *
 * @param url  - Absolute or relative request URL.
 * @param base - Base URL to resolve relative paths against (the page's own).
 * @returns The host key, or `null` if the URL is unparseable.
 */
function deriveAuthHostKey(url: string, base: string | undefined): string | null {
  try {
    const { hostname } = new URL(url, base);
    if (!hostname) return null;
    return hostname.split('.').slice(-2).join('.');
  } catch {
    return null;
  }
}

/**
 * Flatten any of the three shapes `RequestInit.headers` accepts (a `Headers`
 * instance, a `[name, value][]` array, or a plain object) into a plain record.
 */
function flattenHeaders(h: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!h) return headers;
  const isHeaders = (typeof Headers !== 'undefined' && h instanceof Headers)
    // Cross-realm / polyfilled Headers still expose forEach.
    || (!Array.isArray(h) && typeof (h as Headers).forEach === 'function');
  if (isHeaders) {
    (h as Headers).forEach((v: string, k: string) => { headers[k] = v; });
  } else if (Array.isArray(h)) {
    for (const pair of h as [string, string][]) {
      if (Array.isArray(pair) && pair.length >= 2) headers[String(pair[0])] = String(pair[1]);
    }
  } else if (typeof h === 'object') {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) headers[k] = String(v);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Fetch interceptor
// ---------------------------------------------------------------------------

/**
 * Replace `target.fetch` with a wrapper that captures JSON responses.
 *
 * The wrapper is transparent to callers -- it returns the same `Response`
 * object, at the same time the real `fetch` resolved it. We `clone()` the
 * response so the original consumer can still read the body, and read our
 * clone on a detached promise so the page never waits on our parsing.
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
      const base = target.location?.href;
      let rawUrl = '';
      let headers: Record<string, string> | null = null;

      if (typeof Request !== 'undefined' && req instanceof Request) {
        // `new Request(url, init)` style -- headers are on the Request object.
        rawUrl = req.url;
        headers = flattenHeaders(req.headers);
      } else if (args[1] && typeof args[1] === 'object' && (args[1] as any).headers) {
        // `fetch(url, { headers })` style -- headers are in the init object.
        rawUrl = String((req as any)?.url || req || '');
        headers = flattenHeaders((args[1] as any).headers);
      }

      if (headers && Object.keys(headers).length) {
        const host = deriveAuthHostKey(rawUrl, base);
        if (host) captureAuthHeaders(host, headers);
      }
    } catch {}

    // --- Call the real fetch ---
    const res = await originalFetch.apply(target, args);

    // --- Response interception ---
    //
    // Only the `clone()` happens on the page's critical path; the body read
    // and the adapter callback are detached.
    //
    // Awaiting `clone().json()` here (as this previously did) made the page's
    // own `await fetch(...)` wait on OUR parse: every matched response added
    // its full JSON-parse time to the page's latency, and a slow or
    // never-completing body on a matched URL would hang the page's request
    // forever. Cloning is synchronous and must still happen before the page
    // starts reading the body, so it stays inline; everything after it runs
    // on its own microtask chain and can no longer affect the caller.
    try {
      const url = String((args[0] as any)?.url || args[0] || '');
      // Let the adapter decide if it cares about this URL.
      if (opts.shouldInterceptUrl(url)) {
        // Only parse JSON responses -- skip HTML, images, etc.
        const ct = String(res.headers?.get('content-type') || '').toLowerCase();
        if (ct.includes('json')) {
          // Clone before reading so the page's own .json() call still works.
          const clone = res.clone();
          void (async () => {
            try {
              const endParse = perf.start('fetch:clone+json');
              const data = await clone.json();
              endParse();
              const endCb = perf.start('fetch:onResponse');
              opts.onFetchResponse(url, data);
              endCb();
            } catch {
              // Interception is best-effort; never surface as an unhandled
              // rejection on the page.
            }
          })();
        }
      }
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
  const patchedOpen = XHR.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__aggregaytorUrl = String(url || '');
    return (originalOpen as any).apply(this, [method, url, ...rest]);
  };

  // Patch send() to attach a response listener before the real send fires.
  const patchedSend = XHR.prototype.send = function (this: XMLHttpRequest, ...args: any[]) {
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
          if (payload) {
            const endCb = perf.start('xhr:onResponse');
            opts.onXHRResponse(url, payload);
            endCb();
          }
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
    // Restore only what is still ours. Another extension may have layered its
    // own patch on top of ours after we installed; blindly assigning
    // `originalOpen` back would silently uninstall *their* interceptor.
    if (XHR.prototype.open === patchedOpen) XHR.prototype.open = originalOpen;
    if (XHR.prototype.send === patchedSend) XHR.prototype.send = originalSend;
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
    // Use EventTarget.prototype.addEventListener directly rather than
    // `ws.addEventListener`, which would re-enter our own WebSocket.prototype
    // wrapper. (The previous `getPrototypeOf(getPrototypeOf(ws))` walk landed
    // on EventTarget.prototype for a plain socket, but on the *patched*
    // WebSocket.prototype for anything created from a `class X extends
    // WebSocket`, re-entering the wrapper it was trying to bypass.)
    const nativeAddListener = EventTarget.prototype.addEventListener;
    nativeAddListener.call(ws, 'message', (event: Event) => {
      try {
        // `MessageEvent.data` is `string | ArrayBuffer | Blob` -- a socket
        // left at the default `binaryType = 'blob'` delivers Blobs. The
        // `InterceptorOptions.onWebSocketMessage` contract (and every adapter
        // implementing it) is synchronous and only handles string/ArrayBuffer,
        // so anything else is dropped here rather than handed across the
        // boundary as a lie about its type.
        const data = (event as MessageEvent | undefined)?.data;
        if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
          perf.count('ws:skippedNonTextFrame');
          return;
        }
        const endWs = perf.start('ws:onMessage');
        opts.onWebSocketMessage(data, _source);
        endWs();
      } catch {
        // Best-effort: never break the page's own WebSocket handling.
      }
    });
  }

  // --- Hook 1: Constructor wrapper ---
  // Catches sockets created AFTER our patch is installed.
  //
  // A Proxy with a `construct` trap, rather than a hand-rolled wrapper
  // function. The trap forwards `newTarget` through `Reflect.construct`, and
  // everything we do not trap (statics like WebSocket.OPEN, `prototype`,
  // `name`, `length`, `toString()`, `instanceof`, and the TypeError you get
  // from calling `WebSocket()` without `new`) is forwarded to the real
  // constructor automatically.
  //
  // The previous plain-function wrapper got three of those wrong: a
  // `class X extends WebSocket` received a bare WebSocket from `super()`
  // instead of an X (its prototype chain was silently dropped), calling
  // `WebSocket()` without `new` quietly succeeded instead of throwing, and
  // `WebSocket.toString()` no longer read as native code. All three are
  // observable from the page, which this interceptor must not be.
  const WrappedWebSocket = new Proxy(NativeWebSocket, {
    construct(ctor, args, newTarget) {
      const ws = Reflect.construct(ctor, args, newTarget) as WebSocket;
      hookSocket(ws, 'ws-constructor');
      return ws;
    },
    get(ctor, prop, receiver) {
      // Answer the double-patch sentinel from the trap so we never define a
      // property on the native constructor that would outlive cleanup.
      if (prop === PATCH_FLAG) return true;
      return Reflect.get(ctor, prop, receiver);
    },
  });
  target.WebSocket = WrappedWebSocket;

  // --- Hook 2: Prototype addEventListener ---
  // Catches sockets that were created BEFORE our constructor wrapper existed.
  // When the page calls `ws.addEventListener('message', handler)` on a
  // pre-existing socket, we piggyback and hook it.
  // Note whether `addEventListener` was an OWN property of WebSocket.prototype
  // before we touched it. Normally it is inherited from EventTarget.prototype,
  // so restoring by plain assignment would leave behind an own property that
  // was never there -- a detectable, if benign, footprint on the page.
  const hadOwnAddListener = Object.prototype.hasOwnProperty.call(
    NativeWebSocket.prototype, 'addEventListener',
  );
  const origAddListener = NativeWebSocket.prototype.addEventListener;
  const patchedAddListener = NativeWebSocket.prototype.addEventListener = function(
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
  let onMsgPatched = false;
  if (origOnMsgDesc?.set && origOnMsgDesc.configurable) {
    const origSet = origOnMsgDesc.set;
    const origGet = origOnMsgDesc.get;
    Object.defineProperty(NativeWebSocket.prototype, 'onmessage', {
      set(fn) {
        if (fn) hookSocket(this, 'ws-proto-onmessage');
        origSet.call(this, fn);
      },
      // The native descriptor always has a getter, but a page that has already
      // redefined `onmessage` may have left a setter-only accessor. Falling
      // back to `undefined` keeps reads from throwing.
      get: origGet ? function (this: WebSocket) { return origGet.call(this); } : undefined,
      // Preserve the original attributes. Omitting `enumerable` would silently
      // flip the native `true` to `false`, changing what the page sees from
      // for-in / Object.keys on a WebSocket -- exactly the kind of observable
      // side effect this interceptor must not have.
      enumerable: origOnMsgDesc.enumerable,
      configurable: true,
    });
    onMsgPatched = true;
  }

  // --- Cleanup ---
  // Restore everything. Only replaces if nobody else has swapped things
  // out since we installed (defensive against other extensions).
  return () => {
    if (target.WebSocket === WrappedWebSocket) {
      target.WebSocket = NativeWebSocket;
    }
    if (NativeWebSocket.prototype.addEventListener === patchedAddListener) {
      if (hadOwnAddListener) {
        NativeWebSocket.prototype.addEventListener = origAddListener;
      } else {
        // Restore inheritance from EventTarget.prototype rather than pinning
        // an own property that did not exist before.
        delete (NativeWebSocket.prototype as any).addEventListener;
      }
    }
    if (onMsgPatched && origOnMsgDesc) {
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
  return () => {
    // Isolate each restore: a frozen prototype or a hostile page redefining a
    // global can make one teardown throw, and that must not leave the other
    // two interceptors permanently installed on the page.
    for (const fn of cleanups) {
      try { fn(); } catch { /* keep tearing down the rest */ }
    }
  };
}
