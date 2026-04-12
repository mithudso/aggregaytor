/**
 * threads.ts — Thread aggregation and unread counts.
 *
 * Threads are not stored as their own document type; instead they are computed
 * on the fly by grouping MessageDocs by contactId and joining in the
 * corresponding ContactDoc. This keeps the database simple (messages are the
 * source of truth) while giving the UI the denormalized ThreadSummary it needs.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { MessageDoc, ContactDoc, ThreadSummary } from './types.js';
import { getDB } from './db.js';
import { getContact } from './contacts.js';

/**
 * Build the thread list for the main UI inbox.
 *
 * Join logic (3-way join: messages + contacts + unread counts):
 *   1. Fetch up to 5000 messages (all platforms or filtered by one platform).
 *   2. Group messages by contactId into a Map, accumulating an array of
 *      messages and a running unread count per contact.
 *   3. For each contact group, sort messages newest-first and take the first
 *      one as `lastMessage`. Look up the ContactDoc for display info (name,
 *      avatar, etc.).
 *   4. Append any "pinned" contacts that have no messages yet (e.g. the
 *      Sniffies global chat room) with a synthetic placeholder message.
 *   5. Sort the final list by lastMessage timestamp (newest first) and
 *      truncate to the requested limit.
 *
 * Performance note: the 5000-message cap prevents loading the entire database
 * for users with very long histories. For most users this is plenty to build
 * the full thread list since it only needs one message per contact.
 *
 * @param opts.platform  If provided, only return threads from this platform.
 * @param opts.limit     Maximum number of threads to return (default 100).
 */
export async function getThreadSummaries(
  opts?: { platform?: Platform; limit?: number },
  db?: PouchDB.Database,
): Promise<ThreadSummary[]> {
  const store = db || await getDB();
  const selector: Record<string, unknown> = { docType: 'message' };
  if (opts?.platform) selector.platform = opts.platform;

  // Step 1: Fetch a large batch of messages to group into threads
  const result = await store.find({ selector, limit: 5000 });
  const messages = result.docs as MessageDoc[];

  // Step 2: Group by contactId, counting unreads along the way
  const contactMap = new Map<string, { messages: MessageDoc[]; unread: number }>();
  for (const msg of messages) {
    if (!contactMap.has(msg.contactId)) {
      contactMap.set(msg.contactId, { messages: [], unread: 0 });
    }
    const entry = contactMap.get(msg.contactId)!;
    entry.messages.push(msg);
    // Only inbound unread messages count toward the badge
    if (!msg.read && msg.direction === 'in') entry.unread++;
  }

  // Step 3: Build a ThreadSummary for each contact by finding their latest
  // message and looking up the contact doc for display info
  const summaries: ThreadSummary[] = [];
  for (const [contactId, { messages: msgs, unread }] of contactMap) {
    const sorted = msgs.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    const lastMessage = sorted[0];
    const contact = await getContact(contactId, store);

    summaries.push({
      threadId: lastMessage.threadId || contactId,
      contactId,
      contact,
      lastMessage,
      unreadCount: unread,
      platform: lastMessage.platform,
    });
  }

  // Step 4: Inject pinned contacts that have no messages yet so they always
  // appear in the thread list (e.g. Sniffies Global Chat)
  const pinnedIds = ['sniffies:global-chat'];
  for (const pid of pinnedIds) {
    if (!contactMap.has(pid)) {
      const contact = await getContact(pid, store);
      if (contact) {
        // Create a synthetic placeholder message so the UI has something to render
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

  // Step 5: Sort newest-first and apply the limit
  return summaries
    .sort((a, b) =>
      new Date(b.lastMessage.timestamp).getTime() - new Date(a.lastMessage.timestamp).getTime(),
    )
    .slice(0, opts?.limit || 100);
}

/**
 * Get a map of contactId -> unread message count for all contacts.
 *
 * Fetches all unread inbound messages in one query and aggregates counts
 * client-side. Used by the UI to render badge counts on each thread without
 * needing to call getThreadSummaries (which is heavier).
 *
 * @returns Map where keys are contactId strings and values are unread counts.
 */
export async function getThreadUnreadCounts(
  db?: PouchDB.Database,
): Promise<Map<string, number>> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'message', read: false, direction: 'in' },
  });
  const counts = new Map<string, number>();
  for (const doc of result.docs as MessageDoc[]) {
    counts.set(doc.contactId, (counts.get(doc.contactId) || 0) + 1);
  }
  return counts;
}
