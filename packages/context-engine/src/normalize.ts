/**
 * normalize.ts — Text normalization, unicode cleanup, mojibake repair.
 *
 * Extracted from mdb-tam context-modules.js lines 7-74.
 */

const COMMON_REPLACEMENTS = new Map<string, string>([
  ['\u00a0', ' '],
  ['\u200b', ''],
  ['\u200c', ''],
  ['\u200d', ''],
  ['\ufeff', ''],
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u201c', '"'],
  ['\u201d', '"'],
  ['\u2013', '-'],
  ['\u2014', '-'],
  ['\u2022', '-'],
  ['\u2026', '...'],
]);

/**
 * Mojibake sniffer for UTF-8 text that was decoded as Latin-1.
 *
 * `\u00c3.` / `\u00e2.` / `\u00c2[^\s]` are the mangled lead bytes and `\u00f0\u0178`
 * is the emoji-plane lead pair. Longer sequences (the mangled forms of the
 * curly quotes and dashes) need no alternative of their own: each is `\u00e2`
 * followed by a non-newline character, so `\u00e2.` already matches them.
 */
const COMMON_MOJIBAKE_RE = /\u00c3.|\u00e2.|\u00f0\u0178|\u00c2[^\s]/;

/**
 * Single-pass matcher for every COMMON_REPLACEMENTS key.
 *
 * Built from the map so the two cannot drift. Each key is emitted as a \uXXXX
 * escape so no key can ever be read as character-class syntax.
 */
const COMMON_REPLACEMENT_RE = new RegExp(
  `[${[...COMMON_REPLACEMENTS.keys()]
    .map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('')}]`,
  'g',
);

export function applyCommonReplacements(text: string): string {
  const value = String(text || '');
  // One scan rather than one split/join pass per map entry. Equivalent to the
  // sequential passes because no replacement *output* (' ', '', "'", '"', '-',
  // '...') is itself a key, so passes could never cascade into each other.
  return value.replace(COMMON_REPLACEMENT_RE, char => COMMON_REPLACEMENTS.get(char)!);
}

export function maybeRepairMojibake(text: string): string {
  const value = String(text || '');
  if (!COMMON_MOJIBAKE_RE.test(value)) return value;
  const codes: number[] = [];
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code > 255) return value;
    codes.push(code);
  }
  try {
    const repaired = new TextDecoder('utf-8', { fatal: false }).decode(
      Uint8Array.from(codes),
    );
    return repaired && repaired.length >= Math.floor(value.length * 0.5)
      ? repaired
      : value;
  } catch {
    return value;
  }
}

export function normalizeContextText(text: string): string {
  let value = applyCommonReplacements(text);
  value = maybeRepairMojibake(value);
  value = applyCommonReplacements(value);
  value = value.normalize('NFC');
  value = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return value;
}
