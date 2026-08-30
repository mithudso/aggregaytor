# Runbook — extension debugging

## 1. Inspect the service worker

- `chrome://extensions` → Aggregaytor card → click the **"service worker"** link
  (shows "inactive" when the MV3 SW has been idle-killed ~30s; clicking wakes it).
- Useful probes from the SW console:

  ```js
  chrome.runtime.sendMessage({type:'GET_SW_PERF'}, console.log)            // per-op perf + memory block
  chrome.runtime.sendMessage({type:'GET_LLM_QUEUE_STATUS'}, console.log)   // queue, provider RPM, backoff
  chrome.runtime.sendMessage({type:'DIAGNOSE_TRAINING_DATA'}, console.log) // preference-model audit
  chrome.storage.local.set({ aggregaytor_log_level: 'debug' })             // raise log verbosity everywhere
  ```

- Remember the lifecycle: the SW dies after 30s idle / 5min task. If a breakpoint
  session "disappears", the SW restarted — state in Dexie survives, in-memory caches
  (search index, thread cache) rebuild lazily.

## 2. Content-script consoles

- MAIN-world adapters + ISOLATED bridges log to the **platform tab's** DevTools
  console, gated by the log level (see `docs/logging.md`).
- Perf counters from the page console: `__aggregaytor_perf.stats()` /
  `.reset()` / `.uptimeMin()`.
- Side panel: right-click inside the panel → Inspect. Popup: right-click the toolbar
  icon → Inspect popup.

## 3. Dev auto-reload (.build-hash)

- `cd extensions/aggregaytor && pnpm run dev` — Vite watch writes `dist/.build-hash`
  on every bundle; the SW polls it every 1.5s (dev-only, guarded on
  `!manifest.update_url`, kept alive by the `dev-reload-keepalive` 30s alarm) and
  self-reloads via `chrome.runtime.reload()`.
- If auto-reload stops: the SW was probably killed with the poll timer — open the SW
  inspector once to wake it, or reload manually at `chrome://extensions`.
- Platform tabs always need a manual refresh after a reload (content scripts don't
  reinject).

## 4. Error-logger dump

Every context's errors (unhandled, rejections, `console.error`) land in a rolling
500-entry buffer in `chrome.storage.local['aggregaytor_error_log_v1']`.

- **Export**: Settings → export error log, which downloads
  `aggregaytor-errors-<timestamp>.json` (via `chrome.downloads`). The file includes
  `extensionVersion` and `entryCount`.
- Inspect in place from any extension console:

  ```js
  chrome.storage.local.get('aggregaytor_error_log_v1', d => console.table(d.aggregaytor_error_log_v1))
  ```

- Known CORS/preflight noise is filtered from the captured log by design (still
  visible live) — don't chase model-updater CORS entries.

## 5. Debug-server bridge (MCP)

`tools/debug-server` (see its README + `docs/MCP.md`) exposes MCP tools —
`query_messages/contacts/threads`, `get_extension_status`, `get_llm_status`,
`execute_query`, `trigger_action` (destructive `clear_db` included — confirm first).

- Register in your personal Claude MCP config (`npx tsx tools/debug-server/src/server.ts`).
- It connects as a WebSocket client to `ws://localhost:9222`
  (`AGGREGAYTOR_DEBUG_PORT` overrides; 9222 collides with Chrome's own
  `--remote-debugging-port` — move it if Chrome holds the port).
- Requires the SW to be awake. Fallback without the bridge — drive commands straight
  from the SW console:

  ```js
  chrome.runtime.sendMessage({type:'DEBUG_COMMAND', command:'query_threads', params:{}}, console.log)
  chrome.runtime.sendMessage({type:'DEBUG_COMMAND', command:'get_extension_status', params:{}}, console.log)
  ```

- Security: this surface is ungated (known-issues §A1/§A2). Debug on trusted
  machines only.

## 6. Common diagnostics

| Symptom | First checks |
|---|---|
| No messages flowing from a platform | Platform tab console: did the MAIN script load (`__aggregaytor_perf` defined)? Interceptor logs at debug level; then SW console for `ADAPTER_MESSAGES` handling errors; then `docs/known-issues.md` §A12 (id-scheme quirks) and site-redeploy breakage (`docs/integrations-and-assumptions.md`) |
| LLM features silent | `GET_LLM_QUEUE_STATUS`; provider key present? RPM exhausted (PROVIDER_RPM)? 429 failover logs under `[Aggregaytor:LLM]` |
| Google sync failing | SW console for 401 loops (token revoke path); re-auth interactively via settings; check consent-screen scopes |
| DB looks wrong | `DEBUG_COMMAND get_extension_status` (doc counts) → `execute_query` with a narrow selector; Dexie DB is `aggregaytor_dexie`, LRU cache DB is `aggregaytor-cache` (Application tab → IndexedDB) |
| Unread badge stale | `unreadCountCache` (2s TTL) + `threadSummaryCache` (5s TTL) — see `docs/caching-and-optimization.md` before suspecting the store |
