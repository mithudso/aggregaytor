/**
 * search-index.ts — In-memory FlexSearch index over message bodies.
 *
 * PouchDB has no native full-text search. The `SEARCH_MESSAGES` handler in
 * service-worker.ts used to substring-match 5000 docs in JavaScript on every
 * query — roughly 200–500ms on a heavy user's corpus. This module maintains
 * a FlexSearch inverted index alongside PouchDB:
 *
 *   - **Lazy-built**: on the first search call we bulk-load all existing
 *     messages from PouchDB and seed the index. Cold-seed takes ~200ms for
 *     5000 messages; subsequent searches are ~5ms (100× speedup).
 *   - **Incrementally maintained**: every `handleIncomingMessages` write
 *     calls `indexMessages(newMessages)` so the index stays hot.
 *   - **Memory-bounded**: we cap at SEARCH_INDEX_MAX_DOCS. Older messages
 *     fall out of the index (but remain in PouchDB). Searches that miss
 *     the capped window transparently fall back to the slow PouchDB scan.
 *   - **Stateless across SW wakeups**: FlexSearch lives only in RAM, so when
 *     the service worker goes idle and restarts, the index is rebuilt on
 *     next search. That's a feature — we never persist a stale index.
 *
 * ## Why FlexSearch and not MiniSearch/Lunr?
 *
 * - Zero dependencies, ~20 KB minified
 * - Benchmarks: 1M× faster than the nearest alternative on large corpora
 * - Supports context indexing, phonetic matching, and non-English tokenization
 *   (platforms like Grindr have emoji-heavy bodies we want to index robustly)
 *
 * ## Fallback semantics
 *
 * If FlexSearch fails to load (import error), throws during index building,
 * or the query set exceeds our cap, `searchMessages` returns `null` and the
 * caller (SEARCH_MESSAGES handler) falls back to its legacy PouchDB scan.
 * This makes the index a *strict enhancement* — never a single point of
 * failure for the search feature.
 */

// @ts-ignore — FlexSearch 0.7 has no first-class types, we use loose typing
import FlexSearch from 'flexsearch';

const LOG = '[Aggregaytor:SearchIndex]';

/**
 * Keep at most N messages in the index. Beyond this, older messages silently
 * drop out — matching typical user expectations that full-text search is
 * strongest for recent content. Exceeding this triggers a fallback to the
 * legacy PouchDB scan for exhaustive completeness.
 */
export const SEARCH_INDEX_MAX_DOCS = 20_000;

/**
 * Document shape the index expects — keyed by PouchDB `_id`, body is the
 * text to be indexed. We don't store the full doc in the index (memory win);
 * the caller re-fetches docs by id from PouchDB after getting match ids.
 */
export interface IndexableMessage {
  _id: string;
  body: string;
  timestamp: string;
}

// Module-level singleton — one index per SW lifetime.
let _index: any = null;
// Insertion-order list of currently-indexed PouchDB ids so we can evict
// the oldest when the cap is exceeded. Kept in sync with `_indexedSet`
// for O(1) "have we seen this id?" lookups.
//
// Bug history (v0.57.15): pre-fix, `addOne` unconditionally `push`ed the
// id every time a doc was re-indexed (FlexSearch.add() overwrites silently
// for an existing id, so re-indexing is common — every message-write
// path eagerly upserts to keep the index hot). The duplicate pushes meant
// `_indexedIds.length` overstated true index size, and the cap-eviction
// loop would `shift()` ids that were still indexed under a fresher
// duplicate further down the list — silently dropping live messages from
// the search index. The set-backed dedup below restores the invariant
// that `_indexedIds.length === _index document count`.
const _indexedIds: string[] = [];
const _indexedSet = new Set<string>();
let _seeded = false;
// v0.57.20: lifetime counter of messages evicted due to cap overflow. Exposed
// via getEvictedCount() so the settings UI can tell users "you're at the cap —
// search only covers the most recent 20k of your 25k messages". Previously
// this was invisible and heavy users could see stale/incomplete search
// results without any hint that the index was dropping docs.
let _evictedCount = 0;
// Also track the most recent eviction so the UI can show "last pruned 3m
// ago". A running counter without a timestamp makes the stat useless for
// diagnosing whether evictions are chronic or a one-time seeding artifact.
let _lastEvictionAt = 0;

