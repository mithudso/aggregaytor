// Sniffies HTTP client: the two profile endpoints the site exposes to a same-browser caller.
// Auth is cookies only (`credentials: "include"`) — no token header exists; a library caller
// inherits the logged-in browser session and cannot authenticate outside the browser.
import { SniffiesError, SniffiesAllBasesError, SniffiesTimeoutError } from './errors.js';

export const DEFAULT_PARTIALS_BASES = [
  'https://usw.api.sniffies.com/api/user/partials',
  'https://uswapi2.sniffies.com/api/user/partials',
];
export const DEFAULT_FULL_ORIGINS = [
  'https://usw.api.sniffies.com',
  'https://uswapi2.sniffies.com',
  'https://uswapi.sniffies.com',
];
// The accepted partials body key is not pinned down server-side; the shape is probed in this
// order and the first that returns a JSON array should be remembered by the caller.
export const PARTIALS_BODY_SHAPES = ['userIds', 'profileIds', 'ids', 'array'];
export const PARTIALS_BATCH_SIZE = 50;
export const FETCH_TIMEOUT_MS = 15_000;

const buildBody = (shape, ids) => (shape === 'array' ? ids : { [shape]: ids });

/** fetch() with an AbortController timeout; composes with a caller-supplied signal. */
export async function fetchWithTimeout(input, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = opts.signal && typeof AbortSignal !== 'undefined' && AbortSignal.any
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  try {
    return await fetch(input, { ...opts, signal });
  } catch (e) {
    if (controller.signal.aborted && !(opts.signal && opts.signal.aborted)) {
      throw new SniffiesTimeoutError(String(input), timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Presence: `lastActive = min(now, max(connectUpdateTime, disconnectTime))` — connectUpdateTime
 * advances while connected, disconnectTime is stamped on drop; a future value is clamped so a
 * server "valid until" timestamp can't read as currently-online.
 * @param {{connectUpdateTime?:any, disconnectTime?:any}} row (or row.data)
 * @param {number} [nowMs]
 * @returns {number} epoch ms, or 0 when neither field parses
 */
export function computeLastActiveTs(row, nowMs = Date.now()) {
  const src = (row && typeof row === 'object' && row.data && typeof row.data === 'object') ? row.data : row;
  const t = (v) => {
    const n = new Date(v).getTime();
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  if (!src || typeof src !== 'object') return 0;
  const best = Math.max(t(src.connectUpdateTime), t(src.disconnectTime));
  return best ? Math.min(best, nowMs) : 0;
}

/**
 * Attitude from a partials row: `row.data.profile.extended.sexuality.attitude`. Distinguishes
 * "absent" (return undefined) from an explicit null via hasOwnProperty.
 * @returns {string|null|undefined}
 */
export function extractAttitudeFromPartial(row) {
  const sex = row && row.data && row.data.profile && row.data.profile.extended
    && row.data.profile.extended.sexuality;
  if (!sex || typeof sex !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(sex, 'attitude')) return undefined;
  const v = sex.attitude;
  return v == null ? null : String(v);
}

/**
 * Build an API client. `remember` persists learned base/shape (e.g. into localStorage) and
 * `recall` restores them; both optional. `limiter` (see createLimiter) gates every request.
 * @param {{bases?:string[], fullOrigins?:string[], limiter?:{run:(fn:()=>Promise<any>)=>Promise<any>, reportRejection?:()=>void},
 *          remember?:(k:string,v:string)=>void, recall?:(k:string)=>string|null,
 *          fetchImpl?:typeof fetch, timeoutMs?:number}} [opts]
 */
export function createApi({
  bases = DEFAULT_PARTIALS_BASES,
  fullOrigins = DEFAULT_FULL_ORIGINS,
  limiter = null,
  remember = () => {},
  recall = () => null,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  let preferredBase = recall('partialsBase') || '';
  let preferredShape = recall('partialsShape') || '';
  let preferredFullOrigin = recall('fullOrigin') || '';

  const gate = (fn) => (limiter ? limiter.run(fn) : fn());
  const rejected = (status) => {
    if ((status === 429 || status === 403) && limiter && limiter.reportRejection) limiter.reportRejection();
  };

  const post = async (url, body) => fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  }, timeoutMs);

  /**
   * Fetch partial profile rows for up to 50 ids, probing bases × body shapes until one returns
   * a JSON array. Remembers the winning base + shape for next time.
   * @param {string[]} ids
   * @returns {Promise<Array<object>>} rows (each with `_id`, `data.*`); [] when every probe failed
   */
  const getPartials = (ids) => gate(async () => {
    const list = (ids || []).map(String).filter(Boolean).slice(0, PARTIALS_BATCH_SIZE);
    if (!list.length) return [];
    const baseOrder = preferredBase ? [preferredBase, ...bases.filter((b) => b !== preferredBase)] : bases;
    const shapeOrder = preferredShape
      ? [preferredShape, ...PARTIALS_BODY_SHAPES.filter((s) => s !== preferredShape)]
      : PARTIALS_BODY_SHAPES;
    const attempts = [];
    for (const base of baseOrder) {
      for (const shape of shapeOrder) {
        try {
          const res = await post(base, buildBody(shape, list));
          if (!res.ok) {
            rejected(res.status);
            attempts.push({ base, error: new SniffiesError(`HTTP ${res.status}`, { status: res.status, path: base }) });
            if (res.status === 401 || res.status === 403 || res.status === 429) {
              throw new SniffiesError(`Partials rejected with ${res.status}`, { status: res.status, path: base });
            }
            continue;
          }
          const data = await res.json();
          if (Array.isArray(data)) {
            preferredBase = base;
            preferredShape = shape;
            remember('partialsBase', base);
            remember('partialsShape', shape);
            try { remember('fullOrigin', new URL(base).origin); } catch (_e) {}
            return data;
          }
        } catch (e) {
          if (e instanceof SniffiesError && e.status) throw e;
          attempts.push({ base, error: e });
        }
      }
    }
    throw new SniffiesAllBasesError('/api/user/partials', attempts);
  });

  /**
   * Fetch one full profile: POST {origin}/api/user/full with {userId}. One profile per call, by
   * design — spread across the shared request budget.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  const getFullUser = (id) => gate(async () => {
    const userId = String(id || '');
    if (!userId) return null;
    const order = [preferredFullOrigin, ...fullOrigins].filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    const attempts = [];
    for (const origin of order) {
      try {
        const res = await post(`${origin}/api/user/full`, { userId });
        if (!res.ok) {
          rejected(res.status);
          attempts.push({ base: origin, error: new SniffiesError(`HTTP ${res.status}`, { status: res.status }) });
          if (res.status === 401 || res.status === 403 || res.status === 429) {
            throw new SniffiesError(`Full-user rejected with ${res.status}`, { status: res.status, path: `${origin}/api/user/full` });
          }
          continue;
        }
        const data = await res.json();
        if (data && typeof data === 'object') {
          preferredFullOrigin = origin;
          remember('fullOrigin', origin);
          return data;
        }
      } catch (e) {
        if (e instanceof SniffiesError && e.status) throw e;
        attempts.push({ base: origin, error: e });
      }
    }
    throw new SniffiesAllBasesError('/api/user/full', attempts);
  });

  return {
    getPartials,
    getFullUser,
    computeLastActiveTs,
    extractAttitudeFromPartial,
    get preferredBase() { return preferredBase; },
    get preferredShape() { return preferredShape; },
    get preferredFullOrigin() { return preferredFullOrigin; },
  };
}
