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
  favorited: false,
  alias: '',
  tags: [],
  notes: '',
  deletedChatCount: 0,
  autoRespondEnabled: false,
  autoRespondSettings: { ...DEFAULT_AUTO_RESPOND_SETTINGS },
  generatedNickname: '',
  blockedByThem: false,
  distance: '',
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

/**
 * Fields on ThreadMetaDoc that, when changed, are preference-model training
 * signals. Writes that touch any of these bump `signalsUpdatedAt` so the
 * incremental auto-trainer knows which threads to re-scan.
 *
 * Non-signal fields (notes, tags, alias, distance) are excluded so cosmetic
 * edits don't fan out into unnecessary model retraining work.
 */
const SIGNAL_FIELDS = new Set<keyof ThreadMetaDoc>([
  'bookmarked', 'favorited', 'rating' as any,
  'blockedByThem', 'archived', 'hidden',
]);

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

  // Detect whether this write changes a preference signal. Compares each
  // signal field's proposed value to the existing value; if any differ, we
  // bump signalsUpdatedAt so the incremental trainer picks this thread up
  // on its next pass. This keeps the training scan O(Δ) instead of O(N).
  let signalChanged = !existing; // new docs always count as a signal change if they carry any signal
  if (existing) {
    for (const field of SIGNAL_FIELDS) {
      if (field in updates) {
        const next = (updates as any)[field];
        const prev = (existing as any)[field];
        if (next !== prev) { signalChanged = true; break; }
      }
    }
  } else {
    // New doc — count as a signal change only if any signal field is set
    signalChanged = false;
    for (const field of SIGNAL_FIELDS) {
      if (field in updates && (updates as any)[field]) { signalChanged = true; break; }
    }
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
  if (signalChanged) {
    (doc as any).signalsUpdatedAt = now;
  }
  if (existing?._rev) doc._rev = existing._rev;

  await store.put(doc);
  return doc;
}

/** Fetch all thread metadata using allDocs key-range (meta: prefix). */
export async function getAllThreadMeta(
  db?: PouchDB.Database,
): Promise<ThreadMetaDoc[]> {
  const store = db || await getDB();
  const result = await store.allDocs({
    startkey: 'meta:',
    endkey: 'meta:\uffff',
    include_docs: true,
  });
  return result.rows
    .filter(r => r.doc)
    .map(r => r.doc as ThreadMetaDoc);
}

/** Fetch bookmarked threads. Uses allDocs range + client-side filter. */
export async function getBookmarkedThreads(
  db?: PouchDB.Database,
): Promise<ThreadMetaDoc[]> {
  const all = await getAllThreadMeta(db);
  return all.filter(m => m.bookmarked);
}

/** Fetch archived threads. Uses allDocs range + client-side filter. */
export async function getArchivedThreads(
  db?: PouchDB.Database,
): Promise<ThreadMetaDoc[]> {
  const all = await getAllThreadMeta(db);
  return all.filter(m => m.archived);
}
