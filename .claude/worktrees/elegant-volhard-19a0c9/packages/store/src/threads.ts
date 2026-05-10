/**
 * threads.ts — Thread aggregation and unread counts.
 *
 * Threads are not stored as their own document type; instead they are computed
 * on the fly by grouping MessageDocs by contactId and joining in the
 * corresponding ContactDoc. This keeps the database simple (messages are the
 * source of truth) while giving the UI the denormalized ThreadSummary it needs.
 *
 * ## Performance (v0.40.0)
 * Uses allDocs() with key-range queries instead of Mango find(). This bypasses
 * PouchDB's JS-level query planner and uses IndexedDB's native B-tree index
 * directly, reducing getThreadSummaries from ~235ms to ~30-50ms.
 *
 * Also fixes a long-standing bug where contact lookups always returned null
 * because the `contact:` _id prefix was not prepended.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { MessageDoc, ContactDoc, ThreadSummary } from './types.js';
import { getDB } from './db.js';

/**
 * Build the thread list for the main UI inbox.
 *
 * Uses allDocs key-range queries for both messages and contacts:
 *   1. Fetch messages via allDocs({startkey:'msg:', endkey:'msg:\uffff'})
 *      — native IndexedDB key scan, ~5-10x faster than Mango find()
 *   2. Group messages by contactId, counting unreads
 *   3. Batch-fetch all contacts in ONE allDocs call using their known IDs
 *      — eliminates the previous N+1 getContact() loop
 *   4. Inject pinned contacts (Global Chat) that may have no messages
 *   5. Sort by most recent message and apply limit
 *
 * @param opts.platform  If provided, only return threads from this platform.
 * @param opts.limit     Maximum number of threads to return (default 100).
 */
