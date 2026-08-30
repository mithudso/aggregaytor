/**
 * db.ts — Dexie-backed store wrapper with a PouchDB-shaped compatibility API.
 *
 * The rest of the store code expects a handful of PouchDB-style methods
 * (`get`, `put`, `bulkDocs`, `allDocs`, `find`, `remove`, `info`, `compact`).
 * This module preserves that contract while moving the underlying storage to a
 * single IndexedDB database managed by Dexie.
 */

import Dexie from 'dexie';

declare const chrome: any;

export interface StoreDoc {
  _id: string;
  _rev?: string;
  _deleted?: boolean;
  docType?: string;
}

export interface StorePutResult {
  ok: true;
  id: string;
  rev: string;
}

export interface StoreInfo {
  db_name: string;
  doc_count: number;
  update_seq: number;
}

export interface StoreAllDocsOptions {
  include_docs?: boolean;
  keys?: string[];
  startkey?: string;
  endkey?: string;
  descending?: boolean;
  limit?: number;
}

export interface StoreAllDocsRow<T extends StoreDoc = StoreDoc> {
  id: string;
  key: string;
  value?: { rev?: string };
  doc?: T;
  error?: 'not_found';
}

export interface StoreAllDocsResult<T extends StoreDoc = StoreDoc> {
  rows: Array<StoreAllDocsRow<T>>;
  total_rows: number;
}

type SelectorOperatorValue = {
  $gt?: unknown;
  $gte?: unknown;
  $lt?: unknown;
  $lte?: unknown;
  $in?: unknown[];
  $ne?: unknown;
};

type SortDirection = 'asc' | 'desc';

export interface StoreFindRequest {
  selector: Record<string, unknown>;
  sort?: Array<Record<string, 'asc' | 'desc'>>;
  limit?: number;
  fields?: string[];
}

export interface StoreFindResult<T extends StoreDoc = StoreDoc> {
  docs: T[];
}

export interface StoreDatabase {
  get<T extends StoreDoc = StoreDoc>(id: string): Promise<T>;
  put<T extends StoreDoc = StoreDoc>(doc: T): Promise<StorePutResult>;
  bulkDocs<T extends StoreDoc = StoreDoc>(docs: T[]): Promise<StorePutResult[]>;
  allDocs<T extends StoreDoc = StoreDoc>(opts?: StoreAllDocsOptions): Promise<StoreAllDocsResult<T>>;
  find<T extends StoreDoc = StoreDoc>(request: StoreFindRequest): Promise<StoreFindResult<T>>;
  remove(doc: Pick<StoreDoc, '_id'>): Promise<StorePutResult>;
  compact(): Promise<void>;
  close(): Promise<void>;
  destroy(): Promise<void>;
  info(): Promise<StoreInfo>;
  createIndex(_spec: unknown): Promise<void>;
}

class AggregaytorDexie extends Dexie {
  declare docs: Dexie.Table<StoreDoc, string>;

  constructor(name: string) {
    super(name);
    // NOTE: IndexedDB has no boolean key type, so the `read`, `[docType+read]`
    // and `[docType+read+timestamp]` declarations below never index anything —
    // records with a boolean `read` are simply skipped by the indexer. Reads on
    // `read` therefore fall back to a `docType` scan + JS filter (see
    // `seedFindCandidates`). The declarations are kept because dropping them
    // requires a schema version bump (data migration); do not add new
    // boolean-keyed indexes.
    this.version(1).stores({
      docs: [
        '&_id',
        'docType',
        'platform',
        'threadId',
        'contactId',
        'timestamp',
        'read',
        'direction',
        'dueAt',
        'status',
        'scheduledAt',
        'tag',
        '[docType+platform]',
        '[docType+platform+timestamp]',
        '[docType+contactId]',
        '[docType+contactId+timestamp]',
        '[docType+timestamp]',
        '[docType+threadId]',
        '[docType+read]',
        '[docType+read+timestamp]',
        '[docType+status]',
        '[docType+status+scheduledAt]',
        '[docType+dueAt]',
      ].join(','),
    });
  }
}

function actualDbName(name: string): string {
  return name.endsWith('_dexie') ? name : `${name}_dexie`;
}

