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
  generatedNickname: string;
  blockedByThem: boolean;         // they blocked us
  distance: string;               // cached distance       // LLM-generated nickname when no username
  sentiment: SentimentScore | null;
  preferenceScore: number | null;
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

// ── ML Preference Learning ──────────────────────────────────────────────────

export interface PreferenceFeedbackDoc {
  _id: string;              // 'pref:{contactId}:{timestamp}'
  _rev?: string;
  docType: 'preference_feedback';
  contactId: string;
  platform: Platform;
  liked: boolean;           // true = liked, false = disliked/passed
  features: ProfileFeatures;
  createdAt: string;
}

export interface ProfileFeatures {
  bodyType: string;
  position: string;
  age: string;
  ethnicity: string;
  height: string;
  profileTextLength: number;
  profileTextKeywords: string[];
  hasPhoto: boolean;
  photoCount: number;
  distance: string;
  conversationLength: number;   // number of messages exchanged
  responseRate: number;         // their response rate (0-1)
  [key: string]: unknown;
}

export interface PreferenceModelDoc {
  _id: string;              // 'prefmodel:latest'
  _rev?: string;
  docType: 'preference_model';
  featureWeights: Record<string, number>;   // learned weights per feature
  trainingCount: number;
  accuracy: number;         // estimated accuracy from cross-validation
  lastTrainedAt: string;
  version: number;
}

// ── Sentiment Analysis ──────────────────────────────────────────────────────

export interface SentimentScore {
  interest: number;         // 0-1: how interested they seem
  engagement: number;       // 0-1: how engaged in conversation
  commitment: number;       // 0-1: likelihood they'll actually meet
  overall: number;          // 0-1: composite score
  signals: string[];        // human-readable signal descriptions
}

// ── Calendar Integration ────────────────────────────────────────────────────

export interface CalendarEventDoc {
  _id: string;              // 'calevent:{contactId}:{timestamp}'
  _rev?: string;
  docType: 'calendar_event';
  contactId: string;
  platform: Platform;
  googleEventId: string;
  title: string;
  startTime: string;
  endTime: string;
  prepStartTime: string;    // includes prep buffer
  location: string;
  notes: string;
  status: 'tentative' | 'confirmed' | 'cancelled';
  createdAt: string;
}

export interface AutoRespondSession {
  _id: string;              // 'arsession:{timestamp}'
  _rev?: string;
  docType: 'ar_session';
  lookingByDeadline: string; // ISO 8601 deadline
  preferenceSummary: string; // LLM-generated summary of what user wants
  confirmedPreferences: boolean;
  activeContactIds: string[];
  availableSlots: TimeSlot[];
  startedAt: string;
  status: 'setup' | 'active' | 'paused' | 'completed';
}

export interface TimeSlot {
  start: string;            // ISO 8601
  end: string;
  label: string;            // human-readable: "7:00 PM - 9:00 PM"
}

// ── Contact Dossier ─────────────────────────────────────────────────────────

export interface ContactDossierDoc {
  _id: string;              // 'dossier:{contactId}'
  _rev?: string;
  docType: 'dossier';
  contactId: string;
  platform: Platform;

  // Identity
  realName: string;
  birthYear: string;
  phone: string;
  address: string;
  hometown: string;
  employer: string;
  schedule: string;         // e.g., "works 9-5 M-F, free weekends"

  // Relationship
  relationshipStatus: string; // single, partnered, married, etc.
  partnerNames: string[];
  partnerLinks: string[];

  // Cross-platform links
  otherProfileLinks: string[];  // URLs to their profiles on other platforms

  // Meeting history
  metInPerson: boolean;
  meetingDates: string[];    // ISO dates
  meetingNotes: string;      // how was it
  wouldMeetAgain: boolean | null;
  wouldDate: boolean | null;

  // Logistics
  hasTransportation: boolean | null;
  hasDog: boolean | null;
  isInHotel: boolean | null;
  sentAddressToThem: boolean;
  owesMeMoney: number;       // dollar amount, 0 = none
  paidForAnything: string;   // what you had to pay for

  // Profile / sexual
  position: string;
  kinks: string[];
  bodyType: string;

  // Trust signals
  isRealOrBot: 'real' | 'bot' | 'suspicious' | 'unknown';
  ghostCount: number;        // times they've ghosted
  deletedChatCount: number;  // inherited from ThreadMetaDoc

  // Auto-extracted flags (LLM fills these)
  autoExtracted: Record<string, { value: string; source: string; extractedAt: string }>;

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_DOSSIER: Omit<ContactDossierDoc, '_id' | '_rev' | 'contactId' | 'platform' | 'createdAt' | 'updatedAt'> = {
  docType: 'dossier',
  realName: '', birthYear: '', phone: '', address: '', hometown: '', employer: '', schedule: '',
  relationshipStatus: '', partnerNames: [], partnerLinks: [],
  otherProfileLinks: [],
  metInPerson: false, meetingDates: [], meetingNotes: '', wouldMeetAgain: null, wouldDate: null,
  hasTransportation: null, hasDog: null, isInHotel: null, sentAddressToThem: false, owesMeMoney: 0, paidForAnything: '',
  position: '', kinks: [], bodyType: '',
  isRealOrBot: 'unknown', ghostCount: 0, deletedChatCount: 0,
  autoExtracted: {},
};

export interface ThreadSummary {
  threadId: string;
  contactId: string;
  contact: ContactDoc | null;
  lastMessage: MessageDoc;
  unreadCount: number;
  platform: Platform;
}
