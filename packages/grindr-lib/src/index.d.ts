// Hand-written type surface for the vendored Grindr client library.
// The implementation lives in the sibling .js modules (JSDoc-annotated);
// these declarations cover the exports the aggregaytor code consumes.

export const VERSION: string;

export interface GrindrCredentials {
  token?: string;
  countryCode?: string;
  locale?: string;
  base?: string;
}

export interface GrindrAuth {
  set(cfg?: GrindrCredentials): boolean;
  clear(): void;
  isReady(): boolean;
  headers(extra?: Record<string, string>): Record<string, string>;
  request(path: string, opts?: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  enc(id: unknown): string;
  encId(id: unknown): string;
  readonly base: string;
}

export interface GrindrBlocks {
  hide(id: string): Promise<true>;
  block(id: string): Promise<true>;
  unblock(id: string, kind?: 'block' | 'hide'): Promise<true>;
  listHides(): Promise<unknown[]>;
  listBlocks(opts?: { maxPages?: number }): Promise<unknown[]>;
}

export interface GrindrChat {
  getHistory(convId: string, limit?: number): Promise<unknown>;
  sendTyping(convId: string, status?: string): Promise<unknown>;
}

export interface GrindrProfiles {
  getProfile(id: string): Promise<unknown>;
  getCascade(params?: Record<string, unknown>): Promise<unknown>;
  recordView(id: string): Promise<unknown>;
}

export interface GrindrAlbums {
  getShares(albumId: string): Promise<string[]>;
  share(albumId: string, profileId: string, shareId?: string): Promise<unknown>;
  unshare(albumId: string, profileId: string, shareId?: string): Promise<unknown>;
  queryShare(profileId: string): Promise<unknown>;
}

export interface GrindrLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  pending(): number;
}

export interface GrindrObserver {
  install(): void;
  uninstall(): void;
}

export interface GrindrClient {
  auth: GrindrAuth;
  blocks: GrindrBlocks;
  albums: GrindrAlbums;
  chat: GrindrChat;
  profiles: GrindrProfiles;
  dom: typeof import('./dom.js');
  compose: typeof import('./compose.js');
  reconcile: {
    idsFromListPayload(text: string | object): Set<string>;
    reconcileTiers(opts?: { maxPages?: number }): Promise<{ hideIds: Set<string>; blockIds: Set<string>; needsUpgrade: Set<string> }>;
  };
  limiterFactory: typeof createLimiter;
  observer: GrindrObserver | null;
  destroy(): void;
}

export function createClient(opts?: {
  token?: string;
  countryCode?: string;
  locale?: string;
  base?: string;
  observe?: boolean;
  onObserveError?: (e: unknown) => void;
}): GrindrClient;

export function createLimiter(opts?: { minIntervalMs?: number; maxPerHour?: number }): GrindrLimiter;

export function createObserver(handlers?: {
  onAuth?: (a: { token: string; countryCode: string; locale: string }) => void;
  onListResponse?: (r: { url: string; data: unknown }) => void;
  onWsSend?: (data: unknown) => void;
  onError?: (e: unknown) => void;
  isGrindrUrl?: (u: string) => boolean;
}): GrindrObserver;

export function conversationId(a: unknown, b: unknown): string;
export function deriveOwnId(convA: string, convB: string): string;
export function idsFromListPayload(text: string | object): Set<string>;

export const dom: typeof import('./dom.js');
export const compose: typeof import('./compose.js');
