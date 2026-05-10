/**
 * tasks.ts — Task CRUD operations on PouchDB.
 *
 * Tasks are user-created to-do items, optionally linked to a contact.
 * Uses allDocs key-range queries for listing (no Mango find).
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { TaskDoc } from './types.js';
import { getDB } from './db.js';
import type { StoreDatabase } from './db.js';

/**
 * Create a new task and persist it to PouchDB.
 *
 * Generates a deterministic _id in the format `task:{timestamp}-{random}`.
 * Returns the full TaskDoc after insertion.
 */
export async function createTask(
  opts: {
    title: string;
    notes?: string;
    contactId?: string;
    platform?: Platform;
    dueAt?: string;
    priority?: 'low' | 'medium' | 'high';
  },
  db?: StoreDatabase,
): Promise<TaskDoc> {
  const store = db || await getDB();
  const now = new Date().toISOString();
  const id = `task:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const doc: TaskDoc = {
    _id: id,
    docType: 'task',
    title: opts.title,
    notes: opts.notes || '',
    contactId: opts.contactId,
    platform: opts.platform,
    dueAt: opts.dueAt,
    completed: false,
    priority: opts.priority || 'medium',
    createdAt: now,
    updatedAt: now,
  };
  await store.put(doc);
  return doc;
}

/**
 * Get all tasks using allDocs key-range scan.
 *
 * Optional filters:
 *   - `completed` -- filter by completion status
 *   - `contactId` -- filter by linked contact
 *
 * Sort order: incomplete first, then by dueAt (soonest first, undated last),
 * then by createdAt (oldest first).
 */
export async function getAllTasks(
  opts?: { completed?: boolean; contactId?: string },
  db?: StoreDatabase,
): Promise<TaskDoc[]> {
  const store = db || await getDB();
  const result = await store.allDocs({
    startkey: 'task:',
    endkey: 'task:\uffff',
    include_docs: true,
  });
  let docs = result.rows
    .filter(r => r.doc)
    .map(r => r.doc as TaskDoc);

  // Client-side filters
  if (opts?.completed !== undefined) {
    docs = docs.filter(d => d.completed === opts.completed);
  }
  if (opts?.contactId) {
    docs = docs.filter(d => d.contactId === opts.contactId);
  }

  // Sort: incomplete first, then by dueAt (soonest first, undated last), then createdAt
  return docs.sort((a, b) => {
    // Incomplete before completed
    if (a.completed !== b.completed) return a.completed ? 1 : -1;

    // By dueAt -- soonest first, undated pushed to end
    if (a.dueAt || b.dueAt) {
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      const dueCmp = a.dueAt.localeCompare(b.dueAt);
      if (dueCmp !== 0) return dueCmp;
    }

    // By createdAt -- oldest first
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Update an existing task by merging partial updates.
 * Automatically sets `updatedAt` to the current time.
 */
export async function updateTask(
  id: string,
  updates: Partial<TaskDoc>,
  db?: StoreDatabase,
): Promise<TaskDoc> {
  const store = db || await getDB();
  const existing = await store.get(id) as TaskDoc;
  const now = new Date().toISOString();

  const doc: TaskDoc = {
    ...existing,
    ...updates,
    _id: existing._id,
    _rev: existing._rev,
    docType: 'task',
    updatedAt: now,
  };
  await store.put(doc);
  return doc;
}

/**
 * Delete a task by its PouchDB _id.
 */
export async function deleteTask(
  id: string,
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id);
  await store.remove(doc);
}

/**
 * Get all tasks linked to a specific contact.
 * Convenience wrapper around getAllTasks with a contactId filter.
 */
export async function getTasksByContact(
  contactId: string,
  db?: StoreDatabase,
): Promise<TaskDoc[]> {
  return getAllTasks({ contactId }, db);
}
