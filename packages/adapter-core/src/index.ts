/**
 * @aggregaytor/adapter-core
 *
 * Base adapter class, network interception, payload walking,
 * message normalization, and DOM observation utilities.
 */

// Types
export type {
  Platform,
  UnifiedMessage,
  UnifiedContact,
  AdapterEventType,
  AdapterEvent,
  AdapterConfig,
  InterceptorOptions,
  PayloadVisitor,
  DOMExtractorOptions,
} from './types.js';

// Base adapter
export { BaseAdapter } from './base-adapter.js';

// Network interception
export {
  installFetchInterceptor,
  installXHRInterceptor,
  installWebSocketInterceptor,
  installAllInterceptors,
} from './network-interceptor.js';

// Payload walker
export { walkPayload } from './payload-walker.js';

// Message normalization
export {
  extractTimestamp,
  extractDirection,
  extractMessageText,
  extractId,
  parseRelativeTimeString,
} from './message-normalizer.js';

// Self-ID tracking
export { SelfIdTracker } from './self-id-tracker.js';

// DOM observation
export { createDOMExtractor } from './dom-observer.js';

// API replay sender
export { captureAuthHeaders, getCapturedAuth, sendViaApi } from './api-sender.js';

// Logger
export { createLogger, setLogLevel, getLogLevel, loadLogLevel, saveLogLevel } from './logger.js';
export type { LogLevel } from './logger.js';
