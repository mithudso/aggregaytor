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
  // Manual blocks
  blockedIds: Set<string>;
}

interface MarkerInfo {
  element: HTMLElement;
  profileId: string;
  attitude?: string;
  lastChatTs?: number;
  profileText?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 5000;
const HIDE_CLASS = 'aggregaytor-hide';
const HIGHLIGHT_CLASS = 'aggregaytor-highlight';
const HIGHLIGHT_ATTITUDE_CLASS = 'aggregaytor-highlight-attitude';
const BADGE_CLASS = 'aggregaytor-chat-badge';
const STORAGE_KEY = 'aggregaytor_map_filter_settings';
const BLOCKED_KEY = 'aggregaytor_map_blocked';

// ── State ──────────────────────────────────────────────────────────────────

const idToMarker = new Map<string, HTMLElement>();
const markerAttitudes = new Map<string, string>();
const markerProfileText = new Map<string, string>();
const chatTimestamps = new Map<string, number>(); // profileId → last chat ms
const badgeElements = new Map<string, HTMLElement>(); // profileId → badge div

let settings: MapFilterSettings = {
  hideBottom: false, hideVersBottom: false, hideVers: false,
  hideVersTop: false, hideTop: false, hideSide: false, hideUnspecified: false,
  highlightBottom: false, highlightVersBottom: false, highlightVers: false,
  highlightVersTop: false, highlightTop: false,
  excludeTerms: [], includeTerms: [],
  excludeEnabled: false, includeEnabled: false,
  showChatAgeBadges: false,
  blockedIds: new Set(),
};

let filterEnabled = false;

// ── CSS Injection ──────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('aggregaytor-map-filter-css')) return;
  const style = document.createElement('style');
  style.id = 'aggregaytor-map-filter-css';
  style.textContent = `
    .${HIDE_CLASS} {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
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
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ── Marker Scanning ────────────────────────────────────────────────────────

function resolveMarkerRoot(el: HTMLElement): HTMLElement | null {
  return el.closest('.maplibregl-marker') as HTMLElement || null;
}

function extractIdFromElement(el: HTMLElement): string {
  // Try background-image URL on the element or children
  const targets = [el, ...el.querySelectorAll('.marker-avatar-image, [style*="sniffiesassets"]')];
  for (const target of targets) {
    const bg = (target as HTMLElement).style?.backgroundImage || '';
    const match = bg.match(/sniffiesassets\.com\/([0-9a-f]{6,})\//i);
    if (match) return match[1].toLowerCase();
  }
  // Try href
  const link = el.querySelector('a[href*="/profile/"]') || el.closest('a[href*="/profile/"]');
  if (link) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/profile\/([0-9a-f]{6,})/i);
    if (match) return match[1].toLowerCase();
  }
  return '';
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

  // Clean up removed markers
  for (const [id, el] of idToMarker) {
    if (!currentIds.has(id) || !document.body.contains(el)) {
      idToMarker.delete(id);
      const badge = badgeElements.get(id);
      if (badge) { badge.remove(); badgeElements.delete(id); }
    }
  }
}

// ── Attitude Detection ─────────────────────────────────────────────────────

function normalizeAttitude(att: string): string {
  const lower = (att || '').toLowerCase().trim();
  if (lower.includes('dom top') || lower.includes('breeder')) return 'dom top breeder';
  if (lower.includes('passive top')) return 'passive top';
  if (lower.includes('vers top')) return 'vers top';
  if (lower.includes('power bottom')) return 'power bottom';
  if (lower.includes('submissive bottom')) return 'submissive bottom';
  if (lower.includes('vers bottom')) return 'vers bottom';
  if (lower === 'top') return 'top';
  if (lower === 'bottom') return 'bottom';
  if (lower === 'vers' || lower === 'versatile') return 'vers';
  if (lower === 'side') return 'side';
  return lower || 'unspecified';
}

function shouldHideAttitude(att: string): boolean {
  const norm = normalizeAttitude(att);
  if (norm === 'bottom' && settings.hideBottom) return true;
  if (norm === 'vers bottom' && settings.hideVersBottom) return true;
  if (norm === 'vers' && settings.hideVers) return true;
  if (norm === 'vers top' && settings.hideVersTop) return true;
  if (norm === 'top' && settings.hideTop) return true;
  if (norm === 'side' && settings.hideSide) return true;
  if (norm === 'unspecified' && settings.hideUnspecified) return true;
  return false;
}

function shouldHighlightAttitude(att: string): boolean {
  const norm = normalizeAttitude(att);
  if (norm === 'bottom' && settings.highlightBottom) return true;
  if (norm === 'vers bottom' && settings.highlightVersBottom) return true;
  if (norm === 'vers' && settings.highlightVers) return true;
  if (norm === 'vers top' && settings.highlightVersTop) return true;
  if (norm === 'top' && settings.highlightTop) return true;
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
  const chatTs = chatTimestamps.get(id);
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
  badge.textContent = formatAge(age);
  badge.style.display = '';
}

// ── Main Filter Pass ───────────────────────────────────────────────────────

function applyFilters(): void {
  if (!filterEnabled) return;
  scanMarkers();

  for (const [id, marker] of idToMarker) {
    // Remove all classes first
    marker.classList.remove(HIDE_CLASS, HIGHLIGHT_CLASS, HIGHLIGHT_ATTITUDE_CLASS);

    // Priority 1: manually blocked
    if (settings.blockedIds.has(id)) {
      marker.classList.add(HIDE_CLASS);
      continue;
    }

    // Priority 2: exclude terms
    if (settings.excludeEnabled && settings.excludeTerms.length) {
      const text = markerProfileText.get(id) || '';
      if (matchesTerms(text, settings.excludeTerms)) {
        marker.classList.add(HIDE_CLASS);
        continue;
      }
    }

    // Priority 3: attitude hiding
    const att = markerAttitudes.get(id) || 'unspecified';
    if (shouldHideAttitude(att)) {
      marker.classList.add(HIDE_CLASS);
      continue;
    }

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
  }
}

// ── Click Handlers ─────────────────────────────────────────────────────────

function setupClickHandlers(): void {
  // Middle-click on map marker = quick hide
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return; // middle click only
    const marker = resolveMarkerRoot(e.target as HTMLElement);
    if (!marker) return;
    const id = extractIdFromElement(marker);
    if (!id) return;

    e.preventDefault();
    e.stopPropagation();
    settings.blockedIds.add(id);
    marker.classList.add(HIDE_CLASS);
    saveBlockedIds();
    // Notify bridge for aggregator tracking
    window.dispatchEvent(new CustomEvent('__aggregaytor_message', {
      detail: JSON.parse(JSON.stringify({
        type: 'PROFILE_BLOCKED',
        contactId: `sniffies:${id}`,
        platform: 'sniffies',
      })),
    }));
  }, true);

  // Shift+click on map marker = toggle block
  document.addEventListener('click', (e) => {
    if (!e.shiftKey) return;
    const marker = resolveMarkerRoot(e.target as HTMLElement);
    if (!marker) return;
    const id = extractIdFromElement(marker);
    if (!id) return;

    e.preventDefault();
    e.stopPropagation();
    if (settings.blockedIds.has(id)) {
      settings.blockedIds.delete(id);
      marker.classList.remove(HIDE_CLASS);
    } else {
      settings.blockedIds.add(id);
      marker.classList.add(HIDE_CLASS);
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
      Object.assign(settings, parsed);
      if (Array.isArray(parsed.blockedIds)) {
        settings.blockedIds = new Set(parsed.blockedIds);
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
  Object.assign(settings, update);
  if (Array.isArray(update.blockedIds)) {
    settings.blockedIds = new Set(update.blockedIds);
  }
  // Persist
  try {
    const toSave = { ...settings, blockedIds: [...settings.blockedIds] };
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
      markerAttitudes.set(id, String(c.metadata.position || c.metadata.attitude));
    }
    if (c.metadata?.profileText) {
      markerProfileText.set(id, String(c.metadata.profileText));
    }
  }
}) as EventListener);

// Chat timestamp updates from adapter messages
window.addEventListener('__aggregaytor_chat_timestamp', ((event: CustomEvent) => {
  const { profileId, timestamp } = event.detail || {};
  if (profileId && timestamp) {
    chatTimestamps.set(profileId.toLowerCase(), timestamp);
  }
}) as EventListener);

// ── Initialization ─────────────────────────────────────────────────────────

export function initMapFilters(): void {
  injectStyles();
  loadSettings();
  setupClickHandlers();
  filterEnabled = true;

  // Start periodic scan
  setInterval(applyFilters, SCAN_INTERVAL_MS);
  // Initial scan after DOM settles
  setTimeout(applyFilters, 3000);

  console.log('[Aggregaytor:MapFilters] Initialized — scanning every 5s');
}
