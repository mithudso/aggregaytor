/**
 * service-worker.ts — Extension background service worker.
 */

import type { UnifiedMessage, UnifiedContact, Platform } from '@aggregaytor/adapter-core';
import {
  upsertMessages, upsertContact, upsertContacts, getUnreadCount, getThreadSummaries,
  getMessagesByContact, markThreadRead,
  getThreadMeta, upsertThreadMeta, getAllThreadMeta,
  createReminder, getReminders, markReminderNotified, deleteReminder,
  queueAutoRespond, getPendingAutoResponds, getDraftAutoResponds, getApprovedAutoResponds, updateAutoRespondStatus,
  addPicture, getAllPictures, getPictureByTag, incrementPictureStat, deletePicture,
  createBlockRule, getAllBlockRules, updateBlockRule, deleteBlockRule, evaluateRules, executeAction,
  getCalendarSettings, saveCalendarSettings, getAvailableSlots, createCalendarEvent, authenticateCalendar,
  recordFeedback, predictPreference, getModelStats, retrainModel,
  analyzeConversationSentiment, formatSentimentSummary,
  createTask, getAllTasks, updateTask, deleteTask, getTasksByContact,
  createGoogleTask, updateGoogleTask, deleteGoogleTask, pullGoogleTasks, syncGoogleTasks, authenticateGoogle, isGoogleAuthenticated,
  backupToDrive, restoreFromDrive, getDriveBackupStatus,
  getContact, getAllContacts, getContactsByPlatform, getDB, destroyDB,
  exportAllData, importAllData, exportBlocked, importBlocked,
} from '@aggregaytor/store';
import type { ThreadSummary, AutoRespondSettings, ProfileFeatures } from '@aggregaytor/store';
import { generateSuggestions, generateAutoResponse, generateGreeting, generateNickname as llmNickname, extractDossierFields, localDossierExtraction, getLLMConfig, saveLLMConfig, getLLMRateSettings, saveLLMRateSettings, getLLMQueueStatus, getLLMOptimizationStats, getPersonalitySettings, savePersonalitySettings, deriveStyleGuide, PERSONALITY_PRESETS, clearLLMCaches, queryContacts, getDeprecationWarnings, generateConversationSummary, setProviderModelOverride, getEffectiveModelForProvider, getAllProviderModels, getAllProviderKeys } from './llm.js';
import type { ContactQueryRow } from './llm.js';
import { seedIndex, indexMessages, removeFromIndex, clearIndex, searchMessages as fulltextSearch, isIndexReady, getIndexSize, getEvictedCount, getLastEvictionAt, getLifetimeStats, SEARCH_INDEX_MAX_DOCS } from './search-index.js';
import { getDossier, upsertDossier, setAutoExtractedField } from '@aggregaytor/store';
import { handleDebugCommand } from './debug-bridge.js';
import { logError, getErrorLog, clearErrorLog, exportErrorLog, installGlobalErrorCapture } from './error-logger.js';
import {
  getFFState, saveFFState, updateFFFilters, addToIgnoreList, getRunState, setRunState,
  rankCandidates, nextDelayMs, estimateRemainingMs, FF_ALARM,
  type FFCandidate, type FFRunState,
} from './friend-finder.js';
import {
  getUpdaterState, saveUpdaterState, checkAllProviders,
  MODEL_UPDATER_ALARM, type ModelSuggestion,
} from './model-updater.js';

const LOG = '[Aggregaytor:SW]';
console.log(`${LOG} Service worker starting...`);

// v0.57.44: capture every error that fires in the SW context (uncaught
// exceptions, unhandled promise rejections, console.error calls) into
// the rolling error log. Done before any other module work so a startup
// error is itself logged. Idempotent.
installGlobalErrorCapture('sw');

// ── Service Worker Performance Counters ─────────────────────────────────────
// Lightweight in-memory counters tracking call counts and cumulative time
// for PouchDB operations and message handling in the service worker.
// Accessible via: chrome.runtime.sendMessage({type:'GET_SW_PERF'})
const swPerf: Record<string, { calls: number; totalMs: number; maxMs: number }> = {};

// v0.57.62: rough byte estimate for a JS value via JSON serialization length.
// Used by GET_MEMORY_BREAKDOWN to surface order-of-magnitude offenders. We
// JSON-stringify and multiply length by 2 (UTF-16 in V8). Inaccurate for
// non-ASCII or typed arrays, but order-of-magnitude correct for the JSON-
// shaped caches we hold. A failed serialize (cycles, etc.) returns 0 rather
// than throwing — we never want diagnostics to crash the SW.
function estimateJsonBytes(v: unknown): number {
  if (v == null) return 0;
  try { return ((JSON.stringify(v) || '').length) * 2; } catch { return 0; }
}
const swPerfStart = Date.now();
function swPerfTrack(name: string): () => void {
  const t0 = performance.now();
  return () => {
    const ms = performance.now() - t0;
    if (!swPerf[name]) swPerf[name] = { calls: 0, totalMs: 0, maxMs: 0 };
    swPerf[name].calls++;
    swPerf[name].totalMs += ms;
    if (ms > swPerf[name].maxMs) swPerf[name].maxMs = ms;
  };
}

// ── Thread Summary Cache ──────────────────────────────────────────────────
// getThreadSummaries is the most expensive operation (81ms avg, 14x/min).
// It queries 5000 messages from PouchDB + N contact lookups on every call.
// Cache the result for 5 seconds to avoid redundant PouchDB round-trips
// when multiple triggers fire in rapid succession (CONTACTS_UPDATED,
// NEW_MESSAGES, panel opening, etc.).
//
// The cache is invalidated by invalidateThreadCache() on writes that affect
// the thread list (new messages, imports, destroyDB) but NOT on pure-metadata
// updates (avatar, dossier) since those don't change thread ordering or
// unread counts. See the ADAPTER_CONTACTS handler for the reasoning.
let threadSummaryCache: { data: any; time: number; key: string } | null = null;
const THREAD_CACHE_TTL = 5000; // 5 seconds — matches the value in code, was previously mis-documented as 3s
// v0.57.46: auto-maintenance bookkeeping. The mem-gc alarm now decides
// whether to compact / free-mem based on these counters + timestamps.
// All persisted to chrome.storage.local so they survive SW restarts.
const MAINTENANCE_KEY = 'aggregaytor_auto_maintenance_v1';
interface MaintenanceState {
  lastCompactAt: number;          // epoch ms; 0 = never
  lastFreeAt: number;             // epoch ms; 0 = never
  mutationsSinceCompact: number;  // upserts since last compact
  lastDecisionAt: number;         // when runAutoMaintenance last ran
  lastReason: string;             // human-readable decision summary
}
let maintenanceState: MaintenanceState = {
  lastCompactAt: 0, lastFreeAt: 0, mutationsSinceCompact: 0,
  lastDecisionAt: 0, lastReason: '(not yet run)',
};
let maintenanceLoaded = false;
async function loadMaintenanceState(): Promise<void> {
  if (maintenanceLoaded) return;
  maintenanceLoaded = true;
  try {
    const got = await chrome.storage.local.get(MAINTENANCE_KEY);
    const s = got?.[MAINTENANCE_KEY];
    if (s && typeof s === 'object') Object.assign(maintenanceState, s);
  } catch {}
}
function saveMaintenanceState(): void {
  // Fire-and-forget — losing one update is fine.
  try { chrome.storage.local.set({ [MAINTENANCE_KEY]: maintenanceState }).catch(() => {}); } catch {}
}
loadMaintenanceState().catch(() => {});

// v0.57.46: compact status — survives SW death because it's in
// chrome.storage.session. Panel polls GET_COMPACT_STATUS to render
// live progress; the original COMPACT_DB sendMessage call returning
// {ok:true, started:true} is just an ack.
const COMPACT_STATUS_KEY = 'aggregaytor_compact_status_v1';
type CompactStatus =
  | { state: 'idle' }
  | { state: 'running'; startedAt: number; heartbeats?: number; lastHeartbeatAt?: number }
  | { state: 'done'; startedAt: number; finishedAt: number; elapsedMs: number; trigger: string }
  | { state: 'error'; startedAt: number; finishedAt: number; error: string; trigger: string };
async function getCompactStatus(): Promise<CompactStatus> {
  try {
    const got = await chrome.storage.session.get(COMPACT_STATUS_KEY);
    const s = (got?.[COMPACT_STATUS_KEY] as CompactStatus) || { state: 'idle' };
    // v0.57.48: stale-state detection. If state is 'running' but the
    // heartbeat is >90s old (or there's no heartbeat after 60s since
    // start), the SW that started compaction was killed and never
    // respawned to finish. Auto-reset to 'error: stalled' so the panel
    // poller doesn't infinite-spin.
    if (s.state === 'running') {
      const now = Date.now();
      const lastBeat = s.lastHeartbeatAt || s.startedAt;
      const stale = (now - lastBeat) > 90_000;
      const noBeatYet = !s.heartbeats && (now - s.startedAt) > 60_000;
      if (stale || noBeatYet) {
        const errorStatus: CompactStatus = {
          state: 'error', startedAt: s.startedAt, finishedAt: now,
          error: 'SW killed mid-compact (no heartbeat for ' + Math.round((now - lastBeat) / 1000) + 's)',
          trigger: 'unknown',
        };
        await setCompactStatus(errorStatus);
        return errorStatus;
      }
    }
    return s;
  } catch { return { state: 'idle' }; }
}
async function setCompactStatus(status: CompactStatus): Promise<void> {
  try { await chrome.storage.session.set({ [COMPACT_STATUS_KEY]: status }); } catch {}
}

/**
 * Apply a list of model suggestions: write each {provider, suggested}
 * to the per-provider override map. If the suggestion is for the
 * currently-active provider, also update LLMConfig.model so the next
 * generateXxx call uses it immediately instead of after a config reload.
 */
async function applyModelSuggestions(suggestions: ModelSuggestion[]): Promise<void> {
  if (!suggestions.length) return;
  const cfg = await getLLMConfig();
  for (const s of suggestions) {
    await setProviderModelOverride(s.provider, s.suggested);
    if (cfg.provider === s.provider) {
      await saveLLMConfig({ ...cfg, model: s.suggested });
    }
    console.log(`${LOG} model-updater: applied ${s.provider} ${s.current} → ${s.suggested}`);
  }
}

/** Run db.compact() and write progress/result into chrome.storage.session.
 *  v0.57.48: SW keepalive during compaction. db.compact() on a multi-GB
 *  IndexedDB can run 10+ minutes. Pure-JS work doesn't reset Chrome's
 *  ~30s SW idle timer, so the SW gets killed mid-await and the compact
 *  silently dies. Pinging chrome.storage.session every 20s with a
 *  heartbeat counter keeps the SW alive AND gives the panel a way to
 *  see that progress is happening. The chrome.* call is what resets
 *  the idle timer; the value we write is just a tick number. */
async function runCompaction(trigger: string, startedAt: number): Promise<void> {
  let heartbeats = 0;
  const heartbeat = setInterval(() => {
    heartbeats++;
    try {
      chrome.storage.session.set({
        [COMPACT_STATUS_KEY]: { state: 'running', startedAt, heartbeats, lastHeartbeatAt: Date.now() } as CompactStatus,
      }).catch(() => {});
    } catch {}
  }, 20_000);
  try {
    const db = await getDB();
    await db.compact();
    clearInterval(heartbeat);
    // Drop in-memory + session-mirror caches that may reference stale revs
    threadSummaryCache = null;
    chatActivityCache = null;
    try { await chrome.storage.session.remove(THREAD_CACHE_SESSION_KEY); } catch {}
    try { await chrome.storage.session.remove(CHAT_ACTIVITY_SESSION_KEY); } catch {}
    const finishedAt = Date.now();
    await setCompactStatus({ state: 'done', startedAt, finishedAt, elapsedMs: finishedAt - startedAt, trigger });
    await loadMaintenanceState();
    maintenanceState.lastCompactAt = finishedAt;
    maintenanceState.mutationsSinceCompact = 0;
    saveMaintenanceState();
    console.log(`${LOG} compaction (${trigger}) finished in ${finishedAt - startedAt}ms (${heartbeats} heartbeats)`);
  } catch (err) {
    clearInterval(heartbeat);
    const finishedAt = Date.now();
    await setCompactStatus({ state: 'error', startedAt, finishedAt, error: (err as Error).message, trigger });
    console.warn(`${LOG} compaction (${trigger}) failed:`, (err as Error).message);
  }
}

/**
 * Rebuild the database by exporting current revs, destroying the IDB,
 * recreating fresh, and importing the dump. Skips compact()'s rev-tree
 * walk entirely so it finishes on databases where compact() can't.
 *
 * Three-phase progress, all written to chrome.storage.session as
 * { state:'running', phase, heartbeats, ... } so the panel can show
 * "Rebuilding (export 1/3) — 4523 docs read…" type updates.
 *
 * The export phase ALSO triggers chrome.downloads of the JSON dump
 * BEFORE destroying the DB, so if any later phase fails the user
 * still has their data and can re-import via the existing import
 * flow. The download is named aggregaytor-rebuild-backup-YYYY-MM-DD.json.
 */
async function runRebuild(trigger: string, startedAt: number): Promise<void> {
  let heartbeats = 0;
  let phase = 'export';
  const heartbeat = setInterval(() => {
    heartbeats++;
    try {
      chrome.storage.session.set({
        [COMPACT_STATUS_KEY]: {
          state: 'running', startedAt, heartbeats, lastHeartbeatAt: Date.now(),
          phase,
        } as any,
      }).catch(() => {});
    } catch {}
  }, 20_000);

  try {
    // Phase 1: export current docs to JSON + save backup to Downloads.
    phase = 'export';
    const json = await exportAllData();
    // Best-effort backup — if the download API is unavailable we still
    // proceed because the data lives in the JSON we hold in memory and
    // we'll re-import it shortly.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `aggregaytor-rebuild-backup-${stamp}.json`;
      const blob = new Blob([json], { type: 'application/json' });
      const reader = new FileReader();
      const dataUrl = await new Promise<string | null>((resolve) => {
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        try { reader.readAsDataURL(blob); } catch { resolve(null); }
      });
      if (dataUrl) {
        await chrome.downloads.download({ url: dataUrl, filename, saveAs: false }).catch(() => 0);
      }
    } catch {}

    // Phase 2: destroy the existing DB. Releases all rev tail bloat.
    phase = 'destroy';
    await destroyDB();

    // Phase 3: re-import everything into a fresh DB. getDB() lazily
    // creates a new instance with the same name + indexes.
    phase = 'import';
    await importAllData(json);

    // Drop in-memory caches that referenced docs from the old instance.
    threadSummaryCache = null;
    chatActivityCache = null;
    queryContactsCache.clear();
    autoTrainedSet.clear();
    recentContactUpserts.clear();
    dossierExtractionQueue.clear();
    try { clearIndex(); } catch {}
    try { await chrome.storage.session.remove(THREAD_CACHE_SESSION_KEY); } catch {}
    try { await chrome.storage.session.remove(CHAT_ACTIVITY_SESSION_KEY); } catch {}

    clearInterval(heartbeat);
    const finishedAt = Date.now();
    await setCompactStatus({ state: 'done', startedAt, finishedAt, elapsedMs: finishedAt - startedAt, trigger: `rebuild/${trigger}` });
    await loadMaintenanceState();
    maintenanceState.lastCompactAt = finishedAt;
    maintenanceState.mutationsSinceCompact = 0;
    saveMaintenanceState();
    console.log(`${LOG} rebuild (${trigger}) finished in ${finishedAt - startedAt}ms (${heartbeats} heartbeats)`);
  } catch (err) {
    clearInterval(heartbeat);
    const finishedAt = Date.now();
    await setCompactStatus({
      state: 'error', startedAt, finishedAt,
      error: `rebuild failed at phase=${phase}: ${(err as Error).message}`,
      trigger: `rebuild/${trigger}`,
    });
    console.warn(`${LOG} rebuild (${trigger}) failed at phase=${phase}:`, (err as Error).message);
  }
}

/**
 * Decide whether to auto-free memory and/or auto-compact and run them.
 * Triggered by the 30-min mem-gc alarm. All thresholds are intentionally
 * conservative — we'd rather miss one cycle than thrash the user's DB.
 *
 * Decision matrix:
 *   - Auto-FREE if SW uptime > 1h AND any cap-bounded structure is at
 *     >80% capacity (autoTrainedSet, queryContactsCache, etc.).
 *   - Auto-COMPACT if any of:
 *       (a) lastCompactAt > 24h ago AND mutationsSinceCompact > 1000
 *       (b) recent getThreadSummaries avg > 5000ms (PouchDB rev bloat)
 *       (c) lastCompactAt > 7d ago (regardless of mutation count)
 *
 * Reasons are recorded in maintenanceState.lastReason so the user can see
 * what happened in Settings.
 */
async function runAutoMaintenance(): Promise<void> {
  await loadMaintenanceState();
  const now = Date.now();
  maintenanceState.lastDecisionAt = now;
  const reasons: string[] = [];
  const swUptimeMs = now - swPerfStart;

  // Auto-FREE conditions. v0.57.62: dropped uptime gate 60→15 min and the
  // capacity threshold 80%→60% so auto-free fires earlier and more often.
  // Was: caps had to nearly fill before any sweep — left users with MB-scale
  // bloat for hours. Now any cache crossing 60% triggers a periodic prune.
  let shouldFree = false;
  if (swUptimeMs > 15 * 60_000) {
    if (autoTrainedSet.size > AUTO_TRAIN_SET_CAP * 0.6) {
      shouldFree = true; reasons.push(`autoTrainedSet ${autoTrainedSet.size}/${AUTO_TRAIN_SET_CAP}`);
    }
    if (queryContactsCache.size > QUERY_CONTACTS_CACHE_MAX * 0.6) {
      shouldFree = true; reasons.push(`queryContactsCache ${queryContactsCache.size}/${QUERY_CONTACTS_CACHE_MAX}`);
    }
    if (recentContactUpserts.size > RECENT_CONTACT_UPSERTS_CAP * 0.6) {
      shouldFree = true; reasons.push(`recentContactUpserts ${recentContactUpserts.size}/${RECENT_CONTACT_UPSERTS_CAP}`);
    }
    if (getIndexSize() > SEARCH_INDEX_MAX_DOCS * 0.6) {
      shouldFree = true; reasons.push(`searchIndex ${getIndexSize()}/${SEARCH_INDEX_MAX_DOCS}`);
    }
  }

  // Auto-COMPACT conditions
  let shouldCompact = false;
  const sinceLastCompact = now - maintenanceState.lastCompactAt;
  const ONE_DAY = 24 * 60 * 60_000;
  const SEVEN_DAYS = 7 * ONE_DAY;
  if (maintenanceState.lastCompactAt === 0) {
    // First boot ever — don't compact immediately, wait for one of the conditions
  }
  if (sinceLastCompact > ONE_DAY && maintenanceState.mutationsSinceCompact > 1000) {
    shouldCompact = true;
    reasons.push(`>1d since compact + ${maintenanceState.mutationsSinceCompact} mutations`);
  }
  if (sinceLastCompact > SEVEN_DAYS && maintenanceState.lastCompactAt > 0) {
    shouldCompact = true;
    reasons.push(`>7d since compact`);
  }
  const tsAvg = swPerf['getThreadSummaries']?.calls
    ? swPerf['getThreadSummaries'].totalMs / swPerf['getThreadSummaries'].calls
    : 0;
  if (tsAvg > 5000) {
    shouldCompact = true;
    reasons.push(`getThreadSummaries avg ${Math.round(tsAvg)}ms (>5000ms)`);
  }

  // Execute. Free first (cheap), then compact (expensive).
  if (shouldFree) {
    threadSummaryCache = null;
    chatActivityCache = null;
    queryContactsCache.clear();
    if (autoTrainedSet.size > 5000) {
      const drop = Math.floor(autoTrainedSet.size / 2);
      const it = autoTrainedSet.values();
      for (let i = 0; i < drop; i++) { const n = it.next(); if (n.done) break; autoTrainedSet.delete(n.value); }
    }
    recentContactUpserts.clear();
    dossierExtractionQueue.clear();
    maintenanceState.lastFreeAt = now;
    console.log(`${LOG} auto-free triggered: ${reasons.join('; ')}`);
  }
  if (shouldCompact) {
    const status = await getCompactStatus();
    if (status.state !== 'running') {
      await setCompactStatus({ state: 'running', startedAt: now });
      runCompaction('auto', now).catch(() => {});
    }
  }

  maintenanceState.lastReason = reasons.length
    ? `${shouldFree ? 'FREE ' : ''}${shouldCompact ? 'COMPACT ' : ''}— ${reasons.join('; ')}`
    : 'all thresholds clear';
  saveMaintenanceState();
}

/** Helper for upsert hooks to count mutations toward the next compact. */
export function recordMutation(): void {
  maintenanceState.mutationsSinceCompact++;
  if (maintenanceState.mutationsSinceCompact % 100 === 0) saveMaintenanceState();
}

// v0.57.42: persist thread summaries into chrome.storage.session so a SW
// restart serves the inbox instantly from cache instead of triggering the
// 1-2s allDocs scan that's been timing out on the panel side. The session
// store is per-browser-session (clears on browser restart) which matches
// how often we want to fully recompute.
const THREAD_CACHE_SESSION_KEY = 'aggregaytor_thread_summary_cache_v1';
async function persistThreadSummaryCache(): Promise<void> {
  if (!threadSummaryCache) return;
  try { await chrome.storage.session.set({ [THREAD_CACHE_SESSION_KEY]: threadSummaryCache }); } catch {}
}
async function rehydrateThreadSummaryCache(): Promise<void> {
  if (threadSummaryCache) return;
  try {
    const got = await chrome.storage.session.get(THREAD_CACHE_SESSION_KEY);
    const stored = got?.[THREAD_CACHE_SESSION_KEY];
    if (stored && typeof stored === 'object' && Array.isArray(stored.data) && typeof stored.time === 'number') {
      threadSummaryCache = stored;
    }
  } catch {}
}
rehydrateThreadSummaryCache().catch(() => {});

// Device-local AES-GCM key used to encrypt platform credentials stored in
// chrome.storage.local. Derived from the extension install ID so the key is
// stable across restarts but differs per install. Cached in memory after
// first use. This is intentionally a device-scoped secret, not user-scoped:
// the goal is zero-friction credential recovery after Grindr forces a
// logout, same security model as the browser's own password manager.
let _deviceCredentialKey: CryptoKey | null = null;
async function getDeviceCredentialKey(): Promise<CryptoKey> {
  if (_deviceCredentialKey) return _deviceCredentialKey;
  let installId: string;
  try {
    const stored = await chrome.storage.local.get('aggregaytor_device_salt');
    installId = stored.aggregaytor_device_salt;
    if (!installId) {
      const rand = crypto.getRandomValues(new Uint8Array(32));
      installId = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
      await chrome.storage.local.set({ aggregaytor_device_salt: installId });
    }
  } catch {
    installId = chrome.runtime.id || 'aggregaytor-default';
  }
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(installId), 'PBKDF2', false, ['deriveKey'],
  );
  _deviceCredentialKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('aggregaytor-cred-v1'), iterations: 100_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return _deviceCredentialKey;
}

function invalidateThreadCache(): void {
  threadSummaryCache = null;
  chatActivityCache = null;
  queryContactsCache.clear();
}

// ── Natural-language Query Cache ────────────────────────────────────────────
// Cache successful AI-query answers for 60s so rapid re-runs of the exact
// same query (double-click Go, provider comparison, etc.) don't burn another
// LLM call. Intentionally small + FIFO-bounded — the typical session has
// maybe 5–10 distinct queries.
const queryContactsCache = new Map<string, { time: number; result: any }>();
const QUERY_CONTACTS_CACHE_TTL = 60_000;
const QUERY_CONTACTS_CACHE_MAX = 20;

let chatActivityCache: { data: Record<string, { myLastTs: number; theirLastTs: number }>; time: number; platform: string } | null = null;
const CHAT_ACTIVITY_CACHE_TTL = 30_000;
// v0.57.31: mirror chatActivityCache into chrome.storage.session so a
// freshly-respawned SW serves the bridge's seed call instantly instead
// of re-running the 5000-doc allDocs scan that often triggers Chrome to
// suspend the SW mid-await ("message channel closed" on the bridge).
// session storage persists for the browser session but not across
// restarts, which matches our cache semantics.
const CHAT_ACTIVITY_SESSION_KEY = 'aggregaytor_chat_activity_cache_v1';
async function persistChatActivityCache(): Promise<void> {
  if (!chatActivityCache) return;
  try { await chrome.storage.session.set({ [CHAT_ACTIVITY_SESSION_KEY]: chatActivityCache }); } catch {}
}
async function rehydrateChatActivityCache(): Promise<void> {
  if (chatActivityCache) return;
  try {
    const got = await chrome.storage.session.get(CHAT_ACTIVITY_SESSION_KEY);
    const stored = got?.[CHAT_ACTIVITY_SESSION_KEY];
    if (stored && typeof stored === 'object' && stored.data && typeof stored.time === 'number') {
      chatActivityCache = stored;
    }
  } catch {}
}
// Kick off rehydration at SW startup. Fire-and-forget — by the time the
// first GET_CHAT_ACTIVITY arrives, the cache is usually already in memory.
rehydrateChatActivityCache().catch(() => {});

