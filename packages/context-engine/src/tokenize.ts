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

/**
 * Lowercases and strips every character outside the token alphabet.
 *
 * Note for callers: runs of disallowed characters collapse to a single ASCII
 * space, so a space is the *only* separator that can appear in the result.
 */
export function normalizeSearchText(text: string): string {
  return normalizeContextText(text)
    .toLowerCase()
    .replace(/[^a-z0-9@._:/-]+/g, ' ');
}

export function tokenizeIndexText(text: string, opts?: number | TokenizeOptions): string[] {
  const maxTokens = typeof opts === 'number' ? opts : (opts?.maxTokens ?? 128);
  const stopwords = typeof opts === 'object' ? (opts?.stopwords ?? DEFAULT_STOPWORDS) : DEFAULT_STOPWORDS;

  // Scanned rather than split/mapped/filtered: callers routinely pass a whole
  // message body but ask for 32 tokens, and splitting materializes every token
  // in the text before the cap is applied. A space is the only separator
  // normalizeSearchText can emit, so indexOf(' ') finds every boundary.
  const normalized = normalizeSearchText(text);
  const seen = new Set<string>();
  const output: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = normalized.indexOf(' ', start);
    if (end === -1) end = normalized.length;
    if (end - start >= 2) {
      const token = normalized.slice(start, end);
      if (!stopwords.has(token) && !seen.has(token)) {
        seen.add(token);
        output.push(token);
        if (output.length >= maxTokens) break;
      }
    }
    start = end + 1;
  }
  return output;
}
