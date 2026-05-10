#!/usr/bin/env node
/**
 * Aggregaytor Debug MCP Server
 *
 * Provides tools for Claude to directly interact with the extension:
 * - Query PouchDB data (messages, contacts, threads, metadata)
 * - Inspect adapter state (captured messages, self IDs, error logs)
 * - Trigger actions (sync pics, resync, toggle auto-respond)
 * - View service worker logs
 *
 * Runs as an MCP server on stdio. Connects to the extension via
 * a WebSocket bridge on port 9222.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

const PORT = 9222;
let ws: WebSocket | null = null;
let requestId = 0;
const pendingRequests = new Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }>();

async function connectWS(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) return;

  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(new Error(`WebSocket error: ${err.message}`)));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          pendingRequests.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.result);
        }
      } catch {}
    });
    ws.on('close', () => { ws = null; });
  });
}

async function sendCommand(type: string, params: Record<string, any> = {}): Promise<any> {
  await connectWS();
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    ws!.send(JSON.stringify({ id, type, ...params }));
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Timeout waiting for extension response'));
      }
    }, 10000);
  });
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'aggregaytor-debug', version: '0.19.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'query_messages',
      description: 'Query stored messages. Filter by contactId, platform, search text, or get recent.',
      inputSchema: {
        type: 'object',
        properties: {
          contactId: { type: 'string', description: 'Filter by contact ID (e.g., "sniffies:abc123")' },
          platform: { type: 'string', description: 'Filter by platform (sniffies, grindr, etc.)' },
          search: { type: 'string', description: 'Search message body text' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'query_contacts',
      description: 'Query stored contacts. Filter by platform or get all.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          search: { type: 'string', description: 'Search display name' },
        },
      },
    },
    {
      name: 'query_threads',
      description: 'Get thread summaries (inbox view). Shows unread counts, last message, contact info.',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'get_thread_meta',
      description: 'Get metadata for a specific thread (bookmarks, notes, sentiment, auto-respond settings).',
      inputSchema: {
        type: 'object',
        properties: { contactId: { type: 'string' } },
        required: ['contactId'],
      },
    },
    {
      name: 'get_dossier',
      description: 'Get the full dossier/intel file for a contact.',
      inputSchema: {
        type: 'object',
        properties: { contactId: { type: 'string' } },
        required: ['contactId'],
      },
    },
    {
      name: 'get_extension_status',
      description: 'Get overall extension status: DB stats, LLM queue, active tabs, adapter states.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_service_worker_logs',
      description: 'Get recent service worker console output.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Number of log lines (default 50)' } },
      },
    },
    {
      name: 'trigger_action',
      description: 'Trigger an extension action: sync_pics, toggle_autorespond, set_log_level, resync_thread.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['sync_pics', 'toggle_autorespond', 'set_log_level', 'resync_thread', 'open_all_sites', 'clear_db'] },
          params: { type: 'object', description: 'Action-specific parameters' },
        },
        required: ['action'],
      },
    },
    {
      name: 'get_llm_status',
      description: 'Get LLM configuration, rate settings, queue status, and provider health.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'execute_query',
      description: 'Execute a raw PouchDB query. For advanced debugging.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'object', description: 'PouchDB find selector' },
          limit: { type: 'number' },
        },
        required: ['selector'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await sendCommand(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}\n\nMake sure the extension is running and the debug bridge is enabled. The extension needs the WebSocket debug bridge active on port ${PORT}.` }],
      isError: true,
    };
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[aggregaytor-debug] MCP server started on stdio');
}

main().catch(console.error);
