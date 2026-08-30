# Known issues

Seeded 2026-08-30 from (a) the CDO report's BLOCKED/decision-needed table, (b) a
TODO/FIXME grep across source, (c) pre-existing tsc errors noted in the report.
Source of truth for the blocking rationale: `docs/CDO-REPORT-2026-08-30.md`.

## A. BLOCKED / decision-needed (from CDO-REPORT-2026-08-30)

### 1. `DEBUG_COMMAND` ungated — full-DB read from any content script
- **Symptom:** any injected content script (i.e. any of the six platform pages'
  extension contexts) can read messages, contacts, and dossiers via debug commands.
- **Root cause:** `chrome.runtime.onMessage` accepts messages from every content
  script and there is no debug-mode gate; the old docstring claimed a gate that
  never existed (docstring corrected, inputs hardened, limits clamped to 500).
- **Workaround:** none beyond bounded/read-mostly handlers; treat the surface as public.
- **Affected files:** `extensions/aggregaytor/background/service-worker.ts` (~line 3211), `extensions/aggregaytor/background/debug-bridge.ts`.
- **Unblock:** product decision on the gating key.

### 2. Debug WebSocket bridge unauthenticated (ws://localhost:9222)
- **Symptom:** any local process/web page reaching the bridge can call
  `execute_query` and destructive `clear_db`.
- **Root cause:** no Origin allowlist, no shared token in the bridge design.
- **Workaround:** only run the debug server on trusted machines; port collides with
  Chrome's `--remote-debugging-port` (override `AGGREGAYTOR_DEBUG_PORT`).
- **Affected files:** `tools/debug-server/src/server.ts`, SW `DEBUG_COMMAND` path.

### 3. `SEND_AUTO_RESPONSE_DIRECT` has no SW handler
- **Symptom:** quick phrases were never sent (silently).
- **Root cause:** panel emitted a message type with no case in the SW switch.
- **Workaround (applied):** rerouted through `spSend` so failures now surface;
  intended handler semantics still ambiguous.
- **Affected files:** `extensions/aggregaytor/sidepanel/panel.js`, `background/service-worker.ts`.

### 4. `ADAPTER_ERROR` has no SW case
- **Symptom:** adapter errors forwarded by bridges are silently discarded.
- **Root cause:** missing switch case; routing target (error log? notification?) ambiguous.
- **Affected files:** `extensions/aggregaytor/content/*-bridge.ts`, `background/service-worker.ts`.

### 5. MAIN↔ISOLATED CustomEvent channel unauthenticated
- **Symptom:** host page can forge filter/block/send events on `__aggregaytor_message`.
- **Root cause:** CustomEvent has no sender authentication; type allowlist filters
  event *types*, not origin.
- **Workaround:** allowlist + `event.source` guards where applicable.
- **Affected files:** all `extensions/aggregaytor/content/` pairs.
- **Unblock:** nonce-handshake architecture change.

### 6. Private data in page-origin localStorage
- **Symptom:** notes/reminders/text substitutions (including a hardcoded Kik/Snap
  handle in defaults) readable by the host site.
- **Root cause:** MAIN-world convenience storage predates the bridge-storage pattern.
- **Affected files:** `extensions/aggregaytor/content/text-expander.ts` (line ~24), sniffies bridge.
- **Unblock:** bridge-mediated storage (architecture change).

### 7. Drive/OPFS backups unencrypted
- **Symptom:** cloud/local backup files are plaintext despite AES-GCM existing in
  `export-import.ts`.
- **Root cause:** backup paths never adopted the encrypted envelope; switching now
  breaks existing restores.
- **Workaround:** manual encrypted export via the export path.
- **Affected files:** `packages/store/src/google-drive-sync.ts`, `opfs-backup.ts`.

### 8. Self-ID detection can adopt strangers' IDs
- **Symptom:** messages misclassified as `out` after the tracker latches onto a
  `userId`/`profileId` on a non-self payload node.
