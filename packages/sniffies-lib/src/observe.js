// Opt-in traffic observer: patches fetch / XHR / WebSocket to surface Sniffies API JSON and
// Socket.IO frames to callbacks. Every patch is SES/lockdown-safe (try/caught, marker-guarded,
// restorable via uninstall()) and never injects into the page realm. Hostname is tested for real
// (an `evil.example/?ref=sniffies.com` must not pass).

const MAX_BODY_CHARS = 1_500_000;

export function isSniffiesApiUrl(u) {
  try {
    const origin = (globalThis.location && location.origin) || 'https://sniffies.com';
    const url = new URL(String(u || ''), origin);
    const h = url.hostname.toLowerCase();
    const isSniffiesHost = h === 'sniffies.com' || h.endsWith('.sniffies.com');
    return isSniffiesHost && url.pathname.includes('/api/');
  } catch (_e) { return false; }
}

/**
 * Decode one WebSocket frame the way the site frames them (Socket.IO/Engine.IO):
 * - numeric-only frames ("2"/"3" ping-pong) → null
 * - "42[...]" → { event, data } from the [eventName, data] tuple
 * - raw JSON objects/arrays → { event: '', data }
 * - double-encoded payloads (JSON string containing JSON) unwrapped once
 * @param {string} text
 * @returns {{event:string, data:any}|null}
 */
