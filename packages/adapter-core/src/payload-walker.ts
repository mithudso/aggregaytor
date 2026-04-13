/**
 * payload-walker.ts -- Generic JSON payload tree walker.
 *
 * Generalized from sniffiesplus consumeChatPayload() (lines 4103-4124).
 * BFS traversal with cycle detection and configurable max depth.
 *
 * ## Why we need recursive walking
 *
 * Platform API responses are deeply nested and vary wildly in shape.
 * A Sniffies WebSocket frame might wrap messages inside
 * `{ data: { conversations: [ { messages: [...] } ] } }`, while Grindr
 * might use `{ data: { chat: { items: [...] } } }`. Rather than writing
 * brittle path-specific extractors for every platform, adapters implement
 * a `PayloadVisitor` that inspects each object node and pulls out fields
 * it recognizes (e.g. "if this object has `body` and `senderId`, treat it
 * as a message"). The walker handles the traversal generics: BFS ordering,
 * cycle detection (APIs sometimes include back-references), and depth
 * limiting (to avoid runaway traversal on pathologically deep payloads).
 *
 * ## Context tracking
 *
 * The `contextId` parameter is an optional thread/conversation ID that the
 * adapter can set when it knows the payload belongs to a specific
 * conversation. The walker propagates it to every visited node so the
 * visitor can associate extracted messages with the right thread even if
 * the message objects themselves do not contain a thread ID.
 */

import type { PayloadVisitor } from './types.js';

/** A single node in the BFS traversal queue. */
interface QueueItem {
  /** The object (or array) to visit. */
  value: unknown;
  /** Thread/conversation ID propagated from the walk root. */
  contextId: string | null;
  /** Distance from the payload root (0-based). */
  depth: number;
}

/**
 * Walk an arbitrary JSON payload tree in BFS order, calling
 * `visitor.onObject()` on every unique object node.
 *
 * @param payload   - The root JSON value (typically the parsed API response).
 *                    Primitives are silently skipped.
 * @param contextId - Optional thread/conversation ID to propagate to every
 *                    visited node. Adapters set this when the payload belongs
 *                    to a known conversation.
 * @param visitor   - The visitor whose `onObject` will be called per node.
 * @param maxDepth  - Maximum nesting depth to traverse (default 7). Prevents
 *                    runaway traversal on deeply nested or circular payloads.
 */
export function walkPayload(
  payload: unknown,
  contextId: string | null,
  visitor: PayloadVisitor,
  maxDepth = 7,
): void {
  // Bail early on primitives -- nothing to walk.
  if (!payload || typeof payload !== 'object') return;

  // Cycle detection: a WeakSet lets us skip objects we have already visited
  // without preventing GC. API payloads sometimes include circular
  // references (e.g. `message.conversation.messages[0]` pointing back).
  const seen = new WeakSet();
  const queue: QueueItem[] = [{ value: payload, contextId, depth: 0 }];

  // Node count cap: prevent unbounded traversal on very large payloads.
  // Raised from 500 to 2000 to handle conversation history pagination
  // responses that can contain 100+ messages with nested metadata objects.
  // The 500 cap was causing silent message drops on large API responses.
  let visited = 0;
  const MAX_NODES = 2000;

  while (queue.length) {
    const { value, contextId: ctx, depth } = queue.shift()!;

    // Skip primitives, already-visited objects, and anything beyond maxDepth.
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value as object)) continue;
    seen.add(value as object);
    if (depth > maxDepth) continue;

    // Stop if we've visited too many nodes (prevent 300ms+ spikes)
    if (++visited > MAX_NODES) break;

    // Let the visitor inspect this node.
    visitor.onObject(value as Record<string, unknown>, ctx, depth);

    // Enqueue all child objects/arrays for the next BFS layer.
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === 'object') {
        queue.push({ value: child, contextId: ctx, depth: depth + 1 });
      }
    }
  }
}
