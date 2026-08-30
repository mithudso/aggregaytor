# GEMINI.md

Guidance for Gemini-based agents working in this repository. The canonical
instructions live in `CLAUDE.md` — read it first, then `docs/ARCHITECTURE.md`.

## Key sections in CLAUDE.md

- **Read these first** — orientation order (`docs/ARCHITECTURE.md`, `README.md`).
- **Commands** — full command reference, including per-package and single-test runs.
- **Architecture quick reference** — MAIN-world adapter → ISOLATED bridge → service worker → store/panel flow.
- **Build system gotchas** — two-pass Vite build, IIFE content scripts, `.build-hash` dev reload.
- **Critical invariants (don't break these)** — caching, PouchDB bulk-write pattern, MV3 alarm rules, `window.*` exposure ban.
- **Repository shape** — top-level directory map.
- **Workflow log rule** — `prompts.md` / `memory.md` logging and manifest patch-version bumps.

## Commands

Package manager is **pnpm** (workspaces); do not use npm/yarn. Run from repo root:

```bash
pnpm install       # install once
pnpm run build     # full build: all packages → adapters → extension
pnpm run test      # vitest across all workspace packages
pnpm run lint      # eslint
pnpm run clean     # rm -rf every dist/
```

Extension watch mode:

```bash
cd extensions/aggregaytor && pnpm run dev
```

Version source of truth: `extensions/aggregaytor/manifest.json`.
