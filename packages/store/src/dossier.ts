/**
 * dossier.ts — Contact dossier (intelligence file) CRUD.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { ContactDossierDoc } from './types.js';
import { DEFAULT_DOSSIER } from './types.js';
import { getDB } from './db.js';

function dossierId(contactId: string): string {
  return `dossier:${contactId}`;
}

export async function getDossier(
  contactId: string,
  db?: PouchDB.Database,
): Promise<ContactDossierDoc | null> {
  const store = db || await getDB();
  try {
    return await store.get(dossierId(contactId)) as ContactDossierDoc;
  } catch (err: any) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function upsertDossier(
  contactId: string,
  platform: Platform,
  updates: Partial<ContactDossierDoc>,
  db?: PouchDB.Database,
): Promise<ContactDossierDoc> {
  const store = db || await getDB();
  const now = new Date().toISOString();
  const id = dossierId(contactId);

  let existing: ContactDossierDoc | null = null;
  try {
    existing = await store.get(id) as ContactDossierDoc;
  } catch (err: any) {
    if (err.status !== 404) throw err;
  }

  const doc: ContactDossierDoc = {
    ...DEFAULT_DOSSIER,
    ...existing,
    ...updates,
    _id: id,
    docType: 'dossier',
    contactId,
    platform: updates.platform || existing?.platform || platform,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (existing?._rev) doc._rev = existing._rev;

  // Merge arrays instead of replacing
  if (updates.kinks && existing?.kinks) {
    doc.kinks = [...new Set([...existing.kinks, ...updates.kinks])];
  }
  if (updates.otherProfileLinks && existing?.otherProfileLinks) {
    doc.otherProfileLinks = [...new Set([...existing.otherProfileLinks, ...updates.otherProfileLinks])];
  }
  if (updates.partnerNames && existing?.partnerNames) {
    doc.partnerNames = [...new Set([...existing.partnerNames, ...updates.partnerNames])];
  }
  if (updates.meetingDates && existing?.meetingDates) {
    doc.meetingDates = [...new Set([...existing.meetingDates, ...updates.meetingDates])];
  }
  // Merge autoExtracted
  if (updates.autoExtracted && existing?.autoExtracted) {
    doc.autoExtracted = { ...existing.autoExtracted, ...updates.autoExtracted };
  }

  await store.put(doc);
  return doc;
}

/**
 * Update a single auto-extracted field with source attribution.
 */
export async function setAutoExtractedField(
  contactId: string,
  platform: Platform,
  field: string,
  value: string,
  source: string,
  db?: PouchDB.Database,
): Promise<void> {
  const dossier = await getDossier(contactId, db) || { ...DEFAULT_DOSSIER, contactId, platform } as any;
  const autoExtracted = dossier.autoExtracted || {};
  autoExtracted[field] = { value, source, extractedAt: new Date().toISOString() };

  // Also set the top-level field if it's empty
  const updates: Partial<ContactDossierDoc> = { autoExtracted };
  if (field in DEFAULT_DOSSIER && !(dossier as any)[field]) {
    (updates as any)[field] = value;
  }

  await upsertDossier(contactId, platform, updates, db);
}
