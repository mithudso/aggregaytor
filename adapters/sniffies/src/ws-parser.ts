/**
 * ws-parser.ts — WebSocket frame parsing for Sniffies.
 *
 * Sniffies uses TWO WebSocket formats:
 *
 * 1. Raw JSON: {"eventName":"userJoined", "data":{...}}
 *    - This is the ACTUAL format observed in production (April 2025+)
 *    - Event name is a property inside the JSON object
 *
 * 2. Socket.IO: 42["eventName", {data}]
 *    - Legacy/fallback — may still be used in some contexts
 *    - Event name is the first array element after the "42" prefix
 */

export interface ParsedSocketFrame {
  eventName: string;
  data: unknown;
}

export function parseSocketIOFrame(text: string): ParsedSocketFrame | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || /^\d{1,2}$/.test(trimmed)) return null; // heartbeat pings

  try {
    // Format 1: Socket.IO prefix "42[...]"
    if (trimmed.startsWith('42')) {
      const socketPayload = JSON.parse(trimmed.slice(2));
      if (Array.isArray(socketPayload)) {
        const eventName = typeof socketPayload[0] === 'string' ? socketPayload[0] : '';
        const data = socketPayload.length > 1 ? socketPayload[1] : socketPayload[0];
        return { eventName, data: (data && typeof data === 'object') ? data : null };
      }
      return socketPayload && typeof socketPayload === 'object'
        ? { eventName: '', data: socketPayload }
        : null;
    }

    // Format 2: Raw JSON object {"eventName":"...", "data":...}
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        // Sniffies-style frame: {"eventName":"...", "data":...}
        if (typeof parsed.eventName === 'string') {
          return { eventName: parsed.eventName, data: parsed.data ?? parsed };
        }
        // Generic JSON object — no event name
        return { eventName: '', data: parsed };
      }
    }

    // Format 3: Raw JSON array
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        // Could be Socket.IO-style without the "42" prefix
        if (parsed.length >= 2 && typeof parsed[0] === 'string') {
          return { eventName: parsed[0], data: parsed[1] };
        }
        return { eventName: '', data: parsed };
      }
    }
  } catch {
    // invalid JSON — skip
  }

  return null;
}

// ── Event Classification ────────────────────────────────────────────────────

// Event names that indicate cruising/global chat (not DMs)
export const GLOBAL_CHAT_EVENTS = new Set([
  // *** CONFIRMED from production WebSocket traffic (April 2025): ***
  'newGlobalMsg',
  // Other observed/expected Sniffies event names
  'cruisingUpdate', 'cruising-update', 'cruisingPost', 'cruising_update',
  'cruisingMessage', 'cruising-message', 'cruising_message',
  'post', 'feedUpdate', 'feed-update', 'feed_update',
  'broadcast', 'globalMessage', 'global-message', 'global_message',
  'update', 'newPost', 'new-post', 'new_post',
  'cruiserUpdate', 'cruiser-update',
  'globalChat', 'global-chat', 'global_chat',
  'publicMessage', 'public-message', 'public_message',
  'shout', 'announcement',
]);

// Presence/map events that should be SKIPPED entirely (not chat messages)
export const PRESENCE_EVENTS = new Set([
  'userJoined', 'userDisconnected', 'userRemoved', 'userAwake',
  'userUpdated', 'userMoved', 'userLeft', 'userOnline', 'userOffline',
  'user-joined', 'user-disconnected', 'user-removed', 'user-awake',
  'user-updated', 'user-moved', 'user-left', 'user-online', 'user-offline',
  'ping', 'pong', 'heartbeat', 'keepalive',
  'connect', 'disconnect', 'reconnect',
  'mapUpdate', 'map-update', 'map_update',
  'locationUpdate', 'location-update', 'location_update',
  'viewportUpdate', 'viewport-update',
]);

export function isGlobalChatEvent(eventName: string): boolean {
  if (!eventName) return false;
  if (GLOBAL_CHAT_EVENTS.has(eventName)) return true;
  const lower = eventName.toLowerCase();
  return lower.includes('cruising') ||
    lower.includes('broadcast') ||
    lower.includes('feed') ||
    lower.includes('globalchat') ||
    lower.includes('globalmsg') ||
    lower.includes('newglobal') ||
    lower.includes('publicmessage');
}

export function isPresenceEvent(eventName: string): boolean {
  if (!eventName) return false;
  if (PRESENCE_EVENTS.has(eventName)) return true;
  const lower = eventName.toLowerCase();
  return lower.startsWith('user') && (
    lower.includes('joined') || lower.includes('disconnected') ||
    lower.includes('removed') || lower.includes('awake') ||
    lower.includes('updated') || lower.includes('moved') ||
    lower.includes('left') || lower.includes('online') || lower.includes('offline')
  );
}
