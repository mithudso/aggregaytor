/**
 * block-rules.ts — Auto-block rule CRUD and evaluation.
 *
 * ## Cache
 *
 * `getAllBlockRules()` is on the hot path — the service worker calls it for
 * every incoming message batch (`runBlockRules()`) and every 5 minutes via
 * the periodic alarm. Rules change only on explicit user CRUD.
 *
 * We maintain a `_rulesCache` (full list) populated on first read and
 * invalidated by every write (`create`, `update`, `delete`). No TTL — the
 * cache is event-driven. The only caller who bypasses the cache is the test
 * suite (via the `db` parameter, since test DBs are isolated).
 */

import type { BlockRuleDoc, BlockRuleCondition, ThreadMetaDoc, MessageDoc } from './types.js';
import type { Platform } from '@aggregaytor/adapter-core';
import { getDB } from './db.js';
import type { StoreDatabase } from './db.js';
import { upsertThreadMeta } from './thread-meta.js';

let _rulesCache: BlockRuleDoc[] | null = null;

/** Invalidate the cache — called by every write path in this module. */
export function invalidateBlockRulesCache(): void {
  _rulesCache = null;
}

/**
 * Create an enabled block rule and invalidate the rules cache.
 *
 * The `_id` is `blockrule:{timestamp}-{random}`. When a test passes its own
 * `db`, the module cache is left untouched (test DBs are isolated).
 *
 * @param input  Rule name, trigger condition, and action.
 * @param db     Optional store override.
 * @returns The newly written BlockRuleDoc.
 */