function nextRevision(previous?: string): string {
  const currentGeneration = previous ? parseInt(previous.split('-', 1)[0] || '0', 10) || 0 : 0;
  const token = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(16).slice(2);
  return `${currentGeneration + 1}-${token}`;
}

function notFound(id: string): Error & { status: number; reason: string } {
  const err = new Error(`missing: ${id}`) as Error & { status: number; reason: string };
  err.status = 404;
  err.reason = 'missing';
  return err;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function projectDoc<T extends StoreDoc>(doc: T, fields?: string[]): T {
  if (!fields?.length) return { ...doc };
  const projected: Record<string, unknown> = {};
  const record = doc as unknown as Record<string, unknown>;
  for (const field of new Set(['_id', ...fields])) {
    if (field in record) projected[field] = record[field];
  }
  return projected as T;
}

function matchesOperator(actual: unknown, operator: SelectorOperatorValue): boolean {
  if (operator.$gt !== undefined && compareValues(actual, operator.$gt) <= 0) return false;
  if (operator.$gte !== undefined && compareValues(actual, operator.$gte) < 0) return false;
  if (operator.$lt !== undefined && compareValues(actual, operator.$lt) >= 0) return false;
  if (operator.$lte !== undefined && compareValues(actual, operator.$lte) > 0) return false;
  if (operator.$ne !== undefined && actual === operator.$ne) return false;
  if (operator.$in && !operator.$in.includes(actual)) return false;
  return true;
}

function selectorMatches(doc: StoreDoc, selector: Record<string, unknown>): boolean {
  const record = doc as unknown as Record<string, unknown>;
  return Object.entries(selector).every(([field, expected]) => {
    const actual = record[field];
    if (
      expected &&
      typeof expected === 'object' &&
      !Array.isArray(expected) &&
      Object.keys(expected).some(key => key.startsWith('$'))
    ) {
      return matchesOperator(actual, expected as SelectorOperatorValue);
    }
    return actual === expected;
  });
}

function sortDocs<T extends StoreDoc>(docs: T[], sort?: Array<Record<string, 'asc' | 'desc'>>): T[] {
  if (!sort?.length) return docs;
  return [...docs].sort((left, right) => {
    const leftRecord = left as unknown as Record<string, unknown>;
    const rightRecord = right as unknown as Record<string, unknown>;
    for (const clause of sort) {
      const [field, direction] = Object.entries(clause)[0];
      const compared = compareValues(leftRecord[field], rightRecord[field]);
      if (compared !== 0) return direction === 'desc' ? -compared : compared;
    }
    return left._id.localeCompare(right._id);
  });
}

function getSortDirection(
  sort: Array<Record<string, SortDirection>> | undefined,
  field: string,
): SortDirection | null {
  if (!sort?.length) return null;
  for (const clause of sort) {
    const [clauseField, direction] = Object.entries(clause)[0];
    if (clauseField === field) return direction;
  }
  return null;
}

function getSelectorOperatorValue(
  selector: Record<string, unknown>,
  field: string,
): SelectorOperatorValue | null {
  const value = selector[field];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.keys(value).some(key => key.startsWith('$'))
  ) {
    return null;
  }
  return value as SelectorOperatorValue;
}

function getRangeBounds(operator: SelectorOperatorValue): {
  lower: unknown;
  upper: unknown;
  lowerOpen: boolean;
  upperOpen: boolean;
} {
  const lower = operator.$gt ?? operator.$gte ?? Dexie.minKey;
  const upper = operator.$lt ?? operator.$lte ?? Dexie.maxKey;
  return {
    lower,
    upper,
    lowerOpen: operator.$gt !== undefined,
    upperOpen: operator.$lt !== undefined,
  };
}

async function maybeReadMigrationFlag(key: string): Promise<boolean> {
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      const data = await chrome.storage.local.get(key);
      return !!data[key];
    }
  } catch {}
  return false;
}

async function maybeWriteMigrationFlag(key: string): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      await chrome.storage.local.set({ [key]: true });
    }
  } catch {}
}

/** Write the legacy corpus in slices so one huge IDB transaction isn't built. */
const LEGACY_MIGRATION_CHUNK = 500;

