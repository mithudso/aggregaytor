import { describe, it, expect } from 'vitest';
import {
  extractTimestamp,
  extractDirection,
  extractMessageText,
  parseRelativeTimeString,
} from '../src/message-normalizer.js';

describe('extractTimestamp', () => {
  it('extracts ISO string timestamp', () => {
    const result = extractTimestamp({ timestamp: '2024-01-15T12:00:00Z' });
    expect(result).toBe('2024-01-15T12:00:00.000Z');
  });

  it('extracts unix seconds timestamp', () => {
    const result = extractTimestamp({ ts: 1700000000 });
    expect(result).toMatch(/2023-11-14/);
  });

  it('extracts unix milliseconds timestamp', () => {
    const result = extractTimestamp({ created_at: 1700000000000 });
    expect(result).toMatch(/2023-11-14/);
  });

  it('returns null when no timestamp found', () => {
    expect(extractTimestamp({ name: 'test' })).toBeNull();
  });

  it('tries multiple key names', () => {
    expect(extractTimestamp({ sentAt: '2024-06-01T00:00:00Z' })).toBeTruthy();
    expect(extractTimestamp({ created_at: '2024-06-01' })).toBeTruthy();
  });
});

describe('extractDirection', () => {
  it('detects incoming from boolean field', () => {
    expect(extractDirection({ isIncoming: true }, new Set())).toBe('in');
    expect(extractDirection({ isIncoming: false }, new Set())).toBe('out');
  });

  it('detects direction from isSelf', () => {
    expect(extractDirection({ isSelf: true }, new Set())).toBe('out');
    expect(extractDirection({ isSelf: false }, new Set())).toBe('in');
  });

  it('detects direction from string field', () => {
    expect(extractDirection({ direction: 'incoming' }, new Set())).toBe('in');
    expect(extractDirection({ direction: 'sent' }, new Set())).toBe('out');
  });

  it('uses selfIds to detect outgoing', () => {
    const selfIds = new Set(['user123']);
    expect(extractDirection({ senderId: 'user123' }, selfIds)).toBe('out');
    expect(extractDirection({ senderId: 'other456' }, selfIds)).toBe('in');
  });

  it('returns null when no direction info', () => {
    expect(extractDirection({ name: 'test' }, new Set())).toBeNull();
  });
});

describe('extractMessageText', () => {
  it('extracts body text', () => {
    expect(extractMessageText({ body: 'hello world' })).toBe('hello world');
  });

  it('tries multiple key names', () => {
    expect(extractMessageText({ text: 'hi' })).toBe('hi');
    expect(extractMessageText({ message: 'hey' })).toBe('hey');
    expect(extractMessageText({ content: 'yo' })).toBe('yo');
  });

  it('returns null for empty/missing text', () => {
    expect(extractMessageText({ body: '' })).toBeNull();
    expect(extractMessageText({ name: 'test' })).toBeNull();
  });

  it('trims whitespace', () => {
    expect(extractMessageText({ body: '  spaced  ' })).toBe('spaced');
  });
});

describe('parseRelativeTimeString', () => {
  it('parses minutes', () => {
    const result = parseRelativeTimeString('5m ago');
    expect(result).toBeGreaterThan(Date.now() - 6 * 60000);
    expect(result).toBeLessThanOrEqual(Date.now());
  });

  it('parses hours', () => {
    const result = parseRelativeTimeString('2h');
    expect(result).toBeGreaterThan(Date.now() - 3 * 3600000);
    // Upper bound: without it, a function that ignored the unit and returned
    // Date.now() would still pass.
    expect(result).toBeLessThanOrEqual(Date.now() - 2 * 3600000);
  });

  it('parses days', () => {
    const result = parseRelativeTimeString('3d');
    expect(result).toBeGreaterThan(Date.now() - 4 * 86400000);
    expect(result).toBeLessThanOrEqual(Date.now() - 3 * 86400000);
  });

  it('returns null for unparseable input', () => {
    expect(parseRelativeTimeString('')).toBeNull();
    expect(parseRelativeTimeString('yesterday')).toBeNull();
  });
});
