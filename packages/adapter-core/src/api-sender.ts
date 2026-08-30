/**
 * api-sender.ts — API replay for sending messages.
 *
 * Captures auth headers from intercepted API calls, then replays
 * the send-message endpoint with the captured credentials.
 * Falls back to DOM injection if API replay fails.
 *
 * ## Cache keys
 *
 * `network-interceptor` stores captures under the request's registrable
 * domain (`grindr.com`, `sniffies.com`), and callers such as the Grindr
 * content script read them back with that same host key. `sendViaApi`,
 * however, is called with a `Platform` slug (`'grindr'`). `PLATFORM_AUTH_HOST`
 * bridges the two namespaces; without it `sendViaApi` looked up a key that is
 * never written and always fell through to the DOM path.
 */

import { createLogger } from './logger.js';

const log = createLogger('[Aggregaytor:APISender]');

interface CapturedAuth {
  headers: Record<string, string>;
  capturedAt: number;
}

const authCache = new Map<string, CapturedAuth>();
const AUTH_TTL_MS = 30 * 60_000; // 30 minutes

/**
 * Hard cap on distinct cached hosts. Every fetch on the page can contribute a
 * key, so without a bound a long-lived tab on an ad-heavy page would retain
 * credentials for arbitrary third-party hosts indefinitely (the TTL is only
 * enforced lazily, on read).
 */
const MAX_AUTH_ENTRIES = 32;

/** Platform slug -> the host key that captures are actually stored under. */
const PLATFORM_AUTH_HOST: Record<string, string> = {
  sniffies: 'sniffies.com',
  grindr: 'grindr.com',
};

/**
 * Capture auth headers from an intercepted request for later replay.
 *
 * @param platform - Cache key. In practice the request's registrable domain
 *                   (e.g. `grindr.com`), supplied by `network-interceptor`.
 * @param headers  - All request headers; only auth-bearing ones are retained.
 */
export function captureAuthHeaders(platform: string, headers: Record<string, string>): void {
  const authHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    if (lk === 'authorization' || lk === 'x-auth-token' || lk === 'x-api-key' ||
        lk === 'cookie' || lk === 'x-csrf-token' || lk === 'x-session-id' ||
        lk.startsWith('x-grindr') || lk.startsWith('x-sniffies')) {
      authHeaders[key] = value;
    }
  }
  if (Object.keys(authHeaders).length) {
    const now = Date.now();
    // Drop expired entries, then (if still over cap) the oldest, before
    // inserting. Map preserves insertion order, so the first key is the
    // least-recently-captured one.
    if (!authCache.has(platform) && authCache.size >= MAX_AUTH_ENTRIES) {
      for (const [key, entry] of authCache) {
        if (now - entry.capturedAt > AUTH_TTL_MS) authCache.delete(key);
      }
      while (authCache.size >= MAX_AUTH_ENTRIES) {
        const oldest = authCache.keys().next();
        if (oldest.done) break;
        authCache.delete(oldest.value);
      }
    }
    authCache.set(platform, { headers: authHeaders, capturedAt: now });
    // Debug level: this fires on every credentialed request the page makes,
    // and the console it writes to is the host page's.
    log.debug(`Captured auth for ${platform}: ${Object.keys(authHeaders).join(', ')}`);
  }
}

/**
 * Get cached auth headers for a platform.
 *
 * @param platform - Either a host key (`grindr.com`) or a `Platform` slug
 *                   (`grindr`); both resolve to the same capture.
 * @returns The captured headers, or `null` if absent or past the TTL.
 */
export function getCapturedAuth(platform: string): Record<string, string> | null {
  const key = authCache.has(platform) ? platform : (PLATFORM_AUTH_HOST[platform] ?? platform);
  const cached = authCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.capturedAt > AUTH_TTL_MS) {
    authCache.delete(key);
    return null;
  }
  return cached.headers;
}

/** How long to wait for a replayed send before giving up and falling back. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Strip a `{platform}:` namespace prefix from a unified contact ID.
 *
 * Uses a prefix check rather than `String.replace`, which would also strip an
 * occurrence in the middle of the ID.
 */
function stripPlatformPrefix(contactId: string, prefix: string): string {
  return contactId.startsWith(prefix) ? contactId.slice(prefix.length) : contactId;
}

/**
 * Send a message via API replay.
 *
 * @param platform  - Platform slug (`'sniffies'`, `'grindr'`).
 * @param contactId - Unified contact ID (`{platform}:{platformUserId}`).
 * @param text      - Message body.
 * @returns `true` on success, `false` if the caller should fall back to DOM.
 */
export async function sendViaApi(
  platform: string,
  contactId: string,
  text: string,
): Promise<boolean> {
  const auth = getCapturedAuth(platform);
  if (!auth) {
    log.info(`No captured auth for ${platform}, falling back to DOM`);
    return false;
  }

  try {
    switch (platform) {
      case 'sniffies':
        return await sendSniffiesApi(contactId, text, auth);
      case 'grindr':
        return await sendGrindrApi(contactId, text, auth);
      default:
        return false;
    }
  } catch (err) {
    log.warn(`API send failed for ${platform}:`, err);
    return false;
  }
}

/**
 * POST a message body to `url` with the captured credentials.
 *
 * @returns `true` only on a 2xx response.
 */
async function postMessage(
  label: string,
  url: string,
  text: string,
  auth: Record<string, string>,
): Promise<boolean> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...auth,
    },
    body: JSON.stringify({ body: text, type: 'text' }),
    // Without a deadline a stalled connection leaves the caller awaiting
    // forever instead of falling back to DOM injection.
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(SEND_TIMEOUT_MS)
      : undefined,
  });
  if (res.ok) {
    log.info(`${label} API send success`);
    return true;
  }
  log.warn(`${label} API send failed: ${res.status}`);
  return false;
}

async function sendSniffiesApi(contactId: string, text: string, auth: Record<string, string>): Promise<boolean> {
  // encodeURIComponent: the ID reaches us from stored/UI data, and an
  // unescaped `/`, `?` or `..` would silently retarget the request at a
  // different endpoint on the platform's origin.
  const profileId = encodeURIComponent(stripPlatformPrefix(contactId, 'sniffies:'));
  // Sniffies sends messages via POST to conversation endpoint
  return postMessage(
    'Sniffies',
    `https://sniffies.com/api/conversations/${profileId}/messages`,
    text,
    auth,
  );
}

async function sendGrindrApi(contactId: string, text: string, auth: Record<string, string>): Promise<boolean> {
  const conversationId = encodeURIComponent(stripPlatformPrefix(contactId, 'grindr:'));
  return postMessage(
    'Grindr',
    `https://web.grindr.com/v4/chat/conversation/${conversationId}`,
    text,
    auth,
  );
}
