// Opt-in traffic observer: patches fetch and WebSocket.send to auto-capture the
// Grindr3 auth headers, tap hides/blocks list responses, and observe outbound WS
// frames. Both patches degrade to a no-op rather than throwing when the intrinsic
// is frozen (SES/lockdown). Uses a real hostname test, never a substring (an
// `evil.example/?ref=grindr.com` must not donate its headers).

const LIST_RE = /\/api\/(?:v1\/hides|v\d+\/blocks)/i;

function defaultIsGrindrUrl(u) {
  try {
    const loc = globalThis.location;
    const origin = (loc && loc.origin) || 'https://web.grindr.com';
    const h = new URL(String(u || ''), origin).hostname.toLowerCase();
    return h === 'grindr.com' || h.endsWith('.grindr.com');
  } catch (_e) { return false; }
}

function headerGet(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  try {
    if (typeof headers.get === 'function') return headers.get(name) || '';
    if (Array.isArray(headers)) {                       // the [[k,v],…] init form is legal
      for (const p of headers) if (p && String(p[0]).toLowerCase() === lower) return String(p[1] == null ? '' : p[1]);
      return '';
    }
    for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k];
  } catch (_e) {}
  return '';
}

/**
 * @param {{onAuth?:(a:{token:string,countryCode:string,locale:string})=>void,
 *          onListResponse?:(r:{url:string,data:any})=>void,
 *          onWsSend?:(data:any)=>void, onError?:(e:any)=>void,
 *          isGrindrUrl?:(u:string)=>boolean}} [handlers]
 * @returns {{install:()=>void, uninstall:()=>void}}
 */
export function createObserver({ onAuth, onListResponse, onWsSend, onError, isGrindrUrl } = {}) {
  const urlTest = typeof isGrindrUrl === 'function' ? isGrindrUrl : defaultIsGrindrUrl;
  let rawFetch = null;
  let patchedFetch = null;
  let origWsSend = null;
  let installed = false;

  const emitAuth = (headers) => {
    if (!onAuth) return;
    const m = String(headerGet(headers, 'Authorization')).match(/^Grindr3\s+(.+)$/);
    if (!m) return;
    onAuth({ token: m[1], countryCode: headerGet(headers, 'country-code'), locale: headerGet(headers, 'l-locale') });
  };

  function install() {
    if (installed) return;
    if (typeof globalThis.fetch !== 'function') { if (onError) onError(new Error('observe: no fetch to patch')); return; }
    rawFetch = globalThis.fetch;
    patchedFetch = async function patched(input, init) {
      // If we've been uninstalled but a later observer captured us as its "raw",
      // behave as a transparent pass-through instead of re-running our handlers.
      if (!installed) return rawFetch.call(this, input, init);
      const url = String((input && input.url) || input || '');
      let isG = false;
      try { isG = urlTest(url); if (isG) emitAuth((init && init.headers) || (input && input.headers)); }
      catch (e) { if (onError) onError(e); }
      const res = await rawFetch.call(this, input, init);
      try {
        if (onListResponse && isG && LIST_RE.test(url)) {
          res.clone().text().then((t) => { try { onListResponse({ url, data: JSON.parse(t) }); } catch (_e) {} }).catch(() => {});
        }
      } catch (e) { if (onError) onError(e); }
      return res;
    };
    try { globalThis.fetch = patchedFetch; }
    catch (e) { rawFetch = null; patchedFetch = null; if (onError) onError(e); return; }   // frozen intrinsic — degrade
    installed = true;
    // WebSocket send tap (guarded, and only recorded once it actually patches).
    try {
      if (globalThis.WebSocket && WebSocket.prototype && onWsSend) {
        const prev = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          try { onWsSend(data); } catch (e) { if (onError) onError(e); }
          return prev.apply(this, arguments);
        };
        origWsSend = prev;
      }
    } catch (_e) {}
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    // Restore only if we're still the top patch; if a later observer wrapped us,
    // leaving `installed = false` turns our patched fn into a pass-through.
    try { if (patchedFetch && globalThis.fetch === patchedFetch) globalThis.fetch = rawFetch; } catch (_e) {}
    try { if (origWsSend) { WebSocket.prototype.send = origWsSend; origWsSend = null; } } catch (_e) {}
  }

  return { install, uninstall };
}
