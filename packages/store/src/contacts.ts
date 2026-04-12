/**
 * contacts.ts — Contact CRUD operations on PouchDB.
 *
 * Contacts are upserted from platform adapters every time a sync runs.
 * The upsert logic is careful to preserve user-facing state that should not
 * be overwritten by a fresh adapter scrape (e.g. lastMessageAt, unreadCount,
 * and existing avatar URLs).
 *
 * All functions accept an optional `db` parameter for test injection.
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
 *
 * New contacts start with lastMessageAt = '' and unreadCount = 0; these
 * fields are populated later by the message upsert pipeline.
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
 * Insert or update a contact from adapter data.
 *
 * Merge behavior on update (when the contact already exists):
 *   - _rev:           attached from existing doc for conflict-free PouchDB update
 *   - createdAt:      preserved from the original insert (never overwritten)
 *   - lastMessageAt:  preserved from existing doc (set by message pipeline, not adapters)
 *   - unreadCount:    preserved from existing doc (managed by message pipeline)
 *   - displayName, profileUrl, avatarUrl, lastSeen, metadata:
 *                     overwritten with the latest adapter data
 *
 * This means adapter syncs refresh profile info without clobbering message
 * state that is managed separately. The avatarUrl is always updated from the
 * adapter; if the adapter sends an empty string the existing URL remains
 * because toContactDoc uses the incoming value as-is and the adapter is
 * expected to send what it has.
 *
 * On first insert (404), the doc is written with default values.
 */
export async function upsertContact(
  contact: UnifiedContact,
  db?: PouchDB.Database,
): Promise<void> {
  const store = db || await getDB();
  const doc = toContactDoc(contact);
  try {
    const existing = await store.get(doc._id) as ContactDoc;
    // Merge: keep revision, original timestamps, and message-managed fields
    doc._rev = existing._rev;
    doc.createdAt = existing.createdAt;
    doc.lastMessageAt = existing.lastMessageAt || doc.lastMessageAt;
    doc.unreadCount = existing.unreadCount;
    await store.put(doc);
  } catch (err: any) {
    if (err.status === 404) {
      // First time seeing this contact -- insert as new
      await store.put(doc);
      return;
    }
    throw err;
  }
}

/**
 * Fetch a single contact by its full PouchDB _id.
 * Returns null (not an error) if the contact does not exist.
 *
 * @param id  Full document ID, e.g. `contact:grindr:12345`.
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
 * Get all contacts on a given platform. Uses the (docType, platform) index.
 *
 * @param platform  Platform to filter by (e.g. 'grindr', 'scruff').
 */
export async function getContactsByPlatform(
  platform: Platform,
  db?: PouchDB.Database,
): Promise<ContactDoc[]> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'contact', platform },
  });
  return result.docs as ContactDoc[];
}

/**
 * Get all contacts across all platforms, with client-side sorting.
 *
 * Sorting options:
 *   - 'lastMessageAt' (default) -- most recently active contacts first
 *   - 'displayName'             -- alphabetical by display name
 *
 * @param opts.sortBy  Sort field (default: 'lastMessageAt').
 */
export async function getAllContacts(
  opts?: { sortBy?: 'lastMessageAt' | 'displayName' },
  db?: PouchDB.Database,
): Promise<ContactDoc[]> {
  const store = db || await getDB();
  const result = await store.find({
    selector: { docType: 'contact' },
  });
  const docs = result.docs as ContactDoc[];
  const sortBy = opts?.sortBy || 'lastMessageAt';
  return docs.sort((a, b) => {
    if (sortBy === 'displayName') return a.displayName.localeCompare(b.displayName);
    // Default: newest activity first (descending by lastMessageAt)
    return new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime();
  });
}
