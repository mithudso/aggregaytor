/**
 * search.ts — Fielded search index with weighted scoring.
 *
 * Extracted from mdb-tam context-modules.js lines 377-477.
 */

import { tokenizeIndexText } from './tokenize.js';
import { buildRecordSearchFields } from './records.js';
import type {
  ContextRecord,
  FieldWeights,
  FieldedIndexRecord,
  IndexDocument,
  SearchFields,
  SearchOptions,
  SearchResult,
} from './types.js';

export const DEFAULT_FIELD_WEIGHTS: FieldWeights = {
  title: 8,
  keywords: 6,
  entities: 5,
  summary: 4,
  excerpt: 3,
  body: 1,
  source_type: 2,
  segment: 1,
};

function buildIndexDocument(record: Partial<ContextRecord>): IndexDocument {
  return {
    id: record.id || '',
    kind: record.kind || '',
    segment: record.segment || '',
    record_type: record.record_type || '',
    source_type: record.source_type || '',
    title: record.title || '',
    summary: record.summary || '',
    excerpt: record.excerpt || '',
    keywords: Array.isArray(record.keywords) ? record.keywords : [],
    entities: Array.isArray(record.entities) ? record.entities : [],
    updated_at: record.updated_at || '',
    event_date: record.event_date || '',
    date_bucket: record.date_bucket || '',
    source_ref: (record.source_ref as Record<string, unknown>) || {},
    search_fields: record.search_fields || buildRecordSearchFields(record),
    base_rank: record.kind === 'chunk' ? 1 : 2,
  };
}

export function buildFieldedIndexRecord(
  entityId: string,
  modules: ContextRecord[] = [],
  chunks: ContextRecord[] = [],
  generatedAt = new Date().toISOString(),
): FieldedIndexRecord {
  return {
    id: `${entityId}_active`,
    account_id: entityId,
    generated_at: generatedAt,
    documents: [
      ...modules.map(buildIndexDocument),
      ...chunks.map(buildIndexDocument),
    ],
  };
}

function scoreIndexDocument(
  doc: IndexDocument,
  queryTokens: string[],
  weights: FieldWeights,
): number {
  const fields: SearchFields = doc.search_fields || ({} as SearchFields);
  let score = 0;
  for (const [fieldName, weight] of Object.entries(weights)) {
    const tokens = Array.isArray(fields[fieldName]) ? fields[fieldName] : [];
    if (!tokens.length) continue;
    let matches = 0;
    for (const token of queryTokens) {
      if (tokens.includes(token)) matches += 1;
    }
    if (matches) score += matches * weight;
  }
  const recencyTs = Date.parse(doc.event_date || doc.updated_at || '') || 0;
  score += doc.base_rank || 0;
  score += recencyTs ? Math.min(2, recencyTs / 86400000 / 100000) : 0;
  return score;
}

function isDocumentWithinAge(
  doc: IndexDocument,
  maxAgeDaysBySegment: Record<string, number>,
): boolean {
  const segment = String(doc.segment || '');
  const maxAgeDays = Number(maxAgeDaysBySegment?.[segment] || 0);
  if (!maxAgeDays) return true;
  const ts = Date.parse(doc.event_date || doc.updated_at || '') || 0;
  if (!ts) return true;
  return Date.now() - ts <= maxAgeDays * 86400000;
}

export function searchFieldedIndex(
  indexRecord: FieldedIndexRecord,
  queryText: string,
  opts: SearchOptions = {},
): SearchResult {
  const queryTokens = tokenizeIndexText(queryText, 32);
  const wantedSegments = new Set(Array.isArray(opts.segments) ? opts.segments : []);
  const maxResults = Math.max(1, Number(opts.maxResults) || 24);
  const maxChunks = Math.max(1, Number(opts.maxChunks) || 12);
  const maxAgeDaysBySegment = opts.maxAgeDaysBySegment || {};
  const weights: FieldWeights = {
    ...DEFAULT_FIELD_WEIGHTS,
    ...(opts.fieldWeights as Record<string, number> | undefined),
  };
  const documents = Array.isArray(indexRecord.documents) ? indexRecord.documents : [];

  // Filter and score in one pass over `{ doc, score }` pairs. Copying every
  // surviving document up front (`{ ...doc, score }`) cloned the whole index on
  // every search; only the handful actually returned needs a copy.
  const scored: Array<{ doc: IndexDocument; score: number }> = [];
  for (const doc of documents) {
    if (wantedSegments.size && !wantedSegments.has(doc.segment)) continue;
    if (!isDocumentWithinAge(doc, maxAgeDaysBySegment)) continue;
    if (!queryTokens.length) {
      scored.push({ doc, score: doc.base_rank || 0 });
      continue;
    }
    const score = scoreIndexDocument(doc, queryTokens, weights);
    if (score > 0) scored.push({ doc, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTs = Date.parse(a.doc.event_date || a.doc.updated_at || '') || 0;
    const bTs = Date.parse(b.doc.event_date || b.doc.updated_at || '') || 0;
    return bTs - aTs;
  });

  const modules: IndexDocument[] = [];
  const chunks: IndexDocument[] = [];
  for (const { doc, score } of scored) {
    if (doc.kind === 'chunk') {
      if (chunks.length < maxChunks) chunks.push({ ...doc, score });
      continue;
    }
    if (modules.length < maxResults) modules.push({ ...doc, score });
    if (modules.length >= maxResults && chunks.length >= maxChunks) break;
  }

  return { query_tokens: queryTokens, modules, chunks };
}
