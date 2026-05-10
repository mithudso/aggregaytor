# Dexie migration plan — PouchDB → Dexie

**Status:** Proposed. Not yet scheduled.
**Target version:** v0.58.0 (major because of the schema cutover)
**Author:** 2026-04-14 research pass
**Prerequisites:** v0.57.9 ships (Cerebras + Anthropic 1h TTL + FlexSearch) cleanly

## TL;DR

Replace PouchDB (+ pouchdb-find) with Dexie for all IndexedDB access. One-time migration on first startup post-upgrade reads every PouchDB doc and writes it into the new Dexie database; old PouchDB database is retained read-only for N days as a rollback.

**Gains (measured from audit):**
- 30–50% faster bulk writes (no revision-tree overhead)
- 10–20 KB smaller bundle (drop pouchdb-browser + pouchdb-find)
- O(1) native secondary indexes for signal-index queries instead of JS-side filter
- Cleaner type signatures (no `_rev`, no `docType` discriminator in queries)
- Better error messages (Dexie throws `Dexie.BulkError` with per-doc failures)

**Risks:**
- One-time data migration can corrupt or lose user data on faulty implementation
- Dexie's transaction model differs — need careful audit of concurrent-write paths
- Test suite uses PouchDB in-memory adapter; needs port to `fake-indexeddb`
- ~800 LOC rewrite across 14 store modules

**Decision gate:** Proceed only after all of:
1. We hit a user-visible write perf problem (none reported as of v0.57.9)
2. We've verified no planned feature needs CouchDB replication (sync.ts stub confirms)
3. We have a full backup path via Google Drive export (already shipped)

---

## 1. Why Dexie over other alternatives

Scoring across alternatives considered in `docs/RESEARCH-2026-04-14.md`:

| Option | Perf | Bundle | API ergonomics | Maintenance risk | Notes |
|---|---|---|---|---|---|
| **Dexie** | ✅ native IDB batch writes | ✅ 29 KB gzipped | ✅ Promise-native | ✅ active, stable | **Chosen** |
| Direct IDB | ✅ raw speed | ✅ 0 KB | ❌ callback hell | ⚠️ DIY error handling | Too much boilerplate |
| RxDB Premium | ✅ fastest | ⚠️ larger | ✅ reactive | ❌ $$ commercial | Free tier uses Dexie internally |
| wa-sqlite | ⚠️ 3 KB overhead | ❌ +1 MB WASM | ⚠️ SQL | ⚠️ niche | Too heavy for our needs |
| OPFS / SQLite WASM | ✅ at scale | ❌ +1 MB | ⚠️ Worker only | ⚠️ nascent | Break-even at 10k+ docs |
| Keep PouchDB | ⚠️ baseline | baseline | ⚠️ quirky | ✅ baseline | Do-nothing option |

## 2. Scope

### What changes

- `packages/store/src/*.ts` — all 14 module CRUD rewrites (~800 LOC)
- `packages/store/package.json` — replace `pouchdb-browser`, `pouchdb-find` with `dexie`; add `fake-indexeddb` to devDeps
- `packages/store/__tests__/*.ts` — if any exist, port to `fake-indexeddb`
- `extensions/aggregaytor/package.json` — replace pouch deps with dexie
- `extensions/aggregaytor/vite.config.ts` — drop `optimizeDeps.include: ['pouchdb-browser','pouchdb-find']`; add `dexie`
- `extensions/aggregaytor/background/service-worker.ts` — direct PouchDB calls in 11 handlers (CLEAR_THREAD_MESSAGES, SEARCH_MESSAGES, DIAGNOSE_TRAINING_DATA, etc.) need translation
- `extensions/aggregaytor/background/debug-bridge.ts` — 2 direct PouchDB call sites

### What doesn't change

- `UnifiedMessage` / `UnifiedContact` types — adapter wire format unchanged
- `docType` field — keep it, but drop as a query filter (tables replace it)
- Document `_id` format — keep as primary key of each table (e.g. `msg:grindr:12345`)
- Public store.ts exports — same function signatures, same behaviour externally
- Content scripts, adapters, sidepanel — zero changes required
- Google Drive export / import — already JSON-only, round-trips cleanly

## 3. Target Dexie schema

