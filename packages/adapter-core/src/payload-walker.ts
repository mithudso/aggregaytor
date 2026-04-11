/**
 * payload-walker.ts — Generic JSON payload tree walker.
 *
 * Generalized from sniffiesplus consumeChatPayload() (lines 4103-4124).
 * BFS traversal with cycle detection and configurable max depth.
 */

import type { PayloadVisitor } from './types.js';

interface QueueItem {
  value: unknown;
  contextId: string | null;
  depth: number;
}

export function walkPayload(
  payload: unknown,
  contextId: string | null,
  visitor: PayloadVisitor,
  maxDepth = 7,
): void {
  if (!payload || typeof payload !== 'object') return;

  const seen = new WeakSet();
  const queue: QueueItem[] = [{ value: payload, contextId, depth: 0 }];

  while (queue.length) {
    const { value, contextId: ctx, depth } = queue.shift()!;
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value as object)) continue;
    seen.add(value as object);
    if (depth > maxDepth) continue;

    visitor.onObject(value as Record<string, unknown>, ctx, depth);

    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === 'object') {
        queue.push({ value: child, contextId: ctx, depth: depth + 1 });
      }
    }
  }
}
