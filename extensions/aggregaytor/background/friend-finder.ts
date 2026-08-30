/**
 * friend-finder.ts — paced intro-greeting workflow.
 *
 * v0.57.50: introduce the user to nearby profiles passing their filters
 * who they've never chatted with. Workflow:
 *   1. User toggles FF on → opens panel modal.
 *   2. Build phase: scan contacts + thread metas, apply filters,
 *      rank by distance, return top N. Excludes a permanent ignore
 *      list so the user never sees the same dismissed profile twice.
 *   3. Approve phase: user deselects anyone they don't want; deselected
 *      contactIds get added to the ignore list permanently.
 *   4. Run phase: paced send loop driven by chrome.alarms with a
 *      jittered gap between sends (default 90s ± 30%). Each send goes
 *      through the existing SEND_GREETING handler which already adds
 *      a 5-15s human-delay before hitting the platform tab. Combined
 *      pacing keeps us well under any platform's rate-limit.
 *   5. Stop button immediately clears the alarm + queue.
 *
 * State lives in chrome.storage.local. Run state lives in
 * chrome.storage.session so it survives SW death within a session.
 */

const FF_STATE_KEY = 'aggregaytor_friend_finder_v1';
const FF_RUN_KEY = 'aggregaytor_friend_finder_run_v1';
const FF_ALARM_NAME = 'friend-finder-tick';

export interface FFFilters {
  inheritMapFilters: boolean;
  requireNeverChatted: boolean;
  requireZeroDeletes: boolean;
  requireCurrentlyActive: boolean;
  respectPreferences: boolean;
  activeWindowMinutes: number;
  maxDistanceMiles: number;
  maxCandidates: number;
  paceSeconds: number;
  paceJitterPercent: number;
  // v0.57.51: skip the approve step entirely. When true, FF_BUILD_CANDIDATES
  // returns the ranked list AND the panel immediately calls FF_APPROVE_RUN
  // with every candidate checked. No deselection step, no permanent-ignore
  // additions for this run. Useful when the user already trusts their
  // filter set and just wants to fire the queue.
  autoApprove: boolean;
}

export interface FFCandidate {
  contactId: string;
  platform: string;
  displayName: string;
  avatarUrl: string;
  stats: string;            // pre-rendered "30m, 5'9", vers" line
  distance: number;         // miles, 9999 if unknown
  lastActiveTs: number;     // 0 if unknown
}

export interface FFRunState {
  state: 'idle' | 'building' | 'awaiting-approval' | 'running' | 'stopped' | 'done';
  queue: FFCandidate[];           // remaining to send
  approved: FFCandidate[];        // original approved list (for stats)
  sentCount: number;
  failedCount: number;
  startedAt: number;
  lastSendAt: number;
  nextSendAt: number;
}

export interface FFState {
  filters: FFFilters;
  ignoreList: string[];           // permanently-ignored contactIds
  enabled: boolean;
  lastRunAt: number;
}

const DEFAULT_FILTERS: FFFilters = {
  inheritMapFilters: true,
  requireNeverChatted: true,
  requireZeroDeletes: true,
  requireCurrentlyActive: true,
  respectPreferences: true,
  activeWindowMinutes: 30,
  maxDistanceMiles: 0,
  maxCandidates: 50,
  paceSeconds: 90,
  paceJitterPercent: 30,
  autoApprove: false, // off by default — review-first is the safer default
};

export async function getFFState(): Promise<FFState> {
  try {
    const got = await chrome.storage.local.get(FF_STATE_KEY);
    const stored = got?.[FF_STATE_KEY];
    if (stored && typeof stored === 'object') {
      return {
        filters: { ...DEFAULT_FILTERS, ...(stored.filters || {}) },
        ignoreList: Array.isArray(stored.ignoreList) ? stored.ignoreList : [],
        enabled: !!stored.enabled,
        lastRunAt: Number(stored.lastRunAt || 0),
      };
    }
  } catch {}
  return { filters: { ...DEFAULT_FILTERS }, ignoreList: [], enabled: false, lastRunAt: 0 };
}

export async function saveFFState(state: FFState): Promise<void> {
  try { await chrome.storage.local.set({ [FF_STATE_KEY]: state }); } catch {}
}

export async function updateFFFilters(patch: Partial<FFFilters>): Promise<FFState> {
  const s = await getFFState();
  s.filters = { ...s.filters, ...patch };
  await saveFFState(s);
  return s;
}

export async function addToIgnoreList(ids: string[]): Promise<FFState> {
  const s = await getFFState();
  const set = new Set(s.ignoreList);
  for (const id of ids) set.add(id);
  s.ignoreList = [...set];
  await saveFFState(s);
  return s;
}

const DEFAULT_RUN_STATE: FFRunState = {
  state: 'idle', queue: [], approved: [], sentCount: 0, failedCount: 0,
  startedAt: 0, lastSendAt: 0, nextSendAt: 0,
};

export async function getRunState(): Promise<FFRunState> {
  try {
    const got = await chrome.storage.session.get(FF_RUN_KEY);
    const stored = got?.[FF_RUN_KEY];
    if (stored && typeof stored === 'object') {
      // Normalise against the defaults rather than trusting the stored shape.
      // A state written by an older build (or a partially-written record) could
      // otherwise hand the alarm tick a non-array `queue`, and `queue.shift()`
      // would throw inside the alarm handler and strand the run.
      return {
        ...DEFAULT_RUN_STATE,
        ...stored,
        queue: Array.isArray(stored.queue) ? stored.queue : [],
        approved: Array.isArray(stored.approved) ? stored.approved : [],
        sentCount: Number(stored.sentCount) || 0,
        failedCount: Number(stored.failedCount) || 0,
      };
    }
  } catch {}
  return { ...DEFAULT_RUN_STATE };
}

