# Onboarding — New Contributor Walkthrough

A guided first week with the Aggregaytor codebase. Budget ~2 hours for the
reading and first build; the rest is orientation you'll return to.

---

## 1. Read these, in this order

1. **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** — the primary document. Code map,
   message-dispatch model, storage layer, the 15 caching layers, content-script
   architecture, and the "Things NOT to do" list. Everything else assumes it.
2. **`CLAUDE.md`** (repo root) — the condensed working rules: commands, build
   gotchas, and the critical invariants. Written for AI assistants but it's the
   best human cheat-sheet too.
3. **[`COMPONENTS.md`](./COMPONENTS.md)** — component-level overview of the
   codebase (per-package/per-module detail below the architecture level).
4. Skim the **README** for the user-facing feature set — it tells you what a
   piece of code is *for*, less how it's wired.
5. When touching tests or security-sensitive code:
   [`TESTING.md`](./TESTING.md), [`SECURITY.md`](./SECURITY.md), and
   [`CDO-REPORT-2026-08-30.md`](./CDO-REPORT-2026-08-30.md) (the most recent
   deep audit — its BLOCKED table is a map of the known sharp edges).

## 2. First build

```bash
pnpm install
pnpm run build
pnpm run test        # expect 198/198
pnpm run lint        # expect 0 problems
```

Load `extensions/aggregaytor/dist` unpacked at `chrome://extensions`
([`INSTALLATION.md`](./INSTALLATION.md) has the click-by-click), open the side
panel, open a supported site, and watch messages arrive. Then start watch mode
(`cd extensions/aggregaytor && pnpm run dev`) — the service worker auto-reloads
itself via `dist/.build-hash` polling.

## 3. Where things live

| You want to change… | Go to |
|---|---|
| Message routing / any `chrome.runtime` message | `extensions/aggregaytor/background/service-worker.ts` (single ~700-case switch) |
| LLM behavior, providers, prompt modules, caches | `extensions/aggregaytor/background/llm.ts` |
| Side-panel UI | `extensions/aggregaytor/sidepanel/panel.js` (~3500 lines vanilla JS) |
| Platform parsing (what counts as a message) | `adapters/<platform>/src/` |
| Page-side interception & bridges | `extensions/aggregaytor/content/<platform>.ts` + `<platform>-bridge.ts` |
| Storage, doc shapes, indexes | `packages/store/src/` (`types.ts` lists every doc shape) |
| Shared types (`UnifiedMessage`, `Platform`) | `packages/adapter-core/src/types.ts` |
| Dedup / search / hashing | `packages/context-engine/src/` |

## 4. The two-worlds content-script model (internalize this)

Every platform gets **two scripts**, because Chrome MV3 splits the world:

- **MAIN world** (`content/<platform>.ts`, built as an IIFE): runs in the
  page's own JS context, so it *can* monkey-patch `window.fetch` / `WebSocket`
  — but it *cannot* touch `chrome.*` APIs, and the host page can see anything
  it puts on `window`.
- **ISOLATED world** (`content/<platform>-bridge.ts`): a normal content script
  that *can* use `chrome.runtime` — but cannot see the page's JS.

They talk via `CustomEvent('__aggregaytor_message')`. The bridge injects the
MAIN-world script, then relays events to the service worker — but only event
types on its per-platform relay allowlist, because *any* page script can forge
that CustomEvent. Treat everything crossing that boundary as untrusted.

## 5. Invariants you must never break

The full list with rationale is in `ARCHITECTURE.md` → "Things NOT to do" and
`CLAUDE.md` → "Critical invariants". The ones people trip on first:

- No new `window.*` exposure from MAIN-world scripts.
- No `setInterval` in the service worker (use `chrome.alarms`); the SW dies
  after ~30s idle, so no in-memory state you can't rebuild.
- Hot-path settings reads go through `getCachedStorage`, never raw
  `chrome.storage.local.get()`; new settings keys must wire
  `invalidateStorageCache(key)` on save.
- Bulk writes are exactly 2 store calls (`allDocs({keys})` then `bulkDocs`).
- Every new cache documents its invalidation trigger next to its declaration.
- New `thread_meta` signal fields go into `SIGNAL_FIELDS`
  (`packages/store/src/thread-meta.ts`) or auto-train ignores them.
- Version source of truth is `extensions/aggregaytor/manifest.json`; release
  commits are `vX.Y.Z: <summary>`.

## 6. Picking up a first task

1. Good first areas: an untested adapter (grindr/doublelist/adam4adam/gmail/
   yahoo have zero tests — adding parser tests teaches you the adapter layer
   safely), or an item from the BLOCKED/advisory tables in
   [`CDO-REPORT-2026-08-30.md`](./CDO-REPORT-2026-08-30.md) — but read the
   "why blocked" column first; several need a data-migration or product
   decision, not just code.
2. Before coding, re-read the relevant `ARCHITECTURE.md` section and check
   whether an invariant applies.
3. Develop in watch mode against a real platform tab; use the SW console
   (`chrome://extensions` → "service worker") and the `GET_SW_PERF` /
   `GET_LLM_QUEUE_STATUS` debug messages.
4. Before pushing: `pnpm run build && pnpm run lint && pnpm run test` — the
   same gate CI runs. See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for conventions
   and the full adapter-adding recipe.
