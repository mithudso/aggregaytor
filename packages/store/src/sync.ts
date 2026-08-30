/**
 * sync.ts — Remote replication is intentionally unsupported on the Dexie store.
 */

export interface SyncConfig {
  remoteUrl: string;
  auth?: { username: string; password: string };
}

/**
 * Deliberately unsupported: the Dexie-backed store has no remote replication.
 *
 * Kept as an explicit throw (rather than a silent no-op) so any caller that
 * still wires up CouchDB replication fails loudly instead of believing sync is
 * running.
 *
 * @param _config  Ignored remote-sync config.
 * @throws Always — remote replication is not available.
 */
export async function startSync(_config: SyncConfig): Promise<void> {
  throw new Error('Remote CouchDB replication is not supported with the Dexie-backed store');
}

/** No-op counterpart to {@link startSync}; there is no replication to stop. */
export function stopSync(): void {}
