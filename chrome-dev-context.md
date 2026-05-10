# Chrome Extension API & DevTools MCP — Developer Context

> Compiled reference for LLM use. Sources: [Chrome Extension API Docs](https://developer.chrome.com/docs/extensions/reference/api), [chrome-devtools-mcp GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp), [MCP Tool Reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md).

---

## Table of Contents

1. [MV3 Architecture Fundamentals](#1-mv3-architecture-fundamentals)
2. [Full Chrome API Index](#2-full-chrome-api-index)
3. [Core APIs — Deep Reference](#3-core-apis--deep-reference)
   - [chrome.tabs](#chromtabs)
   - [chrome.runtime](#chromeruntime)
   - [chrome.scripting](#chromescripting)
   - [chrome.storage](#chromestorage)
   - [chrome.action](#chromeaction)
   - [chrome.offscreen](#chromeoffscreen)
   - [chrome.declarativeNetRequest](#chromedeclarativenetrequest)
   - [chrome.webRequest](#chromewebrequest)
   - [chrome.windows](#chromewindows)
   - [chrome.cookies](#chromecookies)
   - [chrome.identity](#chromeidentity)
   - [chrome.alarms](#chromealarms)
   - [chrome.notifications](#chromenotifications)
   - [chrome.contextMenus](#chromecontextmenus)
   - [chrome.commands](#chromecommands)
   - [chrome.history](#chromehistory)
   - [chrome.webNavigation](#chromewebnavigation)
   - [chrome.sidePanel](#chromesidepanel)
   - [chrome.tabGroups](#chrometabgroups)
   - [chrome.downloads](#chromedownloads)
   - [chrome.devtools.*](#chromedevtools)
   - [chrome.debugger](#chromedebugger)
4. [Messaging Patterns](#4-messaging-patterns)
5. [Manifest V3 Snippets & Recipes](#5-manifest-v3-snippets--recipes)
6. [Chrome DevTools MCP Server](#6-chrome-devtools-mcp-server)
7. [MCP Tool Reference — All 44 Tools](#7-mcp-tool-reference--all-44-tools)

---

## 1. MV3 Architecture Fundamentals

### Execution Contexts (do NOT share memory)

| Context | Has DOM | Chrome APIs | Lifetime |
|---|---|---|---|
| **Service Worker** | ❌ | Almost all | Disposable — suspend/resume |
| **Popup** | ✅ | Almost all | Until popup closed |
| **Options page** | ✅ | Almost all | Until tab closed |
| **Side panel** | ✅ | Almost all | Persistent |
| **Offscreen document** | ✅ | `runtime` only | Explicit create/close |
| **Content script** | ✅ (page DOM) | Limited subset | Page lifetime |
| **DevTools page** | ✅ | `devtools.*` + limited | DevTools open |

### Key Constraints

- **Static imports only** in the MV3 service worker — `import()` is disallowed at runtime
- **Service worker is disposable** — any module-global state can vanish; persist to `chrome.storage.*` or IndexedDB
- Contexts communicate via `chrome.runtime.sendMessage` / `chrome.storage` / IndexedDB
- All `chrome.*` APIs are also available as `browser.*` (Firefox-compatible alias) since Chrome 146
- All async APIs return Promises; the old callback style still works

### Manifest V3 Minimal Structure

```json
{
  "manifest_version": 3,
  "name": "My Extension",
  "version": "1.0.0",
  "permissions": ["storage", "tabs", "scripting"],
  "host_permissions": ["https://*.example.com/*"],
  "background": {
    "service_worker": "src/background/service-worker.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": "icons/icon48.png"
  },
  "content_scripts": [{
    "matches": ["https://*.example.com/*"],
    "js": ["src/content/content.js"]
  }],
  "web_accessible_resources": [{
    "resources": ["src/offscreen/offscreen.html"],
    "matches": ["<all_urls>"]
  }]
}
```

---

## 2. Full Chrome API Index

All APIs in the `chrome.*` namespace (MV3):

| API | Purpose |
|---|---|
| `accessibilityFeatures` | Read/modify browser accessibility settings |
| `action` | Toolbar button icon, badge, popup |
| `alarms` | Periodic/scheduled callbacks (survives service worker sleep) |
| `audio` | ChromeOS: list/configure audio devices |
| `bookmarks` | CRUD browser bookmarks |
| `browsingData` | Delete history, cookies, cache, passwords |
| `certificateProvider` | Enterprise: supply TLS client certificates |
| `commands` | Keyboard shortcuts for extension actions |
| `contentSettings` | Per-site: cookies, JS, images, plugins |
| `contextMenus` | Right-click context menu items |
| `cookies` | Read/write/delete browser cookies |
| `debugger` | Attach Chrome DevTools protocol to tabs |
| `declarativeContent` | Show action based on page URL/CSS rules |
| `declarativeNetRequest` | Block/redirect/modify headers (privacy-safe, MV3 preferred) |
| `desktopCapture` | Prompt user to share screen/window/tab |
| `devtools.inspectedWindow` | Eval in inspected page; get resource list |
| `devtools.network` | Observe network requests from DevTools |
| `devtools.panels` | Create panels/sidebars in DevTools UI |
| `devtools.performance` | DevTools performance panel integration |
| `devtools.recorder` | DevTools Recorder integration |
| `dns` | Resolve DNS hostnames |
| `documentScan` | ChromeOS: scan with attached scanner |
| `dom` | `dom.openOrClosedShadowRoot()` — pierce shadow DOM |
| `downloads` | Initiate/manage downloads |
| `enterprise.*` | Enterprise device/platform attributes |
| `events` | Base types for event patterns |
| `extension` | Legacy utils (prefer `runtime`) |
| `extensionTypes` | Shared type definitions |
| `fontSettings` | Get/set default browser fonts |
| `gcm` | Google Cloud Messaging push |
| `history` | Read/modify browser history |
| `i18n` | Internationalization / `_locales` |
| `identity` | OAuth2 flows, `getAuthToken` |
| `idle` | Detect system idle/locked state |
| `input.ime` | ChromeOS: custom input method engines |
| `management` | List/manage installed extensions |
| `notifications` | Rich desktop notifications |
| `offscreen` | Headless DOM context for service workers |
| `omnibox` | Address bar keyword integration |
| `pageCapture` | Save page as MHTML |
| `permissions` | Request optional permissions at runtime |
| `power` | Prevent system sleep |
| `printing` / `printingMetrics` | ChromeOS: print jobs |
| `privacy` | Browser privacy feature toggles |
| `processes` | Tab process info |
| `proxy` | Configure proxy settings |
| `readingList` | Chrome reading list CRUD |
| `runtime` | Lifecycle, messaging, extension metadata |
| `scripting` | Inject JS/CSS into pages |
| `search` | Trigger browser searches |
| `sessions` | Access recently closed tabs/windows |
| `sidePanel` | Persistent side panel UI |
| `storage` | Key-value store (local/sync/session/managed) |
| `system.*` | CPU, display, memory, storage info |
| `tabCapture` | Capture tab audio/video stream |
| `tabGroups` | Tab group CRUD |
| `tabs` | Tab lifecycle, navigation, messaging |
| `topSites` | Most visited sites |
| `tts` / `ttsEngine` | Text-to-speech |
| `userScripts` | Managed user script injection |
| `vpnProvider` | ChromeOS VPN platform |
| `webAuthenticationProxy` | WebAuthn credential management |
| `webNavigation` | Fine-grained navigation events |
| `webRequest` | Observe/intercept HTTP requests |
| `windows` | Browser window lifecycle |

---

## 3. Core APIs — Deep Reference

### chrome.tabs

**Permissions:** `"tabs"` (for `url`/`title` properties), `"activeTab"` (temporary on user action), or `host_permissions`

```js
// Query active tab in current window
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// Create a new tab
const newTab = await chrome.tabs.create({ url: 'https://example.com', active: false });

// Update: navigate + pin
await chrome.tabs.update(tabId, { url: 'https://example.com', pinned: true });

// Move tab to position
await chrome.tabs.move(tabId, { windowId: windowId, index: 0 });

// Remove/close tabs
await chrome.tabs.remove([tabId1, tabId2]);

// Capture visible area as PNG data URL (needs "activeTab" or host permission)
const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });

// Send message to content script in a tab
const response = await chrome.tabs.sendMessage(tabId, { type: 'getData' });

// Tab lifecycle events
chrome.tabs.onCreated.addListener(tab => console.log('created', tab.id));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') console.log('loaded', tab.url);
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  console.log('closed', tabId, removeInfo.isWindowClosing);
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  console.log('activated', tabId);
});
```

**Key Tab properties:** `id`, `windowId`, `index`, `url`, `title`, `status` (`loading`|`complete`), `active`, `pinned`, `audible`, `mutedInfo`, `favIconUrl`, `groupId`, `incognito`

---

### chrome.runtime

**Core messaging, lifecycle, and extension metadata**

```js
// Lifecycle
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason === 'install') { /* first install */ }
  if (reason === 'update') { /* version upgrade */ }
});
chrome.runtime.onStartup.addListener(() => { /* browser started */ });

// Extension metadata
const manifest = chrome.runtime.getManifest(); // parsed manifest.json
const url = chrome.runtime.getURL('src/offscreen/offscreen.html');
const id = chrome.runtime.id;

// One-time messaging (background ↔ popup/content/options)
// Sender:
const response = await chrome.runtime.sendMessage({ type: 'ping' });
// Receiver (in service worker):
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') sendResponse({ pong: true });
  return true; // return true to keep channel open for async sendResponse
});

// Long-lived connections (ports)
// From content script or popup:
const port = chrome.runtime.connect({ name: 'myChannel' });
port.postMessage({ data: 'hello' });
port.onMessage.addListener(msg => console.log(msg));
// In service worker:
chrome.runtime.onConnect.addListener(port => {
  port.onMessage.addListener(msg => port.postMessage({ echo: msg }));
  port.onDisconnect.addListener(() => console.log('disconnected'));
});

// Get all active contexts (Chrome 116+)
const contexts = await chrome.runtime.getContexts({
  contextTypes: ['OFFSCREEN_DOCUMENT']
});

// Native messaging
const nativePort = chrome.runtime.connectNative('com.example.app');
nativePort.postMessage({ command: 'hello' });
chrome.runtime.sendNativeMessage('com.example.app', { cmd: 'query' }, resp => {
  console.log(resp);
});

// Errors
if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message);
```

---

### chrome.scripting

**Permission:** `"scripting"` + host permissions or `"activeTab"`

```js
// Inject a function (preferred — avoids file loading)
const results = await chrome.scripting.executeScript({
  target: { tabId, allFrames: false },
  func: (arg) => {
    return document.title + ' ' + arg;
  },
  args: ['extra'],
});
console.log(results[0].result);

// Inject a script file
await chrome.scripting.executeScript({
  target: { tabId },
  files: ['src/content/inject.js']
});

// In a specific frame
await chrome.scripting.executeScript({
  target: { tabId, frameIds: [frameId] },
  func: () => document.querySelectorAll('a').length
});

// Insert/remove CSS
await chrome.scripting.insertCSS({
  target: { tabId },
  css: 'body { background: red !important; }'
});
await chrome.scripting.removeCSS({
  target: { tabId },
  css: 'body { background: red !important; }'
});

// Register persistent content scripts
await chrome.scripting.registerContentScripts([{
  id: 'my-script',
  matches: ['https://*.example.com/*'],
  js: ['src/content/content.js'],
  runAt: 'document_idle'
}]);
await chrome.scripting.unregisterContentScripts({ ids: ['my-script'] });
```

---

### chrome.storage

**Four storage areas:**

| Area | Quota | Persists | Notes |
|---|---|---|---|
| `local` | 10 MB (unlimitedStorage: unlimited) | ✅ disk | Default choice |
| `sync` | 100 KB total, 8 KB/item | ✅ cross-device | Requires signed-in Chrome |
| `session` | 10 MB | ❌ (clears on browser restart) | Fast in-memory; service-worker safe |
| `managed` | — | ✅ | Enterprise policy; read-only |

```js
// Write
await chrome.storage.local.set({ key: 'value', obj: { a: 1 } });

// Read
const data = await chrome.storage.local.get(['key', 'obj']);
const all = await chrome.storage.local.get(null); // everything

// Read with defaults
const { theme = 'dark' } = await chrome.storage.local.get({ theme: 'dark' });

// Remove / clear
await chrome.storage.local.remove(['key']);
await chrome.storage.local.clear();

// Watch for changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
    console.log(`${areaName}/${key}: ${oldValue} → ${newValue}`);
  }
});

// storage.session is great for tab-scoped data that survives worker sleep
await chrome.storage.session.set({ activeTabData: {} });
```

---

### chrome.action

**Controls the toolbar button (icon, badge, popup, tooltip)**

**Permission:** None required for basic use

```js
// Badge text and color
await chrome.action.setBadgeText({ text: '3', tabId }); // tabId optional
await chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });

// Popup path (can change dynamically)
await chrome.action.setPopup({ popup: 'popup-alt.html', tabId });

// Icon (ImageData or path)
await chrome.action.setIcon({ path: { 16: 'icon16.png', 48: 'icon48.png' } });

// Title / tooltip
await chrome.action.setTitle({ title: 'Custom tooltip' });

// Enable/disable
await chrome.action.disable(tabId);
await chrome.action.enable(tabId);

// Toolbar click event (when popup is NOT set)
chrome.action.onClicked.addListener(tab => {
  console.log('action clicked on tab', tab.id);
});
```

---

### chrome.offscreen

**Permission:** `"offscreen"` | **Requires:** Chrome 109+ MV3

Use when service worker needs DOM APIs (clipboard, DOMParser, audio, WebRTC, etc.)

```js
// ---- service worker ----

// Helper: ensure offscreen document exists
let creating;
async function ensureOffscreen(path) {
  const url = chrome.runtime.getURL(path);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (existing.length > 0) return;
  if (creating) { await creating; return; }
  creating = chrome.offscreen.createDocument({
    url: path,
    reasons: ['DOM_PARSER'],        // must match actual usage
    justification: 'Parse HTML content',
  });
  await creating;
  creating = null;
}

// Use it:
await ensureOffscreen('src/offscreen/offscreen.html');
const result = await chrome.runtime.sendMessage({
  target: 'offscreen',
  type: 'parseHTML',
  data: rawHtml
});

// Tear down when done
await chrome.offscreen.closeDocument();
```

**Valid `reasons`:** `AUDIO_PLAYBACK`, `IFRAME_SCRIPTING`, `DOM_SCRAPING`, `BLOBS`, `DOM_PARSER`, `USER_MEDIA`, `DISPLAY_MEDIA`, `WEB_RTC`, `CLIPBOARD`, `LOCAL_STORAGE`, `WORKERS`, `BATTERY_STATUS`, `MATCH_MEDIA`, `GEOLOCATION`

**Offscreen document JS (offscreen.js):**
```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'parseHTML') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(msg.data, 'text/html');
    sendResponse({ title: doc.title });
  }
  return true; // async response
});
```

---

### chrome.declarativeNetRequest

**The MV3 way to intercept network requests (privacy-safe, no request body access)**

**Permission:** `"declarativeNetRequest"` or `"declarativeNetRequestWithHostAccess"`

```json
// manifest.json
{
  "permissions": ["declarativeNetRequest"],
  "declarative_net_request": {
    "rule_resources": [{
      "id": "ruleset_1",
      "enabled": true,
      "path": "rules/blocking_rules.json"
    }]
  }
}
```

```json
// rules/blocking_rules.json
[
  {
    "id": 1,
    "priority": 1,
    "action": { "type": "block" },
    "condition": {
      "urlFilter": "||ads.example.com^",
      "resourceTypes": ["script", "image"]
    }
  },
  {
    "id": 2,
    "priority": 1,
    "action": { "type": "redirect", "redirect": { "url": "https://safe.example.com" } },
    "condition": { "urlFilter": "||malicious.com^" }
  },
  {
    "id": 3,
    "priority": 1,
    "action": {
      "type": "modifyHeaders",
      "requestHeaders": [{ "header": "Referer", "operation": "remove" }],
      "responseHeaders": [{ "header": "X-Frame-Options", "operation": "remove" }]
    },
    "condition": { "urlFilter": "*" }
  }
]
```

```js
// Dynamic rules (JS, at runtime)
await chrome.declarativeNetRequest.updateDynamicRules({
  addRules: [{
    id: 100,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: '||tracking.com^', resourceTypes: ['xmlhttprequest'] }
  }],
  removeRuleIds: [99]
});

// Session rules (cleared on browser restart)
await chrome.declarativeNetRequest.updateSessionRules({ addRules: [...] });

// Query matched rules for debugging
const info = await chrome.declarativeNetRequest.testMatchOutcome({
  request: { url: 'https://ads.com/pixel.gif', type: 'image' }
});
```

---

### chrome.webRequest

> ⚠️ **MV3 Limitation:** Blocking (`webRequestBlocking`) only available to enterprise policy-installed extensions. Use `declarativeNetRequest` for blocking in normal extensions. Observing is still allowed.

**Permission:** `"webRequest"`, `"webRequestBlocking"` (enterprise only)

```js
// Observe all requests (non-blocking, informational)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    console.log('Request:', details.url, details.type, details.tabId);
  },
  { urls: ['https://*.example.com/*'] },
  ['requestBody'] // optional: include request body
);

// Request lifecycle events (in order):
// onBeforeRequest → onBeforeSendHeaders → onSendHeaders
// → onHeadersReceived → onAuthRequired → onBeforeRedirect
// → onResponseStarted → onCompleted | onErrorOccurred

// Observe response headers
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const csp = details.responseHeaders?.find(h =>
      h.name.toLowerCase() === 'content-security-policy'
    );
    if (csp) console.log('CSP:', csp.value);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);
```

---

### chrome.windows

```js
// Create a new window
const win = await chrome.windows.create({
  url: 'https://example.com',
  type: 'normal',         // 'normal' | 'popup' | 'panel'
  width: 800, height: 600,
  left: 100, top: 100,
  focused: true,
  incognito: false
});

// Get the current window
const current = await chrome.windows.getCurrent({ populate: true }); // populate = include tabs

// Focus a window
await chrome.windows.update(win.id, { focused: true });

// Events
chrome.windows.onCreated.addListener(win => {});
chrome.windows.onRemoved.addListener(windowId => {});
chrome.windows.onFocusChanged.addListener(windowId => {});
```

---

### chrome.cookies

**Permission:** `"cookies"` + host permissions for the cookie's domain

```js
// Get a specific cookie
const cookie = await chrome.cookies.get({
  url: 'https://example.com',
  name: 'session_id'
});

// Get all cookies for a domain
const cookies = await chrome.cookies.getAll({ domain: 'example.com' });

// Set a cookie
await chrome.cookies.set({
  url: 'https://example.com',
  name: 'my_cookie',
  value: 'abc123',
  secure: true,
  httpOnly: false,
  expirationDate: Math.floor(Date.now()/1000) + 3600 // 1 hour
});

// Remove
await chrome.cookies.remove({ url: 'https://example.com', name: 'my_cookie' });

// Watch for changes
chrome.cookies.onChanged.addListener(({ cookie, removed, cause }) => {
  console.log(removed ? 'removed' : 'set', cookie.name, 'cause:', cause);
});
```

---

### chrome.identity

**Permission:** `"identity"`; OAuth client ID in `oauth2.client_id` in manifest

```js
// Get Google OAuth2 token (silent/non-interactive)
const token = await chrome.identity.getAuthToken({ interactive: false });

// Force interactive login flow
const token = await chrome.identity.getAuthToken({ interactive: true });

// Revoke / clear token from cache
await chrome.identity.removeCachedAuthToken({ token });

// Get user info
const profile = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
// { email: 'user@gmail.com', id: '12345...' }

// Launch web auth flow (non-Google OAuth, PKCE, etc.)
const redirectUrl = chrome.identity.getRedirectURL(); // must be in OAuth whitelist
const responseUrl = await chrome.identity.launchWebAuthFlow({
  url: `https://oauth.example.com/auth?client_id=X&redirect_uri=${redirectUrl}&response_type=token`,
  interactive: true
});
const token = new URL(responseUrl).hash.match(/access_token=([^&]+)/)[1];
```

---

### chrome.alarms

**Purpose:** Periodic/scheduled callbacks that survive service worker sleep  
**Permission:** `"alarms"`

```js
// Create a repeating alarm (every 5 minutes)
await chrome.alarms.create('refresh', { periodInMinutes: 5 });

// One-shot alarm (after 1 minute)
await chrome.alarms.create('oneShot', { delayInMinutes: 1 });

// List alarms
const alarms = await chrome.alarms.getAll();

// Clear
await chrome.alarms.clear('refresh');
await chrome.alarms.clearAll();

// Handle (in service worker)
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'refresh') fetchData();
});
```

---

### chrome.notifications

**Permission:** `"notifications"`

```js
// Create a rich notification
await chrome.notifications.create('notif-1', {
  type: 'basic',          // 'basic' | 'image' | 'list' | 'progress'
  iconUrl: 'icons/icon48.png',
  title: 'Alert',
  message: 'Something happened',
  priority: 1,            // -2 to 2
  buttons: [{ title: 'Open' }, { title: 'Dismiss' }]
});

// Clear
await chrome.notifications.clear('notif-1');

// Events
chrome.notifications.onClicked.addListener(notifId => { /* opened */ });
chrome.notifications.onButtonClicked.addListener((notifId, buttonIndex) => {
  if (buttonIndex === 0) openApp();
});
chrome.notifications.onClosed.addListener((notifId, byUser) => {});
```

---

### chrome.contextMenus

**Permission:** `"contextMenus"`

```js
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'my-action',
    title: 'Do Something with "%s"',  // %s = selected text
    contexts: ['selection', 'link'],   // 'all' | 'page' | 'frame' | 'selection' | 'link' | 'editable' | 'image' | 'video' | 'audio'
    documentUrlPatterns: ['https://*.example.com/*']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'my-action') {
    console.log('Selected:', info.selectionText, 'Link:', info.linkUrl);
  }
});
```

---

### chrome.commands

**Defined in manifest; keyboard shortcuts**

```json
// manifest.json
"commands": {
  "_execute_action": { "suggested_key": { "default": "Ctrl+Shift+Y" } },
  "toggle-feature": {
    "suggested_key": { "default": "Ctrl+Shift+F", "mac": "Command+Shift+F" },
    "description": "Toggle feature"
  }
}
```

```js
chrome.commands.onCommand.addListener(command => {
  if (command === 'toggle-feature') toggleFeature();
});
// List registered commands
const cmds = await chrome.commands.getAll();
```

---

### chrome.history

**Permission:** `"history"`

```js
// Search history
const items = await chrome.history.search({
  text: 'github.com',
  maxResults: 50,
  startTime: Date.now() - 7 * 24 * 3600 * 1000 // last 7 days
});
// items: [{ id, url, title, lastVisitTime, visitCount, typedCount }]

// Add a visit
await chrome.history.addUrl({ url: 'https://example.com' });

// Delete
await chrome.history.deleteUrl({ url: 'https://example.com' });
await chrome.history.deleteRange({ startTime: t1, endTime: t2 });
await chrome.history.deleteAll();

// Events
chrome.history.onVisited.addListener(historyItem => {});
chrome.history.onVisitRemoved.addListener(({ allHistory, urls }) => {});
```

---

### chrome.webNavigation

**Permission:** `"webNavigation"`; more precise than `tabs.onUpdated`

```js
// Fires when navigation is committed (before DOM loads)
chrome.webNavigation.onCommitted.addListener(details => {
  // details: { tabId, url, frameId, transitionType, transitionQualifiers }
}, { url: [{ hostContains: 'example.com' }] });

// DOM ready
chrome.webNavigation.onDOMContentLoaded.addListener(details => {});

// Page fully loaded
chrome.webNavigation.onCompleted.addListener(details => {
  if (details.frameId === 0) { /* main frame */ }
});

// Navigation error
chrome.webNavigation.onErrorOccurred.addListener(details => {
  console.log('nav error', details.error);
});

// History API pushState/replaceState
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {});

// iframe navigation
chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId !== 0) console.log('iframe nav:', details.url);
});
```

---

### chrome.sidePanel

**Permission:** `"sidePanel"` | Requires Chrome 114+

```json
// manifest.json
"side_panel": { "default_path": "src/sidepanel/sidepanel.html" }
```

```js
// Open side panel programmatically (must be in response to user gesture)
await chrome.sidePanel.open({ windowId });

// Per-tab side panel
await chrome.sidePanel.setOptions({
  tabId,
  path: 'sidepanel-alt.html',
  enabled: true
});

// Disable for a tab
await chrome.sidePanel.setOptions({ tabId, enabled: false });

// Set behavior for all windows
await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

---

### chrome.tabGroups

**Permission:** `"tabGroups"`

```js
// Get a group
const group = await chrome.tabGroups.get(groupId);

// Move group
await chrome.tabGroups.move(groupId, { windowId, index: 0 });

// Update (rename, color, collapse)
await chrome.tabGroups.update(groupId, {
  title: 'Work',
  color: 'blue',  // 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange'
  collapsed: false
});

// Group tabs together
const newGroupId = await chrome.tabs.group({ tabIds: [t1, t2], createProperties: { windowId } });
await chrome.tabs.ungroup([tabId]);

// Events
chrome.tabGroups.onCreated.addListener(group => {});
chrome.tabGroups.onUpdated.addListener(group => {});
chrome.tabGroups.onRemoved.addListener(group => {});
```

---

### chrome.downloads

**Permission:** `"downloads"`

```js
// Download a URL
const downloadId = await chrome.downloads.download({
  url: 'https://example.com/file.pdf',
  filename: 'my-file.pdf',    // relative path in Downloads folder
  saveAs: false,               // show Save As dialog
  conflictAction: 'uniquify'   // 'uniquify' | 'overwrite' | 'prompt'
});

// Search downloads
const items = await chrome.downloads.search({
  state: 'complete',
  limit: 10,
  orderBy: ['-startTime']
});

// Pause/resume/cancel
await chrome.downloads.pause(downloadId);
await chrome.downloads.resume(downloadId);
await chrome.downloads.cancel(downloadId);

// Open/show in Finder
await chrome.downloads.open(downloadId);
await chrome.downloads.show(downloadId);

// Events
chrome.downloads.onCreated.addListener(item => {});
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current === 'complete') {
    console.log('download done', delta.id);
  }
});
```

---

### chrome.devtools.*

**Availability:** Only in DevTools extension pages (declared via `devtools_page` in manifest)

```json
// manifest.json
"devtools_page": "devtools/devtools.html"
```

#### devtools.inspectedWindow

```js
// Evaluate JS in the inspected page (raw page scope, not isolated world)
chrome.devtools.inspectedWindow.eval(
  'document.querySelector("h1").textContent',
  (result, isException) => {
    if (isException) console.error('eval error');
    else console.log('result:', result);
  }
);

// Eval with options: specific frame, content script context
chrome.devtools.inspectedWindow.eval(
  'window.location.href',
  { frameURL: 'https://iframe.example.com' },
  (result) => console.log(result)
);

// Reload the inspected page
chrome.devtools.inspectedWindow.reload({
  ignoreCache: true,
  injectedScript: 'window.__debug = true;'
});

// Get all page resources
chrome.devtools.inspectedWindow.getResources(resources => {
  resources.forEach(r => console.log(r.url));
});

// Get/set resource content
chrome.devtools.inspectedWindow.onResourceAdded.addListener(resource => {
  resource.getContent((content, encoding) => console.log(content));
});

const tabId = chrome.devtools.inspectedWindow.tabId; // pass to tabs API via background
```

#### devtools.panels

```js
// Create a custom panel in DevTools
chrome.devtools.panels.create(
  'My Panel',
  'icons/icon16.png',
  'devtools/panel.html',
  panel => {
    panel.onShown.addListener(panelWindow => { /* panel visible */ });
    panel.onHidden.addListener(() => { /* panel hidden */ });
  }
);

// Add sidebar to Elements panel
chrome.devtools.panels.elements.createSidebarPane(
  'My Sidebar',
  sidebar => {
    sidebar.setObject({ custom: 'data' });
    sidebar.onShown.addListener(sidebarWindow => {});
  }
);
// Update sidebar when selection changes in Elements panel
chrome.devtools.panels.elements.onSelectionChanged.addListener(() => {
  sidebar.setExpression('$0.dataset', 'Selected Element Data');
});
```

#### devtools.network

```js
chrome.devtools.network.onRequestFinished.addListener(request => {
  // HAR entry — access request/response data
  request.getContent((content, encoding) => {
    console.log(request.request.url, content.length);
  });
});

chrome.devtools.network.onNavigated.addListener(url => {
  console.log('navigated to', url);
});
```

---

### chrome.debugger

**Permission:** `"debugger"` — attaches Chrome DevTools Protocol to any tab  
⚠️ Shows an infobar to the user; tabs in incognito need `incognito` flag

```js
const target = { tabId };

// Attach and enable a CDP domain
await chrome.debugger.attach(target, '1.3');
await chrome.debugger.sendCommand(target, 'Page.enable');

// Take a screenshot via CDP
const { data } = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
  format: 'jpeg', quality: 80
});
// data = base64-encoded JPEG

// Intercept network requests via CDP
await chrome.debugger.sendCommand(target, 'Network.enable');
await chrome.debugger.sendCommand(target, 'Network.setRequestInterception', {
  patterns: [{ urlPattern: '*' }]
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Network.requestIntercepted') {
    chrome.debugger.sendCommand(target, 'Network.continueInterceptedRequest', {
      interceptionId: params.interceptionId
    });
  }
});

// Execute JS with full access (no isolated world)
const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
  expression: 'document.title',
  returnByValue: true
});
console.log(result.result.value);

// Detach when done
await chrome.debugger.detach(target);

// Events
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log('debugger detached', reason); // 'canceled_by_user' | 'replaced_with_devtools' | ...
});
```

---

## 4. Messaging Patterns

### Content Script ↔ Service Worker

```js
// ---- content script ----
const response = await chrome.runtime.sendMessage({ type: 'fetchData', url: location.href });
console.log(response.data);

// ---- service worker ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetchData') {
    fetch(msg.url)
      .then(r => r.json())
      .then(data => sendResponse({ data }));
    return true; // REQUIRED for async sendResponse
  }
});
```

### Service Worker → Specific Tab (content script)

```js
// Inject if not yet present, then message
await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
const response = await chrome.tabs.sendMessage(tabId, { type: 'getPageData' });
```

### Cross-context with Port (long-lived)

```js
// ---- initiator (popup/content) ----
const port = chrome.runtime.connect({ name: 'stream' });
port.postMessage({ init: true });
port.onMessage.addListener(msg => updateUI(msg));

// ---- service worker ----
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'stream') return;
  const tab = port.sender?.tab;
  const interval = setInterval(() => port.postMessage({ tick: Date.now() }), 1000);
  port.onDisconnect.addListener(() => clearInterval(interval));
});
```

### Offscreen Document ↔ Service Worker

```js
// Service worker → offscreen:
chrome.runtime.sendMessage({ target: 'offscreen', type: 'clipboardWrite', text: 'Hello' });

// Offscreen document:
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.type === 'clipboardWrite') {
    navigator.clipboard.writeText(msg.text).then(() => sendResponse({ ok: true }));
    return true;
  }
});
```

---

## 5. Manifest V3 Snippets & Recipes

### Keep Service Worker Alive (Chrome 109+ workaround)

```js
// Use chrome.alarms to wake the worker periodically
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepAlive') { /* no-op, just wakes worker */ }
});
```

### Safe Storage Helper (with defaults)

```js
async function getSettings(defaults = {}) {
  const keys = Object.keys(defaults);
  const stored = await chrome.storage.local.get(keys.length ? keys : null);
  return { ...defaults, ...stored };
}
async function saveSettings(updates) {
  await chrome.storage.local.set(updates);
}
```

### Inject Only Once Per Tab

```js
const injected = new Set(); // session-scoped, reset on SW restart

async function injectOnce(tabId) {
  if (injected.has(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  injected.add(tabId);
}
chrome.tabs.onRemoved.addListener(tabId => injected.delete(tabId));
```

### Intercept Requests + Modify Headers (MV3 / declarativeNetRequest)

```js
// Remove X-Frame-Options to allow embedding (dynamic rule)
await chrome.declarativeNetRequest.updateDynamicRules({
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }]
    },
    condition: { urlFilter: '*', resourceTypes: ['sub_frame'] }
  }]
});
```

### Detect if Running as MV3 Service Worker vs DOM

```js
const isServiceWorker = typeof window === 'undefined';
```

### Read Cookies via chrome.cookies (not document.cookie)

```js
async function getSessionCookie(domain) {
  const cookies = await chrome.cookies.getAll({ domain, name: 'session' });
  return cookies[0]?.value ?? null;
}
```

### Pattern: Reliable background message with retry

```js
async function sendToBackground(msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
  }
}
```

---

## 6. Chrome DevTools MCP Server

### Overview

`chrome-devtools-mcp` is an npm package providing 44 MCP tools that give AI agents full Chrome DevTools access — screenshots, DOM inspection, script execution, network monitoring, performance tracing, memory profiling, Lighthouse audits, and more.

### Installation

```bash
# Run directly (recommended — always latest)
npx -y chrome-devtools-mcp@latest

# Slim mode (fewer tools, faster startup)
npx -y chrome-devtools-mcp@latest --slim

# Headless (for CI/automation)
npx -y chrome-devtools-mcp@latest --slim --headless

# Connect to existing Chrome instance
npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222
```

**Requirements:** Node.js v20.19+, Chrome stable+

### Feature Flags

| Flag | Effect |
|---|---|
| `--slim` | Minimal tool set only (navigation + basic input + snapshot) |
| `--headless` | Launch Chrome in headless mode |
| `--no-usage-statistics` | Disable telemetry |
| `--browser-url=URL` | Connect to existing Chrome (e.g. `http://127.0.0.1:9222`) |
| `--categoryExtensions=true` | Enable install/list/reload/trigger/uninstall extension tools |
| `--experimentalMemory` | Enable heap snapshot tools |
| `--experimentalVision` | Enable vision-based automation |
| `--experimentalScreencast` | Enable screencast_start/stop tools |
| `--categoryExperimentalThirdParty=true` | Enable third-party tool integration |
| `--categoryExperimentalWebmcp=true` | Enable WebMCP tool integration |

### MCP Config Examples

**Cursor / VS Code (`mcp.json`):**
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

**Claude Desktop (`claude_desktop_config.json`):**
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

**With extensions support:**
```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--categoryExtensions=true", "--experimentalMemory"]
    }
  }
}
```

**Gemini CLI (`.gemini/settings.json`):**
```json
{
  "mcpServers": {
    "chrome-devtools-mcp": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

### Key Automation Principles

1. **Use `take_snapshot` (a11y tree) over `take_screenshot`** — gives uid-tagged elements for reliable automation without image tokens
2. **Use `fill_form` over sequential `fill`+`click`** — faster, more atomic, fewer race conditions
3. **`evaluate_script` runs in page context** — same as DevTools console, full JS access
4. **`navigate_page`** waits for load; use `wait_for` when content is async
5. **Tab management:** `list_pages` → `select_page` → operate; use `new_page` to open fresh tabs

---

## 7. MCP Tool Reference — All 44 Tools

### Input (10 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `click` | Click element by uid | `uid` (required) |
| `dblClick` | Double-click element | `uid` (required) |
| `drag` | Drag element onto another | `from_uid`, `to_uid` |
| `fill` | Type into input / select option | `uid`, `value` |
| `fill_form` | Fill multiple form elements at once | `elements: [{uid, value}]` |
| `handle_dialog` | Accept or dismiss browser dialog | `action: 'accept'|'dismiss'`, `promptText?` |
| `hover` | Hover over element | `uid` |
| `press_key` | Press key or combo | `key` (e.g. `"Enter"`, `"Control+A"`) |
| `type_text` | Type text into focused element | `text`, `submitKey?` |
| `upload_file` | Upload file via input element | `uid`, `filePath` |

### Navigation (6 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `close_page` | Close page by index | `pageId` |
| `list_pages` | List all open pages | — |
| `navigate_page` | Go to URL / back / forward / reload | `type: 'url'|'back'|'forward'|'reload'`, `url?` |
| `new_page` | Open new tab | `url`, `background?`, `isolatedContext?` |
| `select_page` | Set active page for subsequent tools | `pageId`, `bringToFront?` |
| `wait_for` | Wait for text to appear | `text: string[]`, `timeout?` |

### Emulation (2 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `emulate` | Emulate viewport / UA / network / geolocation / color scheme | `viewport?`, `userAgent?`, `networkConditions?`, `geolocation?`, `colorScheme?`, `cpuThrottlingRate?` |
| `resize_page` | Resize browser window | `width`, `height` |

**Emulation examples:**
```
// Mobile viewport
emulate: { viewport: "375x812x2,mobile,touch" }

// Dark mode
emulate: { colorScheme: "dark" }

// Throttle network
emulate: { networkConditions: "Slow 3G" }

// Geolocate
emulate: { geolocation: "37.7749x-122.4194" }
```

### Performance (3 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `performance_start_trace` | Start recording performance trace | `filePath?`, `reload?`, `autoStop?` |
| `performance_stop_trace` | Stop and save trace | `filePath?` |
| `performance_analyze_insight` | Get details on a specific insight | `insightSetId`, `insightName` (e.g. `"LCPBreakdown"`, `"DocumentLatency"`) |

**Performance workflow:**
```
1. navigate_page to target URL
2. performance_start_trace (sets reload:true to capture full load)
3. Wait for trace to complete (autoStop:true by default)
4. performance_analyze_insight to check LCP, CLS, INP
```

### Network (2 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_network_requests` | List all requests since last navigation | `resourceTypes?`, `pageSize?`, `pageIdx?` |
| `get_network_request` | Get full request + response body | `reqid?`, `requestFilePath?`, `responseFilePath?` |

### Debugging (8 tools)

| Tool | Description | Key Parameters |
|---|---|---|
| `evaluate_script` | Run JS in page context | `function` (JS function declaration), `args?`, `dialogAction?` |
| `get_console_message` | Get specific console message | `msgid` |
| `lighthouse_audit` | Run Lighthouse (accessibility, SEO, best practices) | `device?`, `mode?`, `outputDirPath?` |
| `list_console_messages` | List console messages | `types?`, `pageSize?`, `pageIdx?`, `includePreservedMessages?` |
| `take_screenshot` | Capture screenshot | `filePath?`, `format?`, `quality?`, `fullPage?`, `uid?` |
| `take_snapshot` | Capture a11y tree (preferred for automation) | `filePath?`, `verbose?` |
| `screencast_start` | Start live screencast (experimental) | — |
| `screencast_stop` | Stop screencast (experimental) | — |

**evaluate_script examples:**
```js
// Get page title
evaluate_script: { function: "() => document.title" }

// Scroll to bottom
evaluate_script: { function: "() => window.scrollTo(0, document.body.scrollHeight)" }

// Extract all links
evaluate_script: { function: "() => [...document.querySelectorAll('a')].map(a => a.href)" }

// With element argument from snapshot uid
evaluate_script: { function: "(el) => el.textContent", args: ["uid-123"] }
```

### Memory (4 tools — requires `--experimentalMemory`)

| Tool | Description | Key Parameters |
|---|---|---|
| `take_memory_snapshot` | Capture heap snapshot | `filePath` (required, `.heapsnapshot`) |
| `get_memory_snapshot_details` | Analyze loaded snapshot | — |
| `get_nodes_by_class` | Get JS heap nodes by constructor | — |
| `load_memory_snapshot` | Load snapshot from file | — |

### Extensions (5 tools — requires `--categoryExtensions=true`)

| Tool | Description | Key Parameters |
|---|---|---|
| `install_extension` | Install extension from path | `path` (required) |
| `list_extensions` | List all installed extensions | — |
| `reload_extension` | Reload unpacked extension | `id` |
| `trigger_extension_action` | Trigger extension toolbar action | `id` |
| `uninstall_extension` | Uninstall extension | `id` |

### Third-Party (2 tools — requires `--categoryExperimentalThirdParty=true`)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_3p_developer_tools` | List tools exposed by the page | — |
| `execute_3p_developer_tool` | Execute a page-exposed tool | `toolName`, `params?` |

### WebMCP (2 tools — requires `--categoryExperimentalWebmcp=true`)

| Tool | Description | Key Parameters |
|---|---|---|
| `list_webmcp_tools` | List WebMCP tools exposed by page | — |
| `execute_webmcp_tool` | Execute a WebMCP tool | `toolName`, `input?` |

---

## Common Automation Recipes (MCP)

### Scrape a SPA page

```
1. new_page { url: "https://app.example.com" }
2. wait_for { text: ["Dashboard"] }
3. take_snapshot               // get uid-tagged a11y tree
4. evaluate_script { function: "() => JSON.stringify(window.__appState)" }
```

### Fill and submit a form

```
1. navigate_page { type: "url", url: "https://example.com/form" }
2. take_snapshot               // find input uids
3. fill_form { elements: [
     { uid: "uid-email", value: "user@example.com" },
     { uid: "uid-password", value: "secret" }
   ]}
4. click { uid: "uid-submit-button" }
5. wait_for { text: ["Success"] }
```

### Run Lighthouse audit

```
1. navigate_page { type: "url", url: "https://example.com" }
2. lighthouse_audit { device: "mobile", mode: "navigation" }
```

### Capture full-page screenshot

```
1. navigate_page { type: "url", url: "https://example.com" }
2. wait_for { text: ["expected content"] }
3. take_screenshot { fullPage: true, filePath: "/tmp/page.png" }
```

### Monitor network requests during page load

```
1. navigate_page { type: "url", url: "https://example.com" }
2. list_network_requests { resourceTypes: ["fetch", "xhr"] }
3. get_network_request { reqid: <id from step 2> }
```

### Debug memory leak

```
1. take_memory_snapshot { filePath: "/tmp/before.heapsnapshot" }
2. // perform actions that might leak
3. take_memory_snapshot { filePath: "/tmp/after.heapsnapshot" }
4. load_memory_snapshot
5. get_nodes_by_class      // compare retained objects
```

### Test extension behavior

```
1. install_extension { path: "/path/to/extension" }
2. navigate_page { type: "url", url: "https://example.com" }
3. trigger_extension_action { id: "extension-id" }
4. take_snapshot
5. evaluate_script { function: "() => chrome.storage.local.get(null)" }
```

---

*Last compiled: 2025. Sources: Chrome Extensions MV3 Reference, chrome-devtools-mcp v0.x tool reference.*
