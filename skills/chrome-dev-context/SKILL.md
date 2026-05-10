---
name: chrome-dev-context
description: Chrome extension MV3 and Chrome DevTools MCP reference skill. Use when working on Chrome extensions, choosing chrome.* APIs, debugging MV3 context boundaries, or automating Chrome with DevTools MCP.
---

# Chrome Extension MV3 and DevTools MCP

Use this skill for tasks involving Chrome extension architecture, `chrome.*` APIs, Manifest V3 constraints, or browser automation and debugging through `chrome-devtools-mcp`.

## Included reference

- `../../chrome-dev-context.md`: detailed API reference, MV3 architecture notes, messaging patterns, manifest snippets, DevTools MCP setup, full tool list, and automation recipes.

## Operating guidance

1. Start with the execution context before proposing code: service worker, content script, popup, side panel, offscreen document, DevTools page, and page scripts all have different API access and lifecycle constraints.
2. Treat MV3 service workers as disposable. Do not rely on module-global state for anything important; persist state to extension storage or IndexedDB.
3. Prefer the least-powerful manifest permissions and the smallest host permission scope that solves the task.
4. Use message passing across contexts instead of assuming shared memory or direct access.
5. Prefer `chrome.alarms` for recurring background work in MV3.
6. Prefer `chrome.cookies` for cookie access from extension contexts instead of `document.cookie` when appropriate.
7. For network interception or header mutation, prefer `chrome.declarativeNetRequest` unless the task specifically requires `webRequest`.

## DevTools MCP guidance

1. Use the reference file to choose the right tool category: input, navigation, emulation, performance, network, debugging, memory, extensions, third-party, or WebMCP.
2. Prefer `take_snapshot` over screenshots when you need reliable element targeting.
3. Prefer `fill_form` over a sequence of single-field fills when possible.
4. Use `wait_for` after navigation when page content is loaded asynchronously.
5. Use `list_pages` and `select_page` before acting if multiple tabs may be open.
6. If extension tools are needed, make sure the MCP server is started with `--categoryExtensions=true`.
7. If memory tools are needed, make sure the MCP server is started with `--experimentalMemory`.

## Response expectations

- Ground recommendations in the correct extension context and required permissions.
- Mention required manifest entries when they materially affect the solution.
- Favor safe, current MV3 patterns over MV2-era advice.
- Use the included `chrome-dev-context.md` file as the source of detailed API signatures, examples, and tool workflows.
