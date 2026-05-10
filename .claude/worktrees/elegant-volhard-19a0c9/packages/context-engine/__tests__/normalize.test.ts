import { describe, it, expect } from 'vitest';
import { normalizeContextText, applyCommonReplacements, maybeRepairMojibake } from '../src/normalize.js';

describe('applyCommonReplacements', () => {
  it('replaces non-breaking spaces', () => {
    expect(applyCommonReplacements('hello\u00a0world')).toBe('hello world');
  });

  it('replaces smart quotes', () => {
    expect(applyCommonReplacements('\u201chello\u201d')).toBe('"hello"');
    expect(applyCommonReplacements('\u2018hi\u2019')).toBe("'hi'");
  });

  it('replaces dashes and bullets', () => {
    expect(applyCommonReplacements('a\u2013b\u2014c')).toBe('a-b-c');
    expect(applyCommonReplacements('\u2022 item')).toBe('- item');
  });

  it('strips zero-width characters', () => {
    expect(applyCommonReplacements('a\u200bb\u200cc\uFEFF')).toBe('abc');
  });
});

describe('normalizeContextText', () => {
  it('trims whitespace', () => {
    expect(normalizeContextText('  hello  ')).toBe('hello');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeContextText('hello   world')).toBe('hello world');
  });

  it('collapses multiple newlines to double', () => {
    expect(normalizeContextText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('normalizes CRLF to LF', () => {
    expect(normalizeContextText('a\r\nb')).toBe('a\nb');
  });

  it('strips control characters', () => {
    expect(normalizeContextText('a\x01b\x7fc')).toBe('a b c');
  });

  it('handles empty/null input', () => {
    expect(normalizeContextText('')).toBe('');
    expect(normalizeContextText(null as unknown as string)).toBe('');
  });
});

describe('maybeRepairMojibake', () => {
  it('passes through clean text', () => {
    expect(maybeRepairMojibake('hello world')).toBe('hello world');
  });

  it('passes through text with non-Latin chars', () => {
    const input = '日本語テスト';
    expect(maybeRepairMojibake(input)).toBe(input);
  });
});
