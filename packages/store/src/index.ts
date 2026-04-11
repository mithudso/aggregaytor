/**
 * @aggregaytor/store
 *
 * PouchDB-backed storage for unified messages, contacts, thread metadata,
 * reminders, and auto-respond queue.
 */

export type { MessageDoc, ContactDoc, ThreadSummary, ThreadMetaDoc, ReminderDoc, AutoRespondDoc } from './types.js';
export { getDB, closeDB, destroyDB, createDB } from './db.js';
export { upsertMessage, upsertMessages, getMessagesByThread, getMessagesByContact, getRecentMessages, markThreadRead, getUnreadCount } from './messages.js';
export { upsertContact, getContact, getContactsByPlatform, getAllContacts } from './contacts.js';
export { getThreadSummaries, getThreadUnreadCounts } from './threads.js';
export { getThreadMeta, upsertThreadMeta, getAllThreadMeta, getBookmarkedThreads, getArchivedThreads } from './thread-meta.js';
export { createReminder, getReminders, markReminderNotified, deleteReminder } from './reminders.js';
export { queueAutoRespond, getPendingAutoResponds, updateAutoRespondStatus, randomDelay } from './auto-respond.js';
export { startSync, stopSync } from './sync.js';
export type { SyncConfig } from './sync.js';