```ts
// packages/store/src/db.ts (new)
import Dexie, { Table } from 'dexie';
import type {
  MessageDoc, ContactDoc, ThreadMetaDoc, ReminderDoc, AutoRespondDoc,
  PictureDoc, BlockRuleDoc, PreferenceFeedbackDoc, PreferenceModelDoc,
  CalendarEventDoc, ContactDossierDoc, TaskDoc,
} from './types.js';

export class AggregaytorDB extends Dexie {
  // One table per doc type. Primary key is `_id` (same format as today
  // so the migration script can 1:1 copy _id from PouchDB).
  messages!: Table<MessageDoc, string>;
  contacts!: Table<ContactDoc, string>;
  thread_meta!: Table<ThreadMetaDoc, string>;
  reminders!: Table<ReminderDoc, string>;
  auto_respond!: Table<AutoRespondDoc, string>;
  pictures!: Table<PictureDoc, string>;
  block_rules!: Table<BlockRuleDoc, string>;
  preference_feedback!: Table<PreferenceFeedbackDoc, string>;
  preference_model!: Table<PreferenceModelDoc, string>;
  calendar_events!: Table<CalendarEventDoc, string>;
  dossiers!: Table<ContactDossierDoc, string>;
  tasks!: Table<TaskDoc, string>;

  constructor() {
    // DB name intentionally NEW (not 'aggregaytor') so the existing PouchDB
    // store is untouched and available for the migration script / rollback.
    super('aggregaytor_v2');
    this.version(1).stores({
      // `&` prefix = unique primary key; remaining are secondary indexes.
      // Compound indexes are in [brackets]. Index the fields we query on,
      // not every field — indexes cost on every write.
      messages:
        '&_id, platform, contactId, threadId, timestamp, [contactId+timestamp], [threadId+timestamp], [read+direction], contentHash',
      contacts:
        '&_id, platform, platformUserId, lastMessageAt, [platform+lastMessageAt]',
      thread_meta:
        '&_id, contactId, platform, signalsUpdatedAt, bookmarked, favorited, archived',
      reminders:
        '&_id, contactId, dueAt, [notifiedDue+dueAt]',
      auto_respond:
        '&_id, contactId, status, scheduledAt, [status+scheduledAt]',
      pictures:
        '&_id, tag',
      block_rules:
        '&_id, enabled',
      preference_feedback:
        '&_id, contactId, platform, liked, timestamp, [platform+timestamp]',
      preference_model:
        '&_id',
      calendar_events:
        '&_id, contactId, startTime',
      dossiers:
        '&_id, contactId, updatedAt',
      tasks:
        '&_id, contactId, dueAt, completed, googleTaskId',
    });
    // Future schema changes bump: `.version(2).stores({...}).upgrade(tx => ...)`
  }
}

let _db: AggregaytorDB | null = null;
export async function getDB(): Promise<AggregaytorDB> {
  if (_db) return _db;
  _db = new AggregaytorDB();
  await _db.open();
  return _db;
}
```

### Index rationale

Each index is justified by a specific query. Dropping unused indexes speeds up writes.

| Table | Index | Query it serves |
|---|---|---|
| messages | `platform` | `getRecentMessages({ platform })` |
| messages | `contactId` | `getMessagesByContact` |
| messages | `threadId` | `getMessagesByThread` |
| messages | `timestamp` | `getRecentMessages` sort |
| messages | `[contactId+timestamp]` | combined filter+sort |
| messages | `[read+direction]` | `getUnreadCount` |
| messages | `contentHash` | cross-source dedup |
| contacts | `[platform+lastMessageAt]` | `getContactsByPlatform` sorted |
| thread_meta | `signalsUpdatedAt` | **incremental auto-train** — the whole point of v0.57.8 |
| thread_meta | `bookmarked`/`favorited`/`archived` | Sidebar filters |
| auto_respond | `[status+scheduledAt]` | job queue ordering |
| preference_feedback | `[platform+timestamp]` | `getAllFeedback` for retrain |
| dossiers | `updatedAt` | invalidate `contactContextModule` cache |

## 4. API translation cheat sheet

