import { describe, it, expect } from 'vitest';

/**
 * Tests for extractAttitudeFromPartial and extractTextFromPartial — the
 * partials prefetcher's response parsers from sniffies-map-filters.ts.
 *
 * These functions live in a MAIN-world content script and aren't exported.
 * We replicate the pure logic here to verify correctness.
 */

// ── Replicated pure functions ──────────────────────────────────────────────

function extractAttitudeFromPartial(p: any): string | null {
  const sexuality = p?.data?.profile?.extended?.sexuality;
  if (!sexuality) return null;
  const att = sexuality.attitude;
  return att ? String(att).toLowerCase() : null;
}

function extractTextFromPartial(p: any): string {
  const prof = p?.data?.profile;
  if (!prof) return '';
  const bits: string[] = [];
  const bio = prof.extended?.bio || prof.bio;
  if (bio) bits.push(String(bio));
  const aboutMe = prof.extended?.aboutMe || prof.aboutMe;
  if (aboutMe) bits.push(String(aboutMe));
  const lookingFor = prof.extended?.lookingFor || prof.lookingFor;
  if (lookingFor) bits.push(String(lookingFor));
  return bits.join(' ').toLowerCase();
}

function cappedMapSet<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  map.set(key, value);
  if (map.size > cap) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value as string);
  }
}

// ── Tests: extractAttitudeFromPartial ──────────────────────────────────────

describe('extractAttitudeFromPartial', () => {
  it('extracts attitude from standard Sniffies partial response', () => {
    const partial = {
      _id: 'abc123',
      data: {
        profile: {
          extended: {
            sexuality: { attitude: 'Bottom' },
          },
        },
      },
    };
    expect(extractAttitudeFromPartial(partial)).toBe('bottom');
  });

  it('lowercases the attitude value', () => {
    const partial = {
      data: { profile: { extended: { sexuality: { attitude: 'Vers Top' } } } },
    };
    expect(extractAttitudeFromPartial(partial)).toBe('vers top');
  });

  it('returns null when sexuality block is missing', () => {
    const partial = { data: { profile: { extended: {} } } };
    expect(extractAttitudeFromPartial(partial)).toBeNull();
  });

  it('returns null when extended block is missing', () => {
    const partial = { data: { profile: {} } };
    expect(extractAttitudeFromPartial(partial)).toBeNull();
  });

  it('returns null when profile block is missing', () => {
    const partial = { data: {} };
    expect(extractAttitudeFromPartial(partial)).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(extractAttitudeFromPartial(null)).toBeNull();
    expect(extractAttitudeFromPartial(undefined)).toBeNull();
  });

  it('returns null when attitude is empty string', () => {
    const partial = {
      data: { profile: { extended: { sexuality: { attitude: '' } } } },
    };
    expect(extractAttitudeFromPartial(partial)).toBeNull();
  });

  it('coerces numeric attitude to string', () => {
    const partial = {
      data: { profile: { extended: { sexuality: { attitude: 42 } } } },
    };
    expect(extractAttitudeFromPartial(partial)).toBe('42');
  });

  it('handles all standard Sniffies attitude values', () => {
    const attitudes = ['Top', 'Bottom', 'Vers', 'Vers Top', 'Vers Bottom', 'Side'];
    for (const att of attitudes) {
      const partial = {
        data: { profile: { extended: { sexuality: { attitude: att } } } },
      };
      expect(extractAttitudeFromPartial(partial)).toBe(att.toLowerCase());
    }
  });
});

// ── Tests: extractTextFromPartial ──────────────────────────────────────────

