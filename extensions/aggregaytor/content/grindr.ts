/**
 * grindr.ts — MAIN world content script for web.grindr.com.
 *
 * Runs in page context to intercept fetch/XHR/WebSocket.
 * Communicates with ISOLATED world bridge via CustomEvents.
 */

import { GrindrAdapter } from '@aggregaytor/adapter-grindr';
import { getCapturedAuth } from '@aggregaytor/adapter-core';
import { createClient } from '@aggregaytor/grindr-lib';
import { initTextExpander } from './text-expander.js';
import { initGrindrFilters, indexGrindrProfile } from './grindr-filters.js';

const LOG = '[Aggregaytor:Grindr]';

// Grindr client from the vendored @aggregaytor/grindr-lib. `observe: true`
// installs the lib's fetch/WebSocket observer which auto-captures the
// `Grindr3` auth header into `grindr.auth` — the same patching technique the
// adapter already uses; nothing new is exposed on `window`.
const grindr = createClient({
  observe: true,
  onObserveError: (e: unknown) => console.warn(LOG, 'observe error', e),
});
const { dom, compose } = grindr;

// ── Profile ID ↔ Photo Hash Map ─────────────────────────────────────────────
// Grindr's cascade grid doesn't expose profile IDs in the DOM. The adapter
// (which patches fetch BEFORE the page loads) indexes all profileId + photoHash
// pairs from API responses into window.__grindr_hash_map. We use that global
// map for lookups, plus maintain our own as a supplement.
const photoHashToProfileId = new Map<string, string>();
const PHOTO_HASH_MAP_MAX = 10_000;

/**
 * Resolve a Grindr photo hash to a profileId, preferring the adapter's global
 * `window.__grindr_hash_map` (fed by pre-page-load fetch patching, so it has
 * cascade data we might miss) and falling back to our local supplement map.
 *
 * @param hash - Photo/media hash extracted from a CDN image URL.
 * @returns The profileId, or `''` if unknown in either map.
 */
function lookupProfileId(hash: string): string {
  // Check adapter's map first (has cascade API data we might miss)
  const w = window as any;
  if (w.__grindr_hash_map instanceof Map) {
    const pid = w.__grindr_hash_map.get(hash);
    if (pid) return pid;
  }
  return photoHashToProfileId.get(hash) || '';
}

/**
 * Insert a hash→profileId pair into the local map with a simple FIFO cap
 * ({@link PHOTO_HASH_MAP_MAX}) to bound memory on long cascade-scrolling
 * sessions. Hot path (called per profile per API response) — no logging.
 */
function cappedHashSet(hash: string, pid: string): void {
  photoHashToProfileId.set(hash, pid);
  if (photoHashToProfileId.size > PHOTO_HASH_MAP_MAX) {
    const oldest = photoHashToProfileId.keys().next();
    if (!oldest.done) photoHashToProfileId.delete(oldest.value);
  }
}

/**
 * Extract every (photoHash → profileId) pairing from one profile-shaped API
 * object and index it via {@link cappedHashSet}, so a later middle-click on a
 * cascade image can be resolved to a profileId. Tolerant of Grindr's several
 * hash field names/shapes. Hot path (runs over every fetch response) — no logging.
 *
 * @param obj - A single object from a walked grindr.com JSON response.
 */
function indexProfileFromPayload(obj: Record<string, unknown>): void {
  const pid = String(obj.profileId || obj.profileID || '');
  if (!pid || !/^\d+$/.test(pid)) return;

  const hash = String(obj.photoHash || obj.profileImageMediaHash || obj.mediahash || obj.primaryPhotoHash || '');
  if (hash && hash !== 'undefined' && hash !== 'null') {
    cappedHashSet(hash, pid);
  }

  const photoMediaHashes = obj.photoMediaHashes;
  if (Array.isArray(photoMediaHashes)) {
    for (const h of photoMediaHashes) {
      if (typeof h === 'string' && h.length > 10) {
        cappedHashSet(h, pid);
      }
    }
  }

  const medias = obj.medias;
  if (Array.isArray(medias)) {
    for (const m of medias) {
      const mHash = String((m as any)?.mediaHash || '');
      if (mHash && mHash !== 'undefined') {
        cappedHashSet(mHash, pid);
      }
    }
  }
}

// NOTE: this map is deliberately NOT exposed on `window`. The ISOLATED-world
// bridge cannot read MAIN-world globals anyway, so a window export bought us
// nothing while handing the host page our photoHash → profileId index. Hash
// lookups are serviced in-process by the `__aggregaytor_block_by_hash`
// handler below.

/**
 * Forward an adapter event to the ISOLATED-world bridge (MAIN world).
 *
 * WHY: MAIN-world scripts cannot call `chrome.*`; the bridge relays this
 * `window` CustomEvent to the service worker. The payload is JSON deep-cloned so
 * it crosses the structured-clone boundary and carries no live references. The
 * catch is intentionally silent — a serialization failure on this fire-and-
 * forget path must not throw and break the adapter's emit loop.
 *
 * @param message - Plain, JSON-serializable message object to relay.
 */
function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(
      new CustomEvent('__aggregaytor_message', {
        detail: JSON.parse(JSON.stringify(message)),
      }),
    );
  } catch {
    // silently ignore
  }
}

const GRINDR_BRIDGE_RESPONSE_EVENT = '__aggregaytor_grindr_bridge_response';

/**
 * Reply to a bridge-originated request (see grindr-bridge's
 * `relayMainWorldRequest`) by echoing its `requestId` alongside the result.
 * JSON-cloned for the same cross-world safety as {@link sendToBridge}; the catch
 * is intentionally silent (a dropped response is handled by the bridge timeout).
 *
 * @param requestId - Correlation id minted by the bridge for this request.
 * @param payload - Result object to hand back to the bridge.
 */