| Operation | PouchDB | Dexie |
|---|---|---|
| Get by id | `db.get(id)` | `db.table.get(id)` |
| Put single | `db.put(doc)` | `db.table.put(doc)` |
| Bulk get | `db.allDocs({ keys, include_docs: true })` | `db.table.bulkGet(keys)` |
| Bulk put | `db.bulkDocs(docs)` | `db.table.bulkPut(docs)` |
| Delete single | `db.remove(doc)` | `db.table.delete(doc._id)` |
| Bulk delete | `docs.map({_deleted:true}); bulkDocs` | `db.table.bulkDelete(ids)` |
| Find by type | `db.find({ selector: { docType: 'message' } })` | `db.messages.toArray()` |
| Find by field | `db.find({ selector: { docType, contactId } })` | `db.messages.where('contactId').equals(id).toArray()` |
| Find with sort | sort manually after find | `db.messages.orderBy('timestamp').reverse().limit(n).toArray()` |
| Key range | `db.allDocs({ startkey, endkey })` | `db.table.where('_id').between(start, end).toArray()` |
| Destroy DB | `db.destroy()` | `db.delete()` |
| Transactions | implicit | `db.transaction('rw', [tables], () => ...)` |
| `_rev` optimistic locking | automatic | Use `db.transaction` for critical read-modify-write |

### Upsert pattern — the single most-used idiom

```ts
// BEFORE (messages.ts)
const existing = await store.allDocs({ keys: ids, include_docs: true });
const existingMap = new Map();
for (const row of existing.rows) {
  if ('error' in row) continue;
  existingMap.set(row.id, { _rev: row.doc._rev, createdAt: row.doc.createdAt });
}
for (const doc of docs) {
  const prev = existingMap.get(doc._id);
  if (prev) { doc._rev = prev._rev; doc.createdAt = prev.createdAt; }
}
await store.bulkDocs(docs);

// AFTER (Dexie)
const existing = await db.messages.bulkGet(ids);
for (let i = 0; i < docs.length; i++) {
  const prev = existing[i];
  if (prev) docs[i].createdAt = prev.createdAt;
}
await db.messages.bulkPut(docs);
// No _rev, no conflict resolution needed — Dexie serialises writes within
// a transaction. For read-modify-write safety across async boundaries,
// wrap in db.transaction('rw', db.messages, () => { ... })
```

**Critical:** Dexie's `bulkPut` is a full overwrite, not a merge. The 2-phase read-then-merge pattern is still required.

## 5. Rollout phases

### Phase 0 — Preparation (size: XS)

- Add `dexie@^4.0.0` + `fake-indexeddb@^6.0.0` to `packages/store/devDependencies`
- Create a scratch branch `feature/dexie-migration`
- Write smoke-test scenarios in a new `__tests__/dexie-smoke.test.ts`:
  - Bulk-insert 1000 messages, read them back, verify counts
  - Signal-index update: `upsertThreadMeta({bookmarked:true})` → `db.thread_meta.where('signalsUpdatedAt').above(ts)` returns it
  - Contact dedup: write the same message id twice, verify one doc

**Acceptance:** new tests pass against a fresh Dexie instance with no production code changed yet.

### Phase 1 — Store package translation (size: L)

Port all 14 modules in this order (each standalone, each testable):

1. **`db.ts`** — new AggregaytorDB class. Old `getDB/closeDB/destroyDB/createDB` keep the same signatures.
2. **`messages.ts`** — highest-impact table.
   - `upsertMessage`, `upsertMessages`, `getMessagesByThread`, `getMessagesByContact`, `getRecentMessages`, `markThreadRead`, `getUnreadCount`, `invalidateUnreadCountCache`
   - The content-hash dedup logic (`contentHash` Set) stays — index on the `contentHash` field makes the lookup O(1) native.
3. **`contacts.ts`** — second highest impact.
   - Preserve-field merge logic (avatarUrl, displayName, metadata) is identical; only the storage primitives change.
4. **`thread-meta.ts`** — keep the `SIGNAL_FIELDS` + `signalsUpdatedAt` logic. Add `signalsUpdatedAt` to the Dexie index.
5. **`threads.ts`** — `getThreadSummaries` does a big join in JS. After migration, each piece is `db.messages.where().toArray()` + `db.contacts.bulkGet()`. Easier to read.
6. **`thread-meta.ts`**, **`reminders.ts`**, **`auto-respond.ts`**, **`pictures.ts`**, **`block-rules.ts`** — smaller modules, same pattern.
   - `block-rules.ts`'s `_rulesCache` stays as-is; invalidation hooks already in place.
