# Aggregaytor — Codebase Overview

**Generated:** 2026-08-30 · **Extension version:** 0.57.81 (source of truth: `extensions/aggregaytor/manifest.json`)

Human-readable map of every workspace component and substantive file. The machine-readable twin is `docs/high_signal_file_index.json` (validated by `scripts/check-doc-indexes.mjs`, wired as `pnpm run index:check`). For the *why* behind the architecture, read `docs/ARCHITECTURE.md` first.

**What this repo is:** a Chrome MV3 extension (TypeScript pnpm monorepo) that unifies message inboxes across Sniffies, Grindr, DoubleList, Adam4Adam, Gmail, and Yahoo Mail. Local-first storage (Dexie/IndexedDB with a PouchDB-shaped compat API), multi-provider LLM features, and Google Calendar/Tasks/Drive integration.

**Layer legend:** `extension-background` · `extension-content` · `extension-ui` · `adapter` · `shared-lib` · `storage` · `tooling` · `test` · `config` · `docs`

**Data flow:**

```
platform page → MAIN-world adapter (content/<platform>.ts, IIFE, monkey-patches fetch/XHR/WS)
             → ISOLATED bridge (content/<platform>-bridge.ts, relay-type allowlist)
             → background/service-worker.ts handleMessage() (single ~700-case switch)
             → packages/store (Dexie) + background/llm.ts (multi-provider LLM)
             → sidepanel/panel.js (vanilla JS UI)
```

---

## Root configs

| File | Purpose | Layer | Notes |
|---|---|---|---|
| `package.json` | Workspace root: pnpm scripts (`build`, `test`, `lint`, `clean`, `index:check`, `index:semantic`, `index:watch`) + shared devDeps | config | pnpm only — no npm/yarn |
| `pnpm-workspace.yaml` | Workspace globs: `packages/*`, `adapters/*`, `extensions/*` | config | |
| `.pnpmrc.json` | `onlyBuiltDependencies: [esbuild]` — supply-chain hardening | config | |
| `tsconfig.base.json` | Shared strict TS options (ES2022, bundler resolution), extended by every package | config | |
| `vitest.config.ts` | Root Vitest config: node env, forks pool; excludes `.claude/worktrees` duplicate checkouts | config | worktree-exclusion guard |
| `eslint.config.mjs` | Flat ESLint config, shared browser/extension globals, @typescript-eslint for TS | config | |
| `.gitignore` | Ignores node_modules, dist, coverage, `.semantic-index/`, `.venv/` | config | |
| `CLAUDE.md` | Claude Code guidance: commands, architecture quick-ref, build gotchas, invariants | docs | AI-agent context |
| `README.md` | User-facing feature/usage reference | docs | |
| `LICENSE` | Repository license (GPL-style full text) | docs | |
| `chrome-dev-context.md` | Root copy of the Chrome MV3 + DevTools MCP reference context | docs | duplicates `skills/chrome-dev-context` scope |
| `pnpm-lock.yaml` | pnpm lockfile | config | **generated** — do not hand-edit |
| `.claude/settings.local.json` | Local Claude Code permission allowlist | config | local-only |
| `.github/copilot-instructions.md` | Copilot execution-strategy instructions (parallelism-first, no truncation) | docs | AI-agent context |
| `.github/FUNDING.yml` | GitHub funding metadata | config | |
| `.github/SECURITY.md` | Vulnerability-reporting policy (private advisories) | docs | |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR template | docs | |
| `.github/ISSUE_TEMPLATE/bug_report.md` | Bug-report issue template | docs | |
| `.github/ISSUE_TEMPLATE/feature_request.md` | Feature-request issue template | docs | |
| `.github/dependabot.yml` | Weekly npm + actions dependency updates | config | |
| `.github/workflows/ci.yml` | CI workflow (build/lint/test; `pnpm run index:check` is CI-ready to add here) | config | owned by CI tooling — do not edit from index tooling |

Rolled-up: `.playwright-mcp/` holds 37 committed Playwright/console session logs (2026-05-09/10) — debugging artifacts, intentionally excluded from the JSON index and semantic index. `.claude/worktrees/` is a committed duplicate checkout of the whole tree (CDO-flagged); only the main tree is indexed. `.venv/` is an untracked local Python virtualenv (excluded everywhere).

---

## packages/adapter-core — shared adapter framework (`@aggregaytor/adapter-core`)

The base layer every platform adapter builds on: interception plumbing, payload heuristics, shared types.

