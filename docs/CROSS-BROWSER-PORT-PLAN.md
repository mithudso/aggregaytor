# Cross-Browser Port Plan — Aggregaytor + Sibling Userscripts

**Status:** Planning deliverable (no code changed). **Author:** cross-browser reconnaissance pass.
**Date:** 2026-08-30. **Extension version at time of writing:** `0.60.0` (`extensions/aggregaytor/manifest.json`).

Targets: **Edge**, **Opera** (Chromium/Blink+V8) → **Firefox** (Gecko/SpiderMonkey) → **Safari** (WebKit/JavaScriptCore).

Version-sensitive browser behaviors are tagged **[verify]** — confirm against the live browser before relying on them; browser-extension surfaces drift every few releases.

---

## 0. TL;DR effort verdict

| Target | Engine | Effort | One-line verdict |
|---|---|---|---|
| **Edge** | Chromium/V8 | **Trivial** | Same MV3 ZIP loads as-is; only `chrome.identity.getAuthToken` (Google features) and store submission need attention. |
| **Opera** | Chromium/V8 | **Trivial** | Same ZIP; `chrome.sidePanel` support **[verify]** and the same `getAuthToken` caveat as Edge. |
| **Firefox** | Gecko/SpiderMonkey | **Moderate** | `browser.*` polyfill + `sidePanel`→`sidebar_action` rework + Google OAuth rewrite (`getAuthToken`→`launchWebAuthFlow`) + `gecko.id` + AMO signing. Core interception & storage port unchanged. |
| **Safari** | WebKit/JavaScriptCore | **Major** | Xcode wrapper (`xcrun safari-web-extension-converter`) + App Store distribution + full side-panel UI rework (no `sidePanel`, no `sidebar_action`) + Google OAuth rewrite + **storage-durability validation** (the highest-risk unknown for a local-first data store). |

**The MAIN-world network interception (`packages/adapter-core/src/network-interceptor.ts`) is engine-independent** — it patches page globals only (`fetch`/`XHR`/`WebSocket`), touches no `chrome.*`, and uses only long-stable ES features. It ports to all four targets **with zero changes**. That is the single most important finding: the load-bearing "adapter" mechanism is not the porting risk. The risk is everything wrapped *around* it — the extension shell APIs, the side-panel UI, Google OAuth, and Safari's storage/packaging model.

---

## 1. What the codebase actually is (grounding)

- **Chrome MV3 monorepo** (pnpm workspaces). Shipped extension in `extensions/aggregaytor/`; shared logic in `packages/` and `adapters/`. See `docs/ARCHITECTURE.md`.
- **`chrome.*` surface is raw and callback/promise-mixed.** `grep` inventory across `extensions/`, `packages/`, `adapters/`:
  - `chrome.runtime.sendMessage` ×674, `chrome.storage.local` ×389, `chrome.storage.session` ×~, `chrome.tabs.*` (query/sendMessage/update/create), `chrome.alarms.*`, `chrome.identity.getAuthToken` ×22 + `removeCachedAuthToken` ×10, `chrome.sidePanel.open` ×6 + `setPanelBehavior` ×3, `chrome.contextMenus.*`, `chrome.notifications.*`, `chrome.scripting.executeScript` ×13, `chrome.action.setBadge*`, `chrome.downloads.download` ×6, `chrome.windows.*`.
  - **No `webextension-polyfill` anywhere** (`grep -c` = 0 in `pnpm-lock.yaml`; no `browser.*` usage in `extensions/`/`packages/`). Every call is `chrome.*`.
