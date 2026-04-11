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

export interface ThreadSummary {
  threadId: string;
  contactId: string;
  contact: ContactDoc | null;
  lastMessage: MessageDoc;
  unreadCount: number;
  platform: Platform;
}
