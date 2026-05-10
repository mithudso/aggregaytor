# Aggregaytor Debug MCP Server

An MCP server that lets Claude directly interact with the Aggregaytor Chrome extension for debugging and testing.

## Setup

Add to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "aggregaytor-debug": {
      "command": "npx",
      "args": ["tsx", "/Users/mitch/Documents/GitHub/aggregaytor/tools/debug-server/src/server.ts"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `query_messages` | Search stored messages by contact, platform, or text |
| `query_contacts` | List contacts, filter by platform or name |
| `query_threads` | Get thread summaries (inbox view) |
| `get_thread_meta` | Get metadata for a contact (bookmarks, notes, sentiment) |
| `get_dossier` | Get full dossier/intel file for a contact |
| `get_extension_status` | DB stats, LLM queue, active counts |
| `get_llm_status` | LLM config, rate settings, per-provider usage |
| `trigger_action` | Sync pics, toggle auto-respond, set log level |
| `execute_query` | Raw PouchDB query |

## How it works

The MCP server communicates with the extension via `chrome.runtime.sendMessage` through a `DEBUG_COMMAND` message type in the service worker.

Currently requires the extension's service worker to be active. Use the extension's DevTools to send debug commands directly:

```js
chrome.runtime.sendMessage({type: 'DEBUG_COMMAND', command: 'query_threads', params: {}})
```
