/**
 * operations-registry.ts — the single reflective, gated invocation surface.
 *
 * Every legitimately-invocable unit in the codebase is a module's *exported*
 * function. This module reflectively registers those exports under namespaced
 * operation names (e.g. `store.getAllContacts`, `context.tokenizeIndexText`,
 * `core.walkPayload`, `llm.getLLMConfig`) so that a future session — or the
 * CLI / extension / API — can discover and invoke any of them through ONE
 * command (`OPS_RUN`) instead of 900 bespoke message cases. Pure, non-exported
 * helpers are intentionally NOT registered: they run as part of the exported
 * operation that calls them, and `docs/method-registry.json` records that with
 * `reachableVia: "internal (via caller)"`.
 *
 * SECURITY: `OPS_RUN` is gated exactly like `DEBUG_COMMAND` (sender-origin
 * check in the service worker — extension pages only, content scripts refused).
 * On top of that, read/write classification is FAIL-CLOSED: an operation runs
 * without `confirmWrite` ONLY when its name is a confident read (see
 * {@link classifyKind}); every destructive, secret-touching, or ambiguous
 * operation defaults to `write` and is refused unless the caller passes
 * `confirmWrite: true` (or a valid debug token). No operation is exposed to a
 * content script or an external page.
 */

import * as store from '@aggregaytor/store';
import * as core from '@aggregaytor/adapter-core';
import * as context from '@aggregaytor/context-engine';
import * as llm from './llm.js';
import * as searchIndex from './search-index.js';

/** What one registered operation carries for discovery + dispatch. */
export interface OperationEntry {
  /** Namespaced operation name, e.g. `store.getAllContacts`. */
  name: string;
  /** Owning module namespace. */
  module: string;
  /** 'read' runs for any trusted origin; 'write' needs confirmWrite/token. */
  kind: 'read' | 'write';
  /** The actual function (arguments are applied positionally from `args`). */
  fn: (...args: unknown[]) => unknown;
}

// Read/write classification is FAIL-CLOSED. A denylist of write verbs is unsafe
// because it fails OPEN: any exported name that doesn't happen to start with a
// listed verb (e.g. `destroyDB`, `restoreFromOpfsSnapshot`, `closeDB`,
// `clearIndex`, or the secret-creating `getOrCreateBackupKey`) would be treated
// as a free-running read. Instead: an operation is a `read` ONLY when its name
// starts with a conservative read prefix AND is not force-classified as a write;
// everything else defaults to `write` (needs confirmWrite/token).

/** Names that are always writes even if they start with a read-ish prefix
 * (e.g. `getOrCreate…` starts with "get" but persists/creates state). Checked
 * before the read allowlist. */
const FORCE_WRITE_RE = /^(getOrCreate|destroy|drop|restore|close|clear|wipe|erase|purge|delete|remove|reset|rebuild|compact|install|uninstall|rotate|regenerate|revoke|import|migrate|save|put|post|write|set|update|upsert|sync|block|hide|unblock|share|unshare|create|add|enqueue|record|train|send|toggle|apply|authenticate)/i;

/** Conservative read-verb prefixes — only these run without confirmWrite. */
const READ_PREFIX_RE = /^(get|list|query|find|search|read|count|is|has|exists|estimate|inspect|peek|fetch|resolve)/i;

/** Belt-and-suspenders: full operation names that must ALWAYS be writes,
 * regardless of prefix heuristics (destructive or secret-touching). */
const HARD_WRITE_OPS = new Set<string>([
  'store.destroyDB', 'store.closeDB', 'store.restoreFromOpfsSnapshot', 'store.restoreFromDrive',
  'store.importAllData', 'store.importBlocked', 'store.purgeOldestMessages', 'store.getOrCreateBackupKey',
  'store.getStoredBackupKey', 'store.deleteOpfsSnapshot', 'search.clearIndex', 'llm.clearLLMCaches',
]);

/**
 * Classify an operation as read or write, fail-closed.
 * @param fullName namespaced operation name (e.g. `store.getAllContacts`)
 * @param key the bare exported function name
 * @returns 'read' only for a confidently side-effect-free operation; 'write' otherwise
 */
function classifyKind(fullName: string, key: string): 'read' | 'write' {
  if (HARD_WRITE_OPS.has(fullName)) return 'write';
  if (FORCE_WRITE_RE.test(key)) return 'write';
  return READ_PREFIX_RE.test(key) ? 'read' : 'write';
}

