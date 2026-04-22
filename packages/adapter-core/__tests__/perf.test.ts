import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { perf } from '../src/perf.js';

describe('PerfCounters', () => {
  beforeEach(() => {
    perf.reset();
  });

  describe('start/end timing', () => {
    it('records a single call', () => {
      const end = perf.start('test-op');
      end();
      const stats = perf.stats();
      expect(stats['test-op']).toBeDefined();
      expect(stats['test-op'].calls).toBe(1);
      expect(stats['test-op'].totalMs).toBeGreaterThanOrEqual(0);
    });

    it('accumulates across multiple calls', () => {
      for (let i = 0; i < 5; i++) {
        const end = perf.start('multi');
        end();
      }
      expect(perf.stats()['multi'].calls).toBe(5);
    });

    it('tracks maxMs as the worst single call', () => {
      // All calls are ~instant, so maxMs should be small
      for (let i = 0; i < 3; i++) {
        const end = perf.start('max-test');
        end();
      }
      const s = perf.stats()['max-test'];
      expect(s.maxMs).toBeGreaterThanOrEqual(0);
      expect(s.maxMs).toBeLessThanOrEqual(s.totalMs);
    });

    it('does not record if end() is never called', () => {
      perf.start('abandoned');
      expect(perf.stats()['abandoned']).toBeUndefined();
    });

    it('end() can be called multiple times safely (second call still records)', () => {
      const end = perf.start('double-end');
      end();
      end();
      expect(perf.stats()['double-end'].calls).toBe(2);
    });
  });

  describe('count()', () => {
    it('increments call count without timing', () => {
      perf.count('event-a');
      perf.count('event-a');
      perf.count('event-a');
      const s = perf.stats()['event-a'];
      expect(s.calls).toBe(3);
      expect(s.totalMs).toBe(0);
    });

    it('sets lastAt timestamp', () => {
      perf.count('event-b');
      const s = perf.stats()['event-b'];
      expect(s.lastAt).toBeGreaterThan(0);
    });
  });

  describe('stats()', () => {
    it('returns empty object after reset', () => {
      expect(Object.keys(perf.stats()).length).toBe(0);
    });

    it('includes computed avgMs', () => {
      for (let i = 0; i < 3; i++) {
        const end = perf.start('avg-test');
        end();
      }
      const s = perf.stats()['avg-test'];
      expect(s.avgMs).toBeCloseTo(s.totalMs / s.calls, 1);
    });

    it('includes callsPerMin rate', () => {
      perf.count('rate-test');
      const s = perf.stats()['rate-test'];
      expect(s.callsPerMin).toBeGreaterThan(0);
    });

    it('sorts entries by totalMs descending', () => {
      // fast op
      const endFast = perf.start('fast');
      endFast();
      // "slow" op (can't truly delay in a unit test, but we can count more)
      for (let i = 0; i < 100; i++) {
        const end = perf.start('many-calls');
        end();
      }
      const keys = Object.keys(perf.stats());
      const stats = perf.stats();
      expect(stats[keys[0]].totalMs).toBeGreaterThanOrEqual(stats[keys[1]].totalMs);
    });
  });

  describe('reset()', () => {
    it('clears all counters', () => {
      perf.count('a');
      perf.count('b');
      perf.reset();
      expect(Object.keys(perf.stats()).length).toBe(0);
    });
  });

  describe('uptimeMin()', () => {
    it('returns a non-negative number', () => {
      expect(perf.uptimeMin()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('multiple named counters', () => {
    it('keeps counters independent', () => {
      const endA = perf.start('op-a');
      endA();
      perf.count('op-b');
      perf.count('op-b');

      const stats = perf.stats();
      expect(stats['op-a'].calls).toBe(1);
      expect(stats['op-b'].calls).toBe(2);
      expect(stats['op-a'].totalMs).toBeGreaterThanOrEqual(0);
      expect(stats['op-b'].totalMs).toBe(0);
    });
  });
});
