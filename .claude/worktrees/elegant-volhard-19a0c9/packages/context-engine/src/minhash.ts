/**
 * minhash.ts — MinHash signature generation for near-duplicate detection.
 *
 * Extracted from mdb-tam context-modules.js lines 109-142.
 */

import { tokenizeIndexText } from './tokenize.js';
import type { MinHashOptions } from './types.js';

export function buildShingles(tokens: string[], size = 3): string[] {
  if (tokens.length <= size) return tokens.length ? [tokens.join(' ')] : [];
  const output: string[] = [];
  for (let i = 0; i <= tokens.length - size; i += 1) {
    output.push(tokens.slice(i, i + size).join(' '));
  }
  return output;
}

export function seededHash(input: string, seed: number): number {
  const value = String(input || '');
  let hash = 2166136261 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildMinHashSignature(text: string, opts: MinHashOptions = {}): number[] {
  const numHashes = Math.max(8, Number(opts.numHashes) || 24);
  const shingleSize = Math.max(1, Number(opts.shingleSize) || 3);
  const tokens = tokenizeIndexText(text, 256);
  const shingles = buildShingles(tokens, shingleSize);
  if (!shingles.length) return [];
  const signature = new Array<number>(numHashes).fill(0xffffffff);
  for (const shingle of shingles) {
    for (let i = 0; i < numHashes; i += 1) {
      const hashed = seededHash(shingle, i + 1);
      if (hashed < signature[i]) signature[i] = hashed;
    }
  }
  return signature;
}
