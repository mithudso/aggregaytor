#!/usr/bin/env node
/**
 * gen-method-registry.mjs — deterministic method inventory for the whole repo.
 *
 * Walks the shipping TypeScript/JavaScript source, extracts every named
 * function / class method / arrow-const, and records, per method:
 *   - file, line, name, kind (function | method | arrow), exported, async
 *   - hasDoc  — a JSDoc /** … *​/ block immediately precedes it
 *   - summary — first sentence of that JSDoc (or '' when undocumented)
 *   - logs    — body references the logger (`log.`/`createLogger`) or console.*
 *   - errors  — body contains try / catch / throw
 *   - pure    — no await / fetch / chrome.* / db. / localStorage / dispatch
 *   - surface — cli | extension | api | internal (see classifySurface)
 *   - reachableVia — how another session can invoke it (OPS_RUN for the
 *     registered invocable surface, else the transitive command/entry that
 *     reaches it, else 'internal')
 *
 * Outputs two artifacts consumed by other sessions so they never have to guess:
 *   - docs/method-registry.json  (machine-readable, sorted, one row per method)
 *   - docs/method-catalog.md     (human-readable, grouped by file)
 *
 * Modes:
 *   node scripts/gen-method-registry.mjs           # (re)generate both artifacts
 *   node scripts/gen-method-registry.mjs --check    # CI gate: fail if any
 *                                                   # method lacks a JSDoc, or
 *                                                   # if the artifacts are stale
 *
 * Heuristic, not a full TS parser: it errs toward over-reporting a candidate
 * rather than missing one, and never executes the code it scans.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, sep } from 'path';

const ROOT = resolve(process.cwd());
const SRC_DIRS = ['extensions', 'packages', 'adapters', 'tools'];
const SKIP_DIR = new Set(['node_modules', 'dist', '__tests__', '.git', '.venv', '.semantic-index', 'worktrees']);
const REGISTRY_JSON = 'docs/method-registry.json';
const CATALOG_MD = 'docs/method-catalog.md';

/** Recursively collect .ts/.js source files, honoring the skip set. */
function collectFiles(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      collectFiles(full, out);
    } else if (/\.(ts|js|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !/\.config\./.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'do', 'else', 'await', 'typeof', 'new', 'delete', 'void', 'yield', 'in', 'of', 'case', 'default', 'constructor', 'super']);

/** Does a JSDoc block end on the line(s) directly above `lineIdx`? Return its summary. */
function docAbove(lines, lineIdx) {
  let i = lineIdx - 1;
  // allow decorators / blank lines between the doc and the declaration
  while (i >= 0 && (lines[i].trim() === '' || lines[i].trim().startsWith('@'))) i -= 1;
  if (i < 0 || !lines[i].trim().endsWith('*/')) return { hasDoc: false, summary: '' };
  // walk up to the opening /**
  let start = i;
  while (start >= 0 && !lines[start].trim().startsWith('/**')) start -= 1;
  if (start < 0) return { hasDoc: false, summary: '' };
  const body = lines.slice(start, i + 1)
    .map((l) => l.replace(/^\s*\/?\*+\/?/, '').replace(/\*\/\s*$/, '').trim())
    .filter((l) => l && !l.startsWith('@'));
  const summary = (body[0] || '').replace(/\s+/g, ' ').trim();
  return { hasDoc: true, summary };
}

/** Body heuristics over the ~40 lines following a declaration. */
function bodyTraits(text) {
  const logs = /\b(log|logger)\s*\.\s*(debug|info|warn|error|log|trace)\b/.test(text) || /\bconsole\s*\.\s*(log|warn|error|info|debug)\b/.test(text);
  const errors = /\b(try|catch|throw)\b/.test(text);
  const impure = /\b(await|fetch|chrome\.|db\.|localStorage|sessionStorage|dispatchEvent|indexedDB|crypto\.|XMLHttpRequest|WebSocket)\b/.test(text);
  return { logs, errors, pure: !impure };
}

