/**
 * sniffies-map-filters.ts — Map marker filtering, hiding, highlighting, and badges.
 *
 * Injected into the Sniffies page (MAIN world) alongside sniffies.ts.
 * Manages the visual state of map markers based on user preferences:
 *   - Attitude-based hiding (hide bottom, hide top, etc.)
 *   - Attitude-based highlighting (blue outline)
 *   - Text-term exclude (hide markers matching keywords)
 *   - Text-term include (yellow highlight for matching keywords)
 *   - Chat age badges (time since last interaction)
 *   - Manual blocking (shift+click, middle-click)
 *
 * ## Architecture
 * Runs a periodic scan (every 5 seconds) that:
 *   1. Finds all .maplibregl-marker elements on the page
 *   2. Extracts the profile ID from the CDN avatar URL
 *   3. Looks up attitude/metadata from the adapter's contact cache
 *   4. Applies CSS classes based on filter settings
 *   5. Positions chat age badge elements on visible markers
 *
 * Settings are stored in chrome.storage.local (via bridge relay) and
 * loaded at startup. Changes are applied on the next scan cycle.
 */

// ── Types ──────────────────────────────────────────────────────────────────

interface MapFilterSettings {
  // Attitude hiding (true = hide profiles with this attitude)
  hideBottom: boolean;
  hideVersBottom: boolean;
  hideVers: boolean;
  hideVersTop: boolean;
  hideTop: boolean;
  hideSide: boolean;
  hideUnspecified: boolean;
  // Attitude highlighting (true = blue outline)
  highlightBottom: boolean;
  highlightVersBottom: boolean;
  highlightVers: boolean;
  highlightVersTop: boolean;
  highlightTop: boolean;
  // Text-based filtering
  excludeTerms: string[];   // hide profiles matching any of these
  includeTerms: string[];   // highlight profiles matching any of these
  excludeEnabled: boolean;
  includeEnabled: boolean;
  // Chat age badges
  showChatAgeBadges: boolean;
  // Chat-history hiding
  hideRecentChats: boolean;   // hide profiles chatted within last 24h
  hideAnyChats: boolean;      // hide profiles ever chatted
  // Activity hiding — hide markers whose last-active time on the platform
  // is older than 2 hours. Profiles with no last-active signal are LEFT
  // VISIBLE (we don't penalise unknowns).
  hideInactiveOver2h: boolean;
  // Manual blocks
  blockedIds: Set<string>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 5000;
const HIDE_CLASS = 'aggregaytor-hide';
const SHOW_CLASS = 'aggregaytor-show';   // v0.57.55 → kept as a no-op alias for back-compat with anything that read it
const FRESH_CLASS = 'aggregaytor-fresh'; // v0.57.57: brief invisible-on-arrival for new markers, stripped after first applyFilters tick
const FILTERING_BODY_CLASS = 'aggregaytor-filtering';
const HIGHLIGHT_CLASS = 'aggregaytor-highlight';
const HIGHLIGHT_ATTITUDE_CLASS = 'aggregaytor-highlight-attitude';
const BADGE_CLASS = 'aggregaytor-chat-badge';
const STORAGE_KEY = 'aggregaytor_map_filter_settings';
const BLOCKED_KEY = 'aggregaytor_map_blocked';

// ── State ──────────────────────────────────────────────────────────────────

const idToMarker = new Map<string, HTMLElement>();
const ID_TO_MARKER_MAX = 2000;
const markerAttitudes = new Map<string, string>();
const MARKER_ATTITUDES_MAX = 5000;
const manualAttitudes = new Map<string, string>();
const MANUAL_ATTITUDES_MAX = 1000;
const markerProfileText = new Map<string, string>();
const MARKER_PROFILE_TEXT_MAX = 5000;
// Last-active timestamp per profile (epoch ms). Populated from adapter
// contact metadata and from the partials API response. Used by the
// hideInactiveOver2h filter; capped so a long-lived map page doesn't
// accumulate unbounded entries.
const markerLastActive = new Map<string, number>();
const MARKER_LAST_ACTIVE_MAX = 5000;
const INACTIVE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

function cappedMapSet<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  map.set(key, value);
  if (map.size > cap) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value as string);
  }
}
/**
 * Per-profile chat activity — separate timestamps for my last outbound
 * and their last inbound message. Modeled after the old userscript's
 * `chatActivity` Map (v0.7.46), which enables nuanced queries like
 * "waiting on response for >N days" without losing either direction.
 *
 * - myLastTs:    timestamp of the user's most recent outbound message (0 = never)
 * - theirLastTs: timestamp of the contact's most recent inbound message (0 = never)
 *
 * Derived helpers (not stored): anyLastTs = max(my, theirs); waitingOnThem =
 * my > their && my > 0.
 */
interface ChatActivity { myLastTs: number; theirLastTs: number; }
const chatActivity = new Map<string, ChatActivity>();
const CHAT_ACTIVITY_MAX = 5000;

function getActivity(id: string): ChatActivity {
  let a = chatActivity.get(id);
  if (!a) {
    a = { myLastTs: 0, theirLastTs: 0 };
    chatActivity.set(id, a);
    if (chatActivity.size > CHAT_ACTIVITY_MAX) {
      const oldest = chatActivity.keys().next();
      if (!oldest.done) chatActivity.delete(oldest.value as string);
    }
  }
  return a;
}
function anyLastTs(id: string): number {
  const a = chatActivity.get(id);
  if (!a) return 0;
  return Math.max(a.myLastTs, a.theirLastTs);
}
function waitingOnResponse(id: string): boolean {
  const a = chatActivity.get(id);
  if (!a || !a.myLastTs) return false;
  return a.myLastTs > a.theirLastTs;
}
const chatPreviews = new Map<string, Array<{ dir: string; text: string; ts: number }>>();
const CHAT_PREVIEWS_MAX = 500;
const badgeElements = new Map<string, HTMLElement>(); // profileId → badge div
const hideHistory: string[] = []; // stack of recently hidden IDs for undo
const hoverBound = new WeakSet<HTMLElement>(); // prevent duplicate hover listeners

let settings: MapFilterSettings = {
  hideBottom: false, hideVersBottom: false, hideVers: false,
  hideVersTop: false, hideTop: false, hideSide: false, hideUnspecified: false,
  highlightBottom: false, highlightVersBottom: false, highlightVers: false,
  highlightVersTop: false, highlightTop: false,
  excludeTerms: [], includeTerms: [],
  excludeEnabled: false, includeEnabled: false,
  showChatAgeBadges: false,
  hideRecentChats: false,
  hideAnyChats: false,
  hideInactiveOver2h: false,
  blockedIds: new Set(),
};

let filterEnabled = false;
let _lastAppliedSig = '';
let _lastSettingsSig = '';

// ── CSS Injection ──────────────────────────────────────────────────────────

// v0.57.58: bumped CSS version-tag so hot-reloads always replace stale
// CSS. The previous code did `if (existing) return` which kept the
// v0.57.55 default-hide rule alive on tabs that didn't get refreshed
// after the extension hot-reload. That caused "all profile photos
// still hidden" reports even after v0.57.57. Now we use a unique id
// per CSS revision and remove any prior aggregaytor-map-filter-css*
// element on each install.
const FILTER_CSS_ID = 'aggregaytor-map-filter-css-v58';

