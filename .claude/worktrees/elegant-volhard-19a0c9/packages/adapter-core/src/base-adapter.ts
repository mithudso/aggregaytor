/**
 * base-adapter.ts -- Abstract base class for platform-specific message adapters.
 *
 * Every supported platform (Sniffies, Grindr, Doublelist, etc.) will have a
 * concrete adapter that extends `BaseAdapter`. The base class provides:
 *
 *  1. **Network interception wiring** -- `setupNetworkInterception()` patches
 *     `fetch`, `XMLHttpRequest`, and `WebSocket` on a target `window` object,
 *     routing captured payloads through the adapter's `parseApiResponse()` and
 *     `parseWebSocketFrame()` hooks.
 *
 *  2. **Event emitter** -- a lightweight pub/sub (`on` / `emit`) so the UI and
 *     store layers can subscribe to `'messages'`, `'contacts'`, `'typing'`,
 *     `'presence'`, and `'error'` events without tight coupling to any adapter.
 *
 *  3. **Self-ID tracking** -- a `SelfIdTracker` instance that adapters use to
 *     determine which user IDs belong to the logged-in user, so message
 *     `direction` can be set correctly.
 *
 *  4. **Lifecycle management** -- `init()` / `destroy()` and a cleanup registry
 *     that automatically tears down all interception when the adapter is
 *     destroyed.
 *
 * ## MAIN vs. ISOLATED worlds (Chrome extension context)
 *
 * Chrome extensions have two JavaScript execution contexts on each page:
 *  - **MAIN world**: shares the page's `window` -- can monkey-patch `fetch`,
 *    `WebSocket`, etc., and see the page's own JS variables.
 *  - **ISOLATED world**: the default content-script context -- has its own
 *    globals, so patching `window.fetch` there does nothing to the page.
 *
 * Adapters that intercept network traffic MUST run in the MAIN world (or
 * inject a MAIN-world script) because that is where the platform's own JS
 * makes `fetch` / `WebSocket` calls. The `target` parameter in
 * `setupNetworkInterception()` is the MAIN-world `window`.
 */

import type {
  Platform,
  AdapterConfig,
  AdapterEvent,
  AdapterEventType,
  UnifiedMessage,
  InterceptorOptions,
} from './types.js';
import { installAllInterceptors } from './network-interceptor.js';
import { SelfIdTracker } from './self-id-tracker.js';

/** Callback signature for adapter event listeners. */
type EventHandler = (event: AdapterEvent) => void;

export abstract class BaseAdapter {
  /** Platform identifier -- must be set by every concrete adapter. */
  abstract readonly platform: Platform;

  /** Merged configuration with sensible defaults. */
  protected config: AdapterConfig;

  /**
   * Tracks IDs that belong to the currently logged-in user.
   * Adapters feed detected IDs into this tracker so that
   * `parseApiResponse` can mark messages as `direction: 'out'`
   * when the sender matches.
   */
  protected selfIds = new SelfIdTracker();

  /** Per-event-type listener sets. */
  private listeners = new Map<AdapterEventType, Set<EventHandler>>();

  /**
   * Functions that undo side effects (network patches, observers, etc.).
   * All are called during `destroy()`.
   */
  private cleanupFns: (() => void)[] = [];

