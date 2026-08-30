# Integrations and assumptions

Every external service this codebase talks to, plus the hardcoded assumptions that
break when the outside world changes. Companion inventory of raw call sites:
`docs/external-calls.md`.

## 1. Platform sites (interception targets + occasional direct calls)

The six platforms are integrated primarily by **observing** their own traffic
(fetch/XHR/WebSocket interceptors installed in the MAIN world), authenticated by the
user's own session cookies. A few direct calls exist:

| Platform | Hosts (manifest `host_permissions`) | Integration | Direct calls |
|---|---|---|---|
| Sniffies | `sniffies.com` | Socket.IO WebSocket frames + fetch interception (`adapters/sniffies`) | `POST/GET https://sniffies.com/api/v2/post-authentication/chat-data` (chat bootstrap; `content/sniffies.ts:205`, `sniffies-adapter.ts:1008`); map-filter partials endpoint (`sniffies-map-filters.ts:1549`) |
| Grindr | `web.grindr.com` | Fetch interception + captured-auth API replay | `GET /api/v3/me` (`grindr-bridge.ts:413`), `GET /api/v4/profiles/{id}` (`grindr.ts:264`), `POST /api/v1/me/hides/{id}` + `/api/v3/me/blocks/{id}` (`grindr.ts:643-652`), profile fetches (`grindr.ts:185`) |
| DoubleList | `doublelist.com` | Fetch interception (`adapters/doublelist`) | — |
| Adam4Adam | `www.adam4adam.com`, `m.adam4adam.com` | Fetch interception (`adapters/adam4adam`) | — |
| Gmail | `mail.google.com` | DOM + traffic observation (`adapters/gmail`), document_idle bridge | — |
| Yahoo Mail | `mail.yahoo.com` | DOM + traffic observation (`adapters/yahoo`) | — |

Auth: session cookies (browser-managed) + auth headers captured from the platform's
own requests (`api-sender.ts`) for message-send replay. Data in: message/contact
payloads. Data out: message sends, block/hide actions — always as the logged-in user.

## 2. LLM providers (`background/llm.ts`)

Providers (`LLMProvider`): `gemini`, `openai`, `anthropic`, `groq`, `cerebras`,
`perplexity`, `mistral`, `copilot`, plus a no-network `local` fallback.

| Provider | Endpoint | Auth | Hardcoded RPM (`PROVIDER_RPM`, llm.ts:164) |
|---|---|---|---|
| Gemini | `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=` | API key in URL | 15 |
| OpenAI | `api.openai.com/v1/chat/completions` | Bearer key | 500 |
| Anthropic | `api.anthropic.com/v1/messages` | x-api-key | 50 |
| Groq | `api.groq.com/openai/v1/chat/completions` | Bearer key | 30 |
| Cerebras | `api.cerebras.ai/v1/chat/completions` | Bearer key | 30 |
| Perplexity | `api.perplexity.ai/chat/completions` | Bearer key | 50 |
| Mistral | `api.mistral.ai/v1/chat/completions` | Bearer key | 2 |
| Copilot | `api.githubcopilot.com/chat/completions` | community proxy token — no public API | 10 |

Data out: prompt text composed from conversation excerpts, dossier slices, persona
modules (i.e. **sensitive message content leaves the machine when an LLM feature is
used** — user-configured, key-gated). Data in: completions.
Calls go through `queuedFetch` (rate limiter, backoff, 60s timeout); 429 → provider
failover (gemini → anthropic → openai).

## 3. Google APIs (`packages/store`, OAuth via `chrome.identity`)

Manifest `oauth2` scopes: `calendar`, `tasks`, `gmail.readonly`, `drive.file`.
Client id is hardcoded in `manifest.json` (`948699843382-….apps.googleusercontent.com`).

