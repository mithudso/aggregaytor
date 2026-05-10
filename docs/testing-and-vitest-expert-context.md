# Testing and Vitest expert context

## How to use this context

Use this file as a **practical Vitest reference** when writing tests, reviewing test suites, diagnosing flaky behavior, choosing mocking strategies, tuning configuration, or interpreting coverage and snapshot output. Treat the official **Vitest Guide**, **API**, and **Config** reference as the source of truth for runner behavior, supported helpers, configuration semantics, and browser-mode constraints ([Vitest guide](https://vitest.dev/guide/), [Vitest API](https://vitest.dev/api/), [Vitest config](https://vitest.dev/config/)).

**Version note:** this file is based on the current rolling Vitest docs as accessed on **2026-05-10**. The docs referenced here include features explicitly labeled for later versions such as **Vitest 4.1** options like object-form `retry`, `tags`, and `meta`, so version-sensitive features are called out where they matter ([Vitest API](https://vitest.dev/api/)).

## Source scope

- **Core usage and workflow:** guide and getting-started materials ([Vitest guide](https://vitest.dev/guide/)).
- **APIs and task semantics:** `test` / `it`, options, and related test-runner APIs ([Vitest API](https://vitest.dev/api/)).
- **Configuration and project setup:** config reference and merge/override behavior ([Vitest config](https://vitest.dev/config/)).
- **Mocking:** mocks, spies, module mocking, timers, and browser-mode limits ([Vitest mocking](https://vitest.dev/guide/mocking.html)).
- **Coverage:** coverage providers, tradeoffs, and setup ([Vitest coverage](https://vitest.dev/guide/coverage.html)).
- **Snapshots:** snapshot files, inline snapshots, and review expectations ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)).
- **Browser execution:** browser mode, providers, and CI/local considerations ([Vitest browser mode](https://vitest.dev/guide/browser/)).

## Quick rules

1. Keep tests in files containing **`.test.`** or **`.spec.`** by default, because that is Vitest’s default file pattern expectation ([Vitest guide](https://vitest.dev/guide/)).
2. Prefer **`async` tests and returned promises** over legacy done-callback patterns; Vitest explicitly documents promise-based async completion ([Vitest API](https://vitest.dev/api/)).
3. Reset, clear, or restore mocks between tests; the mocking guide explicitly warns about mock state leaking across test runs ([Vitest mocking](https://vitest.dev/guide/mocking.html)).
4. Use snapshots for **unexpected output-change detection**, and commit snapshot artifacts alongside code so they are reviewed like normal code changes ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)).
5. Treat browser mode as a real environment with **limitations and provider-specific tradeoffs**, not as a transparent clone of Node mode ([Vitest browser mode](https://vitest.dev/guide/browser/), [Vitest mocking](https://vitest.dev/guide/mocking.html)).
6. Start with **V8 coverage** unless you have a concrete reason to switch; the docs call it the recommended option and note that its report accuracy matches Istanbul since Vitest `v3.2.0` ([Vitest coverage](https://vitest.dev/guide/coverage.html)).
7. Keep config intentional: `vitest.config.ts` has **higher priority** than `vite.config.ts` and will override it rather than merge implicitly ([Vitest config](https://vitest.dev/config/)).
8. Use retries and repeats deliberately for flaky-test diagnosis, but do not let them become a substitute for isolation and deterministic setup ([Vitest API](https://vitest.dev/api/)).

## Core Vitest model

### What Vitest is

- Vitest is described as a **next generation testing framework powered by Vite** ([Vitest guide](https://vitest.dev/guide/)).
- It expects a local installation in `package.json` in normal usage, though `npx vitest` also works when needed ([Vitest guide](https://vitest.dev/guide/)).
- Current baseline requirements in the guide are **Vite >= 6.0.0** and **Node >= 20.0.0** ([Vitest guide](https://vitest.dev/guide/)).

### Core test authoring

- `test` and `it` are aliases that define a test case with a name, body, and optional timeout or options object ([Vitest API](https://vitest.dev/api/)).
- If a test body returns a promise, Vitest waits for it and fails the test if the promise rejects, which makes promise-returning and `async` tests first-class patterns ([Vitest API](https://vitest.dev/api/)).
- If the test body is omitted, the test is marked as `todo` ([Vitest API](https://vitest.dev/api/)).

## Suites, setup, hooks, and lifecycle

- Vitest organizes test work around tests and suites and supports option chaining like `test.skip(...)` or object-form options such as `{ skip: true }` ([Vitest API](https://vitest.dev/api/)).
- Timeout behavior defaults to **5 seconds** and can be configured globally via `testTimeout` or per-test via timeout options ([Vitest API](https://vitest.dev/api/)).
- The config system is where broader lifecycle/setup choices belong; if using a Vite config, Vitest reads it, but a dedicated `vitest.config.ts` takes precedence and overrides Vite config rather than layering silently on top ([Vitest config](https://vitest.dev/config/)).

## Mocking, spies, fake timers, and module mocking

- Vitest’s mocking surface is centered on the **`vi` helper**, which can be imported from `vitest` or exposed globally if globals are enabled in config ([Vitest mocking](https://vitest.dev/guide/mocking.html), [Vitest config](https://vitest.dev/config/)).
- The mocking guide points new users first to **`vi.fn`**, **`vi.spyOn`**, and **`vi.mock`** ([Vitest mocking](https://vitest.dev/guide/mocking.html)).
- `vi.mock` is **hoisted to the top of the file**, which is a crucial behavior when designing module-mocking patterns ([Vitest mocking](https://vitest.dev/guide/mocking.html)).
- Module spying and export spying have **browser-mode limitations**; the docs explicitly note that some `vi.spyOn` patterns do not work in Browser Mode ([Vitest mocking](https://vitest.dev/guide/mocking.html), [Vitest browser mode](https://vitest.dev/guide/browser/)).
- `vi.setSystemTime` can be used to mock the current date, and fake timers also affect `Date` behavior ([Vitest mocking](https://vitest.dev/guide/mocking.html)).
- The guide explicitly warns that mocks should be **cleared or restored before/after each test run** to avoid cross-test contamination ([Vitest mocking](https://vitest.dev/guide/mocking.html)).

## Async testing patterns

- Promise-returning tests and `async` functions are the standard async path in Vitest, with the runner waiting for resolution or rejection ([Vitest API](https://vitest.dev/api/)).
- The docs specifically point users coming from Jest’s `done` callback toward `async`-function-based patterns instead ([Vitest API](https://vitest.dev/api/)).
- For async concurrent snapshot tests, the snapshot guide warns that you must use the local **Test Context `expect`** so the correct test is associated with the snapshot assertion ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)).

## Coverage

- Vitest supports two coverage providers: **`v8`** and **`istanbul`** ([Vitest coverage](https://vitest.dev/guide/coverage.html)).
- **`v8` is the default provider**, and the docs explicitly label it the recommended option ([Vitest coverage](https://vitest.dev/guide/coverage.html)).
- Since **Vitest `v3.2.0`**, V8 coverage uses AST-based remapping and is documented as having report accuracy equivalent to Istanbul while generally keeping better speed and lower memory usage ([Vitest coverage](https://vitest.dev/guide/coverage.html)).
- Coverage-provider choice is configured through `test.coverage.provider` ([Vitest coverage](https://vitest.dev/guide/coverage.html)).

## Snapshots

- Snapshot tests compare current output against a stored snapshot file and fail when the result changes unexpectedly or the reference needs updating ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)).
- Vitest recommends committing snapshot artifacts and reviewing them during code review ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)).
- Vitest supports both **external snapshot files** and **inline snapshots** via `toMatchInlineSnapshot()` ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)).
- Snapshot rendering uses `@vitest/pretty-format`, and formatting can be influenced through `snapshotFormat` config or custom serializers/matchers ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)).

## Browser mode

- Browser Mode lets tests run in an actual browser environment with browser globals like `window` and `document` ([Vitest browser mode](https://vitest.dev/guide/browser/)).
- Vitest always requires a browser provider, with documented options including **`preview`**, **Playwright**, and **WebdriverIO** providers ([Vitest browser mode](https://vitest.dev/guide/browser/)).
- The docs recommend **Playwright** if you are starting fresh because it supports parallel execution and is better suited than the default preview provider for local and CI execution ([Vitest browser mode](https://vitest.dev/guide/browser/)).
- The default preview provider simulates events rather than using Chrome DevTools Protocol, which is why the docs recommend switching to Playwright or WebdriverIO for stronger real-world confidence ([Vitest browser mode](https://vitest.dev/guide/browser/)).

## Configuration strategy

- If Vitest finds a `vite.config`, it reads it for plugin and setup alignment, but a separate **`vitest.config.ts` overrides `vite.config.ts`** rather than merging implicitly ([Vitest config](https://vitest.dev/config/)).
- If you need both Vite and Vitest configuration, the docs show using `mergeConfig` explicitly ([Vitest config](https://vitest.dev/config/)).
- Vitest supports using Vite options at the top level in config; they should not be nested under `test` unless they are actually Vitest `test` options ([Vitest config](https://vitest.dev/config/)).
- `configDefaults` can be imported and extended when you want to change defaults without re-creating them manually ([Vitest config](https://vitest.dev/config/)).

## Methods, APIs, config options, and patterns inventory

This is a **condensed testing-focused inventory**, not an exhaustive copy of the full Vitest API surface.

| API / pattern | Purpose | Important args / options | Output / effect | Common usage | Caveats / anti-patterns |
|---|---|---|---|---|---|
| `test()` / `it()` | Define a test case ([Vitest API](https://vitest.dev/api/)) | name, body, timeout or options object | Registers runnable test | Standard unit/integration tests | Omitted body marks test as `todo` |
| `test.skip()` / `{ skip: true }` | Skip a test ([Vitest API](https://vitest.dev/api/)) | chained modifier or options object | Prevents execution | Temporarily disabled tests | Easy to leave behind permanently |
| `timeout` / `testTimeout` | Control test timeout ([Vitest API](https://vitest.dev/api/)) | per-test timeout, global `testTimeout` | Fails long-running tests | Slow integration or browser tests | Last-argument timeout cannot be combined with options object in the old form |
| `retry` | Retry failing tests ([Vitest API](https://vitest.dev/api/)) | number or object with `count`, `delay`, `condition` | Retries failures | Flaky-test diagnosis or transient-failure mitigation | Object form is version-sensitive and functions are not allowed in config because config is serialized |
| `repeats` | Re-run a test multiple times ([Vitest API](https://vitest.dev/api/)) | repeat count | Multiple executions | Debugging flaky tests | Repetition is diagnostic, not a root-cause fix |
| `tags` | Attach user tags to tests ([Vitest API](https://vitest.dev/api/)) | string array | Structured grouping/filtering metadata | Categorize DB, flaky, browser tests | Fails if tags are not declared and strict tag behavior is enabled |
| `meta` | Attach reporter-visible metadata ([Vitest API](https://vitest.dev/api/)) | `TaskMeta` object | Metadata available to reporters | Reporting or custom tooling | Top-level properties merge, nested objects are not deeply merged |
| `expect()` | Perform assertions ([Vitest guide](https://vitest.dev/guide/), [Vitest snapshot](https://vitest.dev/guide/snapshot.html)) | matcher chain | Test passes/fails based on matcher | Core assertion entry point | Use context-local `expect` in async concurrent snapshot tests |
| `vi.fn()` | Create mock function ([Vitest mocking](https://vitest.dev/guide/mocking.html)) | optional implementation | Spy/mock callable | Fake collaborators and inspect calls | Must be reset/cleared/restored appropriately |
| `vi.spyOn()` | Spy on methods/getters/exports ([Vitest mocking](https://vitest.dev/guide/mocking.html)) | target, key, optional accessor kind | Wraps existing implementation or replaces it | Partial mocking and observation | Some export-spying patterns do not work in Browser Mode |
| `vi.mock()` | Mock a module ([Vitest mocking](https://vitest.dev/guide/mocking.html)) | module path/import, factory | Replaces external module access | Full or partial module mocking | Hoisted; only mocks external access, not internal same-module calls |
| `vi.setSystemTime()` | Mock current time ([Vitest mocking](https://vitest.dev/guide/mocking.html)) | date/time value | Changes perceived current time | Date-sensitive tests | Does not auto-reset between tests |
| `toMatchSnapshot()` | Compare value to stored snapshot ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)) | received value from `expect` | Snapshot assertion against file | Stable output regression checks | Snapshot churn needs review discipline |
| `toMatchInlineSnapshot()` | Store snapshot inline in test file ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)) | inline snapshot content or auto-update | Inline snapshot assertion | Small, local snapshot cases | Inline snapshots can clutter tests if overused |
| `coverage.provider` | Select coverage engine ([Vitest coverage](https://vitest.dev/guide/coverage.html)) | `v8` or `istanbul` | Coverage collection/reporting backend | Coverage tuning | V8 is default; Istanbul may still suit some module-heavy cases |
| `defineConfig({ test: ... })` | Configure Vitest ([Vitest config](https://vitest.dev/config/)) | `test` options object | Project-level runner behavior | Central config file | Separate `vitest.config` overrides `vite.config` |
| `configDefaults` | Extend defaults safely ([Vitest config](https://vitest.dev/config/)) | spread/merge with local values | Reuse built-in default config | Adjust excludes or defaults | Prefer extension over retyping defaults manually |
| Browser providers | Run tests in browser environment ([Vitest browser mode](https://vitest.dev/guide/browser/)) | `preview`, Playwright, WebdriverIO | Browser-based execution | DOM and browser-global testing | Preview is easier to start with but weaker for CI realism |

## Testing standards and best practices from the docs

### Test structure

- Keep tests in conventional filenames and wire Vitest through normal package scripts or explicit CLI usage ([Vitest guide](https://vitest.dev/guide/)).
- Use the core test primitives consistently instead of building ad hoc wrappers that obscure Vitest semantics ([Vitest API](https://vitest.dev/api/)).

### Naming

- Give tests explicit names that describe expected behavior, since the runner output and snapshots both surface those names directly ([Vitest guide](https://vitest.dev/guide/), [Vitest snapshot](https://vitest.dev/guide/snapshot.html)).
- Prefer string names over function-name inference when clarity matters, because the docs note that function-first overloads use the function’s `name` property rather than invoking it ([Vitest API](https://vitest.dev/api/)).

### Isolation

- Clear or restore mocks between tests to avoid state leakage ([Vitest mocking](https://vitest.dev/guide/mocking.html)).
- Be careful with time mocks and cached object patterns because they can persist across test boundaries if you do not reset them manually ([Vitest mocking](https://vitest.dev/guide/mocking.html)).

### Mocking strategy

- Prefer the least invasive mock shape that answers the test question: function mock, spy, partial module mock, or full module mock ([Vitest mocking](https://vitest.dev/guide/mocking.html)).
- Remember that `vi.mock` affects external module access but does not magically rewrite internal same-module calls ([Vitest mocking](https://vitest.dev/guide/mocking.html)).

### Async test discipline

- Use `async`/promise-based patterns as the default async style ([Vitest API](https://vitest.dev/api/)).
- Use retries and repeats for flaky diagnosis or controlled reruns, not as a substitute for deterministic test setup ([Vitest API](https://vitest.dev/api/)).

### Snapshot usage

- Use snapshots when output stability matters and commit snapshot artifacts so changes are visible in code review ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)).
- Prefer inline snapshots for small local assertions and external snapshots for broader serialized output where separate files remain readable ([Vitest snapshot](https://vitest.dev/guide/snapshot.html)).

### Coverage interpretation

- Prefer `v8` first because the docs recommend it and document strong speed/memory characteristics with equivalent accuracy since `v3.2.0` ([Vitest coverage](https://vitest.dev/guide/coverage.html)).
- Treat coverage-provider changes as engineering choices with tradeoffs, not as purely cosmetic config switches ([Vitest coverage](https://vitest.dev/guide/coverage.html)).

### Flaky test prevention

- Keep mocks, timers, and shared state under control, because the official mocking guidance centers state reset as a core hygiene rule ([Vitest mocking](https://vitest.dev/guide/mocking.html)).
- Use `repeats` and `retry` to investigate and contain flakiness, while still fixing the underlying cause ([Vitest API](https://vitest.dev/api/)).

### Config defaults and override strategy

- Use `vitest.config.ts` only when you actually want dedicated test config, because it overrides `vite.config.ts` ([Vitest config](https://vitest.dev/config/)).
- Use `mergeConfig` and `configDefaults` when you want intentional extension rather than accidental replacement ([Vitest config](https://vitest.dev/config/)).

## Practical defaults for future testing and review tasks

- Start by deciding whether a test needs Node-mode speed, browser-mode realism, or a specialized provider ([Vitest browser mode](https://vitest.dev/guide/browser/)).
- Start mocking decisions with `vi.spyOn` or focused mocks when possible, and escalate to broader module mocking only when needed ([Vitest mocking](https://vitest.dev/guide/mocking.html)).
- Start flaky-test diagnosis with repeat/retry tools and state-reset checks before rewriting the whole suite ([Vitest API](https://vitest.dev/api/), [Vitest mocking](https://vitest.dev/guide/mocking.html)).

## Known ambiguities / version-sensitive notes

- The Vitest docs are a **rolling documentation set**, and some features are explicitly marked by version, such as `retry` object options and `tags` / `meta` support in **Vitest 4.1** ([Vitest API](https://vitest.dev/api/)).
- Coverage guidance changed materially with **Vitest `v3.2.0`**, where V8 coverage remapping reached Istanbul-equivalent report accuracy ([Vitest coverage](https://vitest.dev/guide/coverage.html)).
- Browser Mode has explicit limitations around some spying/mocking patterns, so examples that work in Node mode may need adaptation there ([Vitest mocking](https://vitest.dev/guide/mocking.html), [Vitest browser mode](https://vitest.dev/guide/browser/)).
- This file is intentionally condensed. For exhaustive matcher, `vi`, project, and config details, follow the citations back to the Vitest Guide, API, and Config docs ([Vitest guide](https://vitest.dev/guide/), [Vitest API](https://vitest.dev/api/), [Vitest config](https://vitest.dev/config/)).
