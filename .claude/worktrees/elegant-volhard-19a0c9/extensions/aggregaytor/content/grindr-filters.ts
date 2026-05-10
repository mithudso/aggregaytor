/**
 * grindr-filters.ts — Client-side cascade grid filtering for Grindr.
 *
 * Filters profiles in the Grindr cascade grid by hiding/showing DOM cards
 * based on profile data intercepted from the cascade API response.
 * Each filter can be INCLUSIVE (show only matching) or EXCLUSIVE (hide matching).
 *
 * Works by:
 * 1. Intercepting cascade API responses to build profileId → data map
 * 2. Mapping img src hashes to profile data
 * 3. Periodically scanning visible cards and applying hide/show CSS
 */

// ── Grindr Enum Mappings ───────────────────────────────────────────────────

export const ETHNICITY_MAP: Record<number, string> = {
  1: 'Not specified',
  2: 'Asian',
  3: 'Black',
  4: 'Latino',
  5: 'Middle Eastern',
  6: 'Mixed',
  7: 'White',
  8: 'Other',
  9: 'South Asian',
  10: 'Native American',
};

export const GENDER_MAP: Record<number, string> = {
  1: 'Cis Man',
  2: 'Cis Woman',
  3: 'Trans Man',
  4: 'Trans Woman',
  5: 'Non-Binary',
  6: 'Non-Conforming',
  7: 'Queer',
  8: 'Crossdresser',
  15: 'Two-Spirit',
};

// ── Types ──────────────────────────────────────────────────────────────────

interface GrindrProfile {
  profileId: string;
  ethnicity: number;
  genders: number[];
  sexualPosition: number;
  hasChattedInLast24Hrs: boolean;
  aboutMe: string;
  displayName: string;
  photoHashes: string[];
}

type FilterMode = 'off' | 'include' | 'exclude';

interface GrindrFilterSettings {
  // Ethnicity filter: which ethnicities to include/exclude
  ethnicityFilter: FilterMode;
  ethnicityValues: number[]; // ethnicity IDs selected

  // Gender filter: hide trans, female, etc.
  genderFilter: FilterMode;
  genderValues: number[]; // gender IDs selected

  // Never chatted filter
  neverChattedFilter: FilterMode; // 'include' = show only never-chatted

  // Keyword profile text filter
  keywordFilter: FilterMode;
  keywords: string[]; // keywords to match in aboutMe

  // Auto-block: call the Grindr hide API for profiles matching filters
  autoBlock: boolean;

  enabled: boolean;
}

// ── State ──────────────────────────────────────────────────────────────────

const profileMap = new Map<string, GrindrProfile>();
const PROFILE_MAP_MAX = 5000;
const hashToProfile = new Map<string, string>();
const HASH_TO_PROFILE_MAX = 10_000;
const HIDE_CLASS = 'aggregaytor-grindr-hide';
const STORAGE_KEY = 'aggregaytor_grindr_filter_settings';

let settings: GrindrFilterSettings = {
  ethnicityFilter: 'off',
  ethnicityValues: [],
  genderFilter: 'off',
  genderValues: [],
  neverChattedFilter: 'off',
  keywordFilter: 'off',
  keywords: [],
  autoBlock: false,
  enabled: false,
};

// Track which profiles we've already auto-blocked this session
// (so we don't spam the hide API on every filter pass)
const autoBlockedThisSession = new Set<string>();
const AUTO_BLOCKED_MAX = 2000;