export async function getThreadSummaries(
  opts?: { platform?: Platform; limit?: number },
  db?: PouchDB.Database,
): Promise<ThreadSummary[]> {
  const store = db || await getDB();

  // Step 1: Fetch messages using allDocs key-range instead of Mango find().
  // Message IDs are `msg:{platform}:{messageId}`, so we can use the platform
  // as a key-range filter when specified.
  //
  // v0.57.15: bumped the scan limit from 1000 to 5000. The previous cap
  // silently truncated heavy-user inboxes — once you crossed 1000 messages
  // across all threads, older conversations dropped off the list because
  // their last message wasn't in the scanned window. 5000 covers ~250
  // active threads at 20 msgs/thread; the SW cache still memoizes the
  // result for 5s so this only fires a few times per minute.
  // v0.57.42: descending + smaller limit. We only need the latest message
  // per contact, so iterate from the high end of the key range and stop at
  // 2000 docs. With ~lex-sorted msg ids (msg:{platform}:{messageId} where
  // messageId typically encodes a timestamp) the newest 2000 messages
  // cover the most-recent ~250 active conversations comfortably. The
  // previous 5000-doc scan was returning 5-10MB of message bodies and
  // taking >8s on heavy DBs, hitting the new panel-side timeout. Cap
  // halved AND descending order means we get useful data with way less
  // work \u2014 a heavy user's "active in the last week" inbox finishes in
  // ~1s instead of timing out.
  const startkey = opts?.platform ? `msg:${opts.platform}:\uffff` : 'msg:\uffff';
  const endkey = opts?.platform ? `msg:${opts.platform}:` : 'msg:';
  const result = await store.allDocs({
    startkey,
    endkey,
    include_docs: true,
    descending: true,
    limit: 2000,
  });

  // v0.57.36 memory fix \u2014 instead of materialising the full messages[] array
  // (5000 docs \u00d7 ~1-2KB) and a parallel contactMap that holds the SAME doc
  // references in nested arrays, we walk rows once and only retain the
  // last-seen message per contact + unread count. The full message body
  // never escapes this loop, so the 5-10MB transient stays scoped to the
  // function and is GC-eligible the moment we return.
  const contactMap = new Map<string, { lastMessage: MessageDoc; unread: number }>();
  for (const row of result.rows) {
    const m = row.doc as MessageDoc | undefined;
    if (!m || (m as any).docType !== 'message') continue;
    const existing = contactMap.get(m.contactId);
    if (!existing) {
      contactMap.set(m.contactId, {
        lastMessage: m,
        unread: (!m.read && m.direction === 'in') ? 1 : 0,
      });
    } else {
      // Track unread count
      if (!m.read && m.direction === 'in') existing.unread++;
      // Replace lastMessage if this one is newer
      const aTs = new Date(existing.lastMessage.timestamp).getTime();
      const bTs = new Date(m.timestamp).getTime();
      if (bTs > aTs) existing.lastMessage = m;
    }
  }
  // Drop the rows reference so the 5000-doc allDocs buffer becomes GC-eligible
  // before the contact lookup runs (which itself can allocate megabytes).
  (result as any).rows = null;

  // Step 3: Batch-fetch all contacts in ONE allDocs call.
  // Contact IDs in PouchDB are `contact:{platform}:{userId}`, but message
  // contactId fields are `{platform}:{userId}` (no prefix). We prepend
  // `contact:` to build the correct PouchDB _id for each.
  const uniqueContactIds = [...contactMap.keys()];
  const pinnedIds = ['sniffies:global-chat'];
  // Include pinned contacts in the batch fetch too
  for (const pid of pinnedIds) {
    if (!uniqueContactIds.includes(pid)) uniqueContactIds.push(pid);
  }
  const contactDocIds = uniqueContactIds.map(cid => `contact:${cid}`);
  const contactResult = await store.allDocs({ keys: contactDocIds, include_docs: true });
  const contactLookup = new Map<string, ContactDoc>();
  for (const row of contactResult.rows) {
    if ('error' in row) continue; // 404 — contact not in DB yet
    if (row.doc) {
      // Strip `contact:` prefix to map back to the contactId used in messages
      const contactId = row.id.replace(/^contact:/, '');
      contactLookup.set(contactId, row.doc as ContactDoc);
    }
  }

  // Step 4: Build ThreadSummary for each contact (no per-contact sort —
  // the contactMap already tracks the latest message per contact).
  const summaries: ThreadSummary[] = [];
  for (const [contactId, { lastMessage, unread }] of contactMap) {
    const contact = contactLookup.get(contactId) || null;
    summaries.push({
      threadId: lastMessage.threadId || contactId,
      contactId,
      contact,
      lastMessage,
      unreadCount: unread,
      platform: lastMessage.platform,
    });
  }

  // Step 5: Inject pinned contacts that have no messages yet
  for (const pid of pinnedIds) {
    if (!contactMap.has(pid)) {
      const contact = contactLookup.get(pid);
      if (contact) {
        summaries.push({
          threadId: pid,
          contactId: pid,
          contact,
          lastMessage: { _id: '', docType: 'message', platform: contact.platform, threadId: pid, contactId: pid, direction: 'in', body: 'Tap to open global chat', timestamp: contact.lastSeen || new Date().toISOString(), read: true, metadata: {}, contentHash: '', createdAt: '', updatedAt: '' } as MessageDoc,
          unreadCount: 0,
          platform: contact.platform,
        });
      }
    }
  }

  // Step 6: Sort newest-first and apply the limit
  return summaries
    .sort((a, b) =>
      new Date(b.lastMessage.timestamp).getTime() - new Date(a.lastMessage.timestamp).getTime(),
    )
    .slice(0, opts?.limit || 100);
}

/**
 * Get a map of contactId -> unread message count for all contacts.
 * Used by the UI to render badge counts without the heavier getThreadSummaries.
 */
export async function getThreadUnreadCounts(
  db?: PouchDB.Database,
): Promise<Map<string, number>> {
  const store = db || await getDB();
  const result = await store.allDocs({
    startkey: 'msg:',
    endkey: 'msg:\uffff',
    include_docs: true,
  });
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const doc = row.doc as MessageDoc;
    if (doc && !doc.read && doc.direction === 'in') {
      counts.set(doc.contactId, (counts.get(doc.contactId) || 0) + 1);
    }
  }
  return counts;
}
