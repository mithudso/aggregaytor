/**
 * @aggregaytor/store
 */

export type {
  MessageDoc, ContactDoc, ThreadSummary, ThreadMetaDoc, ReminderDoc,
  AutoRespondDoc, AutoRespondTier, AutoRespondStatus, AutoRespondSettings,
  PictureDoc, BlockRuleDoc, BlockRuleCondition,
} from './types.js';
export { DEFAULT_AUTO_RESPOND_SETTINGS } from './types.js';
export { getDB, closeDB, destroyDB, createDB } from './db.js';
export { upsertMessage, upsertMessages, getMessagesByThread, getMessagesByContact, getRecentMessages, markThreadRead, getUnreadCount } from './messages.js';
export { upsertContact, getContact, getContactsByPlatform, getAllContacts } from './contacts.js';
export { getThreadSummaries, getThreadUnreadCounts } from './threads.js';
export { getThreadMeta, upsertThreadMeta, getAllThreadMeta, getBookmarkedThreads, getArchivedThreads } from './thread-meta.js';
export { createReminder, getReminders, markReminderNotified, deleteReminder } from './reminders.js';
export { queueAutoRespond, getPendingAutoResponds, getDraftAutoResponds, getApprovedAutoResponds, updateAutoRespondStatus, randomDelay } from './auto-respond.js';
export { addPicture, getAllPictures, getPicture, getPictureByTag, incrementPictureStat, deletePicture } from './pictures.js';
export { createBlockRule, getAllBlockRules, updateBlockRule, deleteBlockRule, evaluateRules, executeAction } from './block-rules.js';
export { startSync, stopSync } from './sync.js';
export type { SyncConfig } from './sync.js';
