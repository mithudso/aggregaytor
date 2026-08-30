# Development Guide

How to set up, build, test, and extend Aggregaytor. For the *why* behind the
architecture, read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | >= 18 | No `engines` field is pinned in `package.json`; README states >= 18. Newer LTS versions work (dev machines run Node 26). |
| pnpm | >= 9 | `pnpm-lock.yaml` is `lockfileVersion: '9.0'`, which requires pnpm 9+. Install: `npm install -g pnpm`. **Do not use npm or yarn** — this is a pnpm workspace. |
| Chrome | Chromium-based browser with MV3 + side panel support (Chrome 114+ ships the Side Panel API) | Needed to load and exercise the extension. |

## First-run setup

```bash
git clone git@github.com:mithudso/aggregaytor.git
cd aggregaytor
pnpm install          # installs all workspace packages
pnpm run build        # tsup builds packages/adapters, then Vite builds the extension
```

`pnpm run build` runs `pnpm -r build` — every workspace package in dependency
order, ending with `extensions/aggregaytor` whose Vite build bundles everything
into `extensions/aggregaytor/dist/`.

Then load the extension: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select `extensions/aggregaytor/dist`. Full walkthrough in
[`INSTALLATION.md`](./INSTALLATION.md).

## Dev workflow

### Extension watch mode

```bash
cd extensions/aggregaytor && pnpm run dev     # vite build --watch
```

Two things make watch mode pleasant:

