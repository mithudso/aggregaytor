/**
 * llm.ts — Multi-provider LLM integration for context-aware responses.
 *
 * Providers (in priority order):
 *   1. Google Gemini (free tier available)
 *   2. OpenAI (GPT-4o-mini for cost efficiency)
 *   3. Anthropic Claude
 *   4. Local pattern matching fallback (no API key needed)
 */

import { getDossier, getDossierSlice, formatDossierContext, LruIdbCache } from '@aggregaytor/store';
import type { DossierCategory } from '@aggregaytor/store';

const LOG = '[Aggregaytor:LLM]';

export type LLMProvider = 'gemini' | 'openai' | 'anthropic' | 'groq' | 'cerebras' | 'perplexity' | 'mistral' | 'copilot' | 'local';

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
}

interface Message {
  direction: 'in' | 'out';
  body: string;
  timestamp: string;
}

interface SuggestionResult {
  suggestions: string[];
  provider: LLMProvider;
  error?: string;
}

const SETTINGS_KEY = 'aggregaytor_llm_settings';
const RATE_SETTINGS_KEY = 'aggregaytor_llm_rate_settings';
const PROVIDER_KEYS_KEY = 'aggregaytor_all_llm_keys';

// ── Settings Cache ──────────────────────────────────────────────────────────
//
// Every LLM call previously fanned out to 3–4 `chrome.storage.local.get()`
// round-trips: rate settings, provider keys, user-facing config,
// personality. Each read is 1–5ms but the cumulative cost on a hot burst
// of auto-respond / suggestions requests was visible in the SW perf stats.
//
// Settings are event-driven — they only change when the user clicks Save in
// the settings UI. `chrome.storage.onChanged` fires synchronously for any
// change, so we can cache eagerly and invalidate reactively with zero TTL.
//
// This module exports `getCachedStorage(key)` which returns the current
// cached value or fetches it lazily on first read. `chrome.storage.onChanged`
// invalidates entries on write.
const _storageCache = new Map<string, unknown>();
const _storagePending = new Map<string, Promise<unknown>>();
let _storageListenerInstalled = false;

/**
 * Install the one-time `chrome.storage.onChanged` listener that reactively
 * evicts cached settings keys the moment they're written anywhere. Idempotent
 * — guarded on `_storageListenerInstalled` so repeated calls are no-ops.
 *
 * Why: the cache has zero TTL and relies entirely on this listener for
 * freshness; without it a stale value could be served indefinitely.
 * @returns nothing. A missing `chrome.storage` API (unit tests) is swallowed
 *          so callers fall through to live reads instead of throwing.
 */
function installStorageListener(): void {
  if (_storageListenerInstalled) return;
  _storageListenerInstalled = true;
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const key of Object.keys(changes)) {
        _storageCache.delete(key);
      }
    });
  } catch {
    // chrome.storage unavailable (tests) — fall through to live reads
  }
}

/**
 * Read a `chrome.storage.local` key through the module's settings cache,
 * coalescing concurrent reads of the same key into a single in-flight fetch.
 *
 * Why: LLM hot paths read several settings keys per call; caching turns the
 * repeat reads into free in-memory lookups (invalidated reactively — see
 * `installStorageListener`). Serving a shared in-flight promise prevents a
 * burst of callers from each issuing their own storage round-trip.
 * @param key storage key to read.
 * @returns the cached/fetched value (`T`), or `undefined` when the key is unset.
 * @throws the underlying `chrome.storage.local.get` rejection — deliberately
 *         propagated (the pending entry is cleared first) so callers decide how
 *         to degrade rather than silently receiving a wrong value.
 */
async function getCachedStorage<T>(key: string): Promise<T | undefined> {
  installStorageListener();
  if (_storageCache.has(key)) return _storageCache.get(key) as T;
  const pending = _storagePending.get(key);
  if (pending) return pending as Promise<T>;
  const p = chrome.storage.local.get(key).then((data: any) => {
    _storageCache.set(key, data[key]);
    _storagePending.delete(key);
    return data[key] as T;
  }).catch(err => {
    _storagePending.delete(key);
    throw err;
  });
  _storagePending.set(key, p);
  return p as Promise<T>;
}

/** Explicit invalidation — used by save functions so the next read after a
 *  write doesn't race the onChanged listener. */
function invalidateStorageCache(key: string): void {
  _storageCache.delete(key);
  _storagePending.delete(key);
}

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  gemini: 'gemini-3.1-flash-lite-preview',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  groq: 'llama-3.1-8b-instant',
  // Cerebras: extraordinary free tier (1M tokens/day, 30 RPM) at ~2600 tok/s
  // on Llama 4 Scout — ~10x faster than Groq. Added v0.57.9.
  cerebras: 'llama-4-scout-17b-16e-instruct',
  perplexity: 'llama-3.1-sonar-small-128k-online',
  mistral: 'mistral-small-latest',
  copilot: 'gpt-4o-mini',
  local: 'local',
};

// ── Deprecation fallback ────────────────────────────────────────────────────
// Gemini 2.5 Flash family is announced for deprecation on 2026-06-17.
// Keep a fallback for pinned legacy Gemini 2.5 models so older saved
// settings continue working after the deprecation date.
//
// Surfaces as a warning via `getDeprecationWarnings()` so the panel can
// show a one-time banner before the swap happens.
const GEMINI_DEPRECATION_DATE = new Date('2026-06-17T00:00:00Z');
const GEMINI_FALLBACK_MAP: Record<string, string> = {
  'gemini-2.5-flash-lite': 'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash': 'gemini-3.1-flash-preview',
};

/**
 * Whether the current wall-clock time is at or past the announced Gemini 2.5
 * deprecation date. Pure predicate; drives auto-remapping of pinned models.
 * @returns true once `Date.now()` reaches `GEMINI_DEPRECATION_DATE`.
 */
function isGeminiDeprecated(): boolean {
  return Date.now() >= GEMINI_DEPRECATION_DATE.getTime();
}

/**
 * Remap a deprecated Gemini 2.5 model id to its live successor once the
 * deprecation date has passed, so older saved settings keep working.
 * Only affects the `gemini` provider and only auto-picked (not user-pinned)
 * models — see `getModelForTask`.
 * @param provider active provider; non-gemini values pass `model` through.
 * @param model the model id to potentially remap.
 * @returns the successor id if a mapping applies, else `model` unchanged.
 */
function applyDeprecationFallback(provider: LLMProvider, model: string): string {
  if (provider !== 'gemini') return model;
  if (!isGeminiDeprecated()) return model;
  return GEMINI_FALLBACK_MAP[model] || model;
}

/**
 * Return a list of human-readable deprecation warnings relevant right now.
 * The panel polls this so it can show an inline advisory without us needing
 * a separate notifications system for it.
 */
export function getDeprecationWarnings(): { id: string; message: string; activeAfter: string; active: boolean }[] {
  const now = Date.now();
  const daysUntil = (d: Date) => Math.ceil((d.getTime() - now) / 86_400_000);
  const warnings: { id: string; message: string; activeAfter: string; active: boolean }[] = [];
  const geminiDays = daysUntil(GEMINI_DEPRECATION_DATE);
  if (geminiDays > 0 && geminiDays <= 60) {
    warnings.push({
      id: 'gemini-2.5-deprecation',
      message: `Gemini 2.5 Flash deprecates in ${geminiDays} day${geminiDays === 1 ? '' : 's'} (2026-06-17). Aggregaytor already defaults to gemini-3.1-flash-lite-preview; update any pinned Gemini 2.5 model in Settings → AI before that date.`,
      activeAfter: GEMINI_DEPRECATION_DATE.toISOString(),
      active: false,
    });
  } else if (geminiDays <= 0) {
    warnings.push({
      id: 'gemini-2.5-deprecated',
      message: 'Gemini 2.5 Flash is deprecated — Aggregaytor defaults to gemini-3.1-flash-lite-preview and will remap pinned Gemini 2.5 models automatically.',
      activeAfter: GEMINI_DEPRECATION_DATE.toISOString(),
      active: true,
    });
  }
  return warnings;
}

// Known rate limits per provider (requests per minute on free/tier-1)
// Sources: provider docs as of April 2026
const PROVIDER_RPM: Record<string, number> = {
  gemini: 15,       // Free tier baseline; pinned Gemini 2.5 models auto-remap after 2026-06-17
  openai: 500,      // Tier 1 ($5): 500 RPM. Free tier only 3 RPM.
  anthropic: 50,    // Tier 1 ($5): 50 RPM all models
  groq: 30,         // Free: 30 RPM, 14400 RPD, very fast LPU inference
  cerebras: 30,     // Free: 30 RPM, 1M tokens/day — the largest free daily quota in the industry
  perplexity: 50,   // Tier 0: 50 RPM (pay-as-you-go, no free tier)
  mistral: 2,       // Free "Experiment": 2 RPM (paid tiers much higher)
  copilot: 10,      // No public API — community proxy only, rate undisclosed
};

// Per-provider request tracking for proactive cycling.
//
// `providerRequestCounts` stores a rolling window of request timestamps per
// provider. Entries older than 60s are dropped on every read so the array
// never grows unbounded on sustained heavy use. A hard ceiling is enforced
// defensively in case a provider is hit more than the soft-cap in 60s.
const providerRequestCounts = new Map<string, number[]>();
const PROVIDER_TS_HARD_CAP = 2000;

/**
 * Count requests made to `provider` within the trailing 60s window, pruning
 * aged-out timestamps as a side effect. Hot path — no logging.
 * @param provider provider id whose rolling window to measure.
 * @returns number of requests in the last 60 seconds.
 */
function getProviderRPMUsed(provider: string): number {
  const now = Date.now();
  const timestamps = providerRequestCounts.get(provider) || [];
  const recent = timestamps.filter(t => now - t < 60_000);
  if (recent.length !== timestamps.length) providerRequestCounts.set(provider, recent);
  return recent.length;
}

/**
 * Record a just-issued request against `provider`'s rolling RPM window, pruning
 * on write and enforcing a hard entry cap so the array can't grow unbounded
 * during a single 60s burst. Hot path — no logging.
 * @param provider provider id that a request was sent to.
 * @returns nothing; mutates `providerRequestCounts` in place.
 */
function recordProviderRequest(provider: string): void {
  const now = Date.now();
  let timestamps = providerRequestCounts.get(provider) || [];
  // Defensive ceiling. The 60s prune below is the primary bound, but it only
  // fires once the OLDEST entry has aged out — a burst that stays inside a
  // single 60s window is otherwise unbounded. PROVIDER_TS_HARD_CAP was
  // declared for exactly this and had never been enforced.
  if (timestamps.length >= PROVIDER_TS_HARD_CAP) {
    timestamps = timestamps.slice(-Math.floor(PROVIDER_TS_HARD_CAP / 2));
  }
  // v0.57.36: prune-on-write so the array is always exactly the 60s window.
  // Old code only pruned on read AND only after the 2000-entry hard cap was
  // reached. On a chronically-misbehaving SW this could pin ~16KB per provider
  // before the splice fired — small per provider but multiplied by lifetime
  // accumulation across SW restarts the steady-state grew. Pruning on every
  // write keeps the array at <= the actual RPM (typically <60).
  if (timestamps.length > 0 && now - timestamps[0] > 60_000) {
    timestamps = timestamps.filter(t => now - t < 60_000);
  }
  timestamps.push(now);
  providerRequestCounts.set(provider, timestamps);
}

/**
 * Whether `provider` is within one request of its known RPM ceiling, used to
 * cycle proactively before an actual 429. Leaves a 1-request buffer.
 * @param provider provider id to check.
 * @returns true when used RPM is at or above `limit - 1`.
 */
function isProviderNearLimit(provider: string): boolean {
  const limit = PROVIDER_RPM[provider] || 10;
  const used = getProviderRPMUsed(provider);
  return used >= limit - 1; // leave 1 request buffer
}

/**
 * Get the best available provider — cycles proactively before hitting rate limits.
 */
async function getBestProvider(): Promise<LLMConfig> {
  const primary = await getLLMConfig();
  if (primary.provider === 'local' || !primary.apiKey) return primary;

  // If primary is near its limit, try alternatives
  if (!isProviderNearLimit(primary.provider)) return primary;

  console.log(`${LOG} ${primary.provider} near rate limit (${getProviderRPMUsed(primary.provider)}/${PROVIDER_RPM[primary.provider] || '?'} RPM), cycling...`);

  // Copy before mutating: getAllProviderKeys() hands back the object held in
  // _storageCache, so writing the primary key into it would poison that cache
  // for every later reader (making a never-persisted key look persisted).
  const keys = { ...(await getAllProviderKeys()) };
  // Also include the primary key
  keys[primary.provider] = primary.apiKey;

  // Try providers in order of remaining capacity
  const candidates = Object.entries(keys)
    .filter(([p, k]) => k && p !== 'local')
    .map(([p, k]) => ({ provider: p as LLMProvider, apiKey: k, headroom: (PROVIDER_RPM[p] || 10) - getProviderRPMUsed(p) }))
    .filter(c => c.headroom > 0)
    .sort((a, b) => b.headroom - a.headroom);

  if (candidates.length) {
    const best = candidates[0];
    console.log(`${LOG} Cycling to ${best.provider} (${best.headroom} RPM headroom)`);
    return { provider: best.provider, apiKey: best.apiKey, model: '' };
  }

  // All providers near limit — return primary anyway
  return primary;
}

// ── Rate limiting + backoff ─────────────────────────────────────────────────

