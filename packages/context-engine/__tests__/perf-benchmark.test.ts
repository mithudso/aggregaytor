import { describe, it, expect } from 'vitest';
import { stableContentHash } from '../src/hash.js';
import { normalizeContextText, applyCommonReplacements } from '../src/normalize.js';
import { createContextModule } from '../src/records.js';
import { buildFieldedIndexRecord, searchFieldedIndex } from '../src/search.js';

/**
 * Performance benchmarks for context-engine hot paths.
 *
 * Tests verify key operations stay within generous latency budgets.
 * Ceilings are 10-100x above typical to catch regressions, not
 * micro-optimization noise.
 */

function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

// ── Hashing benchmarks ─────────────────────────────────────────────────────

describe('stableContentHash performance', () => {
  it('hashes 10k short strings in <100ms', () => {
    const inputs = Array.from({ length: 10000 }, (_, i) => `message body ${i}`);
    const elapsed = timeMs(() => {
      for (const s of inputs) stableContentHash(s);
    });
    expect(elapsed).toBeLessThan(100);
  });

  it('hashes a 10KB string in <5ms', () => {
    const longStr = 'a'.repeat(10_000);
    const elapsed = timeMs(() => stableContentHash(longStr));
    expect(elapsed).toBeLessThan(5);
  });

  it('hashes a 100KB string in <50ms', () => {
    const longStr = 'abcdefghij'.repeat(10_000);
    const elapsed = timeMs(() => stableContentHash(longStr));
    expect(elapsed).toBeLessThan(50);
  });

  it('produces unique hashes for 1000 distinct inputs (no collisions)', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(stableContentHash(`unique input number ${i}`));
    }
    expect(hashes.size).toBe(1000);
  });
});

// ── Normalization benchmarks ───────────────────────────────────────────────

describe('normalizeContextText performance', () => {
  it('normalizes 10k strings in <50ms', () => {
    const inputs = Array.from({ length: 10000 }, (_, i) =>
      `  Hello\u00a0world  \t\r\n  message ${i}  \u200b\uFEFF`
    );
    const elapsed = timeMs(() => {
      for (const s of inputs) normalizeContextText(s);
    });
    expect(elapsed).toBeLessThan(50);
  });

  it('applyCommonReplacements: 10k strings in <50ms', () => {
    const inputs = Array.from({ length: 10000 }, (_, i) =>
      `\u201cHello\u201d \u2013 message\u00a0${i}`
    );
    const elapsed = timeMs(() => {
      for (const s of inputs) applyCommonReplacements(s);
    });
    expect(elapsed).toBeLessThan(50);
  });
});

// ── Search index benchmarks ────────────────────────────────────────────────

describe('searchFieldedIndex performance', () => {
  const moduleCount = 500;
  const modules = Array.from({ length: moduleCount }, (_, i) =>
    createContextModule({
      id: `mod-${i}`,
      title: `Module ${i}: ${['Database', 'API', 'Auth', 'Cache', 'Queue'][i % 5]} ${['Guide', 'Report', 'Spec', 'Plan'][i % 4]}`,
      summary: `Detailed summary for module ${i} covering ${['performance', 'security', 'scaling', 'deployment', 'monitoring'][i % 5]}`,
      keywords: [
        ['database', 'migration', 'postgresql'][i % 3],
        ['api', 'rest', 'graphql'][i % 3],
        ['latency', 'throughput', 'availability'][i % 3],
      ],
      segment: ['docs', 'reports', 'specs'][i % 3],
    })
  );
  const index = buildFieldedIndexRecord('perf-test', modules, []);

  it('builds a 500-module index in <50ms', () => {
    const elapsed = timeMs(() => {
      buildFieldedIndexRecord('perf-test', modules, []);
    });
    expect(elapsed).toBeLessThan(50);
  });

  it('searches a 500-module index in <10ms', () => {
    const elapsed = timeMs(() => {
      searchFieldedIndex(index, 'database migration performance');
    });
    expect(elapsed).toBeLessThan(10);
  });

  it('runs 100 searches against a 500-module index in <100ms', () => {
    const queries = [
      'database migration', 'api latency', 'auth security',
      'cache performance', 'queue scaling', 'deployment guide',
      'monitoring report', 'postgresql rest', 'graphql throughput',
      'availability spec',
    ];
    const elapsed = timeMs(() => {
      for (let i = 0; i < 100; i++) {
        searchFieldedIndex(index, queries[i % queries.length]);
      }
    });
    expect(elapsed).toBeLessThan(100);
  });

  it('empty query returns all modules quickly (<10ms)', () => {
    const elapsed = timeMs(() => {
      const result = searchFieldedIndex(index, '');
      expect(result.modules.length).toBe(Math.min(moduleCount, 24));
    });
    expect(elapsed).toBeLessThan(10);
  });

  it('segment-filtered search is not slower than unfiltered', () => {
    const unfilteredTime = timeMs(() => {
      for (let i = 0; i < 50; i++) searchFieldedIndex(index, 'database');
    });
    const filteredTime = timeMs(() => {
      for (let i = 0; i < 50; i++) searchFieldedIndex(index, 'database', { segments: ['docs'] });
    });
    // Filtered should be same order of magnitude (possibly faster)
    expect(filteredTime).toBeLessThan(unfilteredTime * 3);
  });
});