export async function createBlockRule(
  input: { name: string; condition: BlockRuleCondition; action: 'block' | 'archive' | 'hide' },
  db?: StoreDatabase,
): Promise<BlockRuleDoc> {
  const store = db || await getDB();
  const id = `blockrule:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const doc: BlockRuleDoc = {
    _id: id,
    docType: 'block_rule',
    name: input.name,
    condition: input.condition,
    action: input.action,
    enabled: true,
    executedCount: 0,
    createdAt: new Date().toISOString(),
  };
  await store.put(doc);
  if (!db) invalidateBlockRulesCache();
  return doc;
}

/**
 * Return every block rule, served from the module cache on the hot path.
 *
 * A test-injected `db` bypasses the cache entirely. The cached list is copied
 * before it is handed out so an in-place sort/splice by a caller can't corrupt
 * the shared array. Populates the cache on the first non-test read.
 *
 * @param db  Optional store override (bypasses the cache).
 * @returns A fresh array of all block rules.
 */
export async function getAllBlockRules(
  db?: StoreDatabase,
): Promise<BlockRuleDoc[]> {
  // Tests inject their own DB and must not share the module-level cache
  if (db) {
    const result = await db.find({ selector: { docType: 'block_rule' } });
    return result.docs as BlockRuleDoc[];
  }
  // Hand out a copy: the cached array outlives every caller, so returning it
  // directly lets an in-place sort/splice by one caller corrupt it for all.
  if (_rulesCache) return [..._rulesCache];
  const store = await getDB();
  const result = await store.find({ selector: { docType: 'block_rule' } });
  _rulesCache = result.docs as BlockRuleDoc[];
  return [..._rulesCache];
}

/**
 * Apply a partial update to a block rule and invalidate the cache.
 *
 * Identity fields (`_id`, `_rev`, `docType`) are stripped from `updates` so a
 * caller-supplied patch can't fork the rule into a second doc or break the
 * docType index.
 *
 * @param id       Rule _id to update.
 * @param updates  Fields to merge (identity fields ignored).
 * @param db       Optional store override.
 * @throws If the rule does not exist (propagates the store's 404).
 */
export async function updateBlockRule(
  id: string,
  updates: Partial<BlockRuleDoc>,
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id) as BlockRuleDoc;
  // Never let a caller-supplied patch rewrite the document's identity — that
  // would fork the rule into a second doc or break the docType index.
  const { _id: _ignoredId, _rev: _ignoredRev, docType: _ignoredType, ...safeUpdates } = updates;
  Object.assign(doc, safeUpdates);
  await store.put(doc);
  if (!db) invalidateBlockRulesCache();
}

/**
 * Delete a block rule by _id and invalidate the cache.
 *
 * @param id  Rule _id to remove.
 * @param db  Optional store override.
 * @throws If the rule does not exist (the `get` propagates the store's 404).
 */
export async function deleteBlockRule(
  id: string,
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id);
  await store.remove(doc);
  if (!db) invalidateBlockRulesCache();
}

/**
 * Evaluate block rules against a thread's messages and metadata.
 * Returns actions to execute (if any).
 */
export function evaluateRules(
  rules: BlockRuleDoc[],
  messages: MessageDoc[],
  meta: ThreadMetaDoc | null,
): { rule: BlockRuleDoc; action: 'block' | 'archive' | 'hide' }[] {
  const results: { rule: BlockRuleDoc; action: 'block' | 'archive' | 'hide' }[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (matchesCondition(rule.condition, messages, meta)) {
      results.push({ rule, action: rule.action });
    }
  }
  return results;
}

/**
 * Test a single rule condition against a thread's messages/metadata.
 *
 * Pure predicate (no I/O). Each condition type reads a different subset of
 * fields — see {@link BlockRuleCondition}. Unknown types return false.
 *
 * @param condition  The trigger condition to evaluate.
 * @param messages   The thread's messages.
 * @param meta       The thread's metadata (or null).
 * @returns True if the condition is met.
 */
function matchesCondition(
  condition: BlockRuleCondition,
  messages: MessageDoc[],
  meta: ThreadMetaDoc | null,
): boolean {
  switch (condition.type) {
    case 'ignored_count': {
      // Count consecutive outbound messages without any inbound reply at the end
      const sorted = [...messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      let consecutive = 0;
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].direction === 'out') consecutive++;
        else break;
      }
      return consecutive >= (condition.threshold || 3);
    }
    case 'keyword': {
      const keywords = (condition.keywords || []).map(k => k.toLowerCase());
      return messages.some(m =>
        m.direction === 'in' && keywords.some(k => m.body.toLowerCase().includes(k))
      );
    }
    case 'no_response_days': {
      const sorted = [...messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const lastOut = [...sorted].reverse().find(m => m.direction === 'out');
      const lastIn = [...sorted].reverse().find(m => m.direction === 'in');
      if (!lastOut) return false;
      const outTs = new Date(lastOut.timestamp).getTime();
      const inTs = lastIn ? new Date(lastIn.timestamp).getTime() : 0;
      if (inTs > outTs) return false; // they responded after our last message
      const daysSince = (Date.now() - outTs) / 86_400_000;
      return daysSince >= (condition.days || 7);
    }
    case 'deleted_chat': {
      return (meta?.deletedChatCount || 0) >= (condition.threshold || 1);
    }
    default:
      return false;
  }
}

/**
 * Carry out a rule's action on a thread (via thread-meta flags) and bump the
 * rule's `executedCount`.
 *
 * 'block' sets both archived + hidden; 'archive' sets archived; 'hide' sets
 * hidden. The counter increment is best-effort: a failure there is logged but
 * does NOT undo the action, which has already been applied.
 *
 * @param contactId  Contact to act on.
 * @param platform   Contact's platform.
 * @param action     What to do: block | archive | hide.
 * @param ruleId     Rule whose executedCount to bump.
 * @param db         Optional store override.
 */
export async function executeAction(
  contactId: string,
  platform: Platform,
  action: 'block' | 'archive' | 'hide',
  ruleId: string,
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();

  switch (action) {
    case 'block':
      await upsertThreadMeta(contactId, platform, { archived: true, hidden: true }, store);
      break;
    case 'archive':
      await upsertThreadMeta(contactId, platform, { archived: true }, store);
      break;
    case 'hide':
      await upsertThreadMeta(contactId, platform, { hidden: true }, store);
      break;
  }

  // Increment rule execution count. Invalidate the cache so the bumped
  // count is visible to the next getAllBlockRules() caller (the settings
  // UI shows per-rule trigger counts).
  try {
    const rule = await store.get(ruleId) as BlockRuleDoc;
    rule.executedCount = (rule.executedCount || 0) + 1;
    await store.put(rule);
    if (!db) invalidateBlockRulesCache();
  } catch (err) {
    // Non-fatal: the block action itself already succeeded. Still log it —
    // a permanently failing counter means the settings UI shows stale stats.
    console.warn('[Aggregaytor:Store] block rule counter update failed:', ruleId, err);
  }
}
