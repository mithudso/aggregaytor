## Summary

<!-- What does this PR do, and why? One or two sentences. -->

## Changes

<!-- Bullet list of the concrete changes. Note which layers are touched:
     adapter / bridge / service worker / store / side panel / build config. -->

-

## Testing

- [ ] `pnpm run build` passes
- [ ] `pnpm run lint` passes (0 problems)
- [ ] `pnpm run test` passes
- [ ] Extension loaded at `chrome://extensions` and manually verified (if UI/content-script change)
- [ ] Patch version bumped in `extensions/aggregaytor/manifest.json` (version source of truth)

## Invariant checklist (see CLAUDE.md)

- [ ] No direct `chrome.storage.local.get()` on hot paths (`getCachedStorage` used)
- [ ] No new `setInterval` in the service worker (use `chrome.alarms`)
- [ ] Nothing new exposed on `window.*` from MAIN-world scripts
- [ ] PouchDB bulk writes follow the 2-call `allDocs` + `bulkDocs` pattern
