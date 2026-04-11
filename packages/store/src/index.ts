/**
 * @aggregaytor/store
 *
 * PouchDB-backed storage for unified messages and contacts.
 */

// Types
export type { MessageDoc, ContactDoc, ThreadSummary } from './types.js';

// Database
export { getDB, closeDB, destroyDB, createDB } from './db.js';

// Messages
export {
  upsertMessage,
  upsertMessages,
  getMessagesByThread,
  getMessagesByContact,
  getRecentMessages,
  markThreadRead,
  getUnreadCount,
} from './messages.js';

// Contacts
export {
  upsertContact,
  getContact,
  getContactsByPlatform,
  getAllContacts,
} from './contacts.js';

// Threads
export { getThreadSummaries, getThreadUnreadCounts } from './threads.js';

// Sync
export { startSync, stopSync } from './sync.js';
export type { SyncConfig } from './sync.js';
