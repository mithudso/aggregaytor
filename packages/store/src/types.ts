/**
 * types.ts — Database document types for the Aggregaytor unified message store.
 *
 * Every document stored in PouchDB has a `docType` discriminator field so that
 * a single database can hold messages, contacts, thread metadata, auto-respond
 * jobs, pictures, block rules, preference models, calendar events, and dossiers
 * side-by-side. The `_id` format is always `docType:platform:uniquePart` which
 * keeps IDs deterministic and enables efficient key-range queries.
 */

import type { Platform } from '@aggregaytor/adapter-core';

/**
 * A single chat message from any supported platform, normalized into a common
 * shape. Messages are the core atomic unit of the store -- threads and contact
 * activity are derived from them.
 *
 * _id format: `msg:{platform}:{platformMessageId}`
 *
 * `threadId` groups messages into a conversation. On 1-to-1 platforms this is
 * typically equal to `contactId`; on platforms with distinct threads (e.g.
 * Grindr "taps" vs chat) it may differ.
 *
 * `contactId` is the _id of the corresponding ContactDoc and links every
 * message to a single person across the UI.
 *
 * `contentHash` is a deterministic hash of platform + contactId + body +
 * timestamp, used to detect duplicate imports even when platform message IDs
 * change (e.g. Sniffies ephemeral IDs).
 */
export interface MessageDoc {
  /** PouchDB document ID -- `msg:{platform}:{platformMsgId}` */
  _id: string;
  /** PouchDB revision token for conflict resolution */
  _rev?: string;
  /** Discriminator -- always 'message' for this doc type */
  docType: 'message';
  /** Source platform (grindr, scruff, sniffies, etc.) */
  platform: Platform;
  /** Conversation thread this message belongs to */
  threadId: string;
  /** Contact who sent or received this message (foreign key to ContactDoc._id) */
  contactId: string;
  /** 'in' = received from contact, 'out' = sent by the user */
  direction: 'in' | 'out';
  /** Plain-text message content */
  body: string;
  /** ISO 8601 timestamp of when the message was sent on the platform */
  timestamp: string;
  /** Whether the user has read this message in Aggregaytor */
  read: boolean;
  /** Platform-specific extras (tap type, media URLs, location, etc.) */
  metadata: Record<string, unknown>;
  /** Deterministic dedup hash: hash(platform:contactId:body:timestamp) */
  contentHash: string;
  /** ISO 8601 -- when this doc was first written to PouchDB */
  createdAt: string;
  /** ISO 8601 -- last time this doc was updated (e.g. marked read) */
  updatedAt: string;
}

/**
 * A person on a specific platform. One real-world person may have multiple
 * ContactDocs if they appear on several platforms; cross-platform linking is
 * handled by `ContactDossierDoc.otherProfileLinks`.
 *
 * _id format: `contact:{platform}:{platformUserId}`
 *
 * The `avatarUrl` is scraped from the platform and cached locally. During
 * upsert the existing avatar is preserved if the incoming data has no new one,
 * so we never lose a previously-captured profile picture.
 */
export interface ContactDoc {
  /** PouchDB document ID -- `contact:{platform}:{platformUserId}` */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'contact' */
  docType: 'contact';
  /** Which platform this contact lives on */
  platform: Platform;
  /** The platform's own user identifier (profile ID, username, etc.) */
  platformUserId: string;
  /** Human-readable name shown in the UI */
  displayName: string;
  /** Full URL to this contact's profile on the platform */
  profileUrl: string;
  /** Cached profile picture URL or data-URL */
  avatarUrl: string;
  /** ISO 8601 -- last time the contact was seen online (from platform scrape) */
  lastSeen: string;
  /** ISO 8601 -- timestamp of the most recent message with this contact */
  lastMessageAt: string;
  /** Number of unread inbound messages from this contact */
  unreadCount: number;
  /** Platform-specific profile fields (age, distance, stats, bio, etc.) */
  metadata: Record<string, unknown>;
  /** ISO 8601 -- when this contact doc was first created */
  createdAt: string;
  /** ISO 8601 -- last update */
  updatedAt: string;
}