function sendBridgeResponse(requestId: string, payload: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent(GRINDR_BRIDGE_RESPONSE_EVENT, {
      detail: JSON.parse(JSON.stringify({ requestId, payload })),
    }));
  } catch {}
}

/**
 * Best-effort scan of `localStorage` for a Grindr auth token — used only as a
 * fallback when the adapter's fetch observer hasn't captured a `Grindr3` header
 * yet. Tries a list of well-known keys, then any JWT-shaped value, then any
 * JSON blob with a token field. Each JSON parse is guarded.
 *
 * @returns The raw token string, or `''` if none found.
 */
function findTokenFromStorage(): string {
  const keys = ['authToken', 'auth-token', 'grindrAuthToken', 'session', 'grindrSession', 'access_token', 'accessToken', 'token'];
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value && value.length > 20 && !value.startsWith('{')) return value;
  }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i) || '';
    const value = localStorage.getItem(key) || '';
    if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(value)) return value;
    if (!value.startsWith('{')) continue;
    try {
      const obj = JSON.parse(value);
      const token = obj.authToken || obj.accessToken || obj.token || obj.session?.authToken || obj.session?.accessToken;
      if (token && String(token).length > 20) return String(token);
    } catch {}
  }
  return '';
}

/**
 * Assemble the auth headers to attach to direct Grindr API calls, preferring
 * the adapter's captured `Grindr3` header and falling back to a token dug out of
 * localStorage ({@link findTokenFromStorage}). Never exposes the token on
 * `window`.
 *
 * @returns `{ authHeaders, authSource }` where authSource is `'adapter' | 'localStorage' | 'none'`.
 */
function resolveGrindrAuthHeaders(): { authHeaders: Record<string, string>; authSource: string } {
  const authHeaders: Record<string, string> = {};
  const captured = getCapturedAuth('grindr.com');
  if (captured && Object.keys(captured).length) {
    Object.assign(authHeaders, captured);
    return { authHeaders, authSource: 'adapter' };
  }

  const token = findTokenFromStorage();
  if (token) {
    authHeaders.Authorization = token.startsWith('Grindr3 ') || token.startsWith('Bearer ')
      ? token
      : `Grindr3 ${token}`;
    return { authHeaders, authSource: 'localStorage' };
  }

  return { authHeaders, authSource: 'none' };
}

/**
 * Recursively walk an arbitrary API response and collect every plausible
 * profileId (5+ digit numeric strings, either bare or under a known id key).
 * Deliberately permissive because block/hide/favorite endpoints vary in shape
 * across API versions. Pure — no side effects, no logging.
 *
 * @param data - Any JSON value from a Grindr endpoint.
 * @returns Deduped list of profileId strings.
 */
function extractProfileIds(data: unknown): string[] {
  if (!data) return [];
  const ids: string[] = [];
  const walk = (value: unknown): void => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value);
      if (/^\d{5,}$/.test(normalized)) ids.push(normalized);
      return;
    }
    if (typeof value !== 'object') return;
    for (const key of ['profileId', 'profile_id', 'id', 'userId', 'user_id', 'blockedProfileId', 'hiddenProfileId']) {
      const maybeId = (value as Record<string, unknown>)[key];
      if (maybeId == null) continue;
      const normalized = String(maybeId);
      if (/^\d{5,}$/.test(normalized)) {
        ids.push(normalized);
        return;
      }
    }
    for (const key of ['profiles', 'items', 'data', 'list', 'blocks', 'hides', 'results', 'content']) {
      walk((value as Record<string, unknown>)[key]);
    }
  };
  walk(data);
  return [...new Set(ids)];
}

/**
 * Import the user's Grindr block / hide / favorite lists as ML training signal
 * (blocks & hides = negative, favorites = positive). Paginates each candidate
 * endpoint until a page yields no new ids. Per-request failures are captured
 * into the returned `debug` array (and the loop breaks) rather than thrown, so a
 * single dead endpoint can't abort the whole import.
 *
 * @returns `{ results, debug, authSource }` — labelled ids, per-URL debug rows, and how auth was resolved.
 * @throws Never; network/HTTP failures are recorded in `debug`.
 */
