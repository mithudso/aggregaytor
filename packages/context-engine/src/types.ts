/** Search field weights for scoring index documents. */
export interface FieldWeights {
  title: number;
  keywords: number;
  entities: number;
  summary: number;
  excerpt: number;
  body: number;
  source_type: number;
  segment: number;
  [key: string]: number;
}

/** Tokenized search fields for a context record. */
export interface SearchFields {
  title: string[];
  summary: string[];
  excerpt: string[];
  body: string[];
  keywords: string[];
  entities: string[];
  source_type: string[];
  segment: string[];
  [key: string]: string[];
}

/** Input for creating a context record. */
export interface ContextRecordInput {
  id?: string;
  title?: string;
  summary?: string;
  excerpt?: string;
  body?: string;
  keywords?: string[];
  entities?: string[];
  source_type?: string;
  segment?: string;
  updated_at?: string;
  generated_at?: string;
  event_date?: string;
  exact_hash?: string;
  record_type?: string;
  source_ref?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A fully enriched context record. */
export interface ContextRecord extends ContextRecordInput {
  kind: string;
  title: string;
  summary: string;
  excerpt: string;
  body: string;
  keywords: string[];
  entities: string[];
  source_type: string;
  segment: string;
  updated_at: string;
  event_date: string;
  date_bucket: string;
  exact_hash: string;
  minhash_signature: number[];
  lsh_buckets: string[];
  body_tokens: string[];
  search_fields: SearchFields;
}

/** Options for MinHash signature generation. */
export interface MinHashOptions {
  numHashes?: number;
  shingleSize?: number;
}

/** Options for LSH bucket generation. */
export interface LshOptions {
  bands?: number;
}

/** Options for deduplication. */
export interface DedupeOptions {
  nearThreshold?: number;
  tokenThreshold?: number;
}

/** Result of deduplication. */
export interface DedupeResult {
  records: ContextRecord[];
  duplicates: Map<string, { duplicate_of: string; duplicate_kind: 'exact' | 'near' }>;
}

/** An index document for fielded search. */
export interface IndexDocument {
  id: string;
  kind: string;
  segment: string;
  record_type: string;
  source_type: string;
  title: string;
  summary: string;
  excerpt: string;
  keywords: string[];
  entities: string[];
  updated_at: string;
  event_date: string;
  date_bucket: string;
  source_ref: Record<string, unknown>;
  search_fields: SearchFields;
  base_rank: number;
  score?: number;
}

/** A fielded index record containing all documents for an entity. */
export interface FieldedIndexRecord {
  id: string;
  account_id: string;
  generated_at: string;
  documents: IndexDocument[];
}

/** Options for searching a fielded index. */
export interface SearchOptions {
  segments?: string[];
  maxResults?: number;
  maxChunks?: number;
  maxAgeDaysBySegment?: Record<string, number>;
  fieldWeights?: Partial<FieldWeights>;
}

/** Search results. */
export interface SearchResult {
  query_tokens: string[];
  modules: IndexDocument[];
  chunks: IndexDocument[];
}

/** Options for tokenization. */
export interface TokenizeOptions {
  maxTokens?: number;
  stopwords?: Set<string>;
}

/** A generic entity (generalized from mdb-tam Account). */
export interface Entity {
  id: string;
  name: string;
  aliases: string[];
  keywords: string[];
  metadata: Record<string, unknown>;
}

/** Storage adapter for entity persistence. */
export interface EntityStoreAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
