# Components

Every major module in the monorepo, grouped by layer. Companion to `docs/ARCHITECTURE.md`
(which explains the *why*); this file is the *what lives where* inventory.

Layer order (bottom → top): `packages/context-engine` → `packages/adapter-core` →
`packages/store` → `adapters/*` → `extensions/aggregaytor` → `tools/debug-server`.

---

## packages/adapter-core (`@aggregaytor/adapter-core`)

Shared foundation for every platform adapter: base class, network interception,
payload walking, normalization, logging, perf counters. Zero runtime dependencies.
Public API is the exports of `src/index.ts`.

| File | Purpose | Key exports |
|---|---|---|
| `src/types.ts` | Shared type vocabulary: `Platform`, `UnifiedMessage`, `UnifiedContact`, `AdapterEvent(Type)`, `AdapterConfig`, `InterceptorOptions`, `PayloadVisitor`, `DOMExtractorOptions` | types only |
| `src/base-adapter.ts` | Abstract adapter base. Wires interceptors on a target `window`, exposes an event-emitter surface (`'messages'` / `'contacts'` events) that MAIN-world content scripts relay to the bridge | `BaseAdapter` |
| `src/network-interceptor.ts` | Patches `window.fetch`, `XMLHttpRequest`, and `WebSocket` to observe platform traffic. URL matching is **host-anchored** (fixed 2026-08-30 — substring matches previously let `evil.example/?ref=grindr.com` through). Fetch responses are cloned and parsed off the page's critical path (the page's own `await fetch()` no longer waits on our parse) | `installFetchInterceptor`, `installXHRInterceptor`, `installWebSocketInterceptor`, `installAllInterceptors` |
| `src/payload-walker.ts` | Generic BFS JSON-tree walker with cycle detection and max-depth limiting; adapters supply a `PayloadVisitor` that recognizes message/contact-shaped nodes instead of writing brittle path extractors | `walkPayload` |
| `src/message-normalizer.ts` | Field extraction heuristics: timestamps (garbage-tolerant since 2026-08-30 — a hostile `1e20` timestamp no longer throws mid-batch), direction, text bodies, ids, relative-time strings ("5 months ago" vs "5 minutes ago" alternation-order bug fixed here) | `extractTimestamp`, `extractDirection`, `extractMessageText`, `extractId`, `parseRelativeTimeString` |
| `src/self-id-tracker.ts` | Detects the logged-in user's own platform IDs (field-name heuristics + `isMe`-flag scan) so messages can be classified in/out. Known open risk: can adopt strangers' IDs — see CDO BLOCKED table | `SelfIdTracker` |
| `src/api-sender.ts` | Captures auth headers from intercepted API calls and replays send-message endpoints with them; falls back to DOM injection. `PLATFORM_AUTH_HOST` bridges platform-slug ↔ registrable-domain cache-key namespaces | `captureAuthHeaders`, `getCapturedAuth`, `sendViaApi` |
| `src/dom-observer.ts` | MutationObserver-based DOM extractor factory for platforms/paths where network interception isn't enough | `createDOMExtractor` |
| `src/logger.ts` | Level-gated console logger (`debug < info < warn < error < off`), level persisted in `chrome.storage.local` (`aggregaytor_log_level`). See `docs/logging.md` | `createLogger`, `setLogLevel`, `getLogLevel`, `loadLogLevel`, `saveLogLevel`, `LogLevel` |
| `src/perf.ts` | In-memory call-count + wall-clock counters; MAIN-world scripts expose the instance as `window.__aggregaytor_perf` (deliberate, timing-metadata-only exception to the no-`window.*` rule) | `perf` |

- **Dependencies:** none at runtime (`@aggregaytor/context-engine` is a devDep for tests only).
- **Side effects:** the interceptor installers monkey-patch globals on the target window; logger reads/writes `chrome.storage.local` when available.
- **Constraints:** must run in MAIN world (no `chrome.*` beyond optional storage guards); code reachable from content-script entries is bundled as IIFE — no dynamic imports.

## packages/context-engine (`@aggregaytor/context-engine`)

Pure text/dedup/search utilities (extracted from mdb-tam). No DOM, no chrome, no I/O.

