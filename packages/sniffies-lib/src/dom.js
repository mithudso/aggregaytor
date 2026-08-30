// Pure DOM helpers for sniffies.com (Angular 21 + MapLibre GL). Everything here is observed —
// from a saved live snapshot or the battle-tested userscript — not guessed. Two hard rules:
// never select on per-build `_ngcontent-ng-c*` hashes, and remember Angular DESTROYS nodes via
// *ngIf (a collapsed carousel has no cards to query).

// ---- Selectors (observed) -------------------------------------------------------------------
export const MARKER_ROOT_SELECTOR = '.maplibregl-marker';
export const MARKER_CONTAINER_SELECTOR = '[data-testid="markerUserContainer"], .marker-container';
export const MARKER_AVATAR_IMAGE_SELECTOR = '.marker-avatar-image';
export const SELF_MARKER_CONTAINER_SELECTOR = '[data-testid="cv-marker-container"]';
export const GLOBAL_CHAT_MESSAGE_SELECTOR = '[data-testid="globalChat-message"]';
export const GLOBAL_CHAT_LIST_SELECTOR = '[data-testid="global-chat-list-container"]';
export const USER_STATS_SELECTOR = '[data-testid="userStats"]';
export const CRUISER_CARD_SELECTOR = '[data-testid="cruiserCard"]';
export const CRUISER_CARD_HEADER_SELECTOR = '[data-testid="cruiserCardHeader"]';
export const UNREAD_COUNT_SELECTOR = '[data-testid="avatarNewMsgIcon"]';
export const PROFILE_LINK_SELECTOR = "a[href*='/profile/']";
// ⚠ TRAP: [data-testid="global-chat-message-container"] is the single shared list VIEWPORT, not a
// per-message wrapper — toggling a class there hides the entire global chat. Hide a message via
// its parentElement (<app-global-chat-user-container>) instead.

// ---- Ids ------------------------------------------------------------------------------------

/** A Sniffies profile id is a 24-hex Mongo ObjectId; extraction accepts 6+ hex and lowercases. */
export function normalizeProfileId(v) {
  if (v == null) return null;
  const m = String(v).match(/[0-9a-f]{6,}/i);
  return m ? m[0].toLowerCase() : null;
}

/** Extract a profile id from a /profile/<hex> href (also matches /profile/<hex>/chat). */
export function profileIdFromHref(href) {
  const m = String(href || '').match(/\/profile\/([0-9a-f]{6,})/i);
  return m ? m[1].toLowerCase() : null;
}

