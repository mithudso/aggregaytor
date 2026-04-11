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

export function buildDateBucket(dateValue: string): string {
  const ts = Date.parse(String(dateValue || ''));
  if (!ts) return '';
  const date = new Date(ts);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

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

function normalizeArray(values?: string[]): string[] {
  return Array.isArray(values)
    ? values.map(value => normalizeContextText(value)).filter(Boolean)
    : [];
}

function buildNearDuplicateMetadata(input: Partial<ContextRecordInput>) {
  const basisText = buildCombinedRecordText(input);
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
  const nearDuplicateMeta = buildNearDuplicateMetadata(normalized);
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

export function createContextModule(input: ContextRecordInput = {}): ContextRecord {
  return createContextRecord('module', input);
}

export function createContextChunk(input: ContextRecordInput = {}): ContextRecord {
  return createContextRecord('chunk', input);
}