async function migrateLegacyPouchData(store: DexieStoreDatabase, legacyName: string): Promise<void> {
  const migrationKey = `${actualDbName(legacyName)}_legacy_migrated`;
  if (await maybeReadMigrationFlag(migrationKey)) return;
  if (await store.docCount() > 0) {
    await maybeWriteMigrationFlag(migrationKey);
    return;
  }

  // Only mark the migration done when the copy actually succeeded. Writing the
  // flag after a failed copy would orphan the user's entire pre-Dexie history
  // (the flag makes every later getDB() skip the migration).
  let copied = true;
  try {
    const pouchModule = await import('pouchdb-browser');
    const PouchDB = pouchModule.default;
    const legacyDb = new PouchDB(legacyName);
    const result = await legacyDb.allDocs({ include_docs: true });
    const docs = result.rows
      .filter((row: { doc?: StoreDoc; id: string }) => row.doc && !row.id.startsWith('_design/'))
      .map((row: { doc: StoreDoc }) => {
        const doc = { ...row.doc };
        delete doc._rev;
        return doc;
      });
    try {
      for (let i = 0; i < docs.length; i += LEGACY_MIGRATION_CHUNK) {
        await store.bulkDocs(docs.slice(i, i + LEGACY_MIGRATION_CHUNK));
      }
    } catch (err) {
      copied = false;
      console.warn('[Aggregaytor:Store] legacy migration write failed; will retry on next open:', err);
    }
    try { await legacyDb.close(); } catch {}
  } catch {
    // Fresh installs won't have a legacy PouchDB database (or the module).
  }

  if (copied) await maybeWriteMigrationFlag(migrationKey);
}

class DexieStoreDatabase implements StoreDatabase {
  private readonly db: AggregaytorDexie;
  private readonly logicalName: string;
  private updateSeq = 0;

  constructor(logicalName: string) {
    this.logicalName = logicalName;
    this.db = new AggregaytorDexie(actualDbName(logicalName));
  }

  async docCount(): Promise<number> {
    return this.db.docs.count();
  }

  async get<T extends StoreDoc = StoreDoc>(id: string): Promise<T> {
    const doc = await this.db.docs.get(id);
    if (!doc) throw notFound(id);
    return { ...doc } as T;
  }

  async put<T extends StoreDoc = StoreDoc>(doc: T): Promise<StorePutResult> {
    const [result] = await this.bulkDocs([doc]);
    return result;
  }

  /**
   * Write a batch of documents.
   *
   * One batched read plus at most two batched writes, regardless of batch size
   * — the read happens inside the transaction so the read-modify-write stays
   * atomic against a concurrent `bulkDocs` touching the same ids.
   *
   * Merge semantics deliberately differ from PouchDB: a stored doc is merged
   * (`{ ...existing, ...incoming }`) rather than replaced, so fields omitted by
   * the caller survive. Callers that need a field removed must write an
   * explicit empty/null value.
   */
  async bulkDocs<T extends StoreDoc = StoreDoc>(docs: T[]): Promise<StorePutResult[]> {
    if (!docs.length) return [];
    let results: StorePutResult[] = [];
    await this.db.transaction('rw', this.db.docs, async () => {
      const uniqueIds = [...new Set(docs.map(doc => doc._id))];
      const fetched = await this.db.docs.bulkGet(uniqueIds);
      // Tracks the in-transaction state of each id so repeated ids inside one
      // batch chain onto each other exactly like the old per-doc loop did.
      const current = new Map<string, StoreDoc | undefined>();
      uniqueIds.forEach((id, index) => current.set(id, fetched[index] || undefined));

      const puts = new Map<string, StoreDoc>();
      const deletes = new Set<string>();
      const batchResults: StorePutResult[] = [];

      for (const incoming of docs) {
        const existing = current.get(incoming._id);
        const rev = nextRevision(existing?._rev);
        if (incoming._deleted) {
          current.set(incoming._id, undefined);
          puts.delete(incoming._id);
          deletes.add(incoming._id);
        } else {
          const merged: StoreDoc = { ...(existing || {}), ...incoming, _rev: rev };
          current.set(incoming._id, merged);
          deletes.delete(incoming._id);
          puts.set(incoming._id, merged);
        }
        batchResults.push({ ok: true, id: incoming._id, rev });
      }

      if (deletes.size) await this.db.docs.bulkDelete([...deletes]);
      if (puts.size) await this.db.docs.bulkPut([...puts.values()]);
      results = batchResults;
    });
    this.updateSeq += results.length;
    return results;
  }