export async function setRunState(runState: FFRunState): Promise<void> {
  try { await chrome.storage.session.set({ [FF_RUN_KEY]: runState }); } catch {}
}

/**
 * Apply filters to a list of contact docs and return ranked candidates.
 * Caller passes everything we need so this module stays pure-data.
 */
export function rankCandidates(
  contacts: Array<{ id: string; platform: string; displayName: string; avatarUrl: string; metadata: any; lastSeen?: string }>,
  metaByContactId: Map<string, { archived?: boolean; deletedChatCount?: number; blockedByThem?: boolean }>,
  hasMessagesByContactId: Set<string>,
  ignoreList: Set<string>,
  filters: FFFilters,
  mapFilterSettings: any,        // localStorage map filter settings; opaque
  preferenceScore: (c: any) => number, // 0..1, higher = better
  buildStatsLine: (md: any) => string,
): FFCandidate[] {
  const out: FFCandidate[] = [];
  const now = Date.now();
  for (const c of contacts) {
    const id = c.id;
    if (ignoreList.has(id)) continue;
    const meta = metaByContactId.get(id) || {};

    // Skip contacts that are blocked or archived (definitely don't intro to them)
    if (meta.archived) continue;
    if (meta.blockedByThem) continue;

    if (filters.requireNeverChatted && hasMessagesByContactId.has(id)) continue;
    if (filters.requireZeroDeletes && (meta.deletedChatCount || 0) > 0) continue;

    // Active filter — needs lastActive metadata
    let lastActiveTs = 0;
    if (filters.requireCurrentlyActive) {
      const md = c.metadata || {};
      const la = md.lastActive;
      if (typeof la === 'number' && la > 0) lastActiveTs = la;
      else if (c.lastSeen) lastActiveTs = Date.parse(c.lastSeen) || 0;
      if (!lastActiveTs) continue; // no signal — skip
      const ageMin = (now - lastActiveTs) / 60_000;
      if (ageMin > filters.activeWindowMinutes) continue;
    }

    // Distance filter
    const md = c.metadata || {};
    const dist = parseFloat(String(md.distance || '')) || 9999;
    if (filters.maxDistanceMiles > 0 && dist > filters.maxDistanceMiles) continue;

    // Map filter inheritance — applies position/text rules
    if (filters.inheritMapFilters && mapFilterSettings) {
      if (!passesMapFilters(c, mapFilterSettings)) continue;
    }

    // Preference score (ML model) — weights ranking but doesn't outright reject
    // unless the score is exceptionally low.
    let prefScore = 0.5;
    try { prefScore = preferenceScore(c); } catch {}
    if (filters.respectPreferences && prefScore < 0.2) continue;

    out.push({
      contactId: id,
      platform: c.platform,
      displayName: c.displayName || '',
      avatarUrl: c.avatarUrl || '',
      stats: buildStatsLine(md),
      distance: dist,
      lastActiveTs,
    });
  }

  // Rank: distance ascending, ties broken by lastActive descending.
  out.sort((a, b) => (a.distance - b.distance) || (b.lastActiveTs - a.lastActiveTs));
  return out.slice(0, Math.max(1, filters.maxCandidates));
}

/**
 * Apply the user's existing map-filter settings (position/text rules) to a contact.
 * Mirrors the logic in sniffies-map-filters.ts shouldHideAttitude / matchesTerms,
 * inverted (we INCLUDE iff the marker would NOT be hidden by current filters).
 */
function passesMapFilters(c: any, settings: any): boolean {
  const md = c.metadata || {};
  const att = String(md.attitude || md.position || '').toLowerCase();
  const text = String(md.profileText || '').toLowerCase();
  // Position hiding
  if (att) {
    if (att.includes('vers') && att.includes('bottom') && settings.hideVersBottom) return false;
    else if (att.includes('vers') && att.includes('top') && settings.hideVersTop) return false;
    else if (att.includes('vers') && settings.hideVers) return false;
    else if (att.includes('bottom') && settings.hideBottom) return false;
    else if ((att.includes('top') || att.includes('breeder')) && settings.hideTop) return false;
    else if (att.includes('side') && settings.hideSide) return false;
  } else if (settings.hideUnspecified) {
    return false;
  }
  // Text exclude
  if (settings.excludeEnabled && Array.isArray(settings.excludeTerms) && text) {
    for (const term of settings.excludeTerms) {
      if (term && text.includes(String(term).toLowerCase())) return false;
    }
  }
  return true;
}

/** Compute a jittered next-send delay in ms. */
export function nextDelayMs(filters: FFFilters): number {
  const baseMs = filters.paceSeconds * 1000;
  const jitter = baseMs * (filters.paceJitterPercent / 100);
  return Math.max(15_000, Math.round(baseMs + (Math.random() * 2 - 1) * jitter));
}

/** Estimate ms remaining for a queue. */
export function estimateRemainingMs(queueLen: number, filters: FFFilters): number {
  if (queueLen <= 0) return 0;
  return queueLen * filters.paceSeconds * 1000;
}

export const FF_ALARM = FF_ALARM_NAME;
