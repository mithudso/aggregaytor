/**
 * auto-respond.ts — Auto-respond queue management with escalation tiers.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { AutoRespondDoc, AutoRespondTier, AutoRespondStatus } from './types.js';
import { getDB } from './db.js';
import type { StoreDatabase } from './db.js';

const MIN_DELAY_MS = 20_000;
const MAX_DELAY_MS = 120_000;
const RATE_LIMIT_MS = 300_000;

export function randomDelay(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

export async function queueAutoRespond(
  contactId: string,
  platform: Platform,
  triggerMessageId: string,
  delayMs?: number,
  db?: StoreDatabase,
): Promise<AutoRespondDoc | null> {
  const store = db || await getDB();
  const now = Date.now();

  const result = await store.find({ selector: { docType: 'auto_respond', contactId } });
  const recent = (result.docs as AutoRespondDoc[]).filter(d =>
    d.status === 'sent' && (now - new Date(d.createdAt).getTime()) < RATE_LIMIT_MS
  );
  if (recent.length > 0) return null;

  const delay = delayMs ?? randomDelay();
  const doc: AutoRespondDoc = {
    _id: `autoresp:${contactId}:${now}`,
    docType: 'auto_respond',
    contactId,
    platform,
    triggerMessageId,
    scheduledAt: new Date(now + delay).toISOString(),
    tier: 'low',
    status: 'pending',
    generatedResponse: '',
    suggestedPictureTag: '',
    error: '',
    createdAt: new Date(now).toISOString(),
  };
  await store.put(doc);
  return doc;
}

export async function getPendingAutoResponds(db?: StoreDatabase): Promise<AutoRespondDoc[]> {
  const store = db || await getDB();
  const now = new Date().toISOString();
  const result = await store.find({
    selector: { docType: 'auto_respond', status: 'pending', scheduledAt: { $lte: now } },
    sort: [{ docType: 'asc' }, { scheduledAt: 'asc' }],
  });
  return result.docs as AutoRespondDoc[];
}

export async function getDraftAutoResponds(db?: StoreDatabase): Promise<AutoRespondDoc[]> {
  const store = db || await getDB();
  const result = await store.find({ selector: { docType: 'auto_respond', status: 'draft' } });
  return result.docs as AutoRespondDoc[];
}

export async function getApprovedAutoResponds(db?: StoreDatabase): Promise<AutoRespondDoc[]> {
  const store = db || await getDB();
  const result = await store.find({ selector: { docType: 'auto_respond', status: 'approved' } });
  return result.docs as AutoRespondDoc[];
}

export async function updateAutoRespondStatus(
  id: string,
  status: AutoRespondStatus,
  fields?: { generatedResponse?: string; tier?: AutoRespondTier; suggestedPictureTag?: string; error?: string },
  db?: StoreDatabase,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id) as AutoRespondDoc;
  doc.status = status;
  if (fields?.generatedResponse !== undefined) doc.generatedResponse = fields.generatedResponse;
  if (fields?.tier) doc.tier = fields.tier;
  if (fields?.suggestedPictureTag !== undefined) doc.suggestedPictureTag = fields.suggestedPictureTag;
  if (fields?.error) doc.error = fields.error;
  await store.put(doc);
}