- **Root cause:** heuristic field-name matching without per-platform key audit.
- **Affected files:** `packages/adapter-core/src/self-id-tracker.ts`.
- **Unblock:** per-platform key audit; behavior drift risk.

### 9. Auth capture runs on every page fetch, incl. third-party
- **Symptom:** headers from unrelated third-party requests can be captured.
- **Root cause:** capture not scoped to platform API domains.
- **Affected files:** `packages/adapter-core/src/network-interceptor.ts` (~line 128).
- **Unblock:** per-platform domain verification.

### 10. FNV-1a offset-basis typo in content hash
- **Symptom:** hash outputs match no reference FNV-1a implementation.
- **Root cause:** digit-dropped offset basis constant.
- **Why open:** every persisted hash changes on fix → needs migration.
- **Affected files:** `packages/context-engine/src/hash.ts` (line 11).

### 11. LSH banding drops trailing bands
- **Symptom:** near-duplicate recall loss for signatures whose length isn't a
  multiple of the band size.
- **Why open:** persisted buckets would change.
- **Affected files:** `packages/context-engine/src/lsh.ts`.

### 12. Adapter id-scheme inconsistencies
- **Symptom:** doublelist contact/message ids never join; grindr splits contact
  identity; yahoo/grindr/a4a nondeterministic id fallbacks cause unbounded re-inserts.
- **Root cause:** no canonical per-platform id scheme.
- **Unblock:** data-model decision + doc-id migration.
- **Affected files:** `adapters/doublelist`, `adapters/grindr`, `adapters/yahoo`, `adapters/adam4adam`.

### 13. Sniffies tests exercise replicated parser copies
- **Symptom:** ~40 tests pass against copies of parser functions, not shipped code —
  a regression in the real parser can ship green.
- **Fix direction:** export the functions from a pure module and import in tests.
- **Affected files:** `adapters/sniffies/__tests__/*`.

### 14. Committed junk trees
- **Symptom:** `.claude/worktrees/elegant-volhard-19a0c9/` duplicate tree (~150 files)
  and `.playwright-mcp/` logs are committed.
- **Workaround:** vitest excludes the worktree copy.
- **Unblock:** repo-owner deletion call.

### 15. Dependency vulnerability advisories
- Dev toolchain: vitest (critical), vite/eslint/tsup (high) need **major** bumps
  (behavior risk — track via dependabot). Runtime: `form-data` via
  `@anthropic-ai/sdk`, `uuid` via `pouchdb-browser` (moderate).
- **Affected files:** root + package `package.json`s.

## B. TODO/FIXME grep (source)

| Location | Note |
|---|---|
| `extensions/aggregaytor/background/service-worker.ts:3531` | `handlePictureSend` tracks the stat but doesn't actually send the picture (TODO: platform API/DOM send) |
| `extensions/aggregaytor/sidepanel/panel.js:4595` | TODO: implement camera capture |

(Only two TODO markers exist in shipping source as of 2026-08-30; the rest of the
debt is tracked in section A and ARCHITECTURE.md "Known tech debt".)

## C. Pre-existing tsc errors (extension code)

11 pre-existing `tsc --noEmit` errors in `extensions/` are **not** part of the green
baseline — the Vite build strips types, so they don't block builds. Notable:
`ProfileFeatures.hasPhoto` boolean/number mismatch — fixing it could change the ML
feature encoding, so it's deliberately untouched. Don't "clean these up" casually;
audit the runtime impact first.

## D. Other known tech debt (carried from ARCHITECTURE.md)

- `packages/store/src/sync.ts` throws intentionally — remote CouchDB replication is
  unsupported on the Dexie store.
- `packages/ui` is essentially empty (no shared panel/popup components).
- Dynamic-vs-static import build warning for `llm.ts`/`tasks.ts` — won't fix.
- Two drifted floating-panel implementations (~200 duplicated lines) — consolidation
  advisory in the CDO report.
- gmail/yahoo/doublelist bridges lack the error-forwarding block (advisory:
  `content/bridge-common.ts`).
