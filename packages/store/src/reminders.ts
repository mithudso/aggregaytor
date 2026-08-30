/**
 * reminders.ts — Reminder/appointment CRUD.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { ReminderDoc } from './types.js';
import { getDB } from './db.js';
import type { StoreDatabase } from './db.js';

/**
 * Create and persist a reminder for a contact.
 *
 * The `_id` is `reminder:{timestamp}-{random}` so reminders never collide and
 * remain roughly time-ordered. `contactSnapshot` (optional) freezes the
 * contact's display fields at creation time so the reminder stays meaningful
 * even if the profile later changes.
 *
 * @param contactId       Contact the reminder is about.
 * @param platform        Platform the contact lives on.
 * @param note            Free-text reminder body.
 * @param dueAt           ISO 8601 due time.
 * @param contactSnapshot Optional frozen copy of the contact's display fields.
 * @param db              Optional store override (tests inject an in-memory DB).
 * @returns The newly written ReminderDoc.
 */
export async function createReminder(
  contactId: string,
  platform: Platform,
  note: string,
  dueAt: string,
  contactSnapshot?: ReminderDoc['contactSnapshot'],
  db?: StoreDatabase,
): Promise<ReminderDoc> {
  const store = db || await getDB();
  const now = new Date().toISOString();
  const id = `reminder:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const doc: ReminderDoc = {
    _id: id,
    docType: 'reminder',
    contactId,
    platform,
    note,
    dueAt,
    notifiedApproach: false,
    notifiedDue: false,
    createdAt: now,
    ...(contactSnapshot ? { contactSnapshot } : {}),
  };
  await store.put(doc);
  return doc;
}

/**
 * List reminders, optionally scoped to a contact and/or upcoming-only, sorted
 * by due time ascending.
 *
 * `upcoming` keeps reminders whose `dueAt` is still in the future OR whose
 * "due" notification has not yet fired, so a just-passed reminder isn't hidden
 * before the user has been notified.
 *
 * @param opts.contactId  Restrict to one contact.
 * @param opts.upcoming   Drop reminders already past AND already notified.
 * @param db              Optional store override.
 * @returns Matching reminders, soonest-due first.
 */
export async function getReminders(
  opts?: { contactId?: string; upcoming?: boolean },
  db?: StoreDatabase,
): Promise<ReminderDoc[]> {
  const store = db || await getDB();
  const selector: Record<string, unknown> = { docType: 'reminder' };
  if (opts?.contactId) selector.contactId = opts.contactId;

  const result = await store.find({ selector });
  let docs = result.docs as ReminderDoc[];

  if (opts?.upcoming) {
    const now = new Date().toISOString();
    docs = docs.filter(d => d.dueAt >= now || (!d.notifiedDue));
  }

  return docs.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/**
 * Flag one of a reminder's two notification phases as fired, so the notifier
 * never double-alerts.
 *
 * @param id    Reminder _id.
 * @param type  Which phase fired: 'approach' (pre-due) or 'due' (at due time).
 * @param db    Optional store override.
 * @throws If the reminder does not exist (propagates the store's 404).
 */
export async function markReminderNotified(
  id: string,
  type: 'approach' | 'due',
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id) as ReminderDoc;
  if (type === 'approach') doc.notifiedApproach = true;
  else doc.notifiedDue = true;
  await store.put(doc);
}

/**
 * Delete a reminder by _id.
 *
 * @param id  Reminder _id to remove.
 * @param db  Optional store override.
 * @throws If the reminder does not exist (the `get` propagates the store's 404).
 */
export async function deleteReminder(
  id: string,
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id);
  await store.remove(doc);
}
