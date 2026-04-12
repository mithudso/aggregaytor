/**
 * ws-parser.ts — Socket.IO frame parsing for Sniffies WebSocket messages.
 *
 * Sniffies uses Socket.IO which prefixes frames with "42".
 * Format: 42["eventName", {data}]
 * The event name tells us if it's a DM or cruising update.
 */

export interface ParsedSocketFrame {
  eventName: string;
  data: unknown;
}

export function parseSocketIOFrame(text: string): ParsedSocketFrame | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || /^\d+$/.test(trimmed)) return null;

  try {
    if (trimmed.startsWith('42')) {
      const socketPayload = JSON.parse(trimmed.slice(2));
      if (Array.isArray(socketPayload)) {
        // Socket.IO format: ["eventName", data]
        const eventName = typeof socketPayload[0] === 'string' ? socketPayload[0] : '';
        const data = socketPayload.length > 1 ? socketPayload[1] : socketPayload[0];
        return { eventName, data: (data && typeof data === 'object') ? data : null };
      }
      return socketPayload && typeof socketPayload === 'object'
        ? { eventName: '', data: socketPayload }
        : null;
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? { eventName: '', data: parsed } : null;
    }
  } catch {
    // invalid JSON
  }

  return null;
}

// Event names that indicate cruising/global chat (not DMs)
export const GLOBAL_CHAT_EVENTS = new Set([
  'cruisingUpdate', 'cruising-update', 'cruisingPost', 'cruising_update',
  'post', 'feedUpdate', 'feed-update', 'feed_update',
  'broadcast', 'globalMessage', 'global-message', 'global_message',
  'update', 'newPost', 'new-post', 'new_post',
  'cruiserUpdate', 'cruiser-update',
]);

export function isGlobalChatEvent(eventName: string): boolean {
  if (!eventName) return false;
  return GLOBAL_CHAT_EVENTS.has(eventName) ||
    eventName.toLowerCase().includes('cruising') ||
    eventName.toLowerCase().includes('broadcast') ||
    eventName.toLowerCase().includes('feed');
}
