/**
 * sync.ts — Remote replication is intentionally unsupported on the Dexie store.
 */

export interface SyncConfig {
  remoteUrl: string;
  auth?: { username: string; password: string };
}

export async function startSync(_config: SyncConfig): Promise<void> {
  throw new Error('Remote CouchDB replication is not supported with the Dexie-backed store');
}

export function stopSync(): void {}
