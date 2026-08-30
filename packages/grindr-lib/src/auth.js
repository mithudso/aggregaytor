import { GrindrError, GrindrAuthError, parseErrorCode } from './errors.js';

/**
 * Create a credential store + authed request function. Every authed call sends
 * `Authorization: Grindr3 <JWT>`, `country-code`, and `l-locale` — omitting the
 * latter two returns 501.
 * @param {{token?:string, countryCode?:string, locale?:string, base?:string}} [config]
 */
export function createAuth(config = {}) {
  const state = {
    token: config.token || '',
    countryCode: config.countryCode || '',
    locale: config.locale || '',
    base: (config.base || 'https://web.grindr.com').replace(/\/+$/, ''),
  };
  const isReady = () => !!state.token;
  /**
   * Update credentials. For token/countryCode/locale, `''` clears and
   * null/undefined leaves the field untouched. A blank `base` is ignored (it
   * would otherwise turn every request into a relative URL).
   */
  const set = (cfg = {}) => {
    if (cfg.token != null) state.token = String(cfg.token || '');
    if (cfg.countryCode != null) state.countryCode = String(cfg.countryCode || '');
    if (cfg.locale != null) state.locale = String(cfg.locale || '');
    if (cfg.base != null) { const b = String(cfg.base).replace(/\/+$/, ''); if (b) state.base = b; }
    return isReady();
  };
  const clear = () => { state.token = ''; };
  const headers = (extra) => {
    if (!isReady()) throw new GrindrAuthError();
    return {
      'Authorization': `Grindr3 ${state.token}`,
      'country-code': state.countryCode,
      'l-locale': state.locale,
      'Content-Type': 'application/json',
      ...(extra || {}),
    };
  };
  const enc = (id) => encodeURIComponent(String(id == null ? '' : id));
  /** enc(), but throws if the id is empty — an empty id would collapse a path
   * onto its collection root (e.g. an authed POST to /me/hides/). */
  const encId = (id) => {
    const s = String(id == null ? '' : id).trim();
    if (!s) throw new GrindrError('a resource id is required', { status: 0, code: 'bad-id' });
    return encodeURIComponent(s);
  };

  /**
   * Perform an authed request. Throws GrindrAuthError when creds are unset and
   * GrindrError on transport failure, an unreadable body, or a non-2xx response.
   * @param {string} path path beginning with `/`
   * @param {{method?:string, body?:any, signal?:AbortSignal, timeoutMs?:number}} [opts]
   * @returns {Promise<any>} parsed JSON (or raw text / null)
   */
  async function request(path, { method = 'GET', body, signal, timeoutMs = 20000 } = {}) {
    const h = headers();                       // throws GrindrAuthError if not ready
    // Serialize the body up front so a non-serializable body is reported as such,
    // not as a phantom transport failure.
    let payload;
    try { payload = body != null ? JSON.stringify(body) : undefined; }
    catch (err) { throw new GrindrError(`request body is not serializable: ${method} ${path}`, { status: 0, code: 'bad-body', path, cause: err }); }

    const ac = new AbortController();
    const to = setTimeout(() => { try { ac.abort(); } catch (_e) {} }, timeoutMs);
    // Merge the caller's signal with the internal timeout so BOTH can abort —
    // previously `signal || ac.signal` orphaned the timeout whenever a caller
    // passed their own signal.
    let sig = ac.signal;
    let onAbort = null;
    if (signal) {
      let merged = false;
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
        try { sig = AbortSignal.any([signal, ac.signal]); merged = true; } catch (_e) { sig = ac.signal; }
      }
      // On the AbortSignal.any path the merged signal already forwards the
      // caller's abort, so no manual listener is added (it would be redundant and
      // would leak). Only the fallback path bridges the abort manually, and that
      // listener is always removed in `finally` so it can't accumulate on a
      // caller-reused signal.
      if (!merged) {
        try {
          if (signal.aborted) ac.abort();
          else if (typeof signal.addEventListener === 'function') {
            onAbort = () => { try { ac.abort(); } catch (_e) {} };
            signal.addEventListener('abort', onAbort);
          }
        } catch (_e) {}
      }
    }

    let res;
    try {
      res = await fetch(state.base + path, { method, credentials: 'include', headers: h, signal: sig, body: payload });
    } catch (err) {
      const aborted = (err && err.name === 'AbortError') || ac.signal.aborted;
      const code = aborted ? (signal && signal.aborted ? 'aborted' : 'timeout') : '';
      throw new GrindrError(`request failed: ${method} ${path}`, { status: 0, code, path, cause: err });
    } finally {
      clearTimeout(to);
      if (onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (_e) {} }
    }

    let text = '';
    try { text = await res.text(); }
    catch (err) { throw new GrindrError(`response body unreadable: ${method} ${path}`, { status: res.status, code: 'bad-response-body', path, cause: err }); }
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (_e) { data = text; } }
    if (!res.ok) {
      throw new GrindrError(`HTTP ${res.status} on ${method} ${path}`, { status: res.status, code: parseErrorCode(data), path });
    }
    return data;
  }

  return { set, clear, isReady, headers, request, enc, encId, get base() { return state.base; } };
}