function injectStyles(): void {
  // Strip any prior CSS revisions (including the stale v0.57.55
  // default-hide rule). The id prefix scopes the cleanup so we don't
  // touch unrelated stylesheets.
  document.querySelectorAll('style[id^="aggregaytor-map-filter-css"]').forEach((el) => {
    if (el.id !== FILTER_CSS_ID) el.remove();
  });
  if (document.getElementById(FILTER_CSS_ID)) return;
  const style = document.createElement('style');
  style.id = FILTER_CSS_ID;
  style.textContent = `
    /* v0.57.57: per-marker anti-FOUC. The previous v0.57.55 used a
       body-class default-hide that hid EVERY marker until applyFilters
       had explicitly tagged it with .aggregaytor-show. That over-fired
       on markers without extractable IDs (which never made it into
       idToMarker, so they never got .aggregaytor-show, so they stayed
       invisible forever). The user reported "all profiles hidden, even
       after disabling filters."
       New approach: the MutationObserver tags only BRAND-NEW markers
       with .aggregaytor-fresh which gives a short opacity:0 grace
       window. applyFilters then either keeps them hidden via
       .aggregaytor-hide or strips .aggregaytor-fresh so they fade in.
       Existing markers stay completely native unless a filter explicitly
       hides them. Filter-disabled state is now a no-op visually. */
    .${FRESH_CLASS} {
      opacity: 0 !important;
      pointer-events: none !important;
      transition: opacity 0.18s;
    }
    .${HIDE_CLASS} {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      transition: opacity 0.18s;
    }
    .${HIGHLIGHT_CLASS} {
      outline: 3px solid #fbbf24 !important;
      outline-offset: 2px;
      box-shadow: 0 0 8px rgba(251, 191, 36, 0.5) !important;
      border-radius: 50%;
      z-index: 10 !important;
    }
    .${HIGHLIGHT_ATTITUDE_CLASS} {
      outline: 3px solid #3b82f6 !important;
      outline-offset: 2px;
      box-shadow: 0 0 8px rgba(59, 130, 246, 0.5) !important;
      border-radius: 50%;
      z-index: 10 !important;
    }
    .${BADGE_CLASS} {
      position: absolute;
      bottom: -16px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(15, 20, 25, 0.9);
      color: #93c5fd;
      font-size: 9px;
      font-family: system-ui, sans-serif;
      padding: 1px 4px;
      border-radius: 3px;
      white-space: nowrap;
      pointer-events: none;
      z-index: 20;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    .aggregaytor-chat-preview {
      position: fixed;
      z-index: 9999;
      background: rgba(15, 20, 25, 0.95);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 8px;
      padding: 8px 10px;
      max-width: 280px;
      max-height: 200px;
      overflow-y: auto;
      font-family: system-ui, sans-serif;
      font-size: 11px;
      color: #e7e9ea;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      pointer-events: none;
    }
    .aggregaytor-chat-preview .cp-msg {
      padding: 3px 0;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .aggregaytor-chat-preview .cp-msg:last-child { border-bottom: none; }
    .aggregaytor-chat-preview .cp-dir { font-weight: 600; margin-right: 4px; }
    .aggregaytor-chat-preview .cp-dir.out { color: #6b7280; }
    .aggregaytor-chat-preview .cp-dir.in { color: #3b82f6; }
    .aggregaytor-chat-preview .cp-time { color: #4b5563; font-size: 9px; float: right; }
    .aggregaytor-chat-preview .cp-empty { color: #4b5563; font-style: italic; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ── Marker Scanning ────────────────────────────────────────────────────────

function resolveMarkerRoot(el: HTMLElement): HTMLElement | null {
  return (el.closest('.maplibregl-marker') ||
    el.closest('.marker-avatar') ||
    el.closest('[data-testid="cv-marker"]') ||
    el.closest('.marker-container')) as HTMLElement || null;
}

function extractIdFromElement(el: HTMLElement): string {
  // 1. Background-image URL on this element or its children — cover both
  //    inline style and computed style (Sniffies may set it via CSS class).
  const targets = [el, ...el.querySelectorAll('.marker-avatar-image, [style*="sniffiesassets"], [class*="avatar"], [class*="marker"]')];
  for (const target of targets) {
    let bg = (target as HTMLElement).style?.backgroundImage || '';
    if (!bg || !bg.includes('sniffiesassets')) {
      try { bg = getComputedStyle(target).backgroundImage || ''; } catch {}
    }
    const match = bg.match(/sniffiesassets\.com\/([0-9a-f]{6,})\//i);
    if (match) return match[1].toLowerCase();
  }
  // 2. Walk up the ancestor chain checking for a background-image on any
  //    parent — Sniffies sometimes renders the avatar on a wrapper.
  let node: HTMLElement | null = el;
  while (node && node !== document.body) {
    let bg = (node.style?.backgroundImage) || '';
    if (!bg) { try { bg = getComputedStyle(node).backgroundImage || ''; } catch {} }
    const m = bg.match(/sniffiesassets\.com\/([0-9a-f]{6,})\//i);
    if (m) return m[1].toLowerCase();
    node = node.parentElement;
  }
  // 3. <img src> for anonymous markers — Sniffies sometimes uses <img> tags.
  const imgs = el.querySelectorAll('img');
  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    const match = src.match(/sniffiesassets\.com\/([0-9a-f]{6,})\//i)
      || src.match(/\/profiles?\/([0-9a-f]{6,})/i);
    if (match) return match[1].toLowerCase();
  }
  // 4. <a href="/profile/{id}"> in or around the element.
  const link = el.querySelector('a[href*="/profile/"]') || el.closest('a[href*="/profile/"]');
  if (link) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/profile\/([0-9a-f]{6,})/i);
    if (match) return match[1].toLowerCase();
  }
  // 5. data-* attributes on this element or any descendant.
  for (const attr of ['data-profile-id', 'data-user-id', 'data-cruiser-id', 'data-pid', 'data-id']) {
    const val = el.getAttribute(attr) || el.querySelector(`[${attr}]`)?.getAttribute(attr) || '';
    if (val && /^[0-9a-f]{6,}$/i.test(val)) return val.toLowerCase();
  }
  // 6. .marker-container's `id` attribute — Sniffies sets this to the
  //    profile hex ID directly (learned from the Sniffies Soft Filter
  //    userscript 0.7.46, function getMarkerIdFromElement).
  const container = el.closest('.marker-container') as HTMLElement | null
    || el.querySelector('.marker-container') as HTMLElement | null;
  if (container) {
    const cid = container.getAttribute('id') || '';
    if (cid && /^[0-9a-f]{6,}$/i.test(cid)) return cid.toLowerCase();
  }
  // 7. aria-label — sometimes anonymous markers still encode the ID.
  const aria = el.getAttribute('aria-label') || el.querySelector('[aria-label]')?.getAttribute('aria-label') || '';
  const ariaMatch = aria.match(/([0-9a-f]{16,})/i);
  if (ariaMatch) return ariaMatch[1].toLowerCase();
  // 8. Last resort: any hex-id pattern in the marker's attribute values.
  for (const attr of Array.from(el.attributes)) {
    const m = (attr.value || '').match(/([0-9a-f]{24,})/i);
    if (m) return m[1].toLowerCase();
  }
  return '';
}

// ── MapLibre Feature Querying ──────────────────────────────────────────────
// Adapted from the Sniffies Soft Filter userscript (0.7.46). When an anonymous
// marker has no extractable ID from the DOM, we can still resolve it by asking
// the MapLibre map instance what feature is rendered at a given screen point —
// the feature's properties always contain the profile ID, regardless of whether
// the marker has a picture or not.

let cachedMap: { getCanvas(): HTMLCanvasElement; queryRenderedFeatures(pt: [number, number]): any[] } | null = null;
let cachedMapCanvas: HTMLCanvasElement | null = null;
let lastFullScanTs = 0;
const FULL_SCAN_COOLDOWN_MS = 10_000;

function findMap(): typeof cachedMap {
  if (cachedMap && typeof cachedMap.getCanvas === 'function') {
    try {
      const currentCanvas = cachedMap.getCanvas();
      if (currentCanvas && currentCanvas === cachedMapCanvas && document.body.contains(currentCanvas)) {
        return cachedMap;
      }
    } catch {}
    cachedMap = null;
    cachedMapCanvas = null;
  }
  const canvas = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas');
  if (!canvas) return null;
  const w = window as any;
  const candidates = [
    w.map, w._map, w.__map,
    w.SNIFFIES?.map, w.SNIFFIES?.mapInstance,
    w.SNIFFIES?.mapService?.map, w.SNIFFIES?.mapService?.mapInstance,
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c.getCanvas && c.queryRenderedFeatures && c.getCanvas() === canvas) {
        cachedMap = c; cachedMapCanvas = canvas; return c;
      }
    } catch {}
  }
  const now = Date.now();
  if (now - lastFullScanTs < FULL_SCAN_COOLDOWN_MS) return null;
  lastFullScanTs = now;
  try {
    for (const k in w) {
      const v = w[k];
      if (v && typeof v === 'object' && typeof v.getCanvas === 'function' && typeof v.queryRenderedFeatures === 'function') {
        try { if (v.getCanvas() === canvas) { cachedMap = v; cachedMapCanvas = canvas; return v; } } catch {}
      }
    }
  } catch {}
  return null;
}

function extractIdFromFeature(feature: any): string {
  if (!feature) return '';
  const candidates: unknown[] = [];
  if (feature.id) candidates.push(feature.id);
  const p = feature.properties || {};
  for (const k of ['_id', 'id', 'userId', 'user_id', 'profileId', 'profile_id', 'cruiserId', 'cruiser_id']) {
    if (p[k]) candidates.push(p[k]);
  }
  // Fall back to scanning every property value for a hex id.
  for (const v of Object.values(p)) candidates.push(v);
  let best = '';
  for (const c of candidates) {
    if (c == null) continue;
    const m = String(c).match(/[0-9a-f]{6,}/i);
    if (m && m[0].length > best.length) best = m[0];
  }
  return best.toLowerCase();
}

/** Query the MapLibre map at a screen point and return the profile ID, if any. */
function getIdFromMapAtPoint(clientX: number, clientY: number): string {
  const map = findMap();
  if (!map) return '';
  const canvas = map.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return '';
  let feats: any[] = [];
  try { feats = map.queryRenderedFeatures([x, y]) || []; } catch { return ''; }
  for (const f of feats) {
    const id = extractIdFromFeature(f);
    if (id) return id;
  }
  return '';
}

/** Try to resolve a marker element's ID via MapLibre by using its centre point. */
function tryIdFromMapForMarker(marker: HTMLElement): string {
  const rect = marker.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return '';
  return getIdFromMapAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function scanMarkers(): void {
  const markers = document.querySelectorAll('.maplibregl-marker');
  const currentIds = new Set<string>();

  markers.forEach(el => {
    const root = el as HTMLElement;
    const id = extractIdFromElement(root);
    if (!id) return;
    currentIds.add(id);
    idToMarker.set(id, root);
  });

  // Clean up removed markers and their associated badge elements
  for (const [id, el] of idToMarker) {
    if (!currentIds.has(id) || !document.body.contains(el)) {
      idToMarker.delete(id);
      const badge = badgeElements.get(id);
      if (badge) { badge.remove(); badgeElements.delete(id); }
    }
  }

  // Enforce cap on idToMarker — evict oldest entries when map is too large
  // (can happen on heavily scrolled maps where markers accumulate)
  while (idToMarker.size > ID_TO_MARKER_MAX) {
    const oldest = idToMarker.keys().next();
    if (!oldest.done) {
      const badge = badgeElements.get(oldest.value);
      if (badge) { badge.remove(); badgeElements.delete(oldest.value); }
      idToMarker.delete(oldest.value);
    } else break;
  }

  // Prune orphaned badge elements whose markers no longer exist in idToMarker
  if (badgeElements.size > idToMarker.size + 50) {
    for (const [id, badge] of badgeElements) {
      if (!idToMarker.has(id)) { badge.remove(); badgeElements.delete(id); }
    }
  }
}

// ── Attitude Detection (Fuzzy Cross-Platform Matching) ─────────────────────
// Each checkbox uses FUZZY matching so it catches ALL variations of that
// position across all platforms:
//   "Top"    → top, vers top, passive top, dom top, dom top breeder
//   "Bottom" → bottom, vers bottom, power bottom, submissive bottom
//   "Vers"   → vers, versatile, vers top, vers bottom
//   "Side"   → side
//
// The Vers checkbox catches pure vers only (not vers top/vers bottom).
// The Vers Top and Vers Bottom checkboxes catch those specific combos.
// This means: hiding "Top" hides ALL top-leaning positions.

function attitudeContains(att: string, keyword: string): boolean {
  return att.toLowerCase().includes(keyword);
}

function shouldHideAttitude(att: string): boolean {
  const lower = (att || '').toLowerCase().trim();
  if (!lower || lower === 'unspecified' || lower === 'unknown' || lower === '') {
    return settings.hideUnspecified;
  }
  // Vers Bottom — check before generic bottom/vers
  if (attitudeContains(lower, 'vers') && attitudeContains(lower, 'bottom')) return settings.hideVersBottom;
  // Vers Top — check before generic top/vers
  if (attitudeContains(lower, 'vers') && attitudeContains(lower, 'top')) return settings.hideVersTop;
  // Pure vers/versatile (no top/bottom qualifier)
  if (attitudeContains(lower, 'vers') || attitudeContains(lower, 'versatile')) return settings.hideVers;
  // Bottom (catches: bottom, power bottom, submissive bottom)
  if (attitudeContains(lower, 'bottom')) return settings.hideBottom;
  // Top (catches: top, passive top, dom top, dom top breeder)
  if (attitudeContains(lower, 'top') || attitudeContains(lower, 'breeder')) return settings.hideTop;
  // Side
  if (attitudeContains(lower, 'side')) return settings.hideSide;
  // Anything else unrecognized
  return settings.hideUnspecified;
}

function shouldHighlightAttitude(att: string): boolean {
  const lower = (att || '').toLowerCase().trim();
  if (!lower) return false;
  if (attitudeContains(lower, 'vers') && attitudeContains(lower, 'bottom')) return settings.highlightVersBottom;
  if (attitudeContains(lower, 'vers') && attitudeContains(lower, 'top')) return settings.highlightVersTop;
  if (attitudeContains(lower, 'vers') || attitudeContains(lower, 'versatile')) return settings.highlightVers;
  if (attitudeContains(lower, 'bottom')) return settings.highlightBottom;
  if (attitudeContains(lower, 'top') || attitudeContains(lower, 'breeder')) return settings.highlightTop;
  return false;
}

// ── Text Term Filtering ────────────────────────────────────────────────────

function matchesTerms(text: string, terms: string[]): boolean {
  if (!text || !terms.length) return false;
  const lower = text.toLowerCase();
  return terms.some(t => lower.includes(t.toLowerCase()));
}

// ── Chat Age Badges ────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

function updateBadge(id: string, marker: HTMLElement): void {
  const chatTs = anyLastTs(id);
  if (!chatTs || !settings.showChatAgeBadges) {
    const existing = badgeElements.get(id);
    if (existing) { existing.style.display = 'none'; }
    return;
  }

  let badge = badgeElements.get(id);
  if (!badge) {
    badge = document.createElement('div');
    badge.className = BADGE_CLASS;
    marker.style.overflow = 'visible';
    marker.appendChild(badge);
    badgeElements.set(id, badge);
  }

  const age = Date.now() - chatTs;
  const waiting = waitingOnResponse(id);
  badge.textContent = `${waiting ? '→' : '←'}${formatAge(age)}`;
  badge.style.display = '';
}

// ── Chat Preview Popup ─────────────────────────────────────────────────────

let previewEl: HTMLElement | null = null;

function showChatPreview(id: string, marker: HTMLElement): void {
  hideChatPreview();
  const messages = chatPreviews.get(id);
  if (!messages || !messages.length) return;

  previewEl = document.createElement('div');
  previewEl.className = 'aggregaytor-chat-preview';

  const sorted = [...messages].sort((a, b) => b.ts - a.ts).slice(0, 8);
  previewEl.innerHTML = sorted.map(m => {
    const dir = m.dir === 'out' ? '→' : '←';
    const cls = m.dir === 'out' ? 'out' : 'in';
    const age = formatAge(Date.now() - m.ts);
    return `<div class="cp-msg"><span class="cp-dir ${cls}">${dir}</span>${escapeHtml(m.text.slice(0, 80))}${m.text.length > 80 ? '...' : ''}<span class="cp-time">${age}</span></div>`;
  }).join('');

  // Position near the marker
  const rect = marker.getBoundingClientRect();
  previewEl.style.left = `${Math.min(rect.right + 8, window.innerWidth - 290)}px`;
  previewEl.style.top = `${Math.max(8, rect.top - 40)}px`;
  document.body.appendChild(previewEl);
}

function hideChatPreview(): void {
  if (previewEl) { previewEl.remove(); previewEl = null; }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ensureHoverBindings(id: string, marker: HTMLElement): void {
  if (hoverBound.has(marker)) return;
  hoverBound.add(marker);
  marker.addEventListener('mouseenter', () => showChatPreview(id, marker), { passive: true });
  marker.addEventListener('mouseleave', () => hideChatPreview(), { passive: true });
}

// ── Attitude Override ──────────────────────────────────────────────────────

function getEffectiveAttitude(id: string): string {
  // Manual override takes priority over adapter-detected attitude
  return manualAttitudes.get(id) || markerAttitudes.get(id) || 'unspecified';
}

// ── Undo Last Hide ─────────────────────────────────────────────────────────

function undoLastHide(): boolean {
  const lastId = hideHistory.pop();
  if (!lastId) return false;
  settings.blockedIds.delete(lastId);
  const marker = idToMarker.get(lastId);
  if (marker) marker.classList.remove(HIDE_CLASS);
  saveBlockedIds();
  return true;
}

// Expose on window for bridge access
(typeof window !== 'undefined' ? window : globalThis as any).__aggregaytor_undoLastHide = undoLastHide;

// Block from floating panel — adds profileId to the blocked set and applies
window.addEventListener('__aggregaytor_block_by_map_filter', ((event: CustomEvent) => {
  const { profileId } = event.detail || {};
  if (!profileId) return;
  console.log('[Aggregaytor:MapFilters] Block event received, profileId:', profileId, 'total blocked:', settings.blockedIds.size + 1);
  settings.blockedIds.add(profileId);
  hideHistory.push(profileId);
  if (hideHistory.length > 50) hideHistory.shift();
  saveBlockedIds();
  applyFilters();
}) as EventListener);

// ── Main Filter Pass ───────────────────────────────────────────────────────

function applyFilters(): void {
  if (!filterEnabled) return;
  scanMarkers();
  if (idToMarker.size === 0) return;

  const anyFilterOn = settings.blockedIds.size > 0 ||
    (settings.excludeEnabled && settings.excludeTerms.length > 0) ||
    settings.hideRecentChats || settings.hideAnyChats ||
    settings.hideBottom || settings.hideVersBottom || settings.hideVers ||
    settings.hideVersTop || settings.hideTop || settings.hideSide || settings.hideUnspecified ||
    (settings.includeEnabled && settings.includeTerms.length > 0) ||
    settings.highlightBottom || settings.highlightVersBottom || settings.highlightVers ||
    settings.highlightVersTop || settings.highlightTop ||
    settings.showChatAgeBadges ||
    settings.hideInactiveOver2h;
  // v0.57.57: ALWAYS strip our body class — kept as a defensive guard
  // in case v0.57.55 left it on someone's page. Per-marker FRESH_CLASS
  // is the new approach. When no filter is active, also strip every
  // class we own so markers go back to fully native rendering.
  // v0.57.60: optional chain — applyFilters can race with very early
  // page load before <body> exists; document.body is null then.
  document.body?.classList.remove(FILTERING_BODY_CLASS);
  if (!anyFilterOn) {
    for (const marker of idToMarker.values()) {
      marker.classList.remove(HIDE_CLASS, SHOW_CLASS, FRESH_CLASS, HIGHLIGHT_CLASS, HIGHLIGHT_ATTITUDE_CLASS);
    }
    // Also strip FRESH_CLASS from anything in the DOM that the observer
    // tagged before this scan ran — even markers we couldn't ID need
    // to come back out of the brief invisible state.
    document.querySelectorAll(`.${FRESH_CLASS}`).forEach((el) => el.classList.remove(FRESH_CLASS));
    return;
  }
  let nMarkers = 0;
  let nHiddenByBlock = 0, nHiddenByText = 0, nHiddenByAttitude = 0;
  let nHiddenByWaiting24h = 0, nHiddenByWaitingEver = 0;
  let nHiddenByInactive = 0;
  let nWaiting = 0, nActivityEntries = 0;
  nActivityEntries = chatActivity.size;

  // v0.57.59: belt-and-suspenders — strip FRESH_CLASS from EVERY marker
  // in the DOM, not just the ones that made it into idToMarker. The
  // previous loop only revealed markers with extractable IDs; markers
  // whose ID couldn't be parsed (avatarless, mid-render, partial-load)
  // got tagged FRESH by the MutationObserver but never had FRESH stripped,
  // so they stayed invisible forever. This sweep happens before the
  // per-id filter loop so any marker that ends up filtered still gets
  // HIDE_CLASS afterward.
  document.querySelectorAll(`.${FRESH_CLASS}`).forEach((el) => el.classList.remove(FRESH_CLASS));

  for (const [id, marker] of idToMarker) {
    nMarkers++;
    // Remove all classes first.
    marker.classList.remove(HIDE_CLASS, SHOW_CLASS, FRESH_CLASS, HIGHLIGHT_CLASS, HIGHLIGHT_ATTITUDE_CLASS);

    // Priority 1: manually blocked
    if (settings.blockedIds.has(id)) {
      marker.classList.add(HIDE_CLASS);
      const b = badgeElements.get(id); if (b) b.style.display = 'none';
      nHiddenByBlock++;
      continue;
    }

    // Priority 2: exclude terms
    if (settings.excludeEnabled && settings.excludeTerms.length) {
      const text = markerProfileText.get(id) || '';
      if (matchesTerms(text, settings.excludeTerms)) {
        marker.classList.add(HIDE_CLASS);
        const b = badgeElements.get(id); if (b) b.style.display = 'none';
        nHiddenByText++;
        continue;
      }
    }

    // Priority 2.5: chat-history filters.
    //
    // The two chips have DIFFERENT semantics by design:
    //
    //   ⏳ <24h      — Hide any profile with chat activity in the last 24h,
    //                  regardless of who spoke last. Purpose: declutter the
    //                  map of people you're already actively chatting with.
    //                  Uses anyLastTs = max(myLastTs, theirLastTs).
    //
    //   ⏳ Ghosted   — Hide profiles where you're waiting on a response
    //                  (myLastTs > theirLastTs). Any age. Purpose: hide
    //                  unanswered conversations so you focus on fresh
    //                  prospects. Marker reappears when they reply.
    //
    // Attribution: <24h is checked first because its scope is narrower;
    // a profile caught by <24h doesn't also get counted under Ghosted.
    const waiting = waitingOnResponse(id);
    if (waiting) nWaiting++;
    if (settings.hideAnyChats || settings.hideRecentChats) {
      const lastAny = anyLastTs(id);
      const within24h = lastAny > 0 && (Date.now() - lastAny) < 24 * 60 * 60 * 1000;
      if (settings.hideRecentChats && within24h) {
        marker.classList.add(HIDE_CLASS);
        const b = badgeElements.get(id); if (b) b.style.display = 'none';
        nHiddenByWaiting24h++;
        continue;
      }
      if (settings.hideAnyChats && waiting) {
        marker.classList.add(HIDE_CLASS);
        const b = badgeElements.get(id); if (b) b.style.display = 'none';
        nHiddenByWaitingEver++;
        continue;
      }
    }

    // Priority 2.75: hide markers whose last platform activity is over the
    // inactivity threshold. Profiles for which we have no last-active
    // signal are LEFT VISIBLE — better to under-hide than to hide a
    // marker that might actually be online but which we just haven't
    // observed a timestamp for yet (the partials prefetch backfills this
    // asynchronously, so unknowns become known on the next pass).
    if (settings.hideInactiveOver2h) {
      const lastActiveTs = markerLastActive.get(id) || 0;
      if (lastActiveTs > 0 && (Date.now() - lastActiveTs) > INACTIVE_THRESHOLD_MS) {
        marker.classList.add(HIDE_CLASS);
        const b = badgeElements.get(id); if (b) b.style.display = 'none';
        nHiddenByInactive++;
        continue;
      }
    }

    // Priority 3: attitude hiding (uses manual override if set)
    const att = getEffectiveAttitude(id);
    if (shouldHideAttitude(att)) {
      marker.classList.add(HIDE_CLASS);
      const b = badgeElements.get(id); if (b) b.style.display = 'none';
      nHiddenByAttitude++;
      continue;
    }

    // v0.57.57: passing marker — no class needed. Native rendering applies.
    // (FRESH_CLASS, if present, was already stripped above.)

    // Not hidden — check highlights
    if (settings.includeEnabled && settings.includeTerms.length) {
      const text = markerProfileText.get(id) || '';
      if (matchesTerms(text, settings.includeTerms)) {
        marker.classList.add(HIGHLIGHT_CLASS);
      }
    }
    if (shouldHighlightAttitude(att)) {
      marker.classList.add(HIGHLIGHT_ATTITUDE_CLASS);
    }

    // Chat age badge
    updateBadge(id, marker);

    // Hover preview bindings (chat preview popup)
    ensureHoverBindings(id, marker);
  }

  // Diagnostic summary — logged on every applyFilters pass so you can tell
  // why (or why not) profiles are being hidden. Gated behind a chip being
  // on or block-activity being nonzero to avoid console spam on idle maps.
  const stats = {
    markers: nMarkers,
    activity: nActivityEntries,
    waiting: nWaiting,
    hiddenByBlock: nHiddenByBlock,
    hiddenByText: nHiddenByText,
    hiddenByAttitude: nHiddenByAttitude,
    hiddenByWaiting24h: nHiddenByWaiting24h,
    hiddenByWaitingEver: nHiddenByWaitingEver,
    hiddenByInactive: nHiddenByInactive,
    lastActiveKnown: markerLastActive.size,
    chips: {
      hideRecentChats: settings.hideRecentChats,
      hideAnyChats: settings.hideAnyChats,
      hideInactiveOver2h: settings.hideInactiveOver2h,
    },
  };
  // Throttle applyFilters logs: only fire when something interesting is
  // happening AND the stats changed since last log. Previously logging on
  // every 6th scan regardless of state → one line of noise every 30s even
  // when nothing changed.
  if (settings.hideAnyChats || settings.hideRecentChats || settings.hideInactiveOver2h || nHiddenByBlock || nHiddenByText || nHiddenByAttitude) {
    const sig = `${nMarkers}/${nActivityEntries}/${nWaiting}/${nHiddenByBlock}/${nHiddenByText}/${nHiddenByAttitude}/${nHiddenByWaiting24h}/${nHiddenByWaitingEver}/${nHiddenByInactive}`;
    if (sig !== _lastAppliedSig) {
      _lastAppliedSig = sig;
      console.log('[Aggregaytor:MapFilters] applyFilters:', stats);
    }
  }
  // Broadcast to the ISOLATED-world bridge so the top filter bar can show
  // live hidden counts per chip. postMessage crosses the MAIN→ISOLATED
  // boundary (bridge listens via window.addEventListener('message')).
  try { window.postMessage({ type: '__aggregaytor_filter_stats', stats }, '*'); } catch {}
}

/**
 * Debug helper — dump the current state of chatActivity for a specific
 * profile. Exposed on window so you can inspect from DevTools:
 *   __aggregaytor_debug_activity('6774d0599604ddad18d1e874')
 */
(window as any).__aggregaytor_debug_activity = (profileId: string) => {
  const id = String(profileId || '').toLowerCase().replace(/^sniffies:/, '');
  const a = chatActivity.get(id);
  if (!a) {
    console.log(`[Aggregaytor:MapFilters] No activity for ${id}`);
    return null;
  }
  const now = Date.now();
  const info = {
    id,
    myLastTs: a.myLastTs,
    theirLastTs: a.theirLastTs,
    myAgeHrs: a.myLastTs ? Math.round((now - a.myLastTs) / 3_600_000 * 10) / 10 : null,
    theirAgeHrs: a.theirLastTs ? Math.round((now - a.theirLastTs) / 3_600_000 * 10) / 10 : null,
    waitingOnResponse: waitingOnResponse(id),
    onMap: idToMarker.has(id),
  };
  console.log('[Aggregaytor:MapFilters] Activity:', info);
  return info;
};

// ── Click Handlers ─────────────────────────────────────────────────────────

/** Core block logic — add to blockedIds, hide the marker, persist, notify. */
function blockById(id: string, marker: HTMLElement | null): void {
  settings.blockedIds.add(id);
  hideHistory.push(id);
  if (hideHistory.length > 50) hideHistory.shift();
  if (marker) marker.classList.add(HIDE_CLASS);
  hideChatPreview();
  saveBlockedIds();
  window.dispatchEvent(new CustomEvent('__aggregaytor_message', {
    detail: JSON.parse(JSON.stringify({
      type: 'PROFILE_BLOCKED',
      contactId: `sniffies:${id}`,
      platform: 'sniffies',
    })),
  }));
}

/**
 * Resolve a profile ID from a marker using every available strategy,
 * in order of preference:
 *   1. DOM-based extraction (background-image, href, data-*, container id)
 *   2. MapLibre queryRenderedFeatures() at the marker's centre point
 * This is the approach used by the original Sniffies Soft Filter userscript
 * (v0.7.46) — anonymous/no-picture markers are always resolvable via
 * MapLibre's feature query as long as the map instance is discoverable.
 */
function resolveMarkerId(marker: HTMLElement, clientX?: number, clientY?: number): string {
  const fromDom = extractIdFromElement(marker);
  if (fromDom) return fromDom;
  // Prefer the click's exact coords when available (more accurate than centre).
  if (typeof clientX === 'number' && typeof clientY === 'number') {
    const fromPoint = getIdFromMapAtPoint(clientX, clientY);
    if (fromPoint) return fromPoint;
  }
  return tryIdFromMapForMarker(marker);
}

/**
 * Resolve a profile ID from a click event on a map marker, trying DOM,
 * MapLibre canvas query, and marker centre-point in priority order.
 * Returns null if no ID could be resolved.
 */
function resolveProfileIdAtEvent(e: MouseEvent): { id: string; markerEl: HTMLElement | null; source: string } | null {
  const target = e.target as HTMLElement;
  if (!target) return null;

  const markerEl = resolveMarkerRoot(target);
  let id = '';
  let source = '';
  if (markerEl) {
    id = extractIdFromElement(markerEl);
    if (id) source = 'dom';
  }
  if (!id) {
    id = getIdFromMapAtPoint(e.clientX, e.clientY);
    if (id) source = 'map-query';
  }
  if (!id && markerEl) {
    id = tryIdFromMapForMarker(markerEl);
    if (id) source = 'marker-centre';
  }
  return id ? { id, markerEl, source } : null;
}

function setupClickHandlers(): void {
  // Middle-click behavior:
  // - In/near chat input → quick-send first available phrase
  // - On a DOM map marker → quick-hide the profile
  // - On the MapLibre canvas (even without a DOM marker — anonymous profiles
  //   are drawn directly on the canvas as features) → query MapLibre at the
  //   click point and quick-hide
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return; // middle click only

    const target = e.target as HTMLElement;
    if (!target) return;

    // If in a chat area → quick-send a phrase (unchanged)
    const chatArea = target.closest('[class*="chat"], [class*="message"], [class*="conversation"]');
    const markerEl = resolveMarkerRoot(target);
    if (chatArea && !markerEl) {
      e.preventDefault();
      try {
        const phrases = JSON.parse(localStorage.getItem('aggregaytor_quick_phrases') || '[]');
        const phrase = phrases[0] || '';
        if (phrase) {
          window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
            detail: { text: phrase },
          }));
        }
      } catch {}
      return;
    }

    const resolved = resolveProfileIdAtEvent(e);
    if (!resolved) {
      console.log('[Aggregaytor:MapFilters] Middle-click: no ID resolved', {
        hasMarkerEl: !!markerEl,
        hasMap: !!findMap(),
        targetTag: target.tagName,
        targetClass: target.className,
      });
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    console.log('[Aggregaytor:MapFilters] Blocking via middle-click:', resolved.id, `(source: ${resolved.source})`);
    blockById(resolved.id, resolved.markerEl);
  }, true);

  // Shift+right-click = same as middle-click (trackpad users without a
  // middle button can still quick-hide). We must suppress both the mousedown
  // default action AND the contextmenu event that would otherwise show the
  // browser right-click menu.
  //
  // v0.57.20: the two handlers (mousedown + contextmenu) both ran the full
  // DOM→canvas→marker-centre resolver, which can be surprisingly expensive
  // on dense clusters (queryRenderedFeatures + getComputedStyle scans).
  // Memoise the resolution result across the two handlers in a single
  // shift+right-click gesture using an event-stamp lookup.
  let _lastShiftRightClickResult: { timestamp: number; resolved: ReturnType<typeof resolveProfileIdAtEvent> } | null = null;
  function resolveShiftRightClick(e: MouseEvent): ReturnType<typeof resolveProfileIdAtEvent> {
    const now = performance.now();
    if (_lastShiftRightClickResult && now - _lastShiftRightClickResult.timestamp < 200) {
      return _lastShiftRightClickResult.resolved;
    }
    // Clear stale result to release DOM element references held by markerEl
    if (_lastShiftRightClickResult && now - _lastShiftRightClickResult.timestamp > 2000) {
      _lastShiftRightClickResult = null;
    }
    const resolved = resolveProfileIdAtEvent(e);
    _lastShiftRightClickResult = { timestamp: now, resolved };
    setTimeout(() => { _lastShiftRightClickResult = null; }, 2000);
    return resolved;
  }

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 2 || !e.shiftKey) return; // right-click with shift only

    const target = e.target as HTMLElement;
    if (!target) return;

    const resolved = resolveShiftRightClick(e);
    if (!resolved) return;

    e.preventDefault();
    e.stopPropagation();
    console.log('[Aggregaytor:MapFilters] Blocking via shift+right-click:', resolved.id, `(source: ${resolved.source})`);
    blockById(resolved.id, resolved.markerEl);
  }, true);

  // Suppress the native context menu when shift is held AND we're over a
  // resolvable marker — otherwise the browser menu appears after the
  // mousedown fires. Checked lazily per event, so non-shift right-clicks
  // behave normally (native context menu still works).
  document.addEventListener('contextmenu', (e) => {
    if (!e.shiftKey) return;
    const resolved = resolveShiftRightClick(e as MouseEvent);
    if (!resolved) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Shift+click = toggle block (works on anonymous markers too via canvas query)
  document.addEventListener('click', (e) => {
    if (!e.shiftKey) return;
    const target = e.target as HTMLElement;
    if (!target) return;

    const markerEl = resolveMarkerRoot(target);
    let id = '';
    if (markerEl) id = extractIdFromElement(markerEl);
    if (!id) id = getIdFromMapAtPoint(e.clientX, e.clientY);
    if (!id && markerEl) id = tryIdFromMapForMarker(markerEl);
    if (!id) return;

    e.preventDefault();
    e.stopPropagation();
    if (settings.blockedIds.has(id)) {
      settings.blockedIds.delete(id);
      if (markerEl) markerEl.classList.remove(HIDE_CLASS);
    } else {
      settings.blockedIds.add(id);
      hideHistory.push(id);
      if (hideHistory.length > 50) hideHistory.shift();
      if (markerEl) markerEl.classList.add(HIDE_CLASS);
    }
    saveBlockedIds();
  }, true);
}

// ── Settings Persistence ───────────────────────────────────────────────────

function saveBlockedIds(): void {
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify([...settings.blockedIds]));
  } catch {}
}

function loadSettings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Strip blockedIds from filter settings on read — BLOCKED_KEY is the
      // canonical source. If an older build left blockedIds in STORAGE_KEY,
      // ignore it here and drop it from the stored doc so it can never
      // come back through the filter panel round-trip again.
      const hadPollution = Array.isArray(parsed.blockedIds);
      delete parsed.blockedIds;
      Object.assign(settings, parsed);
      if (hadPollution) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); } catch {}
      }
    }
    const blocked = localStorage.getItem(BLOCKED_KEY);
    if (blocked) {
      const arr = JSON.parse(blocked);
      if (Array.isArray(arr)) settings.blockedIds = new Set(arr);
    }
  } catch {}
}

// ── Settings Update from Bridge ────────────────────────────────────────────
// The bridge (ISOLATED world) relays settings changes from the side panel
// via a CustomEvent. This is how the user controls filters from the UI.

window.addEventListener('__aggregaytor_map_filter_settings', ((event: CustomEvent) => {
  const update = event.detail;
  if (!update) return;
  // Log only when a user-visible setting actually changed — the top bar
  // and floating panel both echo settings back on every "Sync" tick,
  // which was producing multiple log lines per minute with no state
  // change. Compare a stable signature of the interesting fields.
  const sig = JSON.stringify({
    e: !!update.excludeEnabled, i: !!update.includeEnabled,
    r: !!update.hideRecentChats, a: !!update.hideAnyChats,
    et: (update.excludeTerms || []).join('|'),
    it: (update.includeTerms || []).join('|'),
    h: !!update.hideBottom, hv: !!update.hideVers, ht: !!update.hideTop,
    hvb: !!update.hideVersBottom, hvt: !!update.hideVersTop,
    hs: !!update.hideSide, hu: !!update.hideUnspecified,
    b: !!update.showChatAgeBadges,
    in2h: !!update.hideInactiveOver2h,
  });
  if (sig !== _lastSettingsSig) {
    _lastSettingsSig = sig;
    console.log('[Aggregaytor:MapFilters] Filter settings updated:', {
      excludeEnabled: update.excludeEnabled,
      includeEnabled: update.includeEnabled,
      hideRecentChats: update.hideRecentChats,
      hideAnyChats: update.hideAnyChats,
      excludeTerms: update.excludeTerms?.length,
      includeTerms: update.includeTerms?.length,
    });
  }
  // ⚠ Never let the filter-panel update (which comes from the floating
  // filter UI) TOUCH blockedIds. That UI doesn't edit the blocked list —
  // but it was inadvertently echoing a stale copy read from STORAGE_KEY,
  // which then replaced the live in-memory set. Symptom: middle-clicked
  // hides reappear a few seconds later when the filter panel re-renders.
  // BLOCKED_KEY remains the single source of truth for blocked profiles.
  const { blockedIds: _ignored, ...filterOnly } = update;
  Object.assign(settings, filterOnly);
  // Persist WITHOUT blockedIds so STORAGE_KEY can never contaminate
  // the blocked set on re-read.
  try {
    const toSave = { ...settings } as any;
    delete toSave.blockedIds;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {}
  // Apply immediately
  applyFilters();
}) as EventListener);

// ── Adapter Data Integration ───────────────────────────────────────────────
// The adapter (running in the same MAIN world) emits contact data with
// attitude/metadata. We listen for these to populate our caches.

window.addEventListener('__aggregaytor_contact_data', ((event: CustomEvent) => {
  const contacts = event.detail?.contacts;
  if (!Array.isArray(contacts)) return;
  for (const c of contacts) {
    const id = (c.platformUserId || '').toLowerCase();
    if (!id) continue;
    if (c.metadata?.position || c.metadata?.attitude) {
      cappedMapSet(markerAttitudes, id, String(c.metadata.position || c.metadata.attitude), MARKER_ATTITUDES_MAX);
    }
    if (typeof c.metadata?.lastActive === 'number' && c.metadata.lastActive > 0) {
      // Adapter normalises any of {lastactive, last_active, lastSeenAt, …}
      // into epoch ms via parseTimestamp, so we just cache the number.
      cappedMapSet(markerLastActive, id, c.metadata.lastActive, MARKER_LAST_ACTIVE_MAX);
    }
    if (c.metadata?.profileText) {
      cappedMapSet(markerProfileText, id, String(c.metadata.profileText), MARKER_PROFILE_TEXT_MAX);
    }
  }
}) as EventListener);

// Chat activity seed from the SW (relayed by the bridge every 60s, first
// seed ~1.5s after page load). Merges per-profile {my, them} timestamps
// into the in-memory chatActivity map, taking the max with existing values
// so a live message that arrived between seeds isn't stomped by older data.
// Triggers an immediate applyFilters() so the chips start working the
// moment the first seed lands — no page reload required.
let _lastMergedCount = -1;
window.addEventListener('__aggregaytor_chat_activity_seed', ((event: CustomEvent) => {
  const seed = event.detail;
  if (!seed || typeof seed !== 'object') return;
  let mergedCount = 0;
  for (const [id, val] of Object.entries(seed)) {
    const v = val as { my?: number; them?: number };
    const key = String(id).toLowerCase();
    const a = getActivity(key);
    if (typeof v.my === 'number' && v.my > a.myLastTs) a.myLastTs = v.my;
    if (typeof v.them === 'number' && v.them > a.theirLastTs) a.theirLastTs = v.them;
    mergedCount++;
  }
  // Log only when the count changes — the seed fires every 60s and logging
  // an identical number repeatedly just fills the console with noise.
  if (mergedCount !== _lastMergedCount) {
    console.log(`[Aggregaytor:MapFilters] Merged chat activity seed for ${mergedCount} profiles`);
    _lastMergedCount = mergedCount;
  }
  applyFilters();
}) as EventListener);

// Chat timestamp + preview updates from adapter messages.
// Each event carries one message's direction + timestamp. We update the
// per-direction max so out-of-order delivery (history scrape after a live
// message) still converges to the correct state.
window.addEventListener('__aggregaytor_chat_timestamp', ((event: CustomEvent) => {
  const { profileId, timestamp, body, direction } = event.detail || {};
  if (!profileId || !timestamp) return;
  const id = profileId.toLowerCase();
  const a = getActivity(id);
  if (direction === 'out' && timestamp > a.myLastTs) {
    a.myLastTs = timestamp;
  } else if (direction === 'in' && timestamp > a.theirLastTs) {
    a.theirLastTs = timestamp;
  }
  // Also store message for chat preview popup
  if (body) {
    if (!chatPreviews.has(id)) {
      chatPreviews.set(id, []);
      if (chatPreviews.size > CHAT_PREVIEWS_MAX) {
        const oldest = chatPreviews.keys().next();
        if (!oldest.done) chatPreviews.delete(oldest.value as string);
      }
    }
    const msgs = chatPreviews.get(id)!;
    const isDup = msgs.some(m => m.ts === timestamp && m.dir === (direction || 'in'));
    if (!isDup) {
      msgs.push({ dir: direction || 'in', text: String(body).slice(0, 100), ts: timestamp });
      if (msgs.length > 20) msgs.splice(0, msgs.length - 20);
    }
  }
}) as EventListener);

// Undo last hide — triggered by bridge relay from side panel
window.addEventListener('__aggregaytor_undo_hide', (() => {
  const success = undoLastHide();
  if (success) applyFilters();
}) as EventListener);

// Manual attitude override — set via side panel or bridge
window.addEventListener('__aggregaytor_set_attitude', ((event: CustomEvent) => {
  const { profileId, attitude } = event.detail || {};
  if (!profileId || !attitude) return;
  cappedMapSet(manualAttitudes, profileId.toLowerCase(), attitude, MANUAL_ATTITUDES_MAX);
  // Persist
  try {
    localStorage.setItem('aggregaytor_manual_attitudes', JSON.stringify([...manualAttitudes.entries()]));
  } catch {}
  applyFilters();
}) as EventListener);

// ── Partials Prefetcher ───────────────────────────────────────────────────
// Proactively fetch profile attitude from Sniffies' `/api/user/partials`
// endpoint for markers currently on the map that don't have a known
// attitude. This is what the old userscript used — without it, position
// filters only work for profiles the user has already clicked into,
// because the adapter only emits `contacts` events when the native app
// fetches that specific profile.
//
// The endpoint takes a batch of user IDs and returns an array of partial
// profile objects. The attitude is at `data.profile.extended.sexuality.attitude`.
//
// Rate limiting: at most one POST per 4 seconds; exponential backoff on 429.

const PARTIALS_ENDPOINTS = [
  'https://usw.api.sniffies.com/api/user/partials',
  'https://uswapi2.sniffies.com/api/user/partials',
];
const PARTIALS_BATCH = 50;
const PARTIALS_MIN_INTERVAL_MS = 4000;
const PARTIALS_FAIL_COOLDOWN_MS = 30_000;

const partialsFetchInFlight = new Set<string>();
const partialsRetryAt = new Map<string, number>();
const PARTIALS_RETRY_AT_MAX = 2000;
const partialsNoAttitude = new Set<string>();
const PARTIALS_NO_ATTITUDE_MAX = 5000;
let partialsLastRequestTs = 0;
let partialsRateLimitUntil = 0;
let partialsPreferredEndpoint = PARTIALS_ENDPOINTS[0];
let partialsEndpointFailCount = 0;

function extractAttitudeFromPartial(p: any): string | null {
  const sexuality = p?.data?.profile?.extended?.sexuality;
  if (!sexuality) return null;
  const att = sexuality.attitude;
  return att ? String(att).toLowerCase() : null;
}

function extractTextFromPartial(p: any): string {
  const prof = p?.data?.profile;
  if (!prof) return '';
  const bits: string[] = [];
  const bio = prof.extended?.bio || prof.bio;
  if (bio) bits.push(String(bio));
  const aboutMe = prof.extended?.aboutMe || prof.aboutMe;
  if (aboutMe) bits.push(String(aboutMe));
  const lookingFor = prof.extended?.lookingFor || prof.lookingFor;
  if (lookingFor) bits.push(String(lookingFor));
  return bits.join(' ').toLowerCase();
}

/**
 * Pull a last-active timestamp out of a partials response object. Tries
 * each path Sniffies has used historically, plus legacy snake/camelCase
 * spellings. Returns epoch ms, or 0 when no usable signal was found.
 *
 * Number values below 1e12 are interpreted as seconds and upgraded to
 * milliseconds (matches parseTimestamp() in the adapter).
 */
function extractLastActiveFromPartial(p: any): number {
  const prof = p?.data?.profile || p?.data || p || {};
  const candidates: unknown[] = [
    prof.lastActiveAt, prof.lastActive, prof.lastSeenAt, prof.lastSeen,
    prof.lastOnlineAt, prof.lastOnline, prof.onlineAt,
    prof.activity?.lastSeenAt, prof.activity?.lastActiveAt,
    prof.extended?.lastActiveAt, prof.extended?.lastActive,
    p?.lastActiveAt, p?.lastActive,
  ];
  for (const v of candidates) {
    if (v == null) continue;
    if (typeof v === 'number') {
      if (!isFinite(v) || v <= 0) continue;
      return v < 1e12 ? v * 1000 : v;
    }
    if (typeof v === 'string') {
      const parsed = Date.parse(v);
      if (!isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

async function fetchPartialsForIds(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const now = Date.now();
  if (now < partialsRateLimitUntil) return;
  if (now - partialsLastRequestTs < PARTIALS_MIN_INTERVAL_MS) return;
  partialsLastRequestTs = now;

  // Try preferred endpoint first, fall back to others on failure.
  const endpoints = [partialsPreferredEndpoint, ...PARTIALS_ENDPOINTS.filter(e => e !== partialsPreferredEndpoint)];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userIds: ids }),
        credentials: 'include',
      });
      if (res.status === 429) {
        partialsRateLimitUntil = Date.now() + PARTIALS_FAIL_COOLDOWN_MS;
        console.warn('[Aggregaytor:MapFilters] partials 429 — cooling down');
        return;
      }
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;
      partialsPreferredEndpoint = endpoint;
      partialsEndpointFailCount = 0;
      let attitudeCount = 0;
      for (const p of data) {
        const id = String(p?._id || p?.id || p?.data?._id || '').toLowerCase();
        if (!id) continue;
        const att = extractAttitudeFromPartial(p);
        if (att) {
          cappedMapSet(markerAttitudes, id, att, MARKER_ATTITUDES_MAX);
          attitudeCount++;
        } else {
          partialsNoAttitude.add(id);
          if (partialsNoAttitude.size > PARTIALS_NO_ATTITUDE_MAX) {
            const oldest = partialsNoAttitude.values().next();
            if (!oldest.done) partialsNoAttitude.delete(oldest.value);
          }
        }
        const text = extractTextFromPartial(p);
        if (text) cappedMapSet(markerProfileText, id, text, MARKER_PROFILE_TEXT_MAX);
        const lastActive = extractLastActiveFromPartial(p);
        if (lastActive > 0) cappedMapSet(markerLastActive, id, lastActive, MARKER_LAST_ACTIVE_MAX);
      }
      if (attitudeCount > 0) {
        console.log(`[Aggregaytor:MapFilters] Partials: fetched ${attitudeCount} attitudes (of ${ids.length} requested)`);
        requestAnimationFrame(applyFilters);
      }
      return;
    } catch {
      // Try next endpoint
    }
  }
  partialsEndpointFailCount++;
  if (partialsEndpointFailCount >= 3) {
    const curIdx = PARTIALS_ENDPOINTS.indexOf(partialsPreferredEndpoint);
    partialsPreferredEndpoint = PARTIALS_ENDPOINTS[(curIdx + 1) % PARTIALS_ENDPOINTS.length];
    partialsEndpointFailCount = 0;
  }
}

/**
 * Scan the current marker set and request partials for any IDs where we
 * don't yet know the attitude. Runs on an interval; the rate limiter in
 * fetchPartialsForIds ensures we don't hit the Sniffies API too hard.
 */
function tickPartialsPrefetch(): void {
  if (!filterEnabled) return;
  // Only prefetch when a position-based filter is actually on — no point
  // hitting the API otherwise. Checks the chips users actually toggle.
  const anyPositionFilter =
    settings.hideBottom || settings.hideVersBottom || settings.hideVers ||
    settings.hideVersTop || settings.hideTop || settings.hideSide ||
    settings.hideUnspecified ||
    settings.highlightBottom || settings.highlightVersBottom || settings.highlightVers ||
    settings.highlightVersTop || settings.highlightTop;
  if (!anyPositionFilter) return;

  const now = Date.now();
  const batch: string[] = [];
  for (const id of idToMarker.keys()) {
    if (batch.length >= PARTIALS_BATCH) break;
    if (markerAttitudes.has(id)) continue;
    if (manualAttitudes.has(id)) continue;
    if (partialsFetchInFlight.has(id)) continue;
    if (partialsNoAttitude.has(id)) continue;
    const retry = partialsRetryAt.get(id) || 0;
    if (retry > now) continue;
    batch.push(id);
    partialsFetchInFlight.add(id);
  }
  if (!batch.length) return;
  fetchPartialsForIds(batch).finally(() => {
    for (const id of batch) {
      partialsFetchInFlight.delete(id);
      // If we still don't have attitude after the fetch, back off before retrying
      if (!markerAttitudes.has(id) && !partialsNoAttitude.has(id)) {
        partialsRetryAt.set(id, Date.now() + PARTIALS_FAIL_COOLDOWN_MS);
        if (partialsRetryAt.size > PARTIALS_RETRY_AT_MAX) {
          const oldest = partialsRetryAt.keys().next();
          if (!oldest.done) partialsRetryAt.delete(oldest.value);
        }
      }
    }
  });
}

// ── Initialization ─────────────────────────────────────────────────────────

export function initMapFilters(): void {
  injectStyles();
  loadSettings();
  setupClickHandlers();
  filterEnabled = true;

  // Load manual attitude overrides from localStorage
  try {
    const raw = localStorage.getItem('aggregaytor_manual_attitudes');
    if (raw) {
      const entries = JSON.parse(raw);
      if (Array.isArray(entries)) {
        for (const [k, v] of entries) manualAttitudes.set(k, v);
      }
    }
  } catch {}

  // Seed chat activity from cache written by the bridge.
  //
  // Current format: { [profileId]: { my: number, them: number } }
  // Legacy format 1 (v0.57.21): { [profileId]: { ts: number, dir: 'in'|'out' } }
  // Legacy format 2 (v0.57.20): { [profileId]: number }
  //
  // Without this seed, the chat-history filters would only know about
  // messages received during this session — historical chats would slip
  // through until the adapter happens to re-emit them.
  try {
    const raw = localStorage.getItem('aggregaytor_sniffies_chat_ts');
    if (raw) {
      const map = JSON.parse(raw);
      if (map && typeof map === 'object') {
        for (const [id, val] of Object.entries(map)) {
          const key = id.toLowerCase();
          if (val && typeof val === 'object') {
            const v = val as any;
            if (typeof v.my === 'number' || typeof v.them === 'number') {
              // Current richer format
              const a = getActivity(key);
              if (typeof v.my === 'number') a.myLastTs = v.my;
              if (typeof v.them === 'number') a.theirLastTs = v.them;
            } else if (typeof v.ts === 'number') {
              // Legacy {ts,dir} — map dir into my/their slot we know about
              const a = getActivity(key);
              if (v.dir === 'out') a.myLastTs = v.ts;
              else if (v.dir === 'in') a.theirLastTs = v.ts;
            }
          } else if (typeof val === 'number') {
            // Legacy plain-ts format (direction unknown). Stored in
            // theirLastTs so it still drives the age badge but never
            // triggers the waiting-on-response filter (which requires
            // myLastTs > 0).
            getActivity(key).theirLastTs = val;
          }
        }
      }
    }
  } catch {}

  // Start periodic scan — wrapped in rAF to avoid layout thrashing
  setInterval(() => requestAnimationFrame(applyFilters), SCAN_INTERVAL_MS);
  // Initial scan after DOM settles
  setTimeout(() => requestAnimationFrame(applyFilters), 3000);

  // v0.57.57: per-marker anti-FOUC. As soon as a marker enters the DOM,
  // the observer tags it with FRESH_CLASS (opacity:0). The applyFilters
  // tick that follows ~50ms later strips FRESH_CLASS — either replacing
  // it with HIDE_CLASS (filtered out, stays invisible) or letting the
  // marker fade back to native opacity (filtered in). No body-class,
  // no global default-hide — only the specific marker about to be
  // evaluated is briefly invisible.
  // Skipped entirely when no filter is active so the map looks 100%
  // native in that state.
  let _moDebounce: ReturnType<typeof setTimeout> | null = null;
  function anyFilterCurrentlyOn(): boolean {
    return settings.blockedIds.size > 0 ||
      (settings.excludeEnabled && settings.excludeTerms.length > 0) ||
      settings.hideRecentChats || settings.hideAnyChats ||
      settings.hideBottom || settings.hideVersBottom || settings.hideVers ||
      settings.hideVersTop || settings.hideTop || settings.hideSide || settings.hideUnspecified ||
      settings.hideInactiveOver2h;
  }
  function tagFresh(el: Element): void {
    if (!el.classList.contains(HIDE_CLASS) && !el.classList.contains(FRESH_CLASS)) {
      el.classList.add(FRESH_CLASS);
    }
  }
  try {
    const mo = new MutationObserver((mutations) => {
      // If no filter is active, do nothing — the map looks native.
      if (!anyFilterCurrentlyOn()) return;
      let saw = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;
          // Tag the new marker (or each marker descendant of an added
          // wrapper) with FRESH_CLASS synchronously so it's invisible
          // before the browser's next paint. applyFilters runs ~50ms
          // later and decides hide-vs-fade-in.
          if (el.classList?.contains('maplibregl-marker') ||
              el.classList?.contains('marker-container')) {
            tagFresh(el); saw = true;
          }
          el.querySelectorAll?.('.maplibregl-marker, .marker-container').forEach(tagFresh);
          if (el.querySelector?.('.maplibregl-marker') || el.querySelector?.('.marker-container')) saw = true;
        }
      }
      if (!saw) return;
      if (_moDebounce) return;
      _moDebounce = setTimeout(() => {
        _moDebounce = null;
        requestAnimationFrame(applyFilters);
      }, 50); // bursts of fresh markers collapse into one scan
    });
    mo.observe(document.body || document.documentElement, {
      childList: true, subtree: true,
    });
  } catch (err) {
    console.warn('[Aggregaytor:MapFilters] MutationObserver setup failed:', (err as Error).message);
  }

  // Partials prefetcher — keeps markerAttitudes populated so position
  // filters work for profiles the user hasn't manually opened yet.
  // Rate-limited internally; runs only when a position chip is on.
  setInterval(tickPartialsPrefetch, 4000);
  setTimeout(tickPartialsPrefetch, 5000);

  // v0.57.58 one-shot recovery: aggressively strip every aggregaytor-
  // injected class from every element in the DOM so a stale extension
  // build (v0.57.55/56 default-hide leftovers, etc) can't keep markers
  // invisible. Done up-front, before the first applyFilters tick.
  // v0.57.60: optional chain — sniffies.js is injected at
  // document_start before <body> exists, so document.body can be null
  // here. The recovery is harmless to skip in that case (a freshly
  // loaded page has no aggregaytor classes to recover from yet).
  document.body?.classList.remove(FILTERING_BODY_CLASS);
  document.querySelectorAll(
    `.${SHOW_CLASS}, .${FRESH_CLASS}, .${HIDE_CLASS}, .${HIGHLIGHT_CLASS}, .${HIGHLIGHT_ATTITUDE_CLASS}`
  ).forEach((el) => {
    el.classList.remove(SHOW_CLASS, FRESH_CLASS, HIDE_CLASS, HIGHLIGHT_CLASS, HIGHLIGHT_ATTITUDE_CLASS);
    // Belt-and-suspenders: clear any lingering inline opacity:0 from
    // older builds that wrote it directly.
    if ((el as HTMLElement).style?.opacity === '0') {
      (el as HTMLElement).style.opacity = '';
    }
  });

  // v0.57.62: detached-element prune. idToMarker and badgeElements hold raw
  // HTMLElement refs; when Sniffies's MapLibre layer rebuilds (zoom, filter,
  // re-render) the old DOM nodes are removed but our Map keeps strong refs,
  // preventing GC of entire marker subtrees. Every 60s walk both Maps and
  // drop entries whose element is no longer in the live tree. Cheap (just
  // document.body.contains checks) and reclaims megabytes per hour for heavy
  // map-browsing sessions.
  setInterval(() => {
    if (!document.body) return;
    let prunedMarkers = 0, prunedBadges = 0;
    for (const [id, el] of idToMarker) {
      if (!document.body.contains(el)) {
        idToMarker.delete(id);
        prunedMarkers++;
      }
    }
    for (const [id, el] of badgeElements) {
      if (!document.body.contains(el)) {
        badgeElements.delete(id);
        prunedBadges++;
      }
    }
    if (prunedMarkers > 0 || prunedBadges > 0) {
      console.log(`[Aggregaytor:MapFilters] detach-prune: ${prunedMarkers} markers, ${prunedBadges} badges`);
    }
  }, 60_000);

  // v0.57.62: visibility-driven offload. When the tab is hidden (other tab
  // foregrounded, sidebar collapsed, window minimized), we keep growing the
  // chatPreviews / markerProfileText / markerLastActive Maps while the user
  // can't even see the map. After 5 min hidden, dump the half-most-recent
  // entries — they re-populate from adapter scrapes on visibility return
  // within a few seconds. Cheap insurance against day-long-tab bloat.
  let hiddenSinceMs = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenSinceMs = Date.now();
    } else {
      hiddenSinceMs = 0;
    }
  });
  setInterval(() => {
    if (!hiddenSinceMs) return;
    if (Date.now() - hiddenSinceMs < 5 * 60_000) return;
    // Trim each cache to half its current size, dropping insertion-order-oldest.
    const trim = <V,>(m: Map<string, V>, name: string) => {
      if (m.size < 100) return; // tiny — not worth the work
      const target = Math.floor(m.size / 2);
      const it = m.keys();
      let drop = m.size - target;
      while (drop-- > 0) { const n = it.next(); if (n.done) break; m.delete(n.value as string); }
      console.log(`[Aggregaytor:MapFilters] hidden-tab trim: ${name} → ${m.size}`);
    };
    trim(chatPreviews, 'chatPreviews');
    trim(markerProfileText, 'markerProfileText');
    trim(markerLastActive, 'markerLastActive');
    // Reset the timer so the next trim is another 5 min away — without
    // this we'd keep halving every minute.
    hiddenSinceMs = Date.now();
  }, 60_000);

  // v0.57.62: respond to memory inspection requests from the bridge so the
  // side panel's Memory tab can show per-cache sizes for the MAIN-world map
  // filter state. Synchronous reply via postMessage; the bridge forwards to
  // chrome.storage.session for the SW to read on demand.
  function buildMemoryReport(): Record<string, number> {
    return {
      idToMarker: idToMarker.size,
      markerAttitudes: markerAttitudes.size,
      manualAttitudes: manualAttitudes.size,
      markerProfileText: markerProfileText.size,
      markerLastActive: markerLastActive.size,
      chatActivity: chatActivity.size,
      chatPreviews: chatPreviews.size,
      badgeElements: badgeElements.size,
      hideHistory: hideHistory.length,
      blockedIds: settings.blockedIds.size,
    };
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== '__aggregaytor_memory_request') return;
    window.postMessage(
      { type: '__aggregaytor_memory_response', caches: buildMemoryReport() },
      '*',
    );
  });

  console.log('[Aggregaytor:MapFilters] Initialized — scanning every 5s + DOM observer for new markers');
}