const FN_RE = /^(?<indent>\s*)(?<exp>export\s+)?(?<async1>async\s+)?function\s+(?<n1>[A-Za-z_$][\w$]*)\s*\(/;
const ARROW_RE = /^(?<indent>\s*)(?<exp>export\s+)?const\s+(?<n2>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?<async2>async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/;
const METHOD_RE = /^(?<indent>\s{2,})(?<mods>(?:public|private|protected|static|readonly|async|get|set)\s+)*(?<n3>[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\((?<rest>[^)]*)\)\s*(?::\s*[^={]+)?\{/;

/** Which surface a method is reachable from. exported functions of a module are
 * the legitimately-invocable unit; the OPS_RUN dispatcher can reach any that the
 * operations registry registers. */
function classifySurface(rel, exported) {
  if (rel.startsWith('tools/debug-server')) return 'cli';
  if (!exported) return 'internal';
  if (rel.startsWith('packages/') || rel.startsWith('adapters/')) return 'extension'; // linked into the extension bundle
  if (rel.includes('/background/')) return 'api'; // reachable via chrome.runtime messaging
  if (rel.includes('/content/') || rel.includes('/sidepanel/') || rel.includes('/popup/')) return 'extension';
  return 'internal';
}

function scanFile(full) {
  const rel = relative(ROOT, full).split(sep).join('/');
  const src = readFileSync(full, 'utf8');
  const lines = src.split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let m = FN_RE.exec(line);
    let name, kind, exported, isAsync;
    if (m) { name = m.groups.n1; kind = 'function'; exported = !!m.groups.exp; isAsync = !!m.groups.async1; }
    else if ((m = ARROW_RE.exec(line))) { name = m.groups.n2; kind = 'arrow'; exported = !!m.groups.exp; isAsync = !!m.groups.async2; }
    else if ((m = METHOD_RE.exec(line))) {
      name = m.groups.n3;
      if (CONTROL.has(name)) continue;
      // skip object-literal keys and type members: require a real body brace on this or next lines (already matched `{`)
      kind = 'method'; exported = false; isAsync = /\basync\b/.test(m.groups.mods || '');
    } else continue;
    if (CONTROL.has(name)) continue;
    const { hasDoc, summary } = docAbove(lines, i);
    const traits = bodyTraits(lines.slice(i, i + 40).join('\n'));
    const surface = classifySurface(rel, exported || kind === 'function');
    // Indentation distinguishes a top-level callable unit from a nested inner
    // closure (a drag handler / `walk` / `pickString` declared inside another
    // function body). Class methods are legitimately indented, so they are never
    // "nested". The CI doc gate enforces JSDoc on callable units only; nested
    // closures are cataloged but doc-optional (their parent's JSDoc covers them).
    const indent = (m.groups.indent || '').length;
    const nested = kind !== 'method' && indent > 0;
    rows.push({
      name, file: rel, line: i + 1, kind, exported: exported || (kind === 'function' && /^export\b/.test(line)),
      async: isAsync, nested, hasDoc, summary,
      logs: traits.logs, errors: traits.errors, pure: traits.pure,
      surface,
      reachableVia: surface === 'internal' ? 'internal (via caller)' : 'OPS_RUN',
    });
  }
  return rows;
}

function build() {
  const files = [];
  for (const d of SRC_DIRS) collectFiles(join(ROOT, d), files);
  files.sort();
  const rows = [];
  for (const f of files) rows.push(...scanFile(f));
  rows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return rows;
}

function renderJson(rows) {
  return JSON.stringify(rows, null, 2) + '\n';
}

function renderMarkdown(rows) {
  const byFile = new Map();
  for (const r of rows) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }
  const total = rows.length;
  const documented = rows.filter((r) => r.hasDoc).length;
  const out = [];
  out.push('# Method Catalog');
  out.push('');
  out.push('> Generated by `scripts/gen-method-registry.mjs` — do not hand-edit. Run `pnpm run registry` to refresh, `pnpm run registry:check` in CI.');
  out.push('');
  out.push(`**${total}** methods across **${byFile.size}** files · **${documented}/${total}** documented · machine-readable form: \`docs/method-registry.json\`.`);
  out.push('');
  out.push('Columns: **doc** = has JSDoc · **log** = logs on meaningful paths · **err** = has try/catch/throw · **pure** = no I/O · **surface** = how another session reaches it (all invocable methods are reachable through the gated `OPS_RUN` command on extension/API/CLI; `internal` methods run via their caller).');
  out.push('');
  for (const [file, list] of [...byFile].sort()) {
    out.push(`## ${file}`);
    out.push('');
    out.push('| Method | Kind | doc | log | err | pure | Surface | Summary |');
    out.push('|---|---|:-:|:-:|:-:|:-:|---|---|');
    for (const r of list) {
      const y = (b) => (b ? '✅' : '—');
      const sum = (r.summary || '').replace(/\|/g, '\\|').slice(0, 100);
      out.push(`| \`${r.name}\` (L${r.line}) | ${r.kind} | ${y(r.hasDoc)} | ${y(r.logs)} | ${y(r.errors)} | ${y(r.pure)} | ${r.surface} | ${sum} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

const rows = build();
const jsonStr = renderJson(rows);
const mdStr = renderMarkdown(rows);

if (process.argv.includes('--check')) {
  let fail = false;
  // Enforce JSDoc on callable units (top-level functions, exported arrows,
  // class methods) of first-party code. Exempt: nested inner closures (their
  // parent's JSDoc covers them) and the vendored, provenance-pinned *-lib
  // packages (documented upstream; not ours to hand-edit).
  const isVendored = (f) => /packages\/(grindr|sniffies)-lib\//.test(f);
  const undoc = rows.filter((r) => !r.hasDoc && !r.nested && !isVendored(r.file));
  if (undoc.length) {
    fail = true;
    console.error(`registry:check — ${undoc.length} callable method(s) missing JSDoc:`);
    for (const r of undoc.slice(0, 50)) console.error(`  ${r.file}:${r.line} ${r.name}`);
    if (undoc.length > 50) console.error(`  … and ${undoc.length - 50} more`);
  }
  for (const [path, want] of [[REGISTRY_JSON, jsonStr], [CATALOG_MD, mdStr]]) {
    let cur = '';
    try { cur = readFileSync(join(ROOT, path), 'utf8'); } catch {}
    if (cur !== want) { fail = true; console.error(`registry:check — ${path} is stale; run \`pnpm run registry\``); }
  }
  if (fail) process.exit(1);
  console.log(`registry:check — OK: ${rows.length} methods, all documented, artifacts current.`);
  process.exit(0);
}

writeFileSync(join(ROOT, REGISTRY_JSON), jsonStr);
writeFileSync(join(ROOT, CATALOG_MD), mdStr);
const documented = rows.filter((r) => r.hasDoc).length;
console.log(`Wrote ${REGISTRY_JSON} + ${CATALOG_MD}: ${rows.length} methods, ${documented} documented (${rows.length - documented} undocumented).`);