| File | Purpose | Key exports | Layer | Patterns |
|---|---|---|---|---|
| `packages/adapter-core/src/types.ts` | Single source of truth for shared types across adapters/store/UI | `Platform`, `UnifiedMessage`, `UnifiedContact`, `AdapterConfig`, `InterceptorOptions`, `PayloadVisitor`, `DOMExtractorOptions` | shared-lib | namespaced `{platform}:{id}` ids; `metadata` bag |
| `packages/adapter-core/src/base-adapter.ts` | Abstract base class: interception wiring, pub/sub events, self-ID tracking, lifecycle cleanup | `BaseAdapter` | shared-lib | abstract-base-class, event-emitter, cleanup registry |
| `packages/adapter-core/src/network-interceptor.ts` | Monkey-patches fetch/XHR/WebSocket on a window to passively capture traffic; feeds auth capture | `installFetchInterceptor`, `installXHRInterceptor`, `installWebSocketInterceptor`, `installAllInterceptors` | shared-lib | monkey-patching; non-blocking response handling (CDO fix) |
| `packages/adapter-core/src/payload-walker.ts` | Generic BFS JSON tree walker with cycle detection, depth limit, context-ID propagation | `walkPayload` | shared-lib | visitor pattern |
| `packages/adapter-core/src/message-normalizer.ts` | Heuristic timestamp/direction/text/id extraction from arbitrary payloads; relative-time parsing | `extractTimestamp`, `extractDirection`, `extractMessageText`, `extractId`, `parseRelativeTimeString` | shared-lib | key-list heuristics |
| `packages/adapter-core/src/self-id-tracker.ts` | Detects the logged-in user's IDs (payload sniffing + window globals) so direction is classified right | `SelfIdTracker` | shared-lib | self-ID detection (over-adoption risk CDO-flagged) |
| `packages/adapter-core/src/dom-observer.ts` | MutationObserver message-element extraction with lazy root attachment for SPAs | `createDOMExtractor` | shared-lib | mutation-observer |
| `packages/adapter-core/src/api-sender.ts` | Captures auth headers and replays send endpoints (`PLATFORM_AUTH_HOST` maps slug→host keys); DOM fallback | `captureAuthHeaders`, `getCapturedAuth`, `sendViaApi` | shared-lib | auth-capture, api-replay |
| `packages/adapter-core/src/logger.ts` | Level-gated logger persisted via chrome.storage.local; safe outside extensions | `createLogger`, `setLogLevel`, `getLogLevel`, `loadLogLevel`, `saveLogLevel`, `LogLevel` | shared-lib | level-gated logging |
| `packages/adapter-core/src/perf.ts` | In-memory perf counters (calls + cumulative ms) for DevTools inspection | `perf` | shared-lib | perf-counters |
| `packages/adapter-core/src/index.ts` | Barrel export of the whole package | (re-exports) | shared-lib | barrel |
| `packages/adapter-core/package.json` / `tsconfig.json` / `tsup.config.ts` | Package manifest / TS config / tsup ESM+CJS+dts build | — | config | |

**Tests** (`test` layer, test-only): `packages/adapter-core/__tests__/message-normalizer.test.ts` (extraction + relative time), `packages/adapter-core/__tests__/payload-walker.test.ts` (traversal/depth/cycles), `packages/adapter-core/__tests__/perf.test.ts` (counters), `packages/adapter-core/__tests__/perf-benchmark.test.ts` (latency budgets).

---

## packages/context-engine — dedup/search/entity engine (`@aggregaytor/context-engine`)

Text-processing primitives extracted from mdb-tam: normalization → hashing → tokenization → MinHash → LSH → dedup → fielded search.

