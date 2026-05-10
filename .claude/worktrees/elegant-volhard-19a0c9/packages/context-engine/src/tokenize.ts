/**
 * tokenize.ts — Text tokenization with stopword filtering.
 *
 * Extracted from mdb-tam context-modules.js lines 1-107.
 */

import { normalizeContextText } from './normalize.js';
import type { TokenizeOptions } from './types.js';

export const DEFAULT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'if', 'in', 'into', 'is', 'it',
  'its', 'of', 'on', 'or', 'our', 'she', 'that', 'the', 'their', 'them', 'they',
  'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your',
]);

export function normalizeSearchText(text: string): string {
  return normalizeContextText(text)
    .toLowerCase()
    .replace(/[^a-z0-9@._:/-]+/g, ' ');
}

export function tokenizeIndexText(text: string, opts?: number | TokenizeOptions): string[] {
  const maxTokens = typeof opts === 'number' ? opts : (opts?.maxTokens ?? 128);
  const stopwords = typeof opts === 'object' ? (opts?.stopwords ?? DEFAULT_STOPWORDS) : DEFAULT_STOPWORDS;

  const tokens = normalizeSearchText(text)
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !stopwords.has(token));

  const seen = new Set<string>();
  const output: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    output.push(token);
    if (output.length >= maxTokens) break;
  }
  return output;
}
