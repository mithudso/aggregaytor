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

export function extractTimestamp(obj: Record<string, unknown>): string | null {
  for (const key of TIMESTAMP_KEYS) {
    const value = obj[key];
    if (!value) continue;
    if (typeof value === 'number') {
      // Seconds vs milliseconds heuristic
      const ms = value < 1e12 ? value * 1000 : value;
      return new Date(ms).toISOString();
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!isNaN(parsed)) return new Date(parsed).toISOString();
    }
  }
  return null;
}

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

  // Check sender against known self IDs
  const senderId = String(obj.senderId || obj.sender_id || obj.from || obj.fromId || obj.from_id || '');
  if (senderId && selfIds.has(senderId)) return 'out';
  if (senderId && selfIds.size > 0) return 'in';

  return null;
}

export function extractMessageText(obj: Record<string, unknown>): string | null {
  for (const key of TEXT_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

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

export function parseRelativeTimeString(text: string): number | null {
  const match = String(text || '').match(/(\d+)\s*(s|sec|m|min|h|hr|d|day|w|wk)/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2].charAt(0).toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
  };
  return multipliers[unit] ? Date.now() - n * multipliers[unit] : null;
}