| File | Purpose | Key exports | Layer | Patterns |
|---|---|---|---|---|
| `packages/context-engine/src/normalize.ts` | Unicode replacement, zero-width strip, mojibake repair | `normalizeContextText`, `applyCommonReplacements`, `maybeRepairMojibake` | shared-lib | text-normalization |
| `packages/context-engine/src/hash.ts` | FNV-1a 64-bit stable content hash over normalized text | `stableContentHash` | shared-lib | offset-basis typo kept for persisted-hash compat (CDO) |
| `packages/context-engine/src/tokenize.ts` | Tokenization + stopword filtering | `tokenizeIndexText`, `normalizeSearchText`, `DEFAULT_STOPWORDS` | shared-lib | |
| `packages/context-engine/src/minhash.ts` | MinHash signatures over token shingles | `buildMinHashSignature`, `buildShingles`, `seededHash`, `toIntOption` | shared-lib | minhash |
| `packages/context-engine/src/lsh.ts` | LSH banding + similarity estimators | `buildLshBuckets`, `estimateSignatureSimilarity`, `estimateTokenJaccard` | shared-lib | trailing-band drop kept for persisted-bucket compat (CDO) |
| `packages/context-engine/src/dedup.ts` | Exact + near-duplicate detection keeping the most specific record | `dedupeContextRecords` | shared-lib | hash + LSH dedup |
| `packages/context-engine/src/records.ts` | ContextRecord creation with full enrichment pipeline | `createContextRecord`, `createContextModule`, `createContextChunk`, `buildRecordSearchFields`, `buildDateBucket` | shared-lib | enrichment pipeline |
| `packages/context-engine/src/search.ts` | Fielded inverted index with weighted scoring | `buildFieldedIndexRecord`, `searchFieldedIndex`, `DEFAULT_FIELD_WEIGHTS` | shared-lib | fielded search |
| `packages/context-engine/src/entities.ts` | Entity management with keyword/alias inference, pluggable store adapter | `EntityStore`, `normalizeEntities`, `buildSearchTerms`, `termMatchesText`, `inferEntityId`, `inferEntityName` | shared-lib | storage-adapter |
| `packages/context-engine/src/types.ts` | Package type contracts | `ContextRecord`, `FieldWeights`, `SearchFields`, `DedupeOptions`, `Entity`, `EntityStoreAdapter`, … | shared-lib | |
| `packages/context-engine/src/index.ts` | Barrel export | (re-exports) | shared-lib | barrel |
| `packages/context-engine/package.json` / `tsconfig.json` / `tsup.config.ts` | Manifest / TS config / build | — | config | |

**Tests** (test-only): `packages/context-engine/__tests__/hash.test.ts`, `packages/context-engine/__tests__/normalize.test.ts`, `packages/context-engine/__tests__/search.test.ts`, `packages/context-engine/__tests__/entities.test.ts`, `packages/context-engine/__tests__/perf-benchmark.test.ts`.

---

## packages/store — Dexie-backed document store (`@aggregaytor/store`)

All persistence. Dexie on IndexedDB behind a PouchDB-shaped compat API (`get`/`put`/`bulkDocs`/`allDocs`/`find`); every doc has a `docType` discriminator; batch writers follow the allDocs+bulkDocs two-round-trip pattern.

