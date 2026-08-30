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
import type { StoreDatabase } from './db.js';

/**
 * Retry a PouchDB operation exactly once after a 1-second delay.
 *
 * PouchDB writes can transiently fail under concurrent access (e.g. two
 * adapters syncing at the same time). A single retry with a short backoff
 * handles the vast majority of these cases without adding complexity.
 *
 * The previous implementation discarded the original error — if the retry
 * also failed we only saw the retry's message. v0.57.7 chains the errors so
 * repeated failures surface the original cause in the console.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    await new Promise(r => setTimeout(r, 1000));
    try { return await fn(); }
    catch (retryErr) {
      // Attach the original error so downstream logs aren't blind to the
      // first failure mode (e.g. an initial conflict followed by a network
      // error on retry would otherwise hide the conflict).
      try {
        (retryErr as any).originalError = err;
      } catch { /* frozen/non-extensible error — ignore */ }
      throw retryErr;
    }
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
 * Duck-type guard for a StoreDatabase, used so older call sites that pass the
 * `db` in the second positional slot (where `opts` now lives) are detected and
 * re-routed rather than mistaken for options.
 */
function isStoreDatabase(value: unknown): value is StoreDatabase {
  return !!value && typeof value === 'object' && typeof (value as StoreDatabase).get === 'function';
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
  db?: StoreDatabase,
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
  db?: StoreDatabase,
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

  // Content-hash guard. NOTE the scope: `existing` only holds docs whose _id
  // is in THIS batch, so this cannot detect a stored duplicate that lives
  // under a different _id — catching those would need a contentHash index.
  // What it does catch is a re-ID'd message arriving alongside its previous
  // id in the same batch, which would otherwise be inserted twice.
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
      // Another id in this same batch already carries this content — skip.
      continue;
    } else {
      created++;
      toWrite.push(doc);
    }
  }

  // Write all docs in a single bulk operation
  if (toWrite.length) {
    await withRetry(() => store.bulkDocs(toWrite));
    // New/updated messages may change the unread count, so clear the
    // 2s memoization. The cache auto-refills on the next caller (usually
    // the badge refresh alarm or the panel open).
    invalidateUnreadCountCache();
  }
  return { created, updated };
}

/**
 * Get the most recent messages in a thread, returned oldest-first
 * (chronological order) so the chat view can render them top-to-bottom.
 *
 * The (docType, threadId) index has no timestamp component, so the store
 * returns the whole thread in `_id` order. The limit must therefore be applied
 * AFTER sorting by timestamp — applying it inside the query (as this used to)
 * kept the lexicographically-smallest `_id`s, which for adapters whose message
 * ids aren't chronological meant a long thread rendered an arbitrary slice
 * instead of its newest messages.
 *
 * @param threadId  The thread to fetch messages for.
 * @param opts.limit  Maximum number of messages to return (default 100).
 */