/**
 * Per-contact configuration that controls how the auto-responder behaves.
 *
 * `aggressiveness` sets the conversational tone:
 *   - 'chill'  -- low-key, waits longer, fewer messages
 *   - 'normal' -- balanced default
 *   - 'eager'  -- responds quickly, tries to push toward a meetup
 *
 * `preferredTime` / `preferredPlace` are free-text hints the LLM uses when
 * suggesting meetup logistics (e.g. "tonight after 9", "my place").
 *
 * `allowPictures` + `pictureTagsAllowed` gate whether the auto-responder
 * can attach images from the PictureDoc library during a conversation.
 */
export interface AutoRespondSettings {
  /** Conversational aggressiveness: chill | normal | eager */
  aggressiveness: 'chill' | 'normal' | 'eager';
  /** Free-text preferred meetup time (e.g. "tonight after 9 PM") */
  preferredTime: string;
  /** Free-text preferred meetup location (e.g. "my place", "downtown") */
  preferredPlace: string;
  /** How strict the time preference is */
  timeFlexibility: 'firm' | 'flexible' | 'open';
  /** How strict the place preference is */
  placeFlexibility: 'firm' | 'flexible' | 'open';
  /** Whether auto-responder may send pictures from the library */
  allowPictures: boolean;
  /** Which picture tags (e.g. 'face', 'body') are allowed to be sent */
  pictureTagsAllowed: string[];
}

/** Sensible defaults for a new contact's auto-respond settings. */
export const DEFAULT_AUTO_RESPOND_SETTINGS: AutoRespondSettings = {
  aggressiveness: 'normal',
  preferredTime: '',
  preferredPlace: '',
  timeFlexibility: 'flexible',
  placeFlexibility: 'flexible',
  allowPictures: false,
  pictureTagsAllowed: [],
};

/**
 * User-controlled metadata layered on top of a conversation thread.
 *
 * ThreadMetaDoc is the "editorial layer" -- it stores everything the user or
 * the AI system decides about a thread that is NOT raw message data. This
 * includes organizational flags (archived, hidden, bookmarked), free-form
 * notes, auto-respond configuration, and AI-derived scores.
 *
 * _id format: `thread_meta:{platform}:{contactId}`
 *
 * There is exactly one ThreadMetaDoc per contact per platform. It is created
 * lazily the first time the user interacts with thread settings or when the
 * auto-respond system needs to store state.
 */
export interface ThreadMetaDoc {
  /** PouchDB document ID -- `thread_meta:{platform}:{contactId}` */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'thread_meta' */
  docType: 'thread_meta';
  /** The contact this metadata belongs to (foreign key to ContactDoc._id) */
  contactId: string;
  /** Platform of the thread */
  platform: Platform;
  /** True if the user archived this thread (hidden from main list) */
  archived: boolean;
  /** True if hidden from the thread list entirely */
  hidden: boolean;
  /** Auto-hides until the contact sends a new message */
  hiddenUntilResponse: boolean;
  /** User bookmarked this thread for quick access */
  bookmarked: boolean;
  /** Starred/pinned on the platform itself */
  favorited: boolean;
  /** User-defined nickname override for this contact */
  alias: string;
  /** Free-form tags for filtering/grouping (e.g. "hot", "flaky", "local") */
  tags: string[];
  /** Free-text notes the user can attach to this thread */
  notes: string;
  /** How many times the contact has deleted their chat history */
  deletedChatCount: number;
  /** Whether auto-respond is active for this contact */
  autoRespondEnabled: boolean;
  /** Per-contact auto-respond configuration */
  autoRespondSettings: AutoRespondSettings;
  /** LLM-generated nickname when the platform provides no username */
  generatedNickname: string;
  /** User rating for this contact (1-5 stars, 0 = unrated) */
  rating?: number;
  /** True if this contact has blocked the user on the platform */
  blockedByThem: boolean;
  /** Cached distance string from the platform (e.g. "2 miles") */
  distance: string;
  /** AI-computed sentiment scores, or null if not yet analyzed */
  sentiment: SentimentScore | null;
  /** ML preference model score (0-1), or null if not yet scored */
  preferenceScore: number | null;
  /** ISO 8601 -- when this thread meta was first created */
  createdAt: string;
  /** ISO 8601 -- last update */
  updatedAt: string;
}