| File | Purpose | Key exports | Layer | Patterns |
|---|---|---|---|---|
| `packages/store/src/db.ts` | Dexie database + PouchDB compat wrapper; compound indexes; legacy PouchDB import-on-first-open | `getDB`, `closeDB`, `destroyDB`, `createDB`, `StoreDatabase`, `StoreDoc` | storage | compat-wrapper, compound-indexes, one-shot migration |
| `packages/store/src/types.ts` | Every persisted doc type (message, contact, thread_meta, reminder, auto_respond, picture, block_rule, preference ML, calendar, dossier, task) | `MessageDoc`, `ContactDoc`, `ThreadMetaDoc`, `AutoRespondDoc`, `BlockRuleDoc`, `ProfileFeatures`, `ContactDossierDoc`, `TaskDoc`, … | storage | docType discriminator, deterministic `_id` formats |
| `packages/store/src/messages.ts` | Message CRUD: batched upserts, thread/contact queries, read marking, unread cache, protected purge | `upsertMessages`, `getMessagesByThread`, `getMessagesByContact`, `markThreadRead`, `getUnreadCount`, `purgeOldestMessages` | storage | batch-write pattern, single-retry, protected-contacts purge |
| `packages/store/src/contacts.ts` | Contact CRUD with field-preserving batch upserts | `upsertContact`, `upsertContacts`, `getContact`, `getContactsByPlatform`, `getAllContacts` | storage | field preservation (avatar/name/createdAt) |
| `packages/store/src/threads.ts` | Computes ThreadSummary inbox rows by grouping messages + batch-joining contacts | `getThreadSummaries`, `getThreadUnreadCounts` | storage | derived view — threads are not stored docs |
| `packages/store/src/thread-meta.ts` | Per-thread metadata: bookmark, notes, archive, hide, auto-respond settings | `getThreadMeta`, `upsertThreadMeta`, `getAllThreadMeta`, `getBookmarkedThreads`, `getArchivedThreads` | storage | per-call defaults (no shared mutable literal) |
| `packages/store/src/reminders.ts` | Reminder CRUD with due queries | `createReminder`, `getReminders`, `markReminderNotified`, `deleteReminder` | storage | |
| `packages/store/src/auto-respond.ts` | Auto-respond queue: jittered delays, status lifecycle, rate limit | `queueAutoRespond`, `getPendingAutoResponds`, `updateAutoRespondStatus`, `randomDelay` | storage | pending→draft→approved→sent lifecycle |
| `packages/store/src/pictures.ts` | Picture library CRUD with tag lookup + send/response counters | `addPicture`, `getAllPictures`, `getPictureByTag`, `incrementPictureStat`, `deletePicture` | storage | |
| `packages/store/src/block-rules.ts` | Block-rule CRUD, condition evaluation, action execution; write-invalidated cache | `createBlockRule`, `getAllBlockRules`, `evaluateRules`, `executeAction`, `invalidateBlockRulesCache` | storage | event-driven cache, rule engine |
| `packages/store/src/preference-ml.ts` | Client-side logistic-regression preference model | `extractFeatures`, `recordFeedback`, `predictPreference`, `retrainModel`, `getModelStats` | storage | client-side ML |
| `packages/store/src/sentiment.ts` | Pattern-based conversation sentiment (interest/engagement/commitment) | `analyzeConversationSentiment`, `formatSentimentSummary` | storage | regex heuristics |
| `packages/store/src/dossier.ts` | Contact dossier CRUD with category-sliced reads for LLM prompts | `getDossier`, `upsertDossier`, `getDossierSlice`, `formatDossierContext`, `DOSSIER_CATEGORIES` | storage | category slicing (prompt-cache friendly) |
| `packages/store/src/tasks.ts` | Task CRUD (contact-linkable to-dos) | `createTask`, `getAllTasks`, `updateTask`, `deleteTask`, `getTasksByContact` | storage | |
| `packages/store/src/calendar.ts` | Google Calendar: OAuth token storage, availability slots, event creation | `getAvailableSlots`, `createCalendarEvent`, `authenticateCalendar`, `getCalendarSettings` | storage | oauth, injectable storage |
| `packages/store/src/google-tasks.ts` | Google Tasks REST sync (push CRUD, paginated pull, merge) | `syncGoogleTasks`, `pullGoogleTasks`, `createGoogleTask`, `authenticateGoogle` | storage | oauth, paginated sync (CDO fix) |
| `packages/store/src/google-drive-sync.ts` | Drive v3 backup/restore + OPFS write-through | `backupToDrive`, `restoreFromDrive`, `getDriveBackupStatus` | storage | backups currently unencrypted (CDO-flagged) |
| `packages/store/src/export-import.ts` | Full/blocked export-import with optional AES-GCM (PBKDF2 210k) | `exportAllData`, `importAllData`, `exportBlocked`, `importBlocked` | storage | AES-GCM, chunked import |
| `packages/store/src/opfs-backup.ts` | Supplemental OPFS snapshots with status/restore | `saveOpfsSnapshotData`, `getOpfsSnapshotStatus`, `restoreFromOpfsSnapshot`, `deleteOpfsSnapshot` | storage | OPFS |
| `packages/store/src/lru-idb-cache.ts` | Two-tier LRU cache: capped in-memory Map + IndexedDB cold tier, write-through, lazy TTL | `LruIdbCache`, `LruIdbCacheOptions` | storage | two-tier cache |
| `packages/store/src/sync.ts` | Intentional stub — remote CouchDB replication unsupported on Dexie store | `startSync` (throws), `stopSync` | storage | intentional stub |
| `packages/store/src/pouchdb-browser.d.ts` | Ambient module stub for pouchdb-browser | — | config | type shim |
| `packages/store/src/pouchdb-compat.d.ts` | Global PouchDB namespace shim onto Dexie StoreDatabase | — | config | type shim |
| `packages/store/src/index.ts` | Barrel export of the entire store API | (re-exports) | storage | barrel |
| `packages/store/package.json` / `tsconfig.json` / `tsup.config.ts` | Manifest / TS config / build | — | config | |

**Tests** (test-only): `packages/store/__tests__/db.test.ts` — Dexie compat (allDocs, compound find, export/import, thread summaries) on fake-indexeddb.

---

## adapters/* — six platform adapters

Each adapter package: a `package.json`, `tsconfig.json`, and `tsup.config.ts` (config layer), an `index.ts` barrel under src, and one adapter class extending `BaseAdapter`. All are `adapter` layer.