async function fetchGrindrTrainingImport(): Promise<{
  results: Array<{ profileId: string; liked: boolean; source: string }>;
  debug: Array<{ url: string; status: number; keys: string[]; count: number; sample: unknown }>;
  authSource: string;
}> {
  const { authHeaders, authSource } = resolveGrindrAuthHeaders();
  const results: Array<{ profileId: string; liked: boolean; source: string }> = [];
  const debug: Array<{ url: string; status: number; keys: string[]; count: number; sample: unknown }> = [];

  const paginateEndpoint = async (baseUrl: string, liked: boolean, source: string): Promise<void> => {
    const seen = new Set<string>();
    for (let page = 1; page <= 40; page++) {
      const sep = baseUrl.includes('?') ? '&' : '?';
      const url = `${baseUrl}${sep}page=${page}&pageNumber=${page}&limit=100&pageSize=100`;
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json', ...authHeaders },
        });
        if (!res.ok) {
          debug.push({ url, status: res.status, keys: [], count: 0, sample: null });
          break;
        }
        const data = await res.json();
        const ids = extractProfileIds(data);
        const keys = (data && typeof data === 'object') ? Object.keys(data).slice(0, 10) : [];
        const sample = Array.isArray(data)
          ? data.slice(0, 1)
          : (data?.profiles?.[0] || data?.items?.[0] || data?.data?.[0] || null);
        debug.push({ url, status: res.status, keys, count: ids.length, sample });
        let newIds = 0;
        for (const profileId of ids) {
          if (seen.has(profileId)) continue;
          seen.add(profileId);
          newIds++;
          results.push({ profileId, liked, source });
        }
        if (newIds === 0) break;
      } catch (error: any) {
        debug.push({ url, status: -1, keys: [], count: 0, sample: String(error?.message || error) });
        break;
      }
    }
  };

  const blockEndpoints = [
    'https://web.grindr.com/api/v3.1/me/blocks',
    'https://web.grindr.com/api/v4/me/blocks',
    'https://web.grindr.com/api/v3/me/blocks',
    'https://web.grindr.com/api/me/blocks',
    'https://web.grindr.com/api/v4/blocks',
    'https://web.grindr.com/api/v3/blocks',
    'https://web.grindr.com/api/blocks',
  ];
  const hideEndpoints = [
    'https://web.grindr.com/api/v3.1/me/hides',
    'https://web.grindr.com/api/v4/me/hides',
    'https://web.grindr.com/api/me/hides',
    'https://web.grindr.com/api/v4/hides',
    'https://web.grindr.com/api/v1/hides',
  ];
  const favoriteEndpoints = [
    'https://web.grindr.com/api/v5/favorites',
    'https://web.grindr.com/api/v4/favorites',
    'https://web.grindr.com/api/favorites',
    'https://web.grindr.com/api/v3/me/favorites',
  ];

  for (const endpoint of blockEndpoints) await paginateEndpoint(endpoint, false, 'block');
  for (const endpoint of hideEndpoints) await paginateEndpoint(endpoint, false, 'hide');
  for (const endpoint of favoriteEndpoints) await paginateEndpoint(endpoint, true, 'favorite');

  console.log('[Aggregaytor:Grindr] Block/hide import debug:', debug);
  console.log('[Aggregaytor:Grindr] Total unique ids captured:', results.length);
  return { results, debug, authSource };
}

/**
 * Fetch full profile records for a batch of profileIds, one at a time with a
 * jittered delay between calls to stay under Grindr's rate limits. Bails the
 * whole batch on the first 401/403 (dead session) so we don't hammer a logged-
 * out endpoint; other per-id errors are recorded and the loop continues.
 *
 * @param batch - profileIds to fetch.
 * @param delayMs - Base delay between requests.
 * @param jitterMs - +/- random jitter added to each delay.
 * @returns `{ noAuth, results }`; `noAuth` is true when no auth header was available (nothing fetched).
 * @throws Never; per-request failures are captured in `results`.
 */
async function fetchGrindrProfiles(
  batch: string[],
  delayMs: number,
  jitterMs: number,
): Promise<{ noAuth: boolean; results: Array<{ id: string; ok: boolean; status: number; data?: unknown; error?: string }> }> {
  const { authHeaders } = resolveGrindrAuthHeaders();
  if (!Object.keys(authHeaders).length) {
    return {
      noAuth: true,
      results: batch.map(id => ({ id, ok: false, status: -1, error: 'no-auth' })),
    };
  }

  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders };
  const results: Array<{ id: string; ok: boolean; status: number; data?: unknown; error?: string }> = [];
  for (const id of batch) {
    try {
      const res = await fetch(`https://web.grindr.com/api/v4/profiles/${id}`, {
        credentials: 'include',
        headers,
      });
      if (res.status === 401 || res.status === 403) {
        let body = '';
        try { body = (await res.text()).slice(0, 200); } catch {}
        results.push({ id, ok: false, status: res.status, error: body });
        break;
      }
      if (!res.ok) {
        results.push({ id, ok: false, status: res.status });
      } else {
        const data = await res.json();
        results.push({ id, ok: true, status: 200, data });
      }
    } catch (error: any) {
      results.push({ id, ok: false, status: 0, error: String(error?.message || error) });
    }
    const jittered = delayMs + (Math.random() * 2 - 1) * jitterMs;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, jittered)));
  }
  return { noAuth: false, results };
}

// Bridge→MAIN request: run the training-data import and reply on the same
// requestId. `requestId` is validated present; a rejected import still replies
// with `ok: false` so the bridge's pending promise never hangs to timeout.
window.addEventListener('__aggregaytor_grindr_import_request', ((event: CustomEvent) => {
  const { requestId } = event.detail || {};
  if (!requestId) return;
  void fetchGrindrTrainingImport()
    .then(payload => sendBridgeResponse(requestId, { ok: true, ...payload }))
    .catch((error: any) => {
      sendBridgeResponse(requestId, {
        ok: false,
        error: String(error?.message || error),
        results: [],
        debug: [],
        authSource: 'none',
      });
    });
}) as EventListener);

// Bridge→MAIN request: fetch a batch of profiles and reply on the same
// requestId. `requestId` is validated present; a rejected fetch still replies
// with `ok: false` so the bridge's pending promise never hangs to timeout.
window.addEventListener('__aggregaytor_grindr_profile_fetch_request', ((event: CustomEvent) => {
  const { requestId, batch = [], delayMs = 0, jitterMs = 0 } = event.detail || {};
  if (!requestId) return;
  void fetchGrindrProfiles(batch, delayMs, jitterMs)
    .then(payload => sendBridgeResponse(requestId, { ok: true, ...payload }))
    .catch((error: any) => {
      sendBridgeResponse(requestId, {
        ok: false,
        error: String(error?.message || error),
        noAuth: false,
        results: [],
      });
    });
}) as EventListener);

const adapter = new GrindrAdapter({ platform: 'grindr' });

// Relay parsed messages to the bridge and opportunistically index
// conversationId→profileId from message metadata for middle-click block lookup.
adapter.on('messages', (event) => {
  console.log(`${LOG} Messages captured:`, (event.payload as any[]).length);
  // Index profileIds from message metadata for middle-click block lookup
  for (const m of event.payload as any[]) {
    if (m.metadata?.profileId && m.metadata?.conversationId) {
      cappedHashSet(m.metadata.conversationId, m.metadata.profileId);
    }
  }
  sendToBridge({
    type: 'ADAPTER_MESSAGES',
    platform: 'grindr',
    payload: event.payload,
  });
});

