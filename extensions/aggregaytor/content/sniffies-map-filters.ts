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
const manualAttitudes = new Map<string, string>(); // user-corrected attitudes
const markerProfileText = new Map<string, string>();
const chatTimestamps = new Map<string, number>(); // profileId → last chat ms
const chatPreviews = new Map<string, Array<{ dir: string; text: string; ts: number }>>(); // recent messages
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
  // Try background-image URL on the element or children — check both
  // inline style AND computed style (Sniffies may set it via CSS class)
  const targets = [el, ...el.querySelectorAll('.marker-avatar-image, [style*="sniffiesassets"], [class*="avatar"], [class*="marker"]')];
  for (const target of targets) {
    // Check inline style first (faster)
    let bg = (target as HTMLElement).style?.backgroundImage || '';
    // Fall back to computed style if inline is empty
    if (!bg || !bg.includes('sniffiesassets')) {
      try { bg = getComputedStyle(target).backgroundImage || ''; } catch {}
    }
    const match = bg.match(/sniffiesassets\.com\/([0-9a-f]{6,})\//i);
    if (match) return match[1].toLowerCase();
  }
  // Try href on any link in or near the element
  const link = el.querySelector('a[href*="/profile/"]') || el.closest('a[href*="/profile/"]');
  if (link) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/profile\/([0-9a-f]{6,})/i);
    if (match) return match[1].toLowerCase();
  }
  // Try data attributes
  for (const attr of ['data-profile-id', 'data-user-id', 'data-cruiser-id']) {
    const val = el.getAttribute(attr) || el.querySelector(`[${attr}]`)?.getAttribute(attr) || '';
    if (val && /^[0-9a-f]{6,}$/i.test(val)) return val.toLowerCase();
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

    // Priority 3: attitude hiding (uses manual override if set)
    const att = getEffectiveAttitude(id);
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

    // Hover preview bindings (chat preview popup)
    ensureHoverBindings(id, marker);
  }
}

// ── Click Handlers ─────────────────────────────────────────────────────────

function setupClickHandlers(): void {
  // Middle-click behavior:
  // - On map marker → quick-hide the profile
  // - In/near chat input → quick-send first available phrase
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return; // middle click only

    // Check if we're in a chat area (not on a map marker)
    const target = e.target as HTMLElement;
    const chatArea = target.closest('[class*="chat"], [class*="message"], [class*="conversation"]');
    const marker = resolveMarkerRoot(target);

    // If in a chat area and NOT on a marker → quick-send a phrase
    if (chatArea && !marker) {
      e.preventDefault();
      // Get a quick phrase from localStorage
      try {
        const phrases = JSON.parse(localStorage.getItem('aggregaytor_quick_phrases') || '[]');
        // Only use quick phrases — NOT text substitutions (those include
        // long entries like parking directions that shouldn't be auto-sent)
        const phrase = phrases[0] || '';
        if (phrase) {
          // Dispatch auto-send event (handled by sniffies.ts)
          window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
            detail: { text: phrase },
          }));
        }
      } catch {}
      return;
    }

    // On map marker → quick-hide
    if (!marker) return;
    const id = extractIdFromElement(marker);
    if (!id) return;

    e.preventDefault();
    e.stopPropagation();
    settings.blockedIds.add(id);
    hideHistory.push(id); // track for undo
    if (hideHistory.length > 50) hideHistory.shift(); // cap history
    marker.classList.add(HIDE_CLASS);
    hideChatPreview(); // dismiss any visible preview
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

// Chat timestamp + preview updates from adapter messages
window.addEventListener('__aggregaytor_chat_timestamp', ((event: CustomEvent) => {
  const { profileId, timestamp, body, direction } = event.detail || {};
  if (!profileId || !timestamp) return;
  const id = profileId.toLowerCase();
  chatTimestamps.set(id, timestamp);
  // Also store message for chat preview popup
  if (body) {
    if (!chatPreviews.has(id)) chatPreviews.set(id, []);
    const msgs = chatPreviews.get(id)!;
    msgs.push({ dir: direction || 'in', text: String(body).slice(0, 100), ts: timestamp });
    // Keep only last 20 messages per contact
    if (msgs.length > 20) msgs.splice(0, msgs.length - 20);
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
  manualAttitudes.set(profileId.toLowerCase(), attitude);
  // Persist
  try {
    localStorage.setItem('aggregaytor_manual_attitudes', JSON.stringify([...manualAttitudes.entries()]));
  } catch {}
  applyFilters();
}) as EventListener);

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

  // Start periodic scan
  setInterval(applyFilters, SCAN_INTERVAL_MS);
  // Initial scan after DOM settles
  setTimeout(applyFilters, 3000);

  console.log('[Aggregaytor:MapFilters] Initialized — scanning every 5s');
}
