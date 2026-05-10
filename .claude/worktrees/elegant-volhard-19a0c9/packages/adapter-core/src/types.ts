/**
 * types.ts -- Core schema definitions for the message aggregator.
 *
 * This file is the single source of truth for every shared type in
 * @aggregaytor/adapter-core. Platform adapters, the context-engine, the
 * store layer, and the UI all depend on these interfaces.
 *
 * Key design decisions:
 *  - All cross-platform IDs are namespaced as `{platform}:{platformId}` to
 *    guarantee uniqueness when messages from different platforms are stored
 *    together in the unified store.
 *  - `UnifiedMessage` and `UnifiedContact` carry a `metadata` bag so that
 *    platform adapters can pass through platform-specific fields (e.g.
 *    Grindr distance, Sniffies coordinates) without polluting the core
 *    schema.
 *  - `InterceptorOptions` is the contract between BaseAdapter and the
 *    network-interceptor module -- adapters never touch patching logic
 *    directly; they only provide callbacks through this interface.
 */

// ---------------------------------------------------------------------------
// Platform identifiers
// ---------------------------------------------------------------------------

/**
 * Supported messaging platforms.
 * Each adapter must declare exactly one of these as its `platform` value.
 */
export type Platform =
  | 'sniffies'
  | 'grindr'
  | 'doublelist'
  | 'adam4adam'
  | 'gmail'
  | 'yahoo';

// ---------------------------------------------------------------------------
// Unified message / contact schemas
// ---------------------------------------------------------------------------

/**
 * A single message normalized across all platforms.
 *
 * Every adapter must produce these from raw API/WebSocket payloads.
 * The `direction` field depends on self-ID detection -- see
 * `SelfIdTracker` -- to decide whether a message is inbound or outbound.
 */
export interface UnifiedMessage {
  /** Globally unique: `{platform}:{platformMessageId}` */
  id: string;
  /** Which platform this message originated from. */
  platform: Platform;
  /** Conversation thread: `{platform}:{platformThreadId}` */
  threadId: string;
  /** The other party: `{platform}:{platformUserId}` */
  contactId: string;
  /** `'in'` = received, `'out'` = sent by the logged-in user. */
  direction: 'in' | 'out';
  /** Plain-text message body. */
  body: string;
  /** ISO 8601 timestamp of when the message was sent. */
  timestamp: string;
  /** Whether the logged-in user has already read this message. */
  read: boolean;
  /** Platform-specific extras (distance, coordinates, media URLs, etc.). */
  metadata: Record<string, unknown>;
}

/**
 * A contact (the other party in a conversation) normalized across platforms.
 */
