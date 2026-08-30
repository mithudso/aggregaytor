# Testing Guide

Test strategy, layout, conventions, and honest limitations. Commands assume the
repo root unless noted.

---

## What exists (the pyramid, as-is)

All automated tests are **Vitest unit tests** running in `environment: 'node'`
(root `vitest.config.ts`). There is currently no integration or browser/E2E
layer — the pyramid is a wide unit base with nothing above it.

| Suite | Files | Tests | What it covers |
|---|---|---|---|
| `packages/context-engine/__tests__/` | 5 | 45 | normalize, search, hash, entities + perf benchmark |
| `packages/adapter-core/__tests__/` | 4 | 50 | payload walker, message normalizer, perf + perf benchmark |
| `adapters/sniffies/__tests__/` | 6 | 100 | WS frame parsing, event classification, time parsing, partials, force-refresh + perf benchmark |
| `packages/store/__tests__/` | 1 | 3 | Dexie compatibility layer (`allDocs`, compound `find`, export/import) |
| **Total** | **16** | **198** | |

Key properties:

- **Isolation** — store tests use `fake-indexeddb` (`import 'fake-indexeddb/auto'`)
  with `destroyDB()` in `beforeEach`/`afterEach`, so every test gets a fresh
  in-memory IndexedDB. No test touches a real browser, network, or `chrome.*`
  API. Vitest runs with `pool: 'forks'`, `isolate: true`, and file parallelism
  pinned on.
- **Perf benchmarks** — `perf-benchmark.test.ts` in context-engine,
  adapter-core, and sniffies assert wall-clock timings. They are
  **flake-sensitive**: on a loaded machine (or slow CI runner) they can fail
  without a code regression. If a benchmark test fails in isolation, re-run it
  before assuming a real perf problem.
- The root `vitest.config.ts` excludes `**/.claude/**` so worktree checkouts of
  the repo aren't collected as duplicate test files.

## Running tests

```bash
pnpm run test                                  # everything (pnpm -r test)

# one package
cd packages/context-engine && pnpm run test
pnpm --filter @aggregaytor/store test          # same, from root

# one file / one test
cd adapters/sniffies && npx vitest run __tests__/ws-parser.test.ts
cd adapters/sniffies && npx vitest run -t "matches partial messages"

# watch mode (packages that define it)
cd packages/store && pnpm run test:watch
```

## Writing a new test

Follow the existing patterns — read
`packages/store/__tests__/db.test.ts` and
`adapters/sniffies/__tests__/ws-parser.test.ts` before writing your first one.

- Put tests in `<package>/__tests__/<topic>.test.ts`; import the code under
  test from `../src/<module>.js` (note the `.js` extension — ESM specifiers).
- Use `describe`/`it`/`expect` from `vitest` (globals are enabled, but existing
  files import explicitly — match that).
- **Prefer real behavior over mocks.** The dominant convention is: no mocking
  framework at all. Parsers are fed literal frame/payload fixtures inline
  (`'42["message",{...}]'`) and assertions check the full structured output
  with `expect(result).toEqual({...})`, including the null/garbage cases.
- For storage-backed code, use `fake-indexeddb/auto` + `destroyDB()` per test,
  as `db.test.ts` does — don't share DB state across tests.
- There is no `chrome.*` mock harness in the repo. Code that needs `chrome.*`
  is currently structured to keep parseable logic in pure modules; test the
  pure part.

## Coverage posture

**No coverage tooling is configured** — no `coverage` block in any Vitest
config, no thresholds, no reports. That is deliberate for now.

The target is **meaningful coverage of important, changed, or risky paths with
real behavior assertions** — parsers that face hostile input, storage merge
logic, dedup, anything that loses user data when wrong. It is explicitly **not**
a blanket 100%-line mandate; chasing lines on glue code produces assertion-free
tests that rot.

**The CI gate is `pnpm run test` must pass** (see
[`DEVELOPMENT.md`](./DEVELOPMENT.md) — CI runs install → build → lint → test).
When you change behavior, add or update tests in the same change.

## Known limitations (be honest with yourself)

- **~40 of the sniffies tests exercise replicated copies of parser functions,
  not the shipped code.** Several test files paste-in private helpers from the
  adapter rather than importing them, so those tests can pass while the real
  implementation drifts. The real fix is exporting those helpers from a pure
  module and importing them in tests. See
  [`CDO-REPORT-2026-08-30.md`](./CDO-REPORT-2026-08-30.md) (BLOCKED table) for
  the full finding.
- **The extension UI and content scripts are untested** — `sidepanel/panel.js`
  (~3500 lines of vanilla JS), `popup/popup.js`, the service worker's ~700-case
  message switch, and every `content/*.ts` bridge/adapter entry have no
  automated tests. Manual verification in Chrome is the only check for those
  layers.
- **Several packages pass `--passWithNoTests`** — `packages/store` (which does
  now have a small suite), and the grindr, doublelist, adam4adam, gmail, and
  yahoo adapters. A green `pnpm run test` therefore does not imply those
  adapters' parsing logic is exercised at all.
- Perf-benchmark wall-clock tests can flake under load, as noted above.