const REGISTRY = new Map<string, OperationEntry>();

/**
 * Reflectively register every function exported by a module namespace.
 *
 * @param moduleName short namespace prefix used in operation names
 * @param mod the imported `* as mod` namespace object
 * @returns the number of operations registered from this module
 */
function registerModule(moduleName: string, mod: Record<string, unknown>): number {
  let count = 0;
  for (const [key, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue;         // skip re-exported types/consts
    // Skip class constructors (capitalized) — they are instantiated by adapters,
    // not invoked as standalone operations, and calling `new`-only functions
    // without `new` throws.
    if (/^[A-Z]/.test(key)) continue;
    const name = `${moduleName}.${key}`;
    REGISTRY.set(name, {
      name,
      module: moduleName,
      kind: classifyKind(name, key),
      fn: value as (...args: unknown[]) => unknown,
    });
    count += 1;
  }
  return count;
}

// Register the invocable surface once at module load. Failures here must never
// take down the service worker — a module that fails to enumerate is skipped
// with a warning and its operations are simply absent from OPS_RUN.
let registered = 0;
for (const [ns, mod] of [
  ['store', store],
  ['core', core],
  ['context', context],
  ['llm', llm],
  ['search', searchIndex],
] as const) {
  try {
    registered += registerModule(ns, mod as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(`[Aggregaytor:Ops] failed to register module '${ns}':`, (err as Error).message);
  }
}
console.info(`[Aggregaytor:Ops] registered ${registered} invocable operations across 5 modules.`);

/**
 * List every registered operation (name, module, kind) for discovery. Callers
 * (the panel, the CLI `ops_list` tool) use this to enumerate what `OPS_RUN` can
 * invoke without reading the source.
 *
 * @returns a sorted array of `{ name, module, kind }`, no functions exposed
 */
export function listOperations(): Array<Pick<OperationEntry, 'name' | 'module' | 'kind'>> {
  return [...REGISTRY.values()]
    .map(({ name, module, kind }) => ({ name, module, kind }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Structured result of an `OPS_RUN` invocation. Never throws to the caller. */
export interface OpsRunResult {
  ok: boolean;
  name: string;
  result?: unknown;
  error?: string;
}

/**
 * Invoke one registered operation by name with positional args. This is the
 * body behind the service worker's gated `OPS_RUN` case — it assumes the
 * sender-origin gate has ALREADY passed (it does not do origin checks itself).
 *
 * Write-classified operations are refused unless `allowWrite` is true (the SW
 * sets that only when the caller passed `confirmWrite: true` or a valid debug
 * token). Every failure is returned as a structured `{ ok:false, error }` —
 * this function never throws, so one bad call can't crash the worker.
 *
 * @param name namespaced operation name (see {@link listOperations})
 * @param args positional arguments applied to the operation
 * @param opts `allowWrite` gates state-mutating operations
 * @returns an {@link OpsRunResult}; `result` is awaited when the op is async
 */
export async function runOperation(
  name: string,
  args: unknown[] = [],
  opts: { allowWrite?: boolean } = {},
): Promise<OpsRunResult> {
  const entry = REGISTRY.get(name);
  if (!entry) {
    console.warn(`[Aggregaytor:Ops] OPS_RUN refused: unknown operation '${name}'`);
    return { ok: false, name, error: `unknown operation: ${name}` };
  }
  if (entry.kind === 'write' && !opts.allowWrite) {
    console.warn(`[Aggregaytor:Ops] OPS_RUN refused write operation '${name}' without confirmWrite`);
    return { ok: false, name, error: `operation '${name}' mutates state; pass confirmWrite:true (or a debug token) to run it` };
  }
  if (!Array.isArray(args)) {
    return { ok: false, name, error: 'args must be an array of positional arguments' };
  }
  try {
    const out = await Promise.resolve(entry.fn(...args));
    console.debug(`[Aggregaytor:Ops] OPS_RUN ${name} ok`);
    return { ok: true, name, result: out };
  } catch (err) {
    console.warn(`[Aggregaytor:Ops] OPS_RUN ${name} threw:`, (err as Error).message);
    return { ok: false, name, error: (err as Error).message || String(err) };
  }
}