// Relay parsed contacts to the bridge and index avatar photo-hash→profileId
// pairs for middle-click block lookup.
adapter.on('contacts', (event) => {
  console.log(`${LOG} Contacts captured:`, (event.payload as any[]).length);
  // Index photo hashes for middle-click profile ID lookup
  for (const c of event.payload as any[]) {
    if (c.avatarUrl && c.platformUserId) {
      const hashMatch = c.avatarUrl.match(/\/([a-f0-9]{32,})/i);
      if (hashMatch) cappedHashSet(hashMatch[1], c.platformUserId);
    }
  }
  sendToBridge({
    type: 'ADAPTER_CONTACTS',
    platform: 'grindr',
    payload: event.payload,
  });
});

adapter.init().then(() => {
  console.log(`${LOG} Adapter initialized`);
}).catch((err) => {
  console.error(`${LOG} Adapter init failed:`, err);
});

// Text expander — type "hg " to expand to "Hey there. How's it going?"
initTextExpander();

// Grindr cascade filters — hide/show profiles by ethnicity, gender, keywords
initGrindrFilters();

// ── Proactive Profile Indexing ──────────────────────────────────────────────
// Intercept ALL fetch responses on grindr.com to build the photoHash→profileId
// map. This catches cascade API responses, profile fetches, and any other
// endpoint that returns profile data with mediaHash fields.
const origFetch = window.fetch;
window.fetch = async function(this: unknown, ...args: Parameters<typeof fetch>) {
  const res = await origFetch.apply(this as typeof globalThis, args);
  try {
    const url = String((args[0] as any)?.url || args[0] || '');
    if (!url.includes('grindr.com')) return res;
    const ct = String(res.headers?.get('content-type') || '');
    if (!ct.includes('json')) return res;
    const clone = res.clone();
    clone.json().then((data: any) => {
      // Walk the response for profile objects with profileId + medias/photoHash
      const walk = (obj: any, depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > 5) return;
        if (Array.isArray(obj)) { obj.slice(0, 50).forEach(item => walk(item, depth + 1)); return; }
        indexProfileFromPayload(obj);
        // Also index for Grindr cascade filters (ethnicity, gender, etc.)
        indexGrindrProfile(obj);
        for (const v of Object.values(obj)) {
          if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(data);
    }).catch(() => {});
  } catch {}
  return res;
} as typeof fetch;

// ── Block by Photo Hash Handler ──────────────────────────────────────────────
// When the bridge can't find a profile ID directly in the DOM (most common
// on the cascade grid), it sends the photo hash from the img src. We look it
// up in our photoHash→profileId map and trigger the block.
window.addEventListener('__aggregaytor_block_by_hash', (async (event: CustomEvent) => {
  const { photoHash } = event.detail || {};
  // Forgeable event: a non-string payload would blow up on `.slice()` below.
  if (!photoHash || typeof photoHash !== 'string') return;

  let profileId = lookupProfileId(photoHash);

  // Fallback: scan visible grid images for a /chat/ link near the matching img
  if (!profileId) {
    const adapterMapSize = (window as any).__grindr_hash_map?.size || 0;
    console.log(`${LOG} Hash ${photoHash.slice(0, 12)} not in maps (adapter: ${adapterMapSize}, local: ${photoHashToProfileId.size}), scanning DOM...`);

    const allImages = document.querySelectorAll('img[src*="cdns.grindr.com"]');
    for (const img of allImages) {
      const src = (img as HTMLImageElement).src;
      if (src.includes(photoHash)) {
        // Tile resolution delegates to @aggregaytor/grindr-lib's bounded
        // resolver first; the legacy .closest() selector stays as a fallback.
        const card = dom.resolveCascadeTile(img)
          || (img as HTMLElement).closest('[data-testid="cascadeCellContainer"]');
        if (card) {
          const link = card.querySelector('a[href*="/chat/"]');
          const href = link?.getAttribute('href') || '';
          const match = href.match(/\/chat\/(\d+)/);
          if (match) {
            profileId = match[1];
            cappedHashSet(photoHash, profileId);
            break;
          }
        }
      }
    }
  }

  if (!profileId) {
    console.warn(`${LOG} Could not resolve hash ${photoHash.slice(0, 12)} to profileId`);
    return;
  }

  console.log(`${LOG} Resolved hash → profileId: ${profileId}`);
  window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
    detail: { profileId },
  }));
}) as unknown as EventListener);

// ── Block by React Fiber Lookup ──────────────────────────────────────────────
// Fallback path for profile cells with no picture, no /chat/ link, no data
// attributes — Grindr still has the profileId in the React component's props.
// The ISOLATED bridge tagged the clicked element with data-aggregaytor-
// fiber-lookup="<marker>"; we find that element and walk its React fiber
// tree to extract the profileId from memoizedProps / pendingProps.
// Markers are minted by the bridge as `fiber-lookup-<epochMs>-<base36>`. The
// event is forgeable, and the marker goes straight into a querySelector — a
// value containing a quote or bracket throws a DOMException. Validate shape.
const FIBER_MARKER_RE = /^fiber-lookup-\d+-[a-z0-9]+$/;

