/**
 * db.ts — PouchDB wrapper with singleton connection and index management.
 */

import PouchDB from 'pouchdb-browser';
import PouchDBFind from 'pouchdb-find';

PouchDB.plugin(PouchDBFind);

let _db: PouchDB.Database | null = null;

async function ensureIndexes(db: PouchDB.Database): Promise<void> {
  await Promise.all([
    db.createIndex({ index: { fields: ['docType', 'platform', 'timestamp'] } }),
    db.createIndex({ index: { fields: ['docType', 'contactId', 'timestamp'] } }),
    db.createIndex({ index: { fields: ['docType', 'threadId'] } }),
    db.createIndex({ index: { fields: ['docType', 'platform'] } }),
    db.createIndex({ index: { fields: ['docType', 'read', 'timestamp'] } }),
    db.createIndex({ index: { fields: ['docType', 'contactId'] } }),
    db.createIndex({ index: { fields: ['docType', 'dueAt'] } }),
    db.createIndex({ index: { fields: ['docType', 'status', 'scheduledAt'] } }),
  ]);
}

export async function getDB(name = 'aggregaytor'): Promise<PouchDB.Database> {
  if (_db) return _db;
  _db = new PouchDB(name, { auto_compaction: true });
  await ensureIndexes(_db);
  return _db;
}

export async function closeDB(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

export async function destroyDB(): Promise<void> {
  if (_db) {
    await _db.destroy();
    _db = null;
  }
}

/**
 * Create a DB instance with a custom adapter (e.g., memory for tests).
 */
export async function createDB(
  name: string,
  opts?: PouchDB.Configuration.DatabaseConfiguration,
): Promise<PouchDB.Database> {
  const db = new PouchDB(name, { auto_compaction: true, ...opts });
  await ensureIndexes(db);
  return db;
}