- **`@aggregaytor/*` aliases resolve to `src/`, not `dist/`** — inside the Vite
  extension build, source edits in `packages/` and `adapters/` propagate without
  rebuilding those packages. (tsup outputs still need `pnpm -r build` if some
  *other* tool consumes a package's `dist/`.)
- **`.build-hash` auto-reload** — the `writeBuildHash` Vite plugin writes a fresh
  random hash to `dist/.build-hash` on every bundle. In dev (guarded on
  `!manifest.update_url`) the service worker polls that file and calls
  `chrome.runtime.reload()` itself, so you don't reload manually. You still need
  to refresh open platform tabs to re-inject content scripts.

### One-shot builds

```bash
pnpm run build        # from repo root — full build
pnpm run clean        # rm -rf every dist/
```

After a non-watch build: reload the extension card at `chrome://extensions`,
then refresh any open platform tabs.

## Testing

All tests are Vitest with `environment: 'node'` (see root `vitest.config.ts`,
which also excludes `**/.claude/**` so worktree checkouts aren't collected).

```bash
pnpm run test                                  # all packages (198 tests)

# single package
cd packages/context-engine && pnpm run test
pnpm --filter @aggregaytor/store test          # equivalent from root

# single test file / single test
cd adapters/sniffies && npx vitest run __tests__/ws-parser.test.ts
cd adapters/sniffies && npx vitest run -t "matches partial messages"
```

See [`TESTING.md`](./TESTING.md) for suite layout, conventions, and known gaps.

## Linting

```bash
pnpm run lint         # eslint . from the repo root (config: eslint.config.mjs)
```

The baseline is 0 problems — keep it there.

## Continuous integration

CI runs on GitHub Actions (`.github/workflows/ci.yml`) and mirrors the local
gate: **install → build → lint → test**. A PR is green when
`pnpm install && pnpm run build && pnpm run lint && pnpm run test` all pass —
run exactly that locally before pushing to avoid CI round-trips.

## Branch & commit conventions

- Work happens on the default branch or short-lived feature branches; no formal
  branch-naming scheme is enforced. <!-- TODO: confirm if a branch-naming convention should be adopted -->
- **Release commits use the form `vX.Y.Z: <summary>`.** The version source of
  truth is `extensions/aggregaytor/manifest.json` (subpackage `package.json`
  versions are independent and rarely match).
- To ship a release: bump the manifest version → `pnpm run build` → commit with
  the `vX.Y.Z:` prefix → push.

## Adding a new platform adapter (end-to-end)

Use an existing pair as the template — `adapters/grindr` +
`extensions/aggregaytor/content/grindr.ts` / `grindr-bridge.ts` is a good
mid-complexity reference; `adapters/yahoo` is the simplest (REST-only, no
WebSocket).

1. **Adapter package** — create `adapters/<platform>/` mirroring an existing
   one: `package.json` (name `@aggregaytor/adapter-<platform>`,
   `peerDependencies` on `@aggregaytor/adapter-core`, tsup build,
   `vitest run` test script), `tsup.config.ts`, and
   `src/index.ts` exporting a `<Platform>Adapter` class that extends
   `BaseAdapter` from `@aggregaytor/adapter-core`. Implement
   `shouldInterceptUrl()`, `parseApiResponse()`, and `parseWebSocketFrame()`
   (return `[]` if the platform has no WebSocket traffic — see
   `adapters/yahoo/src/yahoo-adapter.ts`). Emit `UnifiedMessage` /
   `UnifiedContact` records.
2. **Extend the `Platform` type** — add the platform string to `Platform` in
   `packages/adapter-core/src/types.ts`.
3. **MAIN-world entry** — `extensions/aggregaytor/content/<platform>.ts`:
   imports the adapter, instantiates it, and dispatches
   `CustomEvent('__aggregaytor_message')` to the bridge. No `chrome.*` APIs
   here; keep auth/privileged state inside closure scope, never on `window.*`.
4. **ISOLATED-world bridge** — `extensions/aggregaytor/content/<platform>-bridge.ts`:
   injects the MAIN-world script via
   `script.src = chrome.runtime.getURL('content/<platform>.js')`, and relays
   `__aggregaytor_message` events to the service worker with
   `chrome.runtime.sendMessage`. **Define a `<PLATFORM>_RELAY_TYPES` allowlist**
   (e.g. `new Set(['ADAPTER_MESSAGES', 'ADAPTER_CONTACTS'])`) and drop anything
   else — any page script can forge the CustomEvent, so the bridge must only
   forward the types your MAIN-world script actually emits.
5. **Vite entries** — in `extensions/aggregaytor/vite.config.ts`, add the
   MAIN-world entry to the `buildContentScriptsIIFE` list (IIFE pass — MAIN
   world can't load ES modules) *and* the bridge to the main build's
   `rollupOptions.input` map.
6. **Manifest** — in `extensions/aggregaytor/manifest.json`, add the platform's
   origin to `host_permissions`, a `content_scripts` entry loading
   `content/<platform>-bridge.js` (`document_start` for chat platforms,
   `document_idle` for email), and a `web_accessible_resources` entry exposing
   `content/<platform>.js` to that origin only.
7. **Extension deps** — add `"@aggregaytor/adapter-<platform>": "workspace:*"`
   to `extensions/aggregaytor/package.json` dependencies, then `pnpm install`.
8. **Service worker** — normally no changes needed: `ADAPTER_MESSAGES` /
   `ADAPTER_CONTACTS` handling is platform-agnostic. Add cases to
   `handleMessage` only for platform-specific operations.
9. **Tests** — add `adapters/<platform>/__tests__/*.test.ts` covering the
   parsing logic (see [`TESTING.md`](./TESTING.md)).
10. `pnpm run build`, reload the extension, open the platform, and check the
    tab's console for `[Aggregaytor:` log lines.

## Troubleshooting

- **Service-worker inspection** — `chrome://extensions` → Aggregaytor →
  "service worker" link under *Inspect views* opens SW DevTools. Useful probes:
  send `GET_SW_PERF` (perf counters), `GET_LLM_QUEUE_STATUS` (LLM queue/RPM
  state), `DIAGNOSE_TRAINING_DATA` (preference-model audit).
- **Stale dist / extension not picking up changes** — `pnpm run build`, then
  click the reload icon on the extension card at `chrome://extensions`, then
  refresh platform tabs. If things look really wrong: `pnpm run clean && pnpm
  run build` and re-load unpacked from `extensions/aggregaytor/dist`.
- **Watch mode not auto-reloading** — the `.build-hash` poll only runs when
  `manifest.update_url` is absent (dev builds). Confirm `dist/.build-hash`
  changes on save; if not, the Vite watcher died — restart `pnpm run dev`.
- **No messages captured** — DevTools on the platform tab → Console → look for
  `[Aggregaytor:` lines; verify the content scripts are listed under the
  extension's inspect views. Sniffies-specific debug lives in
  `localStorage.__aggregaytor_ws_debug` / `__aggregaytor_fetch_debug` (see
  README → Debug Tools).