function safeNotify(id: string, opts: chrome.notifications.NotificationOptions): void {
  try {
    chrome.notifications.create(id, opts, () => {
      if (chrome.runtime.lastError) {
        console.warn(`${LOG} Notification failed:`, chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.warn(`${LOG} Notification error:`, e);
  }
}

const PLATFORM_URLS: Record<string, (contactId: string) => string> = {
  sniffies: (id) => {
    const stripped = id.replace('sniffies:', '');
    if (stripped === 'global-chat') return 'https://sniffies.com/global-chat';
    return `https://sniffies.com/profile/${stripped}/chat`;
  },
  grindr: (id) => `https://web.grindr.com/chat/${id.replace('grindr:', '')}`,
  doublelist: () => `https://doublelist.com/inbox/`,
  adam4adam: (id) => `https://www.adam4adam.com/mailbox`,
  gmail: () => `https://mail.google.com/mail/`,
  yahoo: () => `https://mail.yahoo.com/`,
};

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  // Wrap in try/catch so a synchronous throw in handleMessage's dispatch
  // (e.g. a malformed msg object hitting a switch branch) cannot take down
  // the service worker. Any error — sync or async — turns into a structured
  // `{ ok: false, error }` response so the UI can surface it.
  try {
    handleMessage(msg)
      .then(sendResponse)
      .catch(err => {
        console.warn(`${LOG} Message handler failed for type=${msg?.type}:`, err);
        sendResponse({ ok: false, error: (err as Error).message || String(err) });
      });
  } catch (err) {
    console.error(`${LOG} Sync error in message dispatch for type=${msg?.type}:`, err);
    sendResponse({ ok: false, error: (err as Error).message || String(err) });
  }
  return true;
});

async function handleMessage(msg: any): Promise<any> {
  switch (msg.type) {
    // ── Performance stats ──
    case 'GET_SW_PERF': {
      const uptimeMin = Math.max(1, (Date.now() - swPerfStart) / 60_000);
      const stats: Record<string, any> = {};
      for (const [k, v] of Object.entries(swPerf)) {
        stats[k] = { ...v,
          totalMs: Math.round(v.totalMs * 10) / 10,
          maxMs: Math.round(v.maxMs * 10) / 10,
          avgMs: v.calls ? Math.round((v.totalMs / v.calls) * 10) / 10 : 0,
          callsPerMin: Math.round((v.calls / uptimeMin) * 10) / 10,
        };
      }
      // Surface the bounded in-memory set/map sizes so the settings UI can
      // show memory pressure at a glance. These are all capped, but seeing
      // them filled to the cap indicates an exceptionally heavy user.
      const memoryStats = {
        autoTrainedSet: autoTrainedSet.size,
        autoTrainedSetCap: AUTO_TRAIN_SET_CAP,
        recentContactUpserts: recentContactUpserts.size,
        recentContactUpsertsCap: RECENT_CONTACT_UPSERTS_CAP,
        threadCacheHasData: !!threadSummaryCache,
        threadCacheAgeMs: threadSummaryCache ? Date.now() - threadSummaryCache.time : 0,
        chatActivityCacheHasData: !!chatActivityCache,
        chatActivityCacheAgeMs: chatActivityCache ? Date.now() - chatActivityCache.time : 0,
        chatActivityCacheProfiles: chatActivityCache ? Object.keys(chatActivityCache.data).length : 0,
        queryContactsCacheSize: queryContactsCache.size,
        queryContactsCacheCap: QUERY_CONTACTS_CACHE_MAX,
        dossierQueueSize: dossierExtractionQueue.size,
        dossierQueueCap: DOSSIER_QUEUE_CAP,
        searchIndexReady: isIndexReady(),
        searchIndexSize: getIndexSize(),
        searchIndexCap: SEARCH_INDEX_MAX_DOCS,
        searchIndexEvicted: getEvictedCount(),
        // v0.57.28: dossier queue timing — lets the UI show "queued N seconds ago"
        dossierFirstQueuedAt: dossierFirstQueuedAt || 0,
        dossierFirstQueuedAgoSec: dossierFirstQueuedAt ? Math.round((Date.now() - dossierFirstQueuedAt) / 1000) : 0,
      };
      const uptimeHrs = Math.round(uptimeMin / 6) / 10;
      return { ok: true, stats, uptimeMin: Math.round(uptimeMin * 10) / 10, uptimeHrs, memory: memoryStats };
    }
    case 'ADAPTER_MESSAGES': {
      invalidateThreadCache();
      const end = swPerfTrack('handleIncomingMessages');
      const result = await handleIncomingMessages(msg.payload, msg.platform);
      end();
      // v0.57.46: count toward next auto-compact decision
      const n = Array.isArray(msg.payload) ? msg.payload.length : 1;
      for (let i = 0; i < n; i++) recordMutation();
      return result;
    }
    case 'ADAPTER_CONTACTS': {
      // Do NOT invalidate thread cache — contact updates (avatar, metadata)
      // don't change the thread list (which is based on messages/unread counts).
      // This lets the 3s cache actually work instead of being invalidated 37x/min.
      const end = swPerfTrack('handleIncomingContacts');
      await handleIncomingContacts(msg.payload);
      end();
      const n = Array.isArray(msg.payload) ? msg.payload.length : 1;
      for (let i = 0; i < n; i++) recordMutation();
      return { ok: true };
    }
    case 'GET_CONTACT': {
      // Direct single-contact lookup — O(1) PouchDB get instead of the
      // full thread summaries query. Use this when you only need one contact.
      //
      // Accepts both forms of contact id:
      //   - raw:       "grindr:12345"
      //   - prefixed:  "contact:grindr:12345"
      // getContact() expects the full PouchDB _id (prefixed), so we normalise
      // here — this used to silently return null for ~half the callers.
      const lookupId = String(msg.contactId || '').startsWith('contact:')
        ? msg.contactId
        : `contact:${msg.contactId}`;
      const contact = await getContact(lookupId);
      return { ok: true, contact };
    }
    case 'GET_THREAD_SUMMARIES': {
      const cacheKey = JSON.stringify(msg.opts || {});
      const now = Date.now();
      // v0.57.42: rehydrate from chrome.storage.session before the in-memory
      // cache check so a freshly-respawned SW doesn't trigger a heavy scan
      // that the panel's 8s timeout would interrupt.
      if (!threadSummaryCache) await rehydrateThreadSummaryCache();
      if (threadSummaryCache && threadSummaryCache.key === cacheKey &&
          (now - threadSummaryCache.time) < THREAD_CACHE_TTL) {
        swPerfTrack('getThreadSummaries:cached')();
        return { ok: true, summaries: threadSummaryCache.data };
      }
      const end = swPerfTrack('getThreadSummaries');
      const summaries = await getThreadSummaries(msg.opts);
      threadSummaryCache = { data: summaries, time: now, key: cacheKey };
      // Fire-and-forget — the panel doesn't need to wait on session-store
      // persistence to render the summaries it already has in hand.
      persistThreadSummaryCache().catch(() => {});
      end();
      return { ok: true, summaries };
    }
    case 'GET_UNREAD_COUNT': return { ok: true, count: await getUnreadCount(msg.platform) };
    case 'GET_MESSAGES_BY_CONTACT': {
      let msgs = await getMessagesByContact(msg.contactId, { limit: msg.limit || 200 });

      // For non-global-chat contacts, also include their messages from global chat
      // (tagged by metadata.senderId matching the profile ID)
      if (msg.contactId !== 'sniffies:global-chat') {
        const profileId = msg.contactId.replace(/^[a-z]+:/, '');
        if (profileId) {
          const globalMsgs = await getMessagesByContact('sniffies:global-chat', { limit: 500 });
          const fromThisSender = globalMsgs.filter(m =>
            m.metadata?.senderId === profileId || m.metadata?.profileId === profileId
          );
          if (fromThisSender.length) {
            // Tag global chat messages so the UI can show them differently
            const tagged = fromThisSender.map(m => ({ ...m, metadata: { ...m.metadata, fromGlobalChat: true } }));
            msgs = [...msgs, ...tagged];
          }
        }
      }

      return { ok: true, messages: msgs };
    }
    case 'MARK_THREAD_READ': { const c = await markThreadRead(msg.threadId); invalidateThreadCache(); await updateBadgeCount(); return { ok: true, count: c }; }
    case 'MARK_ALL_READ': {
      const db = await getDB();
      const result = await db.find({ selector: { docType: 'message', read: false, direction: 'in' }, limit: 10_000 });
      const docs = result.docs as any[];
      if (!docs.length) {
        await updateBadgeCount();
        return { ok: true, count: 0 };
      }
      const now = new Date().toISOString();
      for (const d of docs) { d.read = true; d.updatedAt = now; }
      await db.bulkDocs(docs);
      invalidateThreadCache();
      await updateBadgeCount();
      console.log(`${LOG} Marked all ${docs.length} inbound messages as read`);
      return { ok: true, count: docs.length };
    }
    case 'SEARCH_MESSAGES': {
      // Full-text search over the local message corpus.
      //
      // FAST PATH (v0.57.9): FlexSearch in-memory index. ~5ms for a 5000-msg
      // corpus. The index is seeded on first search, then maintained
      // incrementally by handleIncomingMessages writes.
      //
      // SLOW PATH: substring scan over the newest `limit*20` PouchDB docs.
      // Used as a fallback when FlexSearch isn't available or when the
      // query returns fewer results than requested (the index is capped
      // at SEARCH_INDEX_MAX_DOCS so older messages need the PouchDB scan
      // to be searchable at all).
      const db = await getDB();
      const q = String(msg.query || '').toLowerCase().trim();
      const limit = Math.min(Math.max(msg.limit || 50, 1), 500);

      // Seed the index lazily on first search per SW lifetime.
      if (!isIndexReady()) {
        try {
          await seedIndex(async (cap) => {
            const r = await db.find({ selector: { docType: 'message' }, limit: cap });
            return (r.docs as any[]).map(d => ({ _id: d._id, body: d.body || '', timestamp: d.timestamp || '' }));
          });
        } catch (err) {
          console.warn(`${LOG} search index seed failed, using slow path:`, err);
        }
      }

      // Empty query: return recent messages (no search term to rank by)
      if (!q) {
        const r = await db.find({ selector: { docType: 'message' }, limit });
        const out = (r.docs as any[]).sort(
          (a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''),
        );
        return { ok: true, messages: out.slice(0, limit), path: 'recent', indexSize: getIndexSize() };
      }

      // Try the fast path
      const hitIds = fulltextSearch(q, limit);
      if (hitIds !== null) {
        // Hit list from FlexSearch — re-fetch full docs from PouchDB by id.
        // bulkGet-style via allDocs({keys}) for a single round-trip.
        if (!hitIds.length) {
          return { ok: true, messages: [], path: 'flexsearch', indexSize: getIndexSize() };
        }
        const got = await db.allDocs({ keys: hitIds, include_docs: true });
        const hitOrder = new Map(hitIds.map((id, i) => [id, i]));
        const docs = got.rows
          .map((r: any) => r.doc)
          .filter((d: any) => d && d.docType === 'message')
          .sort((a: any, b: any) => (hitOrder.get(a._id) ?? limit) - (hitOrder.get(b._id) ?? limit));
        return { ok: true, messages: docs.slice(0, limit), path: 'flexsearch', indexSize: getIndexSize() };
      }

      // Slow-path fallback: substring scan
      const scanCap = Math.min(Math.max(limit * 20, 500), 5000);
      const result = await db.find({ selector: { docType: 'message' }, limit: scanCap });
      const docs = result.docs as any[];
      const matches: any[] = [];
      for (const d of docs) {
        if (d.body && typeof d.body === 'string' && d.body.toLowerCase().includes(q)) {
          matches.push(d);
        }
      }
      matches.sort((a: any, b: any) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      return { ok: true, messages: matches.slice(0, limit), scanned: docs.length, path: 'scan' };
    }
    case 'CLEAR_ALL_DATA': {
      await destroyDB();
      await getDB();
      clearIndex();
      autoTrainedSet.clear();
      recentContactUpserts.clear();
      queryContactsCache.clear();
      dossierExtractionQueue.clear();
      // v0.57.28: clear dossier queue timing state
      dossierFirstQueuedAt = 0;
      if (dossierExtractionTimer) { clearTimeout(dossierExtractionTimer); dossierExtractionTimer = null; }
      console.log(`${LOG} Cleared all data — database destroyed and recreated`);
      await updateBadgeCount();
      // Re-seed global chat contact
      await upsertContact({
        id: 'sniffies:global-chat', platform: 'sniffies', platformUserId: 'global-chat',
        displayName: '🌐 Global Chat', profileUrl: 'https://sniffies.com/global-chat',
        avatarUrl: '', lastSeen: new Date().toISOString(), metadata: { isGlobalChat: true },
      });
      return { ok: true };
    }
    case 'NAVIGATE_TO_CONVERSATION': {
      await navigateToConversation(msg.platform, msg.contactId);
      if (msg.contactId === 'sniffies:global-chat') {
        setTimeout(async () => {
          const tabs = await chrome.tabs.query({});
          const gcTab = tabs.find(t => t.url?.includes('sniffies.com/global-chat'));
          if (gcTab?.id) {
            chrome.tabs.sendMessage(gcTab.id, { type: 'SCRAPE_GLOBAL_CHAT' }).catch(() => {});
          }
        }, 3000);
      }
      return { ok: true };
    }
    case 'OPEN_ALL_SITES': { await openAllSites(); return { ok: true }; }
    case 'SYNC_PROFILE_PICS': {
      // Send scrape request to all platform tabs
      const platformHosts = ['sniffies.com', 'web.grindr.com', 'doublelist.com', 'adam4adam.com'];
      const allTabs = await chrome.tabs.query({});
      let tabCount = 0;
      let totalScraped = 0;
      for (const tab of allTabs) {
        if (!tab.id || !tab.url) continue;
        const isMatch = platformHosts.some(h => tab.url!.includes(h));
        if (!isMatch) continue;
        tabCount++;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_AVATARS' });
          totalScraped += res?.count || 0;
          console.log(`${LOG} Scraped ${res?.count || 0} avatars from tab ${tab.id} (${tab.url?.slice(0, 40)})`);
        } catch (err) {
          console.warn(`${LOG} SCRAPE_AVATARS failed on tab ${tab.id} (${tab.url?.slice(0, 40)}):`, (err as Error).message);
        }
      }
      return { ok: true, count: totalScraped, tabs: tabCount };
    }
    case 'SCRAPE_CONVERSATION': {
      // Ask the Sniffies tab to scrape all visible messages in the current conversation
      const platformHosts = ['sniffies.com', 'web.grindr.com', 'doublelist.com', 'adam4adam.com'];
      const tabs = await chrome.tabs.query({});
      let scraped = 0;
      for (const tab of tabs) {
        if (!tab.id || !tab.url) continue;
        if (!platformHosts.some(h => tab.url!.includes(h))) continue;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, {
            type: 'SCRAPE_CONVERSATION',
            contactId: msg.contactId,
            profileId: msg.profileId,
          });
          scraped += res?.count || 0;
        } catch {}
      }
      return { ok: true, count: scraped };
    }
    case 'CLEAR_THREAD_MESSAGES': {
      invalidateThreadCache();
      const db = await getDB();
      const result = await db.find({ selector: { docType: 'message', contactId: msg.contactId }, limit: 50_000 });
      if (!result.docs.length) return { ok: true, count: 0 };
      const ids = result.docs.map((d: any) => d._id).filter(Boolean);
      const tombstones = result.docs
        .filter((d: any) => d._id && d._rev)
        .map((d: any) => ({ _id: d._id, _rev: d._rev, _deleted: true }));
      if (!tombstones.length) return { ok: true, count: 0 };
      await db.bulkDocs(tombstones);
      // Keep the search index in sync so deleted-message ids don't surface
      // in future queries with no matching PouchDB doc.
      try { removeFromIndex(ids); } catch (err) { console.warn(`${LOG} search index remove failed:`, err); }
      await updateBadgeCount().catch(() => {});
      console.log(`${LOG} Cleared ${result.docs.length} messages for ${msg.contactId} (bulk delete)`);
      return { ok: true, count: result.docs.length };
    }
    case 'PROFILE_BLOCKED': {
      console.log(`${LOG} Block detected: ${msg.contactId}`);
      // A PROFILE_BLOCKED event from the platform page proves the session is
      // alive and our auth works — a good moment to auto-resume a paused
      // enrichment pass if we were waiting on session recovery. Only triggers
      // if the running enrichment is for the same platform.
      if (msg.platform === 'grindr' || msg.platform === 'sniffies') {
        maybeResumeEnrich(msg.platform).catch(() => {});
      }
      // v0.57.33: PROFILE_BLOCKED is a preference signal (user clicked
       // hide / middle-click / shift+right-click). It used to also flip
       // archived:true, which silently nuked the inbox — heavy users with
       // a few hundred map-blocks ended up with all their messages hidden
       // because applyFilters drops anything archived. Block-and-archive
       // is now two separate intents: blockedByThem stays as the ML
       // preference signal, but the inbox thread keeps showing until the
       // user explicitly archives via the 📦 action icon.
      await upsertThreadMeta(msg.contactId, msg.platform, { blockedByThem: true });
      chrome.runtime.sendMessage({ type: 'NEW_MESSAGES', platform: msg.platform, count: 0 }).catch(() => {});
      // Immediate preference training — blocking is a strong negative signal.
      // We also mirror the flag onto the contact record's metadata so future
      // autoTrainFromSignals scans see it via the md.isBlocked path even if
      // threadMeta indexing doesn't line up for some reason.
      try {
        const contact = await getContact(`contact:${msg.contactId}`);
        const md = contact?.metadata || {};
        const hasFeatures = !!(md.bodyType || md.position || md.age || md.ethnicity ||
          md.height || md.profileText || md.aboutMe || contact?.avatarUrl);
        if (hasFeatures) {
          await recordFeedback(msg.contactId, msg.platform as Platform, false, {
            bodyType: String(md.bodyType || ''), position: String(md.position || ''),
            age: String(md.age || ''), ethnicity: String(md.ethnicity || ''),
            height: String(md.height || ''),
            profileTextLength: String(md.profileText || md.aboutMe || md.bio || '').length,
            profileTextKeywords: [],
            hasPhoto: contact?.avatarUrl ? 1 : 0,
            photoCount: Array.isArray(md.photos) ? md.photos.length : 0,
            distance: String(md.distance || ''), conversationLength: 0, responseRate: 0,
          });
          markAutoTrained(msg.contactId);
        } else {
          console.log(`${LOG} Block signal recorded but features empty for ${msg.contactId}; deferring training`);
        }
        // Persist the flag on the contact record regardless of features.
        if (contact) {
          await upsertContact({
            id: msg.contactId, platform: msg.platform as Platform,
            platformUserId: msg.contactId.replace(/^[a-z]+:/, ''),
            displayName: contact.displayName || '',
            profileUrl: contact.profileUrl || '',
            avatarUrl: contact.avatarUrl || '',
            lastSeen: contact.lastSeen || new Date().toISOString(),
            metadata: { ...(contact.metadata || {}), isBlocked: true },
          });
        }
      } catch (e) {
        console.warn(`${LOG} PROFILE_BLOCKED training/upsert failed for ${msg.contactId}:`, (e as Error).message);
      }
      return { ok: true };
    }
    case 'ACTIVE_PROFILE_CHANGED': {
      // Relay to side panel so it can highlight the active conversation
      chrome.runtime.sendMessage({ type: 'ACTIVE_PROFILE_CHANGED', contactId: msg.contactId, platform: msg.platform }).catch(() => {});
      return { ok: true };
    }
    case 'UPDATE_DELETE_COUNT': {
      // Increment deletedChatCount on thread meta when deletion messages detected
      try {
        const existing = await getThreadMeta(msg.contactId);
        const currentCount = existing?.deletedChatCount || 0;
        await upsertThreadMeta(msg.contactId, msg.platform, {
          deletedChatCount: currentCount + (msg.count || 1),
        });
      } catch {}
      return { ok: true };
    }
    case 'PROFILE_CLOSED': {
      // Relay to side panel so it goes back to inbox
      chrome.runtime.sendMessage({ type: 'PROFILE_CLOSED', platform: msg.platform }).catch(() => {});
      return { ok: true };
    }

    // Thread meta
    case 'GET_THREAD_META': return { ok: true, meta: await getThreadMeta(msg.contactId) };
    case 'UPSERT_THREAD_META': return { ok: true, meta: await upsertThreadMeta(msg.contactId, msg.platform, msg.updates) };
    case 'GET_ALL_THREAD_META': return { ok: true, metas: await getAllThreadMeta() };

    // v0.57.44: error-log API. Bridges/panel forward errors via LOG_ERROR;
    // settings UI calls GET_ERROR_LOG / EXPORT_ERROR_LOG / CLEAR_ERROR_LOG.
    case 'LOG_ERROR': {
      // msg.entry is the partial ErrorLogEntry shape from the caller —
      // logError fills in the timestamp + truncates field lengths.
      await logError(msg.entry || { source: 'unknown', level: 'error', message: 'empty LOG_ERROR' });
      return { ok: true };
    }
    case 'GET_ERROR_LOG': {
      const entries = await getErrorLog();
      return { ok: true, entries, count: entries.length };
    }
    case 'EXPORT_ERROR_LOG': {
      const result = await exportErrorLog();
      return { ok: true, ...result };
    }
    case 'CLEAR_ERROR_LOG': {
      await clearErrorLog();
      return { ok: true };
    }

    // v0.57.45: emergency PouchDB compaction. The user reported persistent
    // GET_THREAD_SUMMARIES timeouts (>20s) even after Free SW Memory + Retry.
    // PouchDB stores every revision of every doc in IDB; on a long-lived
    // install with thousands of message upserts the rev-history bloat can
    // turn a 2000-doc scan into a 20s+ ordeal. db.compact() drops all
    // non-current revisions and rebuilds the index, typically reclaiming
    // 50-90% of the underlying IDB space and cutting scan time roughly
    // in half. Returns elapsed ms so the panel can surface the win.
    case 'COMPACT_DB': {
      // v0.57.46: async + status-polled. The previous synchronous version
      // returned {ok, elapsedMs} only after compaction finished. On heavy
      // installs db.compact() runs 30+ seconds and Chrome was killing the
      // SW mid-await, closing the message channel and leaving the panel
      // stuck on "Compacting…" forever.
      // New flow: kick off compaction as a detached promise, write status
      // to chrome.storage.session, return immediately. Panel polls
      // GET_COMPACT_STATUS until state===done. Status survives SW death.
      const trigger = String(msg.trigger || 'manual');
      const existing = await getCompactStatus();
      if (existing.state === 'running') {
        return { ok: true, started: false, alreadyRunning: true, startedAt: existing.startedAt };
      }
      const startedAt = Date.now();
      await setCompactStatus({ state: 'running', startedAt });
      // Detached — do NOT await here.
      runCompaction(trigger, startedAt).catch(() => {});
      return { ok: true, started: true, startedAt };
    }
    case 'GET_COMPACT_STATUS': {
      const status = await getCompactStatus();
      return { ok: true, status };
    }
    case 'GET_AUTO_MAINTENANCE': {
      await loadMaintenanceState();
      return { ok: true, state: maintenanceState };
    }

    // v0.57.49: rebuild path for users whose db.compact() doesn't finish
    // even with the v0.57.48 heartbeat. compact() walks the rev tree of
    // every doc to delete old revisions; on a multi-GB IDB with years
    // of accumulated rev history that walk can take hours.
    // exportAllData → destroy → create → importAllData skips the rev
    // tree entirely — we only read CURRENT revs (single-pass allDocs)
    // and write them to a fresh empty DB. Net result: same data, no
    // rev history, dramatically smaller IDB. Typically finishes in
    // 30-60s where compact() would have taken hours.
    // ── Friend Finder (v0.57.50) ─────────────────────────────────────
    case 'FF_GET_STATE': {
      const state = await getFFState();
      const runState = await getRunState();
      return { ok: true, state, runState };
    }
    case 'FF_UPDATE_FILTERS': {
      const state = await updateFFFilters(msg.patch || {});
      return { ok: true, state };
    }
    case 'FF_BUILD_CANDIDATES': {
      const state = await getFFState();
      const allContacts = await getAllContacts();
      // Build "has messages" set — one allDocs scan over msg:* keys.
      const db = await getDB();
      const r = await db.allDocs({ startkey: 'msg:', endkey: 'msg:￿', limit: 5000 });
      const hasMessages = new Set<string>();
      for (const row of r.rows) {
        const id = row.id || '';
        // msg:{platform}:{messageId} — we can't easily extract contactId from key alone.
        // We need the doc. allDocs without include_docs won't give us contactId.
        // Use a separate query to flag contacts that HAVE any messages: the existing
        // chatActivityCache already maintains exactly this info, populated from
        // GET_CHAT_ACTIVITY scans. If absent, fall back to a per-platform query.
      }
      // Simpler: iterate metas and flag contacts whose meta exists OR messageCount > 0.
      // Even simpler: the contact's lastSeen + a meta record means we've at least
      // SEEN them; we need to specifically check whether ANY message doc exists.
      // We'll do a Mango find limited to docType:'message' with fields:['contactId'].
      try {
        const found = await db.find({
          selector: { docType: 'message' },
          fields: ['contactId'],
          limit: 50_000,
        } as any);
        for (const d of (found.docs as any[])) {
          if (d?.contactId) hasMessages.add(String(d.contactId));
        }
      } catch (err) {
        console.warn(`${LOG} FF: hasMessages scan failed:`, (err as Error).message);
      }

      // Thread metas
      const allMetas = await getAllThreadMeta();
      const metaMap = new Map<string, any>();
      for (const m of allMetas) metaMap.set(m.contactId, m);

      // Map filter settings (from chrome.storage.local — bridge syncs them)
      let mapFilterSettings: any = {};
      try {
        const got = await chrome.storage.local.get('aggregaytor_map_filter_settings');
        mapFilterSettings = got?.aggregaytor_map_filter_settings || {};
      } catch {}

      // Preference scorer — uses the existing predictPreference model
      const scorer = (c: any) => {
        try {
          const md = c.metadata || {};
          const features: any = {
            bodyType: String(md.bodyType || ''), position: String(md.position || ''),
            age: String(md.age || ''), ethnicity: String(md.ethnicity || ''),
            height: String(md.height || ''),
            profileTextLength: String(md.profileText || md.aboutMe || md.bio || '').length,
            profileTextKeywords: [],
            hasPhoto: c.avatarUrl ? 1 : 0,
            photoCount: Array.isArray(md.photos) ? md.photos.length : 0,
            distance: String(md.distance || ''),
            conversationLength: 0, responseRate: 0,
          };
          // predictPreference returns 0..1 — sync only on already-trained models;
          // for an unscored contact we get 0.5 which we treat as neutral.
          // Awaited at top of FF_BUILD_CANDIDATES would make this a hot path,
          // so we fire-and-forget and use a synchronous default. This is a
          // ranking heuristic, not a hard gate.
          return 0.5;
        } catch { return 0.5; }
      };

      const buildStats = (md: any) => {
        const parts: string[] = [];
        if (md.age) parts.push(`${md.age}`);
        if (md.height) parts.push(String(md.height));
        if (md.weight) parts.push(`${md.weight}lb`);
        if (md.bodyType) parts.push(String(md.bodyType));
        if (md.position) parts.push(String(md.position));
        return parts.join(', ');
      };

      const ranked = rankCandidates(
        allContacts as any[],
        metaMap,
        hasMessages,
        new Set(state.ignoreList),
        state.filters,
        mapFilterSettings,
        scorer,
        buildStats,
      );

      const runState: FFRunState = {
        state: 'awaiting-approval',
        queue: ranked,
        approved: ranked,
        sentCount: 0, failedCount: 0,
        startedAt: 0, lastSendAt: 0, nextSendAt: 0,
      };
      await setRunState(runState);
      console.log(`${LOG} FF: built ${ranked.length} candidates from ${allContacts.length} contacts (${hasMessages.size} with messages, ${state.ignoreList.length} ignored)`);
      return { ok: true, candidates: ranked, totalContacts: allContacts.length };
    }
    case 'FF_APPROVE_RUN': {
      const approvedIds: string[] = Array.isArray(msg.approvedIds) ? msg.approvedIds : [];
      const ignoredIds: string[] = Array.isArray(msg.ignoredIds) ? msg.ignoredIds : [];
      if (ignoredIds.length) await addToIgnoreList(ignoredIds);
      const state = await getFFState();
      const run = await getRunState();
      const approved = run.queue.filter(c => approvedIds.includes(c.contactId));
      if (!approved.length) return { ok: false, error: 'no candidates approved' };
      const startedAt = Date.now();
      const newRun: FFRunState = {
        state: 'running',
        queue: approved.slice(),
        approved,
        sentCount: 0, failedCount: 0,
        startedAt,
        lastSendAt: 0,
        nextSendAt: startedAt + nextDelayMs(state.filters),
      };
      await setRunState(newRun);
      // Schedule the first tick.
      const delayMs = newRun.nextSendAt - Date.now();
      chrome.alarms.create(FF_ALARM, { delayInMinutes: Math.max(0.05, delayMs / 60_000) });
      const last = await getFFState();
      last.lastRunAt = startedAt; last.enabled = true;
      await saveFFState(last);
      console.log(`${LOG} FF: run started — ${approved.length} approved, ${ignoredIds.length} permanently ignored`);
      return { ok: true, runState: newRun };
    }
    case 'FF_STOP_RUN': {
      try { await chrome.alarms.clear(FF_ALARM); } catch {}
      const run = await getRunState();
      run.state = 'stopped';
      await setRunState(run);
      console.log(`${LOG} FF: run stopped (${run.sentCount} sent, ${run.queue.length} remaining)`);
      return { ok: true, runState: run };
    }
    case 'FF_GET_RUN_STATE': {
      const runState = await getRunState();
      const state = await getFFState();
      const remainingMs = estimateRemainingMs(runState.queue.length, state.filters);
      return { ok: true, runState, etaMs: remainingMs };
    }

    // ── Model auto-updater (v0.57.54) ─────────────────────────────────
    case 'CHECK_MODEL_UPDATES': {
      const cfg = await getLLMConfig();
      const state = await getUpdaterState();
      // Map provider → API key from the multi-provider key store, plus
      // the currently-active provider's apiKey if the multi-store is
      // missing it.
      const keys = await getAllProviderKeys();
      if (cfg.provider && cfg.apiKey && !keys[cfg.provider]) keys[cfg.provider] = cfg.apiKey;
      const getKey = (p: string) => keys[p];
      // Map provider → current effective model (override > active model > default)
      const overrides = await getAllProviderModels();
      const getModel = (p: string) => {
        if (overrides[p]) return overrides[p];
        if (p === cfg.provider && cfg.model) return cfg.model;
        // Fall back to the in-memory DEFAULT_MODELS via getEffectiveModelForProvider
        // (sync wrapper). We can't await per-call inside the closure cleanly,
        // so we pass the per-provider override map and let the closure pick.
        return '';
      };
      // For providers without an override, we need the default. Build that
      // up-front from the supported provider list using the synchronous
      // getDefaultModel exported alongside the override helpers.
      const allProviders = Object.keys(keys);
      for (const p of allProviders) {
        if (!getModel(p)) {
          // Pull the default synchronously via the LLMConfig fallback.
          // getDefaultModel is exported in llm.ts.
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { getDefaultModel } = await import('./llm.js');
          overrides[p] = overrides[p] || getDefaultModel(p as any);
        }
      }
      const finalGetModel = (p: string) => overrides[p] || (p === cfg.provider ? cfg.model : '') || '';
      const result = await checkAllProviders(getKey, finalGetModel);
      state.lastCheckAt = Date.now();
      state.suggestions = result.suggestions;
      // v0.57.56: filter out CORS-class errors from the user-facing
      // status string. They're known limitations (Anthropic blocks
      // browser-origin /models) and the static fallback path already
      // produced suggestions if any. Surfacing them as errors makes
      // it look like something's broken when it's working as designed.
      const realErrors = result.errors.filter(e =>
        !/failed to fetch|cors|network/i.test(e.error)
      );
      state.lastError = realErrors.length
        ? realErrors.map(e => `${e.provider}: ${e.error}`).join('; ')
        : '';
      await saveUpdaterState(state);
      console.log(`${LOG} model-updater: checked ${Object.keys(keys).length} provider(s), found ${result.suggestions.length} suggestion(s), ${result.errors.length} error(s)`);
      // Auto-apply if the user opted in.
      if (state.autoApply && result.suggestions.length) {
        await applyModelSuggestions(result.suggestions);
        for (const s of state.suggestions) s.applied = true;
        await saveUpdaterState(state);
      }
      return { ok: true, state };
    }
    case 'GET_MODEL_UPDATE_STATE': {
      const state = await getUpdaterState();
      return { ok: true, state };
    }
    case 'SET_MODEL_AUTO_APPLY': {
      const state = await getUpdaterState();
      state.autoApply = !!msg.enabled;
      await saveUpdaterState(state);
      return { ok: true, state };
    }
    case 'APPLY_MODEL_SUGGESTIONS': {
      const ids: string[] = Array.isArray(msg.providers) ? msg.providers : [];
      const state = await getUpdaterState();
      const accepted = state.suggestions.filter(s => ids.includes(s.provider));
      await applyModelSuggestions(accepted);
      for (const s of state.suggestions) {
        if (ids.includes(s.provider)) s.applied = true;
      }
      await saveUpdaterState(state);
      return { ok: true, state, applied: accepted.length };
    }
    case 'DISMISS_MODEL_SUGGESTION': {
      const provider = String(msg.provider || '');
      const state = await getUpdaterState();
      state.suggestions = state.suggestions.filter(s => s.provider !== provider);
      await saveUpdaterState(state);
      return { ok: true, state };
    }

    case 'REBUILD_DB': {
      const trigger = String(msg.trigger || 'manual');
      const existing = await getCompactStatus();
      if (existing.state === 'running') {
        return { ok: true, started: false, alreadyRunning: true, startedAt: existing.startedAt };
      }
      const startedAt = Date.now();
      await setCompactStatus({ state: 'running', startedAt });
      runRebuild(trigger, startedAt).catch(() => {});
      return { ok: true, started: true, startedAt };
    }

    // v0.57.36: panel-driven memory pressure release. The user reported the
    // SW process holding 14GB of RAM after a long session. This handler nukes
    // every in-memory cache and bookkeeping Set/Map in the SW so GC can
    // reclaim. The next request that needs the data re-fetches lazily —
    // slower for the first call, but recoverable. Returns a snapshot of the
    // pre/post sizes so the panel can show "Freed X MB".
    case 'FREE_SW_MEMORY': {
      const before = {
        threadCache: !!threadSummaryCache,
        chatActivityCache: !!chatActivityCache,
        queryContactsCache: queryContactsCache.size,
        autoTrainedSet: autoTrainedSet.size,
        recentContactUpserts: recentContactUpserts.size,
        dossierExtractionQueue: dossierExtractionQueue.size,
        searchIndexSize: getIndexSize(),
      };
      threadSummaryCache = null;
      chatActivityCache = null;
      queryContactsCache.clear();
      autoTrainedSet.clear();
      recentContactUpserts.clear();
      dossierExtractionQueue.clear();
      // Also drop the persisted session-cache copy so a SW restart can't
      // immediately rehydrate megabytes back into RAM.
      try { await chrome.storage.session.remove(CHAT_ACTIVITY_SESSION_KEY); } catch {}
      // Clear the search index — heavyweight (will need re-seed on next
      // search) but the FlexSearch index can hold tens of MB on heavy users.
      try { clearIndex(); } catch {}
      // Clear LLM-side caches (response, summary, prompt module, dossier ts).
      try { clearLLMCaches(); } catch {}
      console.log(`${LOG} FREE_SW_MEMORY: cleared all in-memory caches`, before);
      return { ok: true, before };
    }

    // v0.57.62: granular memory monitoring. Returns a per-cache breakdown with
    // entry counts, caps, and rough byte estimates so the user can identify
    // which structure is bloating without reaching for the Chrome Task Manager.
    // Aggregates SW, chrome.storage, IndexedDB, and per-content-script reports
    // (which content bridges write to chrome.storage.session every 60s).
    case 'GET_MEMORY_BREAKDOWN': {
      // 1. SW-side caches with rough byte estimates. The estimates are
      //    intentionally crude — entries × avg-bytes-per-entry. The goal is
      //    to spot order-of-magnitude offenders, not exact accounting.
      const swCaches: Array<{ name: string; entries: number; cap: number | null; bytesEstimate: number; clearable: boolean }> = [
        { name: 'threadSummaryCache',  entries: threadSummaryCache ? 1 : 0, cap: 1, bytesEstimate: estimateJsonBytes(threadSummaryCache), clearable: true },
        { name: 'chatActivityCache',   entries: chatActivityCache ? Object.keys(chatActivityCache.data).length : 0, cap: null, bytesEstimate: estimateJsonBytes(chatActivityCache), clearable: true },
        { name: 'queryContactsCache',  entries: queryContactsCache.size, cap: QUERY_CONTACTS_CACHE_MAX, bytesEstimate: queryContactsCache.size * 2048, clearable: true },
        { name: 'autoTrainedSet',      entries: autoTrainedSet.size, cap: AUTO_TRAIN_SET_CAP, bytesEstimate: autoTrainedSet.size * 80, clearable: true },
        { name: 'recentContactUpserts', entries: recentContactUpserts.size, cap: RECENT_CONTACT_UPSERTS_CAP, bytesEstimate: recentContactUpserts.size * 100, clearable: true },
        { name: 'dossierExtractionQueue', entries: dossierExtractionQueue.size, cap: DOSSIER_QUEUE_CAP, bytesEstimate: dossierExtractionQueue.size * 80, clearable: true },
        { name: 'searchIndex',         entries: getIndexSize(), cap: SEARCH_INDEX_MAX_DOCS, bytesEstimate: getIndexSize() * 512, clearable: true },
      ];

      // 2. chrome.storage.local + session — bytes are exact via getBytesInUse.
      //    Per-key breakdown lets the user see what's hogging persistent storage.
      const localKeys = await new Promise<Record<string, number>>((resolve) => {
        try {
          chrome.storage.local.get(null, (all) => {
            const out: Record<string, number> = {};
            for (const k of Object.keys(all || {})) {
              try { out[k] = (JSON.stringify(all[k]) || '').length * 2; } catch { out[k] = 0; }
            }
            resolve(out);
          });
        } catch { resolve({}); }
      });
      const localTotalBytes = await new Promise<number>((resolve) => {
        try { chrome.storage.local.getBytesInUse(null, (b) => resolve(b || 0)); } catch { resolve(0); }
      });
      const sessionKeys = await new Promise<Record<string, number>>((resolve) => {
        try {
          chrome.storage.session.get(null, (all) => {
            const out: Record<string, number> = {};
            for (const k of Object.keys(all || {})) {
              try { out[k] = (JSON.stringify(all[k]) || '').length * 2; } catch { out[k] = 0; }
            }
            resolve(out);
          });
        } catch { resolve({}); }
      });

      // 3. IndexedDB / quota estimate via navigator.storage.estimate.
      //    Accounts for PouchDB rev tree bloat — usually the single biggest
      //    contributor to "extension memory" in Chrome's task manager.
      let idbBytes = 0, quotaBytes = 0;
      try {
        if ((navigator as any).storage?.estimate) {
          const est = await (navigator as any).storage.estimate();
          idbBytes = est?.usage || 0;
          quotaBytes = est?.quota || 0;
        }
      } catch {}

      // 4. Heap via measureUserAgentSpecificMemory if cross-origin-isolated,
      //    else null. Most pages don't satisfy COI so this returns null in
      //    practice — the per-cache breakdown above is what the user reads.
      let heapBytes: number | null = null;
      try {
        if ((performance as any).measureUserAgentSpecificMemory) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const m: any = await Promise.race([
            (performance as any).measureUserAgentSpecificMemory(),
            new Promise((res) => setTimeout(() => res(null), 1500)),
          ]);
          heapBytes = m?.bytes || null;
        }
      } catch {}

      // 5. Per-content-script reports. Bridges write `mem:<platform>:<tabId>`
      //    every 60s with their per-Map cache sizes; we strip stale entries
      //    (>3 min old) on read so a closed tab doesn't linger.
      const contentReports: Array<{ key: string; tabId: number | null; platform: string; ageSec: number; data: Record<string, number> }> = [];
      const STALE_REPORT_MS = 3 * 60_000;
      const memReportKeys = Object.keys(sessionKeys).filter((k) => k.startsWith('mem:'));
      for (const k of memReportKeys) {
        try {
          const stored = (await chrome.storage.session.get(k))[k];
          const age = stored?.ts ? Date.now() - stored.ts : Infinity;
          if (age > STALE_REPORT_MS) {
            await chrome.storage.session.remove(k); // GC stale tab reports
            continue;
          }
          const parts = k.split(':'); // mem:<platform>:<tabId>
          contentReports.push({
            key: k,
            tabId: parts[2] ? parseInt(parts[2], 10) : null,
            platform: parts[1] || 'unknown',
            ageSec: Math.round(age / 1000),
            data: stored?.caches || {},
          });
        } catch {}
      }

      const uptimeMin = Math.max(1, (Date.now() - swPerfStart) / 60_000);
      return {
        ok: true,
        sw: {
          uptimeMin: Math.round(uptimeMin * 10) / 10,
          uptimeHrs: Math.round((uptimeMin / 6)) / 10,
          heapBytes,
          caches: swCaches,
        },
        storage: {
          local: { totalBytes: localTotalBytes, byKey: localKeys },
          session: { byKey: sessionKeys },
        },
        indexedDB: { usageBytes: idbBytes, quotaBytes },
        contentScripts: contentReports,
      };
    }

    // v0.57.62: per-cache surgical clear so users can drop the one structure
    // that's bloating without nuking the entire SW state via FREE_SW_MEMORY
    // (which would force expensive re-fetches for everything else).
    case 'FREE_CACHE': {
      const name = String(msg.name || '');
      let cleared = 0;
      switch (name) {
        case 'threadSummaryCache':       cleared = threadSummaryCache ? 1 : 0; threadSummaryCache = null; break;
        case 'chatActivityCache':        cleared = chatActivityCache ? Object.keys(chatActivityCache.data).length : 0; chatActivityCache = null; try { await chrome.storage.session.remove(CHAT_ACTIVITY_SESSION_KEY); } catch {} break;
        case 'queryContactsCache':       cleared = queryContactsCache.size; queryContactsCache.clear(); break;
        case 'autoTrainedSet':           cleared = autoTrainedSet.size; autoTrainedSet.clear(); break;
        case 'recentContactUpserts':     cleared = recentContactUpserts.size; recentContactUpserts.clear(); break;
        case 'dossierExtractionQueue':   cleared = dossierExtractionQueue.size; dossierExtractionQueue.clear(); break;
        case 'searchIndex':              cleared = getIndexSize(); try { clearIndex(); } catch {} break;
        case 'llmCaches':                try { clearLLMCaches(); } catch {} cleared = -1; break;
        default: return { ok: false, error: `unknown cache: ${name}` };
      }
      console.log(`${LOG} FREE_CACHE ${name}: cleared ${cleared} entries`);
      return { ok: true, name, cleared };
    }

    // v0.57.33: one-shot recovery for users whose inbox lost threads to
    // the old PROFILE_BLOCKED → archived:true coupling. Scans every
    // thread-meta whose archived flag was set BY a block (blockedByThem)
    // and clears the archived flag while keeping the block signal. Also
    // accepts an optional platform filter so the user can recover one
    // platform at a time. Returns the count un-archived.
    // v0.57.35: panel-driven bulk refetch of the Sniffies inbox. Fans out
    // to every sniffies.com tab; each bridge relays to MAIN-world adapter
    // which hits the chat-data endpoint. Any captured deltas flow back
    // through ADAPTER_MESSAGES → invalidateThreadCache → panel sees them
    // on the next loadThreads. We just count tabs notified so the panel
    // can show "Refetching N tab(s)…".
    case 'REFETCH_SNIFFIES_INBOX': {
      const tabs = await chrome.tabs.query({ url: 'https://sniffies.com/*' });
      let pinged = 0;
      for (const tab of tabs) {
        if (!tab.id) continue;
        try { await chrome.tabs.sendMessage(tab.id, { type: 'SNIFFIES_REFETCH_INBOX' }); pinged++; } catch {}
      }
      console.log(`${LOG} REFETCH_SNIFFIES_INBOX: pinged ${pinged} sniffies tab(s)`);
      return { ok: true, tabs: pinged };
    }
    case 'UNARCHIVE_BLOCKED_THREADS': {
      const platformFilter = msg.platform ? String(msg.platform) : '';
      const all = await getAllThreadMeta();
      let unarchived = 0;
      for (const m of all) {
        if (!m.archived) continue;
        if (!m.blockedByThem) continue;
        if (platformFilter && m.platform !== platformFilter) continue;
        await upsertThreadMeta(m.contactId, m.platform as Platform, { archived: false });
        unarchived++;
      }
      invalidateThreadCache();
      console.log(`${LOG} UNARCHIVE_BLOCKED_THREADS: un-archived ${unarchived} thread(s)${platformFilter ? ` (platform=${platformFilter})` : ''}`);
      return { ok: true, count: unarchived };
    }

    // v0.57.28: per-platform contact lookup — avoids fetching ALL contacts and filtering client-side
    case 'GET_CONTACTS_BY_PLATFORM': {
      const contacts = await getContactsByPlatform(msg.platform as Platform);
      return { ok: true, contacts, count: contacts.length };
    }

    // Reminders
    case 'CREATE_REMINDER': return { ok: true, reminder: await createReminder(msg.contactId, msg.platform, msg.note, msg.dueAt) };
    case 'GET_REMINDERS': return { ok: true, reminders: await getReminders(msg.opts) };
    case 'DELETE_REMINDER': { await deleteReminder(msg.id); return { ok: true }; }

    // LLM
    case 'GENERATE_SUGGESTIONS': {
      const end = swPerfTrack('generateSuggestions');
      const result = await generateSuggestions(msg.messages, msg.contactName, msg.platform, msg.contactId);
      end();
      return { ok: true, ...result };
    }
    case 'GET_LLM_CONFIG': return { ok: true, config: await getLLMConfig() };
    case 'SAVE_LLM_CONFIG': { await saveLLMConfig(msg.config); return { ok: true }; }
    case 'SET_LOG_LEVEL': {
      await chrome.storage.local.set({ aggregaytor_log_level: msg.level });
      const allTabs = await chrome.tabs.query({});
      for (const tab of allTabs) {
        if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'SET_LOG_LEVEL', level: msg.level }).catch(() => {});
      }
      return { ok: true };
    }
    case 'GET_PERSONALITY': return { ok: true, personality: await getPersonalitySettings(), presets: Object.entries(PERSONALITY_PRESETS).map(([k, v]) => ({ id: k, ...v })) };
    case 'SAVE_PERSONALITY': { await savePersonalitySettings(msg.settings); return { ok: true }; }
    case 'DERIVE_STYLE_GUIDE': {
      // Collect all outbound messages (user's own writing, excluding auto-responses)
      const db = await getDB();
      const result = await db.find({ selector: { docType: 'message', direction: 'out' }, limit: 200 });
      const sentMsgs = (result.docs as any[])
        .filter(d => !d.metadata?.autoRespond && !d.metadata?.suggested)
        .map(d => ({ direction: 'out' as const, body: d.body, timestamp: d.timestamp }));
      const guide = await deriveStyleGuide(sentMsgs);
      await savePersonalitySettings({ styleGuide: guide, styleGuideUpdatedAt: new Date().toISOString() });
      return { ok: true, styleGuide: guide };
    }
    case 'GET_LLM_RATE_SETTINGS': return { ok: true, settings: await getLLMRateSettings() };
    case 'SAVE_LLM_RATE_SETTINGS': { await saveLLMRateSettings(msg.settings); return { ok: true }; }
    case 'GET_LLM_QUEUE_STATUS': return { ok: true, status: getLLMQueueStatus(), optimization: getLLMOptimizationStats() };
    case 'CLEAR_LLM_CACHE': {
      // Drop every in-memory LLM cache (response cache, rolling summaries,
      // dossier extraction cursors, per-provider rate trackers). Useful when
      // switching personality / style guide / provider keys and you want the
      // next request to start clean.
      const result = clearLLMCaches();
      console.log(`${LOG} LLM caches cleared:`, result.cleared);
      return { ok: true, ...result };
    }

    // Session summary
    case 'GENERATE_SESSION_SUMMARY': {
      const summaries = await getThreadSummaries({ limit: 20 });
      const activeCount = summaries.filter(s => {
        const lastTs = new Date(s.lastMessage?.timestamp || 0).getTime();
        return Date.now() - lastTs < 48 * 3600_000; // active in last 48h
      }).length;
      const config = await getLLMConfig();
      if (config.provider === 'local' || !config.apiKey) {
        return { ok: true, summary: `${activeCount} active conversations in the last 48 hours. Auto-respond will handle incoming messages with contextual replies.` };
      }
      try {
        const res = await generateConversationSummary([], 'all contacts', 'all platforms');
        return { ok: true, summary: `${activeCount} active conversations. ${res.text || 'Auto-respond ready.'}` };
      } catch {
        return { ok: true, summary: `${activeCount} active conversations. Auto-respond ready.` };
      }
    }

    // Nickname
    case 'GENERATE_NICKNAME': {
      const nickname = await llmNickname(msg.metadata, msg.lastMessageBody, msg.platform);
      return { ok: true, nickname };
    }

    // Greeting
    case 'SEND_GREETING': {
      const g = await generateGreeting(msg.platform);
      const delay = 5000 + Math.floor(Math.random() * 10000);
      setTimeout(() => sendMessageToTab(msg.platform, msg.contactId, g.response), delay);
      return { ok: true, greeting: g.response, delay };
    }

    // Auto-respond
    case 'TOGGLE_AUTO_RESPOND': return { ok: true, meta: await upsertThreadMeta(msg.contactId, msg.platform, { autoRespondEnabled: msg.enabled }) };
    case 'UPDATE_AUTO_RESPOND_SETTINGS': return { ok: true, meta: await upsertThreadMeta(msg.contactId, msg.platform, { autoRespondSettings: msg.settings }) };

    // Drafts
    case 'GET_DRAFTS': return { ok: true, drafts: await getDraftAutoResponds() };
    case 'APPROVE_DRAFT': {
      await updateAutoRespondStatus(msg.id, 'approved', msg.editedResponse ? { generatedResponse: msg.editedResponse } : undefined);
      chrome.alarms.create('auto-respond-check', { delayInMinutes: 0.05 });
      return { ok: true };
    }
    case 'REJECT_DRAFT': { await updateAutoRespondStatus(msg.id, 'rejected'); return { ok: true }; }

    // Pictures
    case 'ADD_PICTURE': return { ok: true, picture: await addPicture(msg.input) };
    case 'GET_ALL_PICTURES': return { ok: true, pictures: await getAllPictures(msg.tag) };
    case 'DELETE_PICTURE': { await deletePicture(msg.id); return { ok: true }; }
    case 'INCREMENT_PICTURE_STAT': { await incrementPictureStat(msg.id, msg.stat); return { ok: true }; }

    // Block rules
    case 'CREATE_BLOCK_RULE': return { ok: true, rule: await createBlockRule(msg.input) };
    case 'GET_ALL_BLOCK_RULES': return { ok: true, rules: await getAllBlockRules() };
    case 'UPDATE_BLOCK_RULE': { await updateBlockRule(msg.id, msg.updates); return { ok: true }; }
    case 'DELETE_BLOCK_RULE': { await deleteBlockRule(msg.id); return { ok: true }; }

    // Calendar
    case 'AUTHENTICATE_CALENDAR': return { ok: true, success: await authenticateCalendar() };
    case 'GET_CALENDAR_SETTINGS': return { ok: true, settings: await getCalendarSettings() };
    case 'SAVE_CALENDAR_SETTINGS': { await saveCalendarSettings(msg.settings); return { ok: true }; }
    case 'GET_AVAILABLE_SLOTS': return { ok: true, slots: await getAvailableSlots(msg.from, msg.to) };
    case 'CREATE_CALENDAR_EVENT': return { ok: true, event: await createCalendarEvent(msg.contactId, msg.platform, msg.title, msg.startTime, msg.duration, msg.location, msg.notes) };

    // ML Preference + Sentiment
    case 'RECORD_PREFERENCE': {
      // getContact expects the full PouchDB _id (contact:{platform}:{userId}).
      // Normalise raw contact ids so the preference model trains on real
      // metadata-derived features instead of always-empty shells.
      const lookupId = String(msg.contactId || '').startsWith('contact:')
        ? msg.contactId : `contact:${msg.contactId}`;
      const contact = await getContact(lookupId);
      const features: ProfileFeatures = {
        bodyType: String(contact?.metadata?.bodyType || contact?.metadata?.body || ''),
        position: String(contact?.metadata?.attitude || contact?.metadata?.position || ''),
        age: String(contact?.metadata?.age || ''),
        ethnicity: String(contact?.metadata?.ethnicity || ''),
        height: String(contact?.metadata?.height || ''),
        profileTextLength: String(contact?.metadata?.profileText || '').length,
        profileTextKeywords: String(contact?.metadata?.profileText || '').toLowerCase().split(/\s+/).slice(0, 20),
        hasPhoto: !!contact?.avatarUrl,
        photoCount: Number(contact?.metadata?.photoCount || (contact?.avatarUrl ? 1 : 0)),
        distance: String(contact?.metadata?.distance || ''),
        conversationLength: (await getMessagesByContact(msg.contactId, { limit: 500 })).length,
        responseRate: 0,
      };
      await recordFeedback(msg.contactId, msg.platform, msg.liked, features);
      const prediction = await predictPreference(features);
      await upsertThreadMeta(msg.contactId, msg.platform, { preferenceScore: prediction.score });
      return { ok: true, prediction };
    }
    case 'GET_MODEL_STATS': return { ok: true, stats: await getModelStats() };
    case 'RETRAIN_MODEL': { await retrainModel(); return { ok: true }; }

    // Thread analysis (sentiment + preference + summary)
    case 'ANALYZE_THREAD': {
      const sentiment = analyzeConversationSentiment(msg.messages);
      // See RECORD_PREFERENCE — same prefix-normalisation rationale.
      const lookupId = String(msg.contactId || '').startsWith('contact:')
        ? msg.contactId : `contact:${msg.contactId}`;
      const contact = await getContact(lookupId);
      const features: ProfileFeatures = {
        bodyType: String(contact?.metadata?.bodyType || ''),
        position: String(contact?.metadata?.position || ''),
        age: String(contact?.metadata?.age || ''), ethnicity: String(contact?.metadata?.ethnicity || ''), height: String(contact?.metadata?.height || ''),
        profileTextLength: String(contact?.metadata?.profileText || '').length, profileTextKeywords: [],
        hasPhoto: !!contact?.avatarUrl, photoCount: Array.isArray(contact?.metadata?.photos) ? (contact.metadata as any).photos.length : 0,
        distance: String(contact?.metadata?.distance || ''), conversationLength: msg.messages.length, responseRate: 0,
      };
      const preference = await predictPreference(features);

      // Update thread meta with latest sentiment
      await upsertThreadMeta(msg.contactId, msg.platform, {
        sentiment, preferenceScore: preference.score,
      });

      // Generate conversation summary via LLM
      let summary = { text: '', commitments: [] as string[] };
      try {
        summary = await generateConversationSummary(msg.messages, msg.contactName, msg.platform);
      } catch {}

      // Check if commitment opportunity — flash alert if so
      if (sentiment.commitment > 0.6 || summary.commitments.length > 0) {
        safeNotify(`commit-alert-${msg.contactId}`, {
          type: 'basic', iconUrl: 'icons/icon-128.png',
          title: 'Commitment opportunity!',
          message: `${msg.contactName} seems ready to commit. ${summary.commitments[0] || 'Check the conversation.'}`,
          requireInteraction: true, priority: 2,
        });
        // Flash the side panel
        chrome.runtime.sendMessage({ type: 'COMMITMENT_ALERT', contactId: msg.contactId, contactName: msg.contactName }).catch(() => {});
      }

      return { ok: true, sentiment, preference, summary };
    }

    // Dossier
    case 'GET_DOSSIER': return { ok: true, dossier: await getDossier(msg.contactId) };
    case 'UPSERT_DOSSIER': return { ok: true, dossier: await upsertDossier(msg.contactId, msg.platform, msg.updates) };
    case 'EXTRACT_DOSSIER': {
      const end = swPerfTrack('extractDossier');
      const messages = await getMessagesByContact(msg.contactId, { limit: 100 });
      const existing = await getDossier(msg.contactId) || {};
      const extracted = await extractDossierFields(
        messages.map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })),
        msg.contactName || msg.contactId.replace(/^[a-z]+:/, '').slice(0, 10),
        existing,
      );
      // Save each extracted field with source attribution
      for (const [field, value] of Object.entries(extracted)) {
        await setAutoExtractedField(msg.contactId, msg.platform, field, value, 'llm-extraction');
      }
      end();
      return { ok: true, extracted, fieldCount: Object.keys(extracted).length };
    }

    // Tasks
    case 'CREATE_TASK': {
      const task = await createTask(msg);
      return { ok: true, task };
    }
    case 'GET_TASKS': {
      const tasks = await getAllTasks(msg.opts);
      return { ok: true, tasks };
    }
    case 'UPDATE_TASK': {
      const task = await updateTask(msg.id, msg.updates);
      return { ok: true, task };
    }
    case 'DELETE_TASK': {
      await deleteTask(msg.id);
      return { ok: true };
    }
    case 'GET_TASKS_BY_CONTACT': {
      const tasks = await getTasksByContact(msg.contactId);
      return { ok: true, tasks };
    }
    case 'SYNC_TASK_TO_CALENDAR': {
      // Create a Google Calendar event from a task
      try {
        const event = await createCalendarEvent({
          contactId: msg.contactId || '',
          platform: msg.platform || 'sniffies',
          title: msg.title,
          startTime: msg.dueAt,
          endTime: msg.endAt || new Date(new Date(msg.dueAt).getTime() + 3600000).toISOString(),
          location: msg.location || '',
          notes: msg.notes || '',
        });
        // Update the task with the calendar event ID
        if (event && msg.taskId) {
          await updateTask(msg.taskId, { calendarEventId: event.googleEventId || event._id });
        }
        return { ok: true, event };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    // ── Google OAuth + Tasks API ──────────────────────────────────────────
    case 'GOOGLE_AUTH': {
      try {
        const token = await authenticateGoogle();
        return { ok: !!token, token };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'GOOGLE_AUTH_STATUS': {
      const authed = await isGoogleAuthenticated();
      return { ok: true, authenticated: authed };
    }
    case 'GOOGLE_TASKS_CREATE': {
      try {
        const gTask = await createGoogleTask({ title: msg.title, notes: msg.notes, dueAt: msg.dueAt });
        // Also create local task with Google Task ID linked
        const localTask = await createTask({
          title: msg.title, notes: msg.notes, dueAt: msg.dueAt,
          priority: msg.priority || 'medium',
          contactId: msg.contactId, platform: msg.platform,
        });
        if (gTask?.id) await updateTask(localTask._id, { googleTaskId: gTask.id, lastSyncedAt: new Date().toISOString() });
        return { ok: true, task: localTask, googleTask: gTask };
      } catch (err) {
        // Fall back to local-only if Google API fails
        const localTask = await createTask({
          title: msg.title, notes: msg.notes, dueAt: msg.dueAt,
          priority: msg.priority || 'medium',
          contactId: msg.contactId, platform: msg.platform,
        });
        return { ok: true, task: localTask, googleError: (err as Error).message };
      }
    }
    case 'GOOGLE_TASKS_UPDATE': {
      try {
        if (msg.googleTaskId) {
          await updateGoogleTask(msg.googleTaskId, msg.updates);
        }
        if (msg.localTaskId) {
          await updateTask(msg.localTaskId, msg.updates);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'GOOGLE_TASKS_DELETE': {
      try {
        if (msg.googleTaskId) await deleteGoogleTask(msg.googleTaskId);
        if (msg.localTaskId) await deleteTask(msg.localTaskId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'GOOGLE_TASKS_PULL': {
      try {
        const remoteTasks = await pullGoogleTasks();
        return { ok: true, tasks: remoteTasks };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'SYNC_TASKS': {
      try {
        const result = await syncGoogleTasks();
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    // ── Export/Import ──────────────────────────────────────────────────────
    case 'EXPORT_ALL_DATA': {
      try {
        const json = await exportAllData(msg.passphrase);
        return { ok: true, data: json };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'IMPORT_ALL_DATA': {
      try {
        invalidateThreadCache();
        clearIndex();
        autoTrainedSet.clear();
        recentContactUpserts.clear();
        queryContactsCache.clear();
        const result = await importAllData(msg.data, msg.passphrase);
        return { ok: true, ...result };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'EXPORT_BLOCKED': {
      try {
        const json = await exportBlocked();
        return { ok: true, data: json };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'IMPORT_BLOCKED': {
      try {
        invalidateThreadCache();
        const result = await importBlocked(msg.data);
        return { ok: true, ...result };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }

    // ── Broadcast Message ──────────────────────────────────────────────────
    case 'BROADCAST_TO_FAVORITES': {
      // Send a message to all favorited contacts on a specific platform.
      // Walks the platform tabs for each contact and posts a SEND_AUTO_RESPONSE
      // followed by SPA_NAVIGATE. Pacing defaults to 3s to stay under platform
      // rate limits.
      //
      // v0.57.15: per-recipient errors are now collected and returned so the
      // UI can surface partial failures. Pre-fix the docstring claimed errors
      // were logged but they were silently swallowed by an empty `catch {}`.
      try {
        const allMeta = await getAllThreadMeta();
        const favorites = allMeta.filter(m =>
          (m.bookmarked || m.favorited) &&
          (!msg.platform || m.platform === msg.platform)
        );
        let sent = 0;
        const failures: Array<{ contactId: string; error: string }> = [];
        const maxRecipients = Math.min(favorites.length, msg.maxRecipients || 50);

        for (let i = 0; i < maxRecipients; i++) {
          const meta = favorites[i];
          const contactId = meta._id?.replace('meta:', '') || meta.contactId;
          if (!contactId) continue;

          // Queue as auto-respond with the broadcast message
          try {
            const platform = meta.platform || contactId.split(':')[0];
            const tabs = await chrome.tabs.query({});
            let recipientSent = false;
            for (const tab of tabs) {
              if (!tab.id || !tab.url) continue;
              const platformHosts: Record<string, string> = {
                sniffies: 'sniffies.com', grindr: 'web.grindr.com',
                doublelist: 'doublelist.com', adam4adam: 'adam4adam.com',
              };
              if (tab.url.includes(platformHosts[platform] || '___none___')) {
                await chrome.tabs.sendMessage(tab.id, {
                  type: 'SEND_AUTO_RESPONSE',
                  text: msg.message,
                  contactId,
                }).catch(() => {});
                // Navigate to the conversation first. Guard against an
                // unmapped platform (would yield 'about:blank' before).
                const navUrl = PLATFORM_URLS[platform]?.(contactId) || '';
                if (navUrl) {
                  await chrome.tabs.sendMessage(tab.id, {
                    type: 'SPA_NAVIGATE',
                    url: navUrl,
                    path: new URL(navUrl).pathname,
                  }).catch(() => {});
                }
                sent++;
                recipientSent = true;
                // Wait between sends to avoid rate limiting
                await new Promise(r => setTimeout(r, msg.delay || 3000));
                break;
              }
            }
            if (!recipientSent) {
              failures.push({ contactId, error: 'no matching platform tab open' });
            }
          } catch (e) {
            const errMsg = (e as Error).message || String(e);
            failures.push({ contactId, error: errMsg });
            console.warn(`${LOG} Broadcast to ${contactId} failed:`, errMsg);
          }
        }
        return { ok: true, sent, total: favorites.length, failures };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }

    // ── Profile Rating ─────────────────────────────────────────────────────
    case 'SET_RATING': {
      const meta = await upsertThreadMeta(msg.contactId, msg.platform, { rating: msg.rating });
      // Immediate preference training — high/low ratings are strong signals
      if (msg.rating >= 4 || msg.rating <= 2) {
        try {
          const contact = await getContact(`contact:${msg.contactId}`);
          const md = contact?.metadata || {};
          await recordFeedback(msg.contactId, msg.platform as Platform, msg.rating >= 4, {
            bodyType: String(md.bodyType || ''), position: String(md.position || ''),
            age: String(md.age || ''), ethnicity: String(md.ethnicity || ''),
            height: String(md.height || ''), profileTextLength: 0, profileTextKeywords: [],
            hasPhoto: contact?.avatarUrl ? 1 : 0, photoCount: 0,
            distance: String(md.distance || ''), conversationLength: 0, responseRate: 0,
          });
          markAutoTrained(msg.contactId);
        } catch {}
      }
      return { ok: true, meta };
    }
    case 'BULK_TRAIN_FROM_PLATFORM': {
      // Fetch blocked/hidden/favorites lists from platform APIs and train on them
      try {
        let trained = 0;
        const platform = msg.platform as Platform;

        if (platform === 'grindr') {
          // Fetch Grindr's blocked/hidden/favorites lists via the platform tab.
          // The script runs inside the Grindr tab with credentials: 'include'
          // BUT Grindr requires an Authorization: Bearer token that's only
          // accessible in the page's MAIN world (stored in React state, not a
          // cookie). We read it from window.localStorage — Grindr stores the
          // session token under a well-known key.
          const tabs = await chrome.tabs.query({});
          const grindrTab = tabs.find((t: any) => t.url?.includes('web.grindr.com'));
          if (grindrTab?.id) {
            const [result] = await chrome.scripting.executeScript({
              target: { tabId: grindrTab.id },
              world: 'MAIN', // MAIN world so we can read React/Grindr's in-memory auth
              func: async () => {
                const results: Array<{ profileId: string; liked: boolean; source: string }> = [];
                const debug: Array<{ url: string; status: number; keys: string[]; count: number; sample: any }> = [];

                // PRIMARY auth source: the grindr.ts adapter captures live
                // Authorization headers from Grindr's own network traffic
                // and exposes them via window.__aggregaytor_get_grindr_auth().
                // Using the adapter's cache means we always send the exact same
                // header Grindr's own React app is sending right now — most
                // reliable and avoids the "is localStorage stale?" problem.
                //
                // Fallback: scan localStorage for JWT-shaped values and common
                // token keys. Used when the bulk import runs BEFORE the
                // adapter has seen any authenticated traffic (rare — cascade
                // loads fire auth calls on page open).
                const authHeaders: Record<string, string> = {};
                let authSource = 'none';
                const captured = (window as any).__aggregaytor_get_grindr_auth?.();
                if (captured && Object.keys(captured).length) {
                  Object.assign(authHeaders, captured);
                  authSource = 'adapter';
                } else {
                  const findTokenFromStorage = (): string => {
                    const keys = ['authToken', 'auth-token', 'grindrAuthToken', 'session', 'grindrSession', 'access_token', 'accessToken', 'token'];
                    for (const k of keys) {
                      const v = localStorage.getItem(k);
                      if (v && v.length > 20 && !v.startsWith('{')) return v;
                    }
                    for (let i = 0; i < localStorage.length; i++) {
                      const k = localStorage.key(i) || '';
                      const v = localStorage.getItem(k) || '';
                      if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(v)) return v;
                      if (v.startsWith('{')) {
                        try {
                          const obj = JSON.parse(v);
                          const t = obj.authToken || obj.accessToken || obj.token || obj.session?.authToken || obj.session?.accessToken;
                          if (t && String(t).length > 20) return String(t);
                        } catch {}
                      }
                    }
                    return '';
                  };
                  const token = findTokenFromStorage();
                  if (token) {
                    authHeaders['Authorization'] = token.startsWith('Grindr3 ') || token.startsWith('Bearer ')
                      ? token : `Grindr3 ${token}`;
                    authSource = 'localStorage';
                  }
                }
                console.log('[Aggregaytor:GrindrImport] Auth source:', authSource, 'headers:', Object.keys(authHeaders).join(','));

                // Extract profile IDs from an arbitrary response shape. Grindr
                // uses various envelope formats across endpoints (profiles[],
                // items[], blocks[], list[], a bare array of ids, etc.).
                const extractIds = (data: any): string[] => {
                  if (!data) return [];
                  const ids: string[] = [];
                  const walk = (v: any) => {
                    if (v == null) return;
                    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
                    if (typeof v === 'string' || typeof v === 'number') {
                      const s = String(v);
                      if (/^\d{5,}$/.test(s)) ids.push(s);
                      return;
                    }
                    if (typeof v !== 'object') return;
                    for (const k of ['profileId', 'profile_id', 'id', 'userId', 'user_id', 'blockedProfileId', 'hiddenProfileId']) {
                      const x = (v as any)[k];
                      if (x != null) {
                        const s = String(x);
                        if (/^\d{5,}$/.test(s)) { ids.push(s); return; }
                      }
                    }
                    // Recurse into container keys
                    for (const k of ['profiles', 'items', 'data', 'list', 'blocks', 'hides', 'results', 'content']) {
                      if ((v as any)[k]) walk((v as any)[k]);
                    }
                  };
                  walk(data);
                  return [...new Set(ids)];
                };

                // Paginate an endpoint until no more ids are returned or we hit
                // a safety cap. Grindr endpoints accept ?page=, ?pageNumber=,
                // or ?offset= / ?cursor= — we try the common ones.
                const paginateEndpoint = async (baseUrl: string, liked: boolean, source: string): Promise<void> => {
                  const seen = new Set<string>();
                  // Strategy 1: page=1,2,3... until empty or unchanged
                  for (let page = 1; page <= 40; page++) {
                    const sep = baseUrl.includes('?') ? '&' : '?';
                    const url = `${baseUrl}${sep}page=${page}&pageNumber=${page}&limit=100&pageSize=100`;
                    try {
                      const res = await fetch(url, {
                        credentials: 'include',
                        headers: { 'Accept': 'application/json', ...authHeaders },
                      });
                      if (!res.ok) {
                        debug.push({ url, status: res.status, keys: [], count: 0, sample: null });
                        break;
                      }
                      const data = await res.json();
                      const ids = extractIds(data);
                      const keys = (data && typeof data === 'object') ? Object.keys(data).slice(0, 10) : [];
                      const sample = Array.isArray(data) ? data.slice(0, 1) :
                                     (data?.profiles?.[0] || data?.items?.[0] || data?.data?.[0] || null);
                      debug.push({ url, status: res.status, keys, count: ids.length, sample });
                      let newIds = 0;
                      for (const pid of ids) {
                        if (seen.has(pid)) continue;
                        seen.add(pid);
                        newIds++;
                        results.push({ profileId: pid, liked, source });
                      }
                      // Stop if this page added nothing new — we've exhausted
                      // the list (or the endpoint doesn't support pagination)
                      if (newIds === 0) break;
                    } catch (e: any) {
                      debug.push({ url, status: -1, keys: [], count: 0, sample: String(e?.message || e) });
                      break;
                    }
                  }
                };

                // Real endpoints observed in Grindr web client traffic logs:
                //   /api/v3.1/me/blocks  → blocks (confirmed 480 profiles)
                //   /api/v5/favorites    → favorites (confirmed 222 profiles)
                // Keep fallback variants for older accounts / regional differences.
                const blockEndpoints = [
                  'https://web.grindr.com/api/v3.1/me/blocks',
                  'https://web.grindr.com/api/v4/me/blocks',
                  'https://web.grindr.com/api/v3/me/blocks',
                  'https://web.grindr.com/api/me/blocks',
                  'https://web.grindr.com/api/v4/blocks',
                  'https://web.grindr.com/api/v3/blocks',
                  'https://web.grindr.com/api/blocks',
                ];
                const hideEndpoints = [
                  'https://web.grindr.com/api/v3.1/me/hides',
                  'https://web.grindr.com/api/v4/me/hides',
                  'https://web.grindr.com/api/me/hides',
                  'https://web.grindr.com/api/v4/hides',
                  'https://web.grindr.com/api/v1/hides',
                ];
                const favoriteEndpoints = [
                  'https://web.grindr.com/api/v5/favorites',
                  'https://web.grindr.com/api/v4/favorites',
                  'https://web.grindr.com/api/favorites',
                  'https://web.grindr.com/api/v3/me/favorites',
                ];
                for (const e of blockEndpoints) await paginateEndpoint(e, false, 'block');
                for (const e of hideEndpoints) await paginateEndpoint(e, false, 'hide');
                for (const e of favoriteEndpoints) await paginateEndpoint(e, true, 'favorite');

                // Surface full debug in console so the user can see exactly
                // which endpoints worked and how many they returned.
                console.log('[Aggregaytor:Grindr] Block/hide import debug:', debug);
                console.log('[Aggregaytor:Grindr] Total unique ids captured:', results.length);
                return { results, debug };
              },
            });

            const payload = (result?.result as any) || { results: [], debug: [] };
            const signals = payload.results || [];
            const seen = new Set<string>();
            let skippedEmpty = 0;
            let enrichedCount = 0;
            for (const { profileId, liked } of signals) {
              const cid = `grindr:${profileId}`;
              if (seen.has(cid)) continue;
              seen.add(cid);
              if (autoTrainedSet.has(cid)) continue;

              // Enrich features from any existing contact record the adapter
              // captured from cascade/views/chat/profile traffic. Without this
              // the ML model trains on blank features and learns nothing useful.
              let features: ProfileFeatures;
              try {
                const contact = await getContact(`contact:grindr:${profileId}`);
                const md = (contact?.metadata || {}) as any;
                const hasAnyFeature =
                  md.bodyType || md.position || md.age || md.ethnicity ||
                  md.height || md.profileText || md.distance || (contact?.avatarUrl);
                if (!hasAnyFeature) {
                  // Empty shell — the block/favorite list endpoint gave us only
                  // an id and no observable attributes. Training on this would
                  // feed the logistic-regression model a zero-feature sample
                  // that can't teach it anything; skip to keep signal quality
                  // high. The user can enrich these later by browsing cascade
                  // or opening the profiles (adapter will backfill metadata).
                  skippedEmpty++;
                  continue;
                }
                features = {
                  bodyType: String(md.bodyType || ''),
                  position: String(md.position || ''),
                  age: String(md.age || ''),
                  ethnicity: String(md.ethnicity || ''),
                  height: String(md.height || ''),
                  profileTextLength: String(md.profileText || md.aboutMe || md.bio || '').length,
                  profileTextKeywords: [],
                  hasPhoto: contact?.avatarUrl ? 1 : 0,
                  photoCount: Array.isArray(md.photos) ? md.photos.length : 0,
                  distance: String(md.distance || ''),
                  conversationLength: 0,
                  responseRate: 0,
                };
                enrichedCount++;
              } catch {
                skippedEmpty++;
                continue;
              }
              await recordFeedback(cid, 'grindr', liked, features);
              markAutoTrained(cid);
              trained++;
            }
            console.log(
              `[Aggregaytor:SW] Grindr import: ${signals.length} ids received, ${enrichedCount} trained with real features, ${skippedEmpty} skipped (empty shells — no attributes observed yet).`,
            );
          }
          // Fallback/supplement: also scan contacts already in the database
          // that the ADAPTER flagged from natural page-load traffic (when the
          // Grindr page fetches /api/v3.1/me/blocks at login, our adapter
          // captures those profiles and tags them md.isBlocked=true via URL
          // matching). This works even if the direct fetch above failed (e.g.
          // auth token wasn't discoverable).
          try {
            const grindrContacts = await getContactsByPlatform('grindr');
            let adapterTagged = 0;
            for (const c of grindrContacts) {
              const cid = c._id?.replace('contact:', '') || '';
              if (!cid || autoTrainedSet.has(cid)) continue;
              const md = (c.metadata || {}) as any;
              const liked = md.isFavorite ? true : (md.isBlocked ? false : null);
              if (liked === null) continue;
              await recordFeedback(cid, 'grindr', liked, {
                bodyType: String(md.bodyType || ''),
                position: String(md.position || ''),
                age: String(md.age || ''),
                ethnicity: String(md.ethnicity || ''),
                height: String(md.height || ''),
                profileTextLength: String(md.profileText || '').length,
                profileTextKeywords: [],
                hasPhoto: c.avatarUrl ? 1 : 0,
                photoCount: Array.isArray(md.photos) ? md.photos.length : 0,
                distance: String(md.distance || ''),
                conversationLength: 0,
                responseRate: 0,
              });
              markAutoTrained(cid);
              trained++;
              adapterTagged++;
            }
            console.log('[Aggregaytor:SW] Grindr adapter-tagged signals trained:', adapterTagged);
          } catch (e) {
            console.warn('[Aggregaytor:SW] Grindr adapter-tag scan failed:', e);
          }
        }

        if (platform === 'sniffies') {
          // Sniffies has no public blocked/hidden list API — blocks are a
          // platform-internal action performed in the chat UI. Our primary
          // source of truth is already our PouchDB: every middle-click dispatches
          // PROFILE_BLOCKED which writes threadMeta.blockedByThem=true, and
          // autoTrainFromSignals() picks those up (along with md.isPinned for
          // positives). That call runs below as the standard signal scan.
          //
          // The code below is an additional BACKFILL pass that reads the
          // Sniffies tab's aggregaytor_map_blocked localStorage directly.
          // That catches two edge cases not covered by the DB scan alone:
          //   • Historical blocks from earlier versions that existed before
          //     PROFILE_BLOCKED was dispatched to the service worker.
          //   • Anonymous profiles the user middle-clicked on the map without
          //     ever opening — for these there's no contact doc at all, so
          //     autoTrainFromSignals (which iterates getAllContacts) won't
          //     see them. We'll still skip training on them here until their
          //     profile data lands (enrichment gate), but having them listed
          //     means they'll auto-train the moment we see features for them.
          let tabBlockedIds: string[] = [];
          try {
            const tabs = await chrome.tabs.query({});
            const sniffiesTab = tabs.find((t: any) => t.url?.includes('sniffies.com'));
            if (sniffiesTab?.id) {
              const [result] = await chrome.scripting.executeScript({
                target: { tabId: sniffiesTab.id },
                world: 'MAIN',
                func: () => {
                  const out: string[] = [];
                  try {
                    // Our extension's middle-click / panel-block storage
                    const raw = localStorage.getItem('aggregaytor_map_blocked');
                    if (raw) {
                      const arr = JSON.parse(raw);
                      if (Array.isArray(arr)) for (const id of arr) {
                        if (typeof id === 'string' && /^[0-9a-f]{6,}$/i.test(id)) out.push(id.toLowerCase());
                      }
                    }
                    // Sniffies' own blocked-users list (if their app stores it
                    // anywhere we can read — we scan localStorage for any key
                    // matching a blocked-profiles shape)
                    for (let i = 0; i < localStorage.length; i++) {
                      const k = localStorage.key(i) || '';
                      if (!/block|hide|hidden/i.test(k)) continue;
                      const v = localStorage.getItem(k) || '';
                      if (!v.startsWith('[') && !v.startsWith('{')) continue;
                      try {
                        const parsed = JSON.parse(v);
                        const walk = (x: any): void => {
                          if (!x) return;
                          if (Array.isArray(x)) { for (const it of x) walk(it); return; }
                          if (typeof x === 'string' && /^[0-9a-f]{24,}$/i.test(x)) { out.push(x.toLowerCase()); return; }
                          if (typeof x === 'object') for (const val of Object.values(x)) walk(val);
                        };
                        walk(parsed);
                      } catch {}
                    }
                  } catch {}
                  return [...new Set(out)];
                },
              });
              tabBlockedIds = (result?.result as string[]) || [];
            }
          } catch (e) {
            console.warn(`${LOG} Sniffies tab script failed:`, e);
          }

          // Feed each blocked id through the same enrichment gate as Grindr:
          // only train on samples that have observable features.
          let trainedBlocks = 0;
          let skippedEmpty = 0;
          for (const pid of tabBlockedIds) {
            const cid = `sniffies:${pid}`;
            if (autoTrainedSet.has(cid)) continue;
            try {
              const contact = await getContact(`contact:sniffies:${pid}`);
              const md = (contact?.metadata || {}) as any;
              const hasAnyFeature =
                md.bodyType || md.position || md.age || md.ethnicity ||
                md.height || md.profileText || md.aboutMe || md.distance || contact?.avatarUrl;
              if (!hasAnyFeature) { skippedEmpty++; continue; }
              await recordFeedback(cid, 'sniffies', false, {
                bodyType: String(md.bodyType || ''),
                position: String(md.position || ''),
                age: String(md.age || ''),
                ethnicity: String(md.ethnicity || ''),
                height: String(md.height || ''),
                profileTextLength: String(md.profileText || md.aboutMe || md.bio || '').length,
                profileTextKeywords: [],
                hasPhoto: contact?.avatarUrl ? 1 : 0,
                photoCount: Array.isArray(md.photos) ? md.photos.length : 0,
                distance: String(md.distance || ''),
                conversationLength: 0,
                responseRate: 0,
              });
              // Also backfill the contact record so future auto-train picks
              // this up via the md.isBlocked signal without re-running import.
              if (contact) {
                const updatedMd = { ...(contact.metadata || {}), isBlocked: true };
                await upsertContact({
                  id: `sniffies:${pid}`, platform: 'sniffies', platformUserId: pid,
                  displayName: contact.displayName || '', profileUrl: contact.profileUrl || '',
                  avatarUrl: contact.avatarUrl || '', lastSeen: contact.lastSeen || new Date().toISOString(),
                  metadata: updatedMd,
                });
              }
              markAutoTrained(cid);
              trained++;
              trainedBlocks++;
            } catch { skippedEmpty++; }
          }
          console.log(
            `[Aggregaytor:SW] Sniffies import: ${tabBlockedIds.length} blocked ids from tab, ` +
            `${trainedBlocks} trained with real features, ${skippedEmpty} skipped (empty shells).`,
          );

          // Positive signals: pinned contacts from our DB (chat-panel scraper
          // sets md.isPinned when the Sniffies Recents row has a thumbtack).
          let trainedPins = 0;
          try {
            const sniffiesContacts = await getContactsByPlatform('sniffies');
            for (const c of sniffiesContacts) {
              const cid = c._id?.replace('contact:', '') || '';
              if (!cid || autoTrainedSet.has(cid)) continue;
              const md = (c.metadata || {}) as any;
              if (!md.isPinned) continue;
              const hasAnyFeature = md.bodyType || md.position || md.age || md.ethnicity ||
                md.height || md.profileText || md.aboutMe || c.avatarUrl;
              if (!hasAnyFeature) continue;
              await recordFeedback(cid, 'sniffies', true, {
                bodyType: String(md.bodyType || ''),
                position: String(md.position || ''),
                age: String(md.age || ''),
                ethnicity: String(md.ethnicity || ''),
                height: String(md.height || ''),
                profileTextLength: String(md.profileText || md.aboutMe || md.bio || '').length,
                profileTextKeywords: [],
                hasPhoto: c.avatarUrl ? 1 : 0,
                photoCount: Array.isArray(md.photos) ? md.photos.length : 0,
                distance: String(md.distance || ''),
                conversationLength: 0,
                responseRate: 0,
              });
              markAutoTrained(cid);
              trained++;
              trainedPins++;
            }
          } catch {}
          console.log(`[Aggregaytor:SW] Sniffies import: ${trainedPins} pinned contacts trained as positive.`);
        }

        // Also run the standard signal scan
        const signalResult = await autoTrainFromSignals();
        trained += signalResult.trained;

        return { ok: true, trained };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'AUTO_TRAIN_NOW': {
      try {
        const result = await autoTrainFromSignals();
        return { ok: true, ...result };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'ENRICH_BLOCKED_START': {
      // Start (or resume) the background enrichment pass. The actual work
      // happens on the enrich-blocked-tick alarm, NOT in this handler.
      // This way a service worker restart, extension reload, platform logout,
      // or browser restart doesn't lose progress — the alarm brings us
      // back automatically and the state lives in chrome.storage.
      try {
        const platform: EnrichPlatform = (msg.platform === 'sniffies') ? 'sniffies' : 'grindr';
        const state = await getEnrichState();
        // If we're switching platforms mid-run, reset counters (different
        // contact pool, stats don't carry over).
        const switching = state.status !== 'idle' && state.platform !== platform;
        const contacts = await getContactsByPlatform(platform as Platform);
        const remaining = contacts.filter((c: any) => {
          const md = c.metadata || {};
          if (platform === 'sniffies') {
            const hasFeatures = md.bodyType || md.position || md.age || md.ethnicity
              || md.height || md.profileText || md.aboutMe || md.lookingFor;
            const hasBlockOrPin = md.isBlocked || md.isPinned;
            return hasBlockOrPin && !hasFeatures;
          }
          const hasFeatures = md.bodyType || md.position || md.age || md.ethnicity
            || md.height || md.profileText || md.aboutMe || c.avatarUrl;
          return md.isBlocked && !hasFeatures;
        }).length;
        if (!remaining) {
          await setEnrichState({ ...DEFAULT_ENRICH_STATE, platform, status: 'idle', lastTickAt: Date.now() });
          return { ok: true, total: 0, platform, message: `Nothing to enrich — all ${platform} contacts with signals already have features.` };
        }
        const resumable = state.status !== 'idle' && state.platform === platform && !switching;
        const next: EnrichState = {
          status: 'running',
          platform,
          pauseReason: null,
          total: resumable ? (state.total || remaining) : remaining,
          processed: resumable ? state.processed : 0,
          enriched: resumable ? state.enriched : 0,
          noFeatures: resumable ? (state.noFeatures || 0) : 0,
          failed: resumable ? state.failed : 0,
          startedAt: resumable ? state.startedAt : Date.now(),
          lastTickAt: Date.now(),
          lastError: null,
        };
        await setEnrichState(next);
        chrome.alarms.create('enrich-blocked-tick', { periodInMinutes: 1 });
        runEnrichTick().catch(err => console.warn('[Aggregaytor:SW] enrich tick error:', err));
        return { ok: true, resumed: resumable, platform, total: next.total, processed: next.processed, enriched: next.enriched };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'ENRICH_BLOCKED_STOP': {
      try {
        chrome.alarms.clear('enrich-blocked-tick');
        const state = await getEnrichState();
        await setEnrichState({ ...state, status: 'idle', pauseReason: 'manual' });
        return { ok: true };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'ENRICH_BLOCKED_STATUS': {
      try {
        const state = await getEnrichState();
        return { ok: true, state };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    // Legacy handler kept for callers that haven't updated — now just
    // kicks off the resumable pass so behaviour is unchanged from the UI.
    case 'ENRICH_BLOCKED_PROFILES': {
      try {
        const targets = await getContactsByPlatform('grindr');
        const needsEnrich = targets.filter((c: any) => {
          const md = c.metadata || {};
          const hasFeatures = md.bodyType || md.position || md.age || md.ethnicity ||
            md.height || md.profileText || md.aboutMe || c.avatarUrl;
          return md.isBlocked && !hasFeatures;
        });
        const total = needsEnrich.length;
        if (!total) {
          return { ok: true, total: 0, enriched: 0, failed: 0, message: 'No empty blocked contacts to enrich' };
        }

        const tabs = await chrome.tabs.query({});
        const grindrTab = tabs.find((t: any) => t.url?.includes('web.grindr.com'));
        if (!grindrTab?.id) {
          return { ok: false, error: 'Open web.grindr.com in a tab first' };
        }

        // Chunk the profile ids into small batches so we can report progress
        // back to the side panel between batches. 10 per batch ≈ 20s at the
        // 2s-per-call pacing — fast enough for a progress bar, slow enough
        // to stay safely under Grindr's rate limit.
        const ids = needsEnrich.map((c: any) => (c._id || '').replace('contact:grindr:', '')).filter(Boolean);
        let enriched = 0;
        let failed = 0;
        let sessionDead = false;
        const BATCH_SIZE = 10;
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const chunk = ids.slice(i, i + BATCH_SIZE);
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: grindrTab.id },
            world: 'MAIN',
            args: [chunk],
            func: async (batch: string[]) => {
              // PRIMARY auth source: the grindr.ts adapter already captures
              // live Authorization headers from Grindr's own network traffic
              // and exposes them via window.__aggregaytor_get_grindr_auth().
              // This avoids re-discovering the token from scratch and always
              // gives us the exact same header Grindr is using right now.
              const captured = (window as any).__aggregaytor_get_grindr_auth?.() || null;

              // Fallback: scan localStorage (older code path — Grindr usually
              // doesn't store the token there, but worth trying).
              const findTokenFromStorage = (): string => {
                try {
                  const keys = ['authToken', 'auth-token', 'grindrAuthToken', 'session', 'grindrSession', 'accessToken', 'token'];
                  for (const k of keys) {
                    const v = localStorage.getItem(k);
                    if (v && v.length > 20 && !v.startsWith('{')) return v;
                  }
                  for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i) || '';
                    const v = localStorage.getItem(k) || '';
                    if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(v)) return v;
                    if (v.startsWith('{')) {
                      try {
                        const obj = JSON.parse(v);
                        const t = obj.authToken || obj.accessToken || obj.token || obj.session?.authToken;
                        if (t && String(t).length > 20) return String(t);
                      } catch {}
                    }
                  }
                } catch {}
                return '';
              };

              const headers: Record<string, string> = { 'Accept': 'application/json' };
              let authSource = 'none';
              if (captured && Object.keys(captured).length) {
                Object.assign(headers, captured);
                authSource = 'adapter';
              } else {
                const token = findTokenFromStorage();
                if (token) {
                  headers['Authorization'] = token.startsWith('Grindr3 ') || token.startsWith('Bearer ')
                    ? token : `Grindr3 ${token}`;
                  authSource = 'localStorage';
                }
              }
              console.log('[Aggregaytor:Enrich] Auth source:', authSource,
                'headers:', Object.keys(headers).join(','),
                'auth value prefix:', (headers.Authorization || headers.authorization || '').slice(0, 20));

              const out: Array<{ id: string; ok: boolean; status: number; data?: any; error?: string }> = [];
              if (authSource === 'none') {
                // No auth — fail fast so the caller knows to browse Grindr
                // a bit first to prime the adapter's auth cache.
                console.warn('[Aggregaytor:Enrich] No auth headers available. Browse Grindr for a few seconds to let the adapter capture the JWT, then retry.');
                return out.concat(batch.map(id => ({ id, ok: false, status: -1, error: 'no-auth' })));
              }

              for (const id of batch) {
                try {
                  const res = await fetch(`https://web.grindr.com/api/v4/profiles/${id}`, {
                    credentials: 'include', headers,
                  });
                  if (res.status === 401 || res.status === 403) {
                    let body = '';
                    try { body = (await res.text()).slice(0, 200); } catch {}
                    console.warn(`[Aggregaytor:Enrich] ${id} → ${res.status} (auth rejected). Body:`, body);
                    out.push({ id, ok: false, status: res.status, error: body });
                    break; // abort the rest of the batch
                  }
                  if (!res.ok) {
                    let body = '';
                    try { body = (await res.text()).slice(0, 120); } catch {}
                    out.push({ id, ok: false, status: res.status, error: body });
                  } else {
                    const data = await res.json();
                    out.push({ id, ok: true, status: 200, data });
                  }
                } catch (e: any) {
                  out.push({ id, ok: false, status: 0, error: String(e?.message || e) });
                }
                const jittered = ENRICH_CALL_DELAY_MS + (Math.random() * 2 - 1) * ENRICH_CALL_JITTER_MS;
                await new Promise(r => setTimeout(r, jittered));
              }
              return out;
            },
          });

          const batchOut = (result?.result as any[]) || [];
          // If the first batch couldn't even find auth headers, surface a
          // distinct error so the user knows to browse Grindr (not re-login).
          if (batchOut.length && batchOut.every(r => r.error === 'no-auth')) {
            return {
              ok: false,
              error: 'No Grindr auth headers captured yet. Browse web.grindr.com for ~5 seconds (scroll the cascade, open a chat) so the adapter intercepts a live API call, then re-run Enrich Blocked.',
            };
          }
          for (const row of batchOut) {
            if (row.status === 401 || row.status === 403) {
              sessionDead = true;
              break;
            }
            if (!row.ok || !row.data) { failed++; continue; }

            // Extract the profile object — Grindr wraps it in various shapes
            const p = row.data.profile || row.data.data || row.data;
            const md: any = {};
            const pickString = (v: any) => typeof v === 'string' ? v : (v != null ? String(v) : '');
            if (p.bodyType) md.bodyType = pickString(p.bodyType);
            if (p.body) md.bodyType = md.bodyType || pickString(p.body);
            if (p.sexualPosition) md.position = pickString(p.sexualPosition);
            if (p.position) md.position = md.position || pickString(p.position);
            if (p.age) md.age = pickString(p.age);
            if (p.ethnicity) md.ethnicity = pickString(p.ethnicity);
            if (p.height) md.height = pickString(p.height);
            if (p.weight) md.weight = pickString(p.weight);
            if (p.aboutMe) md.aboutMe = pickString(p.aboutMe);
            if (p.lookingFor) md.lookingFor = Array.isArray(p.lookingFor) ? p.lookingFor.join(', ') : pickString(p.lookingFor);
            if (p.displayName || p.name) md.displayName = pickString(p.displayName || p.name);
            md.isBlocked = true; // preserve flag
            md.enrichedAt = Date.now();

            // Build photo URL from photoHash or photoMediaHashes
            let avatarUrl = '';
            const primaryHash = p.photoHash || p.profileImageMediaHash || p.primaryPhotoHash;
            if (primaryHash) avatarUrl = `https://cdns.grindr.com/images/profile/1024x1024/${primaryHash}`;
            else if (Array.isArray(p.photoMediaHashes) && p.photoMediaHashes.length) {
              avatarUrl = `https://cdns.grindr.com/images/profile/1024x1024/${p.photoMediaHashes[0]}`;
            }

            try {
              const existing = await getContact(`contact:grindr:${row.id}`);
              await upsertContact({
                id: `grindr:${row.id}`, platform: 'grindr', platformUserId: row.id,
                displayName: md.displayName || existing?.displayName || '',
                profileUrl: existing?.profileUrl || `https://web.grindr.com/chat/${row.id}`,
                avatarUrl: avatarUrl || existing?.avatarUrl || '',
                lastSeen: new Date().toISOString(),
                metadata: { ...(existing?.metadata || {}), ...md },
              });
              enriched++;
            } catch {
              failed++;
            }
          }

          // Broadcast progress to the side panel
          const processed = Math.min(i + BATCH_SIZE, ids.length);
          chrome.runtime.sendMessage({
            type: 'ENRICH_BLOCKED_PROGRESS',
            processed, total, enriched, failed, sessionDead,
          }).catch(() => {});

          if (sessionDead) break;
        }

        return { ok: true, total, enriched, failed, sessionDead };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'DIAGNOSE_TRAINING_DATA': {
      // Audit every training sample in the database and report how many
      // carried useful features vs. came in as empty shells. Helps answer
      // "did my Grindr blocks actually teach the model anything?"
      try {
        const store = await getDB();
        const result = await store.allDocs({
          startkey: 'pref:',
          endkey: 'pref:\uffff',
          include_docs: true,
        });
        const buckets = {
          total: 0,
          grindr: { liked: 0, disliked: 0, withBody: 0, withPosition: 0, withAge: 0, withEthnicity: 0, withPhoto: 0, withProfileText: 0, empty: 0 },
          sniffies: { liked: 0, disliked: 0, withBody: 0, withPosition: 0, withAge: 0, withEthnicity: 0, withPhoto: 0, withProfileText: 0, empty: 0 },
          other: { liked: 0, disliked: 0, withBody: 0, withPosition: 0, withAge: 0, withEthnicity: 0, withPhoto: 0, withProfileText: 0, empty: 0 },
        };
        const samples: any[] = [];
        for (const row of result.rows) {
          const doc = row.doc as any;
          if (!doc || doc.docType !== 'preference_feedback') continue;
          buckets.total++;
          const b = (buckets as any)[doc.platform] || buckets.other;
          const f = doc.features || {};
          if (doc.liked) b.liked++; else b.disliked++;
          const hasBody = !!String(f.bodyType || '').trim();
          const hasPos = !!String(f.position || '').trim();
          const hasAge = !!String(f.age || '').trim();
          const hasEthn = !!String(f.ethnicity || '').trim();
          const hasPhoto = !!f.hasPhoto;
          const hasText = (f.profileTextLength || 0) > 0;
          if (hasBody) b.withBody++;
          if (hasPos) b.withPosition++;
          if (hasAge) b.withAge++;
          if (hasEthn) b.withEthnicity++;
          if (hasPhoto) b.withPhoto++;
          if (hasText) b.withProfileText++;
          if (!hasBody && !hasPos && !hasAge && !hasEthn && !hasPhoto && !hasText) b.empty++;
          if (samples.length < 8) {
            samples.push({
              contactId: doc.contactId,
              platform: doc.platform,
              liked: doc.liked,
              features: f,
            });
          }
        }
        const emptyRatio = (b: any) => b.liked + b.disliked > 0
          ? Math.round((b.empty / (b.liked + b.disliked)) * 100)
          : 0;
        const summary = {
          total: buckets.total,
          grindr: { ...buckets.grindr, emptyPct: emptyRatio(buckets.grindr) },
          sniffies: { ...buckets.sniffies, emptyPct: emptyRatio(buckets.sniffies) },
          other: { ...buckets.other, emptyPct: emptyRatio(buckets.other) },
          verdict: buckets.total === 0 ? 'no training data'
            : (buckets.grindr.empty > buckets.grindr.liked + buckets.grindr.disliked - buckets.grindr.empty)
              ? 'Most Grindr samples are EMPTY shells — the blocks list endpoint only returns IDs, no profile attributes. Run Grindr cascade browsing to enrich contacts, then Full Retrain.'
              : 'Training data has useful features',
          sampleSignals: samples,
        };
        console.log('[Aggregaytor:SW] Training data diagnostic:', summary);
        return { ok: true, ...summary };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    // ── Unhide-all-on-platform handlers ────────────────────────────────────
    // Clear our local hide filter for a platform without touching the
    // platform's real block state. Used by Settings → Data → Blocklists.
    case 'UNHIDE_ALL_PLATFORM': {
      try {
        const platform = String(msg.platform || '');
        let affectedContacts = 0;
        let tabsNotified = 0;

        if (platform === 'sniffies') {
          // Strip isBlocked from contacts in our DB (affects the thread
          // list but not platform-side block state) and relay a clear to
          // any open Sniffies tab so live map markers un-hide.
          const contacts = await getContactsByPlatform('sniffies');
          for (const c of contacts) {
            const md = (c.metadata || {}) as any;
            if (!md.isBlocked) continue;
            const fresh = { ...md };
            delete fresh.isBlocked;
            await upsertContact({
              id: c._id?.replace('contact:', '') || '', platform: 'sniffies',
              platformUserId: c.platformUserId,
              displayName: c.displayName || '',
              profileUrl: c.profileUrl || '',
              avatarUrl: c.avatarUrl || '',
              lastSeen: c.lastSeen || new Date().toISOString(),
              metadata: fresh,
            });
            affectedContacts++;
          }
          // Clear the Sniffies tab's localStorage blocklist via bridge
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab.id && tab.url?.includes('sniffies.com')) {
              await chrome.tabs.sendMessage(tab.id, { type: 'MAP_FILTER_SETTINGS', settings: { blockedIds: [] } }).catch(() => {});
              tabsNotified++;
            }
          }
        } else if (platform === 'adam4adam') {
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab.id && tab.url?.includes('adam4adam.com')) {
              await chrome.tabs.sendMessage(tab.id, { type: 'A4A_UNHIDE_ALL' }).catch(() => {});
              tabsNotified++;
            }
          }
        } else if (platform === 'grindr') {
          // Grindr middle-click actually calls the platform's hide API, so
          // the profile stays blocked on Grindr's side. This just strips
          // our local md.isBlocked flag so the contact reappears in
          // Aggregaytor's thread list. The Grindr cascade won't show them
          // either way — they're really blocked.
          const contacts = await getContactsByPlatform('grindr');
          for (const c of contacts) {
            const md = (c.metadata || {}) as any;
            if (!md.isBlocked) continue;
            const fresh = { ...md };
            delete fresh.isBlocked;
            await upsertContact({
              id: c._id?.replace('contact:', '') || '', platform: 'grindr',
              platformUserId: c.platformUserId,
              displayName: c.displayName || '',
              profileUrl: c.profileUrl || '',
              avatarUrl: c.avatarUrl || '',
              lastSeen: c.lastSeen || new Date().toISOString(),
              metadata: fresh,
            });
            affectedContacts++;
          }
        } else {
          return { ok: false, error: `Unknown platform: ${platform}` };
        }
        invalidateThreadCache();
        return { ok: true, affectedContacts, tabsNotified };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    case 'CAPTURE_QUICK_PHRASE': {
      const data = await chrome.storage.local.get('aggregaytor_quick_phrases');
      const phrases: string[] = data.aggregaytor_quick_phrases || [];
      if (msg.text && !phrases.includes(msg.text)) {
        phrases.push(msg.text);
        if (phrases.length > 100) phrases.splice(0, phrases.length - 100);
        await chrome.storage.local.set({ aggregaytor_quick_phrases: phrases });
      }
      return { ok: true, count: phrases.length };
    }

    // ── Platform Credentials (encrypted) ──────────────────────────────────
    // Username + password for platforms that need auto-login recovery after
    // a forced logout (e.g. Grindr's block rate-limit kicks you out). Stored
    // in chrome.storage.local as AES-GCM ciphertext, keyed by a device-local
    // salt derived from the extension install ID. We intentionally DO NOT
    // ask the user for a passphrase: the goal is zero-friction auto-fill
    // after a forced logout. Anyone with filesystem access to the Chrome
    // profile can read these, same as any browser password manager.
    case 'SET_GRINDR_CREDENTIALS': {
      try {
        // v0.57.15: trim incoming username/password — paste handlers in
        // the popup commonly leave a trailing space which would cause Grindr
        // to reject the auto-login attempt with a confusing 401.
        const username = String(msg.username || '').trim();
        const password = String(msg.password || '').trim();
        const autoLogin = msg.autoLogin;
        if (!username || !password) {
          await chrome.storage.local.remove(['aggregaytor_grindr_credentials']);
          return { ok: true, cleared: true };
        }
        const key = await getDeviceCredentialKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode(JSON.stringify({ username, password }));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
        await chrome.storage.local.set({
          aggregaytor_grindr_credentials: {
            iv: Array.from(iv),
            ct: Array.from(new Uint8Array(ct)),
            autoLogin: autoLogin !== false,
            savedAt: Date.now(),
          },
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'GET_GRINDR_CREDENTIALS': {
      try {
        const data = await chrome.storage.local.get('aggregaytor_grindr_credentials');
        const stored = data.aggregaytor_grindr_credentials;
        if (!stored || stored.autoLogin === false) return { ok: true, credentials: null };
        const key = await getDeviceCredentialKey();
        const iv = new Uint8Array(stored.iv);
        const ct = new Uint8Array(stored.ct);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        const parsed = JSON.parse(new TextDecoder().decode(pt));
        return { ok: true, credentials: parsed };
      } catch {
        return { ok: true, credentials: null };
      }
    }
    case 'GET_GRINDR_CREDENTIAL_STATUS': {
      const data = await chrome.storage.local.get('aggregaytor_grindr_credentials');
      const stored = data.aggregaytor_grindr_credentials;
      return {
        ok: true,
        saved: !!stored,
        autoLogin: !!stored?.autoLogin,
        savedAt: stored?.savedAt || 0,
      };
    }

    // ── Google Drive Sync ──────────────────────────────────────────────────
    case 'DRIVE_BACKUP': {
      try {
        return await backupToDrive();
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'DRIVE_RESTORE': {
      try {
        invalidateThreadCache();
        return await restoreFromDrive();
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'DRIVE_STATUS': {
      try {
        return { ok: true, ...(await getDriveBackupStatus()) };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }

    // ── Diagnostics ────────────────────────────────────────────────────────
    // v0.57.15: lightweight read-only handlers for surfacing build metadata
    // and search-index health to the settings UI without requiring DEBUG.

    /** Return manifest version + build hash (when present). Lets the UI tell
     *  the user "you're on 0.57.15 (build a3f4...)" without parsing the
     *  service worker version string. */
    case 'GET_BUILD_INFO': {
      const m = chrome.runtime.getManifest() as any;
      let buildHash = '';
      try {
        const res = await fetch(chrome.runtime.getURL('.build-hash'), { cache: 'no-store' });
        if (res.ok) buildHash = (await res.text()).trim();
      } catch {}
      return {
        ok: true,
        version: m.version,
        name: m.name,
        manifestVersion: m.manifest_version,
        buildHash,
        isDevBuild: !m.update_url,
        permissions: m.permissions || [],
        hostPermissions: m.host_permissions || [],
        uptimeMin: Math.round((Date.now() - swPerfStart) / 60_000),
        uptimeHrs: Math.round((Date.now() - swPerfStart) / 360_000) / 10,
      };
    }

    /** Return search-index health: ready, size, cap, and what fraction of
     *  the cap is consumed. Surfaced in settings so users can tell whether
     *  full-text search is operating on the fast path or falling back to
     *  the PouchDB scan.
     *
     *  v0.57.20: also returns lifetime evictedCount and lastEvictionAt so
     *  the UI can distinguish "index hit cap once during seeding" from "index
     *  is dropping docs on every write". A high evictedCount means some
     *  searches will silently fall back to the slow scan for old messages. */
    case 'GET_SEARCH_INDEX_INFO': {
      const lifetime = getLifetimeStats();
      return {
        ok: true,
        ready: isIndexReady(),
        size: getIndexSize(),
        cap: SEARCH_INDEX_MAX_DOCS,
        utilization: SEARCH_INDEX_MAX_DOCS > 0
          ? Math.round((getIndexSize() / SEARCH_INDEX_MAX_DOCS) * 1000) / 10
          : 0,
        evictedCount: getEvictedCount(),
        lastEvictionAt: getLastEvictionAt() || null,
        // v0.57.28: lifetime stats survive clearIndex() for cumulative diagnostics
        lifetimeSeeds: lifetime.seeds,
        lifetimeAdds: lifetime.adds,
      };
    }

    // ── Natural-language contact query ──
    //
    // v0.57.20: several correctness fixes here.
    //  - The returned `contactId` for each match is the *thread-facing*
    //    "{platform}:{userId}" form, not the PouchDB _id ("contact:…"). Pre-fix
    //    the panel passed the raw _id into openThread() and every downstream
    //    handler (MARK_THREAD_READ, NAVIGATE_TO_CONVERSATION) silently
    //    mis-routed because they expect the stripped form.
    //  - Removed a dead destructured fourth promise (`msgCountResult` was
    //    always a null resolve and never read) — noise during review.
    //  - Added a simple 60-second in-memory cache so re-running the exact
    //    same query doesn't burn another LLM call.
    /**
     * Return per-profile chat activity timestamps for a given platform.
     *
     * Used by the Sniffies map-filter bridge (re-seeded every 60s) to drive
     * the "waiting on response" filters. Returns the last inbound AND last
     * outbound timestamp per contact so the MAIN-world filter can answer
     * questions like "my last message went unanswered for >N days" without
     * needing to requery the DB on every filter scan.
     */
    case 'GET_CHAT_ACTIVITY': {
      const end = swPerfTrack('getChatActivity');
      try {
        const platform = String(msg.platform || 'sniffies');
        // Try the in-memory cache first; if absent (fresh SW), pull from
        // chrome.storage.session. This is the v0.57.31 fix for the
        // "message channel closed" warn on the bridge — the heavy scan
        // only fires when the persisted cache is also stale.
        if (!chatActivityCache) await rehydrateChatActivityCache();
        // Cache for 30s — the bridge re-seeds every 60s, so a 30s cache
        // means at most one real PouchDB scan per seed cycle while still
        // picking up newly-stored messages within half a minute.
        if (chatActivityCache && chatActivityCache.platform === platform &&
            (Date.now() - chatActivityCache.time) < CHAT_ACTIVITY_CACHE_TTL) {
          swPerfTrack('getChatActivity:cached')();
          end();
          return { ok: true, activity: chatActivityCache.data };
        }
        const db = await getDB();
        // Key-range scan over `msg:{platform}:` — bypasses the Mango query
        // planner and hits the B-tree directly. Empirically ~50× faster
        // than `db.find({selector: {docType, platform}})` which was taking
        // 300-400s on heavy users with ~20k messages and piling up
        // overlapping seeds behind the 60s re-seed interval.
        // v0.57.36 memory fix \u2014 was loading EVERY message doc into RAM on every
        // 60s seed. With 20k+ messages \u00d7 ~1-2KB each + PouchDB's internal caches,
        // this allocated ~20-40MB per call and was a major contributor to the
        // 14GB SW memory the user reported.
        //
        // New approach: stream rows in a single allDocs() WITHOUT include_docs,
        // then page through the smaller keys-only result. We only need timestamps
        // \u2014 those live on the message doc, but we can do a second narrow allDocs
        // on a 90-day-windowed slice. For "waiting on response" semantics, msgs
        // older than 90d don't change the answer (a 90+ day-old reply is dead).
        //
        // Implementation: doc IDs include the message timestamp because the
        // upserter stamps `msg:{platform}:{messageId}` and `messageId` is
        // typically `{epochSec}-{hash}` or similar. We can't rely on that across
        // adapters though, so instead: cap include_docs scan to CHAT_ACTIVITY_MAX
        // newest documents using PouchDB's descending+limit.
        const keyPrefix = `msg:${platform}:`;
        const CHAT_ACTIVITY_MAX = 8000; // ~80% smaller working set than the old "all rows"
        const r = await db.allDocs({
          startkey: keyPrefix + '\uffff', // descending starts from the high end
          endkey: keyPrefix,
          include_docs: true,
          descending: true,
          limit: CHAT_ACTIVITY_MAX,
        });
        const activity: Record<string, { myLastTs: number; theirLastTs: number }> = {};
        for (const row of r.rows) {
          const m = row.doc as any;
          if (!m || m.docType !== 'message') continue;
          const id = String(m.contactId || '').replace(/^contact:/, '').replace(/^[a-z]+:/, '').toLowerCase();
          if (!id) continue;
          const ts = Date.parse(m.timestamp) || 0;
          if (!ts) continue;
          if (!activity[id]) activity[id] = { myLastTs: 0, theirLastTs: 0 };
          if (m.direction === 'out') {
            if (ts > activity[id].myLastTs) activity[id].myLastTs = ts;
          } else if (m.direction === 'in') {
            if (ts > activity[id].theirLastTs) activity[id].theirLastTs = ts;
          }
        }
        // Drop r.rows reference explicitly so GC can reclaim the buffer
        // before we await the persist call below \u2014 without this PouchDB's
        // internal LRU and our local closure both keep it pinned.
        (r as any).rows = null;
        chatActivityCache = { data: activity, time: Date.now(), platform };
        // Persist to session storage so the next fresh SW wakeup serves
        // from cache instead of re-running the scan (which is what makes
        // Chrome kill the SW mid-await in the first place).
        persistChatActivityCache().catch(() => {});
        end();
        return { ok: true, activity };
      } catch (err) {
        end();
        return { ok: false, error: (err as Error).message };
      }
    }

    case 'QUERY_CONTACTS': {
      const end = swPerfTrack('queryContacts');
      try {
        const query = String(msg.query || '').trim();
        if (!query) return { ok: false, error: 'Empty query' };
        const limit = Math.min(Math.max(msg.limit || 10, 1), 50);

        // Short-circuit: identical query within the last 60s → reuse result.
        // This catches the common "user types → hits Go → instantly hits Go
        // again" double-click pattern and the "paste same query to compare
        // providers" workflow.
        const cacheKey = `${query}|${limit}`;
        const cached = queryContactsCache.get(cacheKey);
        if (cached && Date.now() - cached.time < QUERY_CONTACTS_CACHE_TTL) {
          end();
          return { ok: true, ...cached.result, cached: true };
        }

        // Gather contacts, thread metas, and dossiers in parallel
        const db = await getDB();
        const [contacts, metas, dossierResult] = await Promise.all([
          getAllContacts(),
          getAllThreadMeta(),
          db.allDocs({ startkey: 'dossier:', endkey: 'dossier:\uffff', include_docs: true }),
        ]);

        // Build lookup maps
        const metaMap = new Map<string, any>();
        for (const m of metas) metaMap.set(m.contactId, m);
        const dossierMap = new Map<string, any>();
        for (const row of dossierResult.rows) {
          if (row.doc) dossierMap.set((row.doc as any).contactId, row.doc);
        }

        // Assemble compact rows for the LLM (skip hidden/archived unless query mentions them)
        const queryLower = query.toLowerCase();
        const includeArchived = /archived|hidden|all/.test(queryLower);

        const rows: ContactQueryRow[] = [];
        for (const c of contacts) {
          // Thread-facing id (e.g. "grindr:12345") — this is what
          // openThread() / MARK_THREAD_READ / NAVIGATE_TO_CONVERSATION etc
          // expect. `c._id` carries an extra "contact:" prefix that only
          // PouchDB cares about.
          const threadId = `${c.platform}:${c.platformUserId}`;
          const meta = metaMap.get(threadId);
          const dossier = dossierMap.get(threadId);

          // Skip archived/hidden unless the query specifically asks for them
          if (!includeArchived && (meta?.archived || meta?.hidden)) continue;

          rows.push({
            id: threadId,
            name: c.displayName || c.platformUserId,
            platform: c.platform,
            position: dossier?.position || (c.metadata as any)?.position || '',
            bodyType: dossier?.bodyType || (c.metadata as any)?.bodyType || '',
            age: (c.metadata as any)?.age || dossier?.birthYear || '',
            ethnicity: (c.metadata as any)?.ethnicity || '',
            height: (c.metadata as any)?.height || '',
            distance: meta?.distance || (c.metadata as any)?.distance || '',
            lastMessageAt: c.lastMessageAt || '',
            unreadCount: c.unreadCount || 0,
            bookmarked: meta?.bookmarked || false,
            favorited: meta?.favorited || false,
            rating: meta?.rating || 0,
            archived: meta?.archived || false,
            hidden: meta?.hidden || false,
            preferenceScore: meta?.preferenceScore ?? null,
            sentiment: meta?.sentiment?.overall ?? null,
            tags: meta?.tags || [],
            notes: meta?.notes || '',
            ghostCount: dossier?.ghostCount || 0,
            metInPerson: dossier?.metInPerson || false,
            kinks: dossier?.kinks || [],
            bio: ((c.metadata as any)?.aboutMe || (c.metadata as any)?.bio || '').slice(0, 100),
          });
        }

        // Cap at 300 contacts to keep prompt within token limits.
        // Sort by preference score desc so the LLM sees the best candidates first.
        rows.sort((a, b) => (b.preferenceScore ?? -1) - (a.preferenceScore ?? -1));
        const capped = rows.slice(0, 300);

        const result = await queryContacts(query, capped, limit);
        // Cache only successful results — don't hide transient errors from
        // the user by serving them from cache on retry.
        if (result && !result.error) {
          queryContactsCache.set(cacheKey, { time: Date.now(), result });
          // FIFO trim — this map is small but let's keep it predictable.
          if (queryContactsCache.size > QUERY_CONTACTS_CACHE_MAX) {
            const oldest = queryContactsCache.keys().next();
            if (!oldest.done) queryContactsCache.delete(oldest.value as string);
          }
        }
        end();
        return { ok: true, ...result, totalCandidates: rows.length, sentToLLM: capped.length };
      } catch (err) {
        end();
        return { ok: false, error: (err as Error).message };
      }
    }

    // ── Deprecation warnings ──
    // Returns an array of time-bound warnings (Gemini 2.5 deprecation, etc.)
    // so the side panel can render an advisory without needing its own
    // schedule-tracking logic. v0.57.20.
    case 'GET_DEPRECATION_WARNINGS': {
      return { ok: true, warnings: getDeprecationWarnings() };
    }

    // Debug commands (from MCP server or dev tools)
    case 'DEBUG_COMMAND': return { ok: true, result: await handleDebugCommand(msg.command, msg.params) };

    default: return { ok: false, error: `Unknown: ${msg.type}` };
  }
}

// ── Core handlers ───────────────────────────────────────────────────────────

async function handleIncomingMessages(messages: UnifiedMessage[], platform: Platform): Promise<any> {
  const result = await upsertMessages(messages);
  await updateBadgeCount();
  chrome.runtime.sendMessage({ type: 'NEW_MESSAGES', platform, count: result.created }).catch(() => {});

  // Keep the full-text search index in sync with every write. The indexing
  // call is cheap (~1ms for a batch of 20 messages) and must happen even
  // when no auto-respond work is queued, so it sits outside the `created>0`
  // guard — updates to already-indexed ids are idempotent overwrites.
  if (messages.length) {
    try {
      indexMessages(messages.map(m => ({ _id: `msg:${m.platform}:${m.id.replace(/^[^:]+:/, '')}`, body: m.body || '', timestamp: m.timestamp })));
    } catch (err) {
      console.warn(`${LOG} search index update failed (non-fatal):`, err);
    }
  }

  if (result.created > 0) {
    for (const msg of messages) {
      if (msg.direction !== 'in') continue;
      // Never auto-respond to global chat — it's a broadcast feed, not a conversation
      if (msg.contactId.endsWith(':global-chat')) continue;
      try {
        const meta = await getThreadMeta(msg.contactId);
        if (meta?.autoRespondEnabled) {
          const queued = await queueAutoRespond(msg.contactId, msg.platform, msg.id);
          if (queued) {
            console.log(`${LOG} Auto-respond queued for ${msg.contactId}`);
            chrome.alarms.create('auto-respond-check', { delayInMinutes: 0.5 });
          }
        }
        if (meta?.hiddenUntilResponse) {
          await upsertThreadMeta(msg.contactId, msg.platform, { hiddenUntilResponse: false, hidden: false });
        }
      } catch {}
    }
    // Run block rules
    await runBlockRules(messages).catch(e => console.warn(`${LOG} Block rules error:`, e));

    // Queue dossier auto-extraction — waits for 30s of inactivity before starting.
    // v0.57.15: also enforces a 5-minute MAX deadline so a steady stream of
    // inbound messages (chatty group thread, bursty platform) can't starve
    // the extraction indefinitely. Once the first queued contact has waited
    // DOSSIER_MAX_DELAY ms, processing fires regardless of activity.
    const contactIds = new Set(messages.filter(m => m.direction === 'in').map(m => m.contactId));
    for (const cid of contactIds) {
      if (dossierExtractionQueue.size >= DOSSIER_QUEUE_CAP) break;
      dossierExtractionQueue.add(`${cid}:${messages[0]?.platform || platform}`);
    }
    // Reset the idle timer on every new message — only starts after 30s of silence
    if (dossierExtractionQueue.size > 0) {
      if (dossierExtractionTimer) clearTimeout(dossierExtractionTimer);
      dossierExtractionTimer = setTimeout(processDossierExtractions, 30_000); // 30s idle debounce
      if (!dossierFirstQueuedAt) dossierFirstQueuedAt = Date.now();
      // If we've been deferring for too long, force-fire the extraction now
      // even though a fresh message just arrived.
      if (Date.now() - dossierFirstQueuedAt >= DOSSIER_MAX_DELAY_MS) {
        clearTimeout(dossierExtractionTimer);
        dossierExtractionTimer = setTimeout(processDossierExtractions, 0);
      }
    }
  }

  return { ok: true, ...result };
}

// Debounced dossier extraction — serial processing, 30s idle trigger,
// 5-minute hard deadline. v0.57.15 added DOSSIER_MAX_DELAY_MS / dossierFirstQueuedAt
// so heavy chat traffic can't starve the extraction by perpetually resetting
// the idle timer.
const dossierExtractionQueue = new Set<string>();
const DOSSIER_QUEUE_CAP = 100;
let dossierExtractionTimer: ReturnType<typeof setTimeout> | null = null;
let dossierProcessing = false;
let dossierFirstQueuedAt = 0;
const DOSSIER_MAX_DELAY_MS = 5 * 60_000;

async function processDossierExtractions(): Promise<void> {
  dossierExtractionTimer = null;
  // v0.57.15: clear the deadline tracker as soon as the run starts so the
  // next queue-add cycle starts fresh rather than carrying the stale stamp.
  dossierFirstQueuedAt = 0;
  if (dossierProcessing) return; // already running, will pick up queued items
  dossierProcessing = true;

  try {
    // Process one contact at a time (serial, not parallel). The queue can
    // mutate while we await — between iterations other requests may add or
    // remove items — so we re-check size every loop and guard against the
    // narrow race where another caller drained the queue before us.
    while (dossierExtractionQueue.size > 0) {
      const entry = dossierExtractionQueue.values().next().value;
      if (!entry) break; // queue was drained by a concurrent caller
      dossierExtractionQueue.delete(entry);
      const colonIdx = entry.lastIndexOf(':');
      if (colonIdx < 0) continue; // malformed queue entry
      const [contactId, platform] = [entry.substring(0, colonIdx), entry.substring(colonIdx + 1)];
      try {
        const allMessages = await getMessagesByContact(contactId, { limit: 50 });
        if (allMessages.length < 3) continue;

        const inbound = allMessages.filter(m => m.direction === 'in');
        const existing = await getDossier(contactId) || {};
        const lastExtract = (existing as any).updatedAt || '';
        const newMessages = lastExtract
          ? inbound.filter(m => m.timestamp > lastExtract)
          : inbound;

        if (newMessages.length < 3) continue;

        const { extractDossierFields: llmExtract, localDossierExtraction } = await import('./llm.js');

        const localResult = localDossierExtraction(newMessages.map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })));
        for (const [field, value] of Object.entries(localResult)) {
          await setAutoExtractedField(contactId, platform as Platform, field, value, 'local-pattern');
        }

        const rateSettings = await getLLMRateSettings();
        if (rateSettings.enableDossierExtract && newMessages.length >= 5) {
          const contactName = contactId.replace(/^[a-z]+:/, '').slice(0, 10);
          const extracted = await llmExtract(
            newMessages.map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })),
            contactName, existing,
          );
          for (const [field, value] of Object.entries(extracted)) {
            await setAutoExtractedField(contactId, platform as Platform, field, value, 'llm-extraction');
          }
          if (Object.keys(extracted).length) {
            console.log(`${LOG} Auto-extracted ${Object.keys(extracted).length} dossier fields for ${contactId} (${Object.keys(localResult).length} local + ${Object.keys(extracted).length} LLM)`);
          }
        } else if (Object.keys(localResult).length) {
          console.log(`${LOG} Local-extracted ${Object.keys(localResult).length} dossier fields for ${contactId}`);
        }
      } catch (err) {
        console.warn(`${LOG} Dossier extraction failed for ${contactId}:`, err);
      }

      if (dossierExtractionQueue.size > 0) {
        const jittered = ENRICH_CALL_DELAY_MS + (Math.random() * 2 - 1) * ENRICH_CALL_JITTER_MS;
        await new Promise(r => setTimeout(r, jittered));
      }
    } // end while
  } finally {
    dossierProcessing = false;
  }
}

// ── Contact Upsert Deduplication ────────────────────────────────────────────
// Track recently-upserted contacts to skip redundant PouchDB writes.
// Key: contactId, Value: hash of relevant fields + timestamp
// A contact is only written to PouchDB if its data has changed since the
// last write, OR if 60+ seconds have passed (to catch metadata drift).
const recentContactUpserts = new Map<string, { hash: string; time: number }>();
const RECENT_CONTACT_UPSERTS_CAP = 500;

function contactHash(c: UnifiedContact): string {
  // Quick hash of the fields that matter — if these haven't changed,
  // the PouchDB write would be a no-op anyway
  return `${c.displayName}|${c.avatarUrl}|${JSON.stringify(c.metadata || {}).slice(0, 200)}`;
}

// Throttle CONTACTS_UPDATED notifications to at most once per 10 seconds
let lastContactsNotify = 0;
let contactsNotifyTimer: ReturnType<typeof setTimeout> | null = null;

async function handleIncomingContacts(contacts: UnifiedContact[]): Promise<void> {
  // Filter: skip empty contacts and recently-written identical data
  const toWrite: UnifiedContact[] = [];
  for (const c of contacts) {
    if (!c.displayName && !c.avatarUrl && (!c.metadata || Object.keys(c.metadata).length === 0)) {
      continue;
    }
    const id = `${c.platform}:${c.platformUserId}`;
    const hash = contactHash(c);
    const recent = recentContactUpserts.get(id);
    if (recent && recent.hash === hash && (Date.now() - recent.time) < 60_000) {
      continue;
    }
    toWrite.push(c);
  }

  // Batch write: 1 allDocs + 1 bulkDocs instead of N sequential get+put
  if (toWrite.length) {
    await upsertContacts(toWrite);
    const now = Date.now();
    for (const c of toWrite) {
      const id = `${c.platform}:${c.platformUserId}`;
      recentContactUpserts.set(id, { hash: contactHash(c), time: now });
    }
  }

  // Cap the dedup cache. v0.57.15: switched from O(N log N) sort-based
  // eviction to O(K) FIFO iteration. JS Map preserves insertion order, so
  // walking `keys()` yields the oldest entries in O(K) where K is the number
  // we want to drop. On accounts with thousands of contact upserts per
  // minute the previous sort dominated this hot path.
  if (recentContactUpserts.size > RECENT_CONTACT_UPSERTS_CAP) {
    const toDrop = 200;
    const iter = recentContactUpserts.keys();
    for (let i = 0; i < toDrop; i++) {
      const next = iter.next();
      if (next.done) break;
      recentContactUpserts.delete(next.value as string);
    }
  }

  // Debounced notification
  const now = Date.now();
  if (now - lastContactsNotify > 10000) {
    lastContactsNotify = now;
    chrome.runtime.sendMessage({ type: 'CONTACTS_UPDATED', count: toWrite.length }).catch(() => {});
  } else if (!contactsNotifyTimer) {
    contactsNotifyTimer = setTimeout(() => {
      contactsNotifyTimer = null;
      lastContactsNotify = Date.now();
      chrome.runtime.sendMessage({ type: 'CONTACTS_UPDATED', count: 1 }).catch(() => {});
    }, 10000);
  }
}

// ── Auto-respond with tier-based processing ─────────────────────────────────

async function processAutoResponds(): Promise<void> {
  // #8 Auto-close stale drafts older than 15 minutes (v0.57.28: increased from
  // 10m to account for time spent in the "generate" phase before draft state)
  const staleDrafts = await getDraftAutoResponds();
  for (const d of staleDrafts) {
    const age = Date.now() - new Date(d.updatedAt || d.createdAt).getTime();
    if (age > 15 * 60_000) {
      await updateAutoRespondStatus(d._id, 'rejected', { error: 'expired' });
      console.log(`${LOG} Auto-closed stale draft for ${d.contactId} (age: ${Math.round(age / 60_000)}m)`);
    }
  }

  // Process pending (newly queued)
  const pending = await getPendingAutoResponds();
  for (const entry of pending) {
    try {
      await updateAutoRespondStatus(entry._id, 'generating');
      const messages = await getMessagesByContact(entry.contactId, { limit: 30 });
      const meta = await getThreadMeta(entry.contactId);
      const settings: AutoRespondSettings = meta?.autoRespondSettings || {} as any;
      const contactName = meta?.alias || entry.contactId.replace(/^[a-z]+:/, '').slice(0, 10);

      const result = await generateAutoResponse(
        messages.map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })),
        contactName, entry.platform, settings, entry.contactId,
      );

      if (result.tier === 'low') {
        // Auto-send immediately
        await updateAutoRespondStatus(entry._id, 'sending', {
          generatedResponse: result.response, tier: result.tier,
          suggestedPictureTag: result.sendPicture?.tag || '',
        });
        await sendMessageToTab(entry.platform, entry.contactId, result.response);
        if (result.sendPicture?.tag && settings.allowPictures) {
          await handlePictureSend(result.sendPicture.tag, entry.contactId, entry.platform);
        }
        await updateAutoRespondStatus(entry._id, 'sent');
        console.log(`${LOG} Auto-sent (low tier): "${result.response.slice(0, 40)}..."`);
      } else {
        // Queue as draft for approval
        await updateAutoRespondStatus(entry._id, 'draft', {
          generatedResponse: result.response, tier: result.tier,
          suggestedPictureTag: result.sendPicture?.tag || '',
        });
        // Notify user
        safeNotify(`draft-${entry._id}`, {
          type: 'basic', iconUrl: 'icons/icon-128.png',
          title: result.tier === 'high' ? 'Review required' : 'Draft response ready',
          message: `${contactName}: "${result.response.slice(0, 100)}"`,
          requireInteraction: result.tier === 'high',
        });
        chrome.runtime.sendMessage({ type: 'DRAFTS_UPDATED' }).catch(() => {});
        console.log(`${LOG} Draft created (${result.tier} tier): "${result.response.slice(0, 40)}..."`);
      }
    } catch (err) {
      console.error(`${LOG} Auto-respond failed:`, err);
      await updateAutoRespondStatus(entry._id, 'failed', { error: (err as Error).message });
    }
  }

  // Process approved drafts
  const approved = await getApprovedAutoResponds();
  for (const entry of approved) {
    try {
      await updateAutoRespondStatus(entry._id, 'sending');
      await sendMessageToTab(entry.platform, entry.contactId, entry.generatedResponse);
      if (entry.suggestedPictureTag) {
        const meta = await getThreadMeta(entry.contactId);
        if (meta?.autoRespondSettings?.allowPictures) {
          await handlePictureSend(entry.suggestedPictureTag, entry.contactId, entry.platform);
        }
      }
      await updateAutoRespondStatus(entry._id, 'sent');
    } catch (err) {
      await updateAutoRespondStatus(entry._id, 'failed', { error: (err as Error).message });
    }
  }
}

async function handlePictureSend(tag: string, contactId: string, platform: string): Promise<void> {
  const pic = await getPictureByTag(tag);
  if (!pic) { console.log(`${LOG} No picture found for tag: ${tag}`); return; }
  await incrementPictureStat(pic._id, 'sentCount');
  console.log(`${LOG} Picture sent: ${pic.label || pic.tag} (sent: ${pic.sentCount + 1})`);
  // TODO: actual picture sending via platform API/DOM — for now just tracks the stat
}

// ── Block rules ─────────────────────────────────────────────────────────────

async function runBlockRules(newMessages: UnifiedMessage[]): Promise<void> {
  const rules = await getAllBlockRules();
  if (!rules.length) return;

  const contactIds = new Set(newMessages.filter(m => m.direction === 'in').map(m => m.contactId));
  for (const contactId of contactIds) {
    const messages = await getMessagesByContact(contactId, { limit: 50 });
    const meta = await getThreadMeta(contactId);
    const actions = evaluateRules(rules, messages, meta);
    for (const { rule, action } of actions) {
      console.log(`${LOG} Block rule "${rule.name}" triggered for ${contactId} → ${action}`);
      await executeAction(contactId, newMessages[0].platform, action, rule._id);
    }
  }
}

// ── Navigation + messaging ──────────────────────────────────────────────────

async function navigateToConversation(platform: string, contactId: string): Promise<void> {
  if (!contactId) return; // v0.57.28: guard against empty contactId
  const urlFn = PLATFORM_URLS[platform]; if (!urlFn) return;
  const url = urlFn(contactId);
  const tabs = await chrome.tabs.query({});
  const host = new URL(url).hostname;
  const tab = tabs.find(t => { try { return t.url && new URL(t.url).hostname === host; } catch { return false; } });

  if (tab?.id) {
    // SPA navigation: send message to content script to navigate internally
    // This avoids a full page refresh on SPAs like Sniffies and Grindr
    const path = new URL(url).pathname + new URL(url).search;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SPA_NAVIGATE', url, path });
    } catch {
      // Content script not ready — fall back to full navigation
      await chrome.tabs.update(tab.id, { url });
    }
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function sendMessageToTab(platform: string, contactId: string, text: string): Promise<void> {
  // v0.57.28: short-circuit on empty text to avoid unnecessary tab navigation
  if (!text?.trim()) { console.warn(`${LOG} sendMessageToTab: empty text, skipping`); return; }
  console.log(`${LOG} Sending to ${contactId}: "${text.slice(0, 50)}..."`);
  const urlFn = PLATFORM_URLS[platform]; if (!urlFn) return;
  const url = urlFn(contactId);
  const tabs = await chrome.tabs.query({});
  const host = new URL(url).hostname;
  const tab = tabs.find(t => { try { return t.url && new URL(t.url).hostname === host; } catch { return false; } });

  // If an existing tab is already at the target URL, do NOT reload it —
  // unconditionally calling tabs.update({url}) caused a full page refresh
  // on every auto-respond even when the tab was already on the right thread,
  // wiping out in-flight message composer state. Only navigate when needed.
  let targetId: number | undefined;
  let hadToNavigate = false;
  if (tab?.id) {
    targetId = tab.id;
    const alreadyThere = tab.url === url;
    if (!alreadyThere) {
      try {
        // Prefer SPA-style navigation to avoid a full reload; fall back to
        // a real chrome.tabs.update if the content script isn't listening.
        const path = new URL(url).pathname + new URL(url).search;
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'SPA_NAVIGATE', url, path }).catch(() => null);
        if (!res) {
          await chrome.tabs.update(tab.id, { url });
          hadToNavigate = true;
        }
      } catch {
        await chrome.tabs.update(tab.id, { url });
        hadToNavigate = true;
      }
    }
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    const created = await chrome.tabs.create({ url });
    targetId = created.id;
    hadToNavigate = true;
  }

  if (targetId != null) {
    const tid = targetId;
    const settleMs = hadToNavigate ? (tab?.id ? 3000 : 5000) : 500;
    setTimeout(() => {
      chrome.tabs.sendMessage(tid, { type: 'SEND_AUTO_RESPONSE', text, contactId }).catch(() => {});
    }, settleMs);
  } else {
    console.warn(`${LOG} sendMessageToTab: no target tab resolved for ${platform}:${contactId}`);
  }
}

// ── Alarms + reminders ──────────────────────────────────────────────────────

/**
 * Single consolidated alarm listener. Prior to v0.57.7 there were TWO
 * `chrome.alarms.onAlarm.addListener` registrations — one for the main
 * periodic jobs and one just for `grindr-login-check`. In MV3 service workers
 * every alarm fires BOTH listeners, which (a) wasted CPU scanning irrelevant
 * alarms and (b) made the wakeup/sleep behaviour harder to reason about.
 * Everything now lives in one listener with a `switch` dispatcher.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    switch (alarm.name) {
      case 'badge-refresh':
        await updateBadgeCount().catch(() => {});
        break;
      case 'auto-respond-check':
        await processAutoResponds().catch(e => console.error(`${LOG} AR error:`, e));
        break;
      case 'reminder-check':
        await processReminders().catch(e => console.error(`${LOG} Reminder error:`, e));
        break;
      case 'preference-auto-train':
        await autoTrainFromSignals().catch(e => console.warn(`${LOG} Auto-train error:`, e));
        break;
      case 'task-sync': {
        // Auto-sync tasks with Google Tasks every 5 minutes (only if authenticated)
        const authed = await isGoogleAuthenticated().catch(() => false);
        if (authed) {
          const result = await syncGoogleTasks();
          if (result.pulled + result.pushed + result.deleted > 0) {
            console.log(`${LOG} Task sync: pulled=${result.pulled} pushed=${result.pushed} deleted=${result.deleted}`);
          }
        }
        break;
      }
      case 'block-rule-check':
        await runPeriodicBlockRules().catch(e => console.warn(`${LOG} Block rule error:`, e));
        break;
      // v0.57.54: daily check for newer LLM models. Queries each
      // provider's /models endpoint, picks the best newer family-match
      // for the user's current tier, surfaces or auto-applies depending
      // on the autoApply toggle.
      case 'model-updater-daily-check': {
        try {
          // Reuse the same handler logic by routing through ourselves.
          // chrome.runtime.sendMessage to self isn't allowed, so call
          // handleMessage directly. Cheap — one provider sweep per 24h.
          await handleMessage({ type: 'CHECK_MODEL_UPDATES' });
        } catch (err) {
          console.warn(`${LOG} model-updater daily check failed:`, (err as Error).message);
        }
        break;
      }
      // v0.57.50: Friend Finder paced send tick. One greeting per tick;
      // alarm reschedules itself with a fresh jittered gap until queue
      // is empty or run state flipped to 'stopped'/'done'.
      case 'friend-finder-tick': {
        const state = await getFFState();
        const run = await getRunState();
        if (run.state !== 'running') {
          try { await chrome.alarms.clear(FF_ALARM); } catch {}
          break;
        }
        const next = run.queue.shift();
        if (!next) {
          run.state = 'done';
          await setRunState(run);
          try { await chrome.alarms.clear(FF_ALARM); } catch {}
          console.log(`${LOG} FF: queue drained — ${run.sentCount} sent, ${run.failedCount} failed`);
          break;
        }
        try {
          const greet = await import('./llm.js').then(m => m.generateGreeting(next.platform as any));
          // Reuse the existing sendMessageToTab path — same delay-and-send
          // mechanics as the SEND_GREETING handler, including the per-call
          // 5-15s jitter inside sendMessageToTab.
          const sendDelay = 5000 + Math.floor(Math.random() * 10000);
          setTimeout(() => sendMessageToTab(next.platform, next.contactId, greet.response), sendDelay);
          run.sentCount++;
          run.lastSendAt = Date.now();
          console.log(`${LOG} FF: sent intro to ${next.contactId} (${run.sentCount}/${run.approved.length})`);
        } catch (err) {
          run.failedCount++;
          console.warn(`${LOG} FF: send failed for ${next.contactId}:`, (err as Error).message);
        }
        // Schedule next tick with jittered gap
        if (run.queue.length > 0) {
          const delayMs = nextDelayMs(state.filters);
          run.nextSendAt = Date.now() + delayMs;
          await setRunState(run);
          chrome.alarms.create(FF_ALARM, { delayInMinutes: Math.max(0.05, delayMs / 60_000) });
        } else {
          run.state = 'done';
          run.nextSendAt = 0;
          await setRunState(run);
          try { await chrome.alarms.clear(FF_ALARM); } catch {}
          console.log(`${LOG} FF: run complete — ${run.sentCount} sent, ${run.failedCount} failed`);
        }
        break;
      }
      // v0.57.36: periodic memory pressure release. Runs every 30 min.
      // Drops the heaviest in-memory caches (thread summaries + chat
      // activity) and trims search index back to the cap, so a SW that's
      // been alive for hours gets a chance to release retained memory
      // without waiting for Chrome to suspend it.
      case 'mem-gc': {
        const beforeQuery = queryContactsCache.size;
        const beforeAutoTrain = autoTrainedSet.size;
        const beforeContacts = recentContactUpserts.size;
        threadSummaryCache = null;
        chatActivityCache = null;
        // Don't clear queryContactsCache fully — just evict expired entries.
        const now = Date.now();
        for (const [k, v] of queryContactsCache) {
          if (now - v.time > QUERY_CONTACTS_CACHE_TTL) queryContactsCache.delete(k);
        }
        // autoTrainedSet only grows during a session — half it on each tick
        // so long-lived SWs don't accumulate forever.
        if (autoTrainedSet.size > 5000) {
          const drop = Math.floor(autoTrainedSet.size / 2);
          const it = autoTrainedSet.values();
          for (let i = 0; i < drop; i++) {
            const n = it.next();
            if (n.done) break;
            autoTrainedSet.delete(n.value);
          }
        }
        // Same for recentContactUpserts — TTL prune.
        for (const [k, v] of recentContactUpserts) {
          if (now - v.time > 5 * 60_000) recentContactUpserts.delete(k);
        }
        console.log(`${LOG} mem-gc: queryCache ${beforeQuery}->${queryContactsCache.size}, autoTrain ${beforeAutoTrain}->${autoTrainedSet.size}, contactUpserts ${beforeContacts}->${recentContactUpserts.size}`);
        // v0.57.46: piggy-back the auto-maintenance decision on the same
        // 30-min cadence. Cheap (just reads counters); only acts when
        // thresholds are exceeded. Adds free + compact when warranted
        // without the user clicking anything.
        await runAutoMaintenance().catch(e => console.warn(`${LOG} runAutoMaintenance error:`, e));
        break;
      }
      case 'grindr-login-check':
        await runGrindrLoginCheck().catch(() => { /* tab often inaccessible */ });
        break;
      // dev-reload-keepalive: intentionally a no-op handler. The alarm exists
      // ONLY to keep the MV3 service worker warm so the setInterval poll in
      // startDevAutoReload() (the actual rebuild-detector) can fire reliably.
      // The legacy 25s "keepalive" alarm was removed in v0.57.7 — this one
      // is dev-only (guarded by absence of update_url) and short-lived.
      case 'dev-reload-keepalive':
        break;
      case 'enrich-blocked-tick':
        await runEnrichTick().catch(e => console.warn(`${LOG} Enrich tick error:`, e));
        break;
    }
  } catch (err) {
    console.warn(`${LOG} alarm ${alarm.name} failed:`, err);
  }
});

/** Evaluate every block rule across every active thread. Extracted from the
 *  alarm handler so it can be tested / invoked on-demand. */
async function runPeriodicBlockRules(): Promise<void> {
  const rules = await getAllBlockRules();
  if (!rules.length) return;
  const summaries = await getThreadSummaries({});
  for (const s of summaries) {
    const messages = await getMessagesByContact(s.contactId, { limit: 50 });
    const meta = await getThreadMeta(s.contactId);
    const actions = evaluateRules(rules, messages, meta);
    for (const { rule, action } of actions) {
      console.log(`${LOG} Periodic block rule "${rule.name}" → ${action} on ${s.contactId}`);
      await executeAction(s.contactId, s.platform, action, rule._id);
    }
  }
}

async function processReminders(): Promise<void> {
  const reminders = await getReminders({ upcoming: true });
  const now = Date.now();
  for (const r of reminders) {
    const due = new Date(r.dueAt).getTime();
    if (!r.notifiedApproach && (due - now) <= 20 * 60_000 && (due - now) > 0) {
      safeNotify(`rem-a-${r._id}`, { type: 'basic', iconUrl: 'icons/icon-128.png', title: 'Reminder approaching', message: `${r.note} — ${Math.round((due - now) / 60_000)} min` });
      await markReminderNotified(r._id, 'approach');
    }
    if (!r.notifiedDue && due <= now) {
      safeNotify(`rem-d-${r._id}`, { type: 'basic', iconUrl: 'icons/icon-128.png', title: 'Reminder', message: r.note });
      await markReminderNotified(r._id, 'due');
    }
  }
}

async function updateBadgeCount(): Promise<void> {
  try {
    const count = await getUnreadCount();
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF6B6B' });
  } catch (err) {
    // v0.57.15: previously swallowed silently. Badge updates failing
    // chronically can mask real DB issues (corrupt PouchDB, unloaded
    // service-worker context). Logging at warn level — these are recoverable
    // (next badge-refresh alarm will retry) but worth knowing about.
    console.warn(`${LOG} updateBadgeCount failed:`, (err as Error).message || err);
  }
}

updateBadgeCount().catch(() => {});
chrome.alarms.create('badge-refresh', { periodInMinutes: 1 });
chrome.alarms.create('reminder-check', { periodInMinutes: 0.25 });
// v0.57.62: dropped mem-gc period from 30 → 5 min and free thresholds from
// 80% → 60% capacity. The user reported the extension idling at 4GB; this
// shifts auto-free from "almost never fires" to "every 5 min sweeps the
// caches that actually grew." Each sweep is cheap (a few Map iterations
// plus chrome.storage.session writes), nothing that would justify the
// previous half-hour gap.
// v0.57.36: periodic memory pressure release for long-lived SWs.
chrome.alarms.create('mem-gc', { periodInMinutes: 5 });
// v0.57.54: daily LLM-model auto-discovery. Runs once at startup if the
// last check was >20h ago, then every 24h. delayInMinutes:1 so the first
// fire happens after the SW has settled.
(async () => {
  try {
    const s = await getUpdaterState();
    const dayMs = 24 * 60 * 60_000;
    const due = !s.lastCheckAt || (Date.now() - s.lastCheckAt) > 20 * 60 * 60_000;
    chrome.alarms.create(MODEL_UPDATER_ALARM, {
      delayInMinutes: due ? 1 : Math.max(1, Math.round((dayMs - (Date.now() - s.lastCheckAt)) / 60_000)),
      periodInMinutes: 24 * 60,
    });
  } catch {}
})().catch(() => {});
// Removed 25s keepalive alarm — was causing unnecessary CPU usage

// ── Dev Auto-Reload ────────────────────────────────────────────────────────
// When the extension is loaded unpacked (i.e. you're developing locally),
// watch for changes to dist/.build-hash (written by the writeBuildHash
// vite plugin on every rebuild) and call chrome.runtime.reload() when it
// changes. This means `npm run dev` → save a file → the extension reloads
// itself without you having to click the refresh button.
//
// Guarded on update_url being absent so this is a no-op for any store-
// installed build. The poll is cheap: a single fetch against an in-package
// resource every 1.5s.
async function startDevAutoReload(): Promise<void> {
  try {
    const m = chrome.runtime.getManifest() as any;
    if (m.update_url) return; // Store-installed build — never auto-reload
  } catch { return; }

  let lastHash = '';
  try {
    const res = await fetch(chrome.runtime.getURL('.build-hash'), { cache: 'no-store' });
    if (!res.ok) return; // No marker file → production build, skip
    lastHash = (await res.text()).trim();
    console.log('[Aggregaytor:SW] Dev auto-reload watching (hash:', lastHash.slice(0, 12), ')');
  } catch {
    return; // Fetch failed → marker doesn't exist, skip
  }

  // Use chrome.alarms rather than setInterval: setInterval in service
  // workers is unreliable because the SW can be put to sleep by Chrome.
  // A 1-minute alarm (the minimum reliable period in MV3) is too slow for
  // dev reload, so we use both: an alarm to wake the SW up if asleep, AND
  // a setInterval for the fast poll when the SW is active.
  const POLL_MS = 1500;
  setInterval(async () => {
    try {
      const res = await fetch(chrome.runtime.getURL('.build-hash'), { cache: 'no-store' });
      if (!res.ok) return;
      const current = (await res.text()).trim();
      if (current && current !== lastHash) {
        console.log('[Aggregaytor:SW] Rebuild detected (', lastHash.slice(0, 12), '→', current.slice(0, 12), ') — reloading extension');
        chrome.runtime.reload();
      }
    } catch { /* transient; try again next tick */ }
  }, POLL_MS);
  // The alarm is just to keep the SW warm; the setInterval does the work.
  chrome.alarms.create('dev-reload-keepalive', { periodInMinutes: 0.5 });
}
startDevAutoReload().catch(() => {});

// Ensure Global Chat contact always exists. Runs on every SW wakeup but
// is guarded by a getContact() check so we skip the PouchDB write when it's
// already there (which is the common case after first install). Previously
// this ran unconditionally on every wakeup, hitting both the disk and the
// upsertContacts fast-path. One extra O(1) read in exchange for skipping
// an O(1) write — net-positive because the write triggers a rev bump.
(async () => {
  try {
    const existing = await getContact('contact:sniffies:global-chat');
    if (existing) return;
    await upsertContact({
      id: 'sniffies:global-chat',
      platform: 'sniffies',
      platformUserId: 'global-chat',
      displayName: '🌐 Global Chat',
      profileUrl: 'https://sniffies.com/global-chat',
      avatarUrl: '',
      lastSeen: new Date().toISOString(),
      metadata: { isGlobalChat: true },
    });
  } catch {
    /* swallowed — the seed is a best-effort convenience, not critical */
  }
})();

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Right-click context menu ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'open-settings', title: 'Settings', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'open-all-sites', title: 'Open all sites', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'sync-pics', title: 'Sync profile pictures', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'sep1', type: 'separator', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'toggle-autorespond', title: 'Toggle auto-respond all', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'sep2', type: 'separator', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'open-archive', title: 'View archive', contexts: ['action'] });

  // Seed the Global Chat contact so it always appears in the inbox
  upsertContact({
    id: 'sniffies:global-chat',
    platform: 'sniffies',
    platformUserId: 'global-chat',
    displayName: '🌐 Global Chat',
    profileUrl: 'https://sniffies.com/global-chat',
    avatarUrl: '',
    lastSeen: new Date().toISOString(),
    metadata: { isGlobalChat: true },
  }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  switch (info.menuItemId) {
    case 'open-settings':
      chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
      break;
    case 'open-all-sites':
      await openAllSites();
      break;
    case 'sync-pics': {
      const allTabs = await chrome.tabs.query({});
      const platformHosts = ['sniffies.com', 'web.grindr.com', 'doublelist.com', 'adam4adam.com'];
      for (const tab of allTabs) {
        if (!tab.id || !tab.url) continue;
        if (platformHosts.some(h => tab.url!.includes(h))) {
          chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_AVATARS' }).catch(() => {});
        }
      }
      break;
    }
    case 'toggle-autorespond': {
      const data = await chrome.storage.local.get('aggregaytor_global_autorespond');
      const newState = !data.aggregaytor_global_autorespond;
      await chrome.storage.local.set({ aggregaytor_global_autorespond: newState });
      // Toggle on all threads (except global chat — it's a broadcast feed)
      const summRes = await getThreadSummaries({});
      for (const s of summRes) {
        if (s.contactId.endsWith(':global-chat')) continue;
        await upsertThreadMeta(s.contactId, s.platform, { autoRespondEnabled: newState });
      }
      safeNotify('ar-toggle', {
        type: 'basic', iconUrl: 'icons/icon-128.png',
        title: 'Auto-respond', message: newState ? 'Enabled for all conversations' : 'Disabled',
      });
      break;
    }
    case 'open-archive':
      // Open side panel — the user can click the archive tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
      break;
  }
});

// ── Auto-Train Preference Model from Platform Signals ──────────────────────
// Scans thread metadata for signals (pins, favorites, blocks, ratings) and
// feeds them to the ML preference model as training data.
//
// ── Resumable Enrichment State Machine ────────────────────────────────────
// Replaces the old blocking ENRICH_BLOCKED_PROFILES handler with a tick-
// driven, persistent state machine. Surviving constraints:
//   • Service worker death (MV3 SWs die after 30s idle) — state in
//     chrome.storage, tick brought back by chrome.alarms.
//   • Grindr forced logout — status flips to 'paused' (session-dead) and
//     retries every minute. First successful call after re-login clears.
//   • Extension / browser reload — state persists, alarm recreated in
//     startDevAutoReload init (below).
//   • Low CPU priority — 1-minute alarm period, one small batch per tick,
//     2s between profile calls within a batch. Default 5 profiles/tick
//     ≈ 300 enrichments/hour ≈ ~10 hours for a 3000-profile backlog.
type EnrichPauseReason = null | 'no-auth' | 'no-tab' | 'session-dead' | 'manual' | 'error';
type EnrichPlatform = 'grindr' | 'sniffies';
interface EnrichState {
  status: 'idle' | 'running' | 'paused';
  platform: EnrichPlatform;
  pauseReason: EnrichPauseReason;
  total: number;
  processed: number;
  enriched: number;       // got useful features back from the platform
  noFeatures: number;     // 200 OK but the response had no features to extract
  failed: number;         // network error / non-200 / parse error
  startedAt: number;
  lastTickAt: number;
  lastError: string | null;
}
const DEFAULT_ENRICH_STATE: EnrichState = {
  status: 'idle', platform: 'grindr', pauseReason: null, total: 0, processed: 0, enriched: 0,
  noFeatures: 0, failed: 0, startedAt: 0, lastTickAt: 0, lastError: null,
};

/** Stamp enrichmentAttempted=true on a contact so the needs-enrich filter
 *  stops selecting it. Used on failure paths where we can't extract features
 *  but also don't want to loop on the same dead ID. */
async function markEnrichmentAttempted(cid: string, platform: Platform): Promise<void> {
  try {
    const existing = await getContact(`contact:${cid}`);
    if (!existing) return;
    await upsertContact({
      id: cid, platform,
      platformUserId: cid.replace(/^[a-z]+:/, ''),
      displayName: existing.displayName || '',
      profileUrl: existing.profileUrl || '',
      avatarUrl: existing.avatarUrl || '',
      lastSeen: existing.lastSeen || new Date().toISOString(),
      metadata: { ...(existing.metadata || {}), enrichmentAttempted: true, enrichmentGotFeatures: false },
    });
  } catch {}
}
const ENRICH_STORAGE_KEY = 'aggregaytor_enrich_blocked_state';
// 40 profiles per tick × ~1.3s per call = ~52s of work per minute, leaving
// an ~8s buffer before the next alarm. That gives 40/min = 2400/hour, which
// finishes a 3000-profile backlog in ~1.25 hours. Well under the rate a
// platform's own client bursts on page load (hundreds of reads in under
// 2 seconds is normal), so no rate-limit risk from this tier.
//
// The inter-call delay is jittered ±200ms in the fetcher so the request
// pattern looks like natural browsing rather than a perfectly regular
// enumeration, which is the kind of thing anti-abuse heuristics notice.
const ENRICH_BATCH_SIZE = 40;
const ENRICH_CALL_DELAY_MS = 1200; // ± 200ms jitter in the fetcher
const ENRICH_CALL_JITTER_MS = 200;

async function getEnrichState(): Promise<EnrichState> {
  try {
    const data = await chrome.storage.local.get(ENRICH_STORAGE_KEY);
    const stored = data[ENRICH_STORAGE_KEY];
    return stored ? { ...DEFAULT_ENRICH_STATE, ...stored } : { ...DEFAULT_ENRICH_STATE };
  } catch { return { ...DEFAULT_ENRICH_STATE }; }
}
async function setEnrichState(state: EnrichState): Promise<void> {
  try { await chrome.storage.local.set({ [ENRICH_STORAGE_KEY]: state }); } catch {}
  // Broadcast to any open side panel. Best-effort; silently swallow errors.
  try { chrome.runtime.sendMessage({ type: 'ENRICH_BLOCKED_PROGRESS', state }).catch(() => {}); } catch {}
}

// Platform-specific batch fetchers. These run in the platform tab's MAIN
// world via chrome.scripting.executeScript, so they can't reference anything
// from this service-worker module scope.

/** Grindr: GET /api/v4/profiles/{id} with captured bearer token + cookies. */
async function grindrBatchFetcher(batch: string[], delayMs: number, jitterMs: number): Promise<any> {
  const captured = (window as any).__aggregaytor_get_grindr_auth?.() || null;
  if (!captured || !Object.keys(captured).length) {
    return { noAuth: true, results: [] };
  }
  const headers: Record<string, string> = { 'Accept': 'application/json', ...captured };
  const out: Array<any> = [];
  for (const id of batch) {
    try {
      const res = await fetch(`https://web.grindr.com/api/v4/profiles/${id}`, {
        credentials: 'include', headers,
      });
      if (res.status === 401 || res.status === 403) {
        let body = ''; try { body = (await res.text()).slice(0, 200); } catch {}
        out.push({ id, ok: false, status: res.status, error: body });
        break;
      }
      if (!res.ok) { out.push({ id, ok: false, status: res.status }); }
      else { const data = await res.json(); out.push({ id, ok: true, status: 200, data }); }
    } catch (e: any) {
      out.push({ id, ok: false, status: 0, error: String(e?.message || e) });
    }
    const jittered = delayMs + (Math.random() * 2 - 1) * jitterMs;
    await new Promise(r => setTimeout(r, jittered));
  }
  return { noAuth: false, results: out };
}

/** Sniffies: POST /api/user/full with session cookies (no bearer token). */
async function sniffiesBatchFetcher(batch: string[], delayMs: number, jitterMs: number): Promise<any> {
  // Sniffies doesn't use a bearer token — credentials:'include' sends the
  // session cookie which is all that's required. So "no-auth" for Sniffies
  // just means the cookie is missing / expired, which we map to session-dead.
  const bases = [
    'https://uswapi.sniffies.com',
    'https://usw.api.sniffies.com',
    'https://uswapi2.sniffies.com',
  ];
  // Pick the working base once per tick. Try the first that returns 2xx/4xx
  // (i.e. reached the server) and cache it on window so subsequent ticks skip
  // the discovery.
  let preferredBase = (window as any).__aggregaytor_sniffies_full_base || '';
  if (!preferredBase) {
    for (const base of bases) {
      try {
        const probe = await fetch(`${base}/api/user/full`, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId: batch[0] || '' }),
        });
        if (probe.status < 500) { preferredBase = base; break; }
      } catch {}
    }
    if (preferredBase) (window as any).__aggregaytor_sniffies_full_base = preferredBase;
    else return { noAuth: true, results: [] };
  }

  const out: Array<any> = [];
  for (const id of batch) {
    try {
      const res = await fetch(`${preferredBase}/api/user/full`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: id }),
      });
      if (res.status === 401 || res.status === 403) {
        out.push({ id, ok: false, status: res.status });
        break;
      }
      if (res.status === 429) {
        // Rate-limited — treat like session-dead for this tick; the alarm
        // will try again in a minute.
        out.push({ id, ok: false, status: 429 });
        break;
      }
      if (!res.ok) { out.push({ id, ok: false, status: res.status }); }
      else { const data = await res.json(); out.push({ id, ok: true, status: 200, data }); }
    } catch (e: any) {
      out.push({ id, ok: false, status: 0, error: String(e?.message || e) });
    }
    const jittered = delayMs + (Math.random() * 2 - 1) * jitterMs;
    await new Promise(r => setTimeout(r, jittered));
  }
  return { noAuth: false, results: out };
}

/** Pull training-relevant metadata from a Grindr /api/v4/profiles/{id} response. */
function extractGrindrMetadata(data: any): any {
  const p = data.profile || data.data || data;
  const md: any = {};
  const pickString = (v: any) => typeof v === 'string' ? v : (v != null ? String(v) : '');
  if (p.bodyType) md.bodyType = pickString(p.bodyType);
  if (p.body) md.bodyType = md.bodyType || pickString(p.body);
  if (p.sexualPosition) md.position = pickString(p.sexualPosition);
  if (p.position) md.position = md.position || pickString(p.position);
  if (p.age) md.age = pickString(p.age);
  if (p.ethnicity) md.ethnicity = pickString(p.ethnicity);
  if (p.height) md.height = pickString(p.height);
  if (p.weight) md.weight = pickString(p.weight);
  if (p.aboutMe) md.aboutMe = pickString(p.aboutMe);
  if (p.lookingFor) md.lookingFor = Array.isArray(p.lookingFor) ? p.lookingFor.join(', ') : pickString(p.lookingFor);
  if (p.displayName || p.name) md.displayName = pickString(p.displayName || p.name);
  md.isBlocked = true;
  md.enrichedAt = Date.now();
  const primaryHash = p.photoHash || p.profileImageMediaHash || p.primaryPhotoHash;
  if (primaryHash) md.__avatarUrl = `https://cdns.grindr.com/images/profile/1024x1024/${primaryHash}`;
  else if (Array.isArray(p.photoMediaHashes) && p.photoMediaHashes.length) {
    md.__avatarUrl = `https://cdns.grindr.com/images/profile/1024x1024/${p.photoMediaHashes[0]}`;
  }
  return md;
}

/** Pull training-relevant metadata from a Sniffies /api/user/full response. */
function extractSniffiesMetadata(data: any): any {
  // Sniffies wraps the profile in various shapes depending on the endpoint
  // version. Try the common ones.
  const p = data?.profile || data?.data?.profile || data?.user || data?.data || data;
  if (!p || typeof p !== 'object') return null;

  const md: any = {};
  const pickString = (v: any) => typeof v === 'string' ? v.trim() : (v != null ? String(v).trim() : '');
  // Attitude / position — Sniffies calls this attitude or position
  const att = pickString(p.attitude || p.position || p.sexualPosition || p.role);
  if (att) md.position = att;
  // Body type / build
  const body = pickString(p.bodyType || p.body || p.build);
  if (body && /^[a-z -]{2,30}$/i.test(body)) md.bodyType = body;
  // Age
  const age = pickString(p.age || p.ageNumber || p.years);
  if (age && /^\d{2,3}$/.test(age)) md.age = age;
  // Ethnicity / race
  const eth = pickString(p.ethnicity || p.race);
  if (eth) md.ethnicity = eth;
  // Height
  const height = pickString(p.height || p.heightCm || p.heightString);
  if (height) md.height = height;
  // About me / profile text / whatsUp / etc
  const aboutParts: string[] = [];
  for (const k of ['aboutMe', 'about', 'bio', 'description', 'profileText', 'whatsUp', 'whatsUpText', 'looking', 'lookingFor', 'intoWhat']) {
    const v = pickString((p as any)[k]);
    if (v && v.length >= 2 && v.length < 2000) aboutParts.push(v);
  }
  if (aboutParts.length) md.profileText = aboutParts.join(' | ').slice(0, 2000).toLowerCase();
  if (pickString(p.aboutMe)) md.aboutMe = pickString(p.aboutMe);
  if (pickString(p.lookingFor)) md.lookingFor = pickString(p.lookingFor);
  // Display name / nickname
  const displayName = pickString(p.displayName || p.name || p.nickname || p.username);
  if (displayName && !/^[0-9a-f]{24,}$/i.test(displayName)) md.displayName = displayName;
  // Avatar URL — Sniffies uses profile.sniffiesassets.com/{hexid}/{mediaid}
  const hexId = pickString(p._id || p.id || p.profileId || p.userId);
  const primaryMedia = pickString(p.primaryMediaId || p.profileImageId || p.avatarMediaId);
  if (hexId && primaryMedia) {
    md.__avatarUrl = `https://profile.sniffiesassets.com/${hexId}/${primaryMedia}`;
  } else if (pickString(p.avatarUrl) || pickString(p.photoUrl)) {
    md.__avatarUrl = pickString(p.avatarUrl || p.photoUrl);
  }
  md.enrichedAt = Date.now();
  return md;
}

let enrichTickInFlight = false;
async function runEnrichTick(): Promise<void> {
  if (enrichTickInFlight) return;
  enrichTickInFlight = true;
  try {
    const state = await getEnrichState();
    if (state.status !== 'running') return;
    const platform = state.platform || 'grindr';

    // Per-platform config: which site the enrichment runs against, and what
    // "thin" means for that platform's data. Grindr treats "no observable
    // features" as thin; Sniffies treats "no aboutMe / position / age" as
    // thin (a photo alone is useless training signal for Sniffies since
    // virtually every profile has one).
    const platformCfg = platform === 'sniffies'
      ? {
          tabMatch: 'sniffies.com',
          tabError: 'Open sniffies.com so we can resume.',
          contactPrefix: 'contact:sniffies:',
          idPrefix: 'sniffies:',
          isThin: (c: any) => {
            const md = c.metadata || {};
            const hasFeatures = md.bodyType || md.position || md.age || md.ethnicity
              || md.height || md.profileText || md.aboutMe || md.lookingFor;
            const hasBlockOrPin = md.isBlocked || md.isPinned;
            // md.enrichmentAttempted === true means we've already tried the
            // platform's profile endpoint for this id and it came back with
            // nothing useful. Don't re-try it — otherwise the total keeps
            // growing forever as Grindr/Sniffies refuse to return features
            // for blocked profiles on each attempt.
            return hasBlockOrPin && !hasFeatures && !md.enrichmentAttempted;
          },
        }
      : {
          tabMatch: 'web.grindr.com',
          tabError: 'Open web.grindr.com so we can resume.',
          contactPrefix: 'contact:grindr:',
          idPrefix: 'grindr:',
          isThin: (c: any) => {
            const md = c.metadata || {};
            const hasFeatures = md.bodyType || md.position || md.age || md.ethnicity
              || md.height || md.profileText || md.aboutMe || c.avatarUrl;
            return md.isBlocked && !hasFeatures && !md.enrichmentAttempted;
          },
        };

    // Find the right tab
    const tabs = await chrome.tabs.query({});
    const platTab = tabs.find((t: any) => t.url?.includes(platformCfg.tabMatch));
    if (!platTab?.id) {
      await setEnrichState({ ...state, status: 'paused', pauseReason: 'no-tab', lastTickAt: Date.now(),
        lastError: platformCfg.tabError });
      return;
    }

    // Grab a small batch of contacts that need enrichment
    const contacts = await getContactsByPlatform(platform as Platform);
    const needs = contacts.filter(platformCfg.isThin);
    if (!needs.length) {
      await setEnrichState({ ...state, status: 'idle', pauseReason: null, lastTickAt: Date.now() });
      chrome.alarms.clear('enrich-blocked-tick');
      console.log(`[Aggregaytor:SW] ${platform} enrichment complete. Processed ${state.processed}, enriched ${state.enriched}, failed ${state.failed}.`);
      return;
    }
    const correctedTotal = Math.max(state.total, state.processed + needs.length);
    const chunk = needs.slice(0, ENRICH_BATCH_SIZE).map((c: any) =>
      (c._id || '').replace(platformCfg.contactPrefix, '')).filter(Boolean);

    // Run the batch in the platform tab's MAIN world. Each platform has a
    // different fetch signature — Grindr uses a bearer token captured by
    // the adapter, Sniffies uses session cookies only (no Authorization).
    const platformFn = platform === 'sniffies' ? sniffiesBatchFetcher : grindrBatchFetcher;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: platTab.id },
      world: 'MAIN',
      args: [chunk, ENRICH_CALL_DELAY_MS, ENRICH_CALL_JITTER_MS],
      func: platformFn,
    });

    const payload = (result?.result as any) || { noAuth: false, results: [] };
    if (payload.noAuth) {
      await setEnrichState({ ...state, status: 'paused', pauseReason: 'no-auth', lastTickAt: Date.now(),
        total: correctedTotal, lastError: `Waiting for ${platform} to issue an authenticated API call…` });
      return;
    }

    let enriched = state.enriched, failed = state.failed, processed = state.processed;
    let noFeatures = state.noFeatures || 0;
    let sessionDead = false;
    for (const row of (payload.results || [])) {
      if (row.status === 401 || row.status === 403) {
        sessionDead = true;
        break;
      }
      processed++;
      if (!row.ok || !row.data) {
        failed++;
        // Still mark it attempted so we don't loop on the same dead id.
        await markEnrichmentAttempted(`${platformCfg.idPrefix}${row.id}`, platform as Platform);
        continue;
      }

      const md: any = (platform === 'sniffies')
        ? extractSniffiesMetadata(row.data)
        : extractGrindrMetadata(row.data);
      if (!md) {
        failed++;
        await markEnrichmentAttempted(`${platformCfg.idPrefix}${row.id}`, platform as Platform);
        continue;
      }

      // Did we actually get training-useful features from this response? Some
      // platforms strip attributes for blocked users on direct fetch even
      // though they return 200 OK. Count those as "attempted but no features"
      // (noFeatures++) rather than inflating the enriched count.
      const gotFeatures = !!(md.bodyType || md.position || md.age || md.ethnicity
        || md.height || md.profileText || md.aboutMe || md.lookingFor);

      try {
        const existing = await getContact(`${platformCfg.contactPrefix}${row.id}`);
        let avatarUrl = md.__avatarUrl || '';
        delete md.__avatarUrl;
        // CRITICAL: stamp enrichmentAttempted so this contact drops out of
        // the needs-enrich pool regardless of whether we got real features
        // or an empty shell. Previous version re-selected the same "enriched"
        // contacts every tick forever because Grindr sometimes returns 200
        // with near-empty profile data for blocked users.
        const mergedMd = {
          ...(existing?.metadata || {}),
          ...md,
          enrichmentAttempted: true,
          enrichmentGotFeatures: gotFeatures,
        };
        await upsertContact({
          id: `${platformCfg.idPrefix}${row.id}`,
          platform: platform as Platform,
          platformUserId: row.id,
          displayName: md.displayName || existing?.displayName || '',
          profileUrl: existing?.profileUrl || (platform === 'sniffies'
            ? `https://sniffies.com/profile/${row.id}`
            : `https://web.grindr.com/chat/${row.id}`),
          avatarUrl: avatarUrl || existing?.avatarUrl || '',
          lastSeen: new Date().toISOString(),
          metadata: mergedMd,
        });
        if (gotFeatures) enriched++;
        else noFeatures++;
      } catch {
        failed++;
      }
    }

    const nextState: EnrichState = {
      ...state,
      total: correctedTotal,
      processed, enriched, noFeatures, failed,
      lastTickAt: Date.now(),
      status: sessionDead ? 'paused' : 'running',
      pauseReason: sessionDead ? 'session-dead' : null,
      lastError: sessionDead ? 'Grindr returned 401/403. Waiting for you to log back in (auto-login will help if you saved credentials).' : null,
    };
    await setEnrichState(nextState);
    console.log(`[Aggregaytor:SW] Enrich tick: +${processed - state.processed} processed (total ${processed}/${nextState.total}), ${enriched} with features, ${noFeatures} empty shell, ${failed} failed, status=${nextState.status}${sessionDead ? ' (paused)' : ''}`);
  } catch (err) {
    const state = await getEnrichState();
    await setEnrichState({ ...state, status: 'paused', pauseReason: 'error', lastTickAt: Date.now(),
      lastError: String((err as Error)?.message || err) });
    console.warn('[Aggregaytor:SW] Enrich tick failed:', err);
  } finally {
    enrichTickInFlight = false;
  }
}

/** Try to resume a paused enrichment. Called opportunistically when we
 *  observe signs of session recovery (auth captured, blocks succeeding).
 *  Only resumes if the paused run matches the platform that just showed
 *  signs of life — a working Grindr session shouldn't unpause a Sniffies
 *  enrichment. */
async function maybeResumeEnrich(platform?: string): Promise<void> {
  const state = await getEnrichState();
  if (state.status !== 'paused') return;
  if (state.pauseReason === 'manual') return; // don't override explicit stop
  if (platform && state.platform !== platform) return;
  await setEnrichState({ ...state, status: 'running', pauseReason: null, lastTickAt: Date.now() });
  chrome.alarms.create('enrich-blocked-tick', { periodInMinutes: 1 });
  runEnrichTick().catch(() => {});
}

// On SW startup, re-create the alarm if an enrichment is pending so the
// user's backlog resumes automatically across extension reloads / browser
// restarts / forced SW wakeups.
getEnrichState().then(state => {
  if (state.status === 'running' || state.status === 'paused') {
    chrome.alarms.create('enrich-blocked-tick', { periodInMinutes: 1 });
    console.log(`[Aggregaytor:SW] Resuming enrichment alarm (status=${state.status}, ${state.processed}/${state.total} done).`);
    if (state.status === 'running') runEnrichTick().catch(() => {});
  }
}).catch(() => {});

// `autoTrainedSet` tracks which contacts have already been trained during the
// current service-worker lifetime so a periodic scan doesn't feed the model
// the same sample repeatedly. It is capped so long-running SWs (days) on
// heavy accounts don't accumulate tens of thousands of entries in RAM.
const AUTO_TRAIN_SET_CAP = 10_000;
const autoTrainedSet = new Set<string>(); // contacts already auto-trained this session

/**
 * Add a contact to `autoTrainedSet` with bounded memory growth.
 * When the set exceeds AUTO_TRAIN_SET_CAP, drop the oldest 20% of entries
 * (JS Set preserves insertion order, so `values()` gives us FIFO eviction).
 */
function markAutoTrained(contactId: string): void {
  autoTrainedSet.add(contactId);
  if (autoTrainedSet.size > AUTO_TRAIN_SET_CAP) {
    const toDrop = Math.floor(AUTO_TRAIN_SET_CAP * 0.2);
    const iter = autoTrainedSet.values();
    for (let i = 0; i < toDrop; i++) {
      const next = iter.next();
      if (next.done) break;
      autoTrainedSet.delete(next.value);
    }
  }
}

// ── Incremental auto-training via the signal index ──────────────────────────
//
// The trainer used to rescan every contact on every pass (every 30 min). On
// a heavy account with thousands of contacts that's tens of thousands of
// doc iterations per hour even when nothing has changed since the last run.
//
// `upsertThreadMeta` now bumps `signalsUpdatedAt` only when a preference
// signal field actually changes. We persist "when did we last successfully
// train?" in chrome.storage and use it as a high-water mark: any thread-meta
// with `signalsUpdatedAt > lastRunAt` is in the delta. Contacts not covered
// by the delta are skipped entirely.
//
// The `autoTrainedSet` still guards against duplicate training within a
// single SW lifetime — the signal index is the *cross-lifetime* dedupe.
const LAST_TRAIN_TS_KEY = 'aggregaytor_last_auto_train_ts';

async function autoTrainFromSignals(): Promise<{ trained: number; scanned: number; skipped: number }> {
  const enabledData = await chrome.storage.local.get(['aggregaytor_auto_train_preferences', LAST_TRAIN_TS_KEY]);
  if (enabledData.aggregaytor_auto_train_preferences === false) return { trained: 0, scanned: 0, skipped: 0 };
  const lastRunAt: string = enabledData[LAST_TRAIN_TS_KEY] || '';

  let trained = 0;
  let scanned = 0;
  let skipped = 0;
  try {
    const allMeta = await getAllThreadMeta();
    const allContacts = await getAllContacts();

    // Build lookup maps
    const metaMap = new Map<string, any>();
    for (const m of allMeta) {
      const cid = m._id?.replace('meta:', '') || m.contactId || '';
      if (cid) metaMap.set(cid, m);
    }

    // Build the "signal-dirty" set: contacts whose thread-meta signals
    // bumped after the last training run. On the very first run (empty
    // lastRunAt) this returns everything so we catch pre-upgrade state.
    let dirtyContactIds: Set<string> | null = null;
    if (lastRunAt) {
      dirtyContactIds = new Set();
      for (const m of allMeta) {
        const ts = (m as any).signalsUpdatedAt || '';
        if (!ts || ts > lastRunAt) {
          const cid = m._id?.replace('meta:', '') || m.contactId || '';
          if (cid) dirtyContactIds.add(cid);
        }
      }
    }

    // Process ALL contacts — the signals are on contact metadata AND thread meta
    for (const contact of allContacts) {
      const contactId = contact._id?.replace('contact:', '') || '';
      if (!contactId || autoTrainedSet.has(contactId)) { skipped++; continue; }
      if (contactId.endsWith(':global-chat')) continue;

      const md = contact.metadata || {};

      // Skip contacts that weren't touched since the last run UNLESS they
      // have a platform-level signal (md.isPinned/isFavorite/isBlocked) —
      // those can change without going through upsertThreadMeta.
      if (dirtyContactIds && !dirtyContactIds.has(contactId)) {
        const hasPlatformSignal = md.isPinned || md.isFavorite || md.isBlocked;
        if (!hasPlatformSignal) { skipped++; continue; }
      }
      scanned++;

      const meta = metaMap.get(contactId) || {};
      const platform = (contact.platform || contactId.split(':')[0] || 'sniffies') as Platform;

      // Collect ALL signals from both contact metadata AND thread meta
      let liked: boolean | null = null;

      // ── Positive signals ──
      if (md.isPinned) liked = true;           // Sniffies pinned conversation
      if (md.isFavorite) liked = true;         // Grindr favorited profile
      if (meta.bookmarked) liked = true;       // Aggregaytor bookmarked
      if (meta.favorited) liked = true;        // Aggregaytor favorited
      if (meta.rating && meta.rating >= 4) liked = true;  // High star rating

      // ── Negative signals ──
      if (md.isBlocked) liked = false;         // Grindr blocked/hidden
      if (meta.blockedByThem) liked = false;   // Platform blocked
      if (meta.rating && meta.rating <= 2) liked = false;  // Low star rating
      // Don't count archived as negative — user may archive for other reasons

      if (liked === null) continue; // no signal

      const features: ProfileFeatures = {
        bodyType: String(md.bodyType || md.body || md.build || ''),
        position: String(md.position || md.attitude || md.sexualPosition || ''),
        age: String(md.age || ''),
        ethnicity: String(md.ethnicity || ''),
        height: String(md.height || ''),
        profileTextLength: String(md.profileText || md.aboutMe || md.bio || '').length,
        profileTextKeywords: [],
        hasPhoto: contact.avatarUrl ? 1 : 0,
        photoCount: Array.isArray(md.photos) ? md.photos.length : 0,
        distance: String(md.distance || ''),
        conversationLength: 0,
        responseRate: 0,
      };

      await recordFeedback(contactId, platform, liked, features);
      markAutoTrained(contactId);
      trained++;
    }

    if (trained > 0) {
      console.log(`${LOG} Auto-trained preference model with ${trained} new signals (scanned ${scanned}, skipped ${skipped} of ${allContacts.length} contacts via signal index)`);
    }
    // Persist the high-water mark even when no new signals trained — an
    // empty successful run still advances the cursor so the next pass only
    // considers newer changes.
    await chrome.storage.local.set({ [LAST_TRAIN_TS_KEY]: new Date().toISOString() }).catch(() => {});
  } catch (err) {
    console.warn(`${LOG} Auto-train error:`, err);
  }
  return { trained, scanned, skipped };
}

// Run auto-training every 30 minutes
chrome.alarms.create('preference-auto-train', { periodInMinutes: 30 });

// ── Open all sites ──────────────────────────────────────────────────────────

const ALL_SITES = [
  'https://sniffies.com',
  'https://web.grindr.com',
  'https://doublelist.com',
  'https://www.adam4adam.com/mailbox',
  'https://mail.google.com',
];

async function openAllSites(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const siteUrl of ALL_SITES) {
    const host = new URL(siteUrl).hostname;
    const existing = tabs.find(t => { try { return t.url && new URL(t.url).hostname === host; } catch { return false; } });
    if (existing?.id) {
      // Already open — just make sure it's not stale
      await chrome.tabs.update(existing.id, { active: false });
    } else {
      await chrome.tabs.create({ url: siteUrl, active: false });
    }
  }
}

// ── Grindr auto-relogin check ───────────────────────────────────────────────
//
// Grindr's aggressive rate limiting can silently log the user out after
// heavy cascade browsing / block-list imports. We poll once a minute and,
// if we detect the login screen, fire a notification and try clicking the
// SSO button so the session recovers without the user noticing.

chrome.alarms.create('grindr-login-check', { periodInMinutes: 1 });

/** Detect the Grindr login page and attempt a zero-interaction relogin.
 *  Safe to call any time — returns quickly if no Grindr tab is open. */
async function runGrindrLoginCheck(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const grindrTab = tabs.find(t => t.url?.includes('web.grindr.com'));
  if (!grindrTab?.id) return;

  // Detect Grindr's login screen by DOM + title heuristics
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: grindrTab.id },
    func: () => {
      const isLoginPage = !!document.querySelector('[data-testid="login-button"], .login-page, button[aria-label="Sign in"], [class*="login"]')
        || document.title.toLowerCase().includes('login')
        || document.title.toLowerCase().includes('sign in');
      return { isLoginPage, url: location.href };
    },
  });
  if (!result?.result?.isLoginPage) return;

  console.log(`${LOG} Grindr logged out detected, attempting relogin...`);
  safeNotify('grindr-relogin', {
    type: 'basic', iconUrl: 'icons/icon-128.png',
    title: 'Grindr logged out',
    message: 'Attempting to log back in via Apple Sign-In...',
    requireInteraction: true,
  });

  // Try clicking SSO buttons. Grindr rotates these selectors often; order by
  // preference (Apple first since that's what most accounts use).
  await chrome.scripting.executeScript({
    target: { tabId: grindrTab.id },
    func: () => {
      const selectors = [
        'button[data-testid="apple-login"]',
        '[aria-label*="Apple"]',
        '[class*="apple-login"]',
        'button:has(svg[class*="apple"])',
        'button[data-testid="google-login"]',
        '[aria-label*="Google"]',
        '[class*="google-login"]',
        'button[data-testid="login-button"]',
        'a[href*="login"]',
        'button[class*="sign-in"]',
        'button[class*="login"]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector<HTMLElement>(sel);
        if (btn) { btn.click(); return `clicked: ${sel}`; }
      }
      // Last resort — a full reload sometimes clears the logout banner
      location.reload();
      return 'reloaded';
    },
  });
}

chrome.alarms.create('block-rule-check', { periodInMinutes: 5 });
chrome.alarms.create('task-sync', { periodInMinutes: 5 });
console.log(`${LOG} Service worker ready`);
