# @aggregaytor/sniffies-lib

Self-contained Sniffies Web client used by the Sniffies adapter and the
MAIN-world / ISOLATED sniffies content scripts.

## Provenance

Vendored **verbatim** from the Sniffies userscript repo's `lib/` directory (MIT),
source commit `4a6d73869efd13d899b534744b8242d652f378b6`. Do not hand-edit
`src/*.js` — update the upstream lib and re-vendor so the two stay in sync.

## Modules

| Module | Purpose |
|---|---|
| `api.js` | HTTP client for `/api/user/partials` (batches of 50) and `/api/user/full`; probes bases × body-shapes and remembers the winner; `computeLastActiveTs`, `extractAttitudeFromPartial` |
| `limiter.js` | `createLimiter({maxPerMinute:6, minIntervalMs, cooldownMs:600000})` — serializes profile fetches behind a per-minute cap; a reported 429/403 opens a 10-min cooldown |
| `errors.js` | `SniffiesError` / `SniffiesAllBasesError` / `SniffiesTimeoutError` (never carry a cookie/session value) |
| `observe.js` | Opt-in fetch/XHR/WebSocket observer surfacing Sniffies API JSON + Socket.IO frames; `decodeSocketFrame` (Engine.IO/Socket.IO framing), `isSniffiesApiUrl` (real hostname test) |
| `dom.js` | Pure DOM helpers: marker/global-chat/carousel resolution, profile-id extraction, attitude, distance, unread — observed selectors, no per-build `_ngcontent` hashes |
| `compose.js` | Composer resolution + `sendInCurrentChat` (Sniffies has no send API — writes over the DOM; every function degrades to null/false, never throws) |

## Usage

```js
import { createClient } from '@aggregaytor/sniffies-lib';

const client = createClient({ observe: true, onApiJson: ({ data }) => { /* … */ } });
const rows = await client.api.getPartials(ids);      // rate-limited
const sent = client.compose.sendInCurrentChat(text); // DOM send
```