export interface UnifiedContact {
  /** Globally unique: `{platform}:{platformUserId}` */
  id: string;
  /** Which platform this contact belongs to. */
  platform: Platform;
  /** Raw user ID on the originating platform. */
  platformUserId: string;
  /** Human-readable name or handle. */
  displayName: string;
  /** Link to the contact's profile on the platform. */
  profileUrl: string;
  /** URL of the contact's avatar image. */
  avatarUrl: string;
  /** ISO 8601 timestamp of last known activity. */
  lastSeen: string;
  /** Platform-specific extras (age, distance, bio, etc.). */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Adapter event system
// ---------------------------------------------------------------------------

/**
 * The set of event types an adapter can emit.
 * Listeners register for specific types via `BaseAdapter.on()`.
 */
export type AdapterEventType = 'messages' | 'contacts' | 'typing' | 'presence' | 'error';

/**
 * An event emitted by a platform adapter.
 *
 * `payload` is polymorphic based on `type`:
 *  - `'messages'`  -> `UnifiedMessage[]`
 *  - `'contacts'`  -> `UnifiedContact[]`
 *  - `'typing'` / `'presence'` -> `{ contactId: string }`
 *  - `'error'`     -> `Error`
 */
export interface AdapterEvent {
  type: AdapterEventType;
  payload: UnifiedMessage[] | UnifiedContact[] | { contactId: string } | Error;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a platform adapter.
 *
 * The `intercept*` flags let callers selectively enable or disable each
 * network interception mechanism. Some platforms only use WebSockets for
 * real-time chat (e.g. Sniffies), while others rely purely on REST
 * (e.g. Doublelist).
 */
export interface AdapterConfig {
  /** Which platform this config is for. */
  platform: Platform;
  /** Master on/off switch for the adapter. */
  enabled: boolean;
  /** Patch `window.fetch` to capture JSON responses. */
  interceptFetch: boolean;
  /** Patch `XMLHttpRequest` to capture JSON responses. */
  interceptXHR: boolean;
  /** Wrap `WebSocket` constructor + prototype to capture frames. */
  interceptWebSocket: boolean;
  /** Use a MutationObserver on the DOM as a fallback message source. */
  observeDOM: boolean;
}

// ---------------------------------------------------------------------------
// Interceptor callback contract
// ---------------------------------------------------------------------------

/**
 * Callbacks that `installAllInterceptors` invokes when network traffic
 * is captured.
 *
 * This interface decouples the low-level monkey-patching (fetch/XHR/WS)
 * from the adapter's parsing logic. The adapter provides these callbacks,
 * and the interceptor calls them at the right time.
 */
export interface InterceptorOptions {
  /**
   * Filter: return `true` if this URL's response should be captured.
   * Called for every fetch/XHR; WebSocket frames bypass this.
   * @param url - The request URL.
   */
  shouldInterceptUrl: (url: string) => boolean;
  /**
   * Called with the parsed JSON body of a matched `fetch()` response.
   * @param url  - The request URL.
   * @param data - The parsed JSON payload.
   */
  onFetchResponse: (url: string, data: unknown) => void;
  /**
   * Called with the parsed JSON body of a matched `XMLHttpRequest` response.
   * @param url  - The request URL.
   * @param data - The parsed JSON payload.
   */
  onXHRResponse: (url: string, data: unknown) => void;
  /**
   * Called for every incoming WebSocket `message` event.
   * @param data   - Raw frame data (string or ArrayBuffer).
   * @param source - Debug tag indicating how the socket was intercepted
   *                 (`'ws-constructor'`, `'ws-proto-addEventListener'`, etc.).
   */
  onWebSocketMessage: (data: string | ArrayBuffer, source: string) => void;
}

// ---------------------------------------------------------------------------
// Payload walker
// ---------------------------------------------------------------------------

/**
 * Visitor interface for `walkPayload()`.
 *
 * Implement `onObject` to inspect each object node during a BFS traversal
 * of an arbitrary JSON payload tree. The walker handles cycle detection
 * and depth limiting; the visitor only needs to extract what it cares about.
 */
export interface PayloadVisitor {
  /**
   * Called once per unique object node in the payload tree.
   * @param obj       - The current object being visited.
   * @param contextId - An optional conversation/thread ID propagated from
   *                    the root of the walk (set by the adapter).
   * @param depth     - How deep this node is from the payload root (0-based).
   */
  onObject(obj: Record<string, unknown>, contextId: string | null, depth: number): void;
}

// ---------------------------------------------------------------------------
// DOM observation (fallback message source)
// ---------------------------------------------------------------------------

/**
 * Configuration for the MutationObserver-based DOM extractor.
 *
 * Used as a fallback when API/WebSocket interception is insufficient
 * (e.g. platforms that render messages client-side without a clean API).
 */
export interface DOMExtractorOptions {
  /** CSS selector for the container that holds all messages. */
  rootSelector: string;
  /** CSS selector for individual message elements within the root. */
  messageSelector: string;
  /**
   * Called when new message elements appear in the DOM.
   * @param elements - The newly added message DOM elements.
   */
  onNewElements: (elements: Element[]) => void;
  /** Whether to observe the entire subtree of the root (default: false). */
  subtree?: boolean;
}
