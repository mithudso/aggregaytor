import { describe, it, expect } from 'vitest';
import {
  normalizeEntities,
  buildSearchTerms,
  termMatchesText,
  inferEntityId,
  EntityStore,
} from '../src/entities.js';
import type { Entity, EntityStoreAdapter } from '../src/types.js';

const testEntities: Entity[] = normalizeEntities([
  { id: 'acme', name: 'Acme Corp', aliases: ['Acme'], keywords: ['acme', 'roadrunner'] },
  { id: 'globex', name: 'Globex Corporation', aliases: ['GX'], keywords: ['globex', 'gx'] },
]);

describe('normalizeEntities', () => {
  it('fills missing fields with defaults', () => {
    const result = normalizeEntities([{ id: 'test', name: 'Test' }]);
    expect(result[0].aliases).toEqual([]);
    expect(result[0].keywords).toEqual([]);
    expect(result[0].metadata).toEqual({});
  });

  it('deduplicates arrays', () => {
    const result = normalizeEntities([
      { id: 'test', name: 'Test', aliases: ['a', 'a', 'b'] },
    ]);
    expect(result[0].aliases).toEqual(['a', 'b']);
  });
});

describe('buildSearchTerms', () => {
  it('combines name, aliases, and keywords sorted by length', () => {
    const terms = buildSearchTerms(testEntities[0]);
    expect(terms).toContain('Acme Corp');
    expect(terms).toContain('Acme');
    expect(terms).toContain('roadrunner');
    expect(terms[0].length).toBeGreaterThanOrEqual(terms[terms.length - 1].length);
  });
});

describe('termMatchesText', () => {
  it('matches substring for terms > 3 chars', () => {
    expect(termMatchesText('I work at Acme Corp daily', 'acme')).toBe(true);
  });

  it('requires word boundary for short terms', () => {
    expect(termMatchesText('the gx team', 'gx')).toBe(true);
    expect(termMatchesText('oxygen tank', 'gx')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(termMatchesText('ACME CORP', 'acme')).toBe(true);
  });

  it('handles empty inputs', () => {
    expect(termMatchesText('', 'test')).toBe(false);
    expect(termMatchesText('test', '')).toBe(false);
  });
});

describe('inferEntityId', () => {
  it('infers entity from matching text', () => {
    expect(inferEntityId(testEntities, 'Meeting with Acme Corp team')).toBe('acme');
    expect(inferEntityId(testEntities, 'Globex project update')).toBe('globex');
  });

  it('returns null when no match', () => {
    expect(inferEntityId(testEntities, 'unrelated text')).toBeNull();
  });
});

describe('EntityStore', () => {
  function createMemoryAdapter(): EntityStoreAdapter {
    const store = new Map<string, unknown>();
    return {
      get: async (key) => store.get(key),
      set: async (key, value) => { store.set(key, value); },
    };
  }

  it('loads and saves entities', async () => {
    const store = new EntityStore(createMemoryAdapter());
    await store.save(testEntities);
    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].name).toBe('Acme Corp');
  });

  it('infers from text', async () => {
    const store = new EntityStore(createMemoryAdapter());
    await store.save(testEntities);
    const id = await store.inferFromText('roadrunner incident');
    expect(id).toBe('acme');
  });

  it('returns empty array when no saved data', async () => {
    const store = new EntityStore(createMemoryAdapter());
    const loaded = await store.load();
    expect(loaded).toEqual([]);
  });
});
