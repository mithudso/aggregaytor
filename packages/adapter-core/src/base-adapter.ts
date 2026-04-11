/**
 * base-adapter.ts — Abstract base class for platform-specific message adapters.
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

type EventHandler = (event: AdapterEvent) => void;

export abstract class BaseAdapter {
  abstract readonly platform: Platform;
  protected config: AdapterConfig;
  protected selfIds = new SelfIdTracker();
  private listeners = new Map<AdapterEventType, Set<EventHandler>>();
  private cleanupFns: (() => void)[] = [];

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

  /** Initialize the adapter — set up interception, observers, etc. */
  abstract init(): Promise<void>;

  /** Clean up all resources. */
  async destroy(): Promise<void> {
    for (const fn of this.cleanupFns) {
      try { fn(); } catch { /* ignore */ }
    }
    this.cleanupFns = [];
    this.listeners.clear();
    this.selfIds.clear();
  }

  /** Subclass hook: should this URL's response be intercepted? */
  protected abstract shouldInterceptUrl(url: string): boolean;

  /** Subclass hook: parse an API response into UnifiedMessages. */
  protected abstract parseApiResponse(url: string, payload: unknown): UnifiedMessage[];

  /** Subclass hook: parse a WebSocket frame into UnifiedMessages. */
  protected abstract parseWebSocketFrame(data: string | ArrayBuffer): UnifiedMessage[];

  /** Emit an adapter event to all registered listeners. */
  protected emit(event: AdapterEvent): void {
    const handlers = this.listeners.get(event.type);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(event); } catch { /* ignore listener errors */ }
    }
  }

  /** Subscribe to adapter events. Returns an unsubscribe function. */
  on(type: AdapterEventType, handler: EventHandler): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
    return () => {
      this.listeners.get(type)?.delete(handler);
    };
  }

  /** Set up network interception on a target window. */
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

  /** Register a cleanup function to be called on destroy. */
  protected addCleanup(fn: () => void): void {
    this.cleanupFns.push(fn);
  }
}