| File | Purpose | Key exports | Patterns |
|---|---|---|---|
| `adapters/sniffies/src/sniffies-adapter.ts` | Sniffies: fetch/XHR/WS interception; body-type-vs-message disambiguation; global-chat vs DM routing; `forceRefreshConversation` | `SniffiesAdapter` | heuristic classification |
| `adapters/sniffies/src/ws-parser.ts` | Parses WS frames (raw JSON + Socket.IO `42` prefix); classifies global-chat/presence events | `parseSocketIOFrame`, `isGlobalChatEvent`, `isPresenceEvent`, `GLOBAL_CHAT_EVENTS`, `PRESENCE_EVENTS` | dual-format parser |
| `adapters/sniffies/src/profile-resolver.ts` | Extracts partner profile ID via 6-priority strategy with self-ID skipping | `findLikelyProfileId`, `normalizeProfileId`, `extractProfileIdFromUrl`, `extractProfileIdFromBackground` | priority fallback chain |
| `adapters/sniffies/src/index.ts` | Barrel export | (re-exports) | barrel |
| `adapters/grindr/src/grindr-adapter.ts` | Grindr Web: /v3/inbox, /v4/chat, /v1/ws of the React SPA; auth-header capture for API-replay sends | `GrindrAdapter` | host allowlist |
| `adapters/grindr/src/index.ts` | Barrel export | (re-exports) | barrel |
| `adapters/doublelist/src/doublelist-adapter.ts` | DoubleList: server-rendered notification DOM (`data-mess-id`/`data-mess-channel`) + intercepted responses | `DoubleListAdapter` | DOM extraction |
| `adapters/doublelist/src/index.ts` | Barrel export | (re-exports) | barrel |
| `adapters/adam4adam/src/adam4adam-adapter.ts` | A4A: REST + DOM `data-author` extraction; username profile IDs | `Adam4AdamAdapter` | DOM + payload walking |
| `adapters/adam4adam/src/index.ts` | Barrel export | (re-exports) | barrel |
| `adapters/gmail/src/gmail-adapter.ts` | Gmail: DOM observation + Gmail API interception; host-anchored URL checks | `GmailAdapter` | host-anchored matching (CDO fix) |
| `adapters/gmail/src/index.ts` | Barrel export | (re-exports) | barrel |
| `adapters/yahoo/src/yahoo-adapter.ts` | Yahoo Mail: REST interception + MutationObserver (no WS) | `YahooAdapter` | DOM + payload walking |
| `adapters/yahoo/src/index.ts` | Barrel export | (re-exports) | barrel |

Per-adapter configs (all config layer): `adapters/sniffies/tsup.config.ts`, `adapters/grindr/tsup.config.ts`, `adapters/doublelist/tsup.config.ts`, `adapters/adam4adam/tsup.config.ts`, `adapters/gmail/tsup.config.ts`, `adapters/yahoo/tsup.config.ts`, plus each `package.json` and `tsconfig.json`.

**Sniffies tests** (test-only): `adapters/sniffies/__tests__/ws-parser.test.ts`, `adapters/sniffies/__tests__/event-classification.test.ts`, `adapters/sniffies/__tests__/force-refresh.test.ts` (fetch stub), `adapters/sniffies/__tests__/perf-benchmark.test.ts`, and two suites testing **replicated copies** of non-exported content-script functions (CDO-flagged): `adapters/sniffies/__tests__/partials-parser.test.ts`, `adapters/sniffies/__tests__/time-parser.test.ts`.

---

## extensions/aggregaytor — the shipped MV3 extension

### Build & manifest (config/tooling)

| File | Purpose | Layer | Patterns |
|---|---|---|---|
| `extensions/aggregaytor/manifest.json` | MV3 manifest — **version source of truth** (0.57.81); permissions, host permissions, content-script registrations, oauth2 | config | mv3-manifest |
| `extensions/aggregaytor/vite.config.ts` | Two-pass build: ESM (SW + bridges) then IIFE (MAIN-world scripts, no shared chunks); writes `dist/.build-hash` for dev auto-reload | config | two-pass build, `@aggregaytor/*` aliased to `src/` |
| `extensions/aggregaytor/build.sh` | Vite build + static-asset copy into dist/ | tooling | |
| `extensions/aggregaytor/package.json` / `tsconfig.json` | Manifest / TS config | config | |

### background/ (extension-background)

