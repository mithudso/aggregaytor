/**
 * threads.ts — Thread aggregation and unread counts.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { MessageDoc, ContactDoc, ThreadSummary } from './types.js';
import { getDB } from './db.js';
import { getContact } from './contacts.js';

export async function getThreadSummaries(
  opts?: { platform?: Platform; limit?: number },
  db?: PouchDB.Database,
): Promise<ThreadSummary[]> {
  const store = db || await getDB();
  const selector: Record<string, unknown> = { docType: 'message' };
  if (opts?.platform) selector.platform = opts.platform;

  const result = await store.find({ selector, limit: 5000 });
  const messages = result.docs as MessageDoc[];

  // Group by contactId, find last message and unread count
  const contactMap = new Map<string, { messages: MessageDoc[]; unread: number }>();
  for (const msg of messages) {
    if (!contactMap.has(msg.contactId)) {
      contactMap.set(msg.contactId, { messages: [], unread: 0 });
    }
    const entry = contactMap.get(msg.contactId)!;
    entry.messages.push(msg);
    if (!msg.read && msg.direction === 'in') entry.unread++;
  }

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

  return summaries
    .sort((a, b) =>
      new Date(b.lastMessage.timestamp).getTime() - new Date(a.lastMessage.timestamp).getTime(),
    )
    .slice(0, opts?.limit || 100);
}

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