window.addEventListener('__aggregaytor_block_by_fiber', ((event: CustomEvent) => {
  const { marker } = event.detail || {};
  if (!marker || typeof marker !== 'string' || !FIBER_MARKER_RE.test(marker)) return;
  const el = document.querySelector(`[data-aggregaytor-fiber-lookup="${marker}"]`) as HTMLElement | null;
  if (!el) {
    console.warn(`${LOG} Fiber lookup: marker element not found`);
    return;
  }

  // React attaches fiber references as __reactFiber$<hash> and props as
  // __reactProps$<hash>. We walk up the fiber's .return chain, inspecting
  // memoizedProps / stateNode on each ancestor until we find a numeric id.
  /**
   * Walk the React fiber tree upward from `startEl` and pull the first 7+ digit
   * numeric profileId out of common Grindr prop shapes. Bounded to 30 ancestors.
   * @returns The profileId, or `''` if the element has no fiber or none is found.
   */
  const findProfileIdInFiber = (startEl: HTMLElement): string => {
    const anyEl: any = startEl;
    const keys = Object.keys(anyEl).filter(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!keys.length) {
      console.warn(`${LOG} Fiber lookup: element has no React fiber attached`);
      return '';
    }
    let fiber: any = anyEl[keys[0]];
    let depth = 0;
    while (fiber && depth < 30) {
      const candidates = [fiber.memoizedProps, fiber.pendingProps, fiber.stateNode?.props, fiber.stateNode?.state];
      for (const props of candidates) {
        if (!props || typeof props !== 'object') continue;
        // Common Grindr prop shapes: { profileId }, { profile: { profileId } },
        // { item: { profileId } }, { data: { profileId } }, { id }.
        const checks = [
          props.profileId,
          props.profile?.profileId,
          props.profile?.id,
          props.item?.profileId,
          props.item?.id,
          props.data?.profileId,
          props.data?.id,
          props.user?.profileId,
          props.user?.id,
          props.id,
        ];
        for (const v of checks) {
          const s = String(v || '');
          if (/^\d{7,}$/.test(s)) return s;
        }
      }
      fiber = fiber.return;
      depth++;
    }
    return '';
  };

  // Try @aggregaytor/grindr-lib's resolver first (URL peer, bounded strict
  // attribute scan, photo-hash index); the React-fiber walk stays as the
  // fallback — the lib has no fiber path.
  let profileId = dom.resolveProfileIdFromElement(el, {
    hashIndex: { get: (h: string) => lookupProfileId(h) },
  });
  if (!profileId) profileId = findProfileIdInFiber(el);
  if (!profileId) {
    console.warn(`${LOG} Fiber lookup: no profile id found in React tree`);
    return;
  }

  console.log(`${LOG} Fiber lookup: resolved to profileId ${profileId}`);
  window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
    detail: { profileId },
  }));
}) as EventListener);

// ── Rate-Limited Block/Hide Queue ──────────────────────────────────────────
// Grindr rate-limits block/hide calls. If you burst too many in a short
// window, Grindr invalidates your session and forces a re-login. We avoid
// that by:
//   1. Queueing all block requests and releasing one every MIN_INTERVAL_MS
//   2. Backing off exponentially on 429 / 401 / 403 responses
//   3. Pausing the queue entirely when we detect a dead session, and
//      resuming once a fresh API call succeeds (session recovered) or the
//      user re-logs in manually.
//
// For users who just want to hide profiles locally without ever calling the
// Grindr API (zero rate-limit risk), the localOnlyHide mode routes all
// block actions to the PROFILE_BLOCKED storage path only — nothing goes
// over the wire to Grindr.

const BLOCK_QUEUE_KEY = 'aggregaytor_grindr_block_settings';
interface BlockSettings {
  localOnlyHide: boolean;      // never call Grindr API, just store locally
  minIntervalMs: number;       // gap between successful calls
  maxPerHour: number;          // hard cap per rolling hour
}
const defaultBlockSettings: BlockSettings = {
  localOnlyHide: false,
  minIntervalMs: 4000,         // 4s between calls is safely under Grindr's limit
  maxPerHour: 200,             // hard cap; real limit is unknown, this is conservative
};

// Hard bounds for the rate-limit knobs. Anything outside these is either a
// corrupt localStorage value or a forged `__aggregaytor_grindr_block_settings`
// event from a page script — both of which previously landed straight in
// `setTimeout(r, blockSettings.minIntervalMs)`. `NaN`/0/negative there means
// "no gap at all", which bursts the block API and gets the user force-logged
// out: exactly the failure this whole queue exists to prevent.
const MIN_INTERVAL_FLOOR_MS = 500;
const MIN_INTERVAL_CEIL_MS = 600_000;
const MAX_PER_HOUR_FLOOR = 1;
const MAX_PER_HOUR_CEIL = 2000;

/**
 * Coerce an untrusted value to a finite number clamped to `[lo, hi]`, or return
 * `fallback` if it isn't a finite number. Pure — used to sanitize forgeable /
 * corrupt rate-limit settings before they reach `setTimeout`.
 */