| File | Purpose | Key exports | Patterns |
|---|---|---|---|
| `extensions/aggregaytor/background/service-worker.ts` | Central router: single ~700-case `handleMessage` switch (ADAPTER_*, GET_/UPSERT_/DELETE_*, GENERATE_*, GOOGLE_*, training, debug); thread-summary cache invalidation; alarms; dev auto-reload | `recordMutation` | single-switch dispatch, cache invalidation, async handlers wrapped in try/catch |
| `extensions/aggregaytor/background/llm.ts` | Multi-provider LLM engine (~1700 lines): 9 providers with failover, request queue + rate settings, personality presets, style-guide derivation, suggestion/auto-respond/greeting/nickname/dossier generation, layered caches | `generateSuggestions`, `generateAutoResponse`, `generateGreeting`, `extractDossierFields`, `getLLMConfig`, `PERSONALITY_PRESETS`, `LLMProvider`, … | provider failover, request queue, LruIdbCache use |
| `extensions/aggregaytor/background/search-index.ts` | In-memory FlexSearch full-text index over messages: lazy seed, incremental adds, memory cap + eviction accounting; rebuilt after SW restarts | `seedIndex`, `indexMessages`, `searchMessages`, `getEvictedCount`, `SEARCH_INDEX_MAX_DOCS` | lazy seed, bounded memory |
| `extensions/aggregaytor/background/friend-finder.ts` | Paced intro-greeting workflow: filter/rank candidates, permanent ignore list, chrome.alarms jittered send loop | `getFFState`, `rankCandidates`, `nextDelayMs`, `FF_ALARM`, `FFFilters` | alarm-driven loop, session-scoped run state |
| `extensions/aggregaytor/background/model-updater.ts` | Periodic discovery of newer LLM models per provider via /models endpoints, family-pattern ranked suggestions | `checkAllProviders`, `getUpdaterState`, `MODEL_UPDATER_ALARM` | model-family ranking |
| `extensions/aggregaytor/background/error-logger.ts` | Rolling 500-entry error buffer in chrome.storage.local, exportable JSON artifact, global capture installer | `logError`, `getErrorLog`, `exportErrorLog`, `installGlobalErrorCapture` | rolling buffer |
| `extensions/aggregaytor/background/debug-bridge.ts` | Read-mostly introspection for the MCP debug server via `DEBUG_COMMAND` (ungated — documented security caveat, result sizes capped) | `handleDebugCommand` | bounded reads |

### content/ (extension-content)

MAIN-world scripts monkey-patch page networking and can't use `chrome.*`; ISOLATED bridges relay via `__aggregaytor_message` CustomEvents with **type allowlists** (any page script can forge the event — CDO High fix).

| File | Purpose | World | Patterns |
|---|---|---|---|
| `extensions/aggregaytor/content/sniffies.ts` | Sniffies MAIN entry: SniffiesAdapter + perf counters + map filters + text expander | MAIN | custom-event relay |
| `extensions/aggregaytor/content/sniffies-bridge.ts` | Most complex bridge: relay, SW commands (SPA nav, auto-send, Angular DOM scraping), URL-change tracking, context-invalidation survival, MAIN-script injection | ISOLATED | relay allowlist, DOM scraping |
| `extensions/aggregaytor/content/sniffies-map-filters.ts` | Map-marker filtering: attitude hide/highlight, text include/exclude, chat-age badges, manual block (5s periodic scan) | MAIN | periodic scan, CSS classing; `initMapFilters` |
| `extensions/aggregaytor/content/sniffies-migrate.ts` | One-time migration of sniffiesplus localStorage (activity, bookmarks, notes) into the store | ISOLATED | one-shot migration, delivery-confirmed (CDO fix) |
| `extensions/aggregaytor/content/grindr.ts` | Grindr MAIN entry: adapter + photo-hash→profileId map + auth relay + filters | MAIN | hash mapping |
| `extensions/aggregaytor/content/grindr-bridge.ts` | Grindr bridge: relay allowlist, middle-click block, floating panel, error forwarding | ISOLATED | relay allowlist |
| `extensions/aggregaytor/content/grindr-filters.ts` | Cascade grid filters: enum maps (`ETHNICITY_MAP`, `GENDER_MAP`), profile indexing, inclusive/exclusive hide-show | MAIN | enum mapping; `initGrindrFilters`, `indexGrindrProfile` |
| `extensions/aggregaytor/content/adam4adam.ts` | A4A MAIN entry: adapter relay + text expander | MAIN | custom-event relay |
| `extensions/aggregaytor/content/adam4adam-bridge.ts` | A4A bridge: relay, auto-send/avatar scrape, middle-click block, hide filter, floating actions | ISOLATED | relay allowlist |
| `extensions/aggregaytor/content/doublelist.ts` | DoubleList MAIN entry: adapter relay + text expander | MAIN | custom-event relay |
| `extensions/aggregaytor/content/doublelist-bridge.ts` | DoubleList bridge with relay allowlist + context guard | ISOLATED | relay allowlist |
| `extensions/aggregaytor/content/gmail.ts` | Gmail MAIN entry: adapter relay | MAIN | custom-event relay |
| `extensions/aggregaytor/content/gmail-bridge.ts` | Gmail bridge with relay allowlist + context guard | ISOLATED | relay allowlist |
| `extensions/aggregaytor/content/yahoo.ts` | Yahoo MAIN entry: adapter relay | MAIN | custom-event relay |
| `extensions/aggregaytor/content/yahoo-bridge.ts` | Yahoo bridge with relay allowlist + context guard | ISOLATED | relay allowlist |
| `extensions/aggregaytor/content/floating-actions.ts` | Floating quick-action panel (block, notes, 1–5 rating, quick phrases); draggable, persisted position | ISOLATED | injected UI; `showFloatingPanel`, `hideFloatingPanel` |
| `extensions/aggregaytor/content/text-expander.ts` | Shortcut→phrase expansion in chat inputs; defaults include personal data in page-origin localStorage (CDO-flagged) | MAIN | input monitoring; `initTextExpander` |