/**
 * A time-based reminder attached to a contact.
 *
 * Supports two notification phases: an "approaching" notification before the
 * due time, and a "due" notification at the exact time. Both flags track
 * whether each notification has already fired to avoid duplicates.
 *
 * _id format: `reminder:{contactId}:{timestamp}`
 */
export interface ReminderDoc {
  /** PouchDB document ID */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'reminder' */
  docType: 'reminder';
  /** Contact this reminder is about */
  contactId: string;
  /** Platform of the contact */
  platform: Platform;
  /** User-written reminder text */
  note: string;
  /** ISO 8601 -- when the reminder is due */
  dueAt: string;
  /** True once the "approaching" notification has been sent */
  notifiedApproach: boolean;
  /** True once the "due" notification has been sent */
  notifiedDue: boolean;
  /** ISO 8601 -- creation time */
  createdAt: string;
}

/**
 * The urgency/autonomy tier for an auto-respond job.
 *
 *   - 'low'    -- informational only; drafts a response for the user to review
 *   - 'medium' -- generates and queues, but waits for approval before sending
 *   - 'high'   -- fully autonomous; generates and sends without user intervention
 */
export type AutoRespondTier = 'low' | 'medium' | 'high';

/**
 * Lifecycle status of a single auto-respond job.
 *
 * Flow: pending -> generating -> draft -> approved -> sending -> sent
 *                                     \-> rejected   \-> failed
 *
 *   - 'pending'    -- queued, waiting for its scheduled time
 *   - 'generating' -- the LLM is currently drafting the response
 *   - 'draft'      -- response generated, awaiting user review (medium/low tier)
 *   - 'approved'   -- user approved the draft, ready to send
 *   - 'sending'    -- actively being sent to the platform
 *   - 'sent'       -- successfully delivered
 *   - 'failed'     -- send attempt failed (see `error` field)
 *   - 'rejected'   -- user rejected the draft
 */
export type AutoRespondStatus = 'pending' | 'generating' | 'draft' | 'approved' | 'sending' | 'sent' | 'failed' | 'rejected';

/**
 * A single auto-respond job -- one generated reply to one incoming message.
 *
 * The tier system controls how much autonomy the auto-responder has:
 * see {@link AutoRespondTier} for details. The status tracks the job through
 * its lifecycle: see {@link AutoRespondStatus}.
 *
 * _id format: `ar:{contactId}:{timestamp}`
 */
export interface AutoRespondDoc {
  /** PouchDB document ID */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'auto_respond' */
  docType: 'auto_respond';
  /** Contact the response is for */
  contactId: string;
  /** Platform to send the response on */
  platform: Platform;
  /** _id of the inbound message that triggered this auto-respond */
  triggerMessageId: string;
  /** ISO 8601 -- when this response is scheduled to be sent */
  scheduledAt: string;
  /** Autonomy tier: low (draft only), medium (approval needed), high (auto-send) */
  tier: AutoRespondTier;
  /** Current lifecycle status */
  status: AutoRespondStatus;
  /** The LLM-generated response text */
  generatedResponse: string;
  /** If the LLM suggests attaching a picture, the tag to pull from PictureDoc */
  suggestedPictureTag: string;
  /** Error message if status is 'failed' */
  error: string;
  /** ISO 8601 -- when this job was created */
  createdAt: string;
}

