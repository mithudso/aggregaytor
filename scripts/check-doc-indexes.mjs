#!/usr/bin/env node
/**
 * check-doc-indexes.mjs — keep the retrieval indexes honest.
 *
 * Validates, with zero dependencies:
 *  1. Every "path" entry in docs/high_signal_file_index.json exists on disk.
 *  2. Every repo-relative file path mentioned in a backtick code-span in
 *     docs/codebase-overview.md exists on disk (URLs and non-path spans ignored).
 *  3. (warning only) Source files on disk that are missing from the JSON index.
 *
 * Exit codes: 0 = clean (warnings allowed), 1 = missing entries found.
 * Flags: --prune  rewrite the JSON dropping entries whose files are gone.
 *
 * CI: wired as `pnpm run index:check`.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_INDEX = join(ROOT, 'docs', 'high_signal_file_index.json');
const OVERVIEW = join(ROOT, 'docs', 'codebase-overview.md');
const PRUNE = process.argv.includes('--prune');

const EXCLUDE_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.claude', '.playwright-mcp',
  '.semantic-index', '.venv', 'venv', 'coverage', '__pycache__',
]);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.sh', '.html', '.css']);

let failures = 0;
let warnings = 0;

// ── 1. JSON index paths must exist ──────────────────────────────────────────

let indexEntries = [];
try {
  indexEntries = JSON.parse(readFileSync(JSON_INDEX, 'utf8'));
} catch (err) {
  console.error(`FAIL: cannot read/parse ${relative(ROOT, JSON_INDEX)}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(indexEntries)) {
  console.error('FAIL: high_signal_file_index.json is not a JSON array');
  process.exit(1);
}

const deadEntries = indexEntries.filter((e) => !e?.path || !existsSync(join(ROOT, e.path)));
if (deadEntries.length) {
  console.error(`\n${deadEntries.length} JSON index entr${deadEntries.length === 1 ? 'y' : 'ies'} point at missing files:`);
  for (const e of deadEntries) console.error(`  - ${e?.path ?? '<entry without path>'}`);
  if (PRUNE) {
    const kept = indexEntries.filter((e) => !deadEntries.includes(e));
    writeFileSync(JSON_INDEX, `${JSON.stringify(kept, null, 2)}\n`);
    console.error(`--prune: rewrote index with ${kept.length} entries (${deadEntries.length} dropped).`);
  } else {
    failures += deadEntries.length;
  }
}

// ── 2. Overview code-span paths must exist ──────────────────────────────────

// A "path-like" span: contains a slash, ends in a known extension, no spaces,
// not a URL, not a glob/placeholder.
const PATH_SPAN_RE = /`([^`\s]+\/[^`\s]+\.[a-z0-9]{1,5})`/gi;
const KNOWN_EXTS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.sh', '.html', '.css',
  '.json', '.md', '.yaml', '.yml',
]);

let overviewMissing = [];
if (!existsSync(OVERVIEW)) {
  console.error(`FAIL: ${relative(ROOT, OVERVIEW)} does not exist`);
  failures += 1;
} else {
  const text = readFileSync(OVERVIEW, 'utf8');
  const seen = new Set();
  for (const match of text.matchAll(PATH_SPAN_RE)) {
    const span = match[1];
    if (seen.has(span)) continue;
    seen.add(span);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(span)) continue;        // URL
    if (span.includes('*') || span.includes('{') || span.includes('<')) continue; // glob/placeholder
    if (!KNOWN_EXTS.has(extname(span).toLowerCase())) continue;  // not a file we track
    if (span.startsWith('~') || span.startsWith('/')) continue;  // absolute/home — out of repo scope
    if (!existsSync(join(ROOT, span))) overviewMissing.push(span);
  }
  if (overviewMissing.length) {
    console.error(`\n${overviewMissing.length} path span(s) in codebase-overview.md point at missing files:`);
    for (const p of overviewMissing) console.error(`  - ${p}`);
    failures += overviewMissing.length;
  }
}

// ── 3. Warn about unindexed source files on disk ────────────────────────────

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    const top = rel.split('/')[0];
    if (EXCLUDE_DIRS.has(name) || EXCLUDE_DIRS.has(top)) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else yield rel;
  }
}

const indexedPaths = new Set(indexEntries.map((e) => e?.path).filter(Boolean));
const unindexed = [];
for (const rel of walk(ROOT)) {
  if (!SOURCE_EXTS.has(extname(rel).toLowerCase())) continue;
  if (!indexedPaths.has(rel)) unindexed.push(rel);
}
if (unindexed.length) {
  warnings += unindexed.length;
  console.warn(`\nwarning: ${unindexed.length} source file(s) on disk are missing from high_signal_file_index.json:`);
  for (const p of unindexed.sort()) console.warn(`  - ${p}`);
}

// ── Result ──────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\ncheck-doc-indexes: FAIL (${failures} missing entr${failures === 1 ? 'y' : 'ies'}).`);
  process.exit(1);
}
console.log(`check-doc-indexes: OK — ${indexEntries.length} index entries valid` +
  (warnings ? `, ${warnings} warning(s)` : '') + '.');