// ── CSS Injection ──────────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('aggregaytor-grindr-filter-css')) return;
  const style = document.createElement('style');
  style.id = 'aggregaytor-grindr-filter-css';
  style.textContent = `
    .${HIDE_CLASS} {
      display: none !important;
      visibility: hidden !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ── Profile Indexing ───────────────────────────────────────────────────────

export function indexGrindrProfile(obj: Record<string, unknown>): void {
  const pid = String(obj.profileId || '');
  if (!pid || !/^\d+$/.test(pid)) return;

  const profile: GrindrProfile = {
    profileId: pid,
    ethnicity: Number(obj.ethnicity || 0),
    genders: ((obj.genders || []) as any[]).map(g =>
      typeof g === 'object' ? Number(g.id || 0) : Number(g || 0)
    ),
    sexualPosition: Number(obj.sexualPosition || 0),
    hasChattedInLast24Hrs: !!obj.hasChattedInLast24Hrs,
    aboutMe: String(obj.aboutMe || ''),
    displayName: String(obj.displayName || ''),
    photoHashes: [],
  };

  const hashes = obj.photoMediaHashes;
  if (Array.isArray(hashes)) {
    for (const h of hashes) {
      if (typeof h === 'string' && h.length > 10) {
        profile.photoHashes.push(h);
        hashToProfile.set(h, pid);
        if (hashToProfile.size > HASH_TO_PROFILE_MAX) {
          const oldest = hashToProfile.keys().next();
          if (!oldest.done) hashToProfile.delete(oldest.value);
        }
      }
    }
  }

  profileMap.set(pid, profile);
  if (profileMap.size > PROFILE_MAP_MAX) {
    const oldest = profileMap.keys().next();
    if (!oldest.done) profileMap.delete(oldest.value);
  }
}

// ── Filter Logic ───────────────────────────────────────────────────────────

function shouldHideProfile(profile: GrindrProfile): boolean {
  if (!settings.enabled) return false;

  // Ethnicity filter
  if (settings.ethnicityFilter !== 'off' && settings.ethnicityValues.length > 0) {
    const matches = settings.ethnicityValues.includes(profile.ethnicity);
    if (settings.ethnicityFilter === 'include' && !matches) return true;
    if (settings.ethnicityFilter === 'exclude' && matches) return true;
  }

  // Gender filter
  if (settings.genderFilter !== 'off' && settings.genderValues.length > 0) {
    const profileGenders = profile.genders;
    const matches = settings.genderValues.some(g => profileGenders.includes(g));
    if (settings.genderFilter === 'include' && !matches) return true;
    if (settings.genderFilter === 'exclude' && matches) return true;
  }

  // Never chatted filter
  if (settings.neverChattedFilter === 'include' && profile.hasChattedInLast24Hrs) return true;
  if (settings.neverChattedFilter === 'exclude' && !profile.hasChattedInLast24Hrs) return true;

  // Keyword filter
  if (settings.keywordFilter !== 'off' && settings.keywords.length > 0) {
    const text = (profile.aboutMe + ' ' + profile.displayName).toLowerCase();
    const matches = settings.keywords.some(kw => text.includes(kw.toLowerCase()));
    if (settings.keywordFilter === 'include' && !matches) return true;
    if (settings.keywordFilter === 'exclude' && matches) return true;
  }

  return false;
}

// ── DOM Filtering ──────────────────────────────────────────────────────────

let _lastGrindrFilterSig = '';

function applyFilters(): void {
  if (!settings.enabled) return;

  const cards = document.querySelectorAll('[data-testid="cascadeCellContainer"]');
  let nCards = 0, nHidden = 0, nResolved = 0;
  for (const card of cards) {
    nCards++;
    const img = card.querySelector('img[src*="cdns.grindr.com"]');
    if (!img) { continue; }
    const src = (img as HTMLImageElement).src;

    const hashMatch = src.match(/\/([a-f0-9]{32,})/i);
    if (!hashMatch) continue;

    const profileId = hashToProfile.get(hashMatch[1]);
    if (!profileId) continue;
    nResolved++;

    const profile = profileMap.get(profileId);
    if (!profile) continue;

    if (shouldHideProfile(profile)) {
      (card as HTMLElement).classList.add(HIDE_CLASS);
      nHidden++;
      if (settings.autoBlock && !autoBlockedThisSession.has(profileId)) {
        autoBlockedThisSession.add(profileId);
        if (autoBlockedThisSession.size > AUTO_BLOCKED_MAX) {
          const oldest = autoBlockedThisSession.values().next();
          if (!oldest.done) autoBlockedThisSession.delete(oldest.value);
        }
        window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
          detail: { profileId },
        }));
      }
    } else {
      (card as HTMLElement).classList.remove(HIDE_CLASS);
    }
  }

  if (nHidden > 0) {
    const sig = `${nCards}/${nResolved}/${nHidden}`;
    if (sig !== _lastGrindrFilterSig) {
      _lastGrindrFilterSig = sig;
      console.log(`[Aggregaytor:GrindrFilters] ${nHidden}/${nCards} cards hidden (${nResolved} resolved, ${profileMap.size} indexed)`);
    }
  }
}

// ── Settings ───────────────────────────────────────────────────────────────

function loadSettings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch {}
}

window.addEventListener('__aggregaytor_grindr_filter_settings', ((event: CustomEvent) => {
  const update = event.detail;
  if (!update) return;
  Object.assign(settings, update);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {}
  applyFilters();
}) as EventListener);

// ── Init ───────────────────────────────────────────────────────────────────

export function initGrindrFilters(): void {
  injectStyles();
  loadSettings();
  // Apply filters periodically (cascade cards load dynamically)
  setInterval(applyFilters, 3000);
  setTimeout(applyFilters, 2000);
  console.log('[Aggregaytor:GrindrFilters] Initialized');
}