function clampNumber(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Coerce an arbitrary (possibly hostile) object into a valid BlockSettings. */
function sanitizeBlockSettings(raw: unknown): BlockSettings {
  const src = (raw && typeof raw === 'object') ? raw as Partial<BlockSettings> : {};
  return {
    localOnlyHide: !!src.localOnlyHide,
    minIntervalMs: clampNumber(
      src.minIntervalMs, defaultBlockSettings.minIntervalMs, MIN_INTERVAL_FLOOR_MS, MIN_INTERVAL_CEIL_MS),
    maxPerHour: clampNumber(
      src.maxPerHour, defaultBlockSettings.maxPerHour, MAX_PER_HOUR_FLOOR, MAX_PER_HOUR_CEIL),
  };
}

let blockSettings: BlockSettings = { ...defaultBlockSettings };
try {
  const raw = localStorage.getItem(BLOCK_QUEUE_KEY);
  if (raw) blockSettings = sanitizeBlockSettings({ ...blockSettings, ...JSON.parse(raw) });
} catch {}

const blockQueue: string[] = [];
const blockQueueSet = new Set<string>();
let blockSessionDead = false;
let blockBackoffUntil = 0;
let queueProcessing = false;

// Pacing + the rolling hourly cap now delegate to @aggregaytor/grindr-lib's
// limiter (replaces the hand-rolled recentBlockTimestamps window). Rebuilt
// whenever block settings change.
let blockLimiter = grindr.limiterFactory({
  minIntervalMs: blockSettings.minIntervalMs,
  maxPerHour: blockSettings.maxPerHour,
});

/**
 * Show a transient status toast bottom-right (block-queue feedback: rate limits,
 * forced re-login, auth capture). `text` is set via `textContent` (not innerHTML)
 * so it is not an injection sink. The whole body is wrapped so a DOM failure
 * (e.g. no `document.body` yet) can never break the caller's queue logic.
 *
 * @param text - Message to display.
 * @param kind - Visual severity: `'ok' | 'warn' | 'err'` (default `'warn'`).
 */
function showGrindrToast(text: string, kind: 'ok' | 'warn' | 'err' = 'warn'): void {
  try {
    const ID = 'aggregaytor-grindr-toast';
    document.getElementById(ID)?.remove();
    const toast = document.createElement('div');
    toast.id = ID;
    const bg = kind === 'ok' ? 'rgba(34,197,94,0.95)'
      : kind === 'err' ? 'rgba(220,38,38,0.95)'
      : 'rgba(234,179,8,0.95)';
    toast.style.cssText =
      `position:fixed;bottom:20px;right:20px;z-index:999999;max-width:340px;` +
      `background:${bg};color:#fff;padding:10px 14px;border-radius:8px;` +
      `font-family:system-ui,sans-serif;font-size:12px;line-height:1.4;` +
      `box-shadow:0 4px 12px rgba(0,0,0,0.4);transition:opacity 0.3s`;
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, 4500);
    setTimeout(() => toast.remove(), 5000);
  } catch {}
}

// Hashes are interpolated into an attribute-substring selector below, so
// anything containing a quote/bracket would throw a DOMException and abort
// the whole cleanup pass. Map keys include conversationIds from API payloads,
// which are not guaranteed to be hex — filter to a selector-safe charset.
const SELECTOR_SAFE_HASH = /^[A-Za-z0-9._~-]+$/;

/**
 * After a successful block/hide, fade out and hide the corresponding cascade
 * card(s) for `profileId`. Resolves cards via the reverse of the hash map,
 * filtering hashes to a selector-safe charset ({@link SELECTOR_SAFE_HASH}) so a
 * non-hex conversationId key can't throw a DOMException in the attribute
 * selector. Purely cosmetic — never calls the network.
 *
 * @param profileId - The blocked profileId whose visible cards should disappear.
 */
function removeBlockedCardFromDom(profileId: string): void {
  setTimeout(() => {
    const targetHashes: string[] = [];
    for (const [hash, pid] of photoHashToProfileId.entries()) {
      if (pid === profileId && SELECTOR_SAFE_HASH.test(hash)) targetHashes.push(hash);
    }
    if (!targetHashes.length) return;
    let found = false;
    for (const hash of targetHashes) {
      document.querySelectorAll(`img[src*="${hash}"]`).forEach(img => {
        // Tile resolution delegates to @aggregaytor/grindr-lib's bounded
        // resolver first; the legacy .closest() selectors stay as a fallback.
        const card = dom.resolveCascadeTile(img)
          || (img as HTMLElement).closest(
            '[data-testid="cascadeCellContainer"], [class*="cascade-cell"], [class*="profile-card"]'
          );
        if (card && !found) {
          found = true;
          (card as HTMLElement).style.transition = 'opacity 0.3s';
          (card as HTMLElement).style.opacity = '0';
          setTimeout(() => { (card as HTMLElement).style.display = 'none'; }, 300);
        }
      });
      if (found) break;
    }
  }, 300);
}

/**
 * Drain the block/hide queue one profileId at a time through the
 * @aggregaytor/grindr-lib limiter (pacing + hourly cap), honoring the backoff
 * window and the session-dead flag. Handles the outcome of each hide call as a
 * state transition: 401/403 → mark session dead, re-enqueue, watch for the login
 * form, and stop; 429 → 30s backoff and retry; other errors → drop the id. A
 * successful call after a dead flag clears it (canary recovery). Re-entrant-safe
 * via `queueProcessing`. All branches log via {@link LOG}.
 *
 * @throws Never; hide failures are classified and handled inline.
 */
