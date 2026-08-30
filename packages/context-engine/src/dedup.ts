/**
 * dedup.ts — Exact and near-duplicate detection using content hashing and LSH.
 *
 * Extracted from mdb-tam context-modules.js lines 303-375.
 */

import { estimateSignatureSimilarity, estimateTokenJaccard } from './lsh.js';
import type { ContextRecord, DedupeOptions, DedupeResult } from './types.js';

/**
 * Scores how "specific"/information-rich a record is, so the richest of a set
 * of duplicates is the one kept.
 *
 * Weights body length highest, then summary, then keyword count, then recency
 * (as a raw epoch-ms tiebreaker). Records are sorted by this descending before
 * the dedup pass, making the survivor deterministic.
 *
 * @param record - Record to score.
 * @returns A non-negative comparable score (higher = keep in preference).
 */
function recordSpecificityScore(record: ContextRecord): number {
  return [
    String(record.body || '').length * 3,
    String(record.summary || '').length * 2,
    Array.isArray(record.keywords) ? record.keywords.length * 10 : 0,
    Date.parse(record.updated_at || '') || 0,
  ].reduce((sum, value) => sum + value, 0);
}

/**
 * Removes exact and near-duplicate records, keeping the most specific instance
 * of each and mapping every dropped record to its survivor.
 *
 * Two-stage: exact matches collapse by `exact_hash`; remaining records are
 * checked for near-duplication against LSH-bucket-sharing candidates using both
 * the MinHash signature estimate (`nearThreshold`) and the exact token Jaccard
 * (`tokenThreshold`) — either clearing threshold marks a near-duplicate.
 * Records are processed most-specific-first so the survivor is the richest one;
 * the kept set is finally sorted newest-first. Records without an `exact_hash`
 * are skipped entirely.
 *
 * @param records - Records to deduplicate (non-array input is treated as empty).
 * @param opts - `nearThreshold` (MinHash similarity, default 0.9) and
 *   `tokenThreshold` (token Jaccard, default 0.88).
 * @returns `{ records }` (the kept records, newest-first) and `duplicates` (a
 *   map of dropped-record id → `{ duplicate_of, duplicate_kind }`).
 */
export function dedupeContextRecords(
  records: ContextRecord[],
  opts: DedupeOptions = {},
): DedupeResult {
  const exactSeen = new Map<string, string>();
  const bucketMap = new Map<string, string[]>();
  const deduped: ContextRecord[] = [];
  // id -> kept record, so candidate lookup is O(1). A linear scan of `deduped`
  // per candidate made the near-duplicate pass quadratic in the kept-record
  // count on top of the per-record candidate fan-out.
  const keptById = new Map<string, ContextRecord>();
  const duplicateMap = new Map<string, { duplicate_of: string; duplicate_kind: 'exact' | 'near' }>();
  const ordered = [...(Array.isArray(records) ? records : [])]
    .sort((a, b) => recordSpecificityScore(b) - recordSpecificityScore(a));

  const nearThreshold = Number(opts.nearThreshold) || 0.9;
  const tokenThreshold = Number(opts.tokenThreshold) || 0.88;

  for (const record of ordered) {
    if (!record?.exact_hash) continue;

    if (exactSeen.has(record.exact_hash)) {
      duplicateMap.set(record.id!, {
        duplicate_of: exactSeen.get(record.exact_hash)!,
        duplicate_kind: 'exact',
      });
      continue;
    }

    const candidates = new Set<string>();
    for (const bucket of record.lsh_buckets || []) {
      const existingIds = bucketMap.get(bucket) || [];
      existingIds.forEach(id => candidates.add(id));
    }

    let nearDuplicateOf = '';
    for (const candidateId of candidates) {
      const candidate = keptById.get(candidateId);
      if (!candidate) continue;
      const signatureScore = estimateSignatureSimilarity(
        record.minhash_signature,
        candidate.minhash_signature,
      );
      const tokenScore = estimateTokenJaccard(
        record.body_tokens || [],
        candidate.body_tokens || [],
      );
      if (signatureScore >= nearThreshold || tokenScore >= tokenThreshold) {
        nearDuplicateOf = candidateId;
        break;
      }
    }

    if (nearDuplicateOf) {
      duplicateMap.set(record.id!, {
        duplicate_of: nearDuplicateOf,
        duplicate_kind: 'near',
      });
      continue;
    }

    exactSeen.set(record.exact_hash, record.id!);
    deduped.push(record);
    // First-wins, matching the `deduped.find(...)` this replaced: if two kept
    // records somehow share an id, the earlier one stays the candidate.
    if (!keptById.has(record.id!)) keptById.set(record.id!, record);
    for (const bucket of record.lsh_buckets || []) {
      if (!bucketMap.has(bucket)) bucketMap.set(bucket, []);
      bucketMap.get(bucket)!.push(record.id!);
    }
  }

  return {
    records: deduped.sort((a, b) => {
      const aTs = Date.parse(a.updated_at || a.event_date || '') || 0;
      const bTs = Date.parse(b.updated_at || b.event_date || '') || 0;
      return bTs - aTs;
    }),
    duplicates: duplicateMap,
  };
}
