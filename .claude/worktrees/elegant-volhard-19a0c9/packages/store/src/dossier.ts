/**
 * dossier.ts — Contact dossier (intelligence file) CRUD.
 *
 * ## Categories (v0.57.8)
 *
 * Dossier fields are organised into topical categories so LLM tasks can
 * request only the slice they need rather than receiving the whole document.
 * This mirrors the modular-prompt strategy in llm.ts — nickname generation
 * needs demographics, auto-respond needs logistics, summary needs meeting
 * history, etc. Feeding smaller payloads to the LLM:
 *   - cuts tokens (and therefore cost + latency + rate-limit pressure)
 *   - keeps the provider-side prompt cache prefix stable for longer
 *   - reduces prompt-injection surface area (fewer user-supplied strings
 *     in the system prompt)
 *
 * `getDossier()` still returns the full document for back-compat. Use
 * `getDossierSlice(contactId, categories)` for category-scoped reads.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { ContactDossierDoc } from './types.js';
import { DEFAULT_DOSSIER } from './types.js';
import { getDB } from './db.js';

/** Category → field-name list. Categories match the TypeScript doc's
 *  section headers so the data model is self-documenting. */
export const DOSSIER_CATEGORIES = {
  identity:       ['realName', 'birthYear', 'phone', 'address', 'hometown', 'employer', 'schedule'],
  relationship:   ['relationshipStatus', 'partnerNames', 'partnerLinks'],
  crossPlatform:  ['otherProfileLinks'],
  meetings:       ['metInPerson', 'meetingDates', 'meetingNotes', 'wouldMeetAgain', 'wouldDate'],
  logistics:      ['hasTransportation', 'hasDog', 'isInHotel', 'sentAddressToThem', 'owesMeMoney', 'paidForAnything'],
  profile:        ['position', 'kinks', 'bodyType'],
  trust:          ['isRealOrBot', 'ghostCount', 'deletedChatCount'],
} as const;

export type DossierCategory = keyof typeof DOSSIER_CATEGORIES;

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
 * Return only the dossier fields that belong to the requested categories.
 *
 * Used by LLM task builders that need a narrow slice of dossier context
 * (nickname: identity only; auto-respond: logistics + relationship; etc.)
 * rather than dumping the whole intel file into the prompt.
 *
 * Empty-valued fields are omitted from the result so the caller can trust
 * that every key in the returned object represents a fact we actually know.
 */
export async function getDossierSlice(
  contactId: string,
  categories: DossierCategory[],
  db?: PouchDB.Database,
): Promise<Partial<ContactDossierDoc>> {
  const full = await getDossier(contactId, db);
  if (!full) return {};
  const allowed = new Set<string>();
  for (const cat of categories) {
    for (const f of DOSSIER_CATEGORIES[cat] || []) allowed.add(f);
  }
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const v = (full as any)[key];
    // Skip defaults / empties so the caller doesn't see stale noise
    if (v == null) continue;
    if (typeof v === 'string' && !v) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'number' && v === 0 && (key === 'owesMeMoney' || key === 'ghostCount' || key === 'deletedChatCount')) continue;
    out[key] = v;
  }
  return out as Partial<ContactDossierDoc>;
}

/**
 * Format a dossier slice as a compact bullet-list suitable for dropping
 * into an LLM system prompt. Returns empty string when there's nothing
 * to say (so callers can `if (ctx)` and skip the section entirely).
 */
export function formatDossierContext(slice: Partial<ContactDossierDoc>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(slice)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`- ${k}: ${v.join(', ')}`);
    } else if (typeof v === 'object') {
      continue; // skip autoExtracted blob
    } else {
      lines.push(`- ${k}: ${v}`);
    }
  }
  return lines.join('\n');
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
