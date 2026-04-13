/**
 * google-drive-sync.ts — Google Drive backup/restore for Aggregaytor data.
 *
 * Uses the Google Drive v3 REST API to store backups in a dedicated
 * "Aggregaytor Backups" folder. Reuses chrome.identity.getAuthToken()
 * from the manifest oauth2 config (which already includes the drive.file scope).
 *
 * ## API Reference
 * https://developers.google.com/drive/api/reference/rest/v3
 *
 * ## Data Flow
 * - backupToDrive()   → exportAllData() → upload JSON to Drive
 * - restoreFromDrive() → download JSON from Drive → importAllData()
 * - getDriveBackupStatus() → check last backup time and file info
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;

import { exportAllData, importAllData } from './export-import.js';

// Need drive.file scope (already in manifest.json oauth2.scopes)
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_NAME = 'Aggregaytor Backups';
const BACKUP_FILENAME = 'aggregaytor-backup.json';
const FOLDER_ID_KEY = 'aggregaytor_drive_folder_id';

// ── Auth Helper ──────────────────────────────────────────────────────────────

/**
 * Get a valid OAuth access token via chrome.identity.
 * Uses the scopes defined in manifest.json's oauth2 section.
 * Returns null if auth fails or is denied by the user.
 */
async function getAuthToken(interactive = false): Promise<string | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome?.identity?.getAuthToken) return null;
    return new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive }, (token: string) => {
        if (chrome.runtime.lastError) {
          console.warn('[GoogleDrive] Auth failed:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(token || null);
        }
      });
    });
  } catch {
    return null;
  }
}

// ── Drive API Fetch Helper ───────────────────────────────────────────────────

/**
 * Make an authenticated request to the Google Drive API.
 * Retries once with a fresh token if the first attempt gets a 401.
 */
async function driveFetch(
  url: string,
  opts: RequestInit = {},
  retry = true,
): Promise<any> {
  const token = await getAuthToken();
  if (!token) throw new Error('Not authenticated. Click "Connect Google" in settings.');

  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });

  if (res.status === 401 && retry) {
    // Token expired — revoke and get a fresh one
    await new Promise<void>((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
    return driveFetch(url, opts, false);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Drive API ${res.status}: ${body.slice(0, 200)}`);
  }

  // Some responses have no body (204)
  if (res.status === 204) return null;

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

// ── Folder Management ────────────────────────────────────────────────────────

/**
 * Get or create the "Aggregaytor Backups" folder in Google Drive.
 * Caches the folder ID in chrome.storage.local.
 */
async function getOrCreateFolder(): Promise<string> {
  // Check cache first
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    const data = await chrome.storage.local.get(FOLDER_ID_KEY);
    if (data[FOLDER_ID_KEY]) {
      // Verify the cached folder still exists
      try {
        await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(data[FOLDER_ID_KEY])}?fields=id,trashed`);
        return data[FOLDER_ID_KEY];
      } catch {
        // Folder was deleted or inaccessible — clear cache and re-search
        await chrome.storage.local.remove(FOLDER_ID_KEY);
      }
    }
  }

  // Search for existing folder
  const q = `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`;
  const searchResult = await driveFetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`,
  );

  if (searchResult?.files?.length > 0) {
    const folderId = searchResult.files[0].id;
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      await chrome.storage.local.set({ [FOLDER_ID_KEY]: folderId });
    }
    return folderId;
  }

  // Create a new folder
  const created = await driveFetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });

  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    await chrome.storage.local.set({ [FOLDER_ID_KEY]: created.id });
  }
  return created.id;
}

/**
 * Search for the backup file inside the Aggregaytor Backups folder.
 * Returns { id, modifiedTime, name } or null if not found.
 */
async function findBackupFile(folderId: string): Promise<{ id: string; modifiedTime: string; name: string } | null> {
  const q = `'${folderId}' in parents and name='${BACKUP_FILENAME}' and trashed=false`;
  const result = await driveFetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&spaces=drive`,
  );

  if (result?.files?.length > 0) {
    return result.files[0];
  }
  return null;
}

// ── Backup / Restore ─────────────────────────────────────────────────────────

/**
 * Upload a full backup of all PouchDB data to Google Drive.
 * Creates or overwrites the backup file in the "Aggregaytor Backups" folder.
 * @returns The file ID on success, or an error message.
 */
export async function backupToDrive(): Promise<{ ok: boolean; fileId?: string; error?: string }> {
  try {
    // 1. Export all data as JSON
    const jsonData = await exportAllData();

    // 2. Find or create the backup folder
    const folderId = await getOrCreateFolder();

    // 3. Search for existing backup file
    const existing = await findBackupFile(folderId);

    // Build multipart body (metadata + content)
    const boundary = '---aggregaytor-backup-boundary';
    const metadata = existing
      ? { name: BACKUP_FILENAME, mimeType: 'application/json' }
      : { name: BACKUP_FILENAME, mimeType: 'application/json', parents: [folderId] };

    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      `${jsonData}\r\n` +
      `--${boundary}--`;

    let result: any;

    if (existing) {
      // 4. Update existing file (PATCH)
      result = await driveFetch(
        `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body: multipartBody,
        },
      );
    } else {
      // 5. Create new file (POST)
      result = await driveFetch(
        `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body: multipartBody,
        },
      );
    }

    return { ok: true, fileId: result.id };
  } catch (err: any) {
    console.error('[GoogleDrive] Backup failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Download the backup from Google Drive and restore it into PouchDB.
 * @returns The number of imported documents on success, or an error message.
 */
export async function restoreFromDrive(): Promise<{ ok: boolean; imported?: number; error?: string }> {
  try {
    // 1. Find the backup folder
    const folderId = await getOrCreateFolder();

    // 2. Find the backup file
    const file = await findBackupFile(folderId);
    if (!file) {
      return { ok: false, error: 'No backup file found in Google Drive.' };
    }

    // 3. Download the file content (alt=media returns raw content)
    const jsonData = await driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`,
    );

    // driveFetch returns parsed JSON or text depending on content-type.
    // The backup is a JSON string, so we may need to re-stringify if it was parsed.
    const jsonStr = typeof jsonData === 'string' ? jsonData : JSON.stringify(jsonData);

    // 4. Import into PouchDB
    const { imported } = await importAllData(jsonStr);

    return { ok: true, imported };
  } catch (err: any) {
    console.error('[GoogleDrive] Restore failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Check the status of the latest backup on Google Drive.
 * @returns Last backup time, file ID, and filename if a backup exists.
 */
export async function getDriveBackupStatus(): Promise<{
  lastBackup?: string;
  fileId?: string;
  fileName?: string;
}> {
  try {
    const folderId = await getOrCreateFolder();
    const file = await findBackupFile(folderId);

    if (!file) return {};

    return {
      lastBackup: file.modifiedTime,
      fileId: file.id,
      fileName: file.name,
    };
  } catch (err: any) {
    console.warn('[GoogleDrive] Status check failed:', err.message);
    return {};
  }
}
