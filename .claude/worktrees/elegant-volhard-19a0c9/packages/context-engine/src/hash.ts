/**
 * hash.ts — Stable content hashing using FNV-1a 64-bit.
 *
 * Extracted from mdb-tam context-modules.js lines 76-85.
 */

import { normalizeContextText } from './normalize.js';

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
