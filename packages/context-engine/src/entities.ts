/**
 * entities.ts — Generic entity management with keyword-based inference.
 *
 * Generalized from mdb-tam accounts.js. Replaces chrome.storage.local
 * with an abstract EntityStoreAdapter for cross-environment use.
 */

import type { Entity, EntityStoreAdapter } from './types.js';

const ENTITIES_STORAGE_KEY = 'aggregaytor_entities';

function normalizeTerm(value: string): string {
  return String(value || '').trim();
}

/** True for [a-zA-Z0-9]; '' (a missing neighbour) counts as a word boundary. */
function isWordChar(char: string): boolean {
  return (char >= 'a' && char <= 'z')
    || (char >= 'A' && char <= 'Z')
    || (char >= '0' && char <= '9');
}

/**
 * Term match against an *already lowercased* haystack.
 *
 * Equivalent to the previous `(^|[^a-z0-9])term([^a-z0-9]|$)` regex for short
 * terms, minus the per-call RegExp compile: it walks every occurrence and
 * accepts the first one whose neighbours are non-alphanumeric or absent.
 */
function matchesLoweredText(haystack: string, term: string): boolean {
  const needle = normalizeTerm(term).toLowerCase();
  if (!haystack || !needle) return false;
  if (needle.length > 3) return haystack.includes(needle);
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at > 0 ? haystack[at - 1] : '';
    const after = haystack[at + needle.length] ?? '';
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

export function normalizeEntities(entities: Partial<Entity>[]): Entity[] {
  return entities.map(entity => ({
    id: normalizeTerm(entity.id || ''),
    name: normalizeTerm(entity.name || ''),
    aliases: Array.from(new Set((entity.aliases || []).map(normalizeTerm).filter(Boolean))),
    keywords: Array.from(new Set((entity.keywords || []).map(normalizeTerm).filter(Boolean))),
    metadata: entity.metadata || {},
  }));
}

export function buildSearchTerms(entity: Entity): string[] {
  const terms = [
    entity.name,
    ...entity.aliases,
    ...entity.keywords,
  ];
  return Array.from(new Set(terms.map(normalizeTerm).filter(Boolean)))
    .sort((a, b) => b.length - a.length);
}

export function termMatchesText(text: string, term: string): boolean {
  return matchesLoweredText(String(text || '').toLowerCase(), term);
}

export function inferEntityId(entities: Entity[], text: string): string | null {
  // Lowercased once: going through termMatchesText re-lowercased the whole
  // text for every term of every entity, i.e. O(entities x terms x |text|).
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return null;
  for (const entity of entities) {
    for (const term of buildSearchTerms(entity)) {
      if (matchesLoweredText(haystack, term)) {
        return entity.id;
      }
    }
  }
  return null;
}

export function inferEntityName(entities: Entity[], text: string): string {
  const id = inferEntityId(entities, text);
  if (id) {
    const entity = entities.find(e => e.id === id);
    return entity?.name || 'Unknown';
  }
  return 'Unknown';
}

/**
 * EntityStore — manages entity persistence through a pluggable adapter.
 *
 * Usage:
 *   const store = new EntityStore(adapter);
 *   await store.load();
 *   const id = store.inferFromText('some text mentioning a known entity');
 */
export class EntityStore {
  private cache: Entity[] | null = null;
  private loading: Promise<Entity[]> | null = null;
  private adapter: EntityStoreAdapter;
  private storageKey: string;

  constructor(adapter: EntityStoreAdapter, storageKey = ENTITIES_STORAGE_KEY) {
    this.adapter = adapter;
    this.storageKey = storageKey;
  }

  async load(): Promise<Entity[]> {
    if (this.cache) return this.cache;
    // Concurrent callers (several service-worker messages in the same tick)
    // share one adapter read rather than each issuing their own.
    if (!this.loading) {
      this.loading = (async () => {
        const data = await this.adapter.get(this.storageKey);
        const loaded = Array.isArray(data) ? normalizeEntities(data as Partial<Entity>[]) : [];
        // A save that landed while this read was in flight is newer than what
        // came back, so it wins.
        if (!this.cache) this.cache = loaded;
        return this.cache;
      })();
      // Clear on settle so a failed read is retried rather than cached.
      this.loading.catch(() => {}).finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  async save(entities: Entity[]): Promise<void> {
    const normalized = normalizeEntities(entities);
    await this.adapter.set(this.storageKey, normalized);
    // Adopted only once the write lands: updating the cache first left the
    // in-memory copy ahead of storage whenever the adapter threw.
    this.cache = normalized;
  }

  async get(id: string): Promise<Entity | undefined> {
    const entities = await this.load();
    return entities.find(e => e.id === id);
  }

  async ids(): Promise<string[]> {
    const entities = await this.load();
    return entities.map(e => e.id);
  }

  async inferFromText(text: string): Promise<string | null> {
    const entities = await this.load();
    return inferEntityId(entities, text);
  }

  async inferNameFromText(text: string): Promise<string> {
    const entities = await this.load();
    return inferEntityName(entities, text);
  }

  invalidateCache(): void {
    this.cache = null;
    // Drop any in-flight read too, so the next load() re-reads the adapter
    // instead of resolving with data fetched before the invalidation.
    this.loading = null;
  }
}
