/**
 * export-import.ts — Encrypted export/import of PouchDB data.
 *
 * Provides full-database and blocked-contacts export/import with optional
 * AES-GCM encryption via the Web Crypto API (SubtleCrypto). Key derivation
 * uses PBKDF2 with 210,000 iterations, a random 16-byte salt, and produces
 * a 256-bit AES key. Encryption uses a random 12-byte IV.
 *
 * Envelope format (plaintext):
 *   { format, encrypted: false, exportedAt, version, docCount, docs }
 *
 * Envelope format (encrypted):
 *   { format, encrypted: true, salt, iv, ciphertext }
 */

import { getDB } from './db.js';

const FORMAT = 'aggregaytor-export-v1';
const VERSION = '0.45.0';
const PBKDF2_ITERATIONS = 210_000;
const AES_KEY_BITS = 256;
const IV_BYTES = 12;
const SALT_BYTES = 16;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert an ArrayBuffer or Uint8Array to a hex string. */
function bufToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Convert a hex string back to a Uint8Array. */
function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Derive an AES-GCM key from a passphrase and salt using PBKDF2. */
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a UTF-8 string with AES-GCM, returning { salt, iv, ciphertext }. */
async function encrypt(
  plaintext: string,
  passphrase: string,
): Promise<{ salt: string; iv: string; ciphertext: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext),
  );
  // Convert ciphertext to base64
  const bytes = new Uint8Array(encrypted);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const ciphertext = btoa(binary);
  return { salt: bufToHex(salt), iv: bufToHex(iv), ciphertext };
}

/** Decrypt an AES-GCM ciphertext back to a UTF-8 string. */
async function decrypt(
  ciphertext: string,
  iv: string,
  salt: string,
  passphrase: string,
): Promise<string> {
  const key = await deriveKey(passphrase, hexToBuf(salt));
  // Convert base64 ciphertext back to ArrayBuffer
  const binary = atob(ciphertext);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBuf(iv).buffer as ArrayBuffer },
    key,
    bytes.buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(decrypted);
}

// ── Export / Import ────────────────────────────────────────────────────────

/**
 * Export all PouchDB data as a JSON blob, optionally encrypted.
 * Fetches all docs via allDocs, strips _rev, wraps in an envelope
 * with metadata (version, exportedAt, docCount).
 */
export async function exportAllData(passphrase?: string): Promise<string> {
  const db = await getDB();
  const result = await db.allDocs({ include_docs: true });
  const docs = result.rows
    .filter(r => r.doc && !r.id.startsWith('_design/'))
    .map(r => {
      const doc = { ...r.doc } as Record<string, unknown>;
      delete doc._rev;
      return doc;
    });

  const envelope = {
    format: FORMAT,
    encrypted: false as const,
    exportedAt: new Date().toISOString(),
    version: VERSION,
    docCount: docs.length,
    docs,
  };

  if (passphrase) {
    const plaintext = JSON.stringify(envelope);
    const { salt, iv, ciphertext } = await encrypt(plaintext, passphrase);
    return JSON.stringify({
      format: FORMAT,
      encrypted: true as const,
      salt,
      iv,
      ciphertext,
    });
  }

  return JSON.stringify(envelope);
}

/**
 * Import data from a JSON blob, optionally encrypted.
 * Decrypts if passphrase provided, validates envelope, upserts all docs.
 * Returns count of imported documents.
 */
export async function importAllData(
  jsonStr: string,
  passphrase?: string,
): Promise<{ imported: number }> {
  const db = await getDB();
  let parsed = JSON.parse(jsonStr);

  // Decrypt if needed
  if (parsed.encrypted === true) {
    if (!passphrase) throw new Error('Data is encrypted but no passphrase was provided');
    const plaintext = await decrypt(parsed.ciphertext, parsed.iv, parsed.salt, passphrase);
    parsed = JSON.parse(plaintext);
  }

  if (parsed.format !== FORMAT) {
    throw new Error(`Unknown export format: ${parsed.format}`);
  }

  const docs = parsed.docs as Record<string, unknown>[];
  let imported = 0;

  for (const doc of docs) {
    const id = doc._id as string;
    if (!id) continue;

    // Upsert: try to get existing _rev for conflict-free put
    try {
      const existing = await db.get(id);
      await db.put({ ...doc, _rev: existing._rev } as any);
    } catch (err: any) {
      if (err.status === 404) {
        await db.put(doc as any);
      } else {
        throw err;
      }
    }
    imported++;
  }

  return { imported };
}

/**
 * Export only blocked/archived contacts.
 * Fetches all thread_meta docs and filters for archived or hidden entries.
 */
export async function exportBlocked(): Promise<string> {
  const db = await getDB();
  const result = await db.allDocs({
    startkey: 'meta:',
    endkey: 'meta:\uffff',
    include_docs: true,
  });
  const docs = result.rows
    .filter(r => {
      const doc = r.doc as any;
      return doc && (doc.archived || doc.hidden);
    })
    .map(r => {
      const doc = { ...r.doc } as Record<string, unknown>;
      delete doc._rev;
      return doc;
    });

  return JSON.stringify({
    format: FORMAT,
    encrypted: false,
    exportedAt: new Date().toISOString(),
    version: VERSION,
    docCount: docs.length,
    docs,
  });
}

/**
 * Import blocked contacts list.
 * Upserts thread_meta docs with archived/hidden flags from the import.
 */
export async function importBlocked(jsonStr: string): Promise<{ imported: number }> {
  const db = await getDB();
  const parsed = JSON.parse(jsonStr);

  if (parsed.format !== FORMAT) {
    throw new Error(`Unknown export format: ${parsed.format}`);
  }

  const docs = parsed.docs as Record<string, unknown>[];
  let imported = 0;

  for (const doc of docs) {
    const id = doc._id as string;
    if (!id) continue;

    try {
      const existing = await db.get(id);
      await db.put({ ...existing, ...doc, _rev: existing._rev } as any);
    } catch (err: any) {
      if (err.status === 404) {
        await db.put(doc as any);
      } else {
        throw err;
      }
    }
    imported++;
  }

  return { imported };
}
