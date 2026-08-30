/**
 * lsh.ts — Locality-sensitive hashing and similarity estimation.
 *
 * Extracted from mdb-tam context-modules.js lines 144-177.
 */

import { toIntOption } from './minhash.js';
import type { LshOptions } from './types.js';

/**
 * Splits a signature into `bands` buckets of `rows` values each.
 *
 * Known wart, kept for compatibility: `rows` has a floor of 2, so whenever
 * `bands * rows` exceeds the signature length the trailing bands slice past
 * the end and are dropped — e.g. an 8-value signature with the default 6 bands
 * yields 4 buckets, not 6. Bucket strings are persisted on records, so
 * changing the split would orphan every stored `lsh_buckets` value.
 */
export function buildLshBuckets(signature: number[], opts: LshOptions = {}): string[] {
  if (!Array.isArray(signature) || !signature.length) return [];
  // Non-integer/non-finite band counts used to misalign the slices, and
  // Infinity span the loop forever; toIntOption keeps every finite integer.
  const bands = toIntOption(opts.bands, 6, 2);
  const rows = Math.max(2, Math.floor(signature.length / bands));
  const output: string[] = [];
  for (let band = 0; band < bands; band += 1) {
    const start = band * rows;
    const slice = signature.slice(start, start + rows);
    if (!slice.length) continue;
    output.push(`b${band}_${slice.map(value => value.toString(36)).join('_')}`);
  }
  return output;
}

export function estimateSignatureSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const len = Math.min(a.length, b.length);
  let matches = 0;
  for (let i = 0; i < len; i += 1) {
    if (a[i] === b[i]) matches += 1;
  }
  return matches / len;
}

export function estimateTokenJaccard(aTokens: string[], bTokens: string[]): number {
  if (!Array.isArray(aTokens) || !Array.isArray(bTokens)) return 0;
  if (!aTokens.length || !bTokens.length) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  // Probe with the smaller set; |A ∩ B| is symmetric, so the result is the same.
  const [small, large] = aSet.size <= bSet.size ? [aSet, bSet] : [bSet, aSet];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }
  return intersection / Math.max(1, aSet.size + bSet.size - intersection);
}
