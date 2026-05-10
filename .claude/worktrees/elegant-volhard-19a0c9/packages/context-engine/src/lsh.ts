/**
 * lsh.ts — Locality-sensitive hashing and similarity estimation.
 *
 * Extracted from mdb-tam context-modules.js lines 144-177.
 */

import type { LshOptions } from './types.js';

export function buildLshBuckets(signature: number[], opts: LshOptions = {}): string[] {
  if (!Array.isArray(signature) || !signature.length) return [];
  const bands = Math.max(2, Number(opts.bands) || 6);
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
  if (!aTokens.length || !bTokens.length) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  return intersection / Math.max(1, aSet.size + bSet.size - intersection);
}
