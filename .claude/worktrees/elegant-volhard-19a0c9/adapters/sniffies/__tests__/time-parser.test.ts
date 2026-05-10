import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for parseRelativeTime — the bridge's DOM-scraped time parser.
 *
 * The function lives in extensions/aggregaytor/content/sniffies-bridge.ts
 * (ISOLATED world content script, not importable). We replicate the pure
 * function here to verify the logic, especially the new "a few X ago" branch
 * added in the latest uncommitted changes.
 */

// ── Replicated pure function ───────────────────────────────────────────────

function parseRelativeTime(text: string): string {
  if (!text) return new Date().toISOString();
  const t = text.trim().toLowerCase();
  const now = Date.now();

  const fewMatch = t.match(/(a few|several|some|couple(?:\s+of)?)\s+(second|minute|hour|day)s?\s*(?:ago)?/i);
  if (fewMatch) {
    const unit = fewMatch[2].toLowerCase();
    if (unit.startsWith('s')) return new Date(now - 10_000).toISOString();
    if (unit.startsWith('m')) return new Date(now - 180_000).toISOString();
    if (unit.startsWith('h')) return new Date(now - 7_200_000).toISOString();
    if (unit.startsWith('d')) return new Date(now - 2 * 86400_000).toISOString();
  }

  const match = t.match(/(\d+)\s*(second|sec|month|mo|minute|min|hour|hr|week|year|day|s|m|h|d|w|y)s?\s*(?:ago)?/i)
    || t.match(/(a|an)\s+(minute|hour|day|week|month|year)s?\s*(?:ago)?/i);
  if (!match) {
    if (t.includes('just now') || t.includes('now')) return new Date(now).toISOString();
    if (t.includes('yesterday')) return new Date(now - 86400000).toISOString();
    return new Date().toISOString();
  }
  const num = match[1] === 'a' || match[1] === 'an' ? 1 : parseInt(match[1], 10);
  const unit = (match[2] || '').toLowerCase();
  let ms = 0;
  if (unit.startsWith('s')) ms = num * 1000;
  else if (unit.startsWith('mi') || unit === 'm') ms = num * 60_000;
  else if (unit.startsWith('h')) ms = num * 3600_000;
  else if (unit.startsWith('d')) ms = num * 86400_000;
  else if (unit.startsWith('w')) ms = num * 604800_000;
  else if (unit.startsWith('mo')) ms = num * 2592000_000;
  else if (unit.startsWith('y')) ms = num * 31536000_000;
  return new Date(now - ms).toISOString();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function msAgo(iso: string): number {
  return Date.now() - new Date(iso).getTime();
}

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 86400_000;
const WEEK = 604800_000;

// ── Tests ──────────────────────────────────────────────────────────────────

describe('parseRelativeTime', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-04-22T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  describe('empty/null input', () => {
    it('returns current time for empty string', () => {
      expect(msAgo(parseRelativeTime(''))).toBeLessThan(100);
    });

    it('returns current time for whitespace-only', () => {
      expect(msAgo(parseRelativeTime('   '))).toBeLessThan(100);
    });
  });

  describe('"a few X ago" patterns (new branch)', () => {
    it('parses "a few seconds ago" → ~10s ago', () => {
      const result = parseRelativeTime('a few seconds ago');
      expect(msAgo(result)).toBeCloseTo(10_000, -2);
    });

    it('parses "a few minutes ago" → ~3min ago', () => {
      const result = parseRelativeTime('a few minutes ago');
      expect(msAgo(result)).toBeCloseTo(180_000, -2);
    });

    it('parses "a few hours ago" → ~2h ago', () => {
      const result = parseRelativeTime('a few hours ago');
      expect(msAgo(result)).toBeCloseTo(7_200_000, -2);
    });

    it('parses "a few days ago" → ~2d ago', () => {
      const result = parseRelativeTime('a few days ago');
      expect(msAgo(result)).toBeCloseTo(2 * DAY, -2);
    });

    it('handles "several minutes ago"', () => {
      const result = parseRelativeTime('several minutes ago');
      expect(msAgo(result)).toBeCloseTo(180_000, -2);
    });

    it('handles "some hours ago"', () => {
      const result = parseRelativeTime('some hours ago');
      expect(msAgo(result)).toBeCloseTo(7_200_000, -2);
    });

    it('handles "couple of days ago"', () => {
      const result = parseRelativeTime('couple of days ago');
      expect(msAgo(result)).toBeCloseTo(2 * DAY, -2);
    });

    it('handles "couple minutes ago" (no "of")', () => {
      const result = parseRelativeTime('couple minutes ago');
      expect(msAgo(result)).toBeCloseTo(180_000, -2);
    });

    it('handles singular "a few second ago"', () => {
      const result = parseRelativeTime('a few second ago');
      expect(msAgo(result)).toBeCloseTo(10_000, -2);
    });

    it('handles without "ago" suffix: "a few seconds"', () => {
      const result = parseRelativeTime('a few seconds');
      expect(msAgo(result)).toBeCloseTo(10_000, -2);
    });
  });

  describe('numeric relative time', () => {
    it('parses "5 seconds ago"', () => {
      expect(msAgo(parseRelativeTime('5 seconds ago'))).toBeCloseTo(5 * SECOND, -2);
    });

    it('parses "30s"', () => {
      expect(msAgo(parseRelativeTime('30s'))).toBeCloseTo(30 * SECOND, -2);
    });

    it('parses "5m ago"', () => {
      expect(msAgo(parseRelativeTime('5m ago'))).toBeCloseTo(5 * MINUTE, -2);
    });

    it('parses "10 minutes ago"', () => {
      expect(msAgo(parseRelativeTime('10 minutes ago'))).toBeCloseTo(10 * MINUTE, -2);
    });

    it('parses "2h"', () => {
      expect(msAgo(parseRelativeTime('2h'))).toBeCloseTo(2 * HOUR, -2);
    });

    it('parses "3 hours ago"', () => {
      expect(msAgo(parseRelativeTime('3 hours ago'))).toBeCloseTo(3 * HOUR, -2);
    });

    it('parses "1 hr ago"', () => {
      expect(msAgo(parseRelativeTime('1 hr ago'))).toBeCloseTo(HOUR, -2);
    });

    it('parses "2d"', () => {
      expect(msAgo(parseRelativeTime('2d'))).toBeCloseTo(2 * DAY, -2);
    });

    it('parses "7 days ago"', () => {
      expect(msAgo(parseRelativeTime('7 days ago'))).toBeCloseTo(7 * DAY, -2);
    });

    it('parses "1w"', () => {
      expect(msAgo(parseRelativeTime('1w'))).toBeCloseTo(WEEK, -2);
    });

    it('parses "2 weeks ago"', () => {
      expect(msAgo(parseRelativeTime('2 weeks ago'))).toBeCloseTo(2 * WEEK, -2);
    });

    it('parses "1 month ago" (~30d)', () => {
      expect(msAgo(parseRelativeTime('1 month ago'))).toBeCloseTo(2592000_000, -2);
    });

    it('parses "1 year ago" (~365d)', () => {
      expect(msAgo(parseRelativeTime('1 year ago'))).toBeCloseTo(31536000_000, -2);
    });
  });

  describe('"a/an" unit patterns', () => {
    it('parses "a minute ago"', () => {
      expect(msAgo(parseRelativeTime('a minute ago'))).toBeCloseTo(MINUTE, -2);
    });

    it('parses "an hour ago"', () => {
      expect(msAgo(parseRelativeTime('an hour ago'))).toBeCloseTo(HOUR, -2);
    });

    it('parses "a day ago"', () => {
      expect(msAgo(parseRelativeTime('a day ago'))).toBeCloseTo(DAY, -2);
    });

    it('parses "a week ago"', () => {
      expect(msAgo(parseRelativeTime('a week ago'))).toBeCloseTo(WEEK, -2);
    });
  });

  describe('special strings', () => {
    it('parses "just now" → current time', () => {
      expect(msAgo(parseRelativeTime('just now'))).toBeLessThan(100);
    });

    it('parses "now" → current time', () => {
      expect(msAgo(parseRelativeTime('now'))).toBeLessThan(100);
    });

    it('parses "yesterday" → ~24h ago', () => {
      expect(msAgo(parseRelativeTime('yesterday'))).toBeCloseTo(DAY, -2);
    });
  });

  describe('unparseable input', () => {
    it('defaults to current time for garbage input', () => {
      expect(msAgo(parseRelativeTime('xyzzy frobnicator'))).toBeLessThan(100);
    });

    it('does not warn or throw', () => {
      const spy = vi.spyOn(console, 'warn');
      parseRelativeTime('unknown time format');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('output format', () => {
    it('always returns valid ISO 8601', () => {
      const inputs = ['', '5m ago', 'a few seconds ago', 'yesterday', 'garbage'];
      for (const input of inputs) {
        const result = parseRelativeTime(input);
        expect(new Date(result).toISOString()).toBe(result);
      }
    });
  });
});
