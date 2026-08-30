/**
 * records.ts — Context record creation with full enrichment pipeline.
 *
 * Extracted from mdb-tam context-modules.js lines 188-301.
 */

import { normalizeContextText } from './normalize.js';
import { stableContentHash } from './hash.js';
import { tokenizeIndexText } from './tokenize.js';
import { buildMinHashSignature } from './minhash.js';
import { buildLshBuckets } from './lsh.js';
import type { ContextRecord, ContextRecordInput, SearchFields } from './types.js';

/**
 * Derives a `YYYY-MM` (UTC) bucket key from a date string, for coarse
 * time-based grouping/filtering of records.
 *
 * @param dateValue - Any `Date.parse`-able string.
 * @returns `YYYY-MM` in UTC, or '' when the input is empty/unparseable.
 */
export function buildDateBucket(dateValue: string): string {
  const ts = Date.parse(String(dateValue || ''));
  if (!ts) return '';
  const date = new Date(ts);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Tokenizes each searchable field of a record input into its own token list,
 * with per-field token caps tuned to field importance/length.
 *
 * The resulting `SearchFields` are what the fielded search scorer matches
 * against; keeping fields separate lets each be weighted independently at
 * search time. Array fields (keywords, entities) are space-joined first.
 *
 * @param input - Partial record input (any missing field tokenizes to []).
 * @returns Per-field tokenized `SearchFields`.
 */
export function buildRecordSearchFields(input: Partial<ContextRecordInput> = {}): SearchFields {
  return {
    title: tokenizeIndexText(input.title || '', 32),
    summary: tokenizeIndexText(input.summary || '', 48),
    excerpt: tokenizeIndexText(input.excerpt || '', 48),
    body: tokenizeIndexText(input.body || '', 96),
    keywords: tokenizeIndexText(
      Array.isArray(input.keywords) ? input.keywords.join(' ') : '',
      32,
    ),
    entities: tokenizeIndexText(
      Array.isArray(input.entities) ? input.entities.join(' ') : '',
      32,
    ),
    source_type: tokenizeIndexText(input.source_type || '', 8),
    segment: tokenizeIndexText(input.segment || '', 8),
  };
}

/**
 * Concatenates all textual fields of a record into one newline-joined string.
 *
 * This combined text is the single basis for both the exact content hash and
 * the MinHash signature, so the two always describe the same content. Empty
 * fields are dropped before joining. Field order here is part of the hash's
 * determinism basis and must not change casually.
 *
 * @param input - Partial record input.
 * @returns Newline-joined non-empty fields.
 */
function buildCombinedRecordText(input: Partial<ContextRecordInput> = {}): string {
  return [
    input.title || '',
    input.summary || '',
    input.excerpt || '',
    input.body || '',
    Array.isArray(input.keywords) ? input.keywords.join(' ') : '',
    Array.isArray(input.entities) ? input.entities.join(' ') : '',
    input.source_type || '',
    input.segment || '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Normalizes each string in an array via `normalizeContextText` and drops
 * empties; non-array input yields [].
 *
 * @param values - Optional string array (e.g. keywords, entities).
 * @returns Normalized, empties-removed array.
 */
function normalizeArray(values?: string[]): string[] {
  return Array.isArray(values)
    ? values.map(value => normalizeContextText(value)).filter(Boolean)
    : [];
}

/**
 * Computes the near-duplicate detection metadata for a record: its MinHash
 * signature, the derived LSH buckets, and its body tokens.
 *
 * These three fields are persisted and later consumed by `dedupeContextRecords`
 * (buckets to find candidates, signature + body tokens to score them). Because
 * they flow from the deterministic MinHash/LSH pipeline, the same input always
 * produces the same metadata across runs. Body tokens fall back through
 * body → summary → excerpt → title so even sparse records get a token set.
 *
 * @param input - Partial record input (already normalized by the caller).
 * @param basisText - Combined text to fingerprint; defaults to rebuilding it
 *   from `input`, but callers pass the already-built string to avoid
 *   re-concatenating every field.
 * @returns `{ minhash_signature, lsh_buckets, body_tokens }`.
 */
function buildNearDuplicateMetadata(
  input: Partial<ContextRecordInput>,
  basisText = buildCombinedRecordText(input),
) {
  const signature = buildMinHashSignature(basisText);
  const bodyTokens = tokenizeIndexText(
    (input.body || input.summary || input.excerpt || input.title || '') as string,
    128,
  );
  return {
    minhash_signature: signature,
    lsh_buckets: buildLshBuckets(signature),
    body_tokens: bodyTokens,
  };
}

/**
 * Builds a fully enriched context record of the given `kind` from raw input.
 *
 * Runs the full pipeline: normalize every field, compute the combined text
 * once, derive the exact content hash (or honor a caller-supplied one), the
 * near-duplicate metadata (MinHash/LSH/body tokens), the tokenized search
 * fields, and the date bucket; then merge these over the original input.
 * Determinism note: the exact hash and MinHash metadata are reproducible for
 * identical input, but `updated_at`/`event_date` default to `Date.now()` when
 * absent, so a record left to default its timestamps is not bit-identical
 * across calls — supply those fields for a fully reproducible record.
 *
 * @param kind - Record kind tag (e.g. 'module', 'chunk').
 * @param input - Raw record input; unknown extra fields are preserved.
 * @returns The enriched `ContextRecord`.
 */
export function createContextRecord(kind: string, input: ContextRecordInput = {}): ContextRecord {
  const title = normalizeContextText(input.title || '');
  const summary = normalizeContextText(input.summary || '');
  const excerpt = normalizeContextText(input.excerpt || '');
  const body = normalizeContextText(input.body || '');
  const keywords = normalizeArray(input.keywords);
  const entities = normalizeArray(input.entities);
  const sourceType = normalizeContextText(input.source_type || '');
  const segment = normalizeContextText(input.segment || '');

  const normalized = { title, summary, excerpt, body, keywords, entities, source_type: sourceType, segment };
  const combinedText = buildCombinedRecordText(normalized);
  const exactHash = input.exact_hash || stableContentHash(combinedText);
  // Same basis string the hash used — rebuilding it here concatenated every
  // field a second time for no gain.
  const nearDuplicateMeta = buildNearDuplicateMetadata(normalized, combinedText);
  const searchFields = buildRecordSearchFields(normalized);

  const updatedAt = String(input.updated_at || input.generated_at || new Date().toISOString());
  const eventDate = String(input.event_date || updatedAt);

  return {
    ...input,
    kind,
    title,
    summary,
    excerpt,
    body,
    keywords,
    entities,
    source_type: sourceType,
    segment,
    updated_at: updatedAt,
    event_date: eventDate,
    date_bucket: buildDateBucket(eventDate || updatedAt),
    exact_hash: exactHash,
    minhash_signature: nearDuplicateMeta.minhash_signature,
    lsh_buckets: nearDuplicateMeta.lsh_buckets,
    body_tokens: nearDuplicateMeta.body_tokens,
    search_fields: searchFields,
  };
}

/**
 * Convenience wrapper: builds a context record of kind `'module'` (a top-level,
 * higher-ranked document).
 *
 * @param input - Raw record input.
 * @returns The enriched module record.
 */
export function createContextModule(input: ContextRecordInput = {}): ContextRecord {
  return createContextRecord('module', input);
}

/**
 * Convenience wrapper: builds a context record of kind `'chunk'` (a subordinate
 * fragment, lower base rank than a module at search time).
 *
 * @param input - Raw record input.
 * @returns The enriched chunk record.
 */
export function createContextChunk(input: ContextRecordInput = {}): ContextRecord {
  return createContextRecord('chunk', input);
}
