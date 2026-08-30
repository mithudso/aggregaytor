# Requirements

Functional and non-functional requirements as implemented, inferred from the
README feature set, `docs/ARCHITECTURE.md`, and the manifests. This is a
descriptive document (what the system is required to do today), not a roadmap.

---

## 1. Functional requirements

### Message aggregation

- **FR-1** Capture direct messages in real time from Sniffies, Grindr web,
  DoubleList, Adam4Adam, Gmail, and Yahoo Mail by intercepting the page's
  `fetch`/XHR/WebSocket traffic in the MAIN world.
- **FR-2** Normalize every captured message/contact into the shared
  `UnifiedMessage` / `UnifiedContact` shapes (`packages/adapter-core`).
- **FR-3** Present all conversations in a single Chrome side-panel unified
  inbox with platform filter chips and sorting (recent, distance, interest,
  commitment, unread, name).
- **FR-4** Deduplicate captured messages (adapter-side `seenMessageIds`, plus
  store-side dedup via `packages/context-engine` hashing).
- **FR-5** Capture Sniffies Global Chat separately and route it to a dedicated
  "Global Chat" thread.
- **FR-6** Clicking a thread navigates the matching platform tab to that
  conversation (without re-navigating a tab already at the URL).

### AI features

- **FR-7** Support 7 LLM providers (Gemini, OpenAI, Anthropic, Groq,
  Perplexity, Mistral, Copilot) with automatic rate-limit cycling and failover.
- **FR-8** Auto-respond with risk-tiered escalation: low risk auto-sends after
  a delay; medium risk queues a draft for review; high risk requires explicit
  manual approval.
- **FR-9** Offer 14 personality presets plus custom instructions, and derive a
  writing-style guide from the user's own message history.
- **FR-10** Generate per-contact dossiers (AI-extracted profiles) and sentiment
  scores (interest / engagement / commitment).
- **FR-11** Learn user preferences with an on-device logistic-regression model
  fed by like/dislike feedback and thread-meta signal fields.
- **FR-12** Route LLM tasks to model tiers (premium / standard / economy) per
  feature.

### Contact & data management

- **FR-13** Full-text search across all messages and within a conversation
  (flexsearch-backed).
- **FR-14** Favorites, notes, reminders, archiving, and block rules
  (auto-block/archive on configurable conditions).
- **FR-15** Sync contact avatars/photos from map markers, API responses, and
  profile pages on supported platforms.
- **FR-16** Integrate with Google Calendar, Tasks, and Drive (OAuth via
  `chrome.identity`; scopes declared in `manifest.json`).
- **FR-17** Provide data export/import and a "Clear All Data" wipe; support
  optional OPFS snapshots and Google Drive backups as supplemental copies.

## 2. Non-functional requirements

- **NFR-1 · Local-first privacy** — all user data lives in the browser
  (IndexedDB via Dexie, database `aggregaytor_dexie`). Nothing leaves the
  machine except explicit LLM API calls and opted-in Google/Drive sync. No
  telemetry, no remote server.
- **NFR-2 · MAIN-world containment** — nothing new may be exposed on
  `window.*` from MAIN-world scripts (host pages can read it); privileged state
  stays in closure scope, and bridges relay only allowlisted event types.
- **NFR-3 · MV3 service-worker lifetime** — the SW terminates after ~30s idle;
  all recurring work must use `chrome.alarms` (no `setInterval` except the
  guarded dev-reload poll), all state must be re-derivable from
  IndexedDB/`chrome.storage`, and hot-path settings reads must go through
  `getCachedStorage`.
- **NFR-4 · Hot-path performance** — network interception must never block the
  page (response bodies are parsed from a `clone()` on a detached promise);
  bulk storage writes are 2 store calls regardless of batch size
  (`allDocs({keys})` + `bulkDocs`); parse-path perf is guarded by wall-clock
  benchmark tests in context-engine, adapter-core, and sniffies.
- **NFR-5 · Cache discipline** — every cache (15 enumerated in
  `ARCHITECTURE.md`) has an explicit, documented invalidation trigger.
- **NFR-6 · Resilience to hostile input** — adapters parse untrusted page
  traffic; malformed payloads (bad timestamps, garbage frames) must not abort
  batch processing, and all side-panel rendering of platform data must go
  through the HTML escaper.

## 3. External dependencies (production)

Workspace-internal `@aggregaytor/*` packages are omitted; versions are the
declared ranges.

| Package | Dependency | Purpose |
|---|---|---|
| `extensions/aggregaytor` | `dexie` ^4.0.11 | IndexedDB wrapper — the primary datastore |
| `extensions/aggregaytor` | `events` ^3.3.0 | Node-style `EventEmitter` in the browser bundle (adapter event plumbing) |
| `extensions/aggregaytor` | `flexsearch` ^0.7.43 | Client-side full-text search index |
| `extensions/aggregaytor` | `@anthropic-ai/sdk` ^0.39.0 (declared as devDependency, bundled by Vite) | Anthropic LLM provider client |
| `packages/store` | `dexie` ^4.0.11 | Store implementation |
| `packages/store` | `pouchdb-browser` ^9.0.0 | Legacy: PouchDB-compat API shape + first-run migration of the pre-Dexie `aggregaytor` database |
| `packages/adapter-core`, `packages/context-engine`, all `adapters/*` | — | No production dependencies (pure TS; workspace peer deps only) |
| `tools/debug-server` | `@modelcontextprotocol/sdk` ^1.0.0 | MCP server for Claude Code debugging |
| `tools/debug-server` | `ws` ^8.18.0 | WebSocket link to the extension debug bridge |
| `tools/debug-server` | `@anthropic-ai/sdk` ^0.39.0 | LLM access from the debug server |

Dev toolchain (all packages): TypeScript ^5.7, tsup ^8.4, Vitest ^3.1,
Vite ^6.3 (extension only), ESLint ^9.20, Prettier ^3.5, `fake-indexeddb`
^6.0 (store tests), `tsx` (debug server). Known advisory-level upgrade debt is
tracked in [`CDO-REPORT-2026-08-30.md`](./CDO-REPORT-2026-08-30.md).

## 4. System requirements

- **Browser**: Chrome or Chromium-based, Manifest V3. `manifest.json` sets no
  `minimum_chrome_version`; in practice the `sidePanel` permission requires
  **Chrome 114+**.
- **Host permissions**: `sniffies.com`, `web.grindr.com`, `doublelist.com`,
  `www./m.adam4adam.com`, `mail.google.com`, `mail.yahoo.com` (see
  `manifest.json`).
- **Build machine**: Node.js >= 18 and pnpm >= 9 (see
  [`INSTALLATION.md`](./INSTALLATION.md)).
- **Storage**: IndexedDB with `unlimitedStorage`; optional OPFS for snapshots.
- **Network**: only required for the platforms themselves, LLM provider APIs
  (user-supplied keys), and optional Google APIs.
