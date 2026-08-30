# External calls inventory

Every call site that leaves the extension/process boundary, from a
`fetch(` / `new WebSocket(` / `chrome.identity` / `XMLHttpRequest` grep across
`extensions/`, `packages/`, `adapters/`, `tools/` (excluding `dist/`, `node_modules/`,
`.claude/worktrees/`). Line numbers as of 2026-08-30 (v0.57.81); treat as anchors,
not gospel.

**Contract (adapted):** this repo is a browser extension — there is **no
operations-registry server infrastructure** (the mdb-tam five-standard registry is
N/A). The adapted standard for every external call is: **(1) error path logged, (2)
timeout or abort bound.** Rows failing either are flagged ⚠ below and count as debt.

Interception (patched `fetch`/`XHR`/`WebSocket` observing the platform's own traffic)
is excluded — those are the page's calls; ours are below.

## LLM + model discovery (service worker)

| File:line | Target | Transport | Error handling | Retry/timeout | Logged? |
|---|---|---|---|---|---|
| `background/llm.ts:499` (`queuedFetch` → all providers, endpoints chosen ~1260-1374) | gemini / openai / anthropic / groq / cerebras / perplexity / mistral / copilot chat endpoints | fetch (POST) | Status checked; 429 → provider failover (`getConfigWithFailover`), backoff; queue released in try/finally | Rate-limit queue + backoff; **60s AbortController timeout** | Yes (`[Aggregaytor:LLM]`, errors surface to caller + error log) |
| `background/model-updater.ts:269` | provider `/models` endpoints (6) | fetch (GET) | try/catch per provider; `lastError` persisted in updater state; CORS failures expected + noise-filtered | Sequential loop; **15s timeout** per request | Yes (state.lastError; console noise filtered) |

## Google APIs (packages/store, SW context)

| File:line | Target | Transport | Error handling | Retry/timeout | Logged? |
|---|---|---|---|---|---|
| `google-tasks.ts:63` / `:108` | Google OAuth | `chrome.identity.getAuthToken` / `removeCachedAuthToken` | callback errors surfaced; interactive flag controls consent UI | chrome-managed | Yes |
| `google-tasks.ts:95` | `tasks.googleapis.com/tasks/v1/*` | fetch | 401 → revoke token + cache bust + retry once; non-OK throws to caller | 1 auth retry; ⚠ **no timeout** | Yes (errors propagate to sync handler) |
| `google-drive-sync.ts:57` / `:102` | Google OAuth | `chrome.identity` | as above | chrome-managed | Yes |
| `google-drive-sync.ts:91` | `www.googleapis.com/drive/v3` + `/upload/drive/v3` | fetch | 401 → revoke + retry; non-OK throws | 1 auth retry; ⚠ **no timeout** | Yes |
| `calendar.ts:113` | `googleapis.com/calendar/v3/freeBusy` | fetch (POST) | non-OK handled; expired-token path re-auths | ⚠ **no timeout** | Yes |
| `calendar.ts:203` | `calendar/v3/calendars/{id}/events` | fetch (POST) | non-OK handled | ⚠ **no timeout** | Yes |
| `calendar.ts:267` | Google OAuth | `chrome.identity.getAuthToken` | promise rejection surfaced | chrome-managed | Yes |

## Platform direct calls (MAIN-world / content scripts)

| File:line | Target | Transport | Error handling | Retry/timeout | Logged? |
|---|---|---|---|---|---|
| `content/sniffies.ts:205`, `adapters/sniffies/src/sniffies-adapter.ts:1008` | `sniffies.com/api/v2/post-authentication/chat-data` | fetch, session cookies | try/catch | ⚠ no timeout | # TODO: verify log level at these two sites |
| `background/service-worker.ts:4205` / `:4220` (script injected into the sniffies tab) | `usw.api.sniffies.com` / `uswapi2.sniffies.com` `POST /api/user/full` (profile enrichment) | fetch, `credentials: include` | Base discovery probe swallows per-base failures (by design); 401/403 aborts batch; 429 treated as session-dead for the tick | Base cached on `window.__aggregaytor_sniffies_full_base`; ⚠ no timeout | Partial (status returned to SW) |
| `content/grindr-bridge.ts:413` | `web.grindr.com/api/v3/me` (login check) | fetch, cookies | status checked | alarm-paced (1min); ⚠ no timeout | # TODO: verify |
| `content/grindr.ts:185`, `:264` | `web.grindr.com/api/v4/profiles/{id}` etc. (profile fetch) | fetch + captured auth | try/catch | ⚠ no timeout | # TODO: verify |
| `content/grindr.ts:643`, `:652` | `web.grindr.com/api/v1/me/hides/{id}`, `/api/v3/me/blocks/{id}` | fetch + captured auth | status checked | ⚠ no timeout | # TODO: verify |
| `content/sniffies-map-filters.ts:1549` | sniffies partials endpoint (map prefetch) | fetch, cookies | try/catch | prefetch tick pacing; ⚠ no timeout | # TODO: verify |
| `packages/adapter-core/src/api-sender.ts:159` (`sendViaApi`) | platform send-message endpoint (per `PLATFORM_AUTH_HOST`) | fetch + captured auth headers | non-OK → falls back to DOM injection | DOM fallback; has AbortController (see file) | Yes (`log.debug` for auth capture; send errors logged) |

## Local / dev-only

| File:line | Target | Transport | Error handling | Retry/timeout | Logged? |
|---|---|---|---|---|---|
| `background/service-worker.ts:2958`, `:3987`, `:4003` | `chrome.runtime.getURL('.build-hash')` | fetch (extension-local, `cache: no-store`) | try/catch; dev-only (guarded `!manifest.update_url`) | 1.5s poll cadence | debug-level |
| `tools/debug-server/src/server.ts:72` | `ws://localhost:9222` (or `AGGREGAYTOR_DEBUG_PORT`) | WebSocket client | connect errors fail all pending requests with real errors; unparseable frames dropped + logged | **10s `REQUEST_TIMEOUT_MS`** per request; reconnect on next call | Yes (stderr) |
| `background/error-logger.ts:142` | user's Downloads dir | `chrome.downloads.download` (data: URL) | try/catch → `console.warn` (not error — avoids capture re-entrancy) | none needed | Yes |

## Debt summary

- ⚠ **Missing timeouts**: all Google API fetches (tasks/drive/calendar) and all
  platform direct calls except `api-sender`/`llm`/`model-updater`. A hung fetch in
  the SW burns its 5-minute MV3 task budget. Fix pattern: `AbortSignal.timeout(ms)`
  (already used in llm.ts / model-updater.ts / api-sender.ts).
- ⚠ **Unverified logging** at several content-script call sites (marked `# TODO`
  above) — per `docs/logging.md`, every external-call failure path must log; audit
  these when next touching the files.
- No retry policy exists outside LLM failover and the single Google 401 retry —
  acceptable for user-triggered actions, but alarm-driven syncs fail until the next
  tick by design (document per handler if that ever changes).
