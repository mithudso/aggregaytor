/**
 * lru-idb-cache.ts — Two-tier mem + IndexedDB cache.
 *
 * v0.57.73. Replaces the bare-Map caches scattered around the codebase that
 * grow unbounded in JS heap. The pattern:
 *
 *   - Hot tier: a JS Map capped at `maxItems`. O(1) reads on hit.
 *   - Cold tier: a separate IndexedDB store. O(1)-keyed gets on miss; values
 *     promoted to mem on read.
 *   - Write-through on `set`: both tiers receive the value immediately so a
 *     SW restart finds the cache cold-warm in IDB.
 *   - LRU semantics: on every hit (mem OR cold), the entry is re-inserted
 *     at the end of the Map so it's the last thing evicted.
 *   - TTL is checked lazily on read.
 *
 * The cold tier is a SEPARATE IDB database from the main PouchDB store
 * (`aggregaytor-cache`) so heavy churn here doesn't fragment PouchDB's
 * own block layout. Each LruIdbCache instance gets its own object store
 * keyed by `storeName`.
 *
 * # Why not a 3rd-party library
 *
 * `lru-cache-idb` and `idb-lru-cache` exist on npm but bundling another
 * IDB wrapper adds 10–20 KB and locks us into their schema. This impl is
 * ~150 LOC, has no deps, and the schema is whatever shape the caller
 * passes in — perfect fit for our needs.
 *
 * # Usage
 *
 *   const cache = new LruIdbCache<MyValue>({
 *     storeName: 'llm-responses',
 *     maxItems: 100,
 *     ttlMs: 5 * 60_000,
 *   });
 *   await cache.set(key, value);
 *   const got = await cache.get(key);  // mem or cold
 *
 * # Tradeoffs
 *
 *   - All operations are async (IDB needs await even when the data is in
 *     mem, because the IDB write-through is part of the contract).
 *   - First-call latency is ~10–30 ms (open the DB + create object store).
 *   - Mem cap eviction does NOT delete from IDB — the cold tier grows to
 *     a separate `maxItemsTotal` cap (default 4× maxItems) before old
 *     entries get expired.
 */

const DB_NAME = 'aggregaytor-cache';
const DB_VERSION = 1;

export interface LruIdbCacheOptions {
  /** IndexedDB object store name. Each cache instance owns its own store. */
  storeName: string;
  /** Hot-tier (in-memory) entry cap. */
  maxItems: number;
  /** Cold-tier (IDB) entry cap. Defaults to maxItems × 4. */
  maxItemsTotal?: number;
  /** Optional TTL in ms; expired entries are dropped lazily on read. */
  ttlMs?: number;
  /** Optional db name; defaults to 'aggregaytor-cache'. */
  dbName?: string;
}

interface CacheEntry<V> {
  v: V;
  ts: number;
}

// We hold ONE shared IDB connection per dbName to avoid the "1+ connection"
// performance penalty when many cache instances are alive. Object-store
// creation requires a versionchange transaction, so we collect every
// known store on first open and create them all up-front.
const _dbConnections = new Map<string, Promise<IDBDatabase>>();
const _knownStores = new Map<string, Set<string>>();
// Opens are serialized per dbName. Two concurrent opens that each pick their
// own version number race each other: the lower-version request fails with
// VersionError, and its in-flight connection leaks and then blocks every
// later upgrade.
const _openChains = new Map<string, Promise<unknown>>();

function openIdb(dbName: string, version?: number, stores?: Set<string>): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      for (const name of stores || []) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'k' });
        }
      }
    };
    req.onsuccess = (): void => {
      const db = req.result;
      // Another context upgrading this database would be blocked by our open
      // handle; step aside so it can proceed and reopen lazily on next use.
      db.onversionchange = (): void => {
        db.close();
        _dbConnections.delete(dbName);
      };
      resolve(db);
    };
    req.onerror = (): void => reject(req.error);
    req.onblocked = (): void => reject(new Error('IDB upgrade blocked by another connection'));
  });
}

/**
 * Open `dbName` ensuring every store in `stores` exists.
 *
 * The version is derived from the database's ACTUAL current version rather
 * than from the number of stores this process happens to know about. A
 * service-worker restart that instantiates fewer caches than the previous run
 * created stores would otherwise request a LOWER version than the stored one,
 * which fails with VersionError and disables the cold tier for the session.
 */
async function openWithStores(dbName: string, stores: Set<string>): Promise<IDBDatabase> {
  const db = await openIdb(dbName);
  const missing = [...stores].some(name => !db.objectStoreNames.contains(name));
  if (!missing) return db;
  const nextVersion = db.version + 1;
  db.close();
  return openIdb(dbName, nextVersion, stores);
}

