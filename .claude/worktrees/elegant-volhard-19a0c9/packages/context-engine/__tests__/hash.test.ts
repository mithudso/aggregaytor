import { describe, it, expect } from 'vitest';
import { stableContentHash } from '../src/hash.js';

describe('stableContentHash', () => {
  it('returns a hex string prefixed with h', () => {
    const hash = stableContentHash('hello world');
    expect(hash).toMatch(/^h[0-9a-f]{16}$/);
  });

  it('produces deterministic output', () => {
    const a = stableContentHash('test input');
    const b = stableContentHash('test input');
    expect(a).toBe(b);
  });

  it('produces different hashes for different input', () => {
    const a = stableContentHash('input A');
    const b = stableContentHash('input B');
    expect(a).not.toBe(b);
  });

  it('normalizes before hashing', () => {
    const a = stableContentHash('hello   world');
    const b = stableContentHash('hello world');
    expect(a).toBe(b);
  });

  it('handles empty input', () => {
    const hash = stableContentHash('');
    expect(hash).toMatch(/^h[0-9a-f]{16}$/);
  });
});
