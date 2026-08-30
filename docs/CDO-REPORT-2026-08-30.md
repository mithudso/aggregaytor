# Code Deep Optimizer report — 2026-08-30

Run against commit `797f7c3` (fresh clone). Snapshot: `~/.claude/skill-consolidation/backups/aggregaytor-20260830-042132/`.
Restore any file: `cp ~/.claude/skill-consolidation/backups/aggregaytor-20260830-042132/<path> <path>`

## Summary

`2 iterations · 17 of 18 fix-track passes active (T4 partial: no real-sleep/hoist candidates) · Repo profile, 9 parallel bundles, ~85 files · Final counts: Critical 0 open / High 0 open (all fixed or BLOCKED-reported) · Verify: PASS (build ✓, lint 0 problems, 198/198 tests) · Status: CONVERGED`

~190 Medium+ findings; **~160 applied**, remainder BLOCKED (ambiguous intent, persisted-data contracts, or architecture changes) — listed below so nothing is silently dropped.

## Per-iteration severity (applied fixes)

| Iter | Critical | High | Medium | Low (reported only) |
|---|---|---|---|---|
| 1 | 10 | ~30 | ~90 | ~40 |
| 2 | 0 | 1 (months→minutes, adapter-core) | 1 (lint directives) | — |

## Verify gate

| Command | Baseline | After iter 1 | After iter 2 |
|---|---|---|---|
| `pnpm run build` | PASS (icon-plugin warn) | PASS (warn gone) | PASS |
| `pnpm run lint` | PASS, 7 warnings | PASS, 5 warnings | PASS, 0 problems |
| `pnpm run test` | 198/198 | 198/198 | 198/198 |

No regressions; no bisect needed.

## Activated skills (Stage 0)

lang-js-ts, chrome-extension-expert, security-review, software-engineering-patterns (code-reviewer + coding-standards), testing-and-vitest-expert. Detected: TS/pnpm monorepo, Chrome MV3 extension, untrusted host-page input, vitest.

## Critical fixes (10)

1. **panel.js `esc()`** never escaped quotes → attribute-breakout HTML injection from platform profile data at ~30 sink sites. Rewrote as 5-char entity escaper; popup.js had no escaper at all (added).
2. **service-worker `SYNC_TASK_TO_CALENDAR`** passed an object to a positional-args function — handler threw on every call, never worked.
3. **service-worker broadcast** sent the message *before* navigating → text typed into the previous recipient's thread.
4. **adapter-core fetch interception** awaited its own JSON parse before returning the response — every matched page request slowed; a stalled body hung the page forever.
5. **All 6 adapters:** one hostile/garbage `timestamp` (e.g. `1e20`) threw `RangeError` inside the payload walker, silently dropping every later message in the response.
6. **store `migrateLegacyPouchData`** set the migrated flag even when the copy failed → pre-Dexie history permanently orphaned.
7. **store `getProtectedContactIds`** failure path returned an empty set — purge could delete blocked/archived/favorited history (comment claimed the opposite).
8. **store Google Tasks sync** ignored pagination, then deleted every local task not in the first 100 remote ones.
9. **sniffies-migrate** marked one-shot migration done even when delivery to the (often still-starting) SW failed → bookmarks/notes lost.
10. **grindr-bridge middle-click block** ran twice per click (dedupe guard only covered one of two event paths).

## High fixes (selected, ~30 applied)

