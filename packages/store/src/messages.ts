/**
 * messages.ts — Message CRUD operations on PouchDB.
 *
 * This module handles upserting messages from platform adapters, querying
 * messages by thread or contact, marking threads as read, and counting
 * unreads. All functions accept an optional `db` parameter so tests can
 * inject an in-memory database.
 */

import { stableContentHash } from '@aggregaytor/context-engine';
import type { UnifiedMessage, Platform } from '@aggregaytor/adapter-core';
import type { MessageDoc } from './types.js';
import { getDB } from './db.js';

/**
 * Retry a PouchDB operation exactly once after a 1-second delay.
 *
 * PouchDB writes can transiently fail under concurrent access (e.g. two
 * adapters syncing at the same time). A single retry with a short backoff
 * handles the vast majority of these cases without adding complexity.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    await new Promise(r => setTimeout(r, 1000));
    return fn();
  }
}

/**
 * Build a deterministic PouchDB _id for a message.
 *
 * Format: `msg:{platform}:{platformMessageId}`
 *
 * The regex strips any existing prefix from `msg.id` to avoid double-prefixing
 * when an adapter already includes the platform in its ID.
 */
function messageDocId(msg: UnifiedMessage): string {
  return `msg:${msg.platform}:${msg.id.replace(/^[^:]+:/, '')}`;
}

/**
 * Convert a platform-agnostic UnifiedMessage into a PouchDB MessageDoc.
 *
 * The `contentHash` is computed from (platform + contactId + body + timestamp)
 * using a stable hash function from context-engine. This allows dedup even
 * when platform message IDs are ephemeral (e.g. Sniffies regenerates IDs
 * on each page load).
 */
function toMessageDoc(msg: UnifiedMessage): MessageDoc {
  const now = new Date().toISOString();
  // Round timestamp to 10-minute buckets for content hash — this ensures that
  // the same message captured from different sources (API, DOM, WS) with
  // slightly different timestamps produces the SAME hash, preventing duplicates
  // in PouchDB even when the adapter-level dedup misses them.
  const tsRounded = new Date(Math.floor(new Date(msg.timestamp).getTime() / 600_000) * 600_000).toISOString();
  return {
    _id: messageDocId(msg),
    docType: 'message',
    platform: msg.platform,
    threadId: msg.threadId,
    contactId: msg.contactId,
    direction: msg.direction,
    body: msg.body,
    timestamp: msg.timestamp,
    read: msg.read,
    metadata: msg.metadata || {},
    contentHash: stableContentHash(`${msg.platform}:${msg.contactId}:${msg.body.slice(0, 100)}:${tsRounded}`),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Insert or update a single message.
 *
 * Dedup strategy: The _id is deterministic (msg:{platform}:{platformMsgId}),
 * so upserting the same message twice is idempotent. If the doc already exists,
 * we preserve its original `createdAt` and attach the existing `_rev` for a
 * clean PouchDB update. If it does not exist (404), we insert as new.
 *
 * @returns `{ created: true }` for a new insert, `{ created: false }` for update.
 */
export async function upsertMessage(
  msg: UnifiedMessage,
  db?: PouchDB.Database,
): Promise<{ created: boolean }> {
  const store = db || await getDB();
  const doc = toMessageDoc(msg);
  try {
    // Attempt to fetch existing doc to get _rev for conflict-free update
    const existing = await store.get(doc._id) as MessageDoc;
    doc._rev = existing._rev;
    doc.createdAt = existing.createdAt; // preserve original creation time
    await withRetry(() => store.put(doc));
    return { created: false };
  } catch (err: any) {
    if (err.status === 404) {
      // Doc does not exist yet -- insert as new
      await withRetry(() => store.put(doc));
      return { created: true };
    }
    throw err;
  }
}

/**
 * Bulk upsert messages -- the primary entry point for adapter syncs.
 *
 * Performance optimization: instead of N individual get+put round-trips, this
 * fetches all existing docs in a single `allDocs({ keys })` call, then writes
 * all docs in a single `bulkDocs()` call. This reduces PouchDB overhead from
 * O(N) to O(1) database calls regardless of batch size.
 *
 * Dedup/merge logic:
 *   1. Convert all incoming UnifiedMessages to MessageDocs with deterministic IDs
 *   2. Batch-fetch all existing docs by ID to get their _rev and createdAt
 *   3. For docs that already exist: attach _rev (for conflict-free update) and
 *      preserve the original createdAt timestamp
 *   4. For new docs: leave as-is (no _rev means PouchDB creates them)
 *   5. Write everything in one bulkDocs call
 *
 * @returns Counts of newly created vs updated documents.
 */
export async function upsertMessages(
  msgs: UnifiedMessage[],
  db?: PouchDB.Database,
): Promise<{ created: number; updated: number }> {
  if (!msgs.length) return { created: 0, updated: 0 };
  const store = db || await getDB();
  const docs = msgs.map(m => toMessageDoc(m));
  const ids = docs.map(d => d._id);

  // Batch-fetch all existing docs in one round-trip to get _rev tokens
  const existing = await store.allDocs({ keys: ids, include_docs: true });
  const existingMap = new Map<string, { _rev: string; createdAt: string }>();
  for (const row of existing.rows) {
    if ('error' in row) continue; // skip 404s (doc does not exist yet)
    if (row.doc) {
      existingMap.set(row.id, { _rev: (row.doc as any)._rev, createdAt: (row.doc as any).createdAt });
    }
  }

  // Also check for content-hash duplicates — messages with different IDs
  // but identical content (same person, same text, same ~10 min window).
  // This catches cross-source duplicates that have different platform message IDs.
  const existingHashes = new Set<string>();
  for (const row of existing.rows) {
    if ('error' in row) continue;
    if (row.doc) existingHashes.add((row.doc as any).contentHash || '');
  }

  // Merge _rev and createdAt, skip content-hash duplicates
  let created = 0;
  let updated = 0;
  const toWrite: MessageDoc[] = [];
  const seenHashes = new Set<string>();
  for (const doc of docs) {
    // Skip if we've already seen this content hash in this batch
    if (seenHashes.has(doc.contentHash)) continue;
    seenHashes.add(doc.contentHash);

    const prev = existingMap.get(doc._id);
    if (prev) {
      (doc as any)._rev = prev._rev;
      doc.createdAt = prev.createdAt;
      updated++;
      toWrite.push(doc);
    } else if (existingHashes.has(doc.contentHash)) {
      // Different ID but same content hash — skip (it's a duplicate)
      continue;
    } else {
      created++;
      toWrite.push(doc);
    }
  }

  // Write all docs in a single bulk operation
  if (toWrite.length) {
    await withRetry(() => store.bulkDocs(toWrite));
  }
  return { created, updated };
}

/**
 * Get all messages in a thread, sorted oldest-first (chronological order).
 *
 * Uses the (docType, threadId) index for the Mango query, then sorts
 * client-side by timestamp since PouchDB's sort capabilities are limited
 * to indexed fields.
 *
 * @param threadId  The thread to fetch messages for.
 * @param opts.limit  Maximum number of messages to return (default 100).
 */
export async function getMessagesByThread(
  threadId: string,
  opts?: { limit?: number },
  db?: PouchDB.Database,
): Promise<MessageDoc[]> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'message', threadId },
    sort: [{ docType: 'asc' }, { threadId: 'asc' }],
    limit: opts?.limit || 100,
  });
  // Client-side sort: oldest first (ascending timestamp) for chat display
  return (result.docs as MessageDoc[]).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

