/**
 * hash.ts — Stable content hashing using FNV-1a 64-bit.
 *
 * Extracted from mdb-tam context-modules.js lines 76-85.
 */

import { normalizeContextText } from './normalize.js';

/**
 * Computes a stable 64-bit FNV-1a content hash of `value`, prefixed with `h`.
 *
 * Deterministic contract: the input is first passed through
 * `normalizeContextText`, then folded byte-by-byte with the fixed FNV-1a
 * offset basis and prime under 64-bit wraparound. For a given normalized
 * string the output never changes across runs or machines. This hash is
 * persisted as a record's `exact_hash` and drives exact-duplicate detection,
 * so the algorithm, constants, and `h<16 hex>` format MUST NOT change — doing
 * so would orphan every stored hash and silently defeat dedup.
 *
 * @param value - Raw text to hash (normalized internally).
 * @returns Hash of the form `h` + 16 zero-padded lowercase hex digits.
 */
export function stableContentHash(value: string): string {
  const input = normalizeContextText(value);
  let hash = 1469598103934665603n;
  const prime = 1099511628211n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `h${hash.toString(16).padStart(16, '0')}`;
}
