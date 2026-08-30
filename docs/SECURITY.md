# Security — STRIDE Threat Model

Scope: the Aggregaytor Chrome MV3 extension, its content scripts running inside six
hostile-by-assumption platform pages, its local Dexie/IndexedDB corpus, Google OAuth
integrations, LLM provider calls, and the local debug tooling.

**PII stance: all message data is sensitive by default.** Bodies, contact identities,
dossiers, pictures, notes, and preference signals are intimate personal data. The design
is local-first: data stays in the browser profile (IndexedDB/OPFS/chrome.storage) unless
the user explicitly exports it or enables Drive backup. Nothing is telemetered anywhere.

---

## Trust boundaries and principals

```
┌ hostile host page (sniffies.com, web.grindr.com, …) ┐   ← fully untrusted
│   MAIN-world adapter script (content/<platform>.ts) │   ← our code, but page can tamper w/ its environment
└──────── CustomEvent('__aggregaytor_message') ───────┘   ← BOUNDARY 1 (page ↔ extension, forgeable)
            ISOLATED bridge (content/<platform>-bridge.ts)  ← extension-trusted, page-blind
└──────── chrome.runtime.sendMessage ─────────────────┘   ← BOUNDARY 2 (any content script → SW)
            service worker (handleMessage ~700-case switch)
└──────── store / llm / chrome.identity ──────────────┘   ← BOUNDARY 3 (SW → local DB / Google / LLM APIs)
            side panel + popup (extension pages)            ← render boundary (untrusted data → DOM)
            tools/debug-server ↔ ws://localhost:9222       ← BOUNDARY 4 (local dev bridge, unauthenticated)
```

Principals:

| Principal | Trust | Notes |
|---|---|---|
| Host page JS | none | Can read anything on `window.*`, dispatch arbitrary CustomEvents, tamper with patched `fetch`/`WebSocket` |
| MAIN-world adapter | our code in hostile territory | Keeps auth inside closure scope; only `__aggregaytor_grindr_lookupProfileId(hash)` and `__aggregaytor_perf` (timing metadata) are exposed on `window` |
| ISOLATED bridge | extension | Can use `chrome.*`; enforces event-type allowlists on the page→SW relay (landed 2026-08-30) |
| Service worker | extension core | Owns the DB, LLM keys, Google tokens |
| Panel/popup | extension UI | Renders untrusted platform data; must escape |
| Local processes / other web pages | none | Relevant only for the localhost debug bridge |

## Authentication

- **Platform sessions**: the user's own session cookies do the authenticating; the
  extension never handles platform passwords. `api-sender.ts` additionally captures
  auth **headers** from intercepted requests and replays them for message sends —
  these captured headers live in MAIN-world closure/module state, never on `window`.
- **Google**: `chrome.identity.getAuthToken()` with the manifest `oauth2` client
  (scopes: calendar, tasks, gmail.readonly, drive.file). Chrome owns refresh; the code
  caches tokens in-process for ~50min and revokes via `removeCachedAuthToken` on 401.
- **Grindr auto-login credentials**: stored encrypted (`SET_GRINDR_CREDENTIALS`
  handlers, device-bound crypto key in the SW).

## Secret handling

