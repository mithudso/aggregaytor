# Aggregaytor — Architecture & Code Map

**Last updated:** 2026-05-10 (v0.57.80)

This document is the **primary entry point** for anyone (human or AI) starting fresh on the codebase. Read this before making non-trivial changes. It captures the *why* behind choices that aren't obvious from reading the code alone.

---

## What it is

Chrome MV3 extension that unifies message inboxes across Sniffies, Grindr, DoubleList, Adam4Adam, Gmail, and Yahoo Mail. All data is local-first in IndexedDB via a Dexie-backed document store, with optional OPFS snapshots for large local backups. Adds LLM-powered reply suggestions, auto-respond with escalation tiers, dossier auto-extraction, block-rule automation, preference learning, profile rating, and Google Calendar/Tasks/Drive integration.

## Repository layout

```
aggregaytor/
├── extensions/aggregaytor/      # The shipped extension (manifest v3)
│   ├── manifest.json            # SOURCE OF TRUTH for version (currently 0.57.8)
│   ├── background/
│   │   ├── service-worker.ts    # ~2400 lines — central message router
│   │   ├── llm.ts               # ~1700 lines — multi-provider LLM + caches
│   │   └── debug-bridge.ts      # Dev/MCP debug commands
│   ├── content/
│   │   ├── <platform>.ts        # MAIN-world adapter bridges (8 platforms)
│   │   ├── <platform>-bridge.ts # ISOLATED-world content-script side
│   │   ├── grindr-filters.ts    # Cascade filter UI
│   │   ├── sniffies-map-filters.ts # Map marker filters
│   │   ├── floating-actions.ts  # Floating UI overlay
│   │   └── text-expander.ts     # Text expansion
│   ├── sidepanel/
│   │   ├── panel.html/.css/.js  # ~3500 lines of vanilla JS
│   └── popup/
│       ├── popup.html/.js       # ~400 lines — quick settings
│       └── vite.config.ts       # Build config (two-pass: ESM + IIFE)
│
├── adapters/<platform>/         # Platform-specific API/WS scrapers
│   ├── sniffies/                # WebSocket + fetch wrapper
│   ├── grindr/                  # Fetch wrapper, captures auth headers
│   ├── doublelist/, adam4adam/  # Fetch wrappers
│   └── gmail/, yahoo/           # Email provider adapters
│
├── packages/
│   ├── adapter-core/            # UnifiedMessage/UnifiedContact types
│   ├── context-engine/          # Dedup hash, normalize, search, entities
│   ├── store/                   # Dexie-backed document store
│   └── ui/                      # Shared UI primitives (minimal)
│
└── tools/debug-server/          # MCP server for debug commands
```

## Core abstractions

- **UnifiedMessage** — normalised message shape emitted by every adapter.
  `{ id, platform, threadId, contactId, direction, body, timestamp, read, metadata }`
- **UnifiedContact** — normalised contact.
  `{ id, platform, platformUserId, displayName, profileUrl, avatarUrl, lastSeen, metadata }`
- **Platform** — `'sniffies' | 'grindr' | 'doublelist' | 'adam4adam' | 'gmail' | 'yahoo'`
- **Adapter** — subclass of `BaseAdapter` (in `packages/adapter-core`). Intercepts platform network traffic in MAIN world, emits `'messages'` / `'contacts'` events, sent to bridge → service worker.

## Service-worker message dispatch

`chrome.runtime.onMessage` → `handleMessage(msg)` — a single switch statement (~700 cases). Each case:
1. Invalidates the thread-summary cache if its write affects thread ordering/unread counts
2. Routes to a store or LLM helper
3. Returns `{ ok: true, ... }` or `{ ok: false, error }`

**All handlers are async.** The outer listener is wrapped in try/catch so a sync throw can't kill the SW.

### Key handler categories

| Prefix | Purpose |
|---|---|
| `ADAPTER_*` | Inbound writes from content-script adapters |
| `GET_*` / `UPSERT_*` / `DELETE_*` | CRUD on persisted docs |
| `GENERATE_*` / `GET_LLM_*` / `CLEAR_LLM_CACHE` | LLM orchestration |
| `GOOGLE_*` / `DRIVE_*` | Google Tasks / Calendar / Drive |
| `BULK_TRAIN_*` / `AUTO_TRAIN_NOW` / `ENRICH_BLOCKED_PROFILES` | Preference-model training paths |
| `PROFILE_BLOCKED` / `UPDATE_DELETE_COUNT` / `ACTIVE_PROFILE_CHANGED` | UI-triggered signals |
| `SET_GRINDR_CREDENTIALS` / `GET_GRINDR_CREDENTIAL_STATUS` | Encrypted auto-login creds |

