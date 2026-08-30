# Caching and optimization

**Invariant (from ARCHITECTURE.md): every cache has an explicit invalidation trigger,
documented in comments adjacent to its declaration.** New caches must follow this rule.

## The 15 enumerated caches

Authoritative table lives in `docs/ARCHITECTURE.md` ("Caching layers"); summarized here
by layer with invalidation strategy.

### Settings layer (llm.ts)

| Cache | What | Invalidation |
|---|---|---|
| `_storageCache` (`getCachedStorage`) | chrome.storage.local reads for hot-path settings | `chrome.storage.onChanged` listener deletes changed keys **plus** explicit `invalidateStorageCache(key)` on every save (belt-and-braces: the explicit call avoids racing the listener). Zero TTL — event-driven. |

Rules: hot-path settings reads go through `getCachedStorage`, never raw
`chrome.storage.local.get()`. Any new settings key must wire `invalidateStorageCache(key)`
on save. `getAllProviderKeys()` returns the cached object — **copy before mutating**
(cache-poisoning bug fixed 2026-08-30).

### LLM layer (llm.ts)

| Cache | What | Invalidation |
|---|---|---|
| `responseCache` | Deterministic (temp<0.5) LLM responses | 5min TTL, 100 entries. High-temp creative calls skip it to preserve variety. |
| `conversationSummaryCache` | Rolling conversation summaries | 10min TTL, 500 entries |
| `_contextBuilderCache` | Serialized conversation context | 30s TTL, 200 entries |
| `_promptModuleCache` | Persona / writing-style / contact-context prompt modules | Hash-keyed on module inputs (preset, styleGuideUpdatedAt, dossier.updatedAt), 100 entries — byte-identical strings maximize provider-side prompt caching |
| `providerRequestCounts` | Per-provider rolling RPM window | 60s rolling prune on read **and** write; `PROVIDER_TS_HARD_CAP` (2000) defensive ceiling |
| `inflightRequests` | Prompt coalescing (identical concurrent requests share one call) | Cleared when the promise settles (try/finally since the 2026-08-30 queue-wedge fix) |
| `lastDossierExtractTimestamp` | Incremental dossier-extraction cursor | 2k entry cap |

### Service-worker layer

| Cache | What | Invalidation |
|---|---|---|
| `threadSummaryCache` (service-worker.ts) | Inbox thread list | 5s TTL + invalidated by every write handler that affects ordering/unread |
| `recentContactUpserts` (service-worker.ts) | Contact-write dedup | 60s TTL, 500 cap |
| `autoTrainedSet` (service-worker.ts) | Contacts already auto-trained | SW-session lifetime, 10k cap |
| `_deviceCredentialKey` (service-worker.ts) | Credential-encryption crypto key | SW lifetime |

### Store layer (packages/store)

| Cache | What | Invalidation |
|---|---|---|
| `unreadCountCache` (messages.ts) | Badge unread count | 2s TTL + `invalidateUnreadCountCache()` on writes |
| `_rulesCache` (block-rules.ts) | Block rules | `invalidateBlockRulesCache()` fired on every rule CRUD |
| `_authCache` / `_driveAuthCache` (google-tasks.ts / google-drive-sync.ts) | Google OAuth tokens | ~50min TTL; busted on any 401 (plus `chrome.identity.removeCachedAuthToken`) |
| `LruIdbCache` (lru-idb-cache.ts) | Generic two-tier mem+IDB LRU (hot Map capped at `maxItems`, cold tier in the separate `aggregaytor-cache` IDB database, write-through, lazy TTL on read) | LRU eviction + per-entry TTL; survives SW restarts via the cold tier (VersionError-after-restart bug fixed 2026-08-30) |

### Search layer (background/search-index.ts)

FlexSearch in-memory index over message bodies. Lazy cold-seed from the store on first
search (~200ms/5000 msgs), then incremental `indexMessages()` on every inbound write.
Capped at `SEARCH_INDEX_MAX_DOCS` — evicted messages stay in the DB but aren't
searchable while the index is live (`getEvictedCount()` lets the UI warn). RAM-only:
rebuilt after every SW wakeup. Fallback to the store scan only when the index is
unavailable, not on sparse results.

## Performance patterns in use

- **2-call bulk writes** (store invariant): `allDocs({ keys })` → merge `_rev` +
  preserved fields → single `bulkDocs()`. Never per-doc loops (several were removed
  2026-08-30).
- **Payload-walker single pass**: one BFS traversal per intercepted payload with
  visitor callbacks, instead of multiple path-specific scans.
- **Prompt-module composition**: stable cache keys keep prompt strings byte-identical
  across calls → provider-side prompt-cache hits (Anthropic `cache_control:
  ephemeral`, OpenAI automatic, Gemini implicit).
- **Request coalescing + proactive provider cycling**: identical in-flight prompts
  share one request; `getBestProvider()` cycles before hitting `PROVIDER_RPM` limits;
  429s trigger failover with backoff and 60s fetch timeouts.
- **Debouncing/batching**: error-log flush debounced 1s (burst of 100 errors = 1
  storage write); alarms batch recurring work (badge 1min, reminders 15s,
  auto-respond 3s, etc.) instead of timers.
- **Off-critical-path interception**: fetch-interceptor parses response clones without
  making the page's own `await fetch()` wait (2026-08-30 fix).
- **MV3-lifecycle-aware state**: durable state in Dexie/chrome.storage; caches are
  reconstructable; `chrome.alarms` (not `setInterval`) for recurring work.

## Known bottlenecks (reported, not yet fixed)

Reported-only P1 items from the 2026-08-30 review pass + `docs/PERFORMANCE-ANALYSIS-2026-04-14.md`:

1. **`getBoundingClientRect` per frame in `sniffies-bridge.ts`** — layout reads in
   hot paths (e.g. scroll-container discovery, marker positioning around lines
   ~752/1197/1226) force sync layout; should be cached/throttled per frame.
2. **`outerHTML` serialization every 1.5s** — the sniffies bridge serializes large DOM
   subtrees (`document.body.outerHTML` at ~line 3013, per-row outerHTML) on a polling
   cadence; serialization cost scales with page size.
3. **Full-DOM `querySelectorAll` walks** — 34 call sites in `sniffies-bridge.ts`
   alone; repeated broad selector scans instead of scoped roots / MutationObserver
   deltas.

When touching these, measure before/after with the perf counters (below).

## Profiling

- `packages/adapter-core/src/perf.ts`: `const end = perf.start('label'); …; end();`
  — ~100ns overhead, in-memory only.
- **DevTools affordance**: MAIN-world scripts assign `window.__aggregaytor_perf`
  (see `content/sniffies.ts`) — from the page console:
  `__aggregaytor_perf.stats()` (counters sorted by CPU time),
  `__aggregaytor_perf.reset()`, `__aggregaytor_perf.uptimeMin()`.
- Service worker: send `GET_SW_PERF` for per-op counters + memory block
  (autoTrainedSet size, thread-cache age); `GET_LLM_QUEUE_STATUS` for queue length,
  provider RPM usage, backoff state.
- Bench tests: `adapters/sniffies/__tests__/perf-benchmark.test.ts`.
