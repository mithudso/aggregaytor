/**
 * types.ts — Core schema definitions for the message aggregator.
 */

export type Platform =
  | 'sniffies'
  | 'grindr'
  | 'doublelist'
  | 'adam4adam'
  | 'gmail'
  | 'yahoo';

export interface UnifiedMessage {
  id: string;                     // '{platform}:{platformMessageId}'
  platform: Platform;
  threadId: string;               // '{platform}:{platformThreadId}'
  contactId: string;              // '{platform}:{platformUserId}'
  direction: 'in' | 'out';
  body: string;
  timestamp: string;              // ISO 8601
  read: boolean;
  metadata: Record<string, unknown>;
}

export interface UnifiedContact {
  id: string;                     // '{platform}:{platformUserId}'
  platform: Platform;
  platformUserId: string;
  displayName: string;
  profileUrl: string;
  avatarUrl: string;
  lastSeen: string;               // ISO 8601
  metadata: Record<string, unknown>;
}

export type AdapterEventType = 'messages' | 'contacts' | 'typing' | 'presence' | 'error';

export interface AdapterEvent {
  type: AdapterEventType;
  payload: UnifiedMessage[] | UnifiedContact[] | { contactId: string } | Error;
}

export interface AdapterConfig {
  platform: Platform;
  enabled: boolean;
  interceptFetch: boolean;
  interceptXHR: boolean;
  interceptWebSocket: boolean;
  observeDOM: boolean;
}

export interface InterceptorOptions {
  shouldInterceptUrl: (url: string) => boolean;
  onFetchResponse: (url: string, data: unknown) => void;
  onXHRResponse: (url: string, data: unknown) => void;
  onWebSocketMessage: (data: string | ArrayBuffer, source: string) => void;
}

export interface PayloadVisitor {
  onObject(obj: Record<string, unknown>, contextId: string | null, depth: number): void;
}

export interface DOMExtractorOptions {
  rootSelector: string;
  messageSelector: string;
  onNewElements: (elements: Element[]) => void;
  subtree?: boolean;
}
