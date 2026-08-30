# MCP integration

## Repo-local MCP configuration: none

There is no `.mcp.json` and no `.vscode/mcp.json` in this repository. MCP is **not
configured repo-locally** — any MCP wiring lives in the developer's personal Claude
config (e.g. `~/.claude/claude_desktop_config.json`), as documented in
`tools/debug-server/README.md`.

## The debug-integration surface that exists: tools/debug-server

`tools/debug-server` is a hand-rolled MCP server (stdio transport, built on
`@modelcontextprotocol/sdk`) that lets an MCP client (Claude Code / Claude Desktop)
inspect and drive the running extension:

```
MCP client (stdio) ──▶ tools/debug-server/src/server.ts
                              │ WebSocket CLIENT → ws://localhost:9222
                              ▼ (override: AGGREGAYTOR_DEBUG_PORT)
                       bridge listener              # NOTE: port 9222 collides with
                              │                     # Chrome's --remote-debugging-port
                              ▼
                       chrome.runtime.sendMessage({ type: 'DEBUG_COMMAND', command, params })
                              ▼
                       service-worker.ts DEBUG_COMMAND case → background/debug-bridge.ts
```

Tools exposed (see `tools/debug-server/README.md` and `src/server.ts`):
`query_messages`, `query_contacts`, `query_threads`, `get_thread_meta`, `get_dossier`,
`get_extension_status`, `get_llm_status`, `trigger_action` (includes the destructive
`clear_db` — confirm with the user first), `execute_query` (raw selector, limit-clamped).

Registration snippet (personal config, not committed):

```json
{
  "mcpServers": {
    "aggregaytor-debug": {
      "command": "npx",
      "args": ["tsx", "<absolute-repo-path>/tools/debug-server/src/server.ts"]
    }
  }
}
```

Caveats:

- The extension's service worker must be awake for commands to land.
- The WebSocket bridge is **unauthenticated** — an open finding in
  `docs/SECURITY.md` (Origin allowlist + shared token needed). Don't run it on a
  shared machine, and don't widen the command surface while that's open.
- The current source tree contains no extension-side WebSocket listener; the CDO
  report references one as a reported risk. # TODO: confirm where the ws://localhost:9222 listener side is expected to run in the current dev flow (the MCP server connects as a client; DevTools-console `chrome.runtime.sendMessage` is the documented fallback in tools/debug-server/README.md).

## Adding a repo-local MCP server (if ever wanted)

1. Commit a `.mcp.json` at repo root so Claude Code picks it up per-project:

   ```json
   {
     "mcpServers": {
       "aggregaytor-debug": {
         "command": "npx",
         "args": ["tsx", "tools/debug-server/src/server.ts"]
       }
     }
   }
   ```

2. Keep new tools read-only and bounded by default (mirror `debug-bridge.ts`'s
   limit-clamping), and gate anything destructive behind explicit confirmation.
3. Solve the bridge-authentication finding first if the server gains write commands.