| File | Purpose | Key exports |
|---|---|---|
| `src/normalize.ts` | Text normalization, common replacements, mojibake repair | `normalizeContextText`, `applyCommonReplacements`, `maybeRepairMojibake` |
| `src/hash.ts` | Stable content hashing (FNV-1a variant — note the offset-basis typo in the BLOCKED table; changing it invalidates persisted hashes) | `stableContentHash` |
| `src/tokenize.ts` | Tokenization + stopwords for indexing/search | `tokenizeIndexText`, `normalizeSearchText`, `DEFAULT_STOPWORDS` |
| `src/minhash.ts` | MinHash signatures over shingles | `buildMinHashSignature`, `buildShingles`, `seededHash` |
| `src/lsh.ts` | LSH banding + similarity estimation (`bands: Infinity` infinite loop fixed 2026-08-30; trailing-band drop still open) | `buildLshBuckets`, `estimateSignatureSimilarity`, `estimateTokenJaccard` |
| `src/records.ts` | Context-record/module/chunk constructors + search-field builders | `createContextRecord`, `createContextModule`, `createContextChunk`, `buildRecordSearchFields`, `buildDateBucket` |
| `src/dedup.ts` | Near-duplicate detection over context records | `dedupeContextRecords` |
| `src/search.ts` | Fielded inverted index + weighted search | `buildFieldedIndexRecord`, `searchFieldedIndex`, `DEFAULT_FIELD_WEIGHTS` |
| `src/entities.ts` | Entity normalization, search terms, `EntityStore` | `normalizeEntities`, `buildSearchTerms`, `termMatchesText`, `inferEntityId`, `inferEntityName`, `EntityStore` |

- **Dependencies:** none.
- **Side effects:** none (pure functions + in-memory store class).
- **Constraints:** hash/LSH outputs are persisted downstream — output changes require data migration.

## packages/store (`@aggregaytor/store`)

Dexie-on-IndexedDB document store (`aggregaytor_dexie`) behind a PouchDB-shaped
compatibility wrapper (`get`/`put`/`bulkDocs`/`allDocs`/`find`), plus Google
integrations, export/backup, and preference ML. See ARCHITECTURE.md "Storage layer"
for doc types and index list.

| File | Purpose | Key exports |
|---|---|---|
| `src/db.ts` | Dexie database creation, compat wrapper, compound-index bootstrap, legacy-PouchDB first-run migration | `getDB`, `closeDB`, `destroyDB`, `createDB` |
| `src/types.ts` | Every persisted doc shape (`MessageDoc`, `ContactDoc`, `ThreadMetaDoc`, `DossierDoc`, …) | doc types, `DEFAULT_AUTO_RESPOND_SETTINGS`, `DEFAULT_DOSSIER` |
| `src/messages.ts` | Message CRUD, thread/contact/recent queries, unread counts (2s-TTL cache), age-based purge with protected-contact guard | `upsertMessage(s)`, `getMessagesByThread`, `getMessagesByContact`, `getRecentMessages`, `markThreadRead`, `getUnreadCount`, `invalidateUnreadCountCache`, `purgeOldestMessages` |
| `src/contacts.ts` | Contact CRUD following the 2-call bulk-write pattern | `upsertContact(s)`, `getContact`, `getContactsByPlatform`, `getAllContacts` |
| `src/threads.ts` / `src/thread-meta.ts` | Inbox thread summaries; per-thread metadata (bookmarks, notes, ratings) incl. `SIGNAL_FIELDS` feeding preference auto-train | `getThreadSummaries`, `getThreadUnreadCounts`, `getThreadMeta`, `upsertThreadMeta`, `getAllThreadMeta`, `getBookmarkedThreads`, `getArchivedThreads` |
| `src/reminders.ts` / `src/tasks.ts` | Local reminders and tasks | `createReminder`, `getReminders`, …; `createTask`, `getAllTasks`, `updateTask`, `deleteTask`, `getTasksByContact` |
| `src/auto-respond.ts` | Auto-respond queue with status lifecycle + human-jitter delay | `queueAutoRespond`, `getPending/Draft/ApprovedAutoResponds`, `updateAutoRespondStatus`, `randomDelay` |
| `src/pictures.ts` | Stored picture library + per-picture stats | `addPicture`, `getAllPictures`, `getPicture`, `getPictureByTag`, `incrementPictureStat`, `deletePicture` |
| `src/block-rules.ts` | Block-rule CRUD + rule evaluation engine; `_rulesCache` invalidated on CRUD | `createBlockRule`, `getAllBlockRules`, `updateBlockRule`, `deleteBlockRule`, `evaluateRules`, `executeAction`, `invalidateBlockRulesCache` |
| `src/preference-ml.ts` | Custom logistic regression over `ProfileFeatures`; one model doc per install | `recordFeedback`, `predictPreference`, `getModelStats`, `getAllFeedback`, `retrainModel`, `extractFeatures` |
| `src/sentiment.ts` | Lexicon-based conversation sentiment | `analyzeConversationSentiment`, `formatSentimentSummary` |
| `src/dossier.ts` | Per-contact dossier docs + category slices for LLM context | `getDossier`, `upsertDossier`, `setAutoExtractedField`, `getDossierSlice`, `formatDossierContext`, `DOSSIER_CATEGORIES` |
| `src/calendar.ts` | Google Calendar freeBusy + event creation; token storage | `getCalendarSettings`, `saveCalendarSettings`, `getCalendarToken`, `saveCalendarToken`, `getAvailableSlots`, `createCalendarEvent`, `authenticateCalendar` |
| `src/google-tasks.ts` | Google Tasks two-way sync (paginated since 2026-08-30) via `chrome.identity` | `createGoogleTask`, `updateGoogleTask`, `deleteGoogleTask`, `pullGoogleTasks`, `syncGoogleTasks`, `authenticateGoogle`, `isGoogleAuthenticated` |
| `src/google-drive-sync.ts` | Full-DB backup/restore to a Drive "Aggregaytor Backups" folder (`drive.file` scope). Backups currently written **unencrypted** — open risk | `backupToDrive`, `restoreFromDrive`, `getDriveBackupStatus` |
| `src/opfs-backup.ts` | Supplemental local snapshots in OPFS | `saveOpfsSnapshotData`, `getOpfsSnapshotStatus`, `restoreFromOpfsSnapshot`, `deleteOpfsSnapshot` |
| `src/export-import.ts` | Full/blocked export-import with optional AES-GCM (PBKDF2 210k iterations) | `exportAllData`, `importAllData`, `exportBlocked`, `importBlocked` |
| `src/lru-idb-cache.ts` | Two-tier mem+IDB LRU cache (`aggregaytor-cache` DB, separate from the main store) | `LruIdbCache` |
| `src/sync.ts` | Intentionally throws — remote CouchDB replication unsupported on the Dexie store | `startSync`, `stopSync` |