export interface LLMRateSettings {
  enabled: boolean;                // master toggle for LLM calls
  maxRequestsPerMinute: number;    // 0 = unlimited
  enableAutoRespond: boolean;      // allow auto-respond LLM calls
  enableSuggestions: boolean;      // allow suggestion LLM calls
  enableDossierExtract: boolean;   // allow dossier extraction calls
  enableNicknames: boolean;        // allow nickname generation calls
  enableSummaries: boolean;        // allow conversation summary calls
  /**
   * Anthropic prompt-cache TTL. Default 'ephemeral' = 5-minute cache.
   * Set 'long' for the 1-hour TTL added to the Anthropic API in late 2025.
   *
   * Pricing: 5-min cache write is 1.25× base tokens, 1-hour is 2× — but
   * cache reads are always 0.1× regardless of TTL. Break-even for 1h:
   *   needs ~3 subsequent cache hits within the hour to be cheaper than 5-min.
   *
   * When to prefer 'long':
   *   - Light-use pattern where auto-respond fires every 10–30 min
   *   - Stable persona/style guide (won't change during the hour)
   * When to keep 'short':
   *   - Heavy burst usage where cache will be hit many times in <5 min
   *     anyway (the 2× write premium isn't worth it)
   *   - Frequent personality/style-guide tweaks (write cost paid, cache
   *     invalidated before it pays off)
   */
  anthropicCacheTTL: 'short' | 'long';
}

const DEFAULT_RATE_SETTINGS: LLMRateSettings = {
  enabled: true,
  maxRequestsPerMinute: 10,
  enableAutoRespond: true,
  enableSuggestions: true,
  enableDossierExtract: true,
  enableNicknames: true,
  enableSummaries: true,
  anthropicCacheTTL: 'short', // conservative default — heavy users benefit most from 5-min
};

/**
 * Read the LLM rate/feature settings, merged over defaults so a partial or
 * missing stored record still yields a complete, safe settings object.
 * @returns the effective {@link LLMRateSettings} (defaults ∪ stored).
 */
export async function getLLMRateSettings(): Promise<LLMRateSettings> {
  const stored = await getCachedStorage<Partial<LLMRateSettings>>(RATE_SETTINGS_KEY);
  return { ...DEFAULT_RATE_SETTINGS, ...(stored || {}) };
}

/**
 * Persist a partial patch to the LLM rate settings (merged over current
 * values) and invalidate the cache so the next read reflects the write.
 * @param settings partial settings to merge and save.
 * @returns nothing; throws only if `chrome.storage.local.set` rejects.
 */
export async function saveLLMRateSettings(settings: Partial<LLMRateSettings>): Promise<void> {
  const existing = await getLLMRateSettings();
  const merged = { ...existing, ...settings };
  await chrome.storage.local.set({ [RATE_SETTINGS_KEY]: merged });
  invalidateStorageCache(RATE_SETTINGS_KEY);
}

// Request queue with exponential backoff
interface QueuedRequest {
  id: string;
  execute: () => Promise<Response>;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
  retries: number;
  feature: string;
}

const requestQueue: QueuedRequest[] = [];
let queueProcessing = false;

/**
 * Stable-sort the pending request queue so higher-priority features
 * (interactive < background < batch) drain first. Called before each queue
 * step so a late-arriving interactive request jumps ahead of background work.
 * @returns nothing; sorts `requestQueue` in place.
 */
function sortQueueByPriority(): void {
  requestQueue.sort((a, b) => {
    const pA = PRIORITY_ORDER[FEATURE_PRIORITY[a.feature] || 'background'] ?? 1;
    const pB = PRIORITY_ORDER[FEATURE_PRIORITY[b.feature] || 'background'] ?? 1;
    return pA - pB;
  });
}
let requestTimestamps: number[] = [];
let backoffUntil = 0;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;
/** Per-attempt provider request budget. Comfortably above a normal completion
 *  (our max_tokens tops out at 1024) but finite, so one wedged connection can't
 *  block the serial queue forever. Timeouts surface as an AbortError and go
 *  through the existing network-error retry path. */
const LLM_FETCH_TIMEOUT_MS = 60_000;
let rateLimitLoggedAt = 0;

/**
 * Whether the global request-rate cap has been reached in the trailing 60s,
 * pruning aged-out timestamps as a side effect. `maxPerMin <= 0` means
 * unlimited. Hot path — no logging.
 * @param maxPerMin configured requests-per-minute ceiling (0 = unlimited).
 * @returns true when the recent request count meets or exceeds the cap.
 */
function isRateLimited(maxPerMin: number): boolean {
  if (maxPerMin <= 0) return false;
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < 60_000);
  return requestTimestamps.length >= maxPerMin;
}

/**
 * Entry point for draining the request queue. Ensures only one drain loop runs
 * at a time and, critically, always clears the `queueProcessing` guard even if
 * the drain throws (see the inline note) so the queue can never wedge.
 * @returns nothing; resolves when the current drain pass ends.
 */
async function processQueue(): Promise<void> {
  if (queueProcessing) return;
  queueProcessing = true;

  // try/finally is load-bearing: the loop body awaits getLLMRateSettings(),
  // which reads chrome.storage and CAN reject. Without the finally, that
  // rejection escaped with queueProcessing still true, permanently wedging
  // the queue for the rest of the service-worker's life — every subsequent
  // queuedFetch() would push a request that nothing ever drained, so its
  // promise never settled and the caller hung forever.
  try {
    await drainQueue();
  } finally {
    queueProcessing = false;
  }
}

/**
 * Serial queue-drain loop: honours global backoff and the per-minute rate cap,
 * executes each queued request, and applies exponential backoff + bounded
 * retries on 429s, 5xx, and network errors. Background requests are dropped
 * (rejected) when rate-limited so interactive ones aren't starved. State
 * transitions (backoff, drops, retries) are logged via the file's console
 * convention.
 * @returns nothing; resolves when the queue is empty or fully drained/dropped.
 */
async function drainQueue(): Promise<void> {
  while (requestQueue.length > 0) {
    sortQueueByPriority(); // interactive requests first
    const rateSettings = await getLLMRateSettings();

    // Check global backoff
    if (Date.now() < backoffUntil) {
      const wait = backoffUntil - Date.now();
      console.log(`${LOG} Backoff: waiting ${Math.round(wait / 1000)}s`);
      await new Promise(r => setTimeout(r, wait));
    }

    // Check rate limit
    if (isRateLimited(rateSettings.maxRequestsPerMinute)) {
      // Drop background requests that have been queued — they can retry later.
      // Previous implementation: O(n²) — `filter` to find droppable then
      // `splice(indexOf())` to remove each. Now a single in-place partition:
      // keep interactive requests, reject the rest.
      const keep: QueuedRequest[] = [];
      const dropped: QueuedRequest[] = [];
      for (const r of requestQueue) {
        if (FEATURE_PRIORITY[r.feature] === 'interactive') keep.push(r);
        else dropped.push(r);
      }
      requestQueue.length = 0;
      for (const r of keep) requestQueue.push(r);
      for (const d of dropped) {
        d.reject(new Error('Rate limited — background request dropped'));
      }

      if (requestQueue.length === 0) {
        // Log at most once per 60 seconds
        if (!rateLimitLoggedAt || Date.now() - rateLimitLoggedAt > 60_000) {
          console.log(`${LOG} Rate limited (${rateSettings.maxRequestsPerMinute}/min), dropped ${dropped.length} background requests`);
          rateLimitLoggedAt = Date.now();
        }
        break;
      }

      if (!rateLimitLoggedAt || Date.now() - rateLimitLoggedAt > 60_000) {
        console.log(`${LOG} Rate limited, waiting 2min for ${requestQueue.length} interactive requests`);
        rateLimitLoggedAt = Date.now();
      }
      await new Promise(r => setTimeout(r, 120_000));
      continue;
    }

    const req = requestQueue.shift()!;
    requestTimestamps.push(Date.now());

    try {
      const res = await req.execute();

      if (res.status === 429) {
        // Rate limited by provider — exponential backoff
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, req.retries);
        backoffUntil = Date.now() + backoffMs;
        console.warn(`${LOG} 429 from provider, backoff ${backoffMs}ms (retry ${req.retries + 1}/${MAX_RETRIES})`);

        if (req.retries < MAX_RETRIES) {
          req.retries++;
          requestQueue.unshift(req); // put back at front
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        } else {
          req.reject(new Error(`Rate limited after ${MAX_RETRIES} retries`));
          continue;
        }
      }

      if (res.status >= 500) {
        // Server error — retry with backoff
        if (req.retries < MAX_RETRIES) {
          req.retries++;
          const backoffMs = BASE_BACKOFF_MS * Math.pow(2, req.retries);
          console.warn(`${LOG} Server error ${res.status}, retry ${req.retries}/${MAX_RETRIES} in ${backoffMs}ms`);
          requestQueue.unshift(req);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
      }

      req.resolve(res);
    } catch (err) {
      if (req.retries < MAX_RETRIES) {
        req.retries++;
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, req.retries);
        console.warn(`${LOG} Network error, retry ${req.retries}/${MAX_RETRIES} in ${backoffMs}ms`);
        requestQueue.unshift(req);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        req.reject(err as Error);
      }
    }
  }
}

/**
 * Queue a fetch request through the rate limiter + backoff system.
 */
async function queuedFetch(url: string, init: RequestInit, feature: string): Promise<Response> {
  const rateSettings = await getLLMRateSettings();

  // Check if LLM is globally disabled
  if (!rateSettings.enabled) {
    throw new Error('LLM calls disabled');
  }

  // Check feature-specific toggles
  const featureMap: Record<string, keyof LLMRateSettings> = {
    'auto-respond': 'enableAutoRespond',
    'suggestions': 'enableSuggestions',
    'dossier': 'enableDossierExtract',
    'nickname': 'enableNicknames',
    'summary': 'enableSummaries',
    'greeting': 'enableAutoRespond',
  };
  const toggle = featureMap[feature];
  if (toggle && !rateSettings[toggle]) {
    throw new Error(`LLM feature '${feature}' is disabled`);
  }

  // Reject background requests immediately if rate limited — don't even queue them
  const priority = FEATURE_PRIORITY[feature] || 'background';
  if (priority !== 'interactive' && isRateLimited(rateSettings.maxRequestsPerMinute)) {
    throw new Error('Rate limited — background request rejected');
  }

  return new Promise((resolve, reject) => {
    requestQueue.push({
      id: `${feature}-${Date.now()}`,
      // The queue drains SERIALLY, so a single hung provider connection would
      // otherwise stall every other LLM request behind it indefinitely. The
      // signal is constructed per attempt so each retry gets a fresh budget.
      execute: () => fetch(url, {
        ...init,
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(LLM_FETCH_TIMEOUT_MS)
          : undefined,
      }),
      resolve,
      reject,
      retries: 0,
      feature,
    });
    // Not awaited (the per-request promise is what the caller waits on), so
    // attach a handler — an unhandled rejection here would surface as a bogus
    // top-level error in the rolling error log.
    processQueue().catch(err => {
      console.warn(`${LOG} queue processor aborted:`, (err as Error)?.message || err);
    });
  });
}

/**
 * Read the user's active LLM config (provider/apiKey/model) from cached
 * storage, defaulting to the keyless `local` provider when unset.
 * @returns a fully-populated {@link LLMConfig}; never throws for a missing key.
 */
export async function getLLMConfig(): Promise<LLMConfig> {
  const settings = await getCachedStorage<Partial<LLMConfig>>(SETTINGS_KEY) || {};
  return {
    provider: settings.provider || 'local',
    apiKey: settings.apiKey || '',
    model: settings.model || '',
  };
}

/**
 * Get all configured API keys for failover.
 *
 * NOTE: the returned object is the cached instance, not a copy — callers that
 * intend to add or override entries MUST spread it first, or they will mutate
 * the shared settings cache.
 */
export async function getAllProviderKeys(): Promise<Record<string, string>> {
  const keys = await getCachedStorage<Record<string, string>>(PROVIDER_KEYS_KEY);
  return keys || {};
}

/**
 * Persist a single provider's API key into the failover key store and
 * invalidate the cache. Spreads the cached object first so the shared cache
 * instance isn't mutated (see {@link getAllProviderKeys}).
 * @param provider provider id the key belongs to.
 * @param apiKey the API key to store.
 * @returns nothing; throws only if `chrome.storage.local.set` rejects.
 */
export async function saveProviderKey(provider: string, apiKey: string): Promise<void> {
  const keys = await getAllProviderKeys();
  const next = { ...keys, [provider]: apiKey };
  await chrome.storage.local.set({ [PROVIDER_KEYS_KEY]: next });
  invalidateStorageCache(PROVIDER_KEYS_KEY);
}

// v0.57.54: per-provider model overrides. The model auto-updater writes
// here when it discovers a newer model for any provider — even ones
// that aren't currently active. getEffectiveModelForProvider() reads
// this first, then falls back to the active LLMConfig.model (if same
// provider), then to DEFAULT_MODELS.
const PROVIDER_MODELS_KEY = 'aggregaytor_provider_models_v1';
/**
 * Read the auto-updater's per-provider model override, if any.
 * @param provider provider id to look up.
 * @returns the override model id, or `undefined` when none is set — a storage
 *          read failure is deliberately swallowed and also returns `undefined`
 *          so the caller falls back to the default model.
 */
export async function getProviderModelOverride(provider: string): Promise<string | undefined> {
  try {
    const got = await getCachedStorage<Record<string, string>>(PROVIDER_MODELS_KEY);
    return got?.[provider];
  } catch { return undefined; }
}
/**
 * Write a per-provider model override (used by the model auto-updater) and
 * invalidate the cache. Spreads the cached map first to avoid mutating it.
 * @param provider provider id the override applies to.
 * @param model the newer model id to prefer for this provider.
 * @returns nothing; throws only if `chrome.storage.local.set` rejects.
 */
