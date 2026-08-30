# Installation Guide

Getting Aggregaytor from a git clone to a working Chrome side panel. The
extension is loaded unpacked from a local build — it is not distributed through
the Chrome Web Store.

---

## Prerequisites

- **Node.js** >= 18 (newer LTS fine)
- **pnpm** >= 9 (`npm install -g pnpm`) — the lockfile is pnpm v9 format;
  do not use npm or yarn
- **Chrome** or a Chromium-based browser with MV3 side-panel support
  (the Side Panel API ships in Chrome 114+; `manifest.json` does not pin a
  `minimum_chrome_version`)

## Install & build

```bash
git clone git@github.com:mithudso/aggregaytor.git
cd aggregaytor
pnpm install
pnpm run build
```

The build outputs the complete extension to `extensions/aggregaytor/dist/`.

## Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extensions/aggregaytor/dist` folder
5. The Aggregaytor icon appears in the toolbar

## Post-install verification

1. **Side panel opens** — click the extension icon; the side panel should
   render the (empty) unified inbox.
2. **Platform tab detection** — open a supported platform in a normal tab
   (e.g. `https://sniffies.com`, `https://web.grindr.com`, or
   `https://mail.google.com`). Open DevTools on that tab → Console → you should
   see `[Aggregaytor:` log lines from the injected content scripts.
3. **Capture works** — browse/chat on the platform; conversations appear in the
   side panel inbox as traffic is intercepted.
4. If something is off: `chrome://extensions` → Aggregaytor → "service worker"
   link (under *Inspect views*) opens the background console; errors surface
   there. More triage steps in [`DEVELOPMENT.md`](./DEVELOPMENT.md) →
   Troubleshooting and the README's Troubleshooting section.

Optional: to use the AI features (suggestions, auto-respond, dossiers), open
the side panel → Settings (gear) → AI tab and enter at least one LLM provider
API key.

## Upgrade

```bash
git pull
pnpm install        # picks up any dependency changes
pnpm run build
```

Then `chrome://extensions` → click the **reload** icon on the Aggregaytor card,
and refresh any open platform tabs so the new content scripts inject. Your data
is unaffected — everything lives locally in IndexedDB, keyed to the extension,
not to the build.

## Uninstall

1. `chrome://extensions` → Aggregaytor → **Remove**. Chrome deletes the
   extension's local storage (IndexedDB, `chrome.storage`) with it.
2. To wipe data while keeping the extension installed instead: side panel →
   Settings → Data → **Clear All Data**.
3. Optionally delete the cloned repository directory.
