/**
 * thread-meta.ts — Per-thread metadata: bookmark, notes, archive, hide, auto-respond.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { ThreadMetaDoc } from './types.js';
import { DEFAULT_AUTO_RESPOND_SETTINGS } from './types.js';
import { getDB } from './db.js';

function metaId(contactId: string): string {
  return `meta:${contactId}`;
}

const DEFAULTS: Omit<ThreadMetaDoc, '_id' | '_rev' | 'contactId' | 'platform' | 'createdAt' | 'updatedAt'> = {
  docType: 'thread_meta',
  archived: false,
  hidden: false,
  hiddenUntilResponse: false,
  bookmarked: false,
  alias: '',
  tags: [],
  notes: '',
  deletedChatCount: 0,
  autoRespondEnabled: false,
  autoRespondSettings: { ...DEFAULT_AUTO_RESPOND_SETTINGS },
  sentiment: null,
  preferenceScore: null,
};

export async function getThreadMeta(
  contactId: string,
  db?: PouchDB.Database,
): Promise<ThreadMetaDoc | null> {
  const store = db || await getDB();
  try {
    return await store.get(metaId(contactId)) as ThreadMetaDoc;
  } catch (err: any) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function upsertThreadMeta(
  contactId: string,
  platform: Platform,
  updates: Partial<ThreadMetaDoc>,
  db?: PouchDB.Database,
): Promise<ThreadMetaDoc> {
  const store = db || await getDB();
  const now = new Date().toISOString();
  const id = metaId(contactId);

  let existing: ThreadMetaDoc | null = null;
  try {
    existing = await store.get(id) as ThreadMetaDoc;
  } catch (err: any) {
    if (err.status !== 404) throw err;
  }

  const doc: ThreadMetaDoc = {
    ...DEFAULTS,
    ...existing,
    ...updates,
    _id: id,
    docType: 'thread_meta',
    contactId,
    platform: updates.platform || existing?.platform || platform,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (existing?._rev) doc._rev = existing._rev;

  await store.put(doc);
  return doc;
}

export async function getAllThreadMeta(
  db?: PouchDB.Database,
): Promise<ThreadMetaDoc[]> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'thread_meta' },
  });
  return result.docs as ThreadMetaDoc[];
}

export async function getBookmarkedThreads(
  db?: PouchDB.Database,
): Promise<ThreadMetaDoc[]> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'thread_meta', bookmarked: true },
  });
  return result.docs as ThreadMetaDoc[];
}

export async function getArchivedThreads(
  db?: PouchDB.Database,
): Promise<ThreadMetaDoc[]> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'thread_meta', archived: true },
  });
  return result.docs as ThreadMetaDoc[];
}
