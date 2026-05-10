/**
 * perf.ts — Ultra-lightweight performance counters.
 *
 * Tracks call count and cumulative wall-clock time for instrumented code paths.
 * All data lives in a plain JS object in memory — zero I/O, zero allocation
 * beyond the counter object itself. The overhead per measurement is two
 * `performance.now()` calls (~50ns each) and one object property increment.
 *
 * ## Usage
 *
 * ```ts
 * import { perf } from './perf.js';
 *
 * // Instrument a code section:
 * const end = perf.start('parseApiResponse');
 * // ... do work ...
 * end();  // records elapsed time
 *
 * // Check stats from console:
 * console.table(perf.stats());
 * // Or: JSON.stringify(perf.stats(), null, 2)
 * ```
 *
 * ## Exposed globals
 *
 * In the MAIN world content script, `window.__aggregaytor_perf` is set to
 * the perf instance so you can inspect it from DevTools:
 *   __aggregaytor_perf.stats()
 *   __aggregaytor_perf.reset()
 */

interface PerfEntry {
  /** Number of times this counter was started+ended */
  calls: number;
  /** Cumulative elapsed time in milliseconds */
  totalMs: number;
  /** Maximum single-call elapsed time in milliseconds */
  maxMs: number;
  /** Timestamp of the last call (for recency context) */
  lastAt: number;
}

class PerfCounters {
  private counters = new Map<string, PerfEntry>();
  private startTime = Date.now();

  /**
   * Start timing a named code section. Returns a function that,
   * when called, stops the timer and records the elapsed time.
   * If the end function is never called (e.g. due to early return),
   * no time is recorded — counters stay consistent.
   */
  start(name: string): () => void {
    const t0 = performance.now();
    return () => {
      const elapsed = performance.now() - t0;
      let entry = this.counters.get(name);
      if (!entry) {
        entry = { calls: 0, totalMs: 0, maxMs: 0, lastAt: 0 };
        this.counters.set(name, entry);
      }
      entry.calls++;
      entry.totalMs += elapsed;
      if (elapsed > entry.maxMs) entry.maxMs = elapsed;
      entry.lastAt = Date.now();
    };
  }

  /** Increment a counter without timing (for counting events). */
  count(name: string): void {
    let entry = this.counters.get(name);
    if (!entry) {
      entry = { calls: 0, totalMs: 0, maxMs: 0, lastAt: 0 };
      this.counters.set(name, entry);
    }
    entry.calls++;
    entry.lastAt = Date.now();
  }

  /**
   * Return all counters as a plain object, sorted by total CPU time descending.
   * Includes an `avgMs` computed field and `callsPerMin` rate.
   */
  stats(): Record<string, PerfEntry & { avgMs: number; callsPerMin: number }> {
    const uptimeMin = Math.max(1, (Date.now() - this.startTime) / 60_000);
    const entries = [...this.counters.entries()]
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .map(([name, e]) => [name, {
        ...e,
        totalMs: Math.round(e.totalMs * 100) / 100,
        maxMs: Math.round(e.maxMs * 100) / 100,
        avgMs: e.calls ? Math.round((e.totalMs / e.calls) * 100) / 100 : 0,
        callsPerMin: Math.round((e.calls / uptimeMin) * 10) / 10,
      }] as const);
    return Object.fromEntries(entries);
  }

  /** Reset all counters. */
  reset(): void {
    this.counters.clear();
    this.startTime = Date.now();
  }

  /** How long the counters have been collecting, in minutes. */
  uptimeMin(): number {
    return Math.round((Date.now() - this.startTime) / 60_000 * 10) / 10;
  }
}

/** Singleton perf counter instance. */
export const perf = new PerfCounters();