export async function getMessagesByThread(
  threadId: string,
  opts?: { limit?: number },
  db?: StoreDatabase,
): Promise<MessageDoc[]> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'message', threadId },
    sort: [{ docType: 'asc' }, { threadId: 'asc' }],
  });
  const limit = opts?.limit || 100;
  const sorted = (result.docs as MessageDoc[]).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  // Keep the newest `limit` messages, still in ascending order.
  return sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
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
  db?: StoreDatabase,
): Promise<MessageDoc[]> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'message', contactId },
    sort: [{ docType: 'asc' }, { timestamp: 'desc' }],
    limit: opts?.limit || 100,
  });
  // Safety filter: legacy callers relied on selector filtering even when
  // indexes were missing or stale; keep the guard while using the timestamp
  // index so the limit still captures the newest messages first.
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
  db?: StoreDatabase,
): Promise<MessageDoc[]> {
  const store = db || await getDB();
  const selector: Record<string, unknown> = { docType: 'message' };
  if (opts?.platform) selector.platform = opts.platform;
  selector.timestamp = { $gt: '' };
  const result = await store.find({
    selector,
    sort: [{ docType: 'asc' }, { timestamp: 'desc' }],
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
  db?: StoreDatabase,
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
  invalidateUnreadCountCache();
  return docs.length;
}

const MAX_BADGE_SCAN = 999; // badge renders "999+" after this
const UNREAD_CACHE_TTL_MS = 2000;
const unreadCountCache = new Map<string, { count: number; time: number; capped: boolean }>();

/**
 * Count unread inbound messages, optionally filtered by platform.
 *
 * Only counts inbound messages (direction = 'in') since outbound messages
 * sent by the user are always considered "read". Uses `fields: ['_id']` to
 * minimize data transfer -- we only need the count, not the full docs.
 *
 * ## Performance
 *
 * PouchDB has no native count operator: any "how many?" query has to
 * enumerate at least the _id column of the matching docs. To keep this
 * call cheap for the two main callers:
 *
 *   - **Badge update** (the hot path — fires every minute + on every
 *     message write). It only needs "0 / 1..99 / 99+" resolution since the
 *     extension action badge is 3 characters wide. We cap the scan at
 *     `MAX_BADGE_SCAN` so a user with tens of thousands of unreads doesn't
 *     walk the whole corpus every minute.
 *   - **Programmatic exact counts** (unusual). Pass `{ exact: true }` to
 *     bypass the cap and get the true total.
 *
 * Additionally, results are memoized for 2 seconds so rapid back-to-back
 * callers (e.g. multiple message-write paths + badge refresh firing in the
 * same tick) share a single PouchDB round-trip.
 *
 * @param platform  If provided, only count unreads on this platform.
 * @param opts.exact  If true, return exact count (no cap). Default false.
 * @param opts.limit  Override the default cap. Ignored if exact=true.
 * @param db          Optional store override (also accepted in the `opts` slot
 *                    for back-compat with older two-arg call sites).
 * @returns           Count of unread inbound messages, capped unless exact.
 */
export async function getUnreadCount(
  platform?: Platform,
  opts?: { exact?: boolean; limit?: number },
  db?: StoreDatabase,
): Promise<number> {
  // Back-compat: older call sites pass the DB as the second positional arg.
  if (isStoreDatabase(opts) && !db) {
    db = opts;
    opts = undefined;
  }
  const exact = !!opts?.exact;
  const limit = exact ? 0 : Math.max(opts?.limit ?? MAX_BADGE_SCAN, 1);

  const cacheKey = `${platform || '*'}:${exact ? 'exact' : String(limit)}`;
  const cached = unreadCountCache.get(cacheKey);
  if (cached && Date.now() - cached.time < UNREAD_CACHE_TTL_MS) {
    return cached.count;
  }

  const store = db || await getDB();
  const selector: Record<string, unknown> = {
    docType: 'message',
    read: false,
    direction: 'in',
  };
  if (platform) selector.platform = platform;

  // Capped scan: pass limit + 1 so we can detect overflow and return
  // "limit" (with the +1 hidden) when the true count exceeds the cap.
  const queryLimit = exact ? Number.MAX_SAFE_INTEGER : limit + 1;
  const result = await store.find({ selector, fields: ['_id'], limit: queryLimit });
  const raw = result.docs.length;
  const count = exact ? raw : Math.min(raw, limit);
  const capped = !exact && raw > limit;

  unreadCountCache.set(cacheKey, { count, time: Date.now(), capped });
  // Keep the cache small — at most one entry per platform × exact/limit
  // variant. Bounded by the fixed set of call sites, but trim defensively.
  // v0.57.15: defensive guard against the (impossible-but-cheap-to-check)
  // case where iter.next() returns done=true on a non-empty map; passing
  // `undefined` to Map.delete is harmless but the cast hid the case from
  // future maintainers.
  if (unreadCountCache.size > 32) {
    const iter = unreadCountCache.keys();
    const next = iter.next();
    if (!next.done) unreadCountCache.delete(next.value as string);
  }

  return count;
}

/**
 * Invalidate the unread count cache. Call after any write that may change
 * the unread state (new message ingested, mark-read, bulk clear).
 */
export function invalidateUnreadCountCache(): void {
  unreadCountCache.clear();
}

// ── Auto-purge (v0.57.79) ────────────────────────────────────────────────────
//
// Hard cap on database size. When `navigator.storage.estimate()` reports
// usage over a threshold, delete oldest messages until usage drops back
// under the threshold. Skips messages from contacts that are flagged
// archived / hidden / blockedByThem (the user's "blocked list") so the
// retention semantics for explicit blocks aren't disturbed.
//
// `store.compact()` is a no-op on the Dexie backend (there is no rev tree to
// collapse — deletes free their rows immediately), but it is still called so
// the loop keeps working if the store is ever swapped back to a revisioned
// backend. Space is reclaimed asynchronously by the browser, so
// `navigator.storage.estimate()` usually lags the deletes by a tick; the
// iteration/elapsed caps below exist so a lagging estimate can't spin.
//
// Returns a summary object the caller can log + show in a notification.

export interface PurgeResult {
  ranAt: string;
  thresholdBytes: number;
  beforeBytes: number;
  afterBytes: number;
  deletedCount: number;
  protectedCount: number;
  iterations: number;
  elapsedMs: number;
  hitSafetyCap: boolean;
  reason?: string;
}

/**
 * Build the set of contactIds whose messages should be SPARED from purge.
 * A contact is "blocked" if any of its thread_meta flags is set: archived,
 * hidden, blockedByThem, or favorited (favorited is treated as a manual
 * keep-forever flag too — same intent as "I care about this person").
 *
 * Returns `null` when the metadata lookup fails. Callers MUST treat that as
 * "protect everything" and skip the purge entirely — an empty set would mean
 * "nothing is protected" and let the purge delete blocked-list history.
 */
async function getProtectedContactIds(db: StoreDatabase): Promise<Set<string> | null> {
  const out = new Set<string>();
  try {
    const result = await db.allDocs({
      startkey: 'meta:',
      endkey: 'meta:￿',
      include_docs: true,
    });
    for (const row of result.rows) {
      const m = row.doc as any;
      if (!m) continue;
      if (m.archived || m.hidden || m.blockedByThem || m.favorited || m.bookmarked) {
        if (m.contactId) out.add(String(m.contactId));
      }
    }
  } catch (err) {
    console.warn('[Aggregaytor:Store] getProtectedContactIds failed; skipping purge:', err);
    return null;
  }
  return out;
}

/**
 * Estimate current IDB usage. Wraps navigator.storage.estimate so callers
 * don't need to repeat the try/catch. Returns 0 if unsupported.
 */
async function getCurrentIdbBytes(): Promise<number> {
  try {
    if ((navigator as any).storage?.estimate) {
      const est = await (navigator as any).storage.estimate();
      return est?.usage || 0;
    }
  } catch {}
  return 0;
}

/**
 * Purge oldest non-protected messages until IDB usage is below `thresholdBytes`,
 * OR safety caps are hit. Run from a periodic alarm or manually.
 */
export async function purgeOldestMessages(
  thresholdBytes: number,
  db?: StoreDatabase,
): Promise<PurgeResult> {
  const t0 = Date.now();
  const ranAt = new Date(t0).toISOString();
  const store = db || await getDB();

  const beforeBytes = await getCurrentIdbBytes();
  if (beforeBytes <= thresholdBytes) {
    return {
      ranAt, thresholdBytes, beforeBytes, afterBytes: beforeBytes,
      deletedCount: 0, protectedCount: 0, iterations: 0,
      elapsedMs: Date.now() - t0, hitSafetyCap: false,
      reason: 'under threshold — no purge needed',
    };
  }

  const protectedIds = await getProtectedContactIds(store);
  if (!protectedIds) {
    // We could not determine which contacts are protected, so we cannot
    // safely delete anything. Bail out; the next mem-gc tick retries.
    return {
      ranAt, thresholdBytes, beforeBytes, afterBytes: beforeBytes,
      deletedCount: 0, protectedCount: 0, iterations: 0,
      elapsedMs: Date.now() - t0, hitSafetyCap: false,
      reason: 'thread metadata unavailable — purge skipped to protect blocked history',
    };
  }
  let deletedCount = 0;
  let iterations = 0;
  const BATCH = 500;
  // Hard caps so a runaway purge can't grind for hours or delete more
  // than ~50K docs in a single tick. The mem-gc alarm fires every 5min
  // so a still-bloated DB will resume on the next tick.
  const MAX_ITERATIONS = 100; // 50K docs at 500/iter
  const MAX_ELAPSED_MS = 90_000; // 90s wall clock per call

  let currentBytes = beforeBytes;
  let hitSafetyCap = false;

  while (currentBytes > thresholdBytes) {
    if (iterations >= MAX_ITERATIONS) { hitSafetyCap = true; break; }
    if (Date.now() - t0 > MAX_ELAPSED_MS) { hitSafetyCap = true; break; }
    iterations++;

    // Find oldest BATCH messages globally. Uses the (docType, timestamp)
    // index added in db.ts so this is O(log n) seek + linear scan over
    // BATCH rows — not a full table scan.
    const found = await store.find<MessageDoc>({
      selector: { docType: 'message', timestamp: { $gt: '' } },
      sort: [{ docType: 'asc' }, { timestamp: 'asc' }],
      limit: BATCH,
    });
    if (!found.docs.length) break;

    // Filter out messages from protected (blocked / archived / hidden /
    // favorited / bookmarked) contacts.
    const toDelete: Array<{ _id: string; _rev?: string; _deleted: true }> = [];
    for (const m of found.docs) {
      if (protectedIds.has(String(m.contactId))) continue;
      toDelete.push({ _id: m._id, _rev: m._rev, _deleted: true });
    }

    // If everything in this batch is protected, we'd loop forever (the
    // selector returns the same docs since they're not deleted). Bail.
    if (!toDelete.length) {
      // Some non-protected docs may exist further along, but we can't
      // efficiently page past the protected ones with sort+limit alone.
      // Bail out and let the next mem-gc tick try again with potentially
      // updated protectedIds (e.g. user un-archived something).
      break;
    }

    await store.bulkDocs(toDelete);
    deletedCount += toDelete.length;
    // Deleted messages may have been unread, so the memoized badge count is
    // now stale.
    invalidateUnreadCountCache();

    // Compact every few iterations so the rev-tree garbage actually
    // releases. Compact is expensive; running it every 5 batches gives
    // a good lift between batches without dominating the loop.
    if (iterations % 5 === 0) {
      try { await store.compact(); } catch {}
    }

    currentBytes = await getCurrentIdbBytes();
    // Defensive: if the IDB estimate didn't decrease at all (compact
    // didn't catch up yet), bail to let the next tick continue.
    if (currentBytes >= beforeBytes && iterations >= 3) {
      hitSafetyCap = true;
      break;
    }
  }

  // One final compact to release any remaining rev-tree garbage.
  try { await store.compact(); } catch {}

  const afterBytes = await getCurrentIdbBytes();
  const elapsedMs = Date.now() - t0;
  return {
    ranAt, thresholdBytes, beforeBytes, afterBytes,
    deletedCount, protectedCount: protectedIds.size,
    iterations, elapsedMs, hitSafetyCap,
  };
}