  async allDocs<T extends StoreDoc = StoreDoc>(opts: StoreAllDocsOptions = {}): Promise<StoreAllDocsResult<T>> {
    const totalRows = await this.db.docs.count();
    const includeDocs = !!opts.include_docs;

    if (opts.keys?.length) {
      const docs = await this.db.docs.bulkGet(opts.keys);
      return {
        total_rows: totalRows,
        rows: opts.keys.map((key, index) => {
          const doc = docs[index];
          if (!doc) return { id: key, key, error: 'not_found' as const };
          return {
            id: key,
            key,
            value: { rev: doc._rev },
            ...(includeDocs ? { doc: { ...doc } as T } : {}),
          };
        }),
      };
    }

    let collection: Dexie.Collection<StoreDoc, string>;
    if (opts.startkey !== undefined || opts.endkey !== undefined) {
      collection = this.db.docs.where(':id').between(
        opts.startkey ?? Dexie.minKey,
        opts.endkey ?? Dexie.maxKey,
        true,
        true,
      );
    } else {
      collection = this.db.docs.orderBy(':id');
    }

    let query = opts.descending ? collection.reverse() : collection;
    // Push the limit into IndexedDB instead of materialising every row first.
    if (opts.limit) query = query.limit(opts.limit);
    const rows = await query.toArray();
    return {
      total_rows: totalRows,
      rows: rows.map((doc: StoreDoc) => ({
        id: doc._id,
        key: doc._id,
        value: { rev: doc._rev },
        ...(includeDocs ? { doc: { ...doc } as T } : {}),
      })),
    };
  }

  private async findFastPath(request: StoreFindRequest): Promise<StoreDoc[] | null> {
    const selector = request.selector;
    const docType = typeof selector.docType === 'string' ? selector.docType : undefined;
    if (!docType) return null;

    const timestampDirection = getSortDirection(request.sort, 'timestamp');
    const scheduledAtDirection = getSortDirection(request.sort, 'scheduledAt');
    const platform = typeof selector.platform === 'string' ? selector.platform : undefined;
    const contactId = typeof selector.contactId === 'string' ? selector.contactId : undefined;
    const status = typeof selector.status === 'string' ? selector.status : undefined;
    const timestampRange = getSelectorOperatorValue(selector, 'timestamp');
    const scheduledAtRange = getSelectorOperatorValue(selector, 'scheduledAt');

    // A fast-path index only encodes *some* of the selector's fields; `find()`
    // still filters the rows it returns. Pushing `limit` down to IndexedDB is
    // therefore only safe when the index covers every selector field —
    // otherwise the limit truncates the candidate set BEFORE that filter runs
    // and the query silently under-returns.
    const selectorFields = Object.keys(selector);
    const pushDownLimit = (covered: string[]): number | undefined =>
      selectorFields.every(field => covered.includes(field)) ? request.limit : undefined;

    const materialize = (
      collection: Dexie.Collection<StoreDoc, string>,
      descending: boolean,
      covered: string[],
    ): Promise<StoreDoc[]> => {
      const ordered = descending ? collection.reverse() : collection;
      const max = pushDownLimit(covered);
      return max ? ordered.limit(max).toArray() : ordered.toArray();
    };

    if (platform && timestampDirection) {
      const range = getRangeBounds(timestampRange || {});
      const collection = this.db.docs.where('[docType+platform+timestamp]').between(
        [docType, platform, range.lower],
        [docType, platform, range.upper],
        !range.lowerOpen,
        !range.upperOpen,
      );
      return materialize(collection, timestampDirection === 'desc', ['docType', 'platform', 'timestamp']);
    }

    if (contactId && timestampDirection) {
      const range = getRangeBounds(timestampRange || {});
      const collection = this.db.docs.where('[docType+contactId+timestamp]').between(
        [docType, contactId, range.lower],
        [docType, contactId, range.upper],
        !range.lowerOpen,
        !range.upperOpen,
      );
      return materialize(collection, timestampDirection === 'desc', ['docType', 'contactId', 'timestamp']);
    }

    if (status && scheduledAtDirection) {
      const range = getRangeBounds(scheduledAtRange || {});
      const collection = this.db.docs.where('[docType+status+scheduledAt]').between(
        [docType, status, range.lower],
        [docType, status, range.upper],
        !range.lowerOpen,
        !range.upperOpen,
      );
      return materialize(collection, scheduledAtDirection === 'desc', ['docType', 'status', 'scheduledAt']);
    }

    if (timestampDirection) {
      const range = getRangeBounds(timestampRange || {});
      const collection = this.db.docs.where('[docType+timestamp]').between(
        [docType, range.lower],
        [docType, range.upper],
        !range.lowerOpen,
        !range.upperOpen,
      );
      return materialize(collection, timestampDirection === 'desc', ['docType', 'timestamp']);
    }

    return null;
  }