export async function setProviderModelOverride(provider: string, model: string): Promise<void> {
  const got = await getCachedStorage<Record<string, string>>(PROVIDER_MODELS_KEY);
  const next = { ...(got || {}), [provider]: model };
  await chrome.storage.local.set({ [PROVIDER_MODELS_KEY]: next });
  invalidateStorageCache(PROVIDER_MODELS_KEY);
}
/**
 * Read every stored per-provider model override.
 * NOTE: like getAllProviderKeys, this returns the cached instance. Spread it
 * before adding or overriding entries.
 * @returns a `{ provider: modelId }` map (empty object when none stored).
 */
export async function getAllProviderModels(): Promise<Record<string, string>> {
  const got = await getCachedStorage<Record<string, string>>(PROVIDER_MODELS_KEY);
  return got || {};
}
/**
 * The shipped default model id for a provider. Pure lookup.
 * @param provider provider to resolve.
 * @returns the `DEFAULT_MODELS` entry for `provider`.
 */
export function getDefaultModel(provider: LLMProvider): string {
  return DEFAULT_MODELS[provider];
}
/**
 * Resolve the model a provider should actually use: auto-updater override if
 * present, otherwise the shipped default.
 * @param provider provider to resolve a model for.
 * @returns the effective model id.
 */
export async function getEffectiveModelForProvider(provider: LLMProvider): Promise<string> {
  const override = await getProviderModelOverride(provider);
  if (override) return override;
  return DEFAULT_MODELS[provider];
}

/**
 * Get a working LLM config, trying failover providers if the primary is rate-limited.
 */
async function getConfigWithFailover(rateLimitedProvider?: string): Promise<LLMConfig> {
  const primary = await getLLMConfig();

  // If not rate limited, use primary
  if (!rateLimitedProvider || rateLimitedProvider !== primary.provider) return primary;

  // Try failover: check all stored keys
  const keys = await getAllProviderKeys();
  // Failover order: prefer free-tier fast inference first, then paid.
  // Cerebras has the biggest free daily quota (1M tokens/day) so it's
  // the safest fallback when the primary provider 429s.
  const providerOrder: LLMProvider[] = ['cerebras', 'groq', 'gemini', 'anthropic', 'openai'];

  for (const p of providerOrder) {
    if (p === rateLimitedProvider) continue;
    const key = keys[p] || (p === primary.provider ? primary.apiKey : '');
    if (key) {
      console.log(`${LOG} Failing over from ${rateLimitedProvider} to ${p}`);
      return { provider: p, apiKey: key, model: '' };
    }
  }

  // No failover available, return primary anyway
  return primary;
}

/**
 * Snapshot the request-queue + rate-limiter state for the debug/status UIs:
 * queue depth, requests in the last minute, remaining global backoff, and
 * per-provider RPM usage vs. limit. Pure read — no logging.
 * @returns a plain status object (see fields inline).
 */
export function getLLMQueueStatus() {
  const now = Date.now();
  const providerUsage: Record<string, { used: number; limit: number }> = {};
  for (const [provider, limit] of Object.entries(PROVIDER_RPM)) {
    providerUsage[provider] = { used: getProviderRPMUsed(provider), limit };
  }
  return {
    queueLength: requestQueue.length,
    requestsLastMinute: requestTimestamps.filter(t => now - t < 60_000).length,
    backoffUntil: Math.max(0, backoffUntil - now),
    providerUsage,
  };
}

/**
 * Persist a partial LLM config patch (merged over current), invalidate the
 * cache, and mirror the key into the failover key store when both provider and
 * apiKey are present so failover can reach it later.
 * @param config partial config to merge and save.
 * @returns nothing; throws only if a `chrome.storage.local.set` rejects.
 */
export async function saveLLMConfig(config: Partial<LLMConfig>): Promise<void> {
  const existing = await getLLMConfig();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...existing, ...config },
  });
  invalidateStorageCache(SETTINGS_KEY);
  // Also save key to failover store
  if (config.provider && config.apiKey) {
    await saveProviderKey(config.provider, config.apiKey);
  }
}

// ── Personality presets + style guide + custom instructions ──────────────────

const PERSONALITY_SETTINGS_KEY = 'aggregaytor_personality';

export interface PersonalitySettings {
  preset: string;           // active preset name
  customInstructions: string;
  styleGuide: string;       // auto-derived from user's messages
  styleGuideUpdatedAt: string;
}

const DEFAULT_PERSONALITY: PersonalitySettings = {
  preset: 'direct',
  customInstructions: '',
  styleGuide: '',
  styleGuideUpdatedAt: '',
};

export const PERSONALITY_PRESETS: Record<string, { label: string; description: string; prompt: string }> = {
  eager: {
    label: 'Eager',
    description: 'Enthusiastic, excited, proactive about meeting',
    prompt: 'Be enthusiastic and clearly interested. Show excitement. Proactively suggest meeting up. Use exclamation points sparingly but genuinely. Show you are keen.',
  },
  flirty: {
    label: 'Flirty',
    description: 'Playful, teasing, suggestive without being crass',
    prompt: 'Be playful and flirtatious. Use innuendo and light teasing. Be charming and witty. Keep it fun and suggestive without being vulgar. Make them smile.',
  },
  conversational: {
    label: 'Conversational',
    description: 'Friendly, engaging, asks questions, keeps dialogue flowing',
    prompt: 'Be warm and conversational. Ask follow-up questions. Show genuine curiosity about them. Keep the dialogue flowing naturally. Be a good listener.',
  },
  stoic: {
    label: 'Stoic',
    description: 'Calm, measured, unbothered, confident silence',
    prompt: 'Be calm and measured. Use few words but make them count. Do not show eagerness or neediness. Let silences speak. Be confident and unhurried.',
  },
  direct: {
    label: 'Direct',
    description: 'Straightforward, no games, clear about intentions',
    prompt: 'Be straightforward and clear. State what you want directly. No beating around the bush. Cut through small talk efficiently. Be honest and transparent.',
  },
  dismissive: {
    label: 'Dismissive',
    description: 'Disinterested energy, makes them work for attention',
    prompt: 'Be slightly aloof and hard to impress. Give short responses. Make them earn your interest. Do not chase. Show you have better options.',
  },
  pleasant: {
    label: 'Pleasant',
    description: 'Warm, polite, genuinely nice, easy to talk to',
    prompt: 'Be genuinely warm and pleasant. Be polite and considerate. Make them feel comfortable. Be the person everyone wants to talk to. Kind but not pushover.',
  },
  aloof: {
    label: 'Aloof',
    description: 'Mysterious, gives little away, creates intrigue',
    prompt: 'Be enigmatic and give away little about yourself. Create curiosity. Answer questions with questions. Be intriguing without being rude.',
  },
  assertive: {
    label: 'Assertive',
    description: 'Takes charge, leads the conversation, decisive',
    prompt: 'Take charge of the conversation. Be decisive — suggest specific times and places. Lead without being pushy. Show you know what you want.',
  },
  witty: {
    label: 'Witty',
    description: 'Clever, uses humor, quick on the uptake',
    prompt: 'Be clever and use dry humor. Make witty observations. Be quick on the uptake. Use banter. Keep it intelligent and amusing.',
  },
  masculine: {
    label: 'Masculine',
    description: 'Confident, protective energy, takes the lead',
    prompt: 'Project confidence and masculinity. Be protective without being controlling. Take the lead. Be strong and dependable. Use a commanding but warm tone.',
  },
  submissive: {
    label: 'Submissive',
    description: 'Accommodating, follows their lead, eager to please',
    prompt: 'Be accommodating and let them take the lead. Show eagerness to please. Be flexible with their preferences. Express desire to fulfill their needs.',
  },
  hookup: {
    label: 'Hookup-focused',
    description: 'Efficient, logistics-focused, cuts to the chase',
    prompt: 'Focus on logistics. Get to the point quickly — hosting, travel, timing. Skip extensive small talk. Be efficient but not rude. Close the deal.',
  },
  dating: {
    label: 'Dating-focused',
    description: 'Getting to know them, building genuine connection',
    prompt: 'Focus on building a genuine connection. Ask about their interests, life, and goals. Suggest date activities. Show you are interested in them as a person, not just physically.',
  },
};

/**
 * Read the persona/style settings merged over defaults, so a partial or
 * missing record still yields a complete object.
 * @returns the effective {@link PersonalitySettings}.
 */
export async function getPersonalitySettings(): Promise<PersonalitySettings> {
  const stored = await getCachedStorage<Partial<PersonalitySettings>>(PERSONALITY_SETTINGS_KEY);
  return { ...DEFAULT_PERSONALITY, ...(stored || {}) };
}

/**
 * Persist a partial personality-settings patch (merged over current) and
 * invalidate the cache so the next prompt build sees it.
 * @param settings partial personality settings to merge and save.
 * @returns nothing; throws only if `chrome.storage.local.set` rejects.
 */
export async function savePersonalitySettings(settings: Partial<PersonalitySettings>): Promise<void> {
  const existing = await getPersonalitySettings();
  await chrome.storage.local.set({ [PERSONALITY_SETTINGS_KEY]: { ...existing, ...settings } });
  invalidateStorageCache(PERSONALITY_SETTINGS_KEY);
}

/**
 * Derive a style guide from the user's own sent messages.
 * Analyzes message length, vocabulary, punctuation, emoji usage, etc.
 */
export async function deriveStyleGuide(sentMessages: Message[]): Promise<string> {
  if (sentMessages.length < 5) return 'Not enough messages to derive style (need 5+).';

  const bodies = sentMessages.map(m => m.body);
  const avgLength = Math.round(bodies.reduce((s, b) => s + b.length, 0) / bodies.length);
  const usesEmoji = bodies.some(b => /[\u{1F600}-\u{1F9FF}]/u.test(b));
  const usesExclamation = bodies.filter(b => b.includes('!')).length / bodies.length;
  const usesQuestion = bodies.filter(b => b.includes('?')).length / bodies.length;
  const avgWords = Math.round(bodies.reduce((s, b) => s + b.split(/\s+/).length, 0) / bodies.length);
  const usesSlang = bodies.some(b => /\b(wbu|hbu|tbh|ngl|fr|imo|smh|lol|lmao|bruh)\b/i.test(b));
  const usesCapitals = bodies.filter(b => b === b.toUpperCase() && b.length > 3).length / bodies.length;
  const startsLowercase = bodies.filter(b => /^[a-z]/.test(b)).length / bodies.length;

  const traits: string[] = [];
  traits.push(`Average message length: ${avgLength} chars, ${avgWords} words`);
  if (avgWords <= 5) traits.push('Very brief messages — keep responses short');
  else if (avgWords <= 15) traits.push('Medium-length messages');
  else traits.push('Longer, more detailed messages');

  if (usesEmoji) traits.push('Uses emoji occasionally');
  else traits.push('Does NOT use emoji — avoid emoji in responses');

  if (usesExclamation > 0.3) traits.push('Uses exclamation marks frequently');
  else if (usesExclamation < 0.05) traits.push('Rarely uses exclamation marks — keep responses calm');

  if (usesQuestion > 0.3) traits.push('Asks lots of questions — include questions in responses');

  if (usesSlang) traits.push('Uses casual slang (wbu, tbh, lol)');
  else traits.push('Formal/standard language — avoid heavy slang');

  if (startsLowercase > 0.5) traits.push('Often starts with lowercase — match this style');
  if (usesCapitals > 0.1) traits.push('Sometimes uses ALL CAPS for emphasis');

  // Sample some actual messages for LLM to analyze
  const samples = bodies.slice(-10).map(b => `"${b.slice(0, 60)}"`).join(', ');
  traits.push(`Recent message samples: ${samples}`);

  return traits.join('. ') + '.';
}

/**
 * Compose the suggestions system prompt from modular fragments, optionally
 * including a per-contact dossier slice. `contactId` is optional — when the
 * UI doesn't have one handy (or we're in a test) we fall back to the
 * no-context composition, which is still modular and benefits from the
 * persona/style caches.
 */
async function buildSystemPromptWithContext(
  contactName: string,
  platform: string,
  contactId?: string,
): Promise<string> {
  const [persona, style, contactCtx] = await Promise.all([
    personaModule(),
    writingStyleModule(),
    contactId
      ? contactContextModule(contactId, FEATURE_DOSSIER_CATEGORIES['suggestions'])
      : Promise.resolve(''),
  ]);
  const sections: string[] = [
    `You are composing responses for a dating/hookup chat on ${platform}. The user is chatting with "${contactName}".`,
    persona,
    `Your job: suggest 3-4 short, natural response options matching this personality.`,
  ];
  if (style) sections.push(style);
  if (contactCtx) sections.push(contactCtx);
  sections.push(SUGGESTIONS_FORMAT_MODULE);
  return sections.join('\n\n');
}

// ── Optimization layer ──────────────────────────────────────────────────────

// 1. Response cache — cache LLM responses by prompt hash.
//
// v0.57.73: switched from a bare Map to LruIdbCache (mem 100 / cold 400 in
// IDB, 5-min TTL). Win is twofold:
//   1. Cold-tier survives SW restarts so a freshly-recycled SW serves
//      cached responses instead of re-paying token cost on first burst.
//   2. The mem tier still caps at 100 entries × ~1-2KB = ~100-200KB max
//      heap; cold tier holds the older 400 entries in IDB without
//      occupying SW heap.
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const responseCache = new LruIdbCache<{ response: string; tokens: number }>({
  storeName: 'llm-response',
  maxItems: 100,
  maxItemsTotal: 400,
  ttlMs: CACHE_TTL_MS,
});

