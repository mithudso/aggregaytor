/**
 * profile-resolver.ts — Sniffies-specific profile ID extraction.
 *
 * Sniffies uses hex IDs for profiles. This module extracts profile IDs
 * from URLs, API payloads, and DOM elements.
 */

const HEX_ID_RE = /^[0-9a-f]{6,}$/i;

// Keys that identify the OTHER person in the conversation (highest priority)
const OTHER_PERSON_KEYS = [
  'otheruserid', 'otherprofileid', 'peerid', 'otherid',
  'other_user_id', 'other_profile_id', 'peer_id', 'other_id',
  'recipientid', 'recipient_id',
  'toid', 'to_id',
];

// Keys for sender (could be self or other)
const SENDER_KEYS = [
  'senderid', 'sender_id', 'fromid', 'from_id',
];

// Keys for generic profile/user (could be self or other)
const GENERIC_ID_KEYS = [
  'cruiserid', 'cruiser_id',
  'profileid', 'profile_id',
  'userid', 'user_id',
];

// Keys that represent the conversation/thread level ID
const CONVERSATION_KEYS = [
  'conversationid', 'conversation_id', 'threadid', 'thread_id',
  'chatid', 'chat_id', 'channelid', 'channel_id',
];

export function normalizeProfileId(id: string | null | undefined): string {
  if (!id) return '';
  const cleaned = String(id).trim().toLowerCase();
  return HEX_ID_RE.test(cleaned) ? cleaned : '';
}

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
