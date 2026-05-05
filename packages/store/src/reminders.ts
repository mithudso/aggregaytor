/**
 * reminders.ts — Reminder/appointment CRUD.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { ReminderDoc } from './types.js';
import { getDB } from './db.js';

export async function createReminder(
  contactId: string,
  platform: Platform,
  note: string,
  dueAt: string,
  contactSnapshot?: ReminderDoc['contactSnapshot'],
  db?: PouchDB.Database,
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

export async function getReminders(
  opts?: { contactId?: string; upcoming?: boolean },
  db?: PouchDB.Database,
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

export async function markReminderNotified(
  id: string,
  type: 'approach' | 'due',
  db?: PouchDB.Database,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id) as ReminderDoc;
  if (type === 'approach') doc.notifiedApproach = true;
  else doc.notifiedDue = true;
  await store.put(doc);
}

export async function deleteReminder(
  id: string,
  db?: PouchDB.Database,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id);
  await store.remove(doc);
}