async function processBlockQueue(): Promise<void> {
  if (queueProcessing) return;
  queueProcessing = true;
  try {
    while (blockQueue.length) {
      // Respect backoff window
      const waitMs = Math.max(0, blockBackoffUntil - Date.now());
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

      // Session dead? We used to hard-break here, which meant any single
      // stale 401 (e.g. from a mid-run enrichment pass) permanently paused
      // middle-click blocking until the user saved credentials and got
      // auto-logged back in. That was a footgun — often the session
      // wasn't actually dead and a retry would have worked. Now: try once
      // more with fresh auth; if it works, clear the flag and carry on.
      if (blockSessionDead) {
        console.log(`${LOG} Session-dead flag set; trying one canary call to see if it's actually dead.`);
        // Fall through into the normal call path below — if it 401s again
        // the dead flag stays set and we'll break; if it works, the ok
        // branch clears it.
      }

      const profileId = blockQueue.shift()!;

      // Auth capture now delegates to @aggregaytor/grindr-lib's observer
      // (grindr.auth). If it hasn't seen a Grindr3 header yet, don't drop
      // the click — re-enqueue and poll once per second for up to 60s.
      if (!grindr.auth.isReady()) {
        blockQueue.unshift(profileId);
        console.warn(`${LOG} No captured auth yet — waiting for page to issue an API call. ${blockQueue.length} queued.`);
        showGrindrToast('Capturing Grindr auth… (scroll the cascade)', 'warn');
        // Poll for up to 60s
        let waited = 0;
        while (waited < 60_000 && !grindr.auth.isReady()) {
          await new Promise(r => setTimeout(r, 1000));
          waited += 1000;
        }
        if (!grindr.auth.isReady()) {
          console.warn(`${LOG} Gave up after 60s of no auth capture; queue retained for next time.`);
          break;
        }
        continue; // loop around and try again with fresh auth
      }

      try {
        // Delegates to @aggregaytor/grindr-lib: the limiter owns pacing + the
        // hourly cap, and blocks.hide is hide-ONLY. The old "hide, then fall
        // back to block" chain is intentionally gone — hide and block are
        // mutually exclusive server-side, so a block after a hide UNDID the
        // hide (documented lib behavior change).
        await blockLimiter.run(() => grindr.blocks.hide(profileId));
        blockQueueSet.delete(profileId);
        console.log(`${LOG} Hide ok for ${profileId}`);
        sendToBridge({ type: 'PROFILE_BLOCKED', contactId: `grindr:${profileId}`, platform: 'grindr' });
        removeBlockedCardFromDom(profileId);
        if (blockSessionDead) {
          console.log(`${LOG} Canary succeeded — clearing session-dead flag.`);
          blockSessionDead = false;
          blockBackoffUntil = 0;
        }
      } catch (err: any) {
        const status = Number(err?.status || 0);
        if (status === 401 || status === 403) {
          blockSessionDead = true;
          blockQueue.unshift(profileId);
          console.warn(`${LOG} Session dead (${status}). ${blockQueue.length} pending.`);
          showGrindrToast(
            `Grindr forced a re-login (${status}). ${blockQueue.length} block(s) paused until you're logged back in.`,
            'err',
          );
          watchForLoginForm();
          break;
        } else if (status === 429) {
          blockQueue.unshift(profileId);
          blockBackoffUntil = Date.now() + 30_000;
          console.warn(`${LOG} 429 rate limited — backing off 30s`);
          showGrindrToast('Grindr rate-limited. Backing off 30s…', 'warn');
        } else {
          blockQueueSet.delete(profileId);
          console.warn(`${LOG} Block failed (${status || err?.code || err}) for ${profileId} — dropping`);
        }
      }
    }
  } finally {
    queueProcessing = false;
  }
}

/**
 * Add a profileId to the block/hide queue (deduped via `blockQueueSet`) and kick
 * the drain loop. No-ops if already queued.
 */
function enqueueBlock(profileId: string): void {
  if (blockQueueSet.has(profileId)) return;
  blockQueueSet.add(profileId);
  blockQueue.push(profileId);
  processBlockQueue();
}

window.addEventListener('__aggregaytor_block_profile', ((event: CustomEvent) => {
  const { profileId } = event.detail || {};
  if (!profileId) return;

  // Local-only mode: never touch Grindr's API. Just mark the profile blocked
  // in our storage and hide the card visually. Zero rate-limit risk.
  if (blockSettings.localOnlyHide) {
    console.log(`${LOG} Local-only hide for ${profileId}`);
    sendToBridge({ type: 'PROFILE_BLOCKED', contactId: `grindr:${profileId}`, platform: 'grindr' });
    removeBlockedCardFromDom(profileId);
    return;
  }

  enqueueBlock(profileId);
}) as EventListener);

// Manual recovery hook — from DevTools console on the Grindr tab:
//   __aggregaytor_grindr_reset_queue()
// Use when you KNOW you're logged in but the queue got wedged thinking
// the session was dead. Clears all gating state and re-kicks processing.
(window as any).__aggregaytor_grindr_reset_queue = function(): void {
  console.log(`${LOG} Manual reset: clearing session-dead flag & backoff. ${blockQueue.length} queued.`);
  blockSessionDead = false;
  blockBackoffUntil = 0;
  processBlockQueue();
};

// Expose a settings-update hook so the side panel / settings UI can flip
// localOnlyHide and the rate-limit parameters at runtime.
window.addEventListener('__aggregaytor_grindr_block_settings', ((event: CustomEvent) => {
  const update = (event.detail && typeof event.detail === 'object') ? event.detail : {};
  // Sanitized because this event is dispatched on `window` and is therefore
  // forgeable by any script on the page, not just our own bridge.
  blockSettings = sanitizeBlockSettings({ ...blockSettings, ...update });
  // Rebuild the @aggregaytor/grindr-lib limiter so the new pacing settings
  // take effect (the limiter owns min-interval + hourly-cap enforcement).
  blockLimiter = grindr.limiterFactory({
    minIntervalMs: blockSettings.minIntervalMs,
    maxPerHour: blockSettings.maxPerHour,
  });
  try { localStorage.setItem(BLOCK_QUEUE_KEY, JSON.stringify(blockSettings)); } catch {}
  console.log(`${LOG} Block settings updated:`, blockSettings);
}) as EventListener);

// ── Grindr Login Form Detection + Auto-Fill ────────────────────────────────
// When Grindr forces a re-login (either from inactivity or from too many
// block calls), we want to help the user get back in without them having
// to remember to re-type creds. This watcher looks for the login form
// markers, and if the user has opted in to auto-login (via settings), fills
// in the fields from stored credentials and clicks submit.
//
// Credentials are stored by the side panel in chrome.storage.local under
// aggregaytor_grindr_credentials, encrypted with the user's passphrase.
// We ask the service worker to decrypt them on demand — raw creds never
// live in content-script memory except during the brief fill operation.

let loginWatchObserver: MutationObserver | null = null;
let loginFillInFlight = false;

/**
 * Heuristically decide whether the page is currently Grindr's login screen,
 * used to gate auto-fill and to detect successful re-login. Checks the URL path
 * and the presence of a rendered email/username + password field pair.
 *
 * @returns `true` if a login form appears to be present.
 */