- **Dependencies:** `dexie`, `pouchdb-browser` (types/legacy migration).
- **Side effects:** opens/writes IndexedDB and OPFS; Google modules call `chrome.identity` and Google REST APIs.
- **Constraints:** bulk writes are always 2 store calls (`allDocs({keys})` + `bulkDocs`); every cache needs a documented invalidation trigger; runs inside the MV3 SW so no long-lived timers.

## adapters/* (6 platform packages)

Each adapter subclasses `BaseAdapter`, installs interceptors for its platform's
API/WebSocket traffic, and emits `'messages'` / `'contacts'` events. All have the
same dependency shape: dev-time only `@aggregaytor/adapter-core` (inlined into the
extension IIFE build via the `@aggregaytor/*` → `src/` alias).

| Package | Entry | Public API | Notes |
|---|---|---|---|
| `adapters/sniffies` | `src/sniffies-adapter.ts` | `SniffiesAdapter`, plus `parseSocketIOFrame`, `isGlobalChatEvent`, `isPresenceEvent` (ws-parser) and `normalizeProfileId`, `extractProfileIdFromUrl`, `findLikelyProfileId`, `extractProfileIdFromBackground` (profile-resolver) | WebSocket (Socket.IO frames) + fetch; the only adapter with substantive test coverage (`__tests__/`) — though ~40 tests exercise replicated parser copies, see known-issues |
| `adapters/grindr` | `src/grindr-adapter.ts` | `GrindrAdapter` | Fetch wrapper; captures auth headers for API-replay send |
| `adapters/doublelist` | `src/doublelist-adapter.ts` | `DoubleListAdapter` | Fetch wrapper; relative-time parsing quirks (see known-issues: contact/message id join) |
| `adapters/adam4adam` | `src/adam4adam-adapter.ts` | `Adam4AdamAdapter` | Fetch wrapper (www + m. hosts) |
| `adapters/gmail` | `src/gmail-adapter.ts` | `GmailAdapter` | Email adapter; direction + message-id semantics fixed 2026-08-30 |
| `adapters/yahoo` | `src/yahoo-adapter.ts` | `YahooAdapter` | Email adapter |

- **Side effects:** none at import; interceptor installation patches the page's globals.
- **Constraints:** platform DOM selectors and API shapes are load-bearing assumptions — they break silently when sites redeploy (see `docs/integrations-and-assumptions.md`).

## extensions/aggregaytor (`@aggregaytor/extension`)

The shipped MV3 extension. `manifest.json` is the version source of truth.

### background/