- **Two-world content-script model** (`manifest.json` `content_scripts` + `web_accessible_resources`; `vite.config.ts` `buildContentScriptsIIFE`):
  - `content/<platform>-bridge.ts` runs in the **ISOLATED** world (registered in `manifest.content_scripts`, `run_at: document_start`, email at `document_idle`), can use `chrome.*`, and **injects** the MAIN-world script into the page via a `<script>` tag pointing at a `web_accessible_resources` entry.
  - `content/<platform>.ts` runs in the **MAIN** world as a self-contained **IIFE** (no ES modules — MAIN world can't load ext ES modules), instantiates the adapter, and patches page network globals.
  - Crucially, the MAIN-world script is **injected by the bridge**, not declared with the MV3 `world: "MAIN"` content-script key. This matters for Firefox (see §4.2).
- **Storage: Dexie on IndexedDB** (`packages/store/`), DB name `aggregaytor_dexie`, behind a **PouchDB-shaped compatibility wrapper** (`pouchdb-compat.d.ts`; `get`/`put`/`bulkDocs`/`allDocs`/`find`). Plus **OPFS** supplemental encrypted snapshots (`packages/store/src/opfs-backup.ts`, `navigator.storage.getDirectory`, AES-GCM via `getOrCreateBackupKey`). Remote replication is intentionally disabled (`packages/store/src/sync.ts` throws).
  - Note: `CLAUDE.md` still says "PouchDB"; `docs/ARCHITECTURE.md` and the code are Dexie-with-PouchDB-shaped-API. Treat the store as **Dexie/IndexedDB + OPFS** for porting purposes.
- **Google OAuth via `chrome.identity`.** `manifest.json` carries an `oauth2` block (`client_id` + Calendar/Tasks/gmail.readonly/drive.file scopes). `packages/store/src/{google-tasks,google-drive-sync,calendar}.ts` all call `chrome.identity.getAuthToken({ interactive }, cb)` and `chrome.identity.removeCachedAuthToken`. **No `launchWebAuthFlow` path exists today.**
- **LLM engine** (`background/llm.ts`): plain background `fetch()` to 8 provider hosts (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `api.groq.com`, `api.cerebras.ai`, `api.perplexity.ai`, `api.mistral.ai`, `api.githubcopilot.com`) with API keys. Engine-independent; no `chrome.*` beyond storage for keys.
- **Side panel UI** (`sidepanel/panel.html/.css/.js`, ~3500 lines vanilla JS) is the entire app UI; there is no popup-based inbox. `background/service-worker.ts` calls `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` and `chrome.sidePanel.open({ tabId })`.
- **Sibling userscripts** (run standalone *and* their `lib/` is the ancestor of the vendored `packages/{grindr,sniffies}-lib`):
  - `grindr/Grindr Middle-Click Block.user.js` — `@grant none`, `@run-at document-start`, `@match https://web.grindr.com/*`. Runs in the **page world directly** (no sandbox, no `unsafeWindow`, no `GM_*`); patches `fetch`, resolves profile IDs, POSTs hides/blocks. `grindr/lib/compose.js` uses the React-controlled-input native value setter (`Object.getOwnPropertyDescriptor(proto,'value')`).
  - `sniffies/sniffiesplus.js` — `@grant GM_getValue/GM_setValue/GM_deleteValue/GM_openInTab` (+ `GM.*` equivalents) + `unsafeWindow`, `@match https://sniffies.com/*` and `https://www.sniffies.com/*`. Runs **sandboxed**; reaches page globals via `unsafeWindow` (18 refs). `sniffies/lib/*.js` are browser-agnostic DOM/network helpers — only the top-level script touches `GM_*`.

---

## 2. Edge & Opera (Chromium) — Trivial

Both are Blink+V8 and consume the **same MV3 package** with no code changes. `web_accessible_resources` object-form, `action`, `background.service_worker`, `sidePanel`, `declarativeNetRequest` — all identical. The extension uses **no** blocking `webRequest` (it captures traffic by patching page globals in MAIN world, not via `webRequest`), so the biggest Chromium-MV3 divergence doesn't apply.

**The one real caveat — Google OAuth.** `chrome.identity.getAuthToken` is **Chrome-only** (it federates the browser's signed-in Google profile). Edge and Opera do **not** implement it. So even on Chromium siblings, everything in `google-tasks.ts` / `google-drive-sync.ts` / `calendar.ts` (Calendar, Tasks, Drive backup, Gmail read) **will not authenticate** until a `launchWebAuthFlow` fallback exists (§4.4). All non-Google features (all six platform adapters, LLM, local storage, side panel) work untouched.

**Per-target notes:**
- **Edge:** `chrome.sidePanel` is supported. Submit the same ZIP to **Edge Add-ons** (separate manual review). Nothing else to do.
- **Opera:** Chromium-based; can also install Chrome Web Store extensions directly. `chrome.sidePanel` support on Opera is **[verify]** — Opera has its own sidebar model; if `sidePanel` is unavailable, Opera falls into the same "no side panel" rework as Safari (§5), so validate this first before calling Opera "done."

**Files touched:** none for a functional Chromium port; `background/service-worker.ts` + the three `google-*.ts` modules only if you want Google features on Edge/Opera (that work is shared with the Firefox/Safari OAuth rewrite — do it once).

**Phase 1 exit test:** load the built `dist/` unpacked in Edge and Opera, exercise each of the six adapters + LLM + side panel; confirm only Google features are degraded.

---

## 3. What is engine-independent (do NOT re-port)

Before the per-engine breakdown, the parts that need **zero** change on any engine:

1. **`packages/adapter-core/src/network-interceptor.ts`** — patches `window.fetch`, `XMLHttpRequest.prototype.{open,send}`, and `WebSocket` only. Uses `Proxy` + `Reflect.construct` (constructor trap), `EventTarget.prototype.addEventListener`, `Object.getOwnPropertyDescriptor` + `Object.defineProperty` (the `onmessage` native-setter compose), and `WeakSet`. Every one of these is ES2015/ES2022-baseline and has been stable in **SpiderMonkey and JavaScriptCore for years**. No `chrome.*`. See §4.3 for the explicit SpiderMonkey/JavaScriptCore assessment.
2. **All six adapters** (`adapters/*/src/`) — pure parsing + normalization over intercepted payloads.
3. **`packages/context-engine`, `packages/store`** (the Dexie/OPFS layer) — standard IndexedDB + Web Crypto + OPFS APIs (durability caveat on Safari, §5.5, is a *runtime* risk, not a *code* change).
4. **`background/llm.ts`** — provider `fetch` calls (host-permission/CORS concerns are the same on every engine).
5. The **compose native-value-setter** and `dispatchEvent(new InputEvent(...))` typing pattern in `grindr/lib/compose.js` and `sniffies/lib/compose.js` — standard DOM, engine-independent.

---

## 4. Firefox (Gecko/SpiderMonkey) — Moderate

Firefox accepts MV3, so the package shape is close, but four subsystems break.

### 4.1 `chrome.*` → `browser.*` (namespace + promise split)

Firefox natively exposes promise-based `browser.*` and *also* aliases callback-style `chrome.*`, so much of the raw `chrome.*` code will run — but relying on Chrome's exact callback semantics is fragile, and mixed callback/promise code (the repo has both) is exactly what drifts. **Recommended:** adopt **`webextension-polyfill`**, load it first in every context (service worker `import` first; each bridge; `panel.js`; `popup.js`), and convert to `async/await`. On Firefox/Safari the polyfill is a near-no-op; on Chromium it does the real wrapping — so this is a **one-time change that helps all non-Chrome targets at once**.
- Lowest-effort alternative for a first Firefox pass: the zero-dep shim `globalThis.browser ??= globalThis.chrome;` — but it keeps callback semantics and won't fix promise-shape mismatches. Prefer the real polyfill.
- **Files:** wherever `chrome.` appears — heaviest in `background/service-worker.ts` (674 `sendMessage`, the alarms, contextMenus, notifications, downloads), `sidepanel/panel.js`, all `content/*-bridge.ts`, `packages/store/src/{google-tasks,google-drive-sync,calendar}.ts`.

### 4.2 Background: `service_worker` → also ship `scripts`

Firefox's MV3 `background.service_worker` support is maturing but the **event-page** path (`scripts` + `persistent:false`) is more mature **[verify]**. Ship **both** keys so each engine reads the one it supports:
```jsonc
"background": {
  "service_worker": "background/service-worker.js",  // Chrome/Edge/Opera/Safari
  "scripts": ["background/service-worker.js"],        // Firefox event page
  "type": "module"
}
```
The SW is already written to be lifecycle-safe (state in Dexie, `chrome.alarms` for all recurring work, top-level `onMessage` registration — `docs/ARCHITECTURE.md` §"Service-worker lifecycle"), so it survives an event-page model. Verify `chrome.alarms` min-interval and `chrome.storage.session` behavior on Firefox **[verify]**.

### 4.3 The MAIN-world interception on SpiderMonkey

**Verdict: no changes needed.** `network-interceptor.ts` and the WebSocket `Proxy` construct trap, `Reflect.construct(ctor, args, newTarget)`, the `onmessage` descriptor recompose, and `EventTarget.prototype.addEventListener` recursion-avoidance all use baseline ES that SpiderMonkey has shipped for years. The only Firefox-specific wrinkle is **injection timing**, not the patch itself:
- The repo injects the MAIN-world IIFE **via the bridge's `<script>`-tag injection from a `web_accessible_resources` entry** — it does **not** use the MV3 `world: "MAIN"` content-script key. Firefox's `world: "MAIN"` support arrived later than Chrome's **[verify]**, so **the repo's injection approach is actually the more portable one** and avoids that gap. Keep it.
- Validate that the bridge's injected script runs before the page opens its Sniffies WebSocket (the `document_start` race is identical across engines; the interceptor already handles pre-existing sockets via the `addEventListener`/`onmessage` hooks). Confirm `web_accessible_resources` object-form resolves the injected URL on Firefox.

### 4.4 Google OAuth: `getAuthToken` → `launchWebAuthFlow`

`chrome.identity.getAuthToken` and the `manifest.oauth2` block are **Chrome-only**. Firefox supports `browser.identity.launchWebAuthFlow` + `browser.identity.getRedirectURL()` but **not** `getAuthToken`. This is the biggest *code* change in the Firefox port:
- Rewrite `getAuthToken()` in `packages/store/src/google-tasks.ts`, `google-drive-sync.ts`, and `calendar.ts` to run a standard **OAuth 2.0 Authorization Code + PKCE** flow through `launchWebAuthFlow` (no client secret in a public client), parse the redirect, and manage token refresh manually (today `chrome.identity` owns refresh — see the comment in `calendar.ts:96`). Store the refresh token in Dexie/`storage`.
- Register a **new Google Cloud OAuth client** whose redirect URI is the Firefox extension's `getRedirectURL()` (`https://<gecko-id>.extensions.allizom.org/...` style **[verify]**), and add the extension's stable **`gecko.id`** (§4.5).
- Because Edge/Opera also lack `getAuthToken` (§2), **this rewrite is shared across every non-Chrome target** — build it once as a `launchWebAuthFlow` path with a `getAuthToken` fast-path only when `chrome.identity.getAuthToken` exists.
- `manifest.oauth2` can stay for Chrome; Firefox ignores it.

### 4.5 Manifest: `browser_specific_settings.gecko.id`

Add:
```jsonc
"browser_specific_settings": { "gecko": { "id": "aggregaytor@<yourdomain>", "strict_min_version": "115.0" } }
```
Required for AMO, stable extension identity, and the OAuth redirect URI. Chrome/Safari ignore it.

### 4.6 Side panel → `sidebar_action`

Firefox has **no `chrome.sidePanel`**; it uses the `sidebar_action` manifest key + the `browser.sidebarAction` API. The UI itself (`sidepanel/panel.html/.css/.js`) is plain HTML/JS and renders fine in a sidebar; only the **shell wiring** changes:
```jsonc
"sidebar_action": { "default_panel": "sidepanel/panel.html", "default_title": "Aggregaytor", "default_icon": "icons/icon-48.png" }
```
- Replace `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick })` (`service-worker.ts:4294`) and `chrome.sidePanel.open({ tabId })` (`service-worker.ts:4364`) with `browser.sidebarAction.open()` / `toggle()` — note `sidebarAction.open()` must be called from a user gesture on Firefox **[verify]**.
- `panel.js:5299` reads `window.chrome?.sidePanel` for responsive detection; add a `sidebarAction`/feature-detect branch.
- Abstract this behind a small `openPanel()` / `panelHost` shim so Chrome (`sidePanel`), Firefox (`sidebarAction`), and Safari (§5.2) each provide their own implementation.

### 4.7 Packaging & review (AMO)

`web-ext lint` → `web-ext build` → Mozilla signs the XPI (required even for self-distribution). Upload **source** since the extension is bundled/minified by Vite. Use `web-ext run` for the dev loop. Note: Firefox prompts the user to grant MV3 **host permissions** at install/runtime — the seven `host_permissions` entries won't be granted silently; the adapters must tolerate "host not yet granted."

**Firefox exit test:** all six adapters capture (Sniffies WS + REST platforms), side panel opens in the Firefox sidebar, Google OAuth completes via `launchWebAuthFlow`, `web-ext lint` clean.

---

## 5. Safari (WebKit/JavaScriptCore) — Major

Safari accepts MV3 and honors `browser.*` promises natively, but three things make it the heavy lift: the **Xcode/App-Store wrapper**, the **total absence of any side-panel API**, and **storage durability** for a local-first data store under WebKit/ITP.

### 5.1 Conversion, Xcode, distribution

Safari extensions **cannot** be loaded as a folder — they must be embedded in a macOS (and/or iOS) app and shipped through the **App Store**.
```bash
xcrun safari-web-extension-converter extensions/aggregaytor/dist \
  --app-name "Aggregaytor" --bundle-identifier com.<you>.aggregaytor
```
- Build/sign in **Xcode 16+/iOS 18 SDK** (App Store bar since Apr 24 2025 **[verify]**), archive → **App Store Connect** → full App Review (app **and** extension). Requires the **Apple Developer Program ($99/yr)**.
- Dev loop: enable **Develop → Allow Unsigned Extensions** (resets each Safari launch) to test the converted extension without full signing.
- Adopt the `webextension-polyfill` from the Firefox pass (or rely on Safari's native `browser.*`); the `browser.*` migration is shared work.
- If macOS-only is acceptable initially, `--macos-only` narrows scope; iOS Safari adds its own UI constraints (no sidebar at all).

### 5.2 The side panel — the biggest UI rework

Safari has **neither `sidePanel` nor `sidebar_action`.** The entire app UI lives in `sidepanel/panel.*`, so a Safari build needs a different host. Concrete options, best-first:
1. **Full-tab / extension page** — ship `panel.html` as an extension page opened in a new tab via `browser.tabs.create({ url: browser.runtime.getURL('sidepanel/panel.html') })`, triggered from the toolbar `action` (and/or a `contextMenus` item). Lowest-risk: `panel.js` runs essentially unchanged; it just isn't docked. **Recommended first cut.**
2. **Toolbar popup** — set `action.default_popup: "sidepanel/panel.html"`. Reuses the UI but constrained popup sizing and dismiss-on-blur make a 3500-line inbox app awkward; viable as a compact view, not the primary surface.
3. **In-page injected panel** — a content-script-rendered docked overlay (Shadow-DOM sidebar) on the platform tabs. Most Safari-native feel, most work, and it forces the whole panel↔SW message layer to run from a content script instead of an extension page.

Do this behind the same `panelHost` shim from §4.6. Replace the two `chrome.sidePanel.*` calls in `service-worker.ts` and the `panel.js:5299` detection with the Safari branch.

### 5.3 The MAIN-world interception on JavaScriptCore

**Verdict: no changes needed.** Same assessment as SpiderMonkey (§4.3): the `Proxy` construct trap, `Reflect.construct` with `newTarget`, `EventTarget.prototype.addEventListener`, `WeakSet`, and the `Object.defineProperty` `onmessage` recompose are all long-stable in JavaScriptCore. The MAIN-world IIFE injection via `web_accessible_resources` works under Safari's content-script model. Two things to **[verify]** empirically rather than assume:
- Content-script **injection timing** at `document_start` on WebKit vs. the page's own socket/`fetch` setup (the interceptor's pre-existing-socket hooks cover a late install, so this is a completeness check, not a blocker).
- `web_accessible_resources` URL resolution and CSP for the injected `<script>` under Safari.

### 5.4 Google OAuth on Safari

Same as Firefox (§4.4): no `getAuthToken`; use `browser.identity.launchWebAuthFlow` with the Safari extension's redirect URL and a dedicated Google OAuth client. Shared code with the Firefox/Edge/Opera path.

### 5.5 ITP, storage partitioning, and the 7-day cap — **the top runtime risk**

This is the one that can silently corrupt the product's value proposition (local-first data), so it must be validated first, not last.
- **Captured-auth / cookie-session replay (adapters):** the MAIN-world interception and `api-sender` replay run **in the platform page's own first-party context**, using the page's live same-site credentials. That is the ITP-friendly case — first-party cookies for `sniffies.com`/`web.grindr.com` are available to that page's own `fetch`. Cross-site cookie access is not needed. **Low risk, but [verify]** that Safari doesn't partition/withhold cookies on the specific XHR/fetch/WS the adapters replay.
- **Dexie/IndexedDB + OPFS durability (`aggregaytor_dexie`, `opfs-backup.ts`):** WebKit's ITP caps *script-writable storage* for **websites** at ~7 days of no interaction, and Safari has historically been aggressive about evicting IndexedDB under storage pressure. Extension-origin storage (`safari-web-extension://…`, i.e. the background/panel contexts) is generally **exempt** from the 7-day website cap, but this is **exactly the assumption to prove**, because the whole store is local-first with no remote replication (`sync.ts` throws). **Action:** before committing to Safari, run a durability probe — write a large `aggregaytor_dexie` dataset + OPFS snapshot from the extension context, leave Safari idle/backgrounded for >7 days and across relaunches, and confirm the data and OPFS snapshot survive. The `unlimitedStorage` permission and `navigator.storage.persist()` **[verify]** are the mitigations; the encrypted OPFS snapshot (`opfs-backup.ts`) is the backstop, but only if OPFS itself persists.

### 5.6 Native messaging (only if needed)

The wrapper app can host an `SFSafariExtensionHandler` (Swift) for native messaging; the repo doesn't use native messaging today, so this is out of scope unless a Safari-specific capability (e.g., background durability) forces it.

**Safari exit test:** converted app builds/signs in Xcode; all six adapters capture; the chosen `panelHost` renders the full inbox; Google OAuth completes; **the 7-day durability probe passes**.

---

## 6. The userscripts (grindr / sniffies)

Two independent behavior classes, because the two scripts already sit at opposite ends of the sandbox spectrum.

### 6.1 Grindr — `@grant none`, page world

`grindr/Grindr Middle-Click Block.user.js` runs **unsandboxed in the page world** (`@grant none`), so its `window` *is* the page's `window` — no `unsafeWindow`, no `GM_*`. It patches `fetch`, resolves profile IDs, and POSTs hides/blocks with the page's own credentials.
- **Tampermonkey / Violentmonkey (Chrome/Edge/Opera/Firefox):** works as-is; `@grant none` + `@run-at document-start` are honored by all. Only nuance: `@grant none`'s "which window do I get" is slightly manager-variable **[verify]** — but this script *wants* the page window, which is what `@grant none` gives everywhere.
- **Greasemonkey (Firefox):** GM4 dropped `GM_*` but this script uses none, so it's compatible. Confirm GM4's `document-start` timing (looser than Tampermonkey's) still lands the `fetch` patch before Grindr's first request; the interceptor's guards make a late install non-fatal.
- **Safari Userscripts app:** should run (no `GM_*`/`@connect` used, since it uses page `fetch` not `GM.xmlHttpRequest`). **[verify]** injection timing at `document-start` on WebKit.
- **`lib/` audit:** `grindr/lib/*.js` (`auth`, `blocks`, `chat`, `compose`, `dom`, `observe`, `reconcile`, …) are **browser-agnostic** — DOM + `globalThis` + `fetch`. `compose.js` uses the native value setter + `dispatchEvent`, all standard. Nothing manager-specific. These are the modules vendored into the extension, and they carry over cleanly.

### 6.2 Sniffies — `GM_*` + `unsafeWindow`, sandboxed

`sniffies/sniffiesplus.js` runs **sandboxed** with `@grant GM_getValue/GM_setValue/GM_deleteValue/GM_openInTab` (+ `GM.*` forms) and reaches page globals via `unsafeWindow` (18 refs).
- **Tampermonkey / Violentmonkey (all Chromium + Firefox):** works; both support `GM_*` and `GM.*` and `unsafeWindow`.
- **Greasemonkey (Firefox):** **breaks** — GM4 exposes only promise-based `GM.*`; synchronous `GM_getValue`/`GM_setValue`/`GM_deleteValue` throw. The header already declares both `GM_*` and `GM.*` grants, but the **call sites** use the sync `GM_*` forms. **Fix:** rewrite storage/open calls to `await GM.*` and add a `GM.* → GM_*` fallback shim for old managers (write async, degrade sync). Also verify `unsafeWindow` availability/timing under Greasemonkey's stricter isolation.
- **Safari Userscripts app:** supports `GM_*`/`GM.*` + `unsafeWindow`, but injection timing and (if ever added) `@connect`/`GM.xmlHttpRequest` behavior differ — **[verify]**. No Tampermonkey-for-free/Violentmonkey on Safari, so Userscripts is the target.
- **`lib/` audit:** `sniffies/lib/*.js` (`api`, `compose`, `dom`, `errors`, `limiter`, `observe`) are **browser-agnostic** — the only "manager" coupling is that `observe.js` documents passing `unsafeWindow` as the observed target (a comment/param, not a hard dependency). All GM/`unsafeWindow` coupling lives in the **top-level** `sniffiesplus.js`, which is the only file needing manager-aware edits.
- **CSP note:** both scripts use **page `fetch`** (first-party, same-site) rather than `GM.xmlHttpRequest`, so no `@connect` is required and page CSP for same-origin requests is a non-issue. If any future cross-origin call is added, route it through `GM.xmlHttpRequest` + `@connect`.

### 6.3 Userscript porting summary

| Script | TM/VM (Chromium+FF) | Greasemonkey (FF) | Safari Userscripts | Work |
|---|---|---|---|---|
| Grindr | ✅ as-is | ✅ (no `GM_*`) | ✅ **[verify]** timing | none functional; verify timing |
| Sniffies | ✅ as-is | ❌ sync `GM_*` throws | ✅ **[verify]** timing | rewrite `GM_*` call sites → `await GM.*` + shim |

`lib/` modules are shared and browser-agnostic in both — the port cost is entirely in the two top-level `.user.js` files.

---

## 7. Prioritized, phased roadmap

**Phase 1 — Edge & Opera (Trivial, days).**
- Load the existing `dist/` in Edge and Opera; smoke-test all six adapters + LLM + side panel.
- **[verify]** Opera `chrome.sidePanel` support — if absent, Opera inherits the Safari side-panel rework and is no longer trivial.
- Submit the same ZIP to Edge Add-ons and Opera. Google features stay degraded until Phase 2's OAuth work.
- *Files:* none (packaging only).

**Phase 2 — Shared "de-Chrome" refactor (enables FF + Safari + fixes Edge/Opera Google).**
- Add `webextension-polyfill`, load-first in every context, convert to `async/await`. *Files:* `background/service-worker.ts`, `sidepanel/panel.js`, `popup/popup.js`, all `content/*-bridge.ts`, `packages/store/src/google-*.ts`.
- Build the `launchWebAuthFlow` OAuth path with a `getAuthToken` fast-path. *Files:* `packages/store/src/{google-tasks,google-drive-sync,calendar}.ts` + a new Google OAuth client. This immediately restores Google features on **Edge/Opera** too.
- Introduce the `panelHost` shim (Chrome `sidePanel` / FF `sidebarAction` / Safari page-or-popup). *Files:* `service-worker.ts` (the two `sidePanel` calls), `panel.js:5299`.

**Phase 3 — Firefox (Moderate).**
- Manifest: dual `background` keys, `browser_specific_settings.gecko.id`, `sidebar_action`. *Files:* `manifest.json`.
- Wire `sidebarAction` branch of `panelHost`; wire FF redirect URL into OAuth.
- Validate MAIN-world injection timing + `web_accessible_resources` on Gecko; `chrome.alarms`/`storage.session` behavior.
- `web-ext lint`/`run`/`build`; AMO signing (upload source).

**Phase 4 — Safari (Major).**
- **First:** run the §5.5 **storage-durability probe** (7-day IndexedDB/OPFS survival from the extension context) — a red result changes the whole plan (may force native messaging / a different persistence layer). Validate first-party cookie replay for the adapters.
- `xcrun safari-web-extension-converter` → Xcode 16+ project; sign/notarize; App Store Connect.
- Implement the Safari `panelHost` (full-tab page as first cut; popup/injected panel later).
- Wire Safari redirect URL into OAuth. Validate MAIN-world injection timing on JSC.
- App Review submission (app + extension).

**Phase 5 — Userscripts (parallelizable with any phase).**
- Grindr: verify on TM/VM/Greasemonkey/Userscripts; no code change expected.
- Sniffies: rewrite top-level `GM_*` call sites to `await GM.*` + shim; verify `unsafeWindow` under Greasemonkey; verify Safari Userscripts timing. *Files:* `sniffies/sniffiesplus.js` only.

---

## 8. Top-5 highest-risk unknowns to validate FIRST

1. **Safari local-storage durability (ITP / 7-day cap / IndexedDB eviction).** The product is local-first with no remote replication (`sync.ts` throws). If `aggregaytor_dexie` + `opfs-backup.ts` data doesn't survive Safari idle/eviction from the extension context, the Safari port is fundamentally compromised. **Probe before any other Safari work.** [verify]
2. **`chrome.identity.getAuthToken` is Chrome-only — breaks Google features on Edge, Opera, Firefox, AND Safari.** All of `google-tasks.ts`/`google-drive-sync.ts`/`calendar.ts` + `manifest.oauth2` must move to `launchWebAuthFlow` + a new OAuth client with per-browser redirect URIs and manual token refresh. Prototype one provider end-to-end early. [verify redirect-URI formats]
3. **Side-panel replacement, esp. Safari (no `sidePanel` and no `sidebar_action`).** The entire ~3500-line UI is the side panel. Firefox → `sidebar_action` is mechanical; Safari needs a genuinely different host (full-tab page recommended). Also **[verify] Opera `chrome.sidePanel`** — a negative flips Opera from trivial to a rework.
4. **MAIN-world content-script injection timing on WebKit and Gecko.** The *patch* is engine-independent (confirmed by reading `network-interceptor.ts`), but whether the bridge's injected IIFE lands before the page's first Sniffies WebSocket / REST call at `document_start` on Safari/Firefox must be measured. Low-severity fallbacks exist (pre-existing-socket hooks), but capture gaps would be user-visible. [verify]
5. **Sniffies userscript on Greasemonkey (sync `GM_*` throws under GM4).** The only functional userscript regression found. Requires rewriting the top-level `sniffiesplus.js` storage/open calls to `await GM.*` + a fallback shim, and confirming `unsafeWindow` timing under Greasemonkey's stricter isolation.
