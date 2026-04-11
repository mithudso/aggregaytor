/**
 * types.ts — Database document types.
 */

import type { Platform } from '@aggregaytor/adapter-core';

export interface MessageDoc {
  _id: string;
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
  _id: string;
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

export interface AutoRespondSettings {
  aggressiveness: 'chill' | 'normal' | 'eager';
  preferredTime: string;
  preferredPlace: string;
  timeFlexibility: 'firm' | 'flexible' | 'open';
  placeFlexibility: 'firm' | 'flexible' | 'open';
  allowPictures: boolean;
  pictureTagsAllowed: string[];
}

export const DEFAULT_AUTO_RESPOND_SETTINGS: AutoRespondSettings = {
  aggressiveness: 'normal',
  preferredTime: '',
  preferredPlace: '',
  timeFlexibility: 'flexible',
  placeFlexibility: 'flexible',
  allowPictures: false,
  pictureTagsAllowed: [],
};

export interface ThreadMetaDoc {
  _id: string;
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
  autoRespondSettings: AutoRespondSettings;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderDoc {
  _id: string;
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

export type AutoRespondTier = 'low' | 'medium' | 'high';
export type AutoRespondStatus = 'pending' | 'generating' | 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'rejected';

export interface AutoRespondDoc {
  _id: string;
  _rev?: string;
  docType: 'auto_respond';
  contactId: string;
  platform: Platform;
  triggerMessageId: string;
  scheduledAt: string;
  tier: AutoRespondTier;
  status: AutoRespondStatus;
  generatedResponse: string;
  suggestedPictureTag: string;
  error: string;
  createdAt: string;
}

export interface PictureDoc {
  _id: string;
  _rev?: string;
  docType: 'picture';
  tag: string;           // 'face' | 'body' | 'explicit' | 'other' | custom
  label: string;
  dataUrl: string;       // base64 for uploaded
  filePath: string;      // local path for folder-based
  thumbnail: string;     // small base64 for UI
  sentCount: number;
  responseCount: number;
  likeCount: number;
  lastSentAt: string;
  createdAt: string;
}

export interface BlockRuleCondition {
  type: 'ignored_count' | 'keyword' | 'no_response_days' | 'deleted_chat';
  threshold?: number;
  keywords?: string[];
  days?: number;
}

export interface BlockRuleDoc {
  _id: string;
  _rev?: string;
  docType: 'block_rule';
  name: string;
  condition: BlockRuleCondition;
  action: 'block' | 'archive' | 'hide';
  enabled: boolean;
  executedCount: number;
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
