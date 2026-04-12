/**
 * messages.ts — Message CRUD operations on PouchDB.
 */

import { stableContentHash } from '@aggregaytor/context-engine';
import type { UnifiedMessage, Platform } from '@aggregaytor/adapter-core';
import type { MessageDoc } from './types.js';
import { getDB } from './db.js';

/** Retry a PouchDB operation once after 1 second on failure. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (err) {
    await new Promise(r => setTimeout(r, 1000));
    return fn();
  }
}

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
    await withRetry(() => store.put(doc));
    return { created: false };
  } catch (err: any) {
    if (err.status === 404) {
      await withRetry(() => store.put(doc));
      return { created: true };
    }
    throw err;
  }
}

export async function upsertMessages(
  msgs: UnifiedMessage[],
  db?: PouchDB.Database,
): Promise<{ created: number; updated: number }> {
  if (!msgs.length) return { created: 0, updated: 0 };
  const store = db || await getDB();
  const docs = msgs.map(m => toMessageDoc(m));
  const ids = docs.map(d => d._id);

  // Fetch all existing docs in one call
  const existing = await store.allDocs({ keys: ids, include_docs: true });
  const existingMap = new Map<string, { _rev: string; createdAt: string }>();
  for (const row of existing.rows) {
    if ('error' in row) continue;
    if (row.doc) {
      existingMap.set(row.id, { _rev: (row.doc as any)._rev, createdAt: (row.doc as any).createdAt });
    }
  }

  let created = 0;
  let updated = 0;
  for (const doc of docs) {
    const prev = existingMap.get(doc._id);
    if (prev) {
      (doc as any)._rev = prev._rev;
      doc.createdAt = prev.createdAt;
      updated++;
    } else {
      created++;
    }
  }

  await withRetry(() => store.bulkDocs(docs));
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
