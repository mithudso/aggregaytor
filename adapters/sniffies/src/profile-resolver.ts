/**
 * @file profile-resolver.ts -- Sniffies-specific profile ID extraction.
 *
 * Sniffies uses lowercase hex strings (MongoDB ObjectIds) as profile IDs.
 * This module extracts the "other person's" profile ID from API payloads,
 * URLs, and DOM elements.
 *
 * ## Why Self-ID Skipping Matters
 * Every API object that carries a profile ID could be referring to either
 * the logged-in user ("self") or the conversation partner ("other"). If we
 * accidentally return our own ID, the aggregator will:
 *  - Create a conversation with ourselves
 *  - Attribute messages to the wrong contact
 *  - Show our own avatar where the partner's should be
 *
 * Therefore, **every priority level** in {@link findLikelyProfileId} checks
 * the candidate against the `selfIds` set and skips it if it matches.
 *
 * ## 6-Priority Extraction System
 * {@link findLikelyProfileId} tries increasingly generic strategies:
 *  1. Explicit "other person" keys (`otherUserId`, `recipientId`)
 *  2. Sender keys (`senderId`, `fromId`) -- skip if self
 *  3. Nested profile sub-objects (`obj.sender.id`, `obj.user._id`)
 *  4. Conversation/thread IDs (groups messages even if not a real profile)
 *  5. Generic ID keys (`profileId`, `userId`) -- skip if self
 *  6. Any hex string value >= 10 chars -- skip if self (last resort)
 */

/**
 * Regex matching a valid Sniffies profile ID: 6+ lowercase hex characters.
 * Sniffies uses MongoDB ObjectIds which are 24-char hex strings, but we
 * accept 6+ to handle any truncated or alternative ID formats.
 */
const HEX_ID_RE = /^[0-9a-f]{6,}$/i;

// ── Key Name Groups (all normalized / lowercased) ───────────────────────────
//
// These arrays list the normalized key names checked at each priority level
// of findLikelyProfileId. They are ordered from most-specific ("definitely
// the other person") to least-specific ("some ID on this object").

/** Priority 1: Keys that explicitly identify the OTHER person. */
const OTHER_PERSON_KEYS = [
  'otheruserid', 'otherprofileid', 'peerid', 'otherid',
  'other_user_id', 'other_profile_id', 'peer_id', 'other_id',
  'recipientid', 'recipient_id',
  'toid', 'to_id',
];

/** Priority 2: Sender keys -- could be self or other. */
const SENDER_KEYS = [
  'senderid', 'sender_id', 'fromid', 'from_id',
];

/** Priority 5: Generic profile/user ID keys -- could be self or other. */
const GENERIC_ID_KEYS = [
  'cruiserid', 'cruiser_id',
  'profileid', 'profile_id',
  'userid', 'user_id',
];

/** Priority 4: Conversation/thread-level IDs (not a profile, but useful for grouping). */
const CONVERSATION_KEYS = [
  'conversationid', 'conversation_id', 'threadid', 'thread_id',
  'chatid', 'chat_id', 'channelid', 'channel_id',
];

// ── Normalization & URL Extraction ───────────────────────────────────────────

/**
 * Normalize and validate a candidate profile ID string.
 *
 * Returns the lowercased, trimmed string if it matches the hex-ID pattern
 * (6+ hex characters), otherwise returns "" to signal "not a valid ID".
 * This prevents non-hex strings (usernames, UUIDs with dashes, etc.)
 * from being treated as Sniffies profile IDs.
 */
export function normalizeProfileId(id: string | null | undefined): string {
  if (!id) return '';
  const cleaned = String(id).trim().toLowerCase();
  return HEX_ID_RE.test(cleaned) ? cleaned : '';
}

/**
 * Extract a profile ID from a Sniffies URL path.
 *
 * Matches patterns like:
 *  - `/profile/abc123def456`
 *  - `/profile/abc123def456/chat`
 *
 * @returns The normalized profile ID, or "" if no match.
 */
export function extractProfileIdFromUrl(url: string): string {
  const match = String(url || '').match(/\/profile\/([0-9a-f]{6,})(?:\/chat)?/i);
  return match ? normalizeProfileId(match[1]) : '';
}

/**
 * Find the most likely OTHER person's profile ID in an API object.
 * Skips self IDs when possible.
 */
export function findLikelyProfileId(
  obj: Record<string, unknown>,
  fallback: string = '',
  selfIds?: Set<string>,
): string {
  const normalizeKey = (key: string) => key.replace(/[-_ ]/g, '').toLowerCase();

  // Priority 1: explicit "other person" keys
  for (const key of OTHER_PERSON_KEYS) {
    for (const [k, v] of Object.entries(obj)) {
      if (normalizeKey(k) === key && v && typeof v === 'string') {
        const id = normalizeProfileId(v);
        if (id && (!selfIds || !selfIds.has(id))) return id;
      }
    }
  }

  // Priority 2: sender keys (skip if it's self)
  for (const key of SENDER_KEYS) {
    for (const [k, v] of Object.entries(obj)) {
      if (normalizeKey(k) === key && v && typeof v === 'string') {
        const id = normalizeProfileId(v);
        if (id && (!selfIds || !selfIds.has(id))) return id;
      }
    }
  }

  // Priority 3: nested objects that look like user profiles
  for (const [k, v] of Object.entries(obj)) {
    const nk = normalizeKey(k);
    if ((nk === 'otheruser' || nk === 'otherprofile' || nk === 'peer' || nk === 'recipient' || nk === 'sender' || nk === 'user' || nk === 'profile') && v && typeof v === 'object') {
      const sub = v as Record<string, unknown>;
      const id = normalizeProfileId(String(sub.id || sub._id || sub.profileId || sub.userId || ''));
      if (id && (!selfIds || !selfIds.has(id))) return id;
    }
  }

  // Priority 4: conversation/thread ID (at least groups messages together)
  for (const key of CONVERSATION_KEYS) {
    for (const [k, v] of Object.entries(obj)) {
      if (normalizeKey(k) === key && v && typeof v === 'string') {
        const id = normalizeProfileId(v);
        if (id) return id;
      }
    }
  }

  // Priority 5: generic ID keys (skip self)
  for (const key of GENERIC_ID_KEYS) {
    for (const [k, v] of Object.entries(obj)) {
      if (normalizeKey(k) === key && v && typeof v === 'string') {
        const id = normalizeProfileId(v);
        if (id && (!selfIds || !selfIds.has(id))) return id;
      }
    }
  }

  // Priority 6: any hex ID value in the object that isn't self
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const id = normalizeProfileId(v);
      if (id && id.length >= 10 && (!selfIds || !selfIds.has(id))) {
        // Only use long hex IDs to avoid false matches
        return id;
      }
    }
  }

  return fallback;
}

export function extractProfileIdFromBackground(bg: string): string {
  if (!bg) return '';
  const match = bg.match(/profile\.sniffiesassets\.com\/([0-9a-f]{6,})\//i);
  return match ? normalizeProfileId(match[1]) : '';
}
