/**
 * sync.ts — Future CouchDB replication stub.
 */

import { getDB } from './db.js';

export interface SyncConfig {
  remoteUrl: string;
  auth?: { username: string; password: string };
}

let _sync: PouchDB.Replication.Sync<{}> | null = null;

export async function startSync(config: SyncConfig): Promise<void> {
  const db = await getDB();
  const remoteOpts: PouchDB.Configuration.RemoteDatabaseConfiguration = {};
  if (config.auth) {
    remoteOpts.auth = config.auth;
  }
  _sync = db.sync(config.remoteUrl, {
    live: true,
    retry: true,
    ...remoteOpts,
  });
}

export function stopSync(): void {
  if (_sync) {
    _sync.cancel();
    _sync = null;
  }
}
