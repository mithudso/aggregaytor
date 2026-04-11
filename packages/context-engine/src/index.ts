/**
 * @aggregaytor/context-engine
 *
 * Text normalization, content hashing, near-duplicate detection,
 * fielded search indexing, and entity management.
 *
 * Extracted from mdb-tam (context-modules.js + accounts.js).
 */

// Types
export type {
  FieldWeights,
  SearchFields,
  ContextRecordInput,
  ContextRecord,
  MinHashOptions,
  LshOptions,
  DedupeOptions,
  DedupeResult,
  IndexDocument,
  FieldedIndexRecord,
  SearchOptions,
  SearchResult,
  TokenizeOptions,
  Entity,
  EntityStoreAdapter,
} from './types.js';

// Normalize
export { normalizeContextText, applyCommonReplacements, maybeRepairMojibake } from './normalize.js';

// Hash
export { stableContentHash } from './hash.js';

// Tokenize
export { tokenizeIndexText, normalizeSearchText, DEFAULT_STOPWORDS } from './tokenize.js';

// MinHash
export { buildMinHashSignature, buildShingles, seededHash } from './minhash.js';

// LSH
export { buildLshBuckets, estimateSignatureSimilarity, estimateTokenJaccard } from './lsh.js';

// Records
export {
  createContextRecord,
  createContextModule,
  createContextChunk,
  buildRecordSearchFields,
  buildDateBucket,
} from './records.js';

// Dedup
export { dedupeContextRecords } from './dedup.js';

// Search
export {
  buildFieldedIndexRecord,
  searchFieldedIndex,
  DEFAULT_FIELD_WEIGHTS,
} from './search.js';

// Entities
export {
  normalizeEntities,
  buildSearchTerms,
  termMatchesText,
  inferEntityId,
  inferEntityName,
  EntityStore,
} from './entities.js';
