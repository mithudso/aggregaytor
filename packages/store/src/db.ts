/**
 * db.ts — PouchDB wrapper with singleton connection and index management.
 *
 * The store uses PouchDB (IndexedDB in the browser) as a local-first database.
 * All document types live in a single database, discriminated by `docType`.
 * Compound indexes on (docType + other fields) enable the Mango queries used
 * throughout the CRUD modules (messages.ts, contacts.ts, threads.ts, etc.).
 *
 * The singleton pattern (`_db`) ensures only one connection is open at a time,
 * and `auto_compaction: true` keeps the database size manageable by compacting
 * old revisions on every write.
 */

import PouchDB from 'pouchdb-browser';
import PouchDBFind from 'pouchdb-find';

// Register the pouchdb-find plugin so we can use db.createIndex() and db.find()
PouchDB.plugin(PouchDBFind);

/** Module-level singleton -- null until getDB() is called the first time. */
let _db: PouchDB.Database | null = null;

/**
 * Create all compound indexes needed for efficient Mango queries.
 *
 * PouchDB/CouchDB indexes are idempotent -- calling createIndex for an index
 * that already exists is a no-op, so this is safe to run on every startup.
 *
 * Index purposes:
 *   (docType, platform, timestamp)    -- getRecentMessages filtered by platform
 *   (docType, contactId, timestamp)   -- getMessagesByContact sorted by time
 *   (docType, threadId)               -- getMessagesByThread
 *   (docType, platform)               -- getContactsByPlatform
 *   (docType, read, timestamp)        -- getUnreadCount, unread queries
 *   (docType, contactId)              -- general contact-scoped queries
 *   (docType, dueAt)                  -- reminder queries sorted by due date
 *   (docType, status, scheduledAt)    -- auto-respond job queue ordering
 */
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

/**
 * Get (or create) the singleton PouchDB instance.
 *
 * On first call, opens the database, creates indexes, and caches the instance.
 * Subsequent calls return the cached instance immediately.
 *
 * @param name  Database name in IndexedDB. Defaults to 'aggregaytor'.
 * @returns     The ready-to-use PouchDB instance with all indexes in place.
 */
export async function getDB(name = 'aggregaytor'): Promise<PouchDB.Database> {
  if (_db) return _db;
  // v0.57.72: revs_limit=5 (default 1000) caps the per-doc revision history
  // PouchDB keeps in IndexedDB. Per pouchdb/pouchdb#4372, revs_limit hides
  // but doesn't delete revs — the actual delete happens on compact() —
  // but a tighter limit means each future compaction has less to chew
  // through and steady-state IDB size stays smaller. With auto_compaction
  // already on, this halves the rev tree footprint over a multi-month
  // database. Older databases get the benefit on the next compact().
  _db = new PouchDB(name, { auto_compaction: true, revs_limit: 5 });
  await ensureIndexes(_db);
  return _db;
}

/**
 * Gracefully close the database connection and clear the singleton.
 * Safe to call even if no DB is open (no-op in that case).
 */
export async function closeDB(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

/**
 * Permanently destroy the database and all its data, then clear the singleton.
 *
 * WARNING: This deletes everything in IndexedDB for this database name.
 * Used for "reset all data" in settings and in test teardown.
 */
export async function destroyDB(): Promise<void> {
  if (_db) {
    await _db.destroy();
    _db = null;
  }
}

/**
 * Create a standalone DB instance with a custom adapter. Does NOT use or
 * affect the module singleton. Primarily used in tests with the in-memory
 * adapter so each test gets an isolated database.
 *
 * @param name  Database name.
 * @param opts  PouchDB configuration (e.g. `{ adapter: 'memory' }`).
 * @returns     A fresh PouchDB instance with all indexes created.
 */
export async function createDB(
  name: string,
  opts?: PouchDB.Configuration.DatabaseConfiguration,
): Promise<PouchDB.Database> {
  const db = new PouchDB(name, { auto_compaction: true, ...opts });
  await ensureIndexes(db);
  return db;
}
