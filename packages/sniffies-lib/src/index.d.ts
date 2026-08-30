// Hand-written type surface for the vendored Sniffies client library.
// Implementations live in the sibling JSDoc-annotated .js modules; these
// declarations cover the exports the aggregaytor code consumes.

export const VERSION: string;

export class SniffiesError extends Error {
  status: number;
  path: string;
  base: string;
  constructor(message: string, meta?: { status?: number; path?: string; base?: string });
}
export class SniffiesAllBasesError extends SniffiesError {
  attempts: Array<{ base: string; error: Error }>;
  constructor(path: string, attempts?: Array<{ base: string; error: Error }>);
}
export class SniffiesTimeoutError extends SniffiesError {
  timeoutMs: number;
  constructor(path: string, ms: number);
}

export interface SniffiesLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  reportRejection(): void;
  cooldownRemainingMs(): number;
  pending(): number;
}
export function createLimiter(opts?: { maxPerMinute?: number; minIntervalMs?: number; cooldownMs?: number }): SniffiesLimiter;

export interface SniffiesApi {
  getPartials(ids: string[]): Promise<Array<Record<string, unknown>>>;
  getFullUser(id: string): Promise<Record<string, unknown> | null>;
  computeLastActiveTs(row: unknown, nowMs?: number): number;
  extractAttitudeFromPartial(row: unknown): string | null | undefined;
  readonly preferredBase: string;
  readonly preferredShape: string;
  readonly preferredFullOrigin: string;
}
export function createApi(opts?: {
  bases?: string[];
  fullOrigins?: string[];
  limiter?: SniffiesLimiter | null;
  remember?: (k: string, v: string) => void;
  recall?: (k: string) => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SniffiesApi;

export function computeLastActiveTs(row: unknown, nowMs?: number): number;
export function extractAttitudeFromPartial(row: unknown): string | null | undefined;
export function fetchWithTimeout(input: RequestInfo | URL, opts?: RequestInit, timeoutMs?: number): Promise<Response>;

export interface SniffiesObserver {
  install(): boolean;
  uninstall(): void;
}
export function createObserver(handlers?: {
  onApiJson?: (r: { url: string; data: unknown; via: 'fetch' | 'xhr' }) => void;
  onSocketFrame?: (f: { event: string; data: unknown; raw: string }) => void;
  onError?: (e: unknown) => void;
  isApiUrl?: (u: string) => boolean;
  target?: unknown;
}): SniffiesObserver;
export function decodeSocketFrame(text: string): { event: string; data: unknown } | null;
export function isSniffiesApiUrl(u: string): boolean;

export interface SniffiesClient {
  VERSION: string;
  api: SniffiesApi;
  dom: typeof import('./dom.js');
  compose: typeof import('./compose.js');
  limiter: SniffiesLimiter;
  observer: SniffiesObserver | null;
  describe(ids: string[]): Promise<Array<{ id: string | null; attitude: string | null; lastActiveTs: number }>>;
}
export function createClient(opts?: {
  observe?: boolean;
  limiter?: SniffiesLimiter;
  remember?: (k: string, v: string) => void;
  recall?: (k: string) => string | null;
  onApiJson?: (r: { url: string; data: unknown; via: 'fetch' | 'xhr' }) => void;
  onSocketFrame?: (f: { event: string; data: unknown; raw: string }) => void;
}): SniffiesClient;

export const dom: typeof import('./dom.js');
export const compose: typeof import('./compose.js');