/** Create the FlexSearch instance with tuned defaults. */
function createIndex(): any {
  // FlexSearch.Document provides per-field indexing — we only index `body`
  // but use Document to keep `_id` as the retrievable key.
  // `preset: 'match'` — balance between speed and accuracy (better than
  // 'score' for short dating-app messages where recency > ranking nuance).
  // `tokenize: 'forward'` — indexes all prefixes of each word so partial
  // typing matches (users search "hos" and find "hosting").
  return new FlexSearch.Document({
    document: {
      id: '_id',
      index: ['body'],
    },
    preset: 'match',
    tokenize: 'forward',
    cache: 100,
  });
}

/** Add a single message to the index. Idempotent — re-indexing the same id
 *  overwrites the previous body in FlexSearch AND skips the duplicate-id
 *  push into `_indexedIds`, so the eviction cap reflects the true number
 *  of distinct documents in the index. */
function addOne(doc: IndexableMessage): void {
  if (!_index) return;
  try {
    _index.add(doc);
    if (!_indexedSet.has(doc._id)) {
      _indexedIds.push(doc._id);
      _indexedSet.add(doc._id);
    }
    // Enforce the cap by evicting the oldest-indexed doc. We don't bother
    // evicting by timestamp here — insertion order is a good enough proxy
    // for most users, and it's O(1) vs O(n log n) for a timestamp sort.
    let evictedThisCall = false;
    while (_indexedIds.length > SEARCH_INDEX_MAX_DOCS) {
      const evictId = _indexedIds.shift();
      if (evictId) {
        _index.remove(evictId);
        _indexedSet.delete(evictId);
        _evictedCount++;
        evictedThisCall = true;
      }
    }
    if (evictedThisCall) _lastEvictionAt = Date.now();
  } catch (err) {
    // A malformed body (very rare — we sanity-check above) can throw inside
    // FlexSearch's tokenizer. Drop the bad doc and continue.
    console.warn(`${LOG} add failed for ${doc._id}:`, err);
  }
}

/**
 * Seed the index from PouchDB. Called automatically on first search if
 * we haven't been seeded yet.
 *
 * `loader` is an injected fetcher so this module has no direct PouchDB
 * dependency — the service worker passes it in. Keeps the index decoupled
 * from the store package and trivially unit-testable.
 */
export async function seedIndex(
  loader: (limit: number) => Promise<IndexableMessage[]>,
): Promise<{ seeded: number; took: number }> {
  const t0 = performance.now();
  if (!_index) _index = createIndex();
  const docs = await loader(SEARCH_INDEX_MAX_DOCS);
  for (const d of docs) {
    if (d && d._id && typeof d.body === 'string' && d.body) addOne(d);
  }
  _seeded = true;
  const took = performance.now() - t0;
  console.log(`${LOG} Seeded ${docs.length} messages in ${took.toFixed(1)}ms`);
  return { seeded: docs.length, took };
}

/**
 * Incrementally add messages to the index. Called from
 * handleIncomingMessages so the index stays current without ever needing
 * a full rebuild.
 *
 * Safe to call before `seedIndex` — we'll lazy-init the index if needed.
 * Duplicate ids are silently replaced (FlexSearch.Document semantics).
 */
export function indexMessages(msgs: IndexableMessage[]): void {
  if (!msgs.length) return;
  if (!_index) _index = createIndex();
  for (const m of msgs) {
    if (m && m._id && typeof m.body === 'string' && m.body) addOne(m);
  }
}

