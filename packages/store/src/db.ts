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
    // v0.57.79: global oldest-first scan support. Used by the auto-purge
    // job which sorts ALL messages by timestamp asc to find the oldest
    // ones to delete when IDB usage exceeds the threshold.
    db.createIndex({ index: { fields: ['docType', 'timestamp'] } }),
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
 * Release the singleton DB reference and schedule the underlying connection
 * close on a delay.
 *
 * v0.57.76 fix: the previous implementation called `_db.close()` synchronously
 * before returning, which closed the IDB connection out from under any handler
 * still mid-`db.find()` / `db.put()` — those threw "database is closed" the
 * next 100s of ms. The reminder-check alarm fires every 15s and was the most
 * common victim.
 *
 * New behaviour:
 *   1. Replace the singleton with null IMMEDIATELY so the next getDB() opens a
 *      fresh PouchDB instance. New handlers see the new connection.
 *   2. Schedule the actual `.close()` on the OLD instance for 30s later. By
 *      that time any in-flight read/write started before closeDB() was called
 *      has had time to finish; closing afterwards releases the LevelDB block
 *      cache as intended.
 *   3. If closeDB() is called again before the deferred close fires, cancel
 *      the prior timer and start fresh — we always close the most-recently-
 *      orphaned instance, never lose track.
 *   4. If destroyDB() runs in the meantime (legitimate reason to close
 *      synchronously), it cancels any pending deferred close.
 *
 * The 30s window matches the longest realistic handler duration. Operations
 * that take longer are already pathological (a heavy getThreadSummaries
 * scan); bumping to 60s costs little memory and prevents the regression.
 */
const DEFERRED_CLOSE_MS = 30_000;
let _deferredCloseTimer: ReturnType<typeof setTimeout> | null = null;
let _orphanedDb: PouchDB.Database | null = null;

export async function closeDB(): Promise<void> {
  if (!_db) return;
  // Cancel any prior deferred close. We only ever defer the latest orphan;
  // earlier orphans are picked up by the new timer on next fire.
  if (_deferredCloseTimer) {
    clearTimeout(_deferredCloseTimer);
    _deferredCloseTimer = null;
    // If we have an OLDER orphan still pending close, close it now —
    // otherwise it stays alive forever. (The new orphan replaces it as
    // the deferred-close target.)
    if (_orphanedDb) {
      try { await _orphanedDb.close(); } catch {}
      _orphanedDb = null;
    }
  }
  _orphanedDb = _db;
  _db = null;
  _deferredCloseTimer = setTimeout(async () => {
    _deferredCloseTimer = null;
    const toClose = _orphanedDb;
    _orphanedDb = null;
    if (toClose) {
      try { await toClose.close(); } catch {}
    }
  }, DEFERRED_CLOSE_MS);
}

/**
 * Permanently destroy the database and all its data, then clear the singleton.
 *
 * WARNING: This deletes everything in IndexedDB for this database name.
 * Used for "reset all data" in settings and in test teardown.
 *
 * v0.57.76: also flush any deferred-close orphan from closeDB() — destroying
 * the active db while an orphan still has the IDB connection open would
 * conflict (IDB blocks the destroy until the other connection closes).
 */
export async function destroyDB(): Promise<void> {
  if (_deferredCloseTimer) {
    clearTimeout(_deferredCloseTimer);
    _deferredCloseTimer = null;
  }
  if (_orphanedDb) {
    try { await _orphanedDb.close(); } catch {}
    _orphanedDb = null;
  }
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