- All 5 bridges: **type allowlists** on the page→bridge relay (any page script could previously reach the SW's ~700-case message switch).
- `sniffies.ts`: `event.source !== window` guard — third-party iframes could send chat messages as the user.
- MAIN-world `window.*` exposure removed (undo-hide trio, grindr hash-map lookup) per ARCHITECTURE invariant.
- LLM engine: queue-wedge on settings rejection (try/finally), infinite 429 provider-failover recursion, 60s fetch timeouts, settings-cache mutation poisoning, cache-key collisions.
- adapter auth: cache key mismatch (slug vs host) meant API-send replay never found credentials; relative-URL fetches skipped by auth capture.
- Gmail: direction test inverted (inbound labeled outbound); thread-id used as message-id (threads collapsed to one message).
- Doublelist "5 months ago" → 5 minutes (alternation order); same bug fixed upstream in adapter-core `parseRelativeTimeString` (iter 2).
- Host checks on `shouldInterceptUrl` were substring matches — `evil.example/?ref=grindr.com` passed; now host-anchored.
- store: LRU IDB cache VersionError after SW restart (cold tier dead), stranded flush promises, per-doc write loops → bulk ops, `getMessagesByThread` returning arbitrary slice instead of newest, import trusting `_deleted` in backup files.
- panel: duplicate `id="btn-gallery"` (dead Photos button), missing calendar input (settings never saved), per-keystroke thread reloads with stale-response races.
- context-engine/debug tools: `bands: Infinity` infinite loop; debug-server double-connect race and id/type param collision.

## BLOCKED / decision-needed (Medium+ not auto-fixable)

| Item | Where | Why blocked |
|---|---|---|
| `DEBUG_COMMAND` is an unauthenticated full-DB read from any content script; docstring claimed a gate that doesn't exist | service-worker.ts:3211 + debug-bridge | Needs a product decision on the gating key (inputs hardened, docstring corrected) |
| Extension-side debug WebSocket listener (ws://localhost:9222) — any web page/local process can connect; `execute_query` + `clear_db` reachable | extension debug bridge | Needs Origin allowlist + shared token design |
| `SEND_AUTO_RESPONSE_DIRECT` has no SW handler — quick phrases never sent | panel.js ↔ service-worker | Handler semantics ambiguous (rerouted through spSend so failures now surface) |
| `ADAPTER_ERROR` has no SW case — adapter errors silently discarded | content bridges ↔ SW | Routing target ambiguous |
| MAIN↔ISOLATED CustomEvent channel unauthenticated (host page can forge filter/block/send events) | all content scripts | Nonce handshake = architecture change |
| Private data (notes, reminders, text substitutions incl. a hardcoded Kik/Snap handle in defaults) in page-origin localStorage, readable by the site | text-expander.ts:24, sniffies bridge | Bridge-mediated storage = architecture change |
| Drive/OPFS backups written unencrypted despite AES-GCM support in the export path | google-drive-sync.ts | Would break existing restores |
| Self-ID detection (`userId`/`profileId` on any payload node) can adopt strangers' IDs → messages misclassified `out` | adapter-core self-id-tracker | Behavior drift; needs per-platform key audit |
| Auth capture runs on *every* page fetch incl. third-party | adapter-core network-interceptor:128 | Scoping needs per-platform domain verification |
| FNV-1a offset basis is a digit-dropped typo (outputs match no reference impl) | context-engine hash.ts:11 | Every persisted hash changes; needs migration |
| LSH banding drops trailing bands (recall loss) | context-engine lsh.ts | Persisted buckets |
| Doublelist contact/message ids never join; grindr split contact identity; yahoo/grindr/a4a nondeterministic id fallbacks (unbounded re-insert) | adapters | Canonical id scheme = data-model decision + doc-id migration |
| ~40 sniffies tests exercise replicated copies of parser functions, not shipped code | adapters/sniffies/__tests__ | Real fix: export the functions from a pure module |
| Committed `.claude/worktrees/elegant-volhard-19a0c9/` duplicate tree (~150 files) + committed `.playwright-mcp/` logs | repo root | Deletion is a repo-owner call; vitest now excludes the worktree copy |
| Dev-toolchain vulnerability advisories: vitest (critical), vite/eslint/tsup (high) need major bumps; runtime: `form-data` via @anthropic-ai/sdk, `uuid` via pouchdb-browser (moderate) | package.json | Major upgrades = behavior risk; track via dependabot |
| 11 pre-existing `tsc --noEmit` errors in extension code (not part of the green baseline; Vite strips types) incl. `ProfileFeatures.hasPhoto` boolean/number mismatch | extensions/ | Fixing could change ML feature encoding |

## Advisory (not applied, evidence-grounded)

- Vitest `projects` config to run the whole suite from root with benchmarks quarantined sequentially (proposal in bundle I output; `pnpm -r test` currently loads no per-package config at all).
- Consolidate the two drifted floating-panel implementations (~200 duplicated lines, one had an XSS bug the other didn't).
- `content/bridge-common.ts` for the error-forwarding block missing from gmail/yahoo/doublelist bridges.
- Major dep upgrades: eslint 10, TS 7, vite 8, vitest 4.

## Verification commands

```bash
pnpm install && pnpm run build && pnpm run lint && pnpm run test
# expected: build Done ×11, lint 0 problems, 198/198 tests pass
```