| File | Purpose |
|---|---|
| `service-worker.ts` (~4800 lines) | Central router: `chrome.runtime.onMessage` → `handleMessage()` single ~700-case switch. Invalidates thread caches on writes, routes to store/LLM helpers, returns `{ok, ...}`. All recurring work on `chrome.alarms`. Dev auto-reload polls `.build-hash`. |
| `llm.ts` (~2300 lines) | Multi-provider LLM engine: 9 providers (gemini, openai, anthropic, groq, cerebras, perplexity, mistral, copilot, local), `PROVIDER_RPM` hard-coded limits, proactive provider cycling, queued fetch w/ backoff + 60s timeouts, prompt-module composition with stable cache keys, response/summary/context caches, `getCachedStorage` settings cache, Gemini deprecation remapping. |
| `model-updater.ts` | Daily sweep of provider `/models` endpoints (only providers with a saved key); suggests newer same-family models; 15s per-request timeout; state in `chrome.storage.local`. |
| `search-index.ts` | In-memory FlexSearch index over message bodies. Lazy-built on first search, incrementally maintained on writes, capped at `SEARCH_INDEX_MAX_DOCS`, rebuilt after SW restart. |
| `friend-finder.ts` | Paced intro-greeting workflow (build → approve → alarm-driven jittered send loop, permanent ignore list). |
| `error-logger.ts` | Rolling 500-entry error buffer in `chrome.storage.local`, global error/rejection capture, `console.error` patch, JSON export via `chrome.downloads`. See `docs/logging.md`. |
| `debug-bridge.ts` | Read-mostly debug command handlers reached via the SW's `DEBUG_COMMAND` case. **Not gated** — see SECURITY.md known risks. Limits clamped to 500. |

### content/ (per platform: bridge + MAIN pairs)

- `<platform>-bridge.ts` — ISOLATED world, registered in `content_scripts`, injects the MAIN script, relays `CustomEvent('__aggregaytor_message')` → `chrome.runtime.sendMessage` through a **type allowlist** (added 2026-08-30), handles SW→page commands (`SPA_NAVIGATE`, `SCRAPE_*`, `SEND_AUTO_RESPONSE`).
- `<platform>.ts` — MAIN world IIFE, instantiates the adapter, patches fetch/WS, keeps platform auth inside closure scope.
- Extras: `grindr-filters.ts` (cascade filter UI), `sniffies-map-filters.ts` (map marker filters + partials prefetch), `floating-actions.ts` (floating overlay), `text-expander.ts` (text expansion; stores substitutions in page-origin localStorage — open risk), `sniffies-migrate.ts` (one-shot legacy bookmark/note migration).

### sidepanel/ and popup/

- `sidepanel/panel.html/.css/.js` (~5600 lines vanilla JS) — the inbox UI. All HTML sinks go through `esc()` (5-char entity escaper since 2026-08-30).
- `popup/popup.html/.js` (~480 lines) — quick settings; has its own escaper.

- **Dependencies:** all workspace packages plus `dexie`, `flexsearch`, `events`.
- **Constraints:** two-pass Vite build (ESM then IIFE for MAIN-world scripts); no UI frameworks in the SW; MV3 SW lifecycle (30s idle kill) shapes everything.

## tools/debug-server (`@aggregaytor/debug-server`)

MCP server on stdio for Claude-driven debugging. Acts as a WebSocket **client** to
`ws://localhost:9222` (override: `AGGREGAYTOR_DEBUG_PORT`), forwarding tool calls
that ultimately execute as `DEBUG_COMMAND` messages in the SW. Tools:
`query_messages/contacts/threads`, `get_thread_meta`, `get_dossier`,
`get_extension_status`, `get_llm_status`, `trigger_action` (incl. destructive
`clear_db`), `execute_query` (raw selector). Dependencies: `@modelcontextprotocol/sdk`,
`ws`, `@anthropic-ai/sdk`. See `docs/MCP.md`.

---

## Dependency graph

Verified against each `package.json` and import graph:

```
context-engine ──(dev/test only)──▶ adapter-core
                                        ▲
adapter-core ◀── adapters/{sniffies,grindr,doublelist,adam4adam,gmail,yahoo}  (devDeps; inlined at build)
     ▲                                  ▲
     └── store (devDep) ── dexie, pouchdb-browser
                                        │
extensions/aggregaytor ── depends on ALL: adapter-core, context-engine, store,
                          all 6 adapters, dexie, flexsearch, events
tools/debug-server ── standalone (mcp sdk + ws); talks to the extension at runtime, no compile-time deps
```

Rules of thumb:
- **adapters depend on adapter-core** (and sometimes context-engine), never on store or each other.
- **store** may use context-engine utilities; never depends on adapters.
- **the extension depends on everything**; nothing depends on the extension.
- `@aggregaytor/*` aliases resolve to `src/` inside the Vite extension build, so package rebuilds aren't needed for extension dev.
