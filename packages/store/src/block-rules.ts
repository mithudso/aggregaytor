/**
 * block-rules.ts — Auto-block rule CRUD and evaluation.
 */

import type { BlockRuleDoc, BlockRuleCondition, ThreadMetaDoc, MessageDoc } from './types.js';
import type { Platform } from '@aggregaytor/adapter-core';
import { getDB } from './db.js';
import { upsertThreadMeta } from './thread-meta.js';

export async function createBlockRule(
  input: { name: string; condition: BlockRuleCondition; action: 'block' | 'archive' | 'hide' },
  db?: PouchDB.Database,
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
  return doc;
}

export async function getAllBlockRules(
  db?: PouchDB.Database,
): Promise<BlockRuleDoc[]> {
  const store = db || await getDB();
  const result = await store.find({ selector: { docType: 'block_rule' } });
  return result.docs as BlockRuleDoc[];
}

export async function updateBlockRule(
  id: string,
  updates: Partial<BlockRuleDoc>,
  db?: PouchDB.Database,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id) as BlockRuleDoc;
  Object.assign(doc, updates);
  await store.put(doc);
}

export async function deleteBlockRule(
  id: string,
  db?: PouchDB.Database,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id);
  await store.remove(doc);
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

export async function executeAction(
  contactId: string,
  platform: Platform,
  action: 'block' | 'archive' | 'hide',
  ruleId: string,
  db?: PouchDB.Database,
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

  // Increment rule execution count
  try {
    const rule = await store.get(ruleId) as BlockRuleDoc;
    rule.executedCount = (rule.executedCount || 0) + 1;
    await store.put(rule);
  } catch { /* ignore */ }
}