/**
 * Derive a collision-resistant cache/coalesce key from the full system+user
 * prompts and feature. Hashes the entire prompt text (not slices) because this
 * key also drives in-flight coalescing — a collision would hand one contact's
 * response to another's request. Pure/hot — no logging.
 * @param systemPrompt full system prompt.
 * @param userPrompt full user prompt.
 * @param feature feature tag (namespaces the key).
 * @returns a short deterministic key string (`c_<base36 hash>`).
 */
function getCacheKey(systemPrompt: string, userPrompt: string, feature: string): string {
  // Hash the FULL prompts, not slices. The old key hashed only the first 200
  // chars of the system prompt plus the last 500 of the user prompt, so two
  // requests that differed only in the middle collided — and this key also
  // drives in-flight coalescing, so a collision meant one contact's response
  // was handed to another's request. Prompts are a few KB at most, so hashing
  // all of it is negligible. Lengths are mixed in as a cheap extra discriminator.
  let hash = 0;
  const str = `${feature}:${systemPrompt.length}:${userPrompt.length}:${systemPrompt}:${userPrompt}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `c_${hash.toString(36)}`;
}

/**
 * Look up a previously cached provider response by cache key. Logs a cache hit
 * (token savings) via the file's console convention.
 * @param key cache key from {@link getCacheKey}.
 * @returns the cached response text, or `null` on a miss/expired entry.
 */
async function getCachedResponse(key: string): Promise<string | null> {
  const entry = await responseCache.get(key);
  if (!entry) return null;
  console.log(`${LOG} Cache hit (saved ${entry.tokens} tokens)`);
  return entry.response;
}

/**
 * Store a provider response under `key` for later reuse. Delegates LRU/TTL/cap
 * eviction to {@link LruIdbCache}.
 * @param key cache key from {@link getCacheKey}.
 * @param response the provider response text to cache.
 * @param estimatedTokens estimated token count (for savings reporting).
 * @returns nothing; the cold-tier IDB write may reject and is the caller's to
 *          handle (callers use fire-and-forget `.catch()`).
 */
async function setCachedResponse(key: string, response: string, estimatedTokens: number): Promise<void> {
  // LruIdbCache handles its own LRU + cap eviction + TTL.
  await responseCache.set(key, { response, tokens: estimatedTokens });
}

// 2. System prompt composition — driven by the modular cache below.
//    The old implementation cached a whole prompt string and did a regex
//    swap on the contact name (which silently broke when the contact name
//    contained regex special chars). Now each module is cached independently
//    and composed cheaply on every call. The per-module caches mean the
//    heavy parts (persona, style guide) are reused across features, while
//    contact name is interpolated fresh and always correct.
//
//    v0.57.15: removed the dead `cachedSystemPrompt` / `systemPromptHash`
//    back-compat shims — they were preserved across the v0.57.8 caching
//    overhaul to avoid breaking in-flight reloads, but enough release
//    cycles have passed that no live build references them. The empty
//    `getCachedSystemPrompt` wrapper is also gone; callers use
//    `buildSystemPromptWithContext` directly.

// 3. Conversation windowing — use fewer messages for simpler tasks
const CONTEXT_WINDOWS: Record<string, number> = {
  suggestions: 10,      // was 30 — suggestions only need recent context
  'auto-respond': 15,   // was 30 — auto-respond needs slightly more
  dossier: 25,          // was 50 — dossier still needs depth
  summary: 20,          // was 30
  nickname: 5,          // minimal context needed
  greeting: 0,          // no context needed
};

// Memoize the serialized conversation context. For an active thread the
// SW often fires 3–5 LLM calls back-to-back (suggestions, auto-respond,
// dossier, summary) — all of them with the same or overlapping recent
// messages. The serialization is a tight loop but it re-runs even for
// identical inputs. Cache by `(contactName, windowSize, lastTimestamp,
// messageCount)` — if those match, the last-N-message window is identical
// byte-for-byte.
//
// TTL is 30s so mid-conversation the cache stays warm but newly-arriving
// messages are picked up promptly.
const _contextBuilderCache = new Map<string, { value: string; time: number }>();
const CONTEXT_BUILDER_TTL_MS = 30_000;
const CONTEXT_BUILDER_CAP = 200;

/** Serialize a message window to the `Speaker: body` transcript form, with
 *  long bodies compacted. Single definition — three copies of this loop used
 *  to be inlined across buildConversationContext and
 *  getCompactConversationContext. */
function renderTranscript(messages: Message[], contactName: string): string {
  return messages.map(m => {
    const body = m.body.length > 100 ? m.body.slice(0, 100) + '...' : m.body;
    return `${m.direction === 'out' ? 'You' : contactName}: ${body}`;
  }).join('\n');
}

/**
 * Serialize the most-recent message window into a compact transcript string
 * for prompting, memoized by (contact, feature, count, last-timestamp) with a
 * short TTL so back-to-back LLM calls on one thread reuse the work. Hot path —
 * no logging.
 * @param messages full message list (only the last window is used).
 * @param contactName display name used as the inbound speaker label.
 * @param feature feature tag selecting the window size (default `suggestions`).
 * @returns the rendered `Speaker: body` transcript.
 */
function buildConversationContext(messages: Message[], contactName: string, feature = 'suggestions'): string {
  const windowSize = CONTEXT_WINDOWS[feature] || 15;
  const recent = messages.slice(-windowSize);

  // Cache key — the tuple (contact name, count, last-msg-ts) is enough to
  // disambiguate recent windows without hashing the bodies. Contact names
  // are bounded and messages are appended, not edited, so this is tight.
  const last = recent[recent.length - 1];
  const cacheKey = `${contactName}|${feature}|${recent.length}|${last?.timestamp || ''}`;
  const cached = _contextBuilderCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CONTEXT_BUILDER_TTL_MS) {
    return cached.value;
  }

  // Context compaction: for long messages, truncate to first 100 chars
  const value = renderTranscript(recent, contactName);

  _contextBuilderCache.set(cacheKey, { value, time: Date.now() });
  if (_contextBuilderCache.size > CONTEXT_BUILDER_CAP) {
    const iter = _contextBuilderCache.keys();
    const next = iter.next();
    if (!next.done) _contextBuilderCache.delete(next.value);
  }
  return value;
}

// 4. Incremental dossier extraction — only process new messages.
//    Bounded at DOSSIER_TS_CAP entries so long-lived SWs on heavy accounts
//    don't accumulate an entry per contact forever. When the cap is hit,
//    the oldest ~20% of entries are dropped (JS Map preserves insertion
//    order, so iterating `keys()` gives us FIFO eviction).
const lastDossierExtractTimestamp = new Map<string, string>();
const DOSSIER_TS_CAP = 2000;

/**
 * Return only messages newer than the last dossier extraction for a contact,
 * so extraction processes deltas instead of the whole thread. Pure — no logging.
 * @param contactId contact whose extraction cursor to consult.
 * @param messages the contact's full message list.
 * @returns messages after the stored cursor, or all messages on first run.
 */
function getNewMessagesSinceLastExtraction(contactId: string, messages: Message[]): Message[] {
  const lastTs = lastDossierExtractTimestamp.get(contactId);
  if (!lastTs) return messages; // first extraction — use all
  return messages.filter(m => m.timestamp > lastTs);
}

/**
 * Advance the dossier-extraction cursor for a contact to the newest processed
 * message timestamp, with FIFO eviction once the tracker map hits its cap.
 * @param contactId contact whose cursor to advance.
 * @param messages the messages just processed (max timestamp becomes the cursor).
 * @returns nothing; no-op for an empty `messages`.
 */
function markDossierExtracted(contactId: string, messages: Message[]): void {
  if (!messages.length) return;
  const latest = messages.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
  lastDossierExtractTimestamp.set(contactId, latest.timestamp);
  if (lastDossierExtractTimestamp.size > DOSSIER_TS_CAP) {
    const toDrop = Math.floor(DOSSIER_TS_CAP * 0.2);
    const iter = lastDossierExtractTimestamp.keys();
    for (let i = 0; i < toDrop; i++) {
      const next = iter.next();
      if (next.done) break;
      lastDossierExtractTimestamp.delete(next.value);
    }
  }
}

// 5. Model routing — best models for interactive, cheapest for background
//    premium: user-facing responses that need quality (suggestions, auto-respond)
//    standard: analytical tasks that need accuracy but not style (summary, dossier)
//    economy: trivial tasks where any output works (nickname, greeting)
const TASK_TIER: Record<string, 'premium' | 'standard' | 'economy'> = {
  suggestions: 'premium',
  'auto-respond': 'premium',
  summary: 'standard',
  dossier: 'standard',
  nickname: 'economy',
  greeting: 'economy',
};

// Best model per provider per tier
const TIERED_MODELS: Record<string, Record<string, string>> = {
  openai: {
    premium: 'gpt-4o',            // best quality for responses
    standard: 'gpt-4o-mini',      // good enough for analysis
    economy: 'gpt-4o-mini',       // cheapest
  },
  anthropic: {
    premium: 'claude-sonnet-4-20250514',   // best for natural conversation
    standard: 'claude-haiku-4-5-20251001', // fast + cheap for analysis
    economy: 'claude-haiku-4-5-20251001',
  },
  gemini: {
    premium: 'gemini-2.5-flash',     // best free model
    standard: 'gemini-2.5-flash-lite', // cheaper
    economy: 'gemini-2.5-flash-lite',
  },
  groq: {
    premium: 'llama-3.3-70b-versatile',  // best quality on Groq
    standard: 'llama-3.1-8b-instant',    // fast + cheap
    economy: 'llama-3.1-8b-instant',
  },
  cerebras: {
    // Cerebras runs Llama on wafer-scale chips at ~2600 tok/s. Even the
    // premium 70B model comes back faster than most providers' smallest.
    premium: 'llama-3.3-70b',
    standard: 'llama-4-scout-17b-16e-instruct',
    economy: 'llama-3.1-8b',
  },
  perplexity: {
    premium: 'sonar',
    standard: 'sonar',
    economy: 'sonar',
  },
  mistral: {
    premium: 'mistral-medium-latest',
    standard: 'mistral-small-latest',
    economy: 'mistral-small-latest',
  },
  copilot: {
    premium: 'gpt-4o',
    standard: 'gpt-4o-mini',
    economy: 'gpt-4o-mini',
  },
};

/**
 * Choose the model id for a request: honour a user-pinned model verbatim,
 * else pick the provider's model for the feature's cost tier, applying the
 * Gemini deprecation remap only to auto-picked models. Pure — no logging.
 * @param config active config (its `model`, if set, wins).
 * @param feature feature tag mapped to a premium/standard/economy tier.
 * @returns the resolved model id.
 */
function getModelForTask(config: LLMConfig, feature: string): string {
  // If user explicitly set a model, always use it — deprecation swapping is
  // on auto-pick only. A user who pinned "gemini-2.5-flash" knows what they
  // asked for, and if that model goes away the error will surface loudly.
  if (config.model) return config.model;

  const tier = TASK_TIER[feature] || 'standard';
  const providerModels = TIERED_MODELS[config.provider];
  const chosen = providerModels
    ? (providerModels[tier] || providerModels.standard || DEFAULT_MODELS[config.provider] || '')
    : (DEFAULT_MODELS[config.provider] || '');
  return applyDeprecationFallback(config.provider, chosen);
}

// 6. Token estimation — rough estimate to track usage
/**
 * Rough token estimate (≈4 chars/token) for usage/savings accounting only —
 * not billing-accurate. Pure/hot — no logging.
 * @param text text to estimate.
 * @returns estimated token count.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // rough approximation: 4 chars per token
}

// 7. Stats tracking
let totalTokensSaved = 0;
let totalCacheHits = 0;
let totalApiCalls = 0;

/**
 * Snapshot the LLM optimization counters and in-memory cache sizes for the
 * settings/debug UI. Cache sizes report the MEM tier only (see inline note).
 * Pure read — no logging.
 * @returns a plain stats object (tokens saved, cache hits, API calls, sizes).
 */
export function getLLMOptimizationStats() {
  // v0.57.73: cacheSize / summaryCacheSize now report MEM-TIER size only
  // (sync). Cold-tier counts would need a coldSize() async call which
  // would change this function's signature; the panel can call those
  // separately if it cares about the IDB-side count.
  return {
    totalTokensSaved, totalCacheHits, totalApiCalls,
    cacheSize: responseCache.memSize(),
    coalescedRequests: totalCoalesced,
    // Surface the bounded-map sizes too so the settings UI can show the
    // user how much memory the LLM subsystem is holding on to.
    summaryCacheSize: conversationSummaryCache.memSize(),
    dossierTimestampSize: lastDossierExtractTimestamp.size,
    providerTrackerSize: providerRequestCounts.size,
  };
}

/**
 * Drop every in-memory cache the LLM subsystem owns: response cache,
 * rolling summaries, dossier extraction cursors, and per-provider rate
 * trackers. Counters (totalApiCalls etc.) are preserved — those are
 * lifetime stats that are useful for debugging long-running SWs.
 *
 * Exposed as `CLEAR_LLM_CACHE` in the service-worker message router so the
 * settings UI can offer a one-click "reset" without a full extension reload.
 */
export function clearLLMCaches(): { cleared: Record<string, number> } {
  const cleared = {
    responseCache: responseCache.memSize(),
    summaryCache: conversationSummaryCache.memSize(),
    dossierTimestamps: lastDossierExtractTimestamp.size,
    providerRequestCounts: providerRequestCounts.size,
    inflightRequests: inflightRequests.size,
    promptModules: _promptModuleCache.size,
    storageCache: _storageCache.size,
    contextBuilderCache: _contextBuilderCache.size,
  };
  // v0.57.73: LruIdbCache .clear() drops BOTH mem AND cold tiers. The cold
  // (IDB) drop is async — fire-and-forget so the SW handler returns
  // promptly. Worst case the cold tier survives a moment longer; next read
  // re-checks TTL anyway.
  responseCache.clear().catch(() => {});
  conversationSummaryCache.clear().catch(() => {});
  lastDossierExtractTimestamp.clear();
  providerRequestCounts.clear();
  clearPromptModules();
  _storageCache.clear();
  _contextBuilderCache.clear();
  // Don't clear requestTimestamps or backoffUntil — those affect live rate
  // limiting. And `inflightRequests` clears naturally when promises resolve.
  // (v0.57.15: removed assignments to the deleted cachedSystemPrompt/
  // systemPromptHash shims — see the comment near the modular cache above.)
  return { cleared };
}

// 8. Request coalescing — dedupe concurrent identical prompts
const inflightRequests = new Map<string, Promise<string>>();
let totalCoalesced = 0;

/**
 * De-duplicate concurrent identical prompts: if an in-flight call with the same
 * cache key exists, return its promise instead of issuing a second provider
 * request; otherwise call {@link callProvider} and track it until it settles.
 * Logs each coalesced hit.
 * @param config provider config to call with.
 * @param systemPrompt system prompt.
 * @param userPrompt user prompt.
 * @param feature feature tag (priority/routing/keying).
 * @param opts optional temperature/maxTokens/jsonMode overrides.
 * @returns the provider response text.
 * @throws whatever {@link callProvider} throws (propagated to every coalesced
 *         caller sharing the in-flight promise).
 */
async function coalescedCallProvider(
  config: LLMConfig, systemPrompt: string, userPrompt: string,
  feature: string, opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
): Promise<string> {
  const key = getCacheKey(systemPrompt, userPrompt, feature);
  const inflight = inflightRequests.get(key);
  if (inflight) {
    totalCoalesced++;
    console.log(`${LOG} Coalesced request (${feature})`);
    return inflight;
  }
  const promise = callProvider(config, systemPrompt, userPrompt, feature, opts);
  inflightRequests.set(key, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    inflightRequests.delete(key);
  }
}

// 9. Rolling conversation summary — compress old messages into a summary.
//
// v0.57.73: switched from a 500-entry FIFO Map to LruIdbCache (mem 100 /
// cold 600 in IDB, 10-min TTL). Same memory win as the response cache —
// hot tier stays small while cold tier persists across SW restarts so a
// freshly-recycled SW doesn't lose its accumulated summary cache.
const SUMMARY_CACHE_TTL = 10 * 60_000; // 10 min
const conversationSummaryCache = new LruIdbCache<{ summary: string; messageCount: number }>({
  storeName: 'llm-summary',
  maxItems: 100,
  maxItemsTotal: 600,
  ttlMs: SUMMARY_CACHE_TTL,
});

/**
 * Build a token-efficient conversation context: when the thread exceeds the
 * feature's window, prepend a cheap local (no-LLM) summary of the older
 * messages (reusing a cached summary when it still covers roughly the same
 * span) to the recent-window transcript. The summary cache write is
 * fire-and-forget.
 * @param messages full message list.
 * @param contactName inbound speaker label.
 * @param contactId key for the per-contact summary cache.
 * @param feature feature tag selecting the window size.
 * @returns the composed context string (summary + recent transcript).
 */
async function getCompactConversationContext(
  messages: Message[], contactName: string, contactId: string, feature: string,
): Promise<string> {
  const windowSize = CONTEXT_WINDOWS[feature] || 15;

  // If conversation fits in window, no compression needed
  if (messages.length <= windowSize) {
    return buildConversationContext(messages, contactName, feature);
  }

  const recentMessages = messages.slice(-windowSize);
  const olderMessages = messages.slice(0, -windowSize);

  // Check if we have a cached summary for the older messages
  const cached = await conversationSummaryCache.get(contactId);

  // Use cached summary if it covers roughly the same older messages
  // (TTL is enforced inside LruIdbCache.get; we only need the message-count
  //  proximity check here.)
  if (cached && Math.abs(cached.messageCount - olderMessages.length) < 5) {
    return `[Earlier conversation summary: ${cached.summary}]\n\n${renderTranscript(recentMessages, contactName)}`;
  }

  // Generate a local summary of older messages (no LLM call)
  const inCount = olderMessages.filter(m => m.direction === 'in').length;
  const outCount = olderMessages.filter(m => m.direction === 'out').length;
  const topics = extractTopics(olderMessages);
  const summary = `${olderMessages.length} earlier messages (${inCount} from them, ${outCount} from you). Topics: ${topics || 'general chat'}.`;

  // Fire-and-forget cache write — value is already returned below.
  conversationSummaryCache.set(contactId, {
    summary, messageCount: olderMessages.length,
  }).catch(() => {});

  return `[Earlier: ${summary}]\n\n${renderTranscript(recentMessages, contactName)}`;
}

/**
 * Extract the top few recurring hookup/logistics keywords from a message set,
 * for the cheap local conversation summary. Pure — no logging.
 * @param messages messages to scan.
 * @returns a comma-joined list of up to 5 most-frequent matched topics.
 */
function extractTopics(messages: Message[]): string {
  const keywords = new Map<string, number>();
  const topicPatterns = /\b(host|travel|meet|tonight|tomorrow|pics|photo|looking for|top|bottom|vers|fun|chill|hang|hookup|date|drink|place|car|hotel|address|age|height|weight)\b/gi;
  for (const m of messages) {
    const matches = m.body.match(topicPatterns) || [];
    for (const match of matches) {
      const word = match.toLowerCase();
      keywords.set(word, (keywords.get(word) || 0) + 1);
    }
  }
  return [...keywords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word)
    .join(', ');
}

// 10. Priority levels for request queue
type RequestPriority = 'interactive' | 'background' | 'batch';
const PRIORITY_ORDER: Record<RequestPriority, number> = { interactive: 0, background: 1, batch: 2 };

const FEATURE_PRIORITY: Record<string, RequestPriority> = {
  suggestions: 'interactive',
  'auto-respond': 'interactive',
  greeting: 'interactive',
  query: 'interactive',
  nickname: 'background',
  dossier: 'background',
  summary: 'background',
};

// ── Centralized provider call (all LLM requests go through here) ────────────

/**
 * Make an LLM API call through the rate-limited queue with backoff.
 * Returns the raw response text from the provider.
 */
async function callProvider(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
  feature: string,
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
  // Providers already tried in this logical call, for the 429-failover chain
  // below. Without it two rate-limited providers ping-pong forever: A 429s →
  // failover picks B (order skips only the CURRENT provider) → B 429s →
  // failover picks A again, recursing until the stack blows.
  attemptedProviders?: Set<string>,
): Promise<string> {
  totalApiCalls++;

  // Pre-fetch rate settings once — needed for the Anthropic cache-TTL branch
  // below AND cached via the SettingsCache so this is effectively a free
  // in-memory read after the first call.
  const rateSettings = await getLLMRateSettings();

  // Check response cache first (skip for high-temperature creative tasks)
  const temp = opts?.temperature ?? 0.9;
  if (temp < 0.5) { // deterministic tasks can be cached
    const cacheKey = getCacheKey(systemPrompt, userPrompt, feature);
    const cached = await getCachedResponse(cacheKey);
    if (cached) {
      totalCacheHits++;
      totalTokensSaved += estimateTokens(systemPrompt + userPrompt);
      return cached;
    }
  }

  // Use cheapest model for simple tasks
  const routedModel = getModelForTask(config, feature);
  const routedConfig = { ...config, model: routedModel };

  const maxTokens = opts?.maxTokens ?? 256;

  let url: string;
  let init: RequestInit;

  switch (routedConfig.provider) {
    case 'gemini': {
      const model = routedConfig.model || DEFAULT_MODELS.gemini;
      // The key goes in the query string for this provider, so it MUST be
      // percent-encoded — an unencoded '&' or '#' in a pasted key silently
      // truncates it and corrupts the request (model-updater.ts already does
      // this; this call site did not).
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(routedConfig.apiKey)}`;
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(systemPrompt ? { system_instruction: { parts: [{ text: systemPrompt }] } } : {}),
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: temp, maxOutputTokens: maxTokens, ...(opts?.jsonMode ? { responseMimeType: 'application/json' } : {}) },
        }),
      };
      break;
    }
    case 'openai': {
      const model = routedConfig.model || DEFAULT_MODELS.openai;
      url = 'https://api.openai.com/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${routedConfig.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens, ...(opts?.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
      };
      break;
    }
    case 'anthropic': {
      const model = routedConfig.model || DEFAULT_MODELS.anthropic;
      url = 'https://api.anthropic.com/v1/messages';
      // Anthropic prompt caching: cache the system prompt (system here already
      // includes our stable persona/style/tier modules — see buildAutoRespondPrompt).
      // Cached reads are 0.1x base price. TTL is configurable — see
      // LLMRateSettings.anthropicCacheTTL. Default 'short' (5 min) is optimal
      // for burst usage; 'long' (1h) wins for intermittent use patterns.
      const cacheTTL = rateSettings.anthropicCacheTTL === 'long' ? '1h' : undefined;
      const cacheControl: Record<string, any> = { type: 'ephemeral' };
      if (cacheTTL) cacheControl.ttl = cacheTTL;
      const anthropicSystem = systemPrompt ? [
        { type: 'text', text: systemPrompt, cache_control: cacheControl },
      ] : undefined;
      init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': routedConfig.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          // The 1h TTL is gated behind a beta header per Anthropic's docs.
          // Sending it unconditionally is harmless for 5-min requests.
          ...(cacheTTL ? { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } : {}),
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, ...(anthropicSystem ? { system: anthropicSystem } : {}), messages: [{ role: 'user', content: userPrompt }] }),
      };
      break;
    }
    case 'groq': {
      // Groq uses OpenAI-compatible API
      const model = routedConfig.model || DEFAULT_MODELS.groq;
      url = 'https://api.groq.com/openai/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${routedConfig.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'cerebras': {
      // Cerebras Inference — OpenAI-compatible endpoint at api.cerebras.ai.
      // Free tier: 30 RPM, 1M tokens/day, ~2600 tok/s on Llama 4 Scout.
      // Context window is capped at 8192 tokens on the free tier (larger
      // on paid tiers) — keep prompts reasonably sized when routing here.
      const model = routedConfig.model || DEFAULT_MODELS.cerebras;
      url = 'https://api.cerebras.ai/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${routedConfig.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'perplexity': {
      const model = routedConfig.model || DEFAULT_MODELS.perplexity;
      url = 'https://api.perplexity.ai/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${routedConfig.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'mistral': {
      const model = routedConfig.model || DEFAULT_MODELS.mistral;
      url = 'https://api.mistral.ai/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${routedConfig.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'copilot': {
      // GitHub Copilot uses OpenAI-compatible endpoint
      const model = routedConfig.model || DEFAULT_MODELS.copilot;
      url = 'https://api.githubcopilot.com/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${routedConfig.apiKey}`,
          'Editor-Version': 'aggregaytor/0.19.1',
        },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    default:
      throw new Error(`Unknown provider: ${routedConfig.provider}`);
  }

  const res = await queuedFetch(url, init, feature);

  if (!res.ok) {
    // On 429 rate limit, try failover to another provider we haven't already
    // burned in this call chain.
    if (res.status === 429) {
      const attempted = attemptedProviders || new Set<string>();
      attempted.add(routedConfig.provider);
      const failoverConfig = await getConfigWithFailover(routedConfig.provider);
      if (failoverConfig.provider !== routedConfig.provider && !attempted.has(failoverConfig.provider)) {
        console.log(`${LOG} Failing over from ${routedConfig.provider} to ${failoverConfig.provider}`);
        return callProvider(failoverConfig, systemPrompt, userPrompt, feature, opts, attempted);
      }
    }
    const err = await res.text();
    throw new Error(`${routedConfig.provider} ${res.status}: ${err.slice(0, 200)}`);
  }

  // Record this successful request for rate tracking
  recordProviderRequest(routedConfig.provider);

  const data = await res.json();
  let result = '';
  switch (routedConfig.provider) {
    case 'gemini': result = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''; break;
    case 'anthropic': result = data?.content?.[0]?.text || ''; break;
    case 'openai': case 'groq': case 'cerebras': case 'perplexity': case 'mistral': case 'copilot':
      result = data?.choices?.[0]?.message?.content || ''; break;
  }

  // Cache deterministic responses (fire-and-forget — IDB write is async
  // but the response is already returned to the caller).
  if (temp < 0.5 && result) {
    const cacheKey = getCacheKey(systemPrompt, userPrompt, feature);
    setCachedResponse(cacheKey, result, estimateTokens(systemPrompt + userPrompt)).catch(() => {});
  }

  return result;
}

