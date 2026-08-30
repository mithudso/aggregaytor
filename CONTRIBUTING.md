# Contributing to Aggregaytor

## Setup

Prerequisites: Node 26 (see `.nvmrc`) and pnpm 10.

```bash
pnpm install
pnpm run build
```

Load the built extension: `chrome://extensions` → enable Developer mode →
"Load unpacked" → select `extensions/aggregaytor/dist`.

Watch mode (rebuild + auto-reload via `.build-hash` polling):

```bash
cd extensions/aggregaytor && pnpm run dev
```

## Commands

Run from repo root. Package manager is **pnpm** workspaces — do not use npm/yarn.

| Command | What it does |
|---------|--------------|
| `pnpm run build` | Full build: all packages → adapters → extension |
| `pnpm run test` | Vitest across all workspace packages |
| `pnpm run lint` | ESLint (flat config, `eslint.config.mjs`) |
| `pnpm run clean` | Remove every `dist/` |
| `pnpm --filter @aggregaytor/store test` | Test a single package |

## Conventions (from CLAUDE.md — read it, and `docs/ARCHITECTURE.md`, first)

- **Version source of truth** is `extensions/aggregaytor/manifest.json`. Bump the
  patch version on every change; release commits use `vX.Y.Z: <summary>`.
- **Settings reads on hot paths use `getCachedStorage`** — never call
  `chrome.storage.local.get()` directly there; wire `invalidateStorageCache(key)` on save.
- **PouchDB bulk writes are 2 calls, always**: `allDocs({ keys })` then
  `bulkDocs()` (see `upsertMessages` / `upsertContacts`). No per-doc loops.
- **Every cache needs a documented invalidation trigger** adjacent to its declaration.
- **No `setInterval` in the service worker** (MV3 SW terminates after ~30s idle);
  use `chrome.alarms`. The guarded dev-reload poll is the only exception.
- **Never expose new data on `window.*`** from MAIN-world scripts — host pages can read it.
- New `thread_meta` signal fields must be added to `SIGNAL_FIELDS` in
  `packages/store/src/thread-meta.ts`.
- Style: 2-space indent, LF, semicolons — see `.editorconfig`. There is no
  Prettier config; match surrounding code.

## PR flow

1. Branch from `main`.
2. Make your change; keep it scoped (a platform change usually touches
   adapter + bridge + service worker, sometimes panel/store).
3. Verify locally: `pnpm run build && pnpm run lint && pnpm run test`.
4. Bump the manifest patch version.
5. Open a PR against `main` — the template's testing and invariant checklists
   must pass. CI runs install → build → lint → test.
