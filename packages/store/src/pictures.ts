/**
 * pictures.ts — Picture library CRUD with send/response tracking.
 */

import type { PictureDoc } from './types.js';
import { getDB } from './db.js';
import type { StoreDatabase } from './db.js';

/**
 * Add an image to the picture library.
 *
 * Engagement counters (sent/response/like) start at zero. The `_id` is
 * `pic:{timestamp}-{random}`. `thumbnail` falls back to `dataUrl` when the
 * caller supplies no separate thumbnail.
 *
 * @param input  Picture fields; `tag` defaults to 'other' when empty.
 * @param db     Optional store override.
 * @returns The newly written PictureDoc.
 */
export async function addPicture(
  input: { tag: string; label: string; dataUrl?: string; filePath?: string; thumbnail?: string },
  db?: StoreDatabase,
): Promise<PictureDoc> {
  const store = db || await getDB();
  const now = new Date().toISOString();
  const id = `pic:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const doc: PictureDoc = {
    _id: id,
    docType: 'picture',
    tag: input.tag || 'other',
    label: input.label || '',
    dataUrl: input.dataUrl || '',
    filePath: input.filePath || '',
    thumbnail: input.thumbnail || input.dataUrl || '',
    sentCount: 0,
    responseCount: 0,
    likeCount: 0,
    lastSentAt: '',
    createdAt: now,
  };
  await store.put(doc);
  return doc;
}

/**
 * List all pictures, optionally filtered to a single tag.
 *
 * @param tag  Restrict to this category tag; omit for the whole library.
 * @param db   Optional store override.
 * @returns Matching PictureDocs (unsorted).
 */
export async function getAllPictures(
  tag?: string,
  db?: StoreDatabase,
): Promise<PictureDoc[]> {
  const store = db || await getDB();
  const selector: Record<string, unknown> = { docType: 'picture' };
  if (tag) selector.tag = tag;
  const result = await store.find({ selector });
  return result.docs as PictureDoc[];
}

/**
 * Fetch one picture by _id, or null if it doesn't exist.
 *
 * @param id  Picture _id.
 * @param db  Optional store override.
 * @returns The PictureDoc, or null on a 404.
 * @throws Re-throws any non-404 store error.
 */
export async function getPicture(
  id: string,
  db?: StoreDatabase,
): Promise<PictureDoc | null> {
  const store = db || await getDB();
  try {
    return await store.get(id) as PictureDoc;
  } catch (err: any) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Increment one engagement counter on a picture (and stamp `lastSentAt` when
 * the counter is `sentCount`).
 *
 * Feeds the "which pictures perform best" ranking used by getPictureByTag and
 * the auto-responder.
 *
 * @param id    Picture _id.
 * @param stat  Which counter to bump.
 * @param db    Optional store override.
 * @throws If the picture does not exist (propagates the store's 404).
 */
export async function incrementPictureStat(
  id: string,
  stat: 'sentCount' | 'responseCount' | 'likeCount',
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id) as PictureDoc;
  doc[stat] = (doc[stat] || 0) + 1;
  if (stat === 'sentCount') doc.lastSentAt = new Date().toISOString();
  await store.put(doc);
}

/**
 * Delete a picture by _id.
 *
 * @param id  Picture _id to remove.
 * @param db  Optional store override.
 * @throws If the picture does not exist (the `get` propagates the store's 404).
 */
export async function deletePicture(
  id: string,
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id);
  await store.remove(doc);
}

/**
 * Pick one picture from a tag, rotating usage by returning the
 * least-recently-sent match (so the auto-responder doesn't spam the same image).
 *
 * @param tag  Category tag to choose from.
 * @param db   Optional store override.
 * @returns The least-recently-sent picture with this tag, or null if none exist.
 */
export async function getPictureByTag(
  tag: string,
  db?: StoreDatabase,
): Promise<PictureDoc | null> {
  const pics = await getAllPictures(tag, db);
  if (!pics.length) return null;
  // Return least-recently-sent to rotate usage
  return pics.sort((a, b) => (a.lastSentAt || '').localeCompare(b.lastSentAt || ''))[0];
}
