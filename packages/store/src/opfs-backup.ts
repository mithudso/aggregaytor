/**
 * opfs-backup.ts — Supplemental local snapshots in OPFS.
 */

import { importAllData } from './export-import.js';

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

async function getBackupDirectory(create = true): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(BACKUP_DIR, { create });
}

async function readTextFile(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile();
  return file.text();
}

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

export async function saveOpfsSnapshotData(
  jsonData: string,
  meta?: { reason?: string },
): Promise<OpfsBackupStatus> {
  const dir = await getBackupDirectory(true);
  if (!dir) return { available: false, exists: false };

  const fileHandle = await dir.getFileHandle(BACKUP_FILE, { create: true });
  const writer = await fileHandle.createWritable();
  await writer.write(jsonData);
  await writer.close();

  const savedAt = new Date().toISOString();
  const snapshotMeta = {
    ...summarizeSnapshot(jsonData, meta?.reason),
    sizeBytes: new Blob([jsonData]).size,
    modifiedAt: savedAt,
  };

  const metaHandle = await dir.getFileHandle(META_FILE, { create: true });
  const metaWriter = await metaHandle.createWritable();
  await metaWriter.write(JSON.stringify(snapshotMeta));
  await metaWriter.close();

  return snapshotMeta;
}

export async function getOpfsSnapshotStatus(): Promise<OpfsBackupStatus> {
  const dir = await getBackupDirectory(false);
  if (!dir) return { available: false, exists: false };

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

export async function restoreFromOpfsSnapshot(
  passphrase?: string,
): Promise<{ imported: number; snapshot: OpfsBackupStatus }> {
  const dir = await getBackupDirectory(false);
  if (!dir) throw new Error('OPFS is not available in this context');
  const fileHandle = await dir.getFileHandle(BACKUP_FILE);
  const jsonData = await readTextFile(fileHandle);
  const result = await importAllData(jsonData, passphrase);
  return {
    ...result,
    snapshot: await getOpfsSnapshotStatus(),
  };
}

export async function deleteOpfsSnapshot(): Promise<{ ok: true }> {
  const dir = await getBackupDirectory(false);
  if (!dir) return { ok: true };
  try { await dir.removeEntry(BACKUP_FILE); } catch {}
  try { await dir.removeEntry(META_FILE); } catch {}
  return { ok: true };
}
