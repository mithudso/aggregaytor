// Pure DOM helpers: profile-id and cascade-tile resolution, plus route detection.
// The tile resolution is bounded to avoid the "sidebar trap" — walking up from a
// conversation avatar to a huge ancestor (the inbox UL) and hiding the chat list.

export const PROFILE_PHOTO_SELECTOR = 'img[src*="cdns.grindr.com"], img[src*="grindr.com/images/profile"], img[src*="cloudfront.net"]';
export const CASCADE_TILE_SELECTOR = '[data-testid="cascadeCellContainer"]';
const MIN_ID = 5;
const MAX_ID = 10;
// One source of truth for "a profile id is 5–10 digits"; every matcher derives
// from it so tightening the bound can't desync the regexes.
const ID_RE_SRC = `[0-9]{${MIN_ID},${MAX_ID}}`;
const TILE_MIN_PX = 200;   // a real tile is ~559x745; an inbox row is 241x74

/** A Grindr profile id is 5–10 digits. */
export function isPlausibleProfileId(id) {
  const s = String(id == null ? '' : id);
  return /^[0-9]+$/.test(s) && s.length >= MIN_ID && s.length <= MAX_ID;
}

export function isProfileOverlayOpen() {
  try { return /profile=true/.test(location.search || ''); } catch (_e) { return false; }
}
export function isOnChat() {
  try { return /^\/chat(?:\/|$)/.test(location.pathname || ''); } catch (_e) { return false; }
}
/** @returns {'grid'|'profile'|'chat'|'login'} */
export function route() {
  try {
    if (/^\/login/.test(location.pathname || '')) return 'login';
    if (isOnChat()) return 'chat';
    if (isProfileOverlayOpen()) return 'profile';
  } catch (_e) {}
  return 'grid';
}

/**
 * Resolve the cascade tile for an element. Prefers positive identification via the
 * canonical `data-testid` tile; otherwise a bounded geometry walk that requires the
 * result to look like a tile (≥200px each side, ≤viewport tall). Returns null
 * rather than guess — an inbox avatar's row/UL is refused, never returned.
 * @param {Element} el
 * @returns {Element|null}
 */
export function resolveCascadeTile(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const vh = (typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : 900);
  let r0; try { r0 = el.getBoundingClientRect(); } catch (_e) { return null; }
  if (r0.height > vh) return null;
  // Positive identification: the canonical tile, if the element is inside one.
  if (typeof el.closest === 'function') {
    let tile = null;
    try { tile = el.closest(CASCADE_TILE_SELECTOR); } catch (_e) {}
    if (tile) {
      let rt; try { rt = tile.getBoundingClientRect(); } catch (_e) { return null; }
      return rt.height > vh ? null : tile;
    }
  }
  const body = globalThis.document && document.body;
  const docEl = globalThis.document && document.documentElement;
  let best = el;
  let node = el;
  for (let i = 0; node && i < 4; i += 1, node = node.parentElement) {
    if (node === body || node === docEl) break;
    let photos = 0;
    try { photos = node.querySelectorAll(PROFILE_PHOTO_SELECTOR).length; }
    catch (_e) { break; }                          // fail closed — a guard we can't evaluate stops the walk
    if (photos > 1) break;                          // more than one photo = not a single tile
    let r; try { r = node.getBoundingClientRect(); } catch (_e) { break; }
    if (r.height > vh) break;
    best = node;
  }
  let rb; try { rb = best.getBoundingClientRect(); } catch (_e) { return null; }
  return (rb.width >= TILE_MIN_PX && rb.height >= TILE_MIN_PX) ? best : null;
}

/**
 * Resolve a profile id from an element: URL peer (pathname only), then a bounded
 * attribute scan, then an optional photo-hash index. Generic attributes are matched
 * strictly (whole value / `profile<id>`) so a display name inside
 * `data-testid="chat-button-<name>"` can't donate a false id. Returns '' on miss.
 * @param {Element} el
 * @param {{hashIndex?: {get:(hash:string)=>string|undefined}}} [opts]
 * @returns {string}
 */
export function resolveProfileIdFromElement(el, { hashIndex } = {}) {
  try {
    const m = String(location.pathname || '').match(new RegExp(`/(?:profiles?|users?)/(${ID_RE_SRC})(?:/|$)`, 'i'));
    if (m && isPlausibleProfileId(m[1])) return m[1];
  } catch (_e) {}
  if (!el) return '';
  const LOOSE = new RegExp(`(?:^|[^0-9])(${ID_RE_SRC})(?![0-9])`);
  const STRICT = new RegExp(`^(?:profile[-_ ]?)?(${ID_RE_SRC})$`, 'i');
  try {
    let node = el;
    for (let i = 0; node && i < 6; i += 1, node = node.parentElement) {
      for (const k of ['data-profile-id', 'data-testid', 'aria-label']) {
        const t = String((node.getAttribute && node.getAttribute(k)) || '');
        if (!t) continue;
        const mm = t.match(k === 'data-profile-id' ? LOOSE : STRICT);
        if (mm && isPlausibleProfileId(mm[1])) return mm[1];
      }
    }
  } catch (_e) {}
  if (hashIndex && hashIndex.get) {
    try {
      const imgs = [];
      try { if (el.matches && el.matches(PROFILE_PHOTO_SELECTOR)) imgs.push(el); } catch (_e) {}
      try { if (el.querySelectorAll) imgs.push(...el.querySelectorAll(PROFILE_PHOTO_SELECTOR)); } catch (_e) {}
      for (const img of imgs) {
        const src = String((img.getAttribute && img.getAttribute('src')) || '');
        const h = src.split(/[?#]/)[0].match(/\/([A-Za-z0-9_-]{16,})(?:\.[A-Za-z0-9]+)?$/);
        if (h) { const v = hashIndex.get(h[1]); if (v != null && isPlausibleProfileId(v)) return String(v); }
      }
    } catch (_e) {}
  }
  return '';
}
