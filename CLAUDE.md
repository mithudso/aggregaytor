# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read these first

- `docs/ARCHITECTURE.md` — primary entry point. Code map, message-dispatch model, storage layer, caching invariants, content-script architecture, "Things NOT to do". Read it before any non-trivial change.
- `README.md` — user-facing feature/usage reference; useful for understanding what a piece of code is for, less useful for how it's wired.

## Commands

Run from repo root unless noted. Package manager is **pnpm** (workspaces); do not use npm/yarn.

```bash
pnpm install                   # install once
pnpm run build                 # full build: all packages → adapters → extension
pnpm run test                  # vitest across all workspace packages
pnpm run lint                  # eslint
pnpm run clean                 # rm -rf every dist/

# extension watch mode (rebuilds + auto-reloads via .build-hash polling)
cd extensions/aggregaytor && pnpm run dev

# single package
cd packages/context-engine && pnpm run test
pnpm --filter @aggregaytor/store test          # equivalent from root

# single test file / single test
cd adapters/sniffies && npx vitest run __tests__/ws-parser.test.ts
cd adapters/sniffies && npx vitest run -t "matches partial messages"
```

After a `pnpm run build`, reload the extension at `chrome://extensions` and refresh any open platform tabs. In watch mode the SW polls `dist/.build-hash` and self-reloads — no manual reload needed.

## Architecture quick reference

This is a **Chrome MV3 extension** that aggregates DMs from Sniffies, Grindr, DoubleList, Adam4Adam, Gmail, and Yahoo into one side panel. Local-first: all data in PouchDB (IndexedDB).

```
platform page  →  MAIN-world adapter (content/<platform>.ts, IIFE)
               →  ISOLATED bridge (content/<platform>-bridge.ts)  [chrome.runtime.sendMessage]
               →  service-worker.ts  handleMessage()  [single ~700-case switch]
               →  packages/store (PouchDB)  +  background/llm.ts (multi-provider)
               →  sidepanel/panel.js (vanilla JS)
```

Two worlds matter: MAIN-world scripts can patch `fetch`/WebSocket but can't use `chrome.*`; ISOLATED bridges can use `chrome.*` but can't see page JS. They communicate via `CustomEvent`. See `docs/ARCHITECTURE.md` "Content-script architecture" for the full pattern.

## Build system gotchas

- Vite (`extensions/aggregaytor/vite.config.ts`) runs **two passes**:
  1. Main build → service worker + ISOLATED bridges as ES modules.
  2. `buildContentScriptsIIFE` plugin → MAIN-world scripts as **IIFE bundles** (no `import`, no shared chunks). MAIN world doesn't permit ES module loading from the extension's content scripts, so any code reachable from a `content/<platform>.ts` entry must inline.
- `@aggregaytor/*` aliases resolve to `src/` not `dist/`, so source changes in packages propagate without rebuilding the package — but only inside the Vite extension build. tsup builds for individual packages still need `pnpm -r build` if another tool is consuming them.
- `writeBuildHash` plugin writes `dist/.build-hash` on every bundle; SW polls it for dev auto-reload. Don't remove it.

## Critical invariants (don't break these)

These are extracted from `docs/ARCHITECTURE.md`; consult it for the *why*.

- **Version source of truth** is `extensions/aggregaytor/manifest.json`. Subpackage `package.json` versions are independent and rarely match. Release commits use the form `vX.Y.Z: <summary>`.
- **Settings reads on hot paths must use `getCachedStorage`** — never call `chrome.storage.local.get()` directly. When adding a new settings key, wire `invalidateStorageCache(key)` on save.
- **PouchDB bulk writes are 2 calls, always**: `allDocs({ keys })` to get `_rev` + preserved fields, then `bulkDocs()`. See `upsertMessages` / `upsertContacts` for the pattern. Don't reintroduce N-call per-doc loops.
- **Every cache has an explicit invalidation trigger** documented adjacent to its declaration. New caches must follow this rule (15 caches enumerated in `docs/ARCHITECTURE.md`).
- **No `setInterval` in the service worker** except the dev-reload poll (guarded on `!manifest.update_url`). Use `chrome.alarms` for recurring work — MV3 SW terminates after 30s idle.
- **Don't expose anything new on `window.*`** from MAIN-world scripts — the host page can read it. Keep auth and other privileged page state inside MAIN-world closure scope, and use bridge-mediated request/response flows for narrowly scoped operations instead.
- **New `thread_meta` signal fields must be added to `SIGNAL_FIELDS`** in `packages/store/src/thread-meta.ts`, otherwise auto-train won't pick them up.
- **Don't `upsertContact` without filtering empty contacts** — see `handleIncomingContacts` for the filter.
- **Don't `chrome.tabs.update({url})` if the tab is already at the URL** — it wipes page state.

## Where things live

- Service-worker message routing: `extensions/aggregaytor/background/service-worker.ts` (single switch, all handlers async, top-level try/catch).
- LLM engine + caches + provider cycling: `extensions/aggregaytor/background/llm.ts`. Provider RPMs are hard-coded in `PROVIDER_RPM`.
- Side-panel UI (vanilla JS, ~3500 lines): `extensions/aggregaytor/sidepanel/panel.js`.
- Per-platform adapters: `adapters/<platform>/src/` (network interception + parsing). Bridge + MAIN-world entrypoints live in `extensions/aggregaytor/content/`.
- Storage primitives + doc-type definitions: `packages/store/src/` (`types.ts` lists every PouchDB doc shape).
- Shared types (`UnifiedMessage`, `UnifiedContact`, `Platform`): `packages/adapter-core/src/types.ts`.

## Testing

- `vitest` with `environment: 'node'`. Tests use the in-memory PouchDB adapter (`{ adapter: 'memory' }`) — isolated DB per test.
- Most coverage is in `packages/context-engine` and `adapters/sniffies`. Many packages pass `--passWithNoTests`; that's expected.

## Auto-memory has additional context

The user's auto-memory at `/Users/mitch/.claude/projects/-Users-mitch-Documents-GitHub-aggregaytor/memory/` has running notes from prior sessions: performance analyses, scheduled-improvement runs, deprecation deadlines (e.g. Gemini 2.5 → June 17 2026), and the Dexie-migration plan that is documented but **not implemented**. Check `MEMORY.md` index when prior decisions or in-flight initiatives are relevant.
