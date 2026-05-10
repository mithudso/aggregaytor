import type { StoreDatabase } from './db.js';

declare global {
  namespace PouchDB {
    interface Database extends StoreDatabase {}

    namespace Configuration {
      interface DatabaseConfiguration {
        indexedDB?: IDBFactory;
        IDBKeyRange?: typeof globalThis.IDBKeyRange;
      }
    }
  }
}

export {};