## Storage layer — `packages/store`

Dexie on IndexedDB with a compatibility wrapper that preserves the existing PouchDB-shaped store calls (`get`, `put`, `bulkDocs`, `allDocs`, `find`). The live database is `aggregaytor_dexie`; first-run migration imports legacy `aggregaytor` PouchDB docs if they exist. All docs still have a `docType` discriminator.

### Doc types

| docType | id format | Module |
|---|---|---|
| `message` | `msg:{platform}:{platformMsgId}` | messages.ts |
| `contact` | `contact:{platform}:{platformUserId}` | contacts.ts |
| `thread_meta` | `meta:{platform}:{contactId}` | thread-meta.ts |
| `reminder` | `reminder:{contactId}:{ts}` | reminders.ts |
| `auto_respond` | `auto:{ts}` | auto-respond.ts |
| `picture` | `pic:{ts}` | pictures.ts |
| `block_rule` | `blockrule:{ts}-{random}` | block-rules.ts |
| `preference_feedback` | `pref:{contactId}:{ts}` | preference-ml.ts |
| `preference_model` | `pref_model` | preference-ml.ts |
| `calendar_event` | `cal:{ts}` | calendar.ts |
| `dossier` | `dossier:{contactId}` | dossier.ts |
| `task` | `task:{ts}-{random}` | tasks.ts |

### Indexes (db.ts)

Compound indexes idempotently created on every startup:
- `(docType, platform, timestamp)` — recent messages by platform
- `(docType, contactId, timestamp)` — thread view
- `(docType, threadId)` — thread queries
- `(docType, platform)` — contacts by platform
- `(docType, read, timestamp)` — unread queries
- `(docType, contactId)` — generic contact scope
- `(docType, dueAt)` — reminders by due
- `(docType, status, scheduledAt)` — auto-respond queue

### Batch write pattern

Every bulk writer follows this shape (see `upsertMessages` and `upsertContacts`):
1. Build deterministic `_id`s for all docs
2. `allDocs({ keys })` to get `_rev` and preserved fields in one round-trip
3. Merge `_rev` + preserved fields (createdAt, non-null avatar, non-null displayName)
4. `bulkDocs()` in one call — regardless of batch size, 2 store calls total

This pattern matters — don't reintroduce N-call per-doc loops.

## Caching layers (v0.57.8)

See `memory/caching-layer-2026-04-14.md` for the full design rationale. Summary:

| # | Cache | File | Invalidation |
|---|---|---|---|
| 1 | `_storageCache` — chrome.storage reads | llm.ts | `chrome.storage.onChanged` + explicit on save |
| 2 | `_rulesCache` — block rules | block-rules.ts | Event on CRUD |
| 3 | `responseCache` — deterministic LLM responses | llm.ts | 5min TTL, 100 entries |
| 4 | `conversationSummaryCache` — rolling summaries | llm.ts | 10min TTL, 500 entries |
| 5 | `_contextBuilderCache` — serialized context | llm.ts | 30s TTL, 200 entries |
| 6 | `_promptModuleCache` — persona/style/tier modules | llm.ts | Hash-keyed, 100 entries |
| 7 | `threadSummaryCache` — inbox thread list | service-worker.ts | 5s TTL, invalidated on writes |
| 8 | `unreadCountCache` — badge count | messages.ts | 2s TTL, invalidated on writes |
| 9 | `recentContactUpserts` — contact-write dedup | service-worker.ts | 60s TTL, 500 cap |
| 10 | `_authCache` / `_driveAuthCache` — Google OAuth | google-tasks/drive-sync.ts | 50min TTL, 401 bust |
| 11 | `autoTrainedSet` — already-trained contacts | service-worker.ts | Session-lifetime, 10k cap |
| 12 | `_deviceCredentialKey` — crypto key | service-worker.ts | Lifetime |
| 13 | `lastDossierExtractTimestamp` — incremental cursor | llm.ts | 2k entry cap |
| 14 | `providerRequestCounts` — per-provider RPM | llm.ts | 60s rolling window |
| 15 | `inflightRequests` — prompt coalescing | llm.ts | Cleared when promise settles |

