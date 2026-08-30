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

/**
 * Pick a human-looking send delay in [MIN_DELAY_MS, MAX_DELAY_MS).
 *
 * Randomizing the gap before an auto-reply avoids the tell-tale instant,
 * fixed-interval responses that read as automation.
 *
 * @returns Delay in milliseconds.
 */
export function randomDelay(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

/**
 * Queue a new auto-respond job for an incoming message, rate-limited per
 * contact.
 *
 * If this contact received a *sent* auto-response within the last
 * RATE_LIMIT_MS, no job is queued (returns null) so the responder can't spam
 * the same person. Otherwise a 'pending' job is scheduled `delayMs` (or a
 * random human-looking delay) into the future.
 *
 * @param contactId        Contact to respond to.
 * @param platform         Platform to send on.
 * @param triggerMessageId _id of the inbound message that triggered this.
 * @param delayMs          Explicit send delay; defaults to randomDelay().
 * @param db               Optional store override.
 * @returns The queued AutoRespondDoc, or null if rate-limited.
 */
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

/**
 * Fetch pending auto-respond jobs whose scheduled time has arrived, oldest
 * first. This is the poll the scheduler drains each tick.
 *
 * @param db  Optional store override.
 * @returns Due 'pending' jobs, ordered by scheduledAt ascending.
 */
export async function getPendingAutoResponds(db?: StoreDatabase): Promise<AutoRespondDoc[]> {
  const store = db || await getDB();
  const now = new Date().toISOString();
  const result = await store.find({
    selector: { docType: 'auto_respond', status: 'pending', scheduledAt: { $lte: now } },
    sort: [{ docType: 'asc' }, { scheduledAt: 'asc' }],
  });
  return result.docs as AutoRespondDoc[];
}

/**
 * Fetch auto-respond jobs in the 'draft' state — generated but awaiting user
 * review (low/medium tier).
 *
 * @param db  Optional store override.
 * @returns All 'draft' jobs.
 */
export async function getDraftAutoResponds(db?: StoreDatabase): Promise<AutoRespondDoc[]> {
  const store = db || await getDB();
  const result = await store.find({ selector: { docType: 'auto_respond', status: 'draft' } });
  return result.docs as AutoRespondDoc[];
}

/**
 * Fetch auto-respond jobs in the 'approved' state — user-approved and ready to
 * send.
 *
 * @param db  Optional store override.
 * @returns All 'approved' jobs.
 */
export async function getApprovedAutoResponds(db?: StoreDatabase): Promise<AutoRespondDoc[]> {
  const store = db || await getDB();
  const result = await store.find({ selector: { docType: 'auto_respond', status: 'approved' } });
  return result.docs as AutoRespondDoc[];
}

/**
 * Advance an auto-respond job to a new status and optionally patch its
 * generated-response fields.
 *
 * Only the provided `fields` are written; `generatedResponse` and
 * `suggestedPictureTag` accept explicit empty strings (checked with
 * `!== undefined`), while `tier`/`error` are applied only when truthy.
 *
 * @param id      Job _id.
 * @param status  New lifecycle status (see AutoRespondStatus).
 * @param fields  Optional response/tier/picture/error fields to update.
 * @param db      Optional store override.
 * @throws If the job does not exist (propagates the store's 404).
 */
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
