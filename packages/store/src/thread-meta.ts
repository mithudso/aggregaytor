/**
 * thread-meta.ts — Per-thread metadata: bookmark, notes, archive, hide, auto-respond.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { ThreadMetaDoc } from './types.js';
import { DEFAULT_AUTO_RESPOND_SETTINGS } from './types.js';
import { getDB } from './db.js';
import type { StoreDatabase } from './db.js';

/**
 * Build the ThreadMetaDoc _id for a contact. The `meta:` prefix is what the
 * `startkey: 'meta:'` range scans in `getAllThreadMeta` / export-import rely on.
 */
function metaId(contactId: string): string {
  return `meta:${contactId}`;
}

type ThreadMetaDefaults = Omit<
  ThreadMetaDoc,
  '_id' | '_rev' | 'contactId' | 'platform' | 'createdAt' | 'updatedAt'
>;

/**
 * Built per call — a shared literal would hand every new doc the SAME `tags`
 * array and `autoRespondSettings` object, so one caller mutating either
 * (e.g. `meta.tags.push(...)`) would corrupt the defaults for every later doc.
 */
function threadMetaDefaults(): ThreadMetaDefaults {
  return {
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
}

/**
 * Fetch a contact's thread metadata, or null if none has been created yet.
 *
 * @param contactId  Contact whose metadata to load.
 * @param db         Optional store override.
 * @returns The ThreadMetaDoc, or null on a 404.
 * @throws Re-throws any non-404 store error.
 */
export async function getThreadMeta(
  contactId: string,
  db?: StoreDatabase,
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
  'bookmarked', 'favorited', 'rating',
  'blockedByThem', 'archived', 'hidden',
]);

/**
 * Create or update a contact's thread metadata, merging `updates` over the
 * stored doc (or over fresh defaults on first write).
 *
 * Bumps `signalsUpdatedAt` whenever a write changes any preference-model
 * signal field (see {@link SIGNAL_FIELDS}) so the incremental auto-trainer can
 * scan only changed threads. `_rev` from the existing doc is carried forward
 * for a conflict-free write.
 *
 * @param contactId  Contact this metadata belongs to.
 * @param platform   Platform of the thread (used only when creating).
 * @param updates    Partial fields to apply.
 * @param db         Optional store override.
 * @returns The written ThreadMetaDoc.
 * @throws Re-throws any non-404 error from the existing-doc read.
 */
export async function upsertThreadMeta(
  contactId: string,
  platform: Platform,
  updates: Partial<ThreadMetaDoc>,
  db?: StoreDatabase,
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
  let signalChanged = false;
  for (const field of SIGNAL_FIELDS) {
    if (!(field in updates)) continue;
    const next = (updates as Record<string, unknown>)[field];
    // Existing doc: a signal changed if the proposed value differs.
    // New doc: only a truthy signal counts (an all-false doc carries no signal).
    if (existing
      ? next !== (existing as unknown as Record<string, unknown>)[field]
      : !!next
    ) {
      signalChanged = true;
      break;
    }
  }

  const doc: ThreadMetaDoc = {
    ...threadMetaDefaults(),
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
  db?: StoreDatabase,
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
  db?: StoreDatabase,
): Promise<ThreadMetaDoc[]> {
  const all = await getAllThreadMeta(db);
  return all.filter(m => m.bookmarked);
}

/** Fetch archived threads. Uses allDocs range + client-side filter. */
export async function getArchivedThreads(
  db?: StoreDatabase,
): Promise<ThreadMetaDoc[]> {
  const all = await getAllThreadMeta(db);
  return all.filter(m => m.archived);
}