/**
 * An image in the user's picture library that the auto-responder (or the user
 * manually) can send during conversations.
 *
 * Pictures are tagged by category so the auto-responder can pick contextually
 * appropriate images. Engagement metrics (`sentCount`, `responseCount`,
 * `likeCount`) let the system learn which pictures perform best and prefer
 * them in future auto-responses.
 *
 * _id format: `pic:{uuid}`
 */
export interface PictureDoc {
  /** PouchDB document ID */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'picture' */
  docType: 'picture';
  /** Category tag: 'face' | 'body' | 'explicit' | 'other' | any custom tag */
  tag: string;
  /** User-friendly label for display in the library grid */
  label: string;
  /** Base64 data URL for browser-uploaded images */
  dataUrl: string;
  /** Absolute local file path for folder-imported images */
  filePath: string;
  /** Small base64 thumbnail for fast UI rendering */
  thumbnail: string;
  /** How many times this picture has been sent to any contact */
  sentCount: number;
  /** How many contacts replied after receiving this picture */
  responseCount: number;
  /** How many "likes" or positive reactions this picture received */
  likeCount: number;
  /** ISO 8601 -- last time this picture was sent */
  lastSentAt: string;
  /** ISO 8601 -- when this picture was added to the library */
  createdAt: string;
}

/**
 * The trigger condition for an automatic block/archive/hide rule.
 *
 * Each condition type uses a different subset of the optional fields:
 *   - 'ignored_count' -- fires when the user has ignored `threshold` messages
 *   - 'keyword'       -- fires if any message body matches one of `keywords`
 *   - 'no_response_days' -- fires if the contact has not replied in `days`
 *   - 'deleted_chat'  -- fires when the contact deletes the chat `threshold` times
 */
export interface BlockRuleCondition {
  /** Which type of condition to evaluate */
  type: 'ignored_count' | 'keyword' | 'no_response_days' | 'deleted_chat';
  /** Numeric threshold for ignored_count and deleted_chat conditions */
  threshold?: number;
  /** Words/phrases to match in message body for keyword conditions */
  keywords?: string[];
  /** Number of days without a response for no_response_days condition */
  days?: number;
}

/**
 * A user-defined automation rule that takes action when a contact matches
 * certain conditions. Rules are evaluated periodically or on new messages.
 *
 * Actions:
 *   - 'block'   -- block the contact on the platform
 *   - 'archive' -- archive the thread in Aggregaytor
 *   - 'hide'    -- hide the thread from the main list
 *
 * _id format: `blockrule:{uuid}`
 */
export interface BlockRuleDoc {
  /** PouchDB document ID */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'block_rule' */
  docType: 'block_rule';
  /** Human-readable rule name (e.g. "Auto-archive ghosters") */
  name: string;
  /** The trigger condition -- see {@link BlockRuleCondition} */
  condition: BlockRuleCondition;
  /** What to do when the condition is met */
  action: 'block' | 'archive' | 'hide';
  /** Whether this rule is currently active */
  enabled: boolean;
  /** How many times this rule has fired (for analytics) */
  executedCount: number;
  /** ISO 8601 -- when this rule was created */
  createdAt: string;
}

// ── ML Preference Learning ──────────────────────────────────────────────────

/**
 * A single like/dislike feedback event used to train the preference model.
 * Each time the user swipes right/left or engages/ignores a contact, one of
 * these docs is created to capture the decision along with the profile
 * features visible at the time.
 *
 * _id format: `pref:{contactId}:{timestamp}`
 */
export interface PreferenceFeedbackDoc {
  /** PouchDB document ID -- `pref:{contactId}:{timestamp}` */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'preference_feedback' */
  docType: 'preference_feedback';
  /** The contact that was liked or disliked */
  contactId: string;
  /** Platform the contact is on */
  platform: Platform;
  /** True = user liked/engaged, false = user disliked/passed */
  liked: boolean;
  /** Snapshot of the contact's profile features at decision time */
  features: ProfileFeatures;
  /** ISO 8601 -- when the feedback was recorded */
  createdAt: string;
}

