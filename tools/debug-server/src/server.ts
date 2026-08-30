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

/**
 * Bridge port. 9222 is also Chrome's default --remote-debugging-port; if
 * Chrome is holding it, the handshake fails and every tool call reports a
 * connection error. Override on both this server and the extension to move.
 */
const PORT = Number(process.env.AGGREGAYTOR_DEBUG_PORT) || 9222;
const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

let ws: WebSocket | null = null;
let connecting: Promise<WebSocket> | null = null;
let requestId = 0;
const pendingRequests = new Map<number, PendingRequest>();

/** Fails every in-flight request instead of leaving them to time out. */
function failAllPending(reason: Error): void {
  for (const [id, pending] of [...pendingRequests]) {
    pendingRequests.delete(id);
    pending.reject(reason);
  }
}

function handleBridgeMessage(raw: WebSocket.RawData): void {
  let msg: { id?: unknown; error?: unknown; result?: unknown };
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    console.error('[aggregaytor-debug] dropped unparseable bridge frame:', (err as Error).message);
    return;
  }
  if (typeof msg?.id !== 'number') return;
  const pending = pendingRequests.get(msg.id);
  if (!pending) return;
  pendingRequests.delete(msg.id);
  if (msg.error) pending.reject(new Error(String(msg.error)));
  else pending.resolve(msg.result);
}

async function connectWS(): Promise<WebSocket> {
  if (ws?.readyState === WebSocket.OPEN) return ws;
  // Callers arriving during a handshake must await it. Opening a second socket
  // orphaned the first one, and sending on a still-CONNECTING socket throws.
  if (connecting) return connecting;

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${PORT}`);
    socket.on('open', () => {
      ws = socket;
      resolve(socket);
    });
    socket.on('message', handleBridgeMessage);
    socket.on('error', (err) => {
      const failure = new Error(`WebSocket error: ${err.message}`);
      if (ws === socket) ws = null;
      failAllPending(failure);
      reject(failure);
    });
    socket.on('close', () => {
      if (ws === socket) ws = null;
      // Without this, requests in flight when the extension goes away hang
      // for the full timeout instead of failing immediately.
      failAllPending(new Error('Debug bridge closed the connection'));
      reject(new Error('Debug bridge closed before the connection was ready'));
    });
  });
  // Cleared on settle: a successful connect is served by `ws` from here on,
  // and a failed one must be retried rather than replayed.
  connecting.catch(() => {}).finally(() => { connecting = null; });
  return connecting;
}

async function sendCommand(type: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const socket = await connectWS();
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingRequests.delete(id)) {
        reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for extension response`));
      }
    }, REQUEST_TIMEOUT_MS);
    // Never let a pending request keep the event loop alive on shutdown.
    // Cast because this tsconfig loads both the DOM and Node timer signatures.
    (timer as unknown as { unref?: () => void }).unref?.();
    pendingRequests.set(id, {
      resolve: (data) => { clearTimeout(timer); resolve(data); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    try {
      // `id` and `type` are written last so a tool argument of the same name
      // cannot clobber them and strand the response correlation.
      socket.send(JSON.stringify({ ...params, id, type }));
    } catch (err) {
      const pending = pendingRequests.get(id);
      pendingRequests.delete(id);
      pending?.reject(err instanceof Error ? err : new Error(String(err)));
    }
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
      description: 'Trigger an extension action: sync_pics, toggle_autorespond, set_log_level, resync_thread, open_all_sites, or clear_db. DESTRUCTIVE: clear_db erases the local PouchDB store irreversibly — confirm with the user before calling it.',
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
  // stderr, never stdout: stdout carries the MCP protocol stream.
  console.error('[aggregaytor-debug] MCP server started on stdio');
}

main().catch((err) => {
  console.error('[aggregaytor-debug] fatal:', err);
  // Exit non-zero so a supervising client sees the failure instead of a
  // silently dead server that looks like a clean shutdown.
  process.exitCode = 1;
});