// (Removed: callGemini / callOpenAI / callAnthropic. They were labelled
// "legacy wrappers for backward compatibility" but had no callers left —
// every provider now goes through callProvider() and generateSuggestions()
// builds the same prompt inline.)

// ── Local fallback ──────────────────────────────────────────────────────────

/**
 * Zero-cost, no-API reply suggestions derived from simple pattern matching on
 * the last message. Used when no provider is configured or as a fallback when a
 * provider call fails. Pure — no logging.
 * @param messages conversation messages (only the last drives the heuristics).
 * @returns up to 4 suggested reply strings (never empty).
 */
function localSuggestions(messages: Message[]): string[] {
  const last = messages[messages.length - 1];
  if (!last) return ['Hey, what\'s up?', 'How\'s it going?'];

  const body = (last.body || '').toLowerCase();
  const suggestions: string[] = [];

  if (last.direction === 'in') {
    if (/^(hey|hi|hello|howdy|sup|what'?s up|yo)\b/.test(body)) {
      suggestions.push('Hey! How are you?', "What's up?", "How's your night going?");
    } else if (/\?$/.test(body)) {
      if (/host|place|where|location/.test(body)) {
        suggestions.push('I can host', "Can't host, can you?", 'Let me check');
      } else if (/when|tonight|now|free|available|time/.test(body)) {
        suggestions.push("I'm free now", 'Later tonight works', 'What time works for you?');
      } else {
        suggestions.push('Yeah for sure', 'Let me think about it', 'What about you?');
      }
    } else if (/hot|sexy|cute|handsome|nice/.test(body)) {
      suggestions.push('Thanks! You too', "Appreciate that");
    } else {
      suggestions.push('Nice', 'Tell me more', 'Sounds good');
    }
  } else {
    const age = Date.now() - new Date(last.timestamp).getTime();
    if (age > 30 * 60_000) {
      suggestions.push('Still interested?', 'Let me know if you\'re still around');
    } else {
      suggestions.push('So what do you think?');
    }
  }

  if (suggestions.length < 3) {
    suggestions.push('What are you looking for?', 'Got any pics?');
  }
  return suggestions.slice(0, 4);
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Produce reply suggestions for a conversation: builds the context-aware
 * system prompt, calls the best available provider (coalesced), and falls back
 * to {@link localSuggestions} when disabled, keyless, or on error. Expected
 * disabled/rate-limited states log at info level; real failures log as errors.
 * @param messages conversation history.
 * @param contactName display name of the other party.
 * @param platform platform the chat is on.
 * @param contactId optional contact id enabling per-contact dossier context.
 * @returns suggestions plus the provider that produced them (and any error).
 */
export async function generateSuggestions(
  messages: Message[],
  contactName: string,
  platform: string,
  contactId?: string,
): Promise<SuggestionResult> {
  const config = await getBestProvider();

  // v0.57.63: short-circuit when the user has disabled the suggestions
  // LLM feature. Same rationale as generateAutoResponse — don't burn the
  // prompt-build work just to throw inside callProvider's feature gate.
  const rateSettings = await getLLMRateSettings();
  if (!rateSettings.enableSuggestions) {
    return { suggestions: localSuggestions(messages), provider: 'local' };
  }

  const systemPrompt = await buildSystemPromptWithContext(contactName, platform, contactId);
  const conversation = buildConversationContext(messages, contactName, "suggestions");

  console.log(`${LOG} Generating suggestions via ${config.provider} (${messages.length} msgs, ~${estimateTokens(systemPrompt + conversation)} tokens)`);

  if (config.provider === 'local' || !config.apiKey) {
    return { suggestions: localSuggestions(messages), provider: 'local' };
  }

  try {
    const text = await coalescedCallProvider(config, systemPrompt,
      `Here is the conversation:\n\n${conversation}\n\nGenerate 3-4 suggested responses as a JSON array of strings.`,
      'suggestions', { jsonMode: true });
    let suggestions = parseJsonArray(text);
    if (!suggestions.length) {
      suggestions = localSuggestions(messages);
    }
    console.log(`${LOG} Got ${suggestions.length} suggestions from ${config.provider}`);
    return { suggestions, provider: config.provider };
  } catch (err) {
    // v0.57.63: don't error-log expected disabled/rate-limited states.
    const msg = (err as Error)?.message || String(err);
    if (/feature '[^']+' is disabled|Rate limited/.test(msg)) {
      console.log(`${LOG} Suggestions skipped: ${msg}`);
    } else {
      console.error(`${LOG} ${config.provider} failed, falling back to local:`, err);
    }
    return {
      suggestions: localSuggestions(messages),
      provider: 'local',
      error: msg,
    };
  }
}

// ── Auto-respond with escalation tiers ──────────────────────────────────────

export interface AutoRespondSettings {
  aggressiveness?: 'chill' | 'normal' | 'eager';
  preferredTime?: string;
  preferredPlace?: string;
  timeFlexibility?: 'firm' | 'flexible' | 'open';
  placeFlexibility?: 'firm' | 'flexible' | 'open';
  allowPictures?: boolean;
  pictureTagsAllowed?: string[];
}

const AGGRESSIVENESS_PROMPTS: Record<string, string> = {
  chill: 'Be laid-back and casual. Do not push to meet up or suggest times/places. Let them lead the conversation. Keep it light.',
  normal: 'Be direct but not pushy. Express interest naturally. If the conversation is going well, you can mention wanting to meet but do not push hard.',
  eager: 'Be enthusiastic and proactive. If the conversation is flowing well, suggest meeting up. Propose times and show clear interest.',
};

// ── Modular prompt composition ──────────────────────────────────────────────
//
// Prompts are built from independent, individually-cached string modules.
// Each module is:
//   - byte-stable across thousands of requests when inputs haven't changed,
//     which maximises provider-side prompt-cache hit rates (Anthropic
//     ephemeral, OpenAI automatic, Gemini context caching)
//   - cheap to recompute when inputs DO change, since only the affected
//     module is regenerated
//   - composed à la carte per feature — a nickname task pulls only
//     `persona`, while an auto-respond pulls persona + style + tier rules
//     + logistics + task format.
//
// Previously `buildAutoRespondPrompt` emitted one monolithic string mixing
// all of these; any settings change invalidated the whole prefix and forced
// the provider to re-process every token. See the commentary on modular
// prompts in the caching audit for full rationale.

/** Cache of computed module strings keyed by a stable hash of their inputs. */
const _promptModuleCache = new Map<string, string>();
const PROMPT_MODULE_CACHE_CAP = 100;

/**
 * Store a computed prompt-module string under `key`, evicting the oldest entry
 * (FIFO) once the module cache exceeds its cap, and return the value for
 * convenient inline use. Pure bookkeeping — no logging.
 * @param key stable hash key for the module inputs.
 * @param value the computed module string.
 * @returns `value` unchanged.
 */
function cachePromptModule(key: string, value: string): string {
  _promptModuleCache.set(key, value);
  if (_promptModuleCache.size > PROMPT_MODULE_CACHE_CAP) {
    const iter = _promptModuleCache.keys();
    const next = iter.next();
    if (!next.done) _promptModuleCache.delete(next.value);
  }
  return value;
}

/** Tier classification rules — fully static, cached forever (until
 *  extension reload). Kept as a separate module so provider-side caches
 *  retain the biggest prefix chunk across every auto-respond call. */
const TIER_RULES_MODULE = `CRITICAL: You MUST return a JSON object with these fields:
{
  "response": "your message text here",
  "tier": "low" | "medium" | "high",
  "reason": "why you chose this tier",
  "sendPicture": null or { "tag": "face" | "body" | "other" }
}

TIER CLASSIFICATION:
- "low": Safe to auto-send. Greetings, small talk, compliments, "wbu?", casual chat. NO logistics.
- "medium": Needs user review. Suggesting a TIME ("tonight?", "8pm?"), mentioning a general AREA ("I'm near uptown"), asking about availability.
- "high": NEVER auto-send. Specific ADDRESSES, "come over", "on my way", phone numbers, exact meetup locations, confirming plans.

When in doubt, classify as "medium". Any response involving time, place, or meeting plans is AT LEAST "medium".

Return ONLY the JSON object, nothing else.`;

/** Suggestions JSON-schema reminder — also fully static. */
const SUGGESTIONS_FORMAT_MODULE = `Rules:
- Keep responses short (1-2 sentences max)
- Match the conversation tone and flow
- If they asked a question, at least one suggestion should answer it
- Return ONLY a JSON array of strings, no other text

Example output: ["Hey, sounds good! When works for you?", "I'm free tonight", "What area are you in?"]`;

/** Persona module: preset + custom instructions. Cached by a hash of the
 *  personality settings since those only change when the user hits Save. */
async function personaModule(): Promise<string> {
  const personality = await getPersonalitySettings();
  const presetPrompt = PERSONALITY_PRESETS[personality.preset]?.prompt || PERSONALITY_PRESETS.direct.prompt;
  const customHash = personality.customInstructions
    ? `c${personality.customInstructions.length}:${personality.customInstructions.slice(0, 30)}`
    : 'c0';
  const key = `persona:${personality.preset}:${customHash}`;
  const hit = _promptModuleCache.get(key);
  if (hit) return hit;
  let out = `PERSONALITY: ${presetPrompt}`;
  if (personality.customInstructions) {
    out += `\n\nCUSTOM INSTRUCTIONS (follow strictly):\n${personality.customInstructions}`;
  }
  return cachePromptModule(key, out);
}

/** Writing-style module: derived style guide. Cached on the guide's
 *  updated-at timestamp so DERIVE_STYLE_GUIDE refreshes it exactly once. */
async function writingStyleModule(): Promise<string> {
  const personality = await getPersonalitySettings();
  if (!personality.styleGuide) return '';
  const key = `style:${personality.styleGuideUpdatedAt || 'initial'}:${personality.styleGuide.length}`;
  const hit = _promptModuleCache.get(key);
  if (hit) return hit;
  return cachePromptModule(key, `WRITING STYLE:\n${personality.styleGuide}`);
}

/** Contact context module — per-contact dossier slice. Only includes the
 *  categories the task needs (see `FEATURE_DOSSIER_CATEGORIES`). Cached by
 *  contactId+category-hash+dossier-updatedAt so auto-extracted fields flow
 *  through on the next call after extraction. */
async function contactContextModule(
  contactId: string,
  categories: DossierCategory[],
): Promise<string> {
  if (!contactId || !categories.length) return '';
  const catKey = categories.slice().sort().join(',');
  // Cheap freshness check — if the dossier doc's updatedAt hasn't advanced
  // we can skip the slice + format work entirely.
  try {
    const doc = await getDossier(contactId);
    if (!doc) return '';
    const cacheKey = `ctx:${contactId}:${catKey}:${doc.updatedAt || ''}`;
    const hit = _promptModuleCache.get(cacheKey);
    if (hit !== undefined) return hit;
    const slice = await getDossierSlice(contactId, categories);
    const body = formatDossierContext(slice);
    if (!body) return cachePromptModule(cacheKey, '');
    return cachePromptModule(cacheKey, `WHAT WE KNOW ABOUT THEM:\n${body}`);
  } catch (err) {
    // Dossier read/format failed — degrade gracefully to no contact context
    // (the prompt is still valid without it). Warn, don't error: a missing
    // dossier is non-fatal and shouldn't surface in the rolling error log.
    console.warn(`${LOG} contact context skipped for ${contactId}:`, (err as Error)?.message || err);
    return '';
  }
}

/** Per-feature dossier category routing — mirrors FEATURE_MODULES in spirit.
 *  Kept narrow: tasks that don't need a field simply don't get it. */
const FEATURE_DOSSIER_CATEGORIES: Record<string, DossierCategory[]> = {
  suggestions:    ['identity', 'profile', 'logistics'],
  'auto-respond': ['identity', 'profile', 'logistics', 'meetings', 'trust'],
  summary:        ['identity', 'meetings', 'relationship', 'trust'],
  nickname:       ['profile'],
  dossier:        [],  // dossier extraction builds the dossier — no recursion
  greeting:       [],  // platform-agnostic greeting; no per-contact context
};

/** Aggressiveness module — 3 static variants. Cache-key is just the variant
 *  name since the body is a constant. */
function aggressivenessModule(aggressiveness?: string): string {
  const key = `agg:${aggressiveness || 'normal'}`;
  const hit = _promptModuleCache.get(key);
  if (hit) return hit;
  const body = AGGRESSIVENESS_PROMPTS[aggressiveness || 'normal'] || AGGRESSIVENESS_PROMPTS.normal;
  return cachePromptModule(key, `TONE: ${body}`);
}

/** Logistics module — optional time/place/picture prefs. */
function logisticsModule(settings?: AutoRespondSettings): string {
  if (!settings) return '';
  const parts: string[] = [];
  if (settings.preferredTime) parts.push(`User's preferred time: "${settings.preferredTime}" (flexibility: ${settings.timeFlexibility || 'flexible'})`);
  if (settings.preferredPlace) parts.push(`User's preferred place: "${settings.preferredPlace}" (flexibility: ${settings.placeFlexibility || 'flexible'})`);
  if (settings.allowPictures) {
    parts.push(`User allows sending pictures tagged: ${(settings.pictureTagsAllowed || []).join(', ') || 'any'}. If appropriate, include "sendPicture" in your response.`);
  }
  if (!parts.length) return '';
  // Cache-key: stringified settings slice — cheap, bounded input
  const key = `logistics:${settings.preferredTime || ''}|${settings.timeFlexibility || ''}|${settings.preferredPlace || ''}|${settings.placeFlexibility || ''}|${settings.allowPictures ? '1' : '0'}|${(settings.pictureTagsAllowed || []).join(',')}`;
  const hit = _promptModuleCache.get(key);
  if (hit) return hit;
  return cachePromptModule(key, parts.join('\n'));
}

/** Clear all prompt-module caches — called from clearLLMCaches(). */
function clearPromptModules(): void {
  _promptModuleCache.clear();
}

/**
 * Compose the auto-respond system prompt from independently-cached modules.
 *
 * The assembly order is deliberate: static prefix modules first (so
 * provider-side prompt caching gets maximum reuse), variable per-request
 * modules last.
 */
async function buildAutoRespondPrompt(
  contactName: string,
  platform: string,
  settings?: AutoRespondSettings,
  contactId?: string,
): Promise<string> {
  const [persona, style, contactCtx] = await Promise.all([
    personaModule(),
    writingStyleModule(),
    contactId
      ? contactContextModule(contactId, FEATURE_DOSSIER_CATEGORIES['auto-respond'])
      : Promise.resolve(''),
  ]);
  const agg = aggressivenessModule(settings?.aggressiveness);
  const logistics = logisticsModule(settings);

  const sections: string[] = [
    // Static-ish prefix — great for prompt caching
    `You are composing a response in a dating/hookup chat on ${platform}. You ARE the user — write a single response, not options.`,
    persona,
    agg,
  ];
  if (logistics) sections.push(logistics);
  if (style) sections.push(style);
  if (contactCtx) sections.push(contactCtx);
  sections.push(`Keep it short (1-2 sentences). Be direct and confident.`);
  sections.push(TIER_RULES_MODULE);

  return sections.join('\n\n');
}

// (Removed: buildGreetingPrompt. generateGreeting() built this string and then
// threw it away — it delegates to generateAutoResponse() with an empty message
// list, which composes its own prompt. The dead builder made it look as though
// greetings had a dedicated prompt when they never did.)

export interface AutoRespondResult {
  response: string;
  tier: 'low' | 'medium' | 'high';
  reason: string;
  sendPicture: { tag: string } | null;
  provider: LLMProvider;
  error?: string;
}

/**
 * Generate a single auto-reply plus a safety tier (low/medium/high) governing
 * whether it may be auto-sent. Short-circuits to a local reply when
 * auto-respond is disabled, keyless, or the provider errors; expected
 * disabled/rate-limited states log at info level, real failures as errors.
 * @param messages conversation history.
 * @param contactName the other party's display name.
 * @param platform platform the chat is on.
 * @param settings optional aggressiveness/logistics/picture preferences.
 * @param contactId optional contact id enabling per-contact dossier context.
 * @returns the response, its tier/reason, any picture suggestion, and provider.
 */
export async function generateAutoResponse(
  messages: Message[],
  contactName: string,
  platform: string,
  settings?: AutoRespondSettings,
  contactId?: string,
): Promise<AutoRespondResult> {
  const config = await getBestProvider();

  // v0.57.63: short-circuit when the user has unchecked "auto-respond" in
  // Settings → AI rate limits. Previously we'd build the full prompt, fire
  // the call, get rejected by callProvider's feature gate, and then log
  // `[Aggregaytor:LLM] Auto-respond failed: feature 'auto-respond' is
  // disabled` as a console.error — which the rolling error log captures and
  // surfaces as a real-looking bug. Disabled is a configured state, not a
  // fault. Returning the local fallback silently here keeps the error log
  // clean and saves the prompt-build work for nothing.
  const rateSettings = await getLLMRateSettings();
  if (!rateSettings.enableAutoRespond) {
    const suggestions = localSuggestions(messages);
    return {
      response: suggestions[0] || 'Hey',
      tier: 'low',
      reason: 'auto-respond disabled in settings',
      sendPicture: null,
      provider: 'local',
    };
  }

  const systemPrompt = await buildAutoRespondPrompt(contactName, platform, settings, contactId);
  const conversation = buildConversationContext(messages, contactName, "auto-respond");
  const userPrompt = `Here is the conversation:\n\n${conversation}\n\nGenerate your JSON response:`;

  console.log(`${LOG} Auto-responding via ${config.provider} (${messages.length} messages, ${settings?.aggressiveness || 'normal'})`);

  if (config.provider === 'local' || !config.apiKey) {
    const suggestions = localSuggestions(messages);
    return { response: suggestions[0] || 'Hey', tier: 'low', reason: 'local fallback', sendPicture: null, provider: 'local' };
  }

  try {
    let text: string;
    if (config.provider === 'local') {
      text = localSuggestions(messages)[0] || 'Hey';
    } else {
      text = (await callProvider(config, systemPrompt, userPrompt, 'auto-respond', { maxTokens: 128 })).trim();
    }

    // Parse the JSON response to extract tier + picture suggestion
    const parsed = parseAutoRespondJson(text);
    console.log(`${LOG} Auto-response: tier=${parsed.tier}, response="${parsed.response.slice(0, 50)}..."`);
    return { ...parsed, provider: config.provider };
  } catch (err) {
    // v0.57.63: distinguish expected configuration states (feature disabled,
    // rate-limited background request) from real failures. The former are
    // user-controlled toggles, not bugs — log at info level so they don't
    // pollute the rolling error log. Real network/parse errors still
    // console.error as before so the user can spot them.
    const msg = (err as Error)?.message || String(err);
    if (/feature '[^']+' is disabled|Rate limited/.test(msg)) {
      console.log(`${LOG} Auto-respond skipped: ${msg}`);
    } else {
      console.error(`${LOG} Auto-respond failed:`, err);
    }
    return {
      response: localSuggestions(messages)[0] || 'Hey',
      tier: 'low',
      reason: 'fallback',
      sendPicture: null,
      provider: 'local',
      error: msg,
    };
  }
}

