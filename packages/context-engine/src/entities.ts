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

function escapeRegExp(value: string): string {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const haystack = String(text || '').toLowerCase();
  const needle = normalizeTerm(term).toLowerCase();
  if (!haystack || !needle) return false;
  if (needle.length <= 3) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, 'i').test(haystack);
  }
  return haystack.includes(needle);
}

export function inferEntityId(entities: Entity[], text: string): string | null {
  for (const entity of entities) {
    const terms = buildSearchTerms(entity);
    for (const term of terms) {
      if (termMatchesText(text, term)) {
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
  private adapter: EntityStoreAdapter;
  private storageKey: string;

  constructor(adapter: EntityStoreAdapter, storageKey = ENTITIES_STORAGE_KEY) {
    this.adapter = adapter;
    this.storageKey = storageKey;
  }

  async load(): Promise<Entity[]> {
    if (this.cache) return this.cache;
    const data = await this.adapter.get(this.storageKey);
    this.cache = Array.isArray(data) ? normalizeEntities(data as Partial<Entity>[]) : [];
    return this.cache;
  }

  async save(entities: Entity[]): Promise<void> {
    this.cache = normalizeEntities(entities);
    await this.adapter.set(this.storageKey, this.cache);
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
  }
}
