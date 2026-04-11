/**
 * auto-respond.ts — Auto-respond queue management.
 */

import type { Platform } from '@aggregaytor/adapter-core';
import type { AutoRespondDoc } from './types.js';
import { getDB } from './db.js';

const MIN_DELAY_MS = 20_000;     // 20 seconds minimum
const MAX_DELAY_MS = 120_000;    // 2 minutes maximum
const RATE_LIMIT_MS = 300_000;   // 5 minutes between auto-responses per contact

export function randomDelay(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

export async function queueAutoRespond(
  contactId: string,
  platform: Platform,
  triggerMessageId: string,
  delayMs?: number,
  db?: PouchDB.Database,
): Promise<AutoRespondDoc | null> {
  const store = db || await getDB();
  const now = Date.now();

  // Rate limit: check for recent auto-responds to this contact
  const result = await store.find({
    selector: { docType: 'auto_respond', contactId },
  });
  const recent = (result.docs as AutoRespondDoc[]).filter(d =>
    d.status === 'sent' && (now - new Date(d.createdAt).getTime()) < RATE_LIMIT_MS
  );
  if (recent.length > 0) return null; // rate limited

  const delay = delayMs ?? randomDelay();
  const scheduledAt = new Date(now + delay).toISOString();
  const id = `autoresp:${contactId}:${now}`;

  const doc: AutoRespondDoc = {
    _id: id,
    docType: 'auto_respond',
    contactId,
    platform,
    triggerMessageId,
    scheduledAt,
    status: 'pending',
    generatedResponse: '',
    error: '',
    createdAt: new Date(now).toISOString(),
  };
  await store.put(doc);
  return doc;
}

export async function getPendingAutoResponds(
  db?: PouchDB.Database,
): Promise<AutoRespondDoc[]> {
  const store = db || await getDB();
  const now = new Date().toISOString();
  const result = await store.find({
    selector: { docType: 'auto_respond', status: 'pending' },
  });
  return (result.docs as AutoRespondDoc[]).filter(d => d.scheduledAt <= now);
}

export async function updateAutoRespondStatus(
  id: string,
  status: AutoRespondDoc['status'],
  fields?: { generatedResponse?: string; error?: string },
  db?: PouchDB.Database,
): Promise<void> {
  const store = db || await getDB();
  const doc = await store.get(id) as AutoRespondDoc;
  doc.status = status;
  if (fields?.generatedResponse) doc.generatedResponse = fields.generatedResponse;
  if (fields?.error) doc.error = fields.error;
  await store.put(doc);
}