### UI (extension-ui)

| File | Purpose | Patterns |
|---|---|---|
| `extensions/aggregaytor/sidepanel/panel.html` | Side panel markup: inbox + thread views, settings modals | |
| `extensions/aggregaytor/sidepanel/panel.css` | Side panel styling | |
| `extensions/aggregaytor/sidepanel/panel.js` | ~3500-line vanilla-JS controller: inbox/thread views, filters, suggestions, reminders, settings; 5-char entity escaper (CDO Critical fix); error forwarding with noise filter | vanilla JS, message-passing UI |
| `extensions/aggregaytor/popup/popup.html` | Popup quick-settings markup | |
| `extensions/aggregaytor/popup/popup.js` | Popup controller: AI provider config, picture library, block rules; never-throwing sendMessage wrapper | safe-send wrapper |

---

## tools/debug-server — MCP debug server

| File | Purpose | Layer | Patterns |
|---|---|---|---|
| `tools/debug-server/src/server.ts` | MCP stdio server exposing extension introspection (query docs, adapter state, logs, actions) over a WebSocket bridge on port 9222 | tooling | mcp-server, websocket bridge (unauthenticated listener CDO-flagged) |
| `tools/debug-server/README.md` | Setup/usage docs | docs | |
| `tools/debug-server/package.json` / `tsconfig.json` | Manifest (@modelcontextprotocol/sdk, ws) / TS config | config | |

---

## scripts/ — retrieval-index tooling

| File | Purpose | Layer | Patterns |
|---|---|---|---|
| `scripts/semantic_indexer.py` | Local semantic index: walks the repo (honors .gitignore + exclusions), chunks code (~60 lines, 10 overlap) and markdown (heading-split), embeds via Ollama (`OLLAMA_EMBED_MODEL`, default nomic-embed-text), stores in ChromaDB at `.semantic-index/` (collection `aggregaytor`); ids `path#chunkN:<hash>` so re-runs only re-embed changed chunks; `--query "text" [-k N]` and `--stats`; exits 2 with install/pull instructions when Ollama or chromadb is missing | tooling | content-hash incremental, graceful degradation |
| `scripts/watch_and_index.sh` | Watcher: fswatch when installed (2s debounce), otherwise 30s `find -newer` polling; triggers the indexer on changes under packages/adapters/extensions/tools/scripts/docs/skills | tooling | fswatch/poll fallback |
| `scripts/check-doc-indexes.mjs` | No-dependency validator: JSON index paths and overview code-span paths must exist (exit 1 listing missing); warns (exit 0) about on-disk source files absent from the JSON index; `--prune` rewrites the JSON dropping dead entries; wired as `pnpm run index:check` (CI-ready) | tooling | doc-drift gate |
| `scripts/rotate-workflow-logs.mjs` | Rotates old sections of memory.md / prompts.md into docs/archive/ past a 200 KB size limit (`--dry-run`, `--force`); created by the workflow-infrastructure tooling pass | tooling | log rotation |

