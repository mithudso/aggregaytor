/**
 * dedup.ts — Exact and near-duplicate detection using content hashing and LSH.
 *
 * Extracted from mdb-tam context-modules.js lines 303-375.
 */

import { estimateSignatureSimilarity, estimateTokenJaccard } from './lsh.js';
import type { ContextRecord, DedupeOptions, DedupeResult } from './types.js';

function recordSpecificityScore(record: ContextRecord): number {
  return [
    String(record.body || '').length * 3,
    String(record.summary || '').length * 2,
    Array.isArray(record.keywords) ? record.keywords.length * 10 : 0,
    Date.parse(record.updated_at || '') || 0,
  ].reduce((sum, value) => sum + value, 0);
}

export function dedupeContextRecords(
  records: ContextRecord[],
  opts: DedupeOptions = {},
): DedupeResult {
  const exactSeen = new Map<string, string>();
  const bucketMap = new Map<string, string[]>();
  const deduped: ContextRecord[] = [];
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
      const candidate = deduped.find(item => item.id === candidateId);
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
