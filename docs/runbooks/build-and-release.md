# Runbook — build and release

## Prereqs

- Node + **pnpm** (workspaces; never npm/yarn).
- One-time: `pnpm install` from repo root.

## Everyday build

```bash
pnpm run build        # all packages (tsup) → adapters → extension (vite, two-pass)
pnpm run test         # vitest across all workspace packages (198 tests green baseline)
pnpm run lint         # eslint — 0 problems is the baseline
pnpm run clean        # rm -rf every dist/ (when builds get weird)
```

The extension bundle lands in `extensions/aggregaytor/dist/`.

## Load / reload the unpacked extension

1. `chrome://extensions` → enable Developer mode.
2. "Load unpacked" → select `extensions/aggregaytor/dist/`.
3. After each `pnpm run build`: click the reload (↻) button on the extension card,
   then **refresh any open platform tabs** (content scripts don't reinject into
   already-loaded pages).

### Watch mode (skips manual reloads)

```bash
cd extensions/aggregaytor && pnpm run dev
```

The `writeBuildHash` Vite plugin writes `dist/.build-hash` on every bundle; the SW
polls it (1.5s, dev-only — guarded on `!manifest.update_url`) and calls
`chrome.runtime.reload()` itself. Platform tabs still need a manual refresh.

## Release procedure

1. **Bump the version in `extensions/aggregaytor/manifest.json`** — this is the
   single source of truth. (Subpackage `package.json` versions are independent;
   don't try to sync them.)
2. `pnpm run build` — expect `Done ×11`, no errors.
3. Verify: `pnpm run lint` (0 problems) and `pnpm run test` (198/198).
4. Load/reload unpacked and smoke-test at least one platform tab + the side panel.
5. Commit with the release prefix and push:

   ```bash
   git add -A
   git commit -m "vX.Y.Z: <one-line summary>"
   git push
   ```

There is no store publish / CI pipeline — distribution is load-unpacked.

## Build-system gotchas (why builds fail)

- **Two-pass Vite build**: pass 1 emits the SW + ISOLATED bridges as ES modules;
  pass 2 (`buildContentScriptsIIFE`) rebuilds MAIN-world `content/<platform>.ts`
  entries as IIFE with **no imports and no shared chunks**. Anything reachable from
  a MAIN-world entry must be inlineable.
- **`@aggregaytor/*` aliases resolve to `src/`** inside the extension build — package
  source edits propagate without rebuilding the package. Other consumers of the
  packages (tests via tsup output, tools) still need `pnpm -r build`.
- Don't remove the `writeBuildHash` plugin; dev auto-reload depends on it.
- 11 pre-existing `tsc --noEmit` errors in `extensions/` do **not** block the build
  (Vite strips types) — see `docs/known-issues.md` §C before "fixing" them.