/**
 * A snapshot of a contact's profile features at the time the user made a
 * like/dislike decision. Used as the feature vector for training the
 * preference model. Extensible via the index signature for platform-specific
 * fields.
 */
export interface ProfileFeatures {
  /** Self-described body type from profile */
  bodyType: string;
  /** Sexual position preference from profile */
  position: string;
  /** Age or age range from profile */
  age: string;
  /** Ethnicity from profile */
  ethnicity: string;
  /** Height from profile */
  height: string;
  /** Character length of the profile bio text */
  profileTextLength: number;
  /** Keywords extracted from the profile bio */
  profileTextKeywords: string[];
  /** Whether the contact has at least one photo */
  hasPhoto: boolean;
  /** Total number of profile photos */
  photoCount: number;
  /** Distance string from profile (e.g. "2 miles") */
  distance: string;
  /** Number of messages exchanged before this decision */
  conversationLength: number;
  /** Contact's response rate as a fraction 0-1 */
  responseRate: number;
  /** Extensible -- platforms can add extra feature fields */
  [key: string]: unknown;
}

/**
 * The trained preference model -- a simple weighted feature model stored as
 * a single document. Only the latest version is used for scoring; older
 * versions can be kept for comparison.
 *
 * _id format: `prefmodel:latest`
 */
export interface PreferenceModelDoc {
  /** PouchDB document ID -- `prefmodel:latest` */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'preference_model' */
  docType: 'preference_model';
  /** Learned weight for each feature name (higher = more predictive of "like") */
  featureWeights: Record<string, number>;
  /** Number of feedback samples the model was trained on */
  trainingCount: number;
  /** Estimated accuracy from cross-validation (0-1) */
  accuracy: number;
  /** ISO 8601 -- when training last completed */
  lastTrainedAt: string;
  /** Monotonically increasing model version number */
  version: number;
}

// ── Sentiment Analysis ──────────────────────────────────────────────────────

/**
 * AI-generated sentiment scores for a contact, stored on ThreadMetaDoc.
 *
 * All numeric scores are floats in the range [0, 1]. The `signals` array
 * provides human-readable explanations that the UI can display as tooltips
 * (e.g. "Asks follow-up questions", "Uses one-word replies").
 *
 * These scores are recomputed periodically as new messages arrive.
 */
export interface SentimentScore {
  /** 0-1: how interested the contact seems in the user */
  interest: number;
  /** 0-1: how actively engaged they are in conversation (response speed, length) */
  engagement: number;
  /** 0-1: likelihood they will follow through and actually meet in person */
  commitment: number;
  /** 0-1: weighted composite of interest + engagement + commitment */
  overall: number;
  /** Human-readable descriptions of detected signals (shown as UI tooltips) */
  signals: string[];
}

// ── Calendar Integration ────────────────────────────────────────────────────

/**
 * A meetup event synced to Google Calendar. Created when the auto-responder
 * or the user schedules a meetup with a contact.
 *
 * `prepStartTime` accounts for a buffer before the event (shower, travel,
 * etc.) and is used by the availability checker to avoid double-booking.
 *
 * _id format: `calevent:{contactId}:{timestamp}`
 */
export interface CalendarEventDoc {
  /** PouchDB document ID -- `calevent:{contactId}:{timestamp}` */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'calendar_event' */
  docType: 'calendar_event';
  /** Contact this event is with */
  contactId: string;
  /** Platform the contact is from */
  platform: Platform;
  /** The Google Calendar event ID for sync/update/delete */
  googleEventId: string;
  /** Event title shown on the calendar */
  title: string;
  /** ISO 8601 -- event start time */
  startTime: string;
  /** ISO 8601 -- event end time */
  endTime: string;
  /** ISO 8601 -- start time including the prep buffer (earlier than startTime) */
  prepStartTime: string;
  /** Meetup location (address or place name) */
  location: string;
  /** Additional notes for the event */
  notes: string;
  /** Lifecycle status of the event */
  status: 'tentative' | 'confirmed' | 'cancelled';
  /** ISO 8601 -- when this doc was created */
  createdAt: string;
}

