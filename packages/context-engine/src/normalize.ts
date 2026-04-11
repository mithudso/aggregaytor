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

const COMMON_MOJIBAKE_RE = /(Ã.|â.|ðŸ|Â[^\s]|â€™|â€œ|â€\u009d|â€"|â€")/;

export function applyCommonReplacements(text: string): string {
  let value = String(text || '');
  for (const [from, to] of COMMON_REPLACEMENTS.entries()) {
    value = value.split(from).join(to);
  }
  return value;
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
