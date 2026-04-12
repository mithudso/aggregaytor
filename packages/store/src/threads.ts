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
  const startkey = opts?.platform ? `msg:${opts.platform}:` : 'msg:';
  const endkey = opts?.platform ? `msg:${opts.platform}:\uffff` : 'msg:\uffff';
  const result = await store.allDocs({
    startkey,
    endkey,
    include_docs: true,
    limit: 1000,
  });
  const messages = result.rows
    .filter(r => r.doc && (r.doc as any).docType === 'message')
    .map(r => r.doc as MessageDoc);

  // Step 2: Group by contactId, counting unreads along the way
  const contactMap = new Map<string, { messages: MessageDoc[]; unread: number }>();
  for (const msg of messages) {
    if (!contactMap.has(msg.contactId)) {
      contactMap.set(msg.contactId, { messages: [], unread: 0 });
    }
    const entry = contactMap.get(msg.contactId)!;
    entry.messages.push(msg);
    if (!msg.read && msg.direction === 'in') entry.unread++;
  }

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

  // Step 4: Build ThreadSummary for each contact
  const summaries: ThreadSummary[] = [];
  for (const [contactId, { messages: msgs, unread }] of contactMap) {
    const sorted = msgs.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    const lastMessage = sorted[0];
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
