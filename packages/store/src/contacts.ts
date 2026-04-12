/**
 * contacts.ts — Contact CRUD operations on PouchDB.
 *
 * Contacts are upserted from platform adapters every time a sync runs.
 * The upsert logic is careful to preserve user-facing state that should not
 * be overwritten by a fresh adapter scrape (e.g. lastMessageAt, unreadCount,
 * and existing avatar URLs).
 *
 * ## Performance (v0.40.0)
 * - upsertContacts() uses allDocs + bulkDocs for O(1) batch operations
 * - getAllContacts / getContactsByPlatform use allDocs key-range queries
 *   instead of Mango find(), bypassing the PouchDB query planner
 */

import type { UnifiedContact, Platform } from '@aggregaytor/adapter-core';
import type { ContactDoc } from './types.js';
import { getDB } from './db.js';

/**
 * Build a deterministic PouchDB _id for a contact.
 * Format: `contact:{platform}:{platformUserId}`
 */
function contactDocId(contact: UnifiedContact): string {
  return `contact:${contact.platform}:${contact.platformUserId}`;
}

/**
 * Convert a platform-agnostic UnifiedContact into a PouchDB ContactDoc.
 */
function toContactDoc(contact: UnifiedContact): ContactDoc {
  const now = new Date().toISOString();
  return {
    _id: contactDocId(contact),
    docType: 'contact',
    platform: contact.platform,
    platformUserId: contact.platformUserId,
    displayName: contact.displayName,
    profileUrl: contact.profileUrl,
    avatarUrl: contact.avatarUrl,
    lastSeen: contact.lastSeen || now,
    lastMessageAt: '',
    unreadCount: 0,
    metadata: contact.metadata || {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Insert or update a single contact. Use upsertContacts() for batches.
 */
export async function upsertContact(
  contact: UnifiedContact,
  db?: PouchDB.Database,
): Promise<void> {
  const store = db || await getDB();
  const doc = toContactDoc(contact);
  try {
    const existing = await store.get(doc._id) as ContactDoc;
    doc._rev = existing._rev;
    doc.createdAt = existing.createdAt;
    doc.lastMessageAt = existing.lastMessageAt || doc.lastMessageAt;
    doc.unreadCount = existing.unreadCount;
    await store.put(doc);
  } catch (err: any) {
    if (err.status === 404) {
      await store.put(doc);
      return;
    }
    throw err;
  }
}

/**
 * Batch insert/update contacts using allDocs + bulkDocs.
 *
 * Same pattern as upsertMessages in messages.ts:
 *   1. Build deterministic _ids for all contacts
 *   2. Batch-fetch existing docs with allDocs({keys}) to get _rev tokens
 *   3. Merge preserved fields (createdAt, lastMessageAt, unreadCount)
 *   4. Write all in a single bulkDocs call
 *
 * This reduces N sequential get+put round-trips to 2 PouchDB calls
 * regardless of batch size.
 */
export async function upsertContacts(
  contacts: UnifiedContact[],
  db?: PouchDB.Database,
): Promise<{ created: number; updated: number }> {
  if (!contacts.length) return { created: 0, updated: 0 };
  const store = db || await getDB();
  const docs = contacts.map(c => toContactDoc(c));
  const ids = docs.map(d => d._id);

  // Batch-fetch existing docs to get _rev and preserved fields
  const existing = await store.allDocs({ keys: ids, include_docs: true });
  const existingMap = new Map<string, ContactDoc>();
  for (const row of existing.rows) {
    if ('error' in row) continue; // 404 — new contact
    if (row.doc) existingMap.set(row.id, row.doc as ContactDoc);
  }

  let created = 0;
  let updated = 0;
  for (const doc of docs) {
    const prev = existingMap.get(doc._id);
    if (prev) {
      // Merge: preserve _rev, original timestamps, and message-managed fields
      (doc as any)._rev = prev._rev;
      doc.createdAt = prev.createdAt;
      doc.lastMessageAt = prev.lastMessageAt || doc.lastMessageAt;
      doc.unreadCount = prev.unreadCount;
      // Preserve existing avatar if new one is empty
      if (!doc.avatarUrl && prev.avatarUrl) doc.avatarUrl = prev.avatarUrl;
      updated++;
    } else {
      created++;
    }
  }

  await store.bulkDocs(docs);
  return { created, updated };
}

/**
 * Fetch a single contact by its full PouchDB _id.
 * Returns null if the contact does not exist.
 */
export async function getContact(
  id: string,
  db?: PouchDB.Database,
): Promise<ContactDoc | null> {
  const store = db || await getDB();
  try {
    return await store.get(id) as ContactDoc;
  } catch (err: any) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Get all contacts on a given platform using allDocs key-range.
 * Contact IDs are `contact:{platform}:{userId}`, so we scan
 * `contact:{platform}:` to `contact:{platform}:\uffff`.
 */
export async function getContactsByPlatform(
  platform: Platform,
  db?: PouchDB.Database,
): Promise<ContactDoc[]> {
  const store = db || await getDB();
  const result = await store.allDocs({
    startkey: `contact:${platform}:`,
    endkey: `contact:${platform}:\uffff`,
    include_docs: true,
  });
  return result.rows
    .filter(r => r.doc)
    .map(r => r.doc as ContactDoc);
}

/**
 * Get all contacts across all platforms using allDocs key-range.
 * Scans `contact:` to `contact:\uffff` (native IndexedDB B-tree scan).
 */
export async function getAllContacts(
  opts?: { sortBy?: 'lastMessageAt' | 'displayName' },
  db?: PouchDB.Database,
): Promise<ContactDoc[]> {
  const store = db || await getDB();
  const result = await store.allDocs({
    startkey: 'contact:',
    endkey: 'contact:\uffff',
    include_docs: true,
  });
  const docs = result.rows
    .filter(r => r.doc)
    .map(r => r.doc as ContactDoc);
  const sortBy = opts?.sortBy || 'lastMessageAt';
  return docs.sort((a, b) => {
    if (sortBy === 'displayName') return a.displayName.localeCompare(b.displayName);
    return new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime();
  });
}
