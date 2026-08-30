/**
 * message-normalizer.ts — Timestamp, direction, and text extraction utilities.
 *
 * Generalized from sniffiesplus extractEventTimestamp(), detectDirection(),
 * extractMessageText() patterns.
 */

const TIMESTAMP_KEYS = [
  'timestamp', 'ts', 'time', 'created_at', 'createdAt', 'created',
  'sent_at', 'sentAt', 'date', 'datetime', 'updated_at', 'updatedAt',
  'last_message_at', 'lastMessageAt', 'lastActivity',
];

const DIRECTION_KEYS = [
  'direction', 'type', 'role', 'sender_type', 'senderType',
  'is_incoming', 'isIncoming', 'incoming', 'isSelf', 'is_self',
  'isMe', 'is_me', 'fromSelf', 'from_self',
];

const TEXT_KEYS = [
  'body', 'text', 'message', 'content', 'msg', 'snippet',
  'messageText', 'message_text', 'messageBody', 'message_body',
];

/**
 * Largest absolute epoch-milliseconds value the ECMAScript Date type can
 * represent. Anything outside +/- this range makes `new Date(ms)` an Invalid
 * Date, and `Invalid Date.toISOString()` throws a RangeError.
 */
const MAX_EPOCH_MS = 8.64e15;

/**
 * Pull an ISO 8601 timestamp out of an arbitrary payload object by probing a
 * list of common timestamp field names.
 *
 * @param obj - A single object node from a parsed payload.
 * @returns An ISO 8601 string, or `null` if no usable timestamp was found.
 */
export function extractTimestamp(obj: Record<string, unknown>): string | null {
  for (const key of TIMESTAMP_KEYS) {
    const value = obj[key];
    if (!value) continue;
    if (typeof value === 'number') {
      // Seconds vs milliseconds heuristic
      const ms = value < 1e12 ? value * 1000 : value;
      // Guard the Date range: a garbage/overflowed numeric field (e.g. a
      // microsecond or nanosecond clock, or a hostile payload) would otherwise
      // produce an Invalid Date whose .toISOString() throws a RangeError and
      // aborts the caller's whole parse.
      if (!Number.isFinite(ms) || Math.abs(ms) > MAX_EPOCH_MS) continue;
      return new Date(ms).toISOString();
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!isNaN(parsed)) return new Date(parsed).toISOString();
    }
  }
  return null;
}

/** Sender-ID fields probed (in order) when no explicit direction field exists. */
const SENDER_KEYS = ['senderId', 'sender_id', 'from', 'fromId', 'from_id'];

/**
 * Classify a message object as inbound or outbound.
 *
 * Explicit direction fields win; otherwise the sender ID is matched against
 * the known self IDs.
 *
 * @param obj     - A single message-like object from a parsed payload.
 * @param selfIds - IDs known to belong to the logged-in user.
 * @returns `'in'`, `'out'`, or `null` when the payload carries no signal.
 */
export function extractDirection(
  obj: Record<string, unknown>,
  selfIds: Set<string>,
): 'in' | 'out' | null {
  // Check explicit direction fields
  for (const key of DIRECTION_KEYS) {
    const value = obj[key];
    if (value === undefined || value === null) continue;

    if (typeof value === 'boolean') {
      const lk = key.toLowerCase();
      const isIncoming = lk.includes('incoming');
      const isSelf = lk.includes('self') || lk.includes('isme') || lk === 'is_me';
      if (isIncoming) return value ? 'in' : 'out';
      if (isSelf) return value ? 'out' : 'in';
    }

    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'in' || lower === 'incoming' || lower === 'received') return 'in';
      if (lower === 'out' || lower === 'outgoing' || lower === 'sent') return 'out';
    }
  }

  // Check sender against known self IDs.
  // Only scalar sender fields are usable as IDs. Several platforms nest the
  // sender as an object (`{ from: { id: '...' } }`); String()-ing that yields
  // "[object Object]", which never matches a self ID and would therefore
  // misclassify every such message as 'in' once any self ID is known.
  let senderId = '';
  for (const key of SENDER_KEYS) {
    const value = obj[key];
    // Falsy scalars (0, '') fall through to the next key, matching the
    // original `a || b || c` probe order.
    if (typeof value === 'string' && value) { senderId = value; break; }
    if (typeof value === 'number' && value) { senderId = String(value); break; }
  }
  if (senderId && selfIds.has(senderId)) return 'out';
  if (senderId && selfIds.size > 0) return 'in';

  return null;
}

/**
 * Pull the message body out of an object by probing common text field names.
 *
 * @param obj - A single message-like object from a parsed payload.
 * @returns The trimmed body text, or `null` if no non-empty text field exists.
 */
export function extractMessageText(obj: Record<string, unknown>): string | null {
  for (const key of TEXT_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Build a namespaced `{prefix}:{id}` identifier from an object's ID field.
 *
 * @param obj    - A single object from a parsed payload.
 * @param prefix - Namespace to prepend (typically the platform slug).
 * @returns The namespaced ID, or `null` if the object carries no ID field.
 */
export function extractId(obj: Record<string, unknown>, prefix: string): string | null {
  const idKeys = ['id', '_id', 'messageId', 'message_id', 'msgId', 'msg_id'];
  for (const key of idKeys) {
    const value = obj[key];
    if (value !== undefined && value !== null) {
      return `${prefix}:${String(value)}`;
    }
  }
  return null;
}

/**
 * Unit key -> milliseconds. Keys are the first character of the matched unit,
 * except months which use the two-character key 'mo' so that "5 months" never
 * collapses onto the minutes multiplier.
 */
const RELATIVE_UNIT_MS: Record<string, number> = {
  s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
  mo: 2_592_000_000, y: 31_536_000_000,
};

/**
 * Turn a relative time label ("5m ago", "2 hours", "3d") into an absolute
 * epoch-milliseconds value.
 *
 * This is a heuristic for DOM-scraped timestamps; it matches the first
 * number+unit pair anywhere in the string.
 *
 * @param text - The label to parse.
 * @returns Epoch milliseconds, or `null` if nothing parseable was found.
 */
export function parseRelativeTimeString(text: string): number | null {
  // Longest alternatives first: "mo"/"month" must win over the bare "m"
  // (minutes), otherwise "5 months ago" parses as 5 minutes.
  const match = String(text || '').match(/(\d+)\s*(mo(?:nth)?|sec|min|hr|day|wk|y(?:ea)?r|[smhdwy])/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const rawUnit = match[2].toLowerCase();
  const unit = rawUnit.startsWith('mo') ? 'mo' : rawUnit.charAt(0);
  const multiplier = RELATIVE_UNIT_MS[unit];
  if (!multiplier) return null;
  const ms = Date.now() - n * multiplier;
  // A pathologically long digit run ("99999999999999999999d") overflows into
  // a value Date can't represent; reject rather than hand back garbage.
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_EPOCH_MS ? ms : null;
}