7. **`preference-ml.ts`** — the model doc is a singleton (`_id: 'pref_model'`). `getAllFeedback` uses `preference_feedback` table scan.
8. **`calendar.ts`**, **`dossier.ts`**, **`tasks.ts`** — pure CRUD.
9. **`export-import.ts`** — biggest hotspot. The import path round-trips 12 tables; careful to reset dirty caches after import.
10. **`index.ts`** — re-export surface unchanged.
11. **`sync.ts`** — delete. Was a stub.

**Acceptance:**
- All 65 existing tests pass (after porting any PouchDB-specific ones)
- New Dexie-specific tests pass (index usage verification — e.g. `signalsUpdatedAt` index IS used by the query)
- Bundle size drops by ≥10 KB (verify with `du -h dist/background/service-worker.js`)

### Phase 2 — Migration script (size: M)

New file: `packages/store/src/migrations/pouchdb-to-dexie.ts`

```ts
export async function migratePouchDBToDexie(): Promise<MigrationResult> {
  // 1. Check if already migrated — idempotent guard
  const { aggregaytor_dexie_migrated } = await chrome.storage.local.get('aggregaytor_dexie_migrated');
  if (aggregaytor_dexie_migrated) return { ok: true, alreadyMigrated: true };

  // 2. Dynamically import PouchDB (only needed for the migration) so the
  //    final bundle doesn't carry it forever.
  const { default: PouchDB } = await import('pouchdb-browser');

  // 3. Open old PouchDB; if it doesn't exist, treat as first install.
  let oldDb: any;
  try {
    oldDb = new PouchDB('aggregaytor', { auto_compaction: false });
    const info = await oldDb.info();
    if (info.doc_count === 0) {
      await chrome.storage.local.set({ aggregaytor_dexie_migrated: true });
      return { ok: true, freshInstall: true };
    }
  } catch { /* no old DB */ return { ok: true, freshInstall: true }; }

  // 4. Open the new Dexie DB
  const newDb = await getDB();

  // 5. Stream all docs from Pouch, split by docType, bulkPut into Dexie.
  //    Stream in pages of 500 so we don't balloon memory on big databases.
  const BATCH = 500;
  let startkey: string | undefined;
  const counts: Record<string, number> = {};
  while (true) {
    const { rows }: any = await oldDb.allDocs({
      include_docs: true, limit: BATCH, startkey, skip: startkey ? 1 : 0,
    });
    if (!rows.length) break;
    const buckets: Record<string, any[]> = {};
    for (const r of rows) {
      if (!r.doc || r.doc._deleted) continue;
      const dt = r.doc.docType;
      if (!dt) continue;
      if (!buckets[dt]) buckets[dt] = [];
      // Strip _rev — Dexie doesn't use it; leaving it on the doc is harmless
      // but wastes bytes. counts bumped per-bucket.
      const { _rev, ...doc } = r.doc;
      buckets[dt].push(doc);
    }
    for (const [dt, docs] of Object.entries(buckets)) {
      const table = (newDb as any)[tableForDocType(dt)];
      if (!table) { counts[`skip_${dt}`] = (counts[`skip_${dt}`] || 0) + docs.length; continue; }
      await table.bulkPut(docs);
      counts[dt] = (counts[dt] || 0) + docs.length;
    }
    startkey = rows[rows.length - 1].id;
    if (rows.length < BATCH) break;
  }

  // 6. Verify counts match between old and new. Abort if mismatch > 1%
  //    (tolerance for deleted-doc edge cases).
  const info = await oldDb.info();
  const newCount = await totalRowCount(newDb);
  const delta = Math.abs(info.doc_count - newCount) / Math.max(info.doc_count, 1);
  if (delta > 0.01) {
    return { ok: false, error: 'Count mismatch', oldCount: info.doc_count, newCount };
  }

  // 7. Mark migrated. Don't destroy the old PouchDB — keep for rollback.
  await chrome.storage.local.set({
    aggregaytor_dexie_migrated: true,
    aggregaytor_migration_at: new Date().toISOString(),
    aggregaytor_migration_counts: counts,
  });
  await oldDb.close();
  return { ok: true, counts, newCount };
}

function tableForDocType(dt: string): string {
  return {
    message: 'messages', contact: 'contacts', thread_meta: 'thread_meta',
    reminder: 'reminders', auto_respond: 'auto_respond', picture: 'pictures',
    block_rule: 'block_rules', preference_feedback: 'preference_feedback',
    preference_model: 'preference_model', calendar_event: 'calendar_events',
    dossier: 'dossiers', task: 'tasks',
  }[dt] || '';
}
```