/**
 * Parse the model's auto-respond JSON into a validated result, tolerating
 * non-JSON output by falling back to plain text with a conservative,
 * keyword-based tier classification. Untrusted-input safe: the `JSON.parse` is
 * guarded and every field is coerced/whitelisted. No logging (a non-JSON
 * completion is an expected model quirk, not a fault).
 * @param text raw model output.
 * @returns `{ response, tier, reason, sendPicture }` with a safe default tier.
 */
function parseAutoRespondJson(text: string): { response: string; tier: 'low' | 'medium' | 'high'; reason: string; sendPicture: { tag: string } | null } {
  try {
    const parsed = JSON.parse(text);
    return {
      response: String(parsed.response || text).replace(/^["']|["']$/g, '').trim(),
      tier: ['low', 'medium', 'high'].includes(parsed.tier) ? parsed.tier : 'medium',
      reason: String(parsed.reason || ''),
      sendPicture: parsed.sendPicture && parsed.sendPicture.tag ? parsed.sendPicture : null,
    };
  } catch {
    // Not JSON — treat as plain text response, classify conservatively
    const lower = text.toLowerCase();
    let tier: 'low' | 'medium' | 'high' = 'low';
    if (/come over|my place|your place|address|on my way|omw|meet at|meet me/i.test(lower)) tier = 'high';
    else if (/tonight|tomorrow|\d+\s*(am|pm)|when.*free|what time|this week/i.test(lower)) tier = 'medium';
    return { response: text.replace(/^["']|["']$/g, '').trim(), tier, reason: 'auto-classified', sendPicture: null };
  }
}

/**
 * Produce an opening greeting for a brand-new contact by reusing the
 * auto-respond path with an empty conversation. Falls back to a canned,
 * time-of-day-appropriate line when keyless, degenerate, or on error.
 * @param platform platform the greeting is for.
 * @returns an {@link AutoRespondResult} (always tier `low`).
 */
export async function generateGreeting(
  platform: string,
): Promise<AutoRespondResult> {
  const config = await getBestProvider();

  if (config.provider === 'local' || !config.apiKey) {
    const hour = new Date().getHours();
    const greetings = hour < 12
      ? ['Good morning!', 'Morning, how are you?']
      : hour < 17
      ? ['Hey, how\'s your afternoon?', 'Hey there']
      : ['Hey, how\'s your evening going?', 'What\'s up tonight?'];
    return { response: greetings[Math.floor(Math.random() * greetings.length)], tier: 'low', reason: 'greeting', sendPicture: null, provider: 'local' };
  }

  try {
    // Reuse the auto-respond path with no conversation context
    const result = await generateAutoResponse(
      [],
      'someone new',
      platform,
    );
    // Guard against a degenerate/empty completion — fall back to a canned line.
    if (result.response.length < 3) {
      return { response: 'Hey, how\'s it going?', tier: 'low', reason: 'greeting', sendPicture: null, provider: 'local' };
    }
    return result;
  } catch (err) {
    // generateAutoResponse already handles its own provider errors, so
    // reaching here is unexpected — warn (not error) and serve a canned line.
    console.warn(`${LOG} Greeting generation failed, using canned line:`, (err as Error)?.message || err);
    return { response: 'Hey, how\'s it going?', tier: 'low', reason: 'greeting fallback', sendPicture: null, provider: 'local' };
  }
}

// ── Nickname generation ──────────────────────────────────────────────────────

/**
 * Generate a short descriptive nickname for a contact from their profile
 * metadata + last message. Falls back to a locally-composed descriptor when
 * keyless, disabled, or on provider error (nicknames are trivial/economy tier).
 * @param metadata profile fields (body, position, age, ethnicity, ...).
 * @param lastMessageBody the contact's most recent message (context clue).
 * @param platform platform, used in the fallback label.
 * @returns a nickname string (never empty).
 */
export async function generateNickname(
  metadata: Record<string, unknown>,
  lastMessageBody: string,
  platform: string,
): Promise<string> {
  const config = await getBestProvider();

  // Build context clues
  const clues: string[] = [];
  if (metadata.bodyType || metadata.body) clues.push(`Body: ${metadata.bodyType || metadata.body}`);
  if (metadata.attitude || metadata.position) clues.push(`Position: ${metadata.attitude || metadata.position}`);
  if (metadata.age) clues.push(`Age: ${metadata.age}`);
  if (metadata.ethnicity) clues.push(`Ethnicity: ${metadata.ethnicity}`);
  if (lastMessageBody) clues.push(`Last message: "${lastMessageBody.slice(0, 60)}"`);

  // v0.57.63: short-circuit when nicknames are disabled. The local
  // descriptive nickname builder below is the same one used for the
  // 'local' provider — wired up here too so disabled-feature throws
  // don't reach the rolling error log.
  const rateSettings = await getLLMRateSettings();
  const nicknamesDisabled = !rateSettings.enableNicknames;

  if (config.provider === 'local' || !config.apiKey || nicknamesDisabled) {
    // Generate a simple descriptive nickname locally
    const parts: string[] = [];
    if (metadata.bodyType || metadata.body) parts.push(String(metadata.bodyType || metadata.body));
    if (metadata.attitude || metadata.position) parts.push(String(metadata.attitude || metadata.position));
    if (parts.length) return parts.join(' ').replace(/\b\w/g, c => c.toUpperCase());
    return `${platform.charAt(0).toUpperCase() + platform.slice(1)} Guy`;
  }

  const prompt = `Generate a SHORT, descriptive, memorable nickname (2-3 words max) for a person on ${platform} based on these clues:
${clues.join('\n')}

The nickname should be friendly, descriptive, and help identify this person at a glance.
Examples: "Athletic Top", "Chill Bear", "Uptown Jock", "Night Owl", "Tatted Muscle"
Return ONLY the nickname, nothing else.`;

  try {
    const text = await callProvider(config, '', prompt, 'nickname', { temperature: 1.0, maxTokens: 20 });
    return text.replace(/^["']|["']$/g, '').trim().slice(0, 30) || `${platform} Guy`;
  } catch (err) {
    // Provider fetch failed — nicknames are cosmetic, so degrade to a generic
    // label. Warn (not error) so this expected fallback stays out of the
    // rolling error log, consistent with the other feature paths.
    console.warn(`${LOG} Nickname generation failed, using generic label:`, (err as Error)?.message || err);
    return `${platform.charAt(0).toUpperCase() + platform.slice(1)} Guy`;
  }
}

// ── Dossier auto-extraction ─────────────────────────────────────────────────

/**
 * Extract new personal/profile fields the contact revealed in conversation,
 * via the LLM in JSON mode, returning only fields with fresh values. Falls back
 * to the regex-based {@link localDossierExtraction} when keyless, disabled, or
 * on error; a non-JSON completion logs a preview and yields no fields.
 * @param messages conversation history (recent window is analyzed).
 * @param contactName the other party's name (whose info to extract).
 * @param existingDossier already-known fields, shown to the model to dedupe.
 * @returns a `{ field: value }` map of newly-found info (possibly empty).
 */
export async function extractDossierFields(
  messages: Message[],
  contactName: string,
  existingDossier: Record<string, unknown>,
): Promise<Record<string, string>> {
  const config = await getBestProvider();
  if (config.provider === 'local' || !config.apiKey) {
    return localDossierExtraction(messages);
  }

  // v0.57.63: short-circuit when dossier extraction is disabled — fall
  // back to the regex-based local extractor instead of throwing inside
  // callProvider's feature gate and surfacing a noisy error log entry.
  const rateSettings = await getLLMRateSettings();
  if (!rateSettings.enableDossierExtract) {
    return localDossierExtraction(messages);
  }

  const recent = messages.slice(-50);
  const conversation = recent.map(m =>
    `${m.direction === 'out' ? 'You' : contactName}: ${m.body}`
  ).join('\n');

  const alreadyKnown = Object.entries(existingDossier)
    .filter(([k, v]) => v && typeof v === 'string' && v.length > 0 && k !== 'docType' && k !== '_id')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const prompt = `Analyze this conversation and extract any personal information mentioned by "${contactName}" (the other person, NOT "You").

Already known:
${alreadyKnown || 'Nothing yet'}

Conversation:
${conversation}

Extract ANY of these fields IF they are mentioned or can be inferred from what ${contactName} said:
- realName: their actual name
- birthYear: year born or age (convert to year)
- phone: phone number
- address: where they live (any specificity)
- hometown: where they're from originally
- employer: where they work or what they do
- schedule: when they're free/busy
- relationshipStatus: single, partnered, married, etc.
- partnerNames: names of partners
- position: sexual position preference
- kinks: any mentioned kinks/preferences
- hasTransportation: can they drive/get there
- isInHotel: are they staying in a hotel
- hasDog: do they have a dog or pets
- isRealOrBot: any signs of being a bot (scripted responses, no specifics, too generic)

Return ONLY a JSON object with the fields you found new info for. Omit fields with no new info. Example: {"realName":"Mike","position":"vers top","hasTransportation":"true"}`;

  try {
    const text = await callProvider(config, '', prompt, 'dossier', { temperature: 0.2, maxTokens: 512, jsonMode: true });
    try {
      const parsed = JSON.parse(text);
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && v !== undefined && String(v).trim()) {
          result[k] = String(v).trim();
        }
      }
      console.log(`${LOG} Dossier extraction found ${Object.keys(result).length} fields`);
      return result;
    } catch (parseErr) {
      // LLM returned non-JSON — log a short preview so repeated failures
      // stand out instead of being silently dropped. Common causes: model
      // wrapped the JSON in a markdown code fence, or returned prose.
      console.warn(`${LOG} Dossier JSON parse failed (${(parseErr as Error).message}): "${text.slice(0, 80).replace(/\n/g, ' ')}..."`);
      return {};
    }
  } catch (err) {
    // v0.57.63: don't error-log expected disabled/rate-limited states.
    const msg = (err as Error)?.message || String(err);
    if (/feature '[^']+' is disabled|Rate limited/.test(msg)) {
      console.log(`${LOG} Dossier extraction skipped: ${msg}`);
    } else {
      console.error(`${LOG} Dossier extraction failed:`, err);
    }
    return localDossierExtraction(messages);
  }
}

/**
 * Regex-based, no-API dossier extraction over inbound messages — the fallback
 * for {@link extractDossierFields}. Pulls phone, age/birth-year, position,
 * hosting/transport, and name when clearly stated. Pure — no logging.
 * @param messages conversation messages (only inbound are scanned).
 * @returns a `{ field: value }` map of confidently-matched fields (possibly empty).
 */
export function localDossierExtraction(messages: Message[]): Record<string, string> {
  const result: Record<string, string> = {};
  const inbound = messages.filter(m => m.direction === 'in').map(m => m.body.toLowerCase());
  const allText = inbound.join(' ');

  // Phone number
  const phoneMatch = allText.match(/\b(\d{3}[-.]?\d{3}[-.]?\d{4})\b/);
  if (phoneMatch) result.phone = phoneMatch[1];

  // Age/birth year
  const ageMatch = allText.match(/\bi(?:'m|m)\s+(\d{2})\b/) || allText.match(/\b(\d{2})\s*(?:yo|y\/o|years?\s*old)\b/);
  if (ageMatch) result.birthYear = String(new Date().getFullYear() - parseInt(ageMatch[1]));

  // Position
  if (/\b(top|bottom|vers|versatile|side)\b/i.test(allText)) {
    const match = allText.match(/\b(vers top|vers bottom|power bottom|top|bottom|vers|versatile|side)\b/i);
    if (match) result.position = match[1];
  }

  // Hosting/transportation
  if (/\bcan host\b/i.test(allText)) result.hasTransportation = 'true';
  if (/\bcan'?t host\b/i.test(allText) || /\bno car\b/i.test(allText)) result.hasTransportation = 'false';
  if (/\bhotel\b/i.test(allText)) result.isInHotel = 'true';

  // Name
  const nameMatch = allText.match(/\b(?:my name(?:'s| is))\s+([A-Z][a-z]+)\b/i) || allText.match(/\b(?:i'm|im|i am)\s+([A-Z][a-z]{2,})\b/);
  if (nameMatch) result.realName = nameMatch[1];

  return result;
}

// ── Conversation summary ────────────────────────────────────────────────────

/**
 * Summarize a conversation's state and extract any agreed commitments via the
 * LLM in JSON mode. Falls back to {@link localSummary} when keyless, disabled,
 * or on error; a non-JSON completion degrades to a truncated text summary.
 * Expected disabled/rate-limited states log at info level, real failures as errors.
 * @param messages conversation history.
 * @param contactName the other party's name.
 * @param platform platform the chat is on.
 * @returns `{ text, commitments }` summary of the conversation.
 */
export async function generateConversationSummary(
  messages: Message[],
  contactName: string,
  platform: string,
): Promise<{ text: string; commitments: string[] }> {
  const config = await getBestProvider();
  if (config.provider === 'local' || !config.apiKey) {
    return localSummary(messages);
  }

  // v0.57.63: short-circuit when summaries are disabled. Local fallback
  // still gives a useful word-count summary so the UI isn't blank.
  const rateSettings = await getLLMRateSettings();
  if (!rateSettings.enableSummaries) {
    return localSummary(messages);
  }

  const conversation = buildConversationContext(messages, contactName, "summary");
  const prompt = `Analyze this ${platform} conversation and return a JSON object:
{
  "text": "2-3 sentence summary of the conversation state, tone, and what they want",
  "commitments": ["list of any agreed times, places, or action items"],
  "likelyOutcome": "one sentence prediction of where this is heading"
}

Conversation:
${conversation}

Return ONLY the JSON object.`;

  try {
    const text = await callProvider(config, '', prompt, 'summary', { temperature: 0.3, maxTokens: 256, jsonMode: true });
    try {
      const parsed = JSON.parse(text);
      return {
        text: String(parsed.text || parsed.summary || ''),
        commitments: Array.isArray(parsed.commitments) ? parsed.commitments.map(String) : [],
      };
    } catch {
      return { text: text.slice(0, 200), commitments: [] };
    }
  } catch (err) {
    // v0.57.63: don't error-log expected disabled/rate-limited states.
    const msg = (err as Error)?.message || String(err);
    if (/feature '[^']+' is disabled|Rate limited/.test(msg)) {
      console.log(`${LOG} Summary generation skipped: ${msg}`);
    } else {
      console.error(`${LOG} Summary generation failed:`, err);
    }
    return localSummary(messages);
  }
}

/**
 * No-API conversation summary: message counts, last-message preview, and a
 * regex sweep for logistics commitments. Fallback for
 * {@link generateConversationSummary}. Pure — no logging.
 * @param messages conversation messages.
 * @returns `{ text, commitments }` derived locally.
 */
function localSummary(messages: Message[]): { text: string; commitments: string[] } {
  if (!messages.length) return { text: 'No conversation yet.', commitments: [] };
  const inbound = messages.filter(m => m.direction === 'in');
  const outbound = messages.filter(m => m.direction === 'out');
  const last = messages[messages.length - 1];
  const parts = [`${messages.length} messages exchanged (${inbound.length} from them, ${outbound.length} from you).`];
  if (last) parts.push(`Last message was ${last.direction === 'in' ? 'from them' : 'from you'}: "${last.body.slice(0, 50)}..."`);

  const commitments: string[] = [];
  for (const m of messages.slice(-10)) {
    if (/tonight|tomorrow|\d+\s*(am|pm)|meet|come over|my place|your place/i.test(m.body)) {
      commitments.push(m.body.slice(0, 80));
    }
  }

  return { text: parts.join(' '), commitments };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Best-effort parse of a model completion into a string array, tolerating
 * OpenAI json_object wrapping and prose-embedded arrays. Untrusted-input safe:
 * both `JSON.parse` attempts are guarded and non-string members are filtered.
 * @param text raw model output.
 * @returns the parsed string array, or a small canned default if unparseable.
 */
function parseJsonArray(text: string): string[] {
  try {
    // Try direct parse
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(s => typeof s === 'string');
    // OpenAI json_object mode wraps in an object
    if (parsed?.suggestions) return parsed.suggestions.filter((s: any) => typeof s === 'string');
    if (parsed?.responses) return parsed.responses.filter((s: any) => typeof s === 'string');
    // Try to find array in values
    for (const val of Object.values(parsed)) {
      if (Array.isArray(val)) return (val as any[]).filter(s => typeof s === 'string');
    }
  } catch {
    // Try to extract JSON array from text
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) return arr.filter(s => typeof s === 'string');
      } catch { /* ignore */ }
    }
  }
  return ['Sure', 'Sounds good', 'What do you think?'];
}

// ── Natural-language contact query ────────────────────────────────────────

/** Compact contact summary passed from the service worker to the LLM query. */
export interface ContactQueryRow {
  id: string;
  name: string;
  platform: string;
  position?: string;
  bodyType?: string;
  age?: string;
  ethnicity?: string;
  height?: string;
  distance?: string;
  lastMessageAt?: string;
  messageCount?: number;
  unreadCount?: number;
  bookmarked?: boolean;
  favorited?: boolean;
  rating?: number;
  archived?: boolean;
  hidden?: boolean;
  preferenceScore?: number | null;
  sentiment?: number | null;
  tags?: string[];
  notes?: string;
  ghostCount?: number;
  metInPerson?: boolean;
  kinks?: string[];
  bio?: string;
}

export interface QueryContactsResult {
  matches: { contactId: string; reason: string }[];
  explanation: string;
  provider: LLMProvider;
  error?: string;
}

/**
 * Use an LLM to answer a natural-language query over the user's contact list.
 *
 * The caller (service worker) assembles ContactQueryRow[] from PouchDB —
 * this function formats them into a compact prompt, calls the LLM, and
 * returns ranked contact IDs with per-match reasoning.
 */
export async function queryContacts(
  query: string,
  contacts: ContactQueryRow[],
  limit: number = 10,
): Promise<QueryContactsResult> {
  const config = await getBestProvider();
  if (config.provider === 'local' || !config.apiKey) {
    return { matches: [], explanation: 'No LLM provider configured. Set an API key in Settings → AI.', provider: 'local' };
  }

  // Build compact contact table for the prompt (one line per contact)
  const rows = contacts.map((c, i) => {
    const parts: string[] = [`#${i} "${c.name}" (${c.platform})`];
    const attrs: string[] = [];
    if (c.position) attrs.push(c.position);
    if (c.bodyType) attrs.push(c.bodyType);
    if (c.age) attrs.push(`age:${c.age}`);
    if (c.ethnicity) attrs.push(c.ethnicity);
    if (c.height) attrs.push(c.height);
    if (c.distance) attrs.push(c.distance);
    if (attrs.length) parts.push(attrs.join(', '));

    const flags: string[] = [];
    if (c.lastMessageAt) {
      const ago = timeSince(c.lastMessageAt);
      flags.push(`last msg: ${ago}`);
    } else {
      flags.push('never talked');
    }
    if (c.messageCount) flags.push(`${c.messageCount} msgs`);
    if (c.unreadCount) flags.push(`${c.unreadCount} unread`);
    if (c.bookmarked) flags.push('bookmarked');
    if (c.favorited) flags.push('favorited');
    if (c.rating) flags.push(`${c.rating}★`);
    if (c.metInPerson) flags.push('met IRL');
    if (c.ghostCount && c.ghostCount > 0) flags.push(`ghosted ${c.ghostCount}x`);
    if (c.preferenceScore != null) flags.push(`pref:${Math.round(c.preferenceScore * 100)}%`);
    if (c.sentiment != null) flags.push(`interest:${Math.round(c.sentiment * 100)}%`);
    if (c.archived) flags.push('archived');
    if (c.hidden) flags.push('hidden');
    if (c.tags?.length) flags.push(`tags:[${c.tags.join(',')}]`);
    if (flags.length) parts.push(flags.join(' | '));

    if (c.notes) parts.push(`notes: ${c.notes.slice(0, 60)}`);
    if (c.kinks?.length) parts.push(`into: ${c.kinks.join(', ')}`);
    if (c.bio) parts.push(`bio: ${c.bio.slice(0, 80)}`);

    return parts.join(' | ');
  });

  const persona = await personaModule();

  const systemPrompt = [
    'You are an assistant helping the user search and filter their dating/hookup contacts.',
    'The user has a database of profiles from multiple platforms (Grindr, Sniffies, Adam4Adam, etc.).',
    'Answer the query by selecting the most relevant contacts from the list below.',
    persona,
  ].join('\n\n');

  const userPrompt = `CONTACTS (${contacts.length} total):
${rows.join('\n')}

QUERY: "${query}"

Return a JSON object:
{
  "matches": [{"index": <number>, "reason": "<1 sentence why they match>"}],
  "explanation": "<1 sentence summary of results>"
}

Return up to ${limit} matches, ranked by relevance. Only include contacts that actually match the query. If the query mentions "haven't talked to" or similar, prefer contacts with no messages or old messages. If the query mentions a position, body type, distance, etc., filter accordingly. Return ONLY the JSON object.`;

  try {
    const text = await coalescedCallProvider(config, systemPrompt, userPrompt, 'query', {
      temperature: 0.2,
      maxTokens: 1024,
      jsonMode: true,
    });

    try {
      const parsed = JSON.parse(text);
      const matches = (Array.isArray(parsed.matches) ? parsed.matches : [])
        .filter((m: any) => typeof m.index === 'number' && m.index >= 0 && m.index < contacts.length)
        .slice(0, limit)
        .map((m: any) => ({
          contactId: contacts[m.index].id,
          reason: String(m.reason || ''),
        }));
      return {
        matches,
        explanation: String(parsed.explanation || `Found ${matches.length} matches.`),
        provider: config.provider,
      };
    } catch {
      return { matches: [], explanation: `LLM returned unparseable response.`, provider: config.provider, error: text.slice(0, 200) };
    }
  } catch (err) {
    return { matches: [], explanation: (err as Error).message, provider: config.provider, error: (err as Error).message };
  }
}

/**
 * Format an ISO timestamp as a coarse relative-age string (e.g. `5m ago`,
 * `3h ago`, `2mo ago`) for the compact contact table. Pure — no logging.
 * @param iso ISO-8601 timestamp string.
 * @returns a human-readable relative-time string.
 */
function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}