/**
 * Get all messages for a specific contact, sorted newest-first.
 *
 * Uses the (docType, contactId) index for the Mango query. Includes a
 * defensive client-side filter because PouchDB find can occasionally return
 * documents that don't match the selector when indexes are stale or missing.
 *
 * Note: sorted newest-first (descending), unlike getMessagesByThread which
 * is oldest-first. This is because contact message lists typically show the
 * most recent activity at the top.
 *
 * @param contactId  The contact to fetch messages for.
 * @param opts.limit  Maximum number of messages to return (default 100).
 */
export async function getMessagesByContact(
  contactId: string,
  opts?: { limit?: number },
  db?: PouchDB.Database,
): Promise<MessageDoc[]> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'message', contactId },
    limit: opts?.limit || 100,
  });
  // Safety filter: PouchDB find can return incorrect results without a matching index
  const filtered = (result.docs as MessageDoc[]).filter(d => d.contactId === contactId);
  // Sort newest-first for contact activity views
  return filtered.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

/**
 * Get the most recent messages across all contacts, optionally filtered by
 * platform. Sorted newest-first. Used for the global activity feed.
 *
 * @param opts.platform  If provided, only return messages from this platform.
 * @param opts.limit     Maximum number of messages (default 50).
 */
export async function getRecentMessages(
  opts?: { platform?: Platform; limit?: number },
  db?: PouchDB.Database,
): Promise<MessageDoc[]> {
  const store = db || await getDB();
  const selector: Record<string, unknown> = { docType: 'message' };
  if (opts?.platform) selector.platform = opts.platform;
  const result = await store.find({
    selector,
    limit: opts?.limit || 50,
  });
  // Sort newest-first for the activity feed
  return (result.docs as MessageDoc[]).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

/**
 * Mark all unread messages in a thread as read.
 *
 * Finds all messages where (threadId matches, read = false), flips each to
 * read = true, and writes them back in a single bulkDocs call. Returns the
 * count of messages that were marked read (0 if the thread was already fully
 * read).
 *
 * @param threadId  The thread whose messages should be marked read.
 * @returns         Number of messages that were updated.
 */
export async function markThreadRead(
  threadId: string,
  db?: PouchDB.Database,
): Promise<number> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'message', threadId, read: false },
  });
  const docs = result.docs as MessageDoc[];
  if (!docs.length) return 0;
  for (const doc of docs) {
    doc.read = true;
    doc.updatedAt = new Date().toISOString();
  }
  await store.bulkDocs(docs);
  return docs.length;
}

/**
 * Count unread inbound messages, optionally filtered by platform.
 *
 * Only counts inbound messages (direction = 'in') since outbound messages
 * sent by the user are always considered "read". Uses `fields: ['_id']` to
 * minimize data transfer -- we only need the count, not the full docs.
 *
 * @param platform  If provided, only count unreads on this platform.
 * @returns         Total number of unread inbound messages.
 */
export async function getUnreadCount(
  platform?: Platform,
  db?: PouchDB.Database,
): Promise<number> {
  const store = db || await getDB();
  const selector: Record<string, unknown> = {
    docType: 'message',
    read: false,
    direction: 'in',
  };
  if (platform) selector.platform = platform;
  const result = await store.find({ selector, fields: ['_id'] });
  return result.docs.length;
}
