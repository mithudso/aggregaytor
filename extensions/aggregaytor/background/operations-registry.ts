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
 * On top of that, operations whose name matches a MUTATING verb are classified
 * `write` and refused unless the caller passes `confirmWrite: true` (or a valid
 * debug token). Reads run freely for a trusted origin. No operation is exposed
 * to a content script or an external page.
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

/** Verbs that mark an exported operation as state-mutating (write-gated). */
const WRITE_VERB_RE = /^(upsert|delete|remove|put|post|save|write|set|update|purge|clear|drop|sync|block|hide|unblock|share|unshare|create|add|enqueue|reset|import|migrate|record|train|send|toggle|apply|revoke)/i;

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
      kind: WRITE_VERB_RE.test(key) ? 'write' : 'read',
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
