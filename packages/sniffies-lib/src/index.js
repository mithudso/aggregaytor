// Sniffies interaction library — an ES-module client for sniffies.com built entirely from
// observed behavior (see docs/sniffies-dom-and-api.md). Read via the HTTP API and the traffic
// observer; write via the DOM composer (Sniffies has no send-message API). Auth is the browser's
// own cookie session — there is no out-of-browser login.
import { SniffiesError, SniffiesAllBasesError, SniffiesTimeoutError } from './errors.js';
import { createLimiter } from './limiter.js';
import { createApi, computeLastActiveTs, extractAttitudeFromPartial } from './api.js';
import { createObserver, decodeSocketFrame, isSniffiesApiUrl } from './observe.js';
import * as dom from './dom.js';
import * as compose from './compose.js';

/** Library version (distinct from the userscript's version). */
export const VERSION = '0.1.0';

export {
  SniffiesError, SniffiesAllBasesError, SniffiesTimeoutError,
  createLimiter, createApi, createObserver,
  computeLastActiveTs, extractAttitudeFromPartial, decodeSocketFrame, isSniffiesApiUrl,
  dom, compose,
};

// localStorage-backed remember/recall for the API's learned base + body-shape, matching the
// userscript's own key names so a page already carrying them is picked up.
const LS_KEYS = {
  partialsBase: 'sniffiesSoftFilterPartialsBase_v1',
  partialsShape: 'sniffiesSoftFilterPartialsMode_v1',
  fullOrigin: 'sniffiesSoftFilterFullUserBase_v1',
};
function lsRemember(key, value) {
  try { if (LS_KEYS[key]) localStorage.setItem(LS_KEYS[key], value); } catch (_e) {}
}
function lsRecall(key) {
  try { return LS_KEYS[key] ? localStorage.getItem(LS_KEYS[key]) : null; } catch (_e) { return null; }
}

/**
 * Build a Sniffies client. A shared rate limiter (6 requests/min + 10-min cooldown, matching the
 * userscript's self-imposed budget) gates every API call, because that ceiling is shared across
 * every client in the browser.
 * @param {{observe?:boolean, limiter?:object, remember?:Function, recall?:Function,
 *          onApiJson?:Function, onSocketFrame?:Function}} [opts]
 */
export function createClient({
  observe = false,
  limiter = createLimiter(),
  remember = lsRemember,
  recall = lsRecall,
  onApiJson,
  onSocketFrame,
} = {}) {
  const api = createApi({ limiter, remember, recall });
  const client = {
    VERSION,
    api,
    dom,
    compose,
    limiter,
    observer: null,
    /** Convenience: normalized attitude+lastActive for a batch of ids, via getPartials. */
    async describe(ids) {
      const rows = await api.getPartials(ids);
      return rows.map((row) => ({
        id: dom.normalizeProfileId(row && row._id),
        attitude: extractAttitudeFromPartial(row) || null,
        lastActiveTs: computeLastActiveTs(row),
      })).filter((r) => r.id);
    },
  };
  if (observe) {
    client.observer = createObserver({ onApiJson, onSocketFrame });
    client.observer.install();
  }
  return client;
}
