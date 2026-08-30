/**
 * minhash.ts — MinHash signature generation for near-duplicate detection.
 *
 * Extracted from mdb-tam context-modules.js lines 109-142.
 */

import { tokenizeIndexText } from './tokenize.js';
import type { MinHashOptions } from './types.js';

/**
 * Builds overlapping `size`-token shingles (n-grams) from a token list.
 *
 * Shingles are the input set for MinHash: comparing sets of contiguous token
 * runs captures local word order that a bag-of-tokens set would lose. When
 * there are too few tokens to form a full shingle, the whole token run is
 * returned as a single shingle so short texts still produce a signature.
 *
 * Deterministic: same tokens + size always yield the same shingles in the same
 * order. Do not change the join separator or windowing — it feeds persisted
 * MinHash signatures.
 *
 * @param tokens - Ordered tokens to window over.
 * @param size - Shingle width in tokens (default 3).
 * @returns Array of space-joined shingles (possibly empty for empty input).
 */
export function buildShingles(tokens: string[], size = 3): string[] {
  if (tokens.length <= size) return tokens.length ? [tokens.join(' ')] : [];
  const output: string[] = [];
  for (let i = 0; i <= tokens.length - size; i += 1) {
    output.push(tokens.slice(i, i + size).join(' '));
  }
  return output;
}

/**
 * Deterministic 32-bit FNV-1a hash of `input`, mixed with `seed`.
 *
 * The seed lets one string be hashed under many independent hash functions,
 * which is exactly what MinHash needs (one min per seed). `Math.imul` keeps the
 * multiply in 32-bit space and the final `>>> 0` returns an unsigned int.
 *
 * Deterministic contract: output depends only on `input` and `seed` and is
 * stable across runs/machines. The constants and mixing MUST NOT change — the
 * resulting values become MinHash signature entries that are persisted on
 * records and used for cross-run near-duplicate matching.
 *
 * @param input - String to hash (coerced to a string; null/undefined → '').
 * @param seed - Per-hash-function seed, XORed into the FNV offset basis.
 * @returns Unsigned 32-bit hash.
 */
export function seededHash(input: string, seed: number): number {
  const value = String(input || '');
  let hash = 2166136261 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Coerces an option to a positive integer, preserving the historical
 * `Math.max(floor, value || fallback)` semantics for every finite input.
 *
 * Flooring matters: a fractional numHashes reached `new Array(n)` and threw
 * RangeError, and a non-finite one either threw or (for bands) span forever.
 */
export function toIntOption(value: unknown, fallback: number, floor: number): number {
  const parsed = Math.floor(Number(value));
  return Math.max(floor, Number.isFinite(parsed) ? parsed || fallback : fallback);
}

/**
 * Builds a MinHash signature for `text`: one minimum hash value per hash
 * function, over the text's shingle set.
 *
 * The signature approximates Jaccard similarity between texts — the fraction of
 * matching signature positions estimates set overlap (see
 * `estimateSignatureSimilarity`). Text is capped at 256 tokens before
 * shingling to bound cost.
 *
 * Deterministic contract: for the same `text` and `opts` the signature is
 * byte-for-byte identical across runs/machines, because it is built from the
 * deterministic `tokenizeIndexText` → `buildShingles` → `seededHash` chain.
 * Signatures are persisted as `minhash_signature` and compared across runs, so
 * the seed scheme (`i + 1`), the 0xffffffff init, the token cap, and the
 * defaults MUST NOT change.
 *
 * @param text - Source text to fingerprint.
 * @param opts - `numHashes` (signature length, default 24, floor 8) and
 *   `shingleSize` (default 3, floor 1); both coerced via `toIntOption`.
 * @returns Signature array of length `numHashes`, or `[]` when the text yields
 *   no shingles.
 */
export function buildMinHashSignature(text: string, opts: MinHashOptions = {}): number[] {
  const numHashes = toIntOption(opts.numHashes, 24, 8);
  const shingleSize = toIntOption(opts.shingleSize, 3, 1);
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
