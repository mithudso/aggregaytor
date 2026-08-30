import { describe, it, expect } from 'vitest';
import { createContextModule } from '../src/records.js';
import { buildFieldedIndexRecord, searchFieldedIndex } from '../src/search.js';

describe('searchFieldedIndex', () => {
  const modules = [
    createContextModule({
      id: 'mod1',
      title: 'Database Migration Guide',
      summary: 'Steps to migrate PostgreSQL to MongoDB Atlas',
      keywords: ['migration', 'postgresql', 'mongodb', 'atlas'],
      segment: 'docs',
    }),
    createContextModule({
      id: 'mod2',
      title: 'API Performance Report',
      summary: 'Latency analysis for REST endpoints under load',
      keywords: ['performance', 'api', 'latency'],
      segment: 'reports',
    }),
    createContextModule({
      id: 'mod3',
      title: 'Onboarding Checklist',
      summary: 'New employee setup steps and access requests',
      keywords: ['onboarding', 'checklist'],
      segment: 'docs',
    }),
  ];

  const index = buildFieldedIndexRecord('test-entity', modules, []);

  it('finds documents matching query tokens', () => {
    const result = searchFieldedIndex(index, 'migration mongodb');
    expect(result.modules.length).toBeGreaterThan(0);
    expect(result.modules[0].id).toBe('mod1');
  });

  it('ranks by relevance', () => {
    const result = searchFieldedIndex(index, 'performance api latency');
    expect(result.modules[0].id).toBe('mod2');
  });

  it('filters by segment', () => {
    const result = searchFieldedIndex(index, 'migration', { segments: ['reports'] });
    // Guard: `.every()` on an empty array is vacuously true, so a filter that
    // dropped everything would pass the segment assertion below.
    expect(result.modules.length).toBeGreaterThan(0);
    expect(result.modules.every(m => m.segment === 'reports')).toBe(true);
  });

  it('returns fewer results for non-matching query', () => {
    const matching = searchFieldedIndex(index, 'migration mongodb');
    const nonMatching = searchFieldedIndex(index, 'xyzzy frobnicator');
    // Non-matching still returns results (base_rank > 0), but top result differs
    expect(matching.modules[0].score!).toBeGreaterThan(nonMatching.modules[0].score!);
  });

  it('returns all when query is empty', () => {
    const result = searchFieldedIndex(index, '');
    expect(result.modules.length).toBe(modules.length);
  });
});