**Invariant:** every cache has an explicit invalidation trigger documented in comments adjacent to its declaration.

## LLM pipeline (llm.ts)

### Flow for a user-initiated LLM request

```
user action
  → GENERATE_SUGGESTIONS (or AUTO_RESPOND / DOSSIER / ...) in panel.js
  → chrome.runtime.sendMessage
  → service-worker.ts handleMessage
  → generateSuggestions(messages, contactName, platform, contactId?)
      ├── getBestProvider()          — picks least-utilised provider
      ├── buildSystemPromptWithContext()  — composed from cached modules
      │   ├── personaModule()         — cached per (preset, customInstr)
      │   ├── writingStyleModule()    — cached per styleGuideUpdatedAt
      │   └── contactContextModule()  — cached per (contactId, catKey, dossier.updatedAt)
      ├── buildConversationContext()  — memoized 30s
      ├── coalescedCallProvider()
      │   ├── inflightRequests dedupe
      │   └── callProvider()
      │       ├── getCacheKey() → responseCache hit?
      │       ├── getModelForTask(feature) — tier-based routing
      │       ├── queuedFetch() — rate limiter + backoff
      │       └── on 429: getConfigWithFailover()
      └── parseJsonArray() with fallback
```

### Provider cycling logic

1. Primary config comes from `getLLMConfig()` (cached).
2. If primary is near its RPM limit, scan all saved provider keys and pick the one with the most headroom.
3. On 429, call `getConfigWithFailover()` which tries gemini → anthropic → openai.

**Rate limits hard-coded in `PROVIDER_RPM`** (llm.ts:49). Update when provider tier changes.

### Prompt modules

Prompts are composed from independent modules. Each module has a stable cache key so the string is byte-identical when its inputs haven't changed. This maximises provider-side prompt caching (Anthropic `cache_control: ephemeral`, OpenAI automatic, Gemini implicit).

Feature → modules routing in `FEATURE_DOSSIER_CATEGORIES` (llm.ts). Add new features here.

### Temperature / cache interaction

`responseCache` only stores deterministic (temp<0.5) responses. High-temperature creative tasks (suggestions at 0.9) skip the cache to preserve variety.

## Service-worker lifecycle

Chrome MV3 SW terminates after **30s idle** or **5min max single task**. Our SW:

- Reads all settings lazily via `getCachedStorage` — one chrome.storage call per key per lifetime
- Uses `chrome.alarms` for all recurring work (badge-refresh 1min, reminder-check 15s, auto-respond-check 3s, preference-auto-train 30min, block-rule-check 5min, task-sync 5min, grindr-login-check 1min, dev-reload-keepalive 30s)
- `chrome.runtime.onMessage` listener is registered at top-level (first tick) so it never misses events
- State lives in Dexie/IndexedDB — the SW holds only caches. On cold start, `getDB()` re-opens the database quickly, and OPFS snapshots are available as a supplemental local backup layer.
- Dev auto-reload: polls `.build-hash` via `setInterval(1.5s)` + `chrome.alarms` keepalive. Dev-only — guarded on `!manifest.update_url`.

## Content-script architecture

Per-platform, two scripts:

1. **`<platform>-bridge.ts`** — runs in ISOLATED world at `document_start` (or `document_idle` for email).
   - Registered in `content_scripts` in manifest.json.
   - Injects the MAIN-world script into the page.
   - Proxies `CustomEvent('__aggregaytor_message')` → `chrome.runtime.sendMessage`.
   - Handles `SPA_NAVIGATE`, `SCRAPE_AVATARS`, `SCRAPE_CONVERSATION`, `SEND_AUTO_RESPONSE` from SW.

