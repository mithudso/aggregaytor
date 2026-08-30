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

import { dom } from '@aggregaytor/sniffies-lib';

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
 * Now delegates to `@aggregaytor/sniffies-lib` `dom.normalizeProfileId`, which
 * extracts the FIRST 6+-hex substring (UNANCHORED) and lowercases it, returning
 * null on no match. This resolver's callers (findLikelyProfileId, the adapter)
 * require a string, so the lib's null miss-result is coerced back to "".
 *
 * NOTE (intentional behavior adoption): the old implementation anchored the
 * whole cleaned string (`^[0-9a-f]{6,}$`), so a value like "abc123def/chat" or a
 * dashed UUID returned "". The library's unanchored extraction instead returns
 * the first hex run (e.g. "abc123def"). This is an accepted change.
 */
export function normalizeProfileId(id: string | null | undefined): string {
  return dom.normalizeProfileId(id) || '';
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
  // Delegates to @aggregaytor/sniffies-lib `dom.profileIdFromHref` (same
  // `/profile/<6+hex>` capture, lowercased). Coerce its null miss-result back
  // to '' to preserve this resolver's public API.
  return dom.profileIdFromHref(url) || '';
}

// ── Profile ID Extraction ───────────────────────────────────────────────────

/**
 * Find the most likely OTHER person's profile ID from an API response object.
 *
 * Uses a 6-priority cascade, returning the first valid non-self hex ID
 * found. Self-ID skipping (`selfIds` check) is applied at every level
 * except Priority 4 (conversation IDs are not profile IDs, so self-check
 * is irrelevant there).
 *
 * @param obj      The API response object to inspect.
 * @param fallback Value to return if no ID is found (default "").
 * @param selfIds  Set of the logged-in user's known profile IDs.
 * @returns        The normalized hex profile ID of the other person, or fallback.
 */
export function findLikelyProfileId(
  obj: Record<string, unknown>,
  fallback: string = '',
  selfIds?: Set<string>,
): string {
  const normalizeKey = (key: string) => key.replace(/[-_ ]/g, '').toLowerCase();

  // ── Priority 1: explicit "other person" keys ──────────────────────────
  // These keys unambiguously refer to the conversation partner.
  // Self-skip: yes (defensive -- API might put our ID here in edge cases).
  for (const key of OTHER_PERSON_KEYS) {
    for (const [k, v] of Object.entries(obj)) {
      if (normalizeKey(k) === key && v && typeof v === 'string') {
        const id = normalizeProfileId(v);
        if (id && (!selfIds || !selfIds.has(id))) return id;
      }
    }
  }

  // ── Priority 2: sender keys ───────────────────────────────────────────
  // Could be us or them. If it is us, skip and keep looking.
  for (const key of SENDER_KEYS) {
    for (const [k, v] of Object.entries(obj)) {
      if (normalizeKey(k) === key && v && typeof v === 'string') {
        const id = normalizeProfileId(v);
        if (id && (!selfIds || !selfIds.has(id))) return id;
      }
    }
  }

  // ── Priority 3: nested sub-objects that look like user profiles ───────
  // E.g. obj.sender = { _id: "abc123" }, obj.user = { profileId: "..." }
  // Self-skip: yes.
  for (const [k, v] of Object.entries(obj)) {
    const nk = normalizeKey(k);
    if ((nk === 'otheruser' || nk === 'otherprofile' || nk === 'peer' || nk === 'recipient' || nk === 'sender' || nk === 'user' || nk === 'profile') && v && typeof v === 'object') {
      const sub = v as Record<string, unknown>;
      const id = normalizeProfileId(String(sub.id || sub._id || sub.profileId || sub.userId || ''));
      if (id && (!selfIds || !selfIds.has(id))) return id;
    }
  }

  // ── Priority 4: conversation/thread IDs — SKIPPED ─────────────────────
  // Previously this returned conversation-level hex IDs (conversationId,
  // chatId, etc.) as profile IDs. This caused split conversations: the
  // same person would appear under both their real profileId (from one
  // API response) AND a conversationId (from another), creating two
  // separate threads in the inbox for the same person.
  // Conversation IDs are NOT profile IDs — they should never be used as
  // contactId. If we can't find a real profile ID, fall through to
  // Priority 5/6 instead.

  // ── Priority 5: generic ID keys ──────────────────────────────────────
  // Ambiguous keys like `profileId` or `userId` -- could be anyone.
  // Self-skip: yes.
  for (const key of GENERIC_ID_KEYS) {
    for (const [k, v] of Object.entries(obj)) {
      if (normalizeKey(k) === key && v && typeof v === 'string') {
        const id = normalizeProfileId(v);
        if (id && (!selfIds || !selfIds.has(id))) return id;
      }
    }
  }

  // ── Priority 6: any long hex string value in the object ──────────────
  // Last resort: scan all string values for something that looks like a
  // MongoDB ObjectId (>= 10 hex chars). Short hex strings are skipped to
  // avoid false positives (e.g. color codes, small numbers).
  // Self-skip: yes.
  // SKIP conversation/thread-level keys to avoid the split-thread bug.
  const SKIP_KEYS_P6 = new Set([
    'conversationid', 'conversation_id', 'threadid', 'thread_id',
    'chatid', 'chat_id', 'channelid', 'channel_id',
    'roomid', 'room_id', 'groupid', 'group_id',
  ]);
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const nk = normalizeKey(k);
      if (SKIP_KEYS_P6.has(nk)) continue; // skip conversation IDs
      const id = normalizeProfileId(v);
      if (id && id.length >= 10 && (!selfIds || !selfIds.has(id))) {
        return id;
      }
    }
  }

  return fallback;
}

/**
 * Extract a profile ID from a CSS `background-image` URL string.
 *
 * Sniffies map-marker avatars use the CDN pattern:
 *   `profile.sniffiesassets.com/{profileId}/{photoNumber}`
 *
 * This helper pulls the hex profile ID out of that path.
 *
 * @param bg A CSS background-image value (e.g. `url("https://profile.sniffiesassets.com/abc123/0")`)
 * @returns  The normalized profile ID, or "" if the pattern does not match.
 */
export function extractProfileIdFromBackground(bg: string): string {
  // Delegates to @aggregaytor/sniffies-lib `dom.profileIdFromAssetUrl` (byte-
  // identical `profile.sniffiesassets.com/<6+hex>/` regex, lowercased). Coerce
  // its null miss-result back to '' to preserve this resolver's public API.
  return dom.profileIdFromAssetUrl(bg) || '';
}