**Trigger:** call from the top of `service-worker.ts` during the first post-upgrade startup. Surface errors via a one-time notification + log.

**Acceptance:**
- On an existing install, migration completes without error
- Doc counts match (within 1% tolerance for known-deleted edge cases)
- Post-migration queries return the same data as pre-migration
- Idempotent — running it a second time is a no-op

### Phase 3 — Service-worker call-site translation (size: M)

Direct PouchDB calls in service-worker.ts (via `getDB()`) need translation:

| Handler | PouchDB call | Dexie replacement |
|---|---|---|
| `SEARCH_MESSAGES` (now FlexSearch-enhanced) | `db.find({selector: docType:'message'})` | `db.messages.limit(n).toArray()` for the fallback path |
| `CLEAR_THREAD_MESSAGES` | `db.find({selector: contactId})` + `bulkDocs(tombstones)` | `db.messages.where('contactId').equals(id).delete()` |
| `CLEAR_ALL_DATA` | `db.destroy()` | `db.delete()` |
| `DERIVE_STYLE_GUIDE` | `db.find({selector: direction:'out'}, limit:200)` | `db.messages.where('direction').equals('out').limit(200).toArray()` |
| `MARK_ALL_READ` | `db.find({read:false, direction:'in'})` | `db.messages.where('[read+direction]').equals([false,'in']).modify({read:true})` |
| `DIAGNOSE_TRAINING_DATA` | `db.allDocs({startkey:'pref:'})` | `db.preference_feedback.toArray()` |

Same treatment for `debug-bridge.ts`'s 2 sites.

**Acceptance:** smoke-test every affected handler via the debug MCP.

### Phase 4 — Test port (size: S)

