# JavaScript and Node.js expert context

## How to use this context

Use this file as a **behavior and API reference** when generating or reviewing JavaScript and Node.js code. Treat **MDN JavaScript** and the **Node.js API docs** as the source of truth for semantics, API contracts, and version-sensitive behavior. For exhaustive member lists beyond the condensed inventory below, jump to the linked reference indexes: MDN JavaScript Reference and the Node.js API index ([MDN JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript), [MDN JavaScript Reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference), [Node.js API index v26.1.0](https://nodejs.org/api/index.html)).

## Source scope

- **JavaScript source of truth:** MDN JavaScript overview, guide, reference, and focused built-in pages ([MDN JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript), [Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide), [Reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference)).
- **Node.js source of truth:** Node.js API docs, version **v26.1.0** as exposed by the API index page metadata and page title ([Node.js API index v26.1.0](https://nodejs.org/api/index.html)).
- These sources are primarily **language/runtime references and guides**, not a project-specific style guide. Where they do not prescribe a formatter, linter, naming scheme, or repository layout, defer to project-local conventions ([MDN JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript), [Node.js Packages](https://nodejs.org/api/packages.html)).

## Quick rules

1. Prefer **explicit module markers**: `.mjs` / `.cjs` or `package.json#"type"`; Node explicitly recommends being explicit, especially for packages ([Node.js ESM](https://nodejs.org/api/esm.html), [Node.js Packages](https://nodejs.org/api/packages.html)).
2. Use **`async` / `await` with `try` / `catch`** for promise-based APIs; async functions always return promises and uncaught exceptions reject them ([MDN async function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function), [MDN Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise), [Node.js Errors](https://nodejs.org/api/errors.html)).
3. In Node, choose the API form intentionally: **callback `fs` APIs for maximal performance**, promise APIs for ergonomics, sync APIs only when blocking is acceptable ([Node.js fs](https://nodejs.org/api/fs.html)).
4. Treat **streaming and backpressure as first-class concerns**; prefer `stream.pipeline()` / `stream/promises.pipeline()` for multi-stream flows ([Node.js Stream](https://nodejs.org/api/stream.html)).
5. `EventEmitter` listeners run **synchronously in registration order**; move work async with `setImmediate()` or `process.nextTick()` when needed ([Node.js Events](https://nodejs.org/api/events.html)).
6. For Node errors, branch on **`error.code`**, not `error.message`, because message text may change ([Node.js Errors](https://nodejs.org/api/errors.html)).
7. Avoid instance calls to non-polymorphic `Object.prototype` methods; prefer **static `Object.*` utilities** ([MDN Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)).
8. Use **`Map`** and **`Set`** when you need keyed collections, uniqueness, insertion order, or faster membership checks than array scans on average ([MDN Map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map), [MDN Set](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set)).
9. Avoid `eval()` unless you truly need dynamic script evaluation; it evaluates strings as script bodies and can throw parse/runtime exceptions ([MDN eval](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval)).
10. If you need measurements, use **`node:perf_hooks`** instead of ad hoc timing alone ([Node.js perf_hooks](https://nodejs.org/api/perf_hooks.html)).

## Language and runtime reference

### JavaScript language model

- JavaScript is a **dynamic, prototype-based, garbage-collected** language with imperative, functional, and object-oriented styles ([MDN JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript)).
- The standards basis is **ECMAScript (ECMA-262)** plus the internationalization spec **ECMA-402** ([MDN JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript)).
- MDN’s guide/reference coverage spans grammar and types, control flow, loops, functions, expressions/operators, collections, iterators/generators, promises, modules, and more ([MDN Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide), [MDN Reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference)).

### Core built-ins worth reaching for first

- **`Object`** for static object utilities; avoid relying on overridden instance methods where correctness matters ([MDN Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)).
- **`Array`** for ordered, resizable indexed collections; remember arrays are **not associative arrays** and copy operations are shallow ([MDN Array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array)).
- **`Promise`** for async results and composition of eventual success/failure ([MDN Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)).
- **`Map`** for keyed collections with unique keys and insertion-order iteration ([MDN Map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map)).
- **`Set`** for unique-value collections with insertion-order iteration and average sublinear membership checks ([MDN Set](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set)).

### Async model

- A promise can be **pending**, **fulfilled**, or **rejected**; settled means fulfilled or rejected ([MDN Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)).
- `async function` returns a **new Promise** every call; `await` suspends until fulfillment or rejection and makes ordinary `try` / `catch` viable around async code ([MDN async function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function)).
- In Node, sync APIs generally throw; async APIs may reject promises, pass an error-first callback argument, or emit `'error'` events depending on the API style ([Node.js Errors](https://nodejs.org/api/errors.html)).

### Modules and packages

- Node supports both **CommonJS** and **ECMAScript modules** ([Node.js Modules](https://nodejs.org/api/modules.html), [Node.js ESM](https://nodejs.org/api/esm.html)).
- CommonJS uses `require()` and `module.exports`; each file is a module and local variables remain private to the file wrapper ([Node.js Modules](https://nodejs.org/api/modules.html)).
- ESM uses `import` / `export`; explicit markers are `.mjs`, `.cjs`, or `package.json#"type"` ([Node.js ESM](https://nodejs.org/api/esm.html), [Node.js Packages](https://nodejs.org/api/packages.html)).
- Node recommends authors be **explicit** about the package `"type"` field, even for all-CommonJS packages, because it avoids ambiguity and helps tooling ([Node.js Modules](https://nodejs.org/api/modules.html), [Node.js Packages](https://nodejs.org/api/packages.html)).
- In Node ESM, **relative import specifiers require file extensions** ([Node.js ESM](https://nodejs.org/api/esm.html)).

### Node runtime areas to know cold

- **`node:process`**: process info/control, environment, exit lifecycle, warnings, permission checks ([Node.js Process](https://nodejs.org/api/process.html), [Node.js Permissions](https://nodejs.org/api/permissions.html)).
- **`node:events`**: `EventEmitter` and synchronous listener dispatch ([Node.js Events](https://nodejs.org/api/events.html)).
- **`node:fs` / `node:fs/promises`**: callback, promise, and sync filesystem APIs ([Node.js fs](https://nodejs.org/api/fs.html)).
- **`node:stream` / `node:stream/promises`**: readable/writable/duplex/transform streams, pipeline/finalization helpers ([Node.js Stream](https://nodejs.org/api/stream.html)).
- **`node:console`**: logging to stdout/stderr or custom streams, with platform/stream-dependent sync behavior ([Node.js Console](https://nodejs.org/api/console.html)).
- **`node:test`** and **`node:assert/strict`**: built-in test runner and strict assertions ([Node.js Test Runner](https://nodejs.org/api/test.html), [Node.js Assert](https://nodejs.org/api/assert.html)).
- **`node:perf_hooks`**: performance marks, measures, and event-loop utilization ([Node.js perf_hooks](https://nodejs.org/api/perf_hooks.html)).

## Methods and APIs inventory

This is a **high-value condensed inventory**, not a verbatim dump of every member in every built-in. For exhaustive lists, use the linked reference pages directly.

### JavaScript core

| API | Method / form | Purpose | Important params/options | Return / async behavior | Caveats |
|---|---|---|---|---|---|
| `Promise` | `then(onFulfilled, onRejected)` | Chain fulfillment/rejection handlers to an eventual result ([MDN Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)) | fulfillment and rejection handlers | Returns a new promise | Handlers still run when attached after settlement; avoid mixing styles inconsistently |
| `Promise` | `catch(onRejected)` | Handle rejection paths ([MDN Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)) | rejection handler | Returns a new promise | Unhandled rejections matter in Node ([Node.js Errors](https://nodejs.org/api/errors.html)) |
| `Promise` | `finally(onFinally)` | Run cleanup regardless of outcome ([MDN Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)) | cleanup handler | Returns a new promise | Do not use it to transform resolved values |
| `async function` | `async function name(...) {}` | Define promise-returning functions with `await` support ([MDN async function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function)) | standard parameters | Always returns a promise | `await` is only valid inside async functions or modules |
| `Object` | `Object.keys(obj)` / `values(obj)` / `entries(obj)` | Enumerate own enumerable properties using static helpers ([MDN Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)) | target object | Arrays of keys/values/entries | Prefer static helpers over fragile instance/prototype assumptions |
| `Object` | `Object.defineProperty(obj, key, descriptor)` | Define a property explicitly ([MDN Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)) | property descriptor | Modified object | Prefer over deprecated `__defineGetter__` / `__defineSetter__` |
| `Array` | indexed access, `length` | Ordered, zero-based, resizable collection ([MDN Array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array)) | nonnegative integer indices | direct value access | Not associative; named properties are not array elements |
| `Map` | `set(key, value)` / `get(key)` / `delete(key)` | Key-value store with unique keys and insertion-order iteration ([MDN Map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map)) | arbitrary key values | `set()` returns map; `get()` returns value/`undefined` | Key equality is SameValueZero; object keys compare by identity |
| `Set` | `add(value)` / `has(value)` / `delete(value)` | Unique-value collection and fast membership checks on average ([MDN Set](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set)) | arbitrary values | `add()` returns set; `has()` returns boolean | Prefer over array membership scans when uniqueness and membership dominate |
| global | `eval(script)` | Evaluate a string or `TrustedScript` as a script body ([MDN eval](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval)) | script string / TrustedScript | Returns completion value | Can throw parse/runtime errors; avoid unless dynamic evaluation is truly required |

### Node.js core

| API | Method / form | Purpose | Important params/options | Return / async behavior | Caveats |
|---|---|---|---|---|---|
| `node:fs/promises` | `readFile(path, options)` / `writeFile(path, data, options)` | Promise-based file I/O ([Node.js fs](https://nodejs.org/api/fs.html)) | path, encoding/options, data | Returns a promise | Underlying threadpool work is not synchronized/threadsafe for concurrent mutations of the same file |
| `node:fs` | callback APIs like `unlink(path, cb)` | Error-first callback file I/O ([Node.js fs](https://nodejs.org/api/fs.html)) | callback as last arg | Async callback completion | Node explicitly notes callback APIs are preferable when maximal performance is required |
| `node:fs` | sync APIs like `readFileSync()` / `unlinkSync()` | Blocking filesystem operations ([Node.js fs](https://nodejs.org/api/fs.html)) | path/options | Direct return or throw | Blocks the event loop |
| `FileHandle` | `close()` / `appendFile(data, options)` | Operate on open files ([Node.js fs](https://nodejs.org/api/fs.html)) | append data/options | Promise-based | Always close explicitly; do not rely on auto-close warnings |
| `EventEmitter` | `on(event, listener)` | Register listeners ([Node.js Events](https://nodejs.org/api/events.html)) | event name, listener | Returns emitter | Listener callbacks run synchronously in registration order |
| `EventEmitter` | `once(event, listener)` | Register a one-time listener ([Node.js Events](https://nodejs.org/api/events.html)) | event name, listener | Returns emitter | Good for one-shot lifecycle or readiness events |
| `EventEmitter` | `emit(event, ...args)` | Trigger listeners ([Node.js Events](https://nodejs.org/api/events.html)) | event name, arbitrary args | Boolean | Return values from listeners are ignored |
| `node:stream` | `pipeline(source, ...transforms, destination[, options])` | Compose streams with proper teardown/error forwarding ([Node.js Stream](https://nodejs.org/api/stream.html)) | streams/transforms/options | Callback or promise variant | Prefer over manual pipe chains in nontrivial flows |
| `node:stream` | `finished(stream, ...)` | Detect when a stream ends/errors ([Node.js Stream](https://nodejs.org/api/stream.html)) | stream/options | Callback or promise variant | Use for lifecycle completion instead of ad hoc listeners |
| `Readable` | `Readable.from(iterable, options)` | Create readable streams from iterables/async iterables ([Node.js Stream](https://nodejs.org/api/stream.html)) | iterable, options | Returns a readable stream | Useful bridge between iterator-based and stream-based code |
| `node:process` | `process.on('exit' | 'beforeExit' | ...)` | Observe lifecycle events ([Node.js Process](https://nodejs.org/api/process.html)) | event name, listener | Event-driven | `'exit'` listeners must only do synchronous work |
| `node:process` | `process.exit(code)` / `process.exitCode = n` | Control termination status ([Node.js Process](https://nodejs.org/api/process.html)) | exit code | Terminates or sets code | Explicit exit skips normal async continuation |
| `process.permission` | `permission.has(scope[, reference])` | Check permission model grants at runtime ([Node.js Permissions](https://nodejs.org/api/permissions.html)) | scope and optional reference | Boolean | Only exists when permission model is enabled |
| CommonJS | `require(specifier)` / `module.exports` | Load/export CommonJS modules ([Node.js Modules](https://nodejs.org/api/modules.html)) | module specifier | Module value | `require()` always uses the CommonJS loader |
| ESM | `import ... from` / `import()` / `export` | Load/export ES modules ([Node.js ESM](https://nodejs.org/api/esm.html)) | module specifier | Static or dynamic module loading | Relative ESM specifiers require extensions |
| `node:console` | `console.log()` / `error()` / `warn()` | Write diagnostics to stdout/stderr ([Node.js Console](https://nodejs.org/api/console.html)) | printf-like args or objects/errors | Writes to backing streams | Console sync/async behavior depends on backing stream/platform |
| `node:test` | `test(name, fn)` / `t.test(...)` | Define top-level tests and subtests ([Node.js Test Runner](https://nodejs.org/api/test.html)) | test name and sync/promise/callback fn | Test result tracked by runner | Returning a promise and using `done` together fails |
| `node:assert/strict` | `assert.equal` / `deepStrictEqual` / etc. | Verify invariants in strict assertion mode ([Node.js Assert](https://nodejs.org/api/assert.html)) | actual, expected, optional message | Throws on failure | Prefer strict assertion mode; messages can be strings, `Error`, or functions |
| `node:perf_hooks` | `performance.mark()` / `measure()` / `clearMarks()` | Performance instrumentation ([Node.js perf_hooks](https://nodejs.org/api/perf_hooks.html)) | names and optional boundaries | Entries recorded in timeline | Clear marks/measures when appropriate to keep timelines manageable |
| `node:perf_hooks` | `performance.eventLoopUtilization()` | Measure event loop utilization ([Node.js perf_hooks](https://nodejs.org/api/perf_hooks.html)) | optional previous snapshots | Utilization object | Use for real event-loop pressure instead of guesswork |

## Coding standards and best practices from the official docs

### Naming

- The official sources here do **not** prescribe a universal naming convention for variables, files, or functions. Follow project-local conventions, while keeping module boundaries and API semantics explicit ([MDN Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide), [Node.js Packages](https://nodejs.org/api/packages.html)).

### Project structure

- Node’s package docs define a package as a folder tree rooted at `package.json` and discuss authoring `package.json` fields such as `"type"`, `"exports"`, and `"imports"` ([Node.js Packages](https://nodejs.org/api/packages.html)).
- MDN’s modules guide demonstrates splitting code into dedicated module files and directories as projects grow ([MDN Modules Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)).
- Prefer a structure that makes module boundaries obvious and keeps package/module system intent explicit ([Node.js ESM](https://nodejs.org/api/esm.html), [Node.js Packages](https://nodejs.org/api/packages.html)).

### Documentation style

- These sources emphasize **clear API contracts**: explicit parameters, return values, exceptions, and version history on Node pages; syntax and behavior sections on MDN pages ([MDN Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise), [Node.js fs](https://nodejs.org/api/fs.html), [Node.js ESM](https://nodejs.org/api/esm.html)).
- Mirror that style in code-facing docs: document parameters, return types, failure modes, async behavior, and version-sensitive behavior when relevant.

### Error handling

- Use `try` / `catch` for synchronous exceptions and for `await`-based promise flows ([MDN Guide: control flow and error handling](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Control_flow_and_error_handling), [MDN async function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function)).
- In Node, understand the API’s error channel before using it: sync throw, promise rejection, callback-first error, or emitted `'error'` event ([Node.js Errors](https://nodejs.org/api/errors.html)).
- Match Node errors by **`error.code`**, not by message text ([Node.js Errors](https://nodejs.org/api/errors.html)).

### Async / await usage

- Prefer `async` / `await` when consuming promise-based APIs because it simplifies promise consumption while preserving `try` / `catch` ergonomics ([MDN async function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function)).
- Remember every async function call returns a new promise, even when returning a non-promise value ([MDN async function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function)).
- In tests, use either promise-based async tests **or** callback-style tests, but not both in the same test ([Node.js Test Runner](https://nodejs.org/api/test.html)).

### Validation and sanitization

- The official docs in scope do not define a universal validation library or app-layer sanitization standard.
- They do, however, stress understanding coercion and object/property semantics, and note `eval()` only accepts strings or `TrustedScript` and can be restricted under Trusted Types/CSP ([MDN eval](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval), [MDN Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)).
- Practical rule: validate inputs at boundaries, avoid dynamic code evaluation, and prefer explicit APIs over implicit coercion-heavy paths.

### Logging

- Use `console.log`, `console.error`, and `console.warn` for simple diagnostics; use `Console` with custom streams when you need output routing control ([Node.js Console](https://nodejs.org/api/console.html)).
- Do not assume console methods are always sync or always async; behavior depends on the backing stream/platform ([Node.js Console](https://nodejs.org/api/console.html)).

### Testing expectations

- Prefer the built-in **`node:test`** runner when you want official, zero-dependency test semantics from Node itself ([Node.js Test Runner](https://nodejs.org/api/test.html)).
- Prefer **strict assertions** from `node:assert/strict` or `strict as assert` ([Node.js Assert](https://nodejs.org/api/assert.html)).
- Structure related checks as subtests when hierarchy improves readability, and await subtests that must finish before a parent completes ([Node.js Test Runner](https://nodejs.org/api/test.html)).

### Performance guidance

- Use callback `fs` APIs when **maximal performance** matters; promise APIs cost more in time and allocations but are often easier to compose ([Node.js fs](https://nodejs.org/api/fs.html)).
- Be explicit about module type to avoid Node’s syntax-detection fallback and the associated performance cost on ambiguous files ([Node.js Packages](https://nodejs.org/api/packages.html)).
- Prefer `Map`/`Set` for workloads that benefit from average sublinear lookups or membership checks ([MDN Map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map), [MDN Set](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set)).
- Use `node:perf_hooks` for timing and event-loop measurements instead of guessing ([Node.js perf_hooks](https://nodejs.org/api/perf_hooks.html)).

### Security guidance

- Node’s permission model is a **seat belt**, not a sandbox; it is designed to reduce accidental access by trusted code and **does not protect against malicious code** ([Node.js Permissions](https://nodejs.org/api/permissions.html)).
- Avoid `eval()` unless dynamic script evaluation is truly necessary; it parses and executes source strings and can throw syntax/runtime exceptions ([MDN eval](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval)).
- Be careful with object/prototype mutation; MDN explicitly calls out prototype-based behavior as powerful but potentially dangerous, including prototype pollution concerns ([MDN Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object)).

## Practical defaults for future coding tasks

- Default to **ES modules** in new Node projects unless compatibility constraints require CommonJS; when using CommonJS, be explicit about it in `package.json` or file extensions ([Node.js ESM](https://nodejs.org/api/esm.html), [Node.js Packages](https://nodejs.org/api/packages.html)).
- Use **promise-based APIs + `async` / `await`** for readability, except in the few hot paths where Node explicitly documents callback APIs as the better performance choice ([Node.js fs](https://nodejs.org/api/fs.html), [MDN async function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function)).
- Prefer **`Map`** over plain object dictionaries when keys are not naturally string-only or when insertion order and reliable membership semantics matter ([MDN Map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map)).
- Prefer **`Set`** over arrays for deduplication and frequent membership checks ([MDN Set](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set)).
- Prefer **`stream.pipeline()`** for nontrivial streaming chains and **`node:test` + `node:assert/strict`** for built-in testing ([Node.js Stream](https://nodejs.org/api/stream.html), [Node.js Test Runner](https://nodejs.org/api/test.html), [Node.js Assert](https://nodejs.org/api/assert.html)).

## Known ambiguities / version-sensitive notes

- **Node version matters.** This file is grounded in the Node.js API docs for **v26.1.0** ([Node.js API index v26.1.0](https://nodejs.org/api/index.html)).
- **MDN is a living reference.** It may mention features that are documented as browsers/runtimes implement them, sometimes before full standard publication; always confirm runtime support for the target environment ([MDN JavaScript](https://developer.mozilla.org/en-US/docs/Web/JavaScript)).
- **Permission model caveat:** available permissions and flags are Node-version-sensitive and require `--permission`; do not treat them as a general sandboxing boundary ([Node.js Permissions](https://nodejs.org/api/permissions.html)).
- **Module resolution remains version- and package-sensitive.** `"type"`, `"exports"`, `"imports"`, file extensions, and syntax detection all affect behavior; be explicit rather than relying on fallback heuristics ([Node.js Modules](https://nodejs.org/api/modules.html), [Node.js ESM](https://nodejs.org/api/esm.html), [Node.js Packages](https://nodejs.org/api/packages.html)).
- **This file is intentionally condensed.** For exhaustive APIs and all members, use the linked MDN built-in pages and Node API module pages directly ([MDN Reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference), [Node.js API index v26.1.0](https://nodejs.org/api/index.html)).
