/**
 * threads.ts — Thread aggregation and unread counts.
 *
 * Threads are not stored as their own document type; instead they are computed
 * on the fly by grouping MessageDocs by contactId and joining in the
 * corresponding ContactDoc. This keeps the database simple (messages are the
 * source of truth) while giving the UI the denormalized ThreadSummary it needs.
 *
 * ## Performance
 * Uses indexed store queries to pull the newest messages by real timestamp,
 * then batches contact lookups in a single allDocs() call. This keeps inbox
 * ordering correct across adapters whose message IDs are not chronological.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { MessageDoc, ContactDoc, ThreadSummary } from './types.js';
import { getDB } from './db.js';
import type { StoreDatabase } from './db.js';

/**
 * Build the thread list for the main UI inbox.
 *
 * Uses indexed message queries plus batched contact lookups:
 *   1. Fetch recent messages via find({ selector, sort:[timestamp desc] })
 *      so recency follows `timestamp`, not `_id`
 *   2. Group messages by contactId, counting unreads
 *   3. Batch-fetch all contacts in ONE allDocs call using their known IDs
 *      — eliminates per-contact lookups
 *   4. Inject pinned contacts (Global Chat) that may have no messages
 *   5. Sort by most recent message and apply limit
 *
 * @param opts.platform  If provided, only return threads from this platform.
 * @param opts.limit     Maximum number of threads to return (default 100).
 */
export async function getThreadSummaries(
  opts?: { platform?: Platform; limit?: number },
  db?: StoreDatabase,
): Promise<ThreadSummary[]> {
  const store = db || await getDB();

  // Step 1: Fetch the newest messages by actual timestamp instead of `_id`.
  // Adapter message IDs are not reliably chronological across platforms, so
  // `_id` order can silently hide active conversations in large inboxes.
  const selector: Record<string, unknown> = {
    docType: 'message',
    timestamp: { $gt: '' },
  };
  if (opts?.platform) selector.platform = opts.platform;
  const result = await store.find<MessageDoc>({
    selector,
    sort: [{ docType: 'asc' }, { timestamp: 'desc' }],
    limit: 2000,
  });

  // v0.57.36 memory fix \u2014 instead of materialising the full messages[] array
  // (5000 docs \u00d7 ~1-2KB) and a parallel contactMap that holds the SAME doc
  // references in nested arrays, we walk rows once and only retain the
  // last-seen message per contact + unread count. The full message body
  // never escapes this loop, so the 5-10MB transient stays scoped to the
  // function and is GC-eligible the moment we return.
  const contactMap = new Map<string, { lastMessage: MessageDoc; unread: number }>();
  for (const m of result.docs) {
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

  // Step 3: Batch-fetch all contacts in ONE allDocs call.
  // Contact docs are stored as `contact:{platform}:{userId}` while message
  // contactId fields omit the `contact:` prefix, so we add it here.
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
  db?: StoreDatabase,
): Promise<Map<string, number>> {
  const store = db || await getDB();
  // Filter in the store and project down to contactId. The previous
  // allDocs({ include_docs: true }) scan materialised EVERY message document \u2014
  // bodies and all \u2014 purely to count the unread ones, which on a large inbox
  // is several MB of transient heap in the service worker.
  const result = await store.find<MessageDoc>({
    selector: { docType: 'message', read: false, direction: 'in' },
    fields: ['contactId'],
  });
  const counts = new Map<string, number>();
  for (const doc of result.docs) {
    if (!doc.contactId) continue;
    counts.set(doc.contactId, (counts.get(doc.contactId) || 0) + 1);
  }
  return counts;
}