  /**
   * @param config - Partial config; only `platform` is required.
   *                 Defaults enable all three interceptors and disable DOM observation.
   */
  constructor(config: Partial<AdapterConfig> & { platform: Platform }) {
    this.config = {
      enabled: true,
      interceptFetch: true,
      interceptXHR: true,
      interceptWebSocket: true,
      observeDOM: false,
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // Abstract lifecycle -- subclasses MUST implement
  // -------------------------------------------------------------------------

  /**
   * Initialize the adapter -- set up network interception, DOM observers,
   * self-ID seeding, and anything else platform-specific.
   * Called once after construction.
   */
  abstract init(): Promise<void>;

  /**
   * Tear down all resources: remove network patches, disconnect observers,
   * clear listeners and self-ID state.
   * Safe to call multiple times.
   */
  async destroy(): Promise<void> {
    for (const fn of this.cleanupFns) {
      // Errors in individual cleanup functions must not prevent the rest
      // from running, so we swallow them.
      try { fn(); } catch { /* ignore */ }
    }
    this.cleanupFns = [];
    this.listeners.clear();
    this.selfIds.clear();
  }

  // -------------------------------------------------------------------------
  // Abstract hooks -- subclasses MUST implement
  // -------------------------------------------------------------------------

  /**
   * URL filter: return `true` if responses to this URL should be captured
   * and fed into `parseApiResponse`. Typically checks for the platform's
   * API hostname and message-related endpoints.
   * @param url - The request URL being evaluated.
   * @returns Whether the interceptor should capture this URL's response.
   */
  protected abstract shouldInterceptUrl(url: string): boolean;

  /**
   * Parse a captured REST API response into zero or more `UnifiedMessage`s.
   * This is where each adapter maps its platform-specific JSON shape into
   * the shared schema.
   * @param url     - The API endpoint URL.
   * @param payload - The parsed JSON body of the response.
   * @returns An array of normalized messages (empty array if none found).
   */
  protected abstract parseApiResponse(url: string, payload: unknown): UnifiedMessage[];

  /**
   * Parse a captured WebSocket frame into zero or more `UnifiedMessage`s.
   * Platforms like Sniffies stream real-time chat over WebSockets; this hook
   * lets the adapter decode those frames.
   * @param data - The raw frame data (string for text frames, ArrayBuffer for binary).
   * @returns An array of normalized messages (empty array if none found).
   */
  protected abstract parseWebSocketFrame(data: string | ArrayBuffer): UnifiedMessage[];

  // -------------------------------------------------------------------------
  // Event emitter -- lightweight pub/sub for adapter consumers
  // -------------------------------------------------------------------------

  /**
   * Emit an adapter event to all registered listeners of that type.
   * Listener errors are swallowed so one bad listener cannot break the
   * pipeline for others.
   * @param event - The event to broadcast.
   */
  protected emit(event: AdapterEvent): void {
    const handlers = this.listeners.get(event.type);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(event); } catch { /* ignore listener errors */ }
    }
  }

  /**
   * Subscribe to a specific adapter event type.
   * @param type    - The event type to listen for (e.g. `'messages'`).
   * @param handler - Callback invoked with the event.
   * @returns An unsubscribe function -- call it to remove this listener.
   */
  on(type: AdapterEventType, handler: EventHandler): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
    // Return a disposer so callers can clean up without keeping a
    // reference to the Map internals.
    return () => {
      this.listeners.get(type)?.delete(handler);
    };
  }

  // -------------------------------------------------------------------------
  // Network interception setup
  // -------------------------------------------------------------------------

  /**
   * Install fetch, XHR, and WebSocket interceptors on the given `window`.
   *
   * This is the main wiring point between the generic interception layer
   * and the adapter's platform-specific parsing. The flow is:
   *
   *  1. `network-interceptor` monkey-patches `fetch` / `XHR.send` / `WebSocket`
   *     on `target`.
   *  2. When the page makes a request, the patch checks `shouldInterceptUrl()`.
   *  3. If matched, the JSON response (or WS frame) is forwarded to the
   *     adapter's `parseApiResponse()` / `parseWebSocketFrame()`.
   *  4. Any resulting `UnifiedMessage[]` is emitted as a `'messages'` event.
   *
   * The returned cleanup function (also auto-registered for `destroy()`)
   * restores the original globals.
   *
   * @param target - The MAIN-world `window` whose globals will be patched.
   *                 In a Chrome extension, this must be the page's own window,
   *                 not the isolated content-script window.
   * @returns A cleanup function that removes all patches.
   */
  protected setupNetworkInterception(target: Window & typeof globalThis): () => void {
    const opts: InterceptorOptions = {
      shouldInterceptUrl: (url) => this.shouldInterceptUrl(url),
      onFetchResponse: (url, data) => {
        const messages = this.parseApiResponse(url, data);
        if (messages.length) this.emit({ type: 'messages', payload: messages });
      },
      onXHRResponse: (url, data) => {
        const messages = this.parseApiResponse(url, data);
        if (messages.length) this.emit({ type: 'messages', payload: messages });
      },
      onWebSocketMessage: (data) => {
        const messages = this.parseWebSocketFrame(data);
        if (messages.length) this.emit({ type: 'messages', payload: messages });
      },
    };

    const cleanup = installAllInterceptors(target, opts);
    this.cleanupFns.push(cleanup);
    return cleanup;
  }

  // -------------------------------------------------------------------------
  // Cleanup helpers
  // -------------------------------------------------------------------------

  /**
   * Register an arbitrary cleanup function to be called during `destroy()`.
   * Use this for platform-specific teardown (e.g. MutationObserver.disconnect,
   * interval timers, event listener removal).
   * @param fn - A zero-argument function that undoes some side effect.
   */
  protected addCleanup(fn: () => void): void {
    this.cleanupFns.push(fn);
  }
}