| Service | Endpoints | File | Data |
|---|---|---|---|
| Google Tasks | `https://tasks.googleapis.com/tasks/v1/*` | `google-tasks.ts` | Two-way task sync (paginated pull; local↔remote create/update/delete) |
| Google Calendar | `https://www.googleapis.com/calendar/v3/freeBusy`, `/calendars/{id}/events` | `calendar.ts` | freeBusy reads for slot suggestions; event creation |
| Google Drive | `https://www.googleapis.com/drive/v3/*`, `/upload/drive/v3/*` | `google-drive-sync.ts` | Full-DB backup/restore JSON in an "Aggregaytor Backups" folder — **currently unencrypted** (SECURITY.md open risk #5) |

Auth pattern: `chrome.identity.getAuthToken({interactive})`, ~50min in-process token
cache, 401 → `removeCachedAuthToken` + cache bust + one retry.

## 4. Model-updater endpoints (`background/model-updater.ts`)

Daily background sweep of each configured provider's model list (only when the user
has a key saved), 15s timeout per request:

- `generativelanguage.googleapis.com/v1beta/models?key=…`
- `api.openai.com/v1/models`, `api.anthropic.com/v1/models`,
  `api.groq.com/openai/v1/models`, `api.cerebras.ai/v1/models`,
  `api.mistral.ai/v1/models`

Some endpoints fail CORS from an extension SW — expected; falls back to the static
`DEFAULT_MODELS` list (those CORS errors are filtered from the error log as known
noise).

## 5. Debug server (`tools/debug-server`)

`ws://localhost:9222` (override `AGGREGAYTOR_DEBUG_PORT`), MCP-on-stdio dev tool.
Data: full read access to the local corpus + `clear_db`. Unauthenticated — see
SECURITY.md open risk #2. Not part of the shipped extension.

## Hardcoded assumptions (things that break when the world changes)

| Assumption | Where | Breakage mode |
|---|---|---|
| Provider RPM limits match current free/tier-1 quotas ("as of April 2026") | `PROVIDER_RPM`, llm.ts:164 | Wrong cycling decisions / avoidable 429s when a provider changes tiers — update on tier change |
| Default model ids exist (`gemini-3.1-flash-lite-preview`, `gpt-4o-mini`, `claude-haiku-4-5-20251001`, `llama-4-scout-17b-16e-instruct`, …) | `DEFAULT_MODELS`, llm.ts | 404s on retirement; partially self-healing via model-updater + `GEMINI_FALLBACK_MAP` (Gemini 2.5 deprecation 2026-06-17 handled explicitly) |
| Port 9222 free (also Chrome's `--remote-debugging-port` default) | debug-server `PORT` | Handshake fails silently-ish if Chrome holds the port; override env var on both sides |
| Platform API shapes (field names like `body`/`senderId`, wrapper nesting) | each adapter's `PayloadVisitor` | Messages silently stop flowing when a platform redeploys its API |
| Platform DOM selectors (scrape paths, map filters, floating UI anchor points) | `content/*-bridge.ts`, `sniffies-map-filters.ts`, `grindr-filters.ts` | Scraping/UI overlays break on site redesigns; 34 `querySelectorAll` sites in sniffies-bridge alone |
| Platform hostnames fixed | `manifest.json` host_permissions + interceptor host anchors | New domains (e.g. a platform moving off `web.grindr.com`) require a manifest change + review |
| Self-ID discoverable via `userId`/`profileId`/`isMe` heuristics | `self-id-tracker.ts` | Direction misclassification (open BLOCKED finding: can adopt strangers' IDs) |
| Google OAuth client id + scopes valid | `manifest.json` `oauth2` | All Google features die if the Cloud project/consent screen lapses |
| Socket.IO frame format for sniffies chat | `adapters/sniffies/src/ws-parser.ts` | Chat capture breaks if sniffies changes transport/protocol |
| MV3 SW lifecycle: 30s idle kill, 5min task max | throughout (alarms, caches, LruIdbCache cold tier) | Chrome policy changes alter keepalive/caching tradeoffs |
| `chrome.storage.local` 5MB quota is enough for 500 error entries + settings | error-logger.ts | Quota pressure if caps are raised (extension holds `unlimitedStorage` for IDB, but storage.local budgeting still applies) |