/**
 * An auto-respond session represents one "looking tonight" session. It
 * captures the user's current preferences, the deadline they need to find
 * someone by, and which contacts are actively being managed by the system.
 *
 * The session startup flow asks the user what they want, confirms preferences
 * with the LLM, and then begins managing conversations across all active
 * contacts toward scheduling a meetup within the available time slots.
 *
 * _id format: `arsession:{timestamp}`
 */
export interface AutoRespondSession {
  /** PouchDB document ID -- `arsession:{timestamp}` */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'ar_session' */
  docType: 'ar_session';
  /** ISO 8601 -- deadline by which the user wants to have plans ("tonight by 10 PM") */
  lookingByDeadline: string;
  /** LLM-generated summary of what the user wants tonight */
  preferenceSummary: string;
  /** True once the user has confirmed the LLM's understanding of preferences */
  confirmedPreferences: boolean;
  /** Contact IDs actively being managed in this session */
  activeContactIds: string[];
  /** Time windows the user is available, pulled from Google Calendar gaps */
  availableSlots: TimeSlot[];
  /** ISO 8601 -- when this session was started */
  startedAt: string;
  /** Session lifecycle: setup -> active -> paused -> completed */
  status: 'setup' | 'active' | 'paused' | 'completed';
}

/**
 * A single availability window used in auto-respond sessions.
 */
export interface TimeSlot {
  /** ISO 8601 -- start of the available window */
  start: string;
  /** ISO 8601 -- end of the available window */
  end: string;
  /** Human-readable label, e.g. "7:00 PM - 9:00 PM" */
  label: string;
}

// ── Contact Dossier ─────────────────────────────────────────────────────────

/**
 * AI-generated (and user-editable) intelligence dossier for a contact.
 *
 * The dossier aggregates everything known about a person beyond their raw
 * messages: real-world identity, meeting history, logistics, trust signals,
 * and LLM-extracted facts. It is a mix of user-entered data and fields that
 * the LLM auto-populates by reading conversation history.
 *
 * The `autoExtracted` map stores LLM-detected facts with provenance: each
 * entry records the extracted value, the source message/snippet, and when
 * it was extracted. This allows the UI to show "how do we know this?" and
 * lets the user correct mistakes.
 *
 * _id format: `dossier:{contactId}`
 */
export interface ContactDossierDoc {
  /** PouchDB document ID -- `dossier:{contactId}` */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'dossier' */
  docType: 'dossier';
  /** Contact this dossier is about */
  contactId: string;
  /** Platform the contact is from */
  platform: Platform;

  // ── Identity ──────────────────────────────────────────────
  /** Contact's real name (if known) */
  realName: string;
  /** Birth year string (e.g. "1995") */
  birthYear: string;
  /** Phone number */
  phone: string;
  /** Physical address */
  address: string;
  /** Where they are from originally */
  hometown: string;
  /** Where they work */
  employer: string;
  /** Typical schedule, e.g. "works 9-5 M-F, free weekends" */
  schedule: string;

  // ── Relationship ──────────────────────────────────────────
  /** Relationship status: single, partnered, married, etc. */
  relationshipStatus: string;
  /** Names of partners (if any) */
  partnerNames: string[];
  /** Profile URLs of partners (if any) */
  partnerLinks: string[];

  // ── Cross-platform links ──────────────────────────────────
  /** URLs to this person's profiles on other platforms */
  otherProfileLinks: string[];

  // ── Meeting history ───────────────────────────────────────
  /** Whether the user has met this contact in person */
  metInPerson: boolean;
  /** ISO date strings of in-person meetings */
  meetingDates: string[];
  /** Free-text notes about how meetings went */
  meetingNotes: string;
  /** Would the user meet this person again? null = undecided */
  wouldMeetAgain: boolean | null;
  /** Would the user date this person? null = undecided */
  wouldDate: boolean | null;

