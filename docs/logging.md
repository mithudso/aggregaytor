# Logging

Two complementary systems:

1. **Level-gated console logging** — `packages/adapter-core/src/logger.ts`, used by
   adapters, bridges, and shared packages.
2. **Persistent error capture** — `extensions/aggregaytor/background/error-logger.ts`,
   a rolling buffer of every error from every context, exportable as JSON.

## Level-gated logger (`createLogger`)

- Levels: `debug < info < warn < error < off` (`LogLevel` in logger.ts).
- Current level is module state, default `info`, **storage-driven**: persisted under
  `chrome.storage.local['aggregaytor_log_level']`. `loadLogLevel()` hydrates it at
  context startup; `saveLogLevel(level)` persists + applies; `setLogLevel` applies
  in-memory only. Values from storage are validated at the boundary (`isLogLevel`)
  so a bogus stored value can't silently disable all logging.
- `createLogger(prefix)` returns `{ debug, info, warn, error }` that forward to
  `console.debug/log/warn/error` with the prefix when the level passes the gate.
- Changing the level at runtime: from any extension console,
  `chrome.storage.local.set({ aggregaytor_log_level: 'debug' })`, or via the debug
  bridge's `trigger_action` → `set_log_level`.

### Adding logging to a new module

```ts
import { createLogger } from '@aggregaytor/adapter-core';
const log = createLogger('[Aggregaytor:MyModule]');

log.debug('verbose plumbing detail', someObject);   // dev-only noise
log.info('state transition worth knowing about');
log.warn('recoverable oddity, degraded path taken');
log.error('operation failed', err);                 // also lands in the error log (console.error is patched)
```

Conventions:
- Prefix format is `[Aggregaytor:<Area>]` (`[Aggregaytor:LLM]`, `[Aggregaytor:Debug]`,
  `[Aggregaytor:ErrorLog]` are existing examples).
- Background modules that predate the logger use bare `console.log(LOG, ...)` with the
  same prefix constant; new code should prefer `createLogger` so it's level-gated.
- In a MAIN-world content script, call `loadLogLevel()` is unavailable-safe: logger
  guards on `typeof chrome !== 'undefined'`.

## Output locations

| Context | Where output lands | How to view |
|---|---|---|
| MAIN-world adapters + ISOLATED bridges | The **page's** DevTools console (level-gated) | F12 on the platform tab |
| Service worker | SW console | `chrome://extensions` → Aggregaytor → "service worker" |
| Side panel / popup | Their own DevTools | Right-click panel → Inspect |
| Errors from ALL contexts | `error-logger.ts` rolling buffer in `chrome.storage.local['aggregaytor_error_log_v1']` | Settings → export JSON, or `EXPORT_ERROR_LOG` message |

## Persistent error capture (`error-logger.ts`)

- `installGlobalErrorCapture(source)` — called once per long-lived context (SW, panel,
  bridges, MAIN world). Hooks `error` events, `unhandledrejection`, **and patches
  `console.error`** so existing call sites participate automatically. Content scripts
  forward via the `LOG_ERROR` message.
- Entries: `{ ts, source, level: 'error'|'warn'|'unhandled'|'rejection', message, stack?, url?, context? }`.
- Bounded because entries cross an untrusted boundary: message ≤2000 chars, stack ≤4000,
  url ≤1000, context ≤4000 serialized bytes; buffer capped at 500 entries (FIFO),
  flushed to storage on a 1s debounce.
- Known-noise CORS/preflight patterns are filtered out of the captured log (still
  visible live) — the daily model-updater CORS failures were the canonical false alarm.
- Export: `exportErrorLog()` downloads `aggregaytor-errors-<stamp>.json` via
  `chrome.downloads` (data: URL — SW-safe).

## Sensitive-data rules

- **Never log tokens, API keys, captured auth headers, or message bodies at `info`+.**
  Precedent: `api-sender.ts` logs captured-auth *header names* only, and that line was
  deliberately demoted to `log.debug` — auth-related detail must not appear at default
  level (`api-sender.ts:79`).
- Error-log `context` objects are persisted to chrome.storage and exported to files the
  user may share for support — treat them as leaving the machine. No PII, no secrets;
  IDs and counts are fine, bodies are not.
- The perf counters exposed at `window.__aggregaytor_perf` are readable by the host
  page: timing metadata only, never attach payloads (documented invariant in perf.ts).

## The standard: no silent failures

- **Every `catch` branch must either log (at `warn`/`error`) or carry a comment saying
  why swallowing is correct** (e.g. logger's own storage guards, error-logger's
  re-entrancy avoidance). Bare `catch {}` without justification is a review finding.
- **Every external call** (fetch to platforms, Google, LLM providers; WebSocket;
  chrome.identity) must log its failure path — see the per-call audit in
  `docs/external-calls.md`.
- The 2026-08-30 CDO pass treated silent failures as findings (e.g. sniffies-migrate
  marking migration done on failed delivery; `SEND_AUTO_RESPONSE_DIRECT` failing
  silently — now rerouted so failures surface). Keep it that way.