2. **`<platform>.ts`** — runs in MAIN world.
   - Built as an IIFE bundle (vite.config.ts's `buildContentScriptsIIFE`) — no ES modules, no shared chunks.
   - Intercepts `window.fetch` and WebSockets.
   - Instantiates the platform adapter and dispatches events to the bridge.
   - Keeps platform auth and other page-only state inside the MAIN-world closure; bridge-mediated requests ask the page script to perform specific authenticated operations instead of exposing raw credentials on `window`.

### MAIN world security notes

The host page CAN read anything on `window.*`. We only expose:
- `__aggregaytor_grindr_lookupProfileId(hash)` — looks up profileId from a photoHash we already saw (no new info leaked)

Do NOT expose anything that gives the page additional capabilities. Prefer bridge events that trigger narrowly scoped MAIN-world work over exposing secrets or reusable privileged helpers on `window.*`.

## Preference ML

Custom logistic regression in `packages/store/src/preference-ml.ts`. Trains on `ProfileFeatures` vectors; one model doc per install. Auto-training feeds every write in `upsertThreadMeta` with a signal field (since v0.57.8's signal index).

Signals:
- `md.isPinned` (sniffies) / `md.isFavorite` (grindr) / `meta.bookmarked` / `meta.favorited` / `meta.rating >= 4` → **positive**
- `md.isBlocked` (grindr) / `meta.blockedByThem` / `meta.rating <= 2` → **negative**
- `archived` intentionally NOT counted — user may archive for non-preference reasons.

## Data flow diagram (at a glance)

```
platform page (sniffies.com, etc.)
    │ window.fetch / WebSocket
    ▼
MAIN-world adapter (content/<platform>.ts)
    │ CustomEvent('__aggregaytor_message')
    ▼
ISOLATED bridge (content/<platform>-bridge.ts)
    │ chrome.runtime.sendMessage({ type:'ADAPTER_MESSAGES'|'ADAPTER_CONTACTS' })
    ▼
service-worker.ts handleMessage
    │ upsertMessages / upsertContacts (packages/store)
    ▼
Dexie store (IndexedDB 'aggregaytor_dexie')
    │ chrome.runtime.sendMessage({ type:'NEW_MESSAGES' })
    ▼
sidepanel/panel.js renders the inbox
```

## Build

- Monorepo, pnpm workspaces
- `pnpm build` from root runs all adapter/package tsup builds + the extension vite build
- `pnpm dev` watches. The `writeBuildHash` vite plugin writes `dist/.build-hash` on every bundle; SW polls it and calls `chrome.runtime.reload()`.
- Content scripts are built in a SECOND pass as IIFE (no ES imports) — see `vite.config.ts:buildContentScriptsIIFE`.
- Aliases `@aggregaytor/*` resolve to src/ not dist/ so changes propagate instantly.

## Versioning

- Version lives in `extensions/aggregaytor/manifest.json` — **this is the source of truth for releases.**
- Subpackage `package.json`s have their own independently-incremented versions; they rarely match the extension version.
- To ship a release: bump manifest version, `pnpm build`, commit with "vX.Y.Z: <summary>" prefix, push.

## Testing

- `pnpm -r test` — vitest across all packages
- 65 tests currently (context-engine: 34, adapter-core: 23, sniffies: 8)
- Most adapters and the store package have no tests (they pass `--passWithNoTests`)
- Store tests use `fake-indexeddb` for isolated IndexedDB-backed runs

## Debug

- `chrome://extensions/` → "service worker" link opens the SW devtools
- `GET_SW_PERF` message returns per-op perf counters + memory block (autoTrainedSet size, thread-cache age)
- `GET_LLM_QUEUE_STATUS` returns queue length, provider RPM usage, backoff state
- `DIAGNOSE_TRAINING_DATA` returns preference-model sample-quality audit

## Known tech debt / unfinished work

- `handlePictureSend` tracks the stat but doesn't actually send the picture (TODO in code)
- `packages/store/src/sync.ts` now throws intentionally — remote CouchDB replication is not supported on the Dexie-backed store
- `packages/ui` is basically empty — no shared components across panel + popup yet
- Dynamic-vs-static import warning for `llm.ts` and `tasks.ts` — won't fix; functionally fine

## Things NOT to do

- ❌ Don't add UI frameworks to the service worker (weight, cold-start cost)
- ❌ Don't store secrets in `window.*` (MAIN-world host-page reads)
- ❌ Don't call `chrome.storage.local.get()` directly for hot-path settings — use `getCachedStorage`
- ❌ Don't call `chrome.tabs.update({url})` if the tab is already at the URL — it wipes page state
- ❌ Don't use `setInterval` in the service worker except the dev-reload poll (which is explicitly guarded)
- ❌ Don't `upsertContact` without filtering empty contacts — see `handleIncomingContacts`
- ❌ Don't add a new settings key without wiring `invalidateStorageCache(key)` on save
- ❌ Don't add a new thread-meta signal field without adding it to `SIGNAL_FIELDS` in thread-meta.ts