async function getCacheDb(dbName: string, storeName: string): Promise<IDBDatabase> {
  // Track every store we've ever wanted so the next upgrade creates them all.
  let stores = _knownStores.get(dbName);
  if (!stores) { stores = new Set(); _knownStores.set(dbName, stores); }
  stores.add(storeName);

  const knownStores = stores;
  const previous = _openChains.get(dbName) || Promise.resolve();
  const chained = previous.catch(() => { /* a failed open must not wedge the chain */ }).then(async () => {
    const existingP = _dbConnections.get(dbName);
    if (existingP) {
      try {
        const existing = await existingP;
        if (existing.objectStoreNames.contains(storeName)) return existing;
        // Needs an upgrade — release our handle first so it isn't blocked.
        existing.close();
      } catch { /* the previous open failed; fall through and retry */ }
      _dbConnections.delete(dbName);
    }
    const opened = await openWithStores(dbName, knownStores);
    _dbConnections.set(dbName, Promise.resolve(opened));
    return opened;
  });
  _openChains.set(dbName, chained.catch(() => { /* chain link only */ }));
  return chained;
}

export class LruIdbCache<V> {
  private mem = new Map<string, CacheEntry<V>>();
  private opts: Required<LruIdbCacheOptions>;
  // Pending writes coalesced into a single transaction. Keeps the
  // write-through cheap when callers do many sequential .set()s.
  private pendingWrites = new Map<string, CacheEntry<V>>();
  private writeFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolvers for every `set()` awaiting the next cold-tier flush. */
  private flushWaiters: Array<() => void> = [];

  constructor(opts: LruIdbCacheOptions) {
    // Defaults are applied AFTER the spread: spreading `opts` last would let an
    // explicitly-undefined option (e.g. `{ ttlMs: config.ttl }` where ttl is
    // undefined) overwrite the default with undefined.
    this.opts = {
      ...opts,
      maxItemsTotal: opts.maxItemsTotal ?? opts.maxItems * 4,
      ttlMs: opts.ttlMs ?? 0,
      dbName: opts.dbName ?? DB_NAME,
    };
  }

  private isExpired(ts: number): boolean {
    return this.opts.ttlMs > 0 && Date.now() - ts > this.opts.ttlMs;
  }

  private memSet(key: string, entry: CacheEntry<V>): void {
    // Insertion-order LRU: delete-then-set bumps the entry to the end of the
    // Map iteration order so it's the LAST thing evicted, not the first.
    this.mem.delete(key);
    this.mem.set(key, entry);
    // Evict oldest until under cap.
    while (this.mem.size > this.opts.maxItems) {
      const oldest = this.mem.keys().next();
      if (oldest.done) break;
      this.mem.delete(oldest.value);
    }
  }

  /**
   * Get a value from the cache. Returns undefined on miss or expired entry.
   * On mem hit: O(1). On cold hit: ~5–15ms IDB get + promotion to mem.
   */
  async get(key: string): Promise<V | undefined> {
    const m = this.mem.get(key);
    if (m) {
      if (this.isExpired(m.ts)) {
        this.mem.delete(key);
        // Don't await the cold delete; lazy clean-up.
        this.coldDelete(key).catch(() => {});
        return undefined;
      }
      // Bump LRU position.
      this.mem.delete(key);
      this.mem.set(key, m);
      return m.v;
    }
    // Cold tier
    const cold = await this.coldGet(key);
    if (!cold) return undefined;
    if (this.isExpired(cold.ts)) {
      await this.coldDelete(key);
      return undefined;
    }
    // Promote to mem.
    this.memSet(key, cold);
    return cold.v;
  }

  /**
   * Set a value. The mem write is immediate; the cold write joins a batch
   * flushed 50ms after the FIRST pending write.
   *
   * Every caller waiting on that batch is resolved when it lands. The timer is
   * deliberately not restarted by later `set()`s: rescheduling used to drop
   * the previous timer, stranding that caller's promise unresolved forever
   * (and letting a steady write stream postpone the flush indefinitely).
   */
  async set(key: string, value: V): Promise<void> {
    const entry: CacheEntry<V> = { v: value, ts: Date.now() };
    this.memSet(key, entry);
    this.pendingWrites.set(key, entry);
    return new Promise<void>((resolve) => {
      this.flushWaiters.push(resolve);
      if (!this.writeFlushTimer) {
        this.writeFlushTimer = setTimeout(() => { void this.flushPendingWrites(); }, 50);
      }
    });
  }

  /** Drain `pendingWrites` into the cold tier and release every waiter. */
  private async flushPendingWrites(): Promise<void> {
    if (this.writeFlushTimer) {
      clearTimeout(this.writeFlushTimer);
      this.writeFlushTimer = null;
    }
    const batch = Array.from(this.pendingWrites.entries());
    this.pendingWrites.clear();
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    try {
      await this.coldSetBatch(batch);
    } catch (err) {
      console.warn('[LruIdbCache] cold flush failed:', err);
    }
    for (const resolve of waiters) resolve();
  }

  async delete(key: string): Promise<void> {
    this.mem.delete(key);
    // Drop any queued write for this key, or the pending flush would
    // resurrect it in the cold tier straight after the delete.
    this.pendingWrites.delete(key);
    await this.coldDelete(key);
  }