  private async seedFindCandidates(selector: Record<string, unknown>): Promise<StoreDoc[]> {
    const docType = typeof selector.docType === 'string' ? selector.docType : undefined;
    const platform = typeof selector.platform === 'string' ? selector.platform : undefined;
    const contactId = typeof selector.contactId === 'string' ? selector.contactId : undefined;
    const threadId = typeof selector.threadId === 'string' ? selector.threadId : undefined;
    const status = typeof selector.status === 'string' ? selector.status : undefined;
    const read = typeof selector.read === 'boolean' ? selector.read : undefined;
    if (docType && contactId) return this.db.docs.where('[docType+contactId]').equals([docType, contactId]).toArray();
    if (docType && threadId) return this.db.docs.where('[docType+threadId]').equals([docType, threadId]).toArray();
    if (docType && status) return this.db.docs.where('[docType+status]').equals([docType, status]).toArray();
    if (docType && read !== undefined) {
      return this.db.docs
        .where('docType')
        .equals(docType)
        .filter(doc => 'read' in doc && doc.read === read)
        .toArray();
    }
    if (docType && platform) return this.db.docs.where('[docType+platform]').equals([docType, platform]).toArray();
    if (docType) return this.db.docs.where('docType').equals(docType).toArray();
    return this.db.docs.toArray();
  }

  async find<T extends StoreDoc = StoreDoc>(request: StoreFindRequest): Promise<StoreFindResult<T>> {
    const seeded = await this.findFastPath(request) ?? await this.seedFindCandidates(request.selector);
    let docs = seeded.filter(doc => selectorMatches(doc, request.selector));
    docs = sortDocs(docs, request.sort);
    if (request.limit) docs = docs.slice(0, request.limit);
    return {
      docs: docs.map(doc => projectDoc({ ...doc } as T, request.fields)),
    };
  }

  async remove(doc: Pick<StoreDoc, '_id'>): Promise<StorePutResult> {
    const existing = await this.db.docs.get(doc._id);
    if (!existing) throw notFound(doc._id);
    const rev = nextRevision(existing._rev);
    await this.db.docs.delete(doc._id);
    this.updateSeq++;
    return { ok: true, id: doc._id, rev };
  }

  async compact(): Promise<void> {}

  async close(): Promise<void> {
    this.db.close();
  }

  async destroy(): Promise<void> {
    await this.db.delete();
  }

  async info(): Promise<StoreInfo> {
    return {
      db_name: this.logicalName,
      doc_count: await this.db.docs.count(),
      update_seq: this.updateSeq,
    };
  }

  async createIndex(_spec: unknown): Promise<void> {}
}

let _db: StoreDatabase | null = null;

const DEFERRED_CLOSE_MS = 30_000;
let _deferredCloseTimer: ReturnType<typeof setTimeout> | null = null;
let _orphanedDb: StoreDatabase | null = null;

async function ensureIndexes(_db: StoreDatabase): Promise<void> {}

export async function getDB(name = 'aggregaytor'): Promise<StoreDatabase> {
  if (_db) return _db;
  const db = new DexieStoreDatabase(name);
  await ensureIndexes(db);
  await migrateLegacyPouchData(db, name);
  _db = db;
  return _db;
}

export async function closeDB(): Promise<void> {
  if (!_db) return;
  if (_deferredCloseTimer) {
    clearTimeout(_deferredCloseTimer);
    _deferredCloseTimer = null;
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

export async function destroyDB(name = 'aggregaytor'): Promise<void> {
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
    return;
  }
  await new AggregaytorDexie(actualDbName(name)).delete();
}

export async function createDB(
  name: string,
  _opts?: Record<string, unknown>,
): Promise<StoreDatabase> {
  const db = new DexieStoreDatabase(name);
  await ensureIndexes(db);
  return db;
}