export function decodeSocketFrame(text) {
  const s = String(text == null ? '' : text);
  if (!s || s.length > MAX_BODY_CHARS) return null;
  if (/^\d+$/.test(s)) return null;
  const unwrap = (v) => {
    if (typeof v === 'string' && /^[[{]/.test(v.trim())) {
      try { return JSON.parse(v); } catch (_e) { return v; }
    }
    return v;
  };
  try {
    if (/^\d*\[/.test(s)) {
      // Socket.IO event frame: strip the leading packet-type digits ("42"), parse the tuple.
      const body = s.replace(/^\d+/, '');
      const tuple = JSON.parse(body);
      if (Array.isArray(tuple)) {
        if (tuple.length >= 2) return { event: String(tuple[0]), data: unwrap(tuple[1]) };
        if (tuple.length === 1) return { event: '', data: unwrap(tuple[0]) };
      }
      return null;
    }
    if (/^[[{]/.test(s)) return { event: '', data: unwrap(JSON.parse(s)) };
  } catch (_e) {}
  return null;
}

/**
 * @param {{onApiJson?:(r:{url:string, data:any, via:'fetch'|'xhr'})=>void,
 *          onSocketFrame?:(f:{event:string, data:any, raw:string})=>void,
 *          onError?:(e:any)=>void,
 *          isApiUrl?:(u:string)=>boolean,
 *          target?: any}} [handlers] `target` defaults to globalThis (pass unsafeWindow to
 *          observe the page realm from a userscript sandbox).
 * @returns {{install:()=>boolean, uninstall:()=>void}}
 */
export function createObserver({ onApiJson, onSocketFrame, onError, isApiUrl = isSniffiesApiUrl, target = globalThis } = {}) {
  const restorers = [];
  let installed = false;
  const guard = (e) => { try { if (onError) onError(e); } catch (_e) {} };

  const feedFrame = (raw) => {
    try {
      if (!onSocketFrame) return;
      const handle = (text) => {
        const frame = decodeSocketFrame(text);
        if (frame) onSocketFrame({ ...frame, raw: String(text).slice(0, 2000) });
      };
      if (typeof raw === 'string') handle(raw);
      else if (raw && typeof raw.text === 'function') raw.text().then(handle).catch(() => {});
    } catch (e) { guard(e); }
  };

  function install() {
    if (installed) return true;
    installed = true;
    let patched = false;
    try {
      const originalFetch = target.fetch;
      if (typeof originalFetch === 'function' && !originalFetch.__sniffiesLibWrapped) {
        const wrapped = async function patchedFetch(input, init) {
          const res = await originalFetch.call(this, input, init);
          try {
            const url = String((input && input.url) || input || '');
            if (onApiJson && isApiUrl(url)) {
              const ct = String((res.headers && res.headers.get('content-type')) || '').toLowerCase();
              const len = Number((res.headers && res.headers.get('content-length')) || 0);
              if (ct.includes('json') && len <= MAX_BODY_CHARS) {
                res.clone().json().then((data) => { try { onApiJson({ url, data, via: 'fetch' }); } catch (e) { guard(e); } }).catch(() => {});
              }
            }
          } catch (e) { guard(e); }
          return res;
        };
        wrapped.__sniffiesLibWrapped = true;
        target.fetch = wrapped;
        restorers.push(() => { try { if (target.fetch === wrapped) target.fetch = originalFetch; } catch (_e) {} });
        patched = true;
      }
    } catch (e) { guard(e); }
    try {
      const XHR = target.XMLHttpRequest;
      if (XHR && XHR.prototype && !XHR.prototype.__sniffiesLibPatched && onApiJson) {
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url) {
          this.__sniffiesLibUrl = String(url || '');
          return origOpen.apply(this, arguments);
        };
        XHR.prototype.send = function () {
          try {
            this.addEventListener('load', () => {
              try {
                const url = String(this.__sniffiesLibUrl || this.responseURL || '');
                if (!isApiUrl(url)) return;
                let payload = null;
                if (this.responseType === 'json' && this.response && typeof this.response === 'object') payload = this.response;
                else if (!this.responseType || this.responseType === 'text') {
                  const text = this.responseText || '';
                  if (!text || text.length > MAX_BODY_CHARS) return;
                  payload = JSON.parse(text);
                }
                if (payload) onApiJson({ url, data: payload, via: 'xhr' });
              } catch (e) { guard(e); }
            }, { once: true });
          } catch (e) { guard(e); }
          return origSend.apply(this, arguments);
        };
        XHR.prototype.__sniffiesLibPatched = true;
        restorers.push(() => {
          try { XHR.prototype.open = origOpen; XHR.prototype.send = origSend; delete XHR.prototype.__sniffiesLibPatched; } catch (_e) {}
        });
        patched = true;
      }
    } catch (e) { guard(e); }
    try {
      const NativeWS = target.WebSocket;
      if (typeof NativeWS === 'function' && !NativeWS.__sniffiesLibPatched && onSocketFrame) {
        // Proxy construct trap preserves new.target, subclassing, instanceof, and statics.
        const WrappedWS = new Proxy(NativeWS, {
          construct(Target, args, newTarget) {
            const ws = Reflect.construct(Target, args, newTarget);
            try { ws.addEventListener('message', (ev) => feedFrame(ev && ev.data)); } catch (e) { guard(e); }
            return ws;
          },
        });
        try { NativeWS.__sniffiesLibPatched = true; } catch (_e) {}
        target.WebSocket = WrappedWS;
        restorers.push(() => {
          try { if (target.WebSocket === WrappedWS) target.WebSocket = NativeWS; } catch (_e) {}
          try { delete NativeWS.__sniffiesLibPatched; } catch (_e) {}
        });
        patched = true;
      } else if (onSocketFrame && target.WebSocket && target.WebSocket.prototype && !target.WebSocket.prototype.__sniffiesLibDispatchPatched) {
        // Fallback for a frozen/replaced constructor: sniff dispatched 'message' events.
        const proto = target.WebSocket.prototype;
        const origDispatch = proto.dispatchEvent;
        if (typeof origDispatch === 'function') {
          proto.dispatchEvent = function (event) {
            try { if (event && event.type === 'message') feedFrame(event.data); } catch (e) { guard(e); }
            return origDispatch.apply(this, arguments);
          };
          proto.__sniffiesLibDispatchPatched = true;
          restorers.push(() => {
            try { proto.dispatchEvent = origDispatch; delete proto.__sniffiesLibDispatchPatched; } catch (_e) {}
          });
          patched = true;
        }
      }
    } catch (e) { guard(e); }
    return patched;
  }

  function uninstall() {
    if (!installed) return;
    installed = false;
    for (const r of restorers.splice(0)) { try { r(); } catch (_e) {} }
  }

  return { install, uninstall };
}
