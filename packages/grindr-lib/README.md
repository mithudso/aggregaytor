# @aggregaytor/grindr-lib

Self-contained Grindr Web client used by the Grindr adapter and the MAIN-world
`content/grindr.ts` content script.

## Provenance

Vendored **verbatim** from the `Grindr Middle-Click Block` userscript repo's
`lib/` directory (MIT, © 2026 mithudso), source commit
`abda5c893be40f78f13f0e0bf6027118b60a5b05`. Do not hand-edit `src/*.js` — update
the upstream lib and re-vendor so the two stay in sync.

## Modules

| Module | Purpose |
|---|---|
| `auth.js` | Credential store + authed `request()` (timeout/abort, typed errors) |
| `blocks.js` | `hide` / `block` / `unblock`, paginated `listBlocks`, `listHides` — hide and block are mutually exclusive server-side (never chained) |
| `limiter.js` | `createLimiter({minIntervalMs, maxPerHour})` — serializes writes behind a min interval + rolling hourly cap (Grindr force-logs-out on write bursts) |
| `errors.js` | `GrindrError` / `GrindrAuthError` + `parseErrorCode` (never carries a token) |
| `observe.js` | Opt-in fetch/WebSocket observer that auto-captures `Grindr3` auth headers; real hostname test, degrades to a no-op on frozen intrinsics |
| `dom.js` | Profile-id / cascade-tile resolution + route detection (bounded, refuses the inbox-row "sidebar trap") |
| `compose.js` | Composer/Send resolution + `greet()` (native React value setter, WS-send confirmation) |
| `chat.js` | Chat HTTP surface + `conversationId` / `deriveOwnId` helpers |
| `profiles.js` | Profile / cascade / views client |
| `albums.js` | Private-album share client |
| `reconcile.js` | `idsFromListPayload`, `reconcileTiers` (hide-only ids that need upgrading to a block) |

## Usage

```js
import { createClient } from '@aggregaytor/grindr-lib';

const client = createClient({ observe: true });   // auto-captures auth from live traffic
const limiter = client.limiterFactory({ minIntervalMs: 4000, maxPerHour: 200 });
await limiter.run(() => client.blocks.hide(profileId));
```
