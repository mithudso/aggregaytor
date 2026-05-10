/**
 * pictures.ts — Picture library CRUD with send/response tracking.
 */

import type { PictureDoc } from './types.js';
import { getDB } from './db.js';
import type { StoreDatabase } from './db.js';

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

export async function deletePicture(
  id: string,
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id);
  await store.remove(doc);
}

export async function getPictureByTag(
  tag: string,
  db?: StoreDatabase,
): Promise<PictureDoc | null> {
  const pics = await getAllPictures(tag, db);
  if (!pics.length) return null;
  // Return least-recently-sent to rotate usage
  return pics.sort((a, b) => (a.lastSentAt || '').localeCompare(b.lastSentAt || ''))[0];
}
