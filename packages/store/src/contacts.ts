/**
 * contacts.ts — Contact CRUD operations on PouchDB.
 */

import type { UnifiedContact, Platform } from '@aggregaytor/adapter-core';
import type { ContactDoc } from './types.js';
import { getDB } from './db.js';

function contactDocId(contact: UnifiedContact): string {
  return `contact:${contact.platform}:${contact.platformUserId}`;
}

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
    return new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime();
  });
}