Generated artifacts of this tooling: `docs/high_signal_file_index.json` (machine index, **generated**), this file (`docs/codebase-overview.md`, **generated**), and the untracked `.semantic-index/` ChromaDB directory (gitignored).

---

## skills/ — 12 project skills (docs layer)

Each is a `SKILL.md` with YAML frontmatter (name + trigger description) pointing at its full reference context under docs/.

| Skill | Scope | Backing context doc |
|---|---|---|
| `skills/accessibility-ux-reviewer/SKILL.md` | WCAG 2.2 / ARIA / keyboard & focus review | `docs/accessibility-ux-reviewer-context.md` |
| `skills/chrome-dev-context/SKILL.md` | Chrome MV3 + DevTools MCP | `chrome-dev-context.md` (root) |
| `skills/code-reviewer/SKILL.md` | PR/codebase review standards | `docs/code-reviewer-context.md` |
| `skills/html-css-expert/SKILL.md` | Semantic HTML, cascade, layout | `docs/html-css-context.md` |
| `skills/javascript-nodejs-expert/SKILL.md` | JS/Node semantics & APIs | `docs/javascript-nodejs-context.md` |
| `skills/mongodb-expert/SKILL.md` | Schema/MQL/aggregation/indexes | `docs/mongodb-expert-context.md` |
| `skills/mongodb-performance-troubleshooting-expert/SKILL.md` | Explain plans, profiler, index use | `docs/mongodb-performance-troubleshooting-context.md` |
| `skills/performance-profiling-expert/SKILL.md` | DevTools traces, Lighthouse, perf_hooks | `docs/performance-profiling-expert-context.md` |
| `skills/security-reviewer/SKILL.md` | OWASP, CSP, extension permissions | `docs/security-reviewer-context.md` |
| `skills/software-architect/SKILL.md` | 42010/arc42/C4, tradeoffs, ADRs | `docs/software-architect-context.md` |
| `skills/testing-and-vitest-expert/SKILL.md` | Vitest authoring, mocking, coverage | `docs/testing-and-vitest-expert-context.md` |
| `skills/typescript-expert/SKILL.md` | Type design, narrowing, TSConfig | `docs/typescript-expert-context.md` |

---

## docs/ — project documentation

| File | Purpose |
|---|---|
| `docs/ARCHITECTURE.md` | **Primary entry point**: code map, dispatch model, storage layer, caching invariants, content-script architecture, things-not-to-do |
| `docs/CDO-REPORT-2026-08-30.md` | Code Deep Optimizer report: ~160 applied fixes (10 Critical), verify gate, BLOCKED decision-needed items |
| `docs/DEXIE-MIGRATION-PLAN.md` | PouchDB→Dexie migration plan (implemented as current compat layer) |
| `docs/PERFORMANCE-ANALYSIS-2026-04-14.md` | v0.57.6→v0.57.9 performance measurements |
| `docs/RESEARCH-2026-04-14.md` | Caching-assumption verification + candidate library research |
| `docs/codebase-overview.md` | This file (**generated** by the index tooling) |
| `docs/high_signal_file_index.json` | Machine-readable per-file index (**generated**; validated in CI via `pnpm run index:check`) |
| `docs/accessibility-ux-reviewer-context.md` · `docs/code-reviewer-context.md` · `docs/html-css-context.md` · `docs/javascript-nodejs-context.md` · `docs/mongodb-expert-context.md` · `docs/mongodb-performance-troubleshooting-context.md` · `docs/performance-profiling-expert-context.md` · `docs/security-reviewer-context.md` · `docs/software-architect-context.md` · `docs/testing-and-vitest-expert-context.md` · `docs/typescript-expert-context.md` | Full reference contexts backing the matching skills (AI-agent context; version-pinned to docs accessed 2026-05-10) |

---

## Maintenance

- **Validate indexes:** `pnpm run index:check` (exit 1 on dead paths; warns on unindexed source files). Add to CI alongside build/lint/test.
- **Prune dead JSON entries:** `node scripts/check-doc-indexes.mjs --prune`
- **Semantic index:** `pnpm run index:semantic` (build/update) · `python3 scripts/semantic_indexer.py --query "..."` (search) · `--stats` (counts). Requires `pip install chromadb requests` and `ollama pull nomic-embed-text`.
- **Watch mode:** `pnpm run index:watch`
- When adding a source file, add a matching entry to `docs/high_signal_file_index.json` and the relevant table above — the checker warns until you do.
