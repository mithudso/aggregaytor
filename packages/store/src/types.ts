/**
 * types.ts — Database document types extending adapter-core schemas.
 */

import type { Platform } from '@aggregaytor/adapter-core';

export interface MessageDoc {
  _id: string;            // 'msg:{platform}:{platformMessageId}'
  _rev?: string;
  docType: 'message';
  platform: Platform;
  threadId: string;
  contactId: string;
  direction: 'in' | 'out';
  body: string;
  timestamp: string;
  read: boolean;
  metadata: Record<string, unknown>;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContactDoc {
  _id: string;            // 'contact:{platform}:{platformUserId}'
  _rev?: string;
  docType: 'contact';
  platform: Platform;
  platformUserId: string;
  displayName: string;
  profileUrl: string;
  avatarUrl: string;
  lastSeen: string;
  lastMessageAt: string;
  unreadCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMetaDoc {
  _id: string;              // 'meta:{contactId}'
  _rev?: string;
  docType: 'thread_meta';
  contactId: string;
  platform: Platform;
  archived: boolean;
  hidden: boolean;
  hiddenUntilResponse: boolean;
  bookmarked: boolean;
  alias: string;
  tags: string[];
  notes: string;
  deletedChatCount: number;
  autoRespondEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderDoc {
  _id: string;              // 'reminder:{uuid}'
  _rev?: string;
  docType: 'reminder';
  contactId: string;
  platform: Platform;
  note: string;
  dueAt: string;
  notifiedApproach: boolean;
  notifiedDue: boolean;
  createdAt: string;
}

export interface AutoRespondDoc {
  _id: string;              // 'autoresp:{contactId}:{timestamp}'
  _rev?: string;
  docType: 'auto_respond';
  contactId: string;
  platform: Platform;
  triggerMessageId: string;
  scheduledAt: string;
  status: 'pending' | 'generating' | 'sending' | 'sent' | 'failed';
  generatedResponse: string;
  error: string;
  createdAt: string;
}

export interface ThreadSummary {
  threadId: string;
  contactId: string;
  contact: ContactDoc | null;
  lastMessage: MessageDoc;
  unreadCount: number;
  platform: Platform;
}