  /** Drop every entry from BOTH tiers. */
  async clear(): Promise<void> {
    this.mem.clear();
    // Same hazard as delete(): a queued flush would write entries back after
    // the store was cleared.
    this.pendingWrites.clear();
    if (this.writeFlushTimer) {
      clearTimeout(this.writeFlushTimer);
      this.writeFlushTimer = null;
    }
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const resolve of waiters) resolve();
    await this.coldClear();
  }

  /** Drop only the in-memory tier; cold tier survives for the next read. */
  evictMemTier(): void {
    this.mem.clear();
  }

  /** Number of entries in the mem tier (does NOT count cold tier). */
  memSize(): number { return this.mem.size; }

  /** Number of entries in the cold tier (slow — issues a count query). */
  async coldSize(): Promise<number> {
    try {
      const db = await getCacheDb(this.opts.dbName, this.opts.storeName);
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(this.opts.storeName, 'readonly');
        const store = tx.objectStore(this.opts.storeName);
        const req = store.count();
        req.onsuccess = (): void => resolve(req.result);
        req.onerror = (): void => reject(req.error);
      });
    } catch { return 0; }
  }

  // ── Cold-tier helpers (IDB) ─────────────────────────────────────────────
  private async coldGet(key: string): Promise<CacheEntry<V> | null> {
    try {
      const db = await getCacheDb(this.opts.dbName, this.opts.storeName);
      return await new Promise<CacheEntry<V> | null>((resolve, reject) => {
        const tx = db.transaction(this.opts.storeName, 'readonly');
        const store = tx.objectStore(this.opts.storeName);
        const req = store.get(key);
        req.onsuccess = (): void => {
          const row: { k: string; entry: CacheEntry<V> } | undefined = req.result;
          resolve(row?.entry || null);
        };
        req.onerror = (): void => reject(req.error);
      });
    } catch (err) {
      console.warn('[LruIdbCache] coldGet failed:', err);
      return null;
    }
  }

  private async coldSetBatch(batch: [string, CacheEntry<V>][]): Promise<void> {
    if (!batch.length) return;
    const db = await getCacheDb(this.opts.dbName, this.opts.storeName);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.opts.storeName, 'readwrite');
      const store = tx.objectStore(this.opts.storeName);
      for (const [k, entry] of batch) {
        store.put({ k, entry });
      }
      tx.oncomplete = (): void => {
        // Cap-enforce after every batch. We intentionally do this OUTSIDE
        // the put transaction so the writes commit even if the trim work
        // hits a quota error.
        this.coldTrim().catch(() => {});
        resolve();
      };
      tx.onerror = (): void => reject(tx.error);
    });
  }

  private async coldDelete(key: string): Promise<void> {
    try {
      const db = await getCacheDb(this.opts.dbName, this.opts.storeName);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.opts.storeName, 'readwrite');
        const store = tx.objectStore(this.opts.storeName);
        store.delete(key);
        tx.oncomplete = (): void => resolve();
        tx.onerror = (): void => reject(tx.error);
      });
    } catch (err) {
      console.warn('[LruIdbCache] coldDelete failed:', err);
    }
  }

  private async coldClear(): Promise<void> {
    try {
      const db = await getCacheDb(this.opts.dbName, this.opts.storeName);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.opts.storeName, 'readwrite');
        const store = tx.objectStore(this.opts.storeName);
        store.clear();
        tx.oncomplete = (): void => resolve();
        tx.onerror = (): void => reject(tx.error);
      });
    } catch (err) {
      console.warn('[LruIdbCache] coldClear failed:', err);
    }
  }

  /** Trim cold tier to maxItemsTotal by deleting oldest-by-ts. */
  private async coldTrim(): Promise<void> {
    try {
      const db = await getCacheDb(this.opts.dbName, this.opts.storeName);
      const count = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(this.opts.storeName, 'readonly');
        const req = tx.objectStore(this.opts.storeName).count();
        req.onsuccess = (): void => resolve(req.result);
        req.onerror = (): void => reject(req.error);
      });
      if (count <= this.opts.maxItemsTotal) return;
      const dropTarget = count - this.opts.maxItemsTotal;
      // Read all rows, sort by ts asc, delete the oldest dropTarget. This
      // is O(N) but cap is small (default 4×maxItems = 400) so it's fine.
      const rows: { k: string; entry: CacheEntry<V> }[] = await new Promise((resolve, reject) => {
        const tx = db.transaction(this.opts.storeName, 'readonly');
        const req = tx.objectStore(this.opts.storeName).getAll();
        req.onsuccess = (): void => resolve(req.result || []);
        req.onerror = (): void => reject(req.error);
      });
      rows.sort((a, b) => a.entry.ts - b.entry.ts);
      const toDelete = rows.slice(0, dropTarget).map((r) => r.k);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.opts.storeName, 'readwrite');
        const store = tx.objectStore(this.opts.storeName);
        for (const k of toDelete) store.delete(k);
        tx.oncomplete = (): void => resolve();
        tx.onerror = (): void => reject(tx.error);
      });
    } catch (err) {
      console.warn('[LruIdbCache] coldTrim failed:', err);
    }
  }
}
