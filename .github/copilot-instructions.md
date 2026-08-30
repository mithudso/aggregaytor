# Copilot instructions for Aggregaytor

## Default Execution Strategy

- **Parallelism-first.** When a task decomposes into independent subtasks (multiple file reads, per-package builds/tests, independent searches), run them concurrently rather than serially. Only serialize when one step's output feeds the next.
- **No truncation.** Never elide, summarize away, or truncate file contents, diffs, command output, or lists the user asked for. If output is long, deliver all of it in full.
- **Auto-continue.** If a multi-step task is interrupted or hits a length limit, continue from where it left off without waiting to be re-prompted. Do not restart completed steps.
- **Completion summary table.** End every multi-step task with a summary table of what was done:

  | Step | Target | Result |
  |------|--------|--------|
  | e.g. build | repo root | pass/fail + notes |

## Orientation

Read these before making non-trivial changes:

1. `docs/ARCHITECTURE.md` — primary code map: message-dispatch model, storage layer, caching invariants, content-script architecture, "Things NOT to do".
2. `CLAUDE.md` — command reference, critical invariants, build-system gotchas, and where things live.
3. `README.md` — user-facing feature/usage reference.

## Build, Test, and Validation Commands

Use **pnpm workspaces** from the repo root unless noted.

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run lint
pnpm run clean
```

Useful targeted commands:

```bash
# Extension watch build with automatic reload via dist/.build-hash polling
cd extensions/aggregaytor && pnpm run dev

# Run tests for one workspace package
cd packages/context-engine && pnpm run test
pnpm --filter @aggregaytor/store test

# Run a single test file or a single Vitest test
cd adapters/sniffies && npx vitest run __tests__/ws-parser.test.ts
cd adapters/sniffies && npx vitest run -t "matches partial messages"
```

## High-level Architecture

This repo is a **Chrome MV3 extension** that aggregates inboxes from multiple platforms into one side panel. The important end-to-end flow is:

```text
platform page
  -> MAIN-world content script (extensions/aggregaytor/content/<platform>.ts)
  -> ISOLATED bridge (extensions/aggregaytor/content/<platform>-bridge.ts)
  -> background/service-worker.ts
  -> packages/store (PouchDB / IndexedDB) and background/llm.ts
  -> sidepanel/panel.js
```

- The monorepo is split into three main layers:
  - `packages/*` holds shared primitives such as adapter types, the context engine, and the PouchDB-backed store.
  - `adapters/*` holds platform-specific parsing and interception logic.
  - `extensions/aggregaytor/*` holds the shipped Chrome extension: content scripts, service worker, side panel, popup, and manifest.
- MAIN-world scripts patch `fetch` / XHR / WebSocket and emit `CustomEvent`s because they need the page's JS context.
- ISOLATED bridge scripts can use `chrome.runtime.*`, so they relay events to the service worker and handle commands flowing back to the page.
- `extensions/aggregaytor/background/service-worker.ts` is the central router. Most extension behavior hangs off one large async message-dispatch switch.
- Persistence lives in `packages/store`, which uses a single local-first PouchDB database with `docType`-discriminated documents.
- The side panel UI is plain JavaScript in `extensions/aggregaytor/sidepanel/panel.js`, not React/Vue.
- Most feature work crosses boundaries: a platform change usually touches an adapter, a bridge, the service worker, and sometimes side panel rendering or store code.
- The service worker owns recurring background behavior via `chrome.alarms`, storage writes, LLM orchestration, and most UI-facing `chrome.runtime.sendMessage` handlers.

Build-wise, `extensions/aggregaytor/vite.config.ts` matters:

- Vite runs a **two-pass build**.
- Service worker and bridge scripts are built as normal ES modules.
- MAIN-world content scripts are built separately as **self-contained IIFE bundles** with no shared chunks.
- During the extension build, `@aggregaytor/*` aliases resolve to workspace `src/` files rather than `dist/`.

## Key Conventions

- Read `docs/ARCHITECTURE.md` before non-trivial changes. It is the main codebase map and records invariants that are easy to break accidentally.
- The release version source of truth is `extensions/aggregaytor/manifest.json`, not workspace package versions.
- For settings used on hot paths in the service worker / LLM pipeline, use `getCachedStorage()` from `background/llm.ts` rather than direct `chrome.storage.local.get()` reads, and invalidate the cache when saving a key.
- PouchDB batch upserts follow a strict pattern: deterministic IDs, one `allDocs({ keys, include_docs: true })` read to get `_rev` / preserved fields, then one `bulkDocs()` write. See `upsertMessages()` and `upsertContacts()`. Do not reintroduce per-document read/write loops.
- Contact writes must filter out empty contacts before upserting. `handleIncomingContacts()` in the service worker is the expected pattern.
- Every cache should have an explicit invalidation trigger documented near the cache declaration.
- In the service worker, use `chrome.alarms` for recurring work. Avoid `setInterval` there except the guarded dev reload poll.
- If you add a new preference-training signal to `thread_meta`, also add it to `SIGNAL_FIELDS` in `packages/store/src/thread-meta.ts` so incremental auto-training can see it.
- Do not expose new data or capabilities on `window.*` from MAIN-world scripts. The host page can read those values.
