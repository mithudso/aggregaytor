# Runbook — Method registry & the OPS_RUN invocation surface

Purpose: let another session (human or AI) **discover and invoke any method in this
codebase without guessing** — one uniform, gated entry point instead of a bespoke
message case per method.

## The two artifacts

| Artifact | What it is | Regenerate |
|---|---|---|
| `docs/method-registry.json` | Machine-readable row per method: `file`, `line`, `name`, `kind`, `exported`, `async`, `hasDoc`, `summary`, `logs`, `errors`, `pure`, `surface`, `reachableVia`. | `pnpm run registry` |
| `docs/method-catalog.md` | Human-readable table of the same, grouped by file. | `pnpm run registry` |

Both are generated deterministically by `scripts/gen-method-registry.mjs` (no deps, no
network). CI runs `pnpm run registry:check`, which fails the build if **any method lacks
a JSDoc block** or if the artifacts are stale — so the catalog can never silently drift
from the code.

`surface` values: `api` (reachable via `chrome.runtime.sendMessage` to the service
worker), `extension` (linked into the extension bundle — content scripts, UI, packages,
adapters), `cli` (the debug-server tools), `internal` (a non-exported helper — runs via
its exported caller; `reachableVia` names that path).

## Invoking a method: `OPS_LIST` / `OPS_RUN`

Every *exported* function of the registered modules is invocable by name through one
gated command. Modules registered (see `background/operations-registry.ts`): `store`,
`core` (adapter-core), `context` (context-engine), `llm`, `search`. Operation names are
namespaced: `store.getAllContacts`, `context.tokenizeIndexText`, `core.walkPayload`,
`llm.getLLMConfig`, `search.searchMessages`, …

### Gating (identical to `DEBUG_COMMAND`)
- **Sender-origin**: allowed only when the sender is the extension itself
  (`sender.id === chrome.runtime.id && !sender.tab`). Content scripts and external
  extensions are refused unconditionally; an undefined sender fails closed.
- **Read vs write**: an operation whose name starts with a mutating verb
  (`upsert/delete/put/save/set/update/purge/clear/sync/block/hide/send/…`) is classified
  `write` and refused unless the caller passes `confirmWrite: true` (or a stored debug
  token ≥16 chars). Reads run freely for a trusted origin.
- Every failure returns `{ ok:false, error }`; `OPS_RUN` never throws.

### From the extension or an API caller (chrome.runtime messaging)
```js
// list what can be invoked
const { operations } = await chrome.runtime.sendMessage({ type: 'OPS_LIST' });

// read-only invoke
const res = await chrome.runtime.sendMessage({
  type: 'OPS_RUN', name: 'store.getAllContacts', args: [],
});
// res => { ok:true, name:'store.getAllContacts', result:[…] }

// write invoke (needs confirmWrite)
await chrome.runtime.sendMessage({
  type: 'OPS_RUN', name: 'store.upsertContacts', args: [contacts], confirmWrite: true,
});
```

### From the CLI (MCP debug bridge)
The debug MCP server (`tools/debug-server`) exposes `ops_list` and `ops_run` tools that
travel over the `ws://localhost:9222` bridge and reach the same `runOperation` through
`handleDebugCommand`. Same origin gate (the bridge sender is the extension itself), same
read/write rule (`confirmWrite`).

## Adding a new invocable operation

Nothing to wire per method. Export the function from one of the registered modules and it
is **automatically** registered on next SW load and appears in `OPS_LIST`. Then run
`pnpm run registry` so `docs/method-registry.json` + the catalog pick up the new method
(CI's `registry:check` enforces this). To register a whole new module, add it to the
`registerModule` loop in `background/operations-registry.ts`.

## Guarantees for a consuming session
- Every method has a JSDoc summary (CI-enforced) — read `summary` in the registry.
- The registry tells you, per method: does it log? does it handle errors? is it pure?
  which surface reaches it, and the exact `OPS_RUN` name (or the caller path) to activate
  it — so you never guess a method's contract or reachability.