function isLoginScreen(): boolean {
  // Grindr's login page varies. Check several markers.
  if (/\/login|\/signin|\/auth/i.test(location.pathname)) return true;
  const emailEl = document.querySelector(
    'input[type="email"], input[name="email"], input[id*="email" i], ' +
    'input[autocomplete="email"], input[autocomplete="username"], ' +
    'input[placeholder*="email" i], input[name="username"], input[id*="username" i]',
  );
  const pwEl = document.querySelector('input[type="password"]');
  return !!(emailEl && pwEl && document.body?.contains(emailEl) && document.body?.contains(pwEl));
}

/**
 * If the user opted into auto-login, ask the service worker to decrypt the
 * stored Grindr credentials and fill+submit the login form, then optimistically
 * resume the paused block queue once login appears to succeed.
 *
 * WHY: Grindr force-logs-out on inactivity or block bursts; this saves the user
 * re-typing. Raw credentials only ever live in this closure for the brief fill.
 * Re-entrancy is guarded by `loginFillInFlight`; the whole body is try/finally
 * so the flag is always cleared and a decrypt/DOM error is logged, not thrown.
 */
async function attemptAutoFill(): Promise<void> {
  if (loginFillInFlight) return;
  loginFillInFlight = true;
  try {
    // Ask the service worker for decrypted credentials (returns null if
    // user hasn't enabled auto-login or if decryption fails).
    const response: any = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_GRINDR_CREDENTIALS' }, (r: any) => resolve(r || null));
      } catch { resolve(null); }
    });
    const creds = response?.credentials;
    if (!creds?.username || !creds?.password) {
      console.log(`${LOG} Auto-login: no stored credentials`);
      showGrindrToast('Grindr logged you out. Save credentials in Settings → Sync to auto-login next time.', 'warn');
      return;
    }

    // Find the fields
    const emailEl = document.querySelector<HTMLInputElement>(
      'input[type="email"], input[name="email"], input[id*="email" i], ' +
      'input[autocomplete="email"], input[autocomplete="username"], ' +
      'input[name="username"]',
    );
    const pwEl = document.querySelector<HTMLInputElement>('input[type="password"]');
    if (!emailEl || !pwEl) return;

    // Fill using native value setters (React compatibility)
    const setVal = (el: HTMLInputElement, v: string) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    emailEl.focus(); setVal(emailEl, creds.username);
    pwEl.focus(); setVal(pwEl, creds.password);
    console.log(`${LOG} Auto-login fields filled`);
    showGrindrToast('Auto-filled Grindr login — submitting…', 'ok');

    // Find and click submit
    await new Promise(r => setTimeout(r, 400));
    const submit = pwEl.closest('form')?.querySelector<HTMLButtonElement>('button[type="submit"], button')
      || document.querySelector<HTMLButtonElement>('button[type="submit"]')
      || Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find(b => /sign ?in|log ?in|continue/i.test(b.textContent || ''))
      || null;
    if (submit && !submit.disabled) {
      submit.click();
      console.log(`${LOG} Auto-login submitted`);
    } else {
      // Fallback: Enter key on password field
      pwEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }

    // After a successful login, the session is revived. Clear the dead flag
    // so queued blocks resume. We optimistically clear after 8s; if auth is
    // still missing then, the next block call will detect it.
    setTimeout(() => {
      if (!isLoginScreen()) {
        console.log(`${LOG} Login appears successful — resuming block queue`);
        blockSessionDead = false;
        blockBackoffUntil = 0;
        processBlockQueue();
      }
    }, 8000);
  } catch (err) {
    console.warn(`${LOG} Auto-login error:`, err);
  } finally {
    loginFillInFlight = false;
  }
}

let loginWatchTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Watch the DOM for Grindr's login form appearing and trigger {@link attemptAutoFill}.
 *
 * WHY: injected at `document_start`, so `document.body` may be null on first
 * call — observing a null root throws and (running at module top level) would
 * abort the rest of the module, so we defer to `DOMContentLoaded` instead. The
 * observer self-disconnects after 30s and re-arms 60s after a detected login to
 * bound its lifetime. Idempotent while an observer is already active.
 */
function watchForLoginForm(): void {
  if (loginWatchObserver) return;
  if (isLoginScreen()) { attemptAutoFill(); return; }
  // This script is injected at document_start, so <body> can still be null on
  // the first call. `observe(null)` throws a TypeError, and because this
  // function runs at module top level that exception used to abort the rest of
  // the module — the auto-send listener and the timestamp GC interval below
  // never got registered. Wait for the body instead.
  const root = document.body;
  if (!root) {
    document.addEventListener('DOMContentLoaded', () => watchForLoginForm(), { once: true });
    return;
  }
  loginWatchObserver = new MutationObserver(() => {
    if (isLoginScreen()) {
      loginWatchObserver?.disconnect();
      loginWatchObserver = null;
      if (loginWatchTimeout) { clearTimeout(loginWatchTimeout); loginWatchTimeout = null; }
      attemptAutoFill();
      setTimeout(() => watchForLoginForm(), 60_000);
    }
  });
  loginWatchObserver.observe(root, { childList: true, subtree: true });
  loginWatchTimeout = setTimeout(() => {
    if (loginWatchObserver) {
      loginWatchObserver.disconnect();
      loginWatchObserver = null;
    }
    loginWatchTimeout = null;
  }, 30_000);
}

watchForLoginForm();

// Auto-send handler — delegates to @aggregaytor/grindr-lib's compose.greet:
// fills via the native React value setter, clicks an anchored Send button
// (never "send location"/the wrong drawer), and polls for the composer to
// clear as WS send confirmation.
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  console.log(`${LOG} Auto-sending:`, text.slice(0, 30));
  void compose.greet(text).then((ok: boolean) => {
    if (!ok) console.warn(`${LOG} auto-send: composer did not clear`);
  });
}) as EventListener);
