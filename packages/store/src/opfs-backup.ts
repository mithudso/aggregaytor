/**
 * opfs-backup.ts — Supplemental local snapshots in OPFS.
 *
 * Snapshots are always written encrypted: plaintext export envelopes are
 * wrapped in the AES-GCM encrypted envelope using the device-held backup key
 * (see getOrCreateBackupKey in export-import.ts) before they touch disk.
 */

import { importAllData, encryptExportData, getOrCreateBackupKey } from './export-import.js';

const BACKUP_DIR = 'aggregaytor-backups';
const BACKUP_FILE = 'latest-backup.json';
const META_FILE = 'latest-backup.meta.json';

export interface OpfsBackupStatus {
  available: boolean;
  exists: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  encrypted?: boolean;
  docCount?: number;
  reason?: string;
}

/**
 * Resolve the backup directory handle, or null when it isn't reachable.
 *
 * With `create: false` a missing directory throws `NotFoundError` rather than
 * returning null, so callers that only want to *look* (status, restore,
 * delete) must not see a raw DOMException on a fresh install.
 */
async function getBackupDirectory(create = true): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(BACKUP_DIR, { create });
  } catch (err) {
    if (create) throw err;
    return null;
  }
}

/** Read an OPFS file handle's contents as text. */
async function readTextFile(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile();
  return file.text();
}

/**
 * Derive a status summary (encrypted?, docCount) from an export envelope
 * string. Falls back to a minimal "exists" summary if the JSON can't be parsed,
 * so a partially-written snapshot doesn't throw here.
 */
function summarizeSnapshot(jsonData: string, reason?: string): OpfsBackupStatus {
  try {
    const parsed = JSON.parse(jsonData) as Record<string, unknown>;
    return {
      available: true,
      exists: true,
      encrypted: parsed.encrypted === true,
      docCount: typeof parsed.docCount === 'number' ? parsed.docCount : undefined,
      reason,
    };
  } catch {
    return {
      available: true,
      exists: true,
      reason,
    };
  }
}

/**
 * Write the supplemental OPFS snapshot.
 *
 * This is a *best-effort* secondary copy: callers such as `backupToDrive()`
 * run it alongside the primary backup, so an OPFS failure (quota, unsupported
 * context, locked file) is reported in the returned status instead of being
 * thrown — a broken snapshot must not fail the backup that succeeded.
 */
export async function saveOpfsSnapshotData(
  jsonData: string,
  meta?: { reason?: string },
): Promise<OpfsBackupStatus> {
  try {
    const dir = await getBackupDirectory(true);
    if (!dir) return { available: false, exists: false };

    // Summarize from the incoming data first — for plaintext input this
    // preserves docCount in the meta file (docCount is a harmless integer;
    // the doc *content* is what must never be stored unencrypted).
    const summary = summarizeSnapshot(jsonData, meta?.reason);

    // Encrypt-at-rest invariant: anything not verifiably an encrypted
    // envelope gets wrapped with the device backup key before hitting OPFS.
    // Callers that already pass ciphertext (e.g. backupToDrive) are written
    // as-is; encryptExportData is a no-op on encrypted envelopes.
    let payload = jsonData;
    if (summary.encrypted !== true) {
      payload = await encryptExportData(jsonData, await getOrCreateBackupKey());
      summary.encrypted = true;
    }

    const fileHandle = await dir.getFileHandle(BACKUP_FILE, { create: true });
    const writer = await fileHandle.createWritable();
    await writer.write(payload);
    await writer.close();

    const snapshotMeta = {
      ...summary,
      // Read the size back off the file instead of building a throwaway Blob,
      // which would duplicate the whole export in memory.
      sizeBytes: (await fileHandle.getFile()).size,
      modifiedAt: new Date().toISOString(),
    };

    const metaHandle = await dir.getFileHandle(META_FILE, { create: true });
    const metaWriter = await metaHandle.createWritable();
    await metaWriter.write(JSON.stringify(snapshotMeta));
    await metaWriter.close();

    return snapshotMeta;
  } catch (err) {
    console.warn('[Aggregaytor:Store] OPFS snapshot write failed:', err);
    return {
      available: true,
      exists: false,
      reason: `snapshot write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Report on the latest OPFS snapshot: whether OPFS is available, whether a
 * snapshot exists, and its size/metadata.
 *
 * Prefers the sidecar meta file; if that's missing or corrupt it falls back to
 * stat-ing the backup file directly. Never throws — a missing directory or file
 * is reported as `exists: false`.
 *
 * @returns The snapshot status.
 */
export async function getOpfsSnapshotStatus(): Promise<OpfsBackupStatus> {
  const dir = await getBackupDirectory(false);
  // No directory means either OPFS is missing or nothing was ever saved.
  if (!dir) return { available: opfsAvailable(), exists: false };

  try {
    const metaHandle = await dir.getFileHandle(META_FILE);
    return JSON.parse(await readTextFile(metaHandle)) as OpfsBackupStatus;
  } catch {
    try {
      const fileHandle = await dir.getFileHandle(BACKUP_FILE);
      const file = await fileHandle.getFile();
      return {
        available: true,
        exists: true,
        sizeBytes: file.size,
        modifiedAt: new Date(file.lastModified).toISOString(),
      };
    } catch {
      return { available: true, exists: false };
    }
  }
}

/** True when the OPFS API (navigator.storage.getDirectory) is available here. */
function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

/**
 * Restore the local store from the latest OPFS snapshot.
 *
 * Snapshots are encrypted at rest; with no explicit passphrase, importAllData
 * falls back to the persisted device backup key. Distinguishes "no snapshot
 * written" from "OPFS unavailable" in its thrown message.
 *
 * @param passphrase  Optional decryption passphrase; defaults to the device key.
 * @returns Imported-doc count plus the post-restore snapshot status.
 * @throws If OPFS is unavailable or no snapshot file exists.
 */
export async function restoreFromOpfsSnapshot(
  passphrase?: string,
): Promise<{ imported: number; snapshot: OpfsBackupStatus }> {
  const dir = await getBackupDirectory(false);
  if (!dir) {
    // Distinguish "no snapshot has ever been written" from "OPFS is missing",
    // since both surface here as a null handle.
    throw new Error(opfsAvailable()
      ? 'No OPFS snapshot found'
      : 'OPFS is not available in this context');
  }
  const fileHandle = await dir.getFileHandle(BACKUP_FILE).catch(() => {
    throw new Error('No OPFS snapshot found');
  });
  const jsonData = await readTextFile(fileHandle);
  // Snapshots are encrypted at rest; when no explicit passphrase is given,
  // importAllData falls back to the persisted device backup key.
  const result = await importAllData(jsonData, passphrase);
  return {
    ...result,
    snapshot: await getOpfsSnapshotStatus(),
  };
}

/**
 * Delete the OPFS snapshot and its meta file. Idempotent and best-effort:
 * a missing directory or file is treated as already-deleted.
 *
 * @returns `{ ok: true }` once both entries are gone (or were never there).
 */
export async function deleteOpfsSnapshot(): Promise<{ ok: true }> {
  const dir = await getBackupDirectory(false);
  if (!dir) return { ok: true };
  try { await dir.removeEntry(BACKUP_FILE); } catch {}
  try { await dir.removeEntry(META_FILE); } catch {}
  return { ok: true };
}