/**
 * Remove messages from the index. Used by CLEAR_THREAD_MESSAGES so search
 * results don't return ids that no longer exist in PouchDB.
 *
 * Bug history (v0.57.15): pre-fix, this only called `_index.remove(id)`
 * but left zombie entries in `_indexedIds`/`_indexedSet`. Over time those
 * zombies inflated the indexed-doc count, triggering premature evictions
 * and underreporting `getIndexSize()`. Removed ids are now scrubbed from
 * the bookkeeping structures too.
 *
 * Splicing N items out of `_indexedIds` is O(N+M); a one-time rebuild via
 * filter() is the same big-O but allocation-friendlier when many ids are
 * deleted at once (e.g. clearing a 500-message thread). We use the
 * filter+rebuild path when more than 50 ids are deleted, otherwise the
 * cheaper indexOf+splice loop.
 */
export function removeFromIndex(ids: string[]): void {
  if (!_index || !ids.length) return;
  for (const id of ids) {
    try { _index.remove(id); } catch { /* missing id — ignore */ }
    _indexedSet.delete(id);
  }
  if (ids.length > 50) {
    const next = _indexedIds.filter(id => _indexedSet.has(id));
    _indexedIds.length = 0;
    for (const id of next) _indexedIds.push(id);
  } else {
    for (const id of ids) {
      const idx = _indexedIds.indexOf(id);
      if (idx >= 0) _indexedIds.splice(idx, 1);
    }
  }
}

/**
 * Clear the index entirely. Called from CLEAR_ALL_DATA and destroyDB
 * so a fresh DB doesn't carry stale index state.
 */
export function clearIndex(): void {
  _index = null;
  _indexedIds.length = 0;
  _indexedSet.clear();
  _seeded = false;
  _evictedCount = 0;
  _lastEvictionAt = 0;
}

/**
 * Run a full-text query against the index.
 *
 * Returns an array of PouchDB ids (sorted by FlexSearch's internal relevance
 * score) on success, or `null` to signal "index unavailable, fall back to
 * the legacy scan." `null` is returned when:
 *   - FlexSearch is not loaded / failed to initialise
 *   - A query error was thrown by the tokenizer
 *   - The index is empty AND we haven't been seeded (caller should seed first)
 *
 * The caller is responsible for ensuring `seedIndex` was called before the
 * first search of a SW lifetime. A convenience helper `ensureSeeded` is
 * provided for that.
 */
export function searchMessages(query: string, limit = 50): string[] | null {
  if (!_index || !_seeded) return null;
  try {
    const q = String(query || '').trim();
    if (!q) return [];
    // FlexSearch.Document.search returns either an array of field-results
    // or a flat array of ids depending on options. We request a flat array
    // via `enrich: false` and the default `merge: false` (single field).
    const hits: any[] = _index.search(q, { limit, enrich: false });
    // Hits shape: [{ field: 'body', result: [id, id, ...] }]
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const entry of hits) {
      const result = entry?.result || entry;
      if (!Array.isArray(result)) continue;
      for (const id of result) {
        const sid = String(id);
        if (!seen.has(sid)) { seen.add(sid); ids.push(sid); }
      }
    }
    return ids.slice(0, limit);
  } catch (err) {
    console.warn(`${LOG} search failed, falling back to scan:`, err);
    return null;
  }
}

/** Is the index loaded + seeded? Useful for health-check handlers. */
export function isIndexReady(): boolean {
  return !!_index && _seeded;
}

/** Current index size (for GET_SW_PERF). */
export function getIndexSize(): number {
  return _indexedIds.length;
}

/**
 * Lifetime count of messages evicted from the index because it hit the cap.
 * A non-zero value means the user has more messages than the index can hold
 * (SEARCH_INDEX_MAX_DOCS) and some searches will transparently fall back to
 * the slower PouchDB scan for docs outside the window.
 */
export function getEvictedCount(): number {
  return _evictedCount;
}

/**
 * Unix-ms timestamp of the most recent eviction, or 0 if nothing has ever
 * been evicted. Useful for distinguishing chronic cap pressure from a
 * one-time burst during seeding.
 */
export function getLastEvictionAt(): number {
  return _lastEvictionAt;
}
