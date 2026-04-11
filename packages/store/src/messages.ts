/**
 * messages.ts — Message CRUD operations on PouchDB.
 */

import { stableContentHash } from '@aggregaytor/context-engine';
import type { UnifiedMessage, Platform } from '@aggregaytor/adapter-core';
import type { MessageDoc } from './types.js';
import { getDB } from './db.js';

function messageDocId(msg: UnifiedMessage): string {
  return `msg:${msg.platform}:${msg.id.replace(/^[^:]+:/, '')}`;
}

function toMessageDoc(msg: UnifiedMessage): MessageDoc {
  const now = new Date().toISOString();
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
    contentHash: stableContentHash(`${msg.platform}:${msg.contactId}:${msg.body}:${msg.timestamp}`),
    createdAt: now,
    updatedAt: now,
  };
}

export async function upsertMessage(
  msg: UnifiedMessage,
  db?: PouchDB.Database,
): Promise<{ created: boolean }> {
  const store = db || await getDB();
  const doc = toMessageDoc(msg);
  try {
    const existing = await store.get(doc._id) as MessageDoc;
    doc._rev = existing._rev;
    doc.createdAt = existing.createdAt;
    await store.put(doc);
    return { created: false };
  } catch (err: any) {
    if (err.status === 404) {
      await store.put(doc);
      return { created: true };
    }
    throw err;
  }
}

export async function upsertMessages(
  msgs: UnifiedMessage[],
  db?: PouchDB.Database,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const msg of msgs) {
    const result = await upsertMessage(msg, db);
    if (result.created) created++;
    else updated++;
  }
  return { created, updated };
}

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
  return (result.docs as MessageDoc[]).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

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
  // Filter client-side as safety — PouchDB find can return wrong results without proper index
  const filtered = (result.docs as MessageDoc[]).filter(d => d.contactId === contactId);
  return filtered.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

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
  return (result.docs as MessageDoc[]).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

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