- Replace `new PouchDB(name, { adapter: 'memory' })` in test setup with `fake-indexeddb` + fresh `AggregaytorDB('test-' + random)`
- `afterEach` → `await db.delete()` instead of `await db.destroy()`
- Verify all 65 existing tests pass
- Add ~10 new Dexie-specific tests:
  - Index usage (verify `where('signalsUpdatedAt').above()` doesn't scan the table)
  - Transaction safety (concurrent upserts don't corrupt counts)
  - Migration script against a seeded fake PouchDB

**Acceptance:** `pnpm -r test` green with ≥75 tests.

### Phase 5 — Feature-flagged rollout (size: XS)

Gate the migration behind a chrome.storage flag:

```ts
const { aggregaytor_dexie_optin } = await chrome.storage.local.get('aggregaytor_dexie_optin');
if (aggregaytor_dexie_optin) {
  await migratePouchDBToDexie();
  // ... use Dexie
} else {
  // ... keep using PouchDB
}
```

This lets us ship the Dexie code to ALL users but only enable it for self-opt-in testers (via the settings UI) until we're confident.

**Acceptance:** settings toggle visible; flipping it restarts the SW cleanly.

### Phase 6 — Default-on + PouchDB removal (size: S)

After N=14 days of opt-in with no reported bugs:
- Flip the default to Dexie-on for all users on extension upgrade
- Add a "revert to PouchDB" button for emergencies (reads from the preserved old DB)
- In v0.59.x, strip PouchDB deps entirely

**Acceptance:** bundle size drops ≥15 KB; no crash reports or data-loss reports for 14 days post-default.

## 6. Risk matrix

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Data loss during migration | Low | **Critical** | Don't destroy PouchDB; verify counts; rollback flag; pre-migrate automatic Drive backup |
| Schema mistake (missing index) | Medium | Medium | Phase 0 smoke tests; manual index audit vs query list |
| Concurrent-write corruption | Low | High | Wrap read-modify-write in `db.transaction('rw', ...)`; audit every upsert path |
| Dexie version incompatibility | Low | Medium | Pin `dexie@^4.0.0`; test against latest before each bump |
| Test suite port bugs | Medium | Low | `fake-indexeddb` is mature; isolate per-test via unique DB names |
| Store consumers break on subtle semantic change | Medium | Medium | Keep external function signatures identical; run an end-to-end smoke test covering every handler |
| Bundle size unexpectedly grows (Dexie + PouchDB shipped together in Phase 5) | Low | Low | Dynamic-import PouchDB in the migration module only; it's gone after Phase 6 |

## 7. Verification checklist

Before flipping the default (end of Phase 5), verify:

- [ ] Message write throughput: ≥1.3× PouchDB baseline for 1000-msg batches (measured in `GET_SW_PERF`)
- [ ] Full-text search still works (FlexSearch unaffected; index seeder switches to Dexie scan)
- [ ] Signal-index delta scan uses the native index (Dexie tools / explain)
- [ ] All 65+ tests green
- [ ] Google Drive export → import round-trip preserves every table
- [ ] Side panel opens and renders exactly the same inbox as before
- [ ] Auto-respond and suggestions still work (no dropped settings)
- [ ] Block rules still fire
- [ ] Dossier auto-extraction still fires after 30s idle
- [ ] Clear-all-data wipes cleanly (no orphan tables)
- [ ] Bundle size drops by ≥10 KB

## 8. Rollback procedure

If Phase 5 reveals a critical bug:

1. Flip `aggregaytor_dexie_optin` back to `false` via chrome.storage (or via a dev-tools one-liner).
2. SW reload → reads from the preserved PouchDB instance.
3. Users on Dexie get cut over; data written to Dexie after migration is lost.
4. Before re-enabling, optionally write a reverse migration (Dexie → PouchDB) — straightforward since schemas match.

Expected rollback usage: ~0%. We don't ship the default cutover until Phase 5 is clean.

## 9. What NOT to do during the migration

- ❌ Don't change the `_id` format of any doc. Keep `msg:{platform}:{id}` etc. identical.
- ❌ Don't drop the `docType` field from documents — it's used by the Google Drive import path which may re-ingest pre-migration backups.
- ❌ Don't use `bulkPut` inside a loop over a large array without chunking — Dexie IDB transactions have size limits (~10k items).
- ❌ Don't add indexes speculatively. Every index costs on every write.
- ❌ Don't rely on Dexie's `liveQuery` — it's a reactive API that conflicts with our message-based architecture.
- ❌ Don't migrate during a sync burst. Schedule the migration on first cold-start after upgrade, not mid-session.
- ❌ Don't delete the old PouchDB database until Phase 6.

## 10. Open questions

1. **Should we denormalise `platform` out of `_id` into a strict foreign key?** Current IDs are `msg:grindr:12345`. Strict normalisation would be `_id: '12345'` + `platformId: 'grindr'` with a compound primary key `[platform+platformId]`. Cleaner but breaks compatibility with every existing caller. **Answer:** no — keep IDs stable.

2. **Dexie Cloud for cross-device sync?** Paid service, but would replace our stubbed `sync.ts`. **Answer:** defer — our product is single-device. Revisit if user-demand signals shift.

3. **Drop `pouchdb-find` earlier?** Some store modules already use `allDocs({startkey})` exclusively; those could switch to Dexie-like key-range now. **Answer:** yes — audit the `db.find()` callers; migrate those that can be expressed as `allDocs` separately as a mini-preparatory PR.

4. **Test against fake-indexeddb or real Chrome IDB?** `fake-indexeddb` is faster in CI but may not catch Chrome-specific bugs. **Answer:** both — `fake-indexeddb` for unit tests, a separate integration suite run in a real Chrome instance before each release.

## 11. Estimated effort (size, not time)

- Phase 0 (prep): **XS**
- Phase 1 (store rewrite): **L** (biggest chunk, ~800 LOC)
- Phase 2 (migration script): **M**
- Phase 3 (SW translation): **M**
- Phase 4 (test port): **S**
- Phase 5 (opt-in rollout): **XS**
- Phase 6 (default-on + cleanup): **S**

Total: **L** overall — roughly equivalent to the v0.57.8 caching pass plus a careful data-migration layer on top.

## 12. When to NOT do this

Skip this migration entirely if:
- Users don't report write latency problems (baseline: current SW perf shows upsertMessages at ~20ms for 50-message batches — well below perceptible thresholds)
- The team is working on features that depend on PouchDB specifics (e.g. attachments, replication — neither planned)
- Bundle size isn't a constraint (cold-start isn't a reported issue)

As of v0.57.9, none of these triggers are active. **Continue deferring.** This plan exists so that if/when the triggers fire, execution is a matter of reading the plan rather than re-researching the approach.