describe('extractTextFromPartial', () => {
  it('extracts bio from extended profile', () => {
    const partial = {
      data: { profile: { extended: { bio: 'Looking for fun' } } },
    };
    expect(extractTextFromPartial(partial)).toBe('looking for fun');
  });

  it('extracts bio from top-level profile when extended is absent', () => {
    const partial = {
      data: { profile: { bio: 'Top-level bio' } },
    };
    expect(extractTextFromPartial(partial)).toBe('top-level bio');
  });

  it('concatenates bio, aboutMe, and lookingFor', () => {
    const partial = {
      data: {
        profile: {
          extended: {
            bio: 'Bio text',
            aboutMe: 'About me text',
            lookingFor: 'Looking for text',
          },
        },
      },
    };
    expect(extractTextFromPartial(partial)).toBe('bio text about me text looking for text');
  });

  it('prefers extended fields over top-level', () => {
    const partial = {
      data: {
        profile: {
          bio: 'Old bio',
          extended: { bio: 'New bio' },
        },
      },
    };
    expect(extractTextFromPartial(partial)).toBe('new bio');
  });

  it('falls back to top-level when extended field is falsy', () => {
    const partial = {
      data: {
        profile: {
          bio: 'Fallback bio',
          extended: { bio: '' },
        },
      },
    };
    expect(extractTextFromPartial(partial)).toBe('fallback bio');
  });

  it('returns empty string when profile is missing', () => {
    expect(extractTextFromPartial({ data: {} })).toBe('');
  });

  it('returns empty string for null/undefined input', () => {
    expect(extractTextFromPartial(null)).toBe('');
    expect(extractTextFromPartial(undefined)).toBe('');
  });

  it('returns empty string when all fields are absent', () => {
    expect(extractTextFromPartial({ data: { profile: { extended: {} } } })).toBe('');
  });

  it('lowercases output for case-insensitive matching', () => {
    const partial = {
      data: { profile: { extended: { bio: 'DL MASC ONLY' } } },
    };
    expect(extractTextFromPartial(partial)).toBe('dl masc only');
  });
});

// ── Tests: cappedMapSet ────────────────────────────────────────────────────

describe('cappedMapSet', () => {
  it('sets a value on the map', () => {
    const map = new Map<string, string>();
    cappedMapSet(map, 'a', 'value', 3);
    expect(map.get('a')).toBe('value');
  });

  it('allows entries up to the cap', () => {
    const map = new Map<string, number>();
    cappedMapSet(map, 'a', 1, 3);
    cappedMapSet(map, 'b', 2, 3);
    cappedMapSet(map, 'c', 3, 3);
    expect(map.size).toBe(3);
  });

  it('evicts the oldest entry when over cap', () => {
    const map = new Map<string, number>();
    cappedMapSet(map, 'a', 1, 2);
    cappedMapSet(map, 'b', 2, 2);
    cappedMapSet(map, 'c', 3, 2);
    expect(map.size).toBe(2);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
    expect(map.has('c')).toBe(true);
  });

  it('FIFO eviction order — first inserted is first evicted', () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 5; i++) cappedMapSet(map, `k${i}`, i, 3);
    expect(map.has('k0')).toBe(false);
    expect(map.has('k1')).toBe(false);
    expect(map.has('k2')).toBe(true);
    expect(map.has('k3')).toBe(true);
    expect(map.has('k4')).toBe(true);
  });

  it('updating an existing key does not evict', () => {
    const map = new Map<string, number>();
    cappedMapSet(map, 'a', 1, 2);
    cappedMapSet(map, 'b', 2, 2);
    cappedMapSet(map, 'a', 10, 2);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe(10);
    expect(map.get('b')).toBe(2);
  });

  it('handles cap of 1', () => {
    const map = new Map<string, string>();
    cappedMapSet(map, 'a', 'x', 1);
    cappedMapSet(map, 'b', 'y', 1);
    expect(map.size).toBe(1);
    expect(map.has('b')).toBe(true);
    expect(map.has('a')).toBe(false);
  });

  it('handles cap of 0 — never retains entries', () => {
    const map = new Map<string, string>();
    cappedMapSet(map, 'a', 'x', 0);
    expect(map.size).toBe(0);
  });
});
