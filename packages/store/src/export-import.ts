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
import type { StoreDatabase, StoreDoc } from './db.js';

declare const chrome: any;

const FORMAT = 'aggregaytor-export-v1';
const VERSION = '0.45.0';
const PBKDF2_ITERATIONS = 210_000;
const AES_KEY_BITS = 256;
const IV_BYTES = 12;
const SALT_BYTES = 16;
/** Docs per bulkDocs call on import — bounds transaction + peak memory size. */
const IMPORT_CHUNK = 500;
/** chrome.storage.local key holding the device backup encryption key (hex). */
const BACKUP_KEY_STORAGE_KEY = 'aggregaytor_backup_key';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert an ArrayBuffer or Uint8Array to a hex string. */
function bufToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert a hex string back to a Uint8Array.
 * Validated: a malformed envelope would otherwise silently decode to zero
 * bytes and surface as an unexplained decryption failure.
 */
function hexToBuf(hex: string, field: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Malformed export envelope: "${field}" is not a hex string`);
  }
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
  if (typeof ciphertext !== 'string' || !ciphertext) {
    throw new Error('Malformed export envelope: "ciphertext" is missing');
  }
  const key = await deriveKey(passphrase, hexToBuf(salt, 'salt'));
  const ivBytes = hexToBuf(iv, 'iv');
  // Convert base64 ciphertext back to ArrayBuffer
  const binary = atob(ciphertext);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes.buffer as ArrayBuffer },
      key,
      bytes.buffer as ArrayBuffer,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    // AES-GCM authentication failures surface as an opaque OperationError.
    // Never echo the passphrase or key material into the message.
    throw new Error('Decryption failed — incorrect passphrase or corrupted export file');
  }
}

// ── Device backup key ──────────────────────────────────────────────────────

/**
 * In-process memoization of the key lookup/creation so concurrent callers
 * (e.g. a Drive backup and an OPFS snapshot racing) can never generate two
 * different keys and encrypt with one while persisting the other.
 */
let _backupKeyPromise: Promise<string> | null = null;

function chromeLocalStorageAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.local;
}

/**
 * Read the persisted device backup key, or null when none exists (or when
 * chrome.storage.local is not reachable in this context). Never creates one.
 */
async function getStoredBackupKey(): Promise<string | null> {
  if (!chromeLocalStorageAvailable()) return null;
  const data = await chrome.storage.local.get(BACKUP_KEY_STORAGE_KEY);
  const existing = data?.[BACKUP_KEY_STORAGE_KEY];
  return typeof existing === 'string' && /^[0-9a-f]{64}$/.test(existing) ? existing : null;
}

/**
 * Get the device-held backup passphrase, lazily creating and persisting it on
 * first use (32 random bytes → 64-char hex, stored in chrome.storage.local
 * under `aggregaytor_backup_key`). The hex string is fed to the existing
 * PBKDF2 → AES-GCM path as the passphrase.
 *
 * Threat-model tradeoff, documented deliberately: this key encrypts backups
 * *at rest* in Google Drive and OPFS so plaintext DMs never sit in the user's
 * Drive or on disk. It is NOT cross-device secret escrow — restoring on the
 * SAME browser profile works transparently (the key lives in local storage),
 * but restoring on a DIFFERENT device requires the user to have copied the
 * key out beforehand. That is acceptable: the goal is confidentiality of the
 * stored blob, not portable key management.
 *
 * The key must NEVER be logged, exported inside a backup's plaintext, or
 * echoed into an error message.
 */
export async function getOrCreateBackupKey(): Promise<string> {
  if (_backupKeyPromise) return _backupKeyPromise;
  _backupKeyPromise = (async () => {
    if (!chromeLocalStorageAvailable()) {
      throw new Error('Backup key unavailable: chrome.storage.local is not accessible in this context');
    }
    const existing = await getStoredBackupKey();
    if (existing) return existing;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const hex = bufToHex(raw);
    await chrome.storage.local.set({ [BACKUP_KEY_STORAGE_KEY]: hex });
    return hex;
  })();
  try {
    return await _backupKeyPromise;
  } catch (err) {
    // Don't cache failures — a later call may run in a context where
    // chrome.storage.local is reachable again.
    _backupKeyPromise = null;
    throw err;
  }
}

/**
 * Wrap an already-serialized export envelope in the encrypted envelope
 * format. If the input is already encrypted it is returned unchanged, so
 * callers can pass any exportAllData() output without double-encrypting.
 */
export async function encryptExportData(jsonData: string, passphrase: string): Promise<string> {
  try {
    const parsed = JSON.parse(jsonData);
    if (parsed?.encrypted === true) return jsonData;
  } catch {
    // Unparseable input still gets encrypted below — it may hold PII and the
    // invariant is that nothing plaintext reaches the backup destinations.
  }
  const { salt, iv, ciphertext } = await encrypt(jsonData, passphrase);
  return JSON.stringify({
    format: FORMAT,
    encrypted: true as const,
    salt,
    iv,
    ciphertext,
  });
}

// ── Import helpers ─────────────────────────────────────────────────────────

/**
 * Normalise one imported document, returning null when it must be skipped.
 *
 * Import data is untrusted — a backup file can be hand-edited, truncated, or
 * produced by an older build. `_rev` is dropped (the store assigns its own)
 * and `_deleted` is stripped, because a `_deleted: true` entry would otherwise
 * make "restore a backup" DELETE live documents.
 */
function sanitizeImportedDoc(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = { ...(raw as Record<string, unknown>) };
  const id = doc._id;
  if (typeof id !== 'string' || !id || id.startsWith('_design/')) return null;
  delete doc._rev;
  delete doc._deleted;
  return doc;
}

/** Validate an export envelope and return its sanitized, importable docs. */
function readEnvelopeDocs(parsed: unknown): Record<string, unknown>[] {
  const envelope = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  if (envelope.format !== FORMAT) {
    throw new Error(`Unknown export format: ${String(envelope.format)}`);
  }
  if (!Array.isArray(envelope.docs)) {
    throw new Error('Malformed export envelope: "docs" is not an array');
  }
  const docs: Record<string, unknown>[] = [];
  for (const raw of envelope.docs) {
    const doc = sanitizeImportedDoc(raw);
    if (doc) docs.push(doc);
  }
  return docs;
}

/**
 * Write imported docs in chunked bulk writes.
 *
 * `bulkDocs` already merges each doc onto whatever is stored under the same
 * `_id` and assigns a fresh revision, so the previous per-doc `get()` before
 * every `put()` was pure round-trip overhead (2N calls for N docs).
 */
async function writeImportedDocs(db: StoreDatabase, docs: Record<string, unknown>[]): Promise<number> {
  for (let i = 0; i < docs.length; i += IMPORT_CHUNK) {
    await db.bulkDocs(docs.slice(i, i + IMPORT_CHUNK) as unknown as StoreDoc[]);
  }
  return docs.length;
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

  // Decrypt if needed. When no explicit passphrase is given, fall back to the
  // persisted device backup key (never creating one — if none exists, the
  // blob cannot have been encrypted with it) so restores of automatic
  // Drive/OPFS backups work transparently on the same browser profile.
  if (parsed?.encrypted === true) {
    const effectivePassphrase = passphrase || (await getStoredBackupKey().catch(() => null));
    if (!effectivePassphrase) throw new Error('Data is encrypted but no passphrase was provided');
    const plaintext = await decrypt(parsed.ciphertext, parsed.iv, parsed.salt, effectivePassphrase);
    parsed = JSON.parse(plaintext);
  }

  const imported = await writeImportedDocs(db, readEnvelopeDocs(parsed));
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
  const imported = await writeImportedDocs(db, readEnvelopeDocs(JSON.parse(jsonStr)));
  return { imported };
}
