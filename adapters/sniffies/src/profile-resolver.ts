/**
 * profile-resolver.ts — Sniffies-specific profile ID extraction.
 *
 * Sniffies uses hex IDs for profiles. This module extracts profile IDs
 * from URLs, API payloads, and DOM elements.
 */

const HEX_ID_RE = /^[0-9a-f]{6,}$/i;

const PROFILE_ID_KEYS = [
  'otheruserid', 'otherprofileid', 'peerid', 'otherid', 'cruiserid',
  'profileid', 'userid', 'cruiser_id', 'profile_id', 'user_id',
  'peer_id', 'other_user_id', 'other_profile_id',
  'recipientid', 'recipient_id', 'senderid', 'sender_id',
  'fromid', 'from_id', 'toid', 'to_id',
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

export function findLikelyProfileId(
  obj: Record<string, unknown>,
  fallback: string = '',
): string {
  for (const key of PROFILE_ID_KEYS) {
    const value = obj[key] || obj[key.toLowerCase()];
    if (value && typeof value === 'string') {
      const id = normalizeProfileId(value);
      if (id) return id;
    }
  }
  return fallback;
}

export function extractProfileIdFromBackground(bg: string): string {
  if (!bg) return '';
  const match = bg.match(/profile\.sniffiesassets\.com\/([0-9a-f]{6,})\//i);
  return match ? normalizeProfileId(match[1]) : '';
}