/** Extract the id from an avatar-CDN URL: profile.sniffiesassets.com/<id>/… */
export function profileIdFromAssetUrl(url) {
  const m = String(url || '').match(/profile\.sniffiesassets\.com\/([0-9a-f]{6,})\//i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Resolve a profile id from any element inside a marker. The encoding is doubly redundant:
 * the `.marker-container` element's `id` attribute IS the profile id, and the avatar
 * background-image path repeats it. Order: container id → avatar bg URL → nearest profile link.
 * @param {Element} el
 * @returns {string|null}
 */
export function profileIdFromMarkerElement(el) {
  if (!el || typeof el.closest !== 'function') return null;
  const container = el.closest(MARKER_CONTAINER_SELECTOR)
    || (el.querySelector && el.querySelector(MARKER_CONTAINER_SELECTOR));
  if (container && container.id) {
    const id = normalizeProfileId(container.id);
    if (id) return id;
  }
  let node = el;
  for (let i = 0; node && i < 6; i += 1, node = node.parentElement) {
    const bg = (node.style && node.style.backgroundImage) || '';
    const id = profileIdFromAssetUrl(bg);
    if (id) return id;
  }
  const link = el.closest(PROFILE_LINK_SELECTOR)
    || (el.querySelector && el.querySelector(PROFILE_LINK_SELECTOR));
  if (link) return profileIdFromHref(link.getAttribute('href'));
  return null;
}

/** Climb from any marker descendant to the MapLibre marker root (the element to hide/show). */
export function resolveMarkerRoot(el) {
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest(MARKER_ROOT_SELECTOR) || el.closest(MARKER_CONTAINER_SELECTOR) || null;
}

// ---- Routes ---------------------------------------------------------------------------------

export function isOnGlobalChat(pathname = location.pathname) {
  return /^\/global-chat(?:\/|$)/.test(String(pathname || ''));
}
export function currentProfileId(href = location.href) {
  return profileIdFromHref(href);
}
export function isOnProfileChat(pathname = location.pathname) {
  return /^\/profile\/[0-9a-f]{6,}\/chat(?:\/|$)/i.test(String(pathname || ''));
}
/** @returns {'global-chat'|'profile-chat'|'profile'|'map'} */
export function route(loc = location) {
  try {
    if (isOnGlobalChat(loc.pathname)) return 'global-chat';
    if (isOnProfileChat(loc.pathname)) return 'profile-chat';
    if (profileIdFromHref(loc.pathname)) return 'profile';
  } catch (_e) {}
  return 'map';
}
export function profileUrlForId(id) {
  const norm = normalizeProfileId(id);
  return norm ? `https://sniffies.com/profile/${norm}` : 'https://sniffies.com/';
}

// ---- Marker facts (attributes the site puts right on the container) -------------------------

/** Distance in miles from `data-distance-miles` on the marker container; NaN when absent. */
export function markerDistanceMiles(el) {
  const container = el && el.closest && (el.closest(MARKER_CONTAINER_SELECTOR) || el);
  const v = container && container.getAttribute && container.getAttribute('data-distance-miles');
  return v == null ? NaN : Number(v);
}

/**
 * Attitude from marker DOM. The clean encoding: `img[alt="top"|"bottom"]` (eggplant/peach webp)
 * plus an optional `svg[data-testid="vers-top-icon"]` modifier.
 * @param {Element} markerEl any element inside the marker
 * @returns {'top'|'bottom'|'vers-top'|'vers-bottom'|null}
 */
export function attitudeFromMarker(markerEl) {
  const root = resolveMarkerRoot(markerEl) || markerEl;
  if (!root || !root.querySelector) return null;
  const img = root.querySelector('img[data-testid="top-icon"], img[data-testid="bottom-icon"], img.emoji-image[alt]');
  const base = img ? String(img.getAttribute('alt') || '').toLowerCase() : '';
  if (base !== 'top' && base !== 'bottom') return null;
  const versMod = !!root.querySelector('[data-testid="vers-top-icon"]');
  if (versMod) return base === 'top' ? 'vers-top' : 'vers-bottom';
  return base;
}

/** Unread count for a marker: text of span[data-testid=avatarNewMsgIcon]; 0 when absent. */
export function markerUnreadCount(markerEl) {
  const root = resolveMarkerRoot(markerEl) || markerEl;
  const badge = root && root.querySelector && root.querySelector(UNREAD_COUNT_SELECTOR);
  const n = badge ? parseInt(String(badge.textContent || '').trim(), 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** True when the marker shows the hosting pill (i.fa-video). */
export function markerIsHosting(markerEl) {
  const root = resolveMarkerRoot(markerEl) || markerEl;
  return !!(root && root.querySelector && root.querySelector('[data-testid="hostingAvatarIcon"]'));
}

// ---- Global chat ----------------------------------------------------------------------------

/** Author profile id of a global-chat message: the message element's own `id` attribute. */
export function globalChatAuthorId(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const msg = target.closest(GLOBAL_CHAT_MESSAGE_SELECTOR);
  if (!msg) return null;
  return normalizeProfileId(msg.id || (msg.getAttribute && msg.getAttribute('id')));
}

/** The element to toggle when hiding one global-chat message (see the viewport TRAP above). */
export function globalChatMessageWrapper(msgEl) {
  return (msgEl && msgEl.parentElement) || msgEl || null;
}

/** All rendered global-chat message elements. */
export function globalChatMessages(doc = document) {
  return doc.querySelectorAll(GLOBAL_CHAT_MESSAGE_SELECTOR);
}

// ---- Cruiser carousel -----------------------------------------------------------------------

/** True when the carousel header carries the `closed` class (cards are DESTROYED while closed). */
export function isCarouselClosed(doc = document) {
  const header = doc.querySelector(CRUISER_CARD_HEADER_SELECTOR);
  return !!(header && header.classList && header.classList.contains('closed'));
}

/** Profile ids of the rendered cruiser cards, DOM order. Empty while the carousel is collapsed. */
export function cruiserCardIds(doc = document) {
  const out = [];
  for (const card of doc.querySelectorAll(CRUISER_CARD_SELECTOR)) {
    const id = normalizeProfileId(card.id || card.getAttribute('id'));
    if (id) out.push(id);
  }
  return out;
}

/**
 * Ensure the carousel is open (clicks the header when closed). Cards render ~400ms later —
 * resolves after `waitMs` when it had to click, immediately otherwise.
 */
export function ensureCarouselOpen(doc = document, waitMs = 400) {
  const header = doc.querySelector(CRUISER_CARD_HEADER_SELECTOR);
  if (!header) return Promise.resolve(false);
  if (!header.classList.contains('closed')) return Promise.resolve(true);
  header.click();
  return new Promise((r) => setTimeout(() => r(true), waitMs));
}