  // ── Logistics ─────────────────────────────────────────────
  /** Whether the contact has their own transportation */
  hasTransportation: boolean | null;
  /** Whether the contact has a dog (relevant for hosting) */
  hasDog: boolean | null;
  /** Whether the contact is staying in a hotel (can host?) */
  isInHotel: boolean | null;
  /** Whether the user has sent their address to this contact */
  sentAddressToThem: boolean;
  /** Dollar amount owed to the user, 0 = none */
  owesMeMoney: number;
  /** Description of anything the user paid for on their behalf */
  paidForAnything: string;

  // ── Profile / sexual ──────────────────────────────────────
  /** Sexual position preference */
  position: string;
  /** List of kinks/interests */
  kinks: string[];
  /** Body type description */
  bodyType: string;

  // ── Trust signals ─────────────────────────────────────────
  /** Authenticity assessment: real, bot, suspicious, or unknown */
  isRealOrBot: 'real' | 'bot' | 'suspicious' | 'unknown';
  /** Number of times this contact has ghosted */
  ghostCount: number;
  /** Number of times they have deleted the chat (inherited from ThreadMetaDoc) */
  deletedChatCount: number;

  // ── Auto-extracted flags ──────────────────────────────────
  /**
   * LLM-extracted facts with provenance. Key is the fact name (e.g. "job",
   * "pet"), value includes the extracted string, the source message text,
   * and the extraction timestamp.
   */
  autoExtracted: Record<string, { value: string; source: string; extractedAt: string }>;

  // ── Timestamps ────────────────────────────────────────────
  /** ISO 8601 -- when this dossier was first created */
  createdAt: string;
  /** ISO 8601 -- last update */
  updatedAt: string;
}

/** A user-created task, optionally linked to a contact. */
export interface TaskDoc {
  /** PouchDB document ID -- `task:{timestamp}-{random}` */
  _id: string;
  /** PouchDB revision token */
  _rev?: string;
  /** Discriminator -- always 'task' */
  docType: 'task';
  /** Task title / summary */
  title: string;
  /** Free-text notes or details */
  notes: string;
  /** Optional link to a contact/thread */
  contactId?: string;
  /** Platform of the linked contact (if any) */
  platform?: Platform;
  /** ISO 8601 datetime when the task is due */
  dueAt?: string;
  /** Google Calendar event ID if synced to Calendar */
  calendarEventId?: string;
  /** Google Tasks API task ID for bidirectional sync */
  googleTaskId?: string;
  /** ISO 8601 — last time this task was synced with Google Tasks */
  lastSyncedAt?: string;
  /** Whether the task has been completed */
  completed: boolean;
  /** ISO 8601 -- when the task was marked complete */
  completedAt?: string;
  /** Task priority level */
  priority: 'low' | 'medium' | 'high';
  /** ISO 8601 -- when this task was created */
  createdAt: string;
  /** ISO 8601 -- last update */
  updatedAt: string;
}

/** Default empty dossier values for initializing a new ContactDossierDoc. */
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

/**
 * A denormalized view of a conversation thread used to render the thread list
 * in the UI. Produced by `getThreadSummaries()` in threads.ts by joining
 * messages, contacts, and unread counts.
 *
 * This is NOT a stored document -- it is computed on the fly.
 */
export interface ThreadSummary {
  /** Thread identifier (usually contactId, but may differ on multi-thread platforms) */
  threadId: string;
  /** Contact this thread belongs to */
  contactId: string;
  /** Full ContactDoc (null if the contact doc is missing or deleted) */
  contact: ContactDoc | null;
  /** The most recent message in the thread (for preview text + sort order) */
  lastMessage: MessageDoc;
  /** Number of unread inbound messages in this thread */
  unreadCount: number;
  /** Platform this thread lives on */
  platform: Platform;
}