| Secret | Where | Rules |
|---|---|---|
| LLM API keys (per provider) | `chrome.storage.local` (`aggregaytor_all_llm_keys`, `aggregaytor_llm_settings`) | Never sent anywhere but the matching provider endpoint; never exported in backups; never logged |
| Google OAuth tokens | chrome.identity token cache + in-process caches | Never persisted by us beyond calendar token storage; 401 → revoke + refetch |
| Captured platform auth headers | MAIN-world module scope | Never exposed on `window.*`, never persisted |
| Message corpus / dossiers | IndexedDB `aggregaytor_dexie`, OPFS snapshots | Local-only; Drive/OPFS backups now AES-GCM encrypted (PBKDF2 210k) with a device-held key `aggregaytor_backup_key` (see resolved risk #5) |

## Input validation (per boundary)

- **Boundary 1 (page → bridge)**: bridges accept only allowlisted event types from the
  page (2026-08-30). `sniffies.ts` rejects `event.source !== window` so third-party
  iframes can't inject. Remaining gap: the CustomEvent channel itself is
  unauthenticated (see open risks).
- **Interception targets**: `shouldInterceptUrl` host checks are **host-anchored**
  (2026-08-30) — substring tricks like `evil.example/?ref=grindr.com` no longer match.
- **Payload hardening**: the payload walker caps depth and detects cycles; timestamp
  extraction tolerates hostile values (a `1e20` timestamp no longer aborts the batch);
  `debug-bridge.ts` clamps caller-supplied limits to 500 and rejects non-plain-object
  selectors; `error-logger.ts` bounds every free-form field (message 2000, stack 4000,
  context 4000 bytes serialized) because entries arrive from untrusted contexts.
- **Boundary 2 (content script → SW)**: any content script can reach the ~700-case
  switch; handlers must treat all params as untrusted. This is the boundary the
  ungated `DEBUG_COMMAND` sits on (open risk #1).

## Output encoding

- Panel: every untrusted string reaching an HTML sink goes through `esc()` — a
  5-character entity escaper (`& < > " '`) rewritten 2026-08-30 after the previous
  version failed to escape quotes (attribute-breakout XSS at ~30 sinks). Popup has its
  own escaper. **Rule: never build HTML from platform data without `esc()`; prefer
  `textContent`.**

## STRIDE mitigations

| Category | Threats considered | Mitigations |
|---|---|---|
| **S**poofing | Page forging adapter events; iframes posting as the user; stranger IDs adopted as "self" | Bridge event-type allowlists; `event.source === window` check; self-ID tracker (imperfect — open risk); host-anchored URL matching |
| **T**ampering | Page tampering with patched fetch/WS; malicious backup files on import | Interceptors installed at `document_start` before page code; import no longer trusts `_deleted` flags in backup files; migration flags only set after successful copy |
| **R**epudiation | No audit story needed for a single-user local tool | Rolling error log (`error-logger.ts`) gives a bounded local trail; no remote logging by design |
| **I**nformation disclosure | Host page reading secrets on `window.*`; XSS exfiltrating the corpus; debug surfaces leaking full DB; plaintext backups; logs leaking tokens/PII | No-`window.*` invariant (only perf counters exposed); `esc()` everywhere; debug surface now origin-gated; backups now AES-GCM encrypted; api-sender auth logging demoted to `debug` level; **remaining open risks below** |
| **D**enial of service | Hostile payloads (deep nesting, giant timestamps) wedging adapters; LLM queue wedge; unbounded caches | Walker depth/cycle limits; try/finally queue release; 60s LLM fetch timeouts; bounded caches with documented invalidation; provider-timestamp hard cap |
| **E**levation of privilege | Content script reaching privileged SW handlers; localhost processes driving the debug bridge; page driving MAIN-world helpers | Allowlists at the bridge; clamped read-only debug handlers now sender-origin-gated (content scripts refused); narrowly-scoped bridge-mediated MAIN-world operations instead of reusable `window` helpers |

## Known open risks (from CDO-REPORT-2026-08-30 BLOCKED table)

Honest list — these are real, currently-shipping exposures awaiting product/architecture
decisions. Do not silently "fix" them without reading the report's blocking rationale.

1. **`DEBUG_COMMAND` — RESOLVED 2026-08-30** (`service-worker.ts` + `debug-bridge.ts`):
   now gated by a sender-origin check in `authorizeDebugCommand()` — allowed only when
   `sender.id === chrome.runtime.id && !sender.tab` (the extension's own pages), so
   content scripts (which always carry `sender.tab`) and external senders are refused
   unconditionally; an undefined sender fails closed. An optional shared token
   (`aggregaytor_debug_token`, ≥16 chars) layers on top for extension-page callers.
   Inputs remain hardened and results bounded.
2. **Localhost debug WebSocket — NOT A REAL EXPOSURE** (`ws://localhost:9222`): there is
   no in-repo WebSocket *listener*. The SW cannot run a WS server (`debug-bridge.ts`),
   and `tools/debug-server/src/server.ts` is a WS *client* that only dials the port, so
   it binds nothing — no origin/path-traversal/injection surface here. The debug
   commands are reached through `chrome.runtime` messaging, now closed by risk #1's gate.
   Any `:9222` server is an external, out-of-repo component the operator must run bound
   to loopback only.
3. **MAIN↔ISOLATED CustomEvent channel unauthenticated**: the host page can forge
   filter/block/send events on `__aggregaytor_message`. A nonce handshake is an
   architecture change; until then the type allowlist is the only filter.
4. **Private data in page-origin localStorage**: `text-expander.ts` (including a
   hardcoded Kik/Snap handle in defaults) and the sniffies bridge store notes/
   reminders/substitutions where the site itself can read them. Bridge-mediated
   storage is the fix; architecture change.
5. **Drive/OPFS backups — RESOLVED 2026-08-30**: both paths now encrypt with AES-GCM
   (PBKDF2 210k) using a device-held random key (`aggregaytor_backup_key`, 32 bytes in
   `chrome.storage.local`) via `getOrCreateBackupKey()` in `export-import.ts`. Same-profile
   restore is transparent; cross-device restore requires the user to have exported the
   key first (documented tradeoff — the goal is "no plaintext DMs in Drive", not secret
   escrow).

Related BLOCKED items with security flavor: self-ID adoption of strangers' IDs
(misclassification, not exfiltration), auth-header capture running on every page fetch
including third-party requests (scoping needs per-platform domain verification).

## Contributor security checklist

Before merging any change, verify:

- [ ] No new `window.*` exposure from MAIN-world scripts (grep for `window.` assignments; only the documented perf/lookup exceptions).
- [ ] Any new bridge-relayed event type is added to the bridge's explicit allowlist — never a pass-through.
- [ ] Any new URL match in interceptors is host-anchored, not substring.
- [ ] Every new HTML sink in panel/popup uses `esc()` or `textContent`.
- [ ] New SW message handlers treat all params as untrusted (validate types, clamp limits) — anything reachable via `chrome.runtime.sendMessage` is reachable from a content script.
- [ ] No secrets (API keys, OAuth tokens, captured auth headers) in logs above `debug` level, in exports, or in error-log context objects.
- [ ] New persisted data stays in extension-origin storage (IndexedDB / chrome.storage), never page-origin localStorage.
- [ ] External fetches have a timeout and their error path logs (see `docs/external-calls.md` contract).
- [ ] Backup/import paths never trust flags in the file (`_deleted`, doc ids) without validation.
- [ ] If you touch the debug surface, keep handlers read-only + bounded, and preserve the `authorizeDebugCommand()` sender-origin gate (content scripts must stay refused).
- [ ] Any new Drive/OPFS backup write goes through the encrypted export path (`getOrCreateBackupKey()`), never plaintext.
