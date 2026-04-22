import { describe, it, expect } from 'vitest';
import { walkPayload } from '../src/payload-walker.js';
import {
  extractTimestamp,
  extractDirection,
  extractMessageText,
  parseRelativeTimeString,
} from '../src/message-normalizer.js';
import { perf } from '../src/perf.js';
import type { PayloadVisitor } from '../src/types.js';

/**
 * Performance benchmarks for adapter-core hot paths.
 *
 * These tests verify that key operations stay within acceptable latency
 * budgets. They are not flaky timing assertions — they use generous ceilings
 * (10-100x slower than typical) to catch algorithmic regressions, not
 * micro-optimization changes.
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function buildDeepPayload(depth: number, breadth: number): Record<string, unknown> {
  if (depth <= 0) return { body: 'leaf', senderId: 'user1', timestamp: Date.now() };
  const children: Record<string, unknown> = {};
  for (let i = 0; i < breadth; i++) {
    children[`child_${i}`] = buildDeepPayload(depth - 1, breadth);
  }
  return { ...children, id: `node-d${depth}` };
}

function buildFlatPayload(count: number): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `msg-${i}`,
      body: `Message content #${i} with some text`,
      senderId: i % 3 === 0 ? 'self-user' : `other-${i}`,
      timestamp: Date.now() - i * 60000,
      isIncoming: i % 3 !== 0,
    });
  }
  return { data: { conversations: [{ messages }] } };
}

// ── walkPayload benchmarks ─────────────────────────────────────────────────

describe('walkPayload performance', () => {
  it('walks a 200-message flat payload in <10ms', () => {
    const payload = buildFlatPayload(200);
    let nodeCount = 0;
    const visitor: PayloadVisitor = { onObject: () => { nodeCount++; } };

    const elapsed = timeMs(() => walkPayload(payload, null, visitor));
    expect(elapsed).toBeLessThan(10);
    expect(nodeCount).toBeGreaterThan(200);
  });

  it('walks a 1000-message flat payload in <50ms', () => {
    const payload = buildFlatPayload(1000);
    let nodeCount = 0;
    const visitor: PayloadVisitor = { onObject: () => { nodeCount++; } };

    const elapsed = timeMs(() => walkPayload(payload, null, visitor));
    expect(elapsed).toBeLessThan(50);
    expect(nodeCount).toBeGreaterThan(0);
  });

  it('walks a deep (depth=7, breadth=3) payload in <10ms', () => {
    const payload = buildDeepPayload(7, 3);
    let nodeCount = 0;
    const visitor: PayloadVisitor = { onObject: () => { nodeCount++; } };

    const elapsed = timeMs(() => walkPayload(payload, null, visitor));
    expect(elapsed).toBeLessThan(10);
    expect(nodeCount).toBeGreaterThan(0);
  });

  it('respects MAX_NODES cap — does not process more than 2000 nodes', () => {
    const payload = buildDeepPayload(7, 5);
    let nodeCount = 0;
    const visitor: PayloadVisitor = { onObject: () => { nodeCount++; } };

    walkPayload(payload, null, visitor);
    expect(nodeCount).toBeLessThanOrEqual(2001);
  });

  it('handles circular references without hanging', () => {
    const a: Record<string, unknown> = { id: 'a' };
    const b: Record<string, unknown> = { id: 'b', ref: a };
    a.ref = b;
    let nodeCount = 0;
    const visitor: PayloadVisitor = { onObject: () => { nodeCount++; } };

    const elapsed = timeMs(() => walkPayload(a, null, visitor));
    expect(elapsed).toBeLessThan(5);
    expect(nodeCount).toBe(2);
  });

  it('propagates contextId to all visited nodes', () => {
    const payload = buildFlatPayload(10);
    const contexts: (string | null)[] = [];
    const visitor: PayloadVisitor = {
      onObject: (_obj, ctx) => { contexts.push(ctx); },
    };

    walkPayload(payload, 'thread-42', visitor);
    expect(contexts.every(c => c === 'thread-42')).toBe(true);
  });
});

// ── Message normalizer benchmarks ──────────────────────────────────────────

describe('message-normalizer performance', () => {
  it('extractTimestamp: 10k extractions in <50ms', () => {
    const payloads = Array.from({ length: 10000 }, (_, i) => ({
      timestamp: `2026-04-22T12:${String(i % 60).padStart(2, '0')}:00Z`,
    }));

    const elapsed = timeMs(() => {
      for (const p of payloads) extractTimestamp(p);
    });
    expect(elapsed).toBeLessThan(50);
  });

  it('extractDirection: 10k extractions in <50ms', () => {
    const selfIds = new Set(['user-self']);
    const payloads = Array.from({ length: 10000 }, (_, i) => ({
      senderId: i % 2 === 0 ? 'user-self' : `user-${i}`,
    }));

    const elapsed = timeMs(() => {
      for (const p of payloads) extractDirection(p, selfIds);
    });
    expect(elapsed).toBeLessThan(50);
  });

  it('extractMessageText: 10k extractions in <50ms', () => {
    const payloads = Array.from({ length: 10000 }, (_, i) => ({
      body: `This is message number ${i} with some content`,
    }));

    const elapsed = timeMs(() => {
      for (const p of payloads) extractMessageText(p);
    });
    expect(elapsed).toBeLessThan(50);
  });

  it('parseRelativeTimeString: 10k parses in <50ms', () => {
    const inputs = ['5m ago', '2h', '3d', '1w', '30s', '15 minutes ago', '24 hours ago'];
    const elapsed = timeMs(() => {
      for (let i = 0; i < 10000; i++) {
        parseRelativeTimeString(inputs[i % inputs.length]);
      }
    });
    expect(elapsed).toBeLessThan(50);
  });
});

// ── PerfCounters overhead benchmark ────────────────────────────────────────

describe('PerfCounters overhead', () => {
  it('start/end overhead is <1µs per call on average (100k calls)', () => {
    perf.reset();
    const elapsed = timeMs(() => {
      for (let i = 0; i < 100_000; i++) {
        const end = perf.start('overhead-bench');
        end();
      }
    });
    const perCallUs = (elapsed / 100_000) * 1000;
    expect(perCallUs).toBeLessThan(5);
    expect(perf.stats()['overhead-bench'].calls).toBe(100_000);
    perf.reset();
  });

  it('count() overhead is <0.5µs per call on average (100k calls)', () => {
    perf.reset();
    const elapsed = timeMs(() => {
      for (let i = 0; i < 100_000; i++) {
        perf.count('count-bench');
      }
    });
    const perCallUs = (elapsed / 100_000) * 1000;
    expect(perCallUs).toBeLessThan(5);
    expect(perf.stats()['count-bench'].calls).toBe(100_000);
    perf.reset();
  });

  it('stats() serialization is <5ms for 100 counters', () => {
    perf.reset();
    for (let i = 0; i < 100; i++) {
      const end = perf.start(`counter-${i}`);
      end();
    }
    const elapsed = timeMs(() => { perf.stats(); });
    expect(elapsed).toBeLessThan(5);
    perf.reset();
  });
});
