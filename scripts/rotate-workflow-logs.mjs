#!/usr/bin/env node
/**
 * rotate-workflow-logs.mjs — rotate old sections of memory.md / prompts.md
 * into docs/archive/ when either file exceeds SIZE_LIMIT bytes.
 *
 * Policy:
 * - Only runs a rotation for a file when it is larger than 200 KB.
 * - memory.md: sections are `## v<version> - <date>` entries. Every section
 *   whose version is older than the current manifest version is moved to
 *   docs/archive/memory-<timestamp>.md; the current-version section (and the
 *   file header) stay in place.
 * - prompts.md: sections are `## Prompt vN - <timestamp>` entries. All but the
 *   most recent section are moved to docs/archive/prompts-<timestamp>.md.
 * - Refuses to run if a `.swp`/`.swo` sibling of a target file exists
 *   (an editor may have the file open).
 *
 * Usage: node scripts/rotate-workflow-logs.mjs [--dry-run] [--force]
 *   --dry-run  report what would rotate, write nothing
 *   --force    rotate regardless of file size
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE_LIMIT = 200 * 1024; // 200 KB
const ARCHIVE_DIR = join(ROOT, 'docs', 'archive');

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

function fail(msg) {
  console.error(`rotate-workflow-logs: ${msg}`);
  process.exit(1);
}

function refuseIfSwapFile(filePath) {
  for (const ext of ['.swp', '.swo']) {
    // Vim swap files: /path/.name.swp and /path/name.swp variants.
    const dir = dirname(filePath);
    const base = filePath.slice(dir.length + 1);
    for (const candidate of [join(dir, `.${base}${ext}`), `${filePath}${ext}`]) {
      if (existsSync(candidate)) {
        fail(`refusing to rotate: swap file exists (${candidate}) — close the editor first`);
      }
    }
  }
}

function currentManifestVersion() {
  const manifestPath = join(ROOT, 'extensions', 'aggregaytor', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.version) fail(`no version field in ${manifestPath}`);
  return manifest.version;
}

/** Split a markdown file into { header, sections: [{ heading, body }] } on `## ` headings. */
function splitSections(content) {
  const lines = content.split('\n');
  const header = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { heading: line, body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      header.push(line);
    }
  }
  if (current) sections.push(current);
  return { header, sections };
}

function renderSections(header, sections) {
  const parts = [header.join('\n').replace(/\n+$/, '')];
  for (const s of sections) {
    parts.push(`${s.heading}\n${s.body.join('\n').replace(/\n+$/, '')}`);
  }
  return `${parts.join('\n\n')}\n`;
}

function archive(name, keptContent, archivedSections, filePath, header) {
  if (archivedSections.length === 0) {
    console.log(`${name}: nothing to rotate`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = join(ARCHIVE_DIR, `${name.replace(/\.md$/, '')}-${stamp}.md`);
  if (dryRun) {
    console.log(`${name}: would rotate ${archivedSections.length} section(s) → ${archivePath}`);
    return;
  }
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const gitkeep = join(ARCHIVE_DIR, '.gitkeep');
  if (!existsSync(gitkeep)) writeFileSync(gitkeep, '');
  writeFileSync(archivePath, renderSections(header, archivedSections));
  writeFileSync(filePath, keptContent);
  console.log(`${name}: rotated ${archivedSections.length} section(s) → ${archivePath}`);
}

function rotateFile(name, shouldArchiveSection) {
  const filePath = join(ROOT, name);
  if (!existsSync(filePath)) {
    console.log(`${name}: not found, skipping`);
    return;
  }
  refuseIfSwapFile(filePath);
  const content = readFileSync(filePath, 'utf8');
  if (!force && Buffer.byteLength(content, 'utf8') <= SIZE_LIMIT) {
    console.log(`${name}: under ${SIZE_LIMIT / 1024} KB, skipping`);
    return;
  }
  const { header, sections } = splitSections(content);
  const kept = [];
  const archived = [];
  for (const section of sections) {
    (shouldArchiveSection(section) ? archived : kept).push(section);
  }
  archive(name, renderSections(header, kept), archived, filePath, header);
}

const version = currentManifestVersion();

// memory.md: archive every section that is NOT the current manifest version.
rotateFile('memory.md', (section) => !section.heading.includes(`v${version} `) && !section.heading.endsWith(`v${version}`));

// prompts.md: archive all but the last (most recent) `## Prompt vN` section.
{
  const filePath = join(ROOT, 'prompts.md');
  if (existsSync(filePath)) {
    const { sections } = splitSections(readFileSync(filePath, 'utf8'));
    const last = sections.length > 0 ? sections[sections.length - 1].heading : null;
    rotateFile('prompts.md', (section) => section.heading !== last);
  } else {
    console.log('prompts.md: not found, skipping');
  }
}
