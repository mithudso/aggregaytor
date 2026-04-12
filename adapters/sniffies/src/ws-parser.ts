/**
 * @file ws-parser.ts -- WebSocket frame parsing for Sniffies.
 *
 * Sniffies WebSocket traffic arrives in one of two formats:
 *
 * ## Format 1: Raw JSON (primary, observed April 2025+)
 * ```json
 * {"eventName":"userJoined", "data":{...}}
 * ```
 * The event name is a string property inside a plain JSON object.
 *
 * ## Format 2: Socket.IO `42`-prefix (legacy/fallback)
 * ```
 * 42["eventName", {data}]
 * ```
 * The `42` prefix is Socket.IO's "EVENT" packet type. The event name is
 * the first element of the JSON array that follows the prefix.
 *
 * Both formats may appear depending on server version or transport
 * negotiation. This module handles both transparently.
 *
 * ## Event Classification
 * After parsing the frame, the adapter needs to know whether the event
 * represents a global/cruising chat message, a presence update, or a DM.
 * The exported helpers {@link isGlobalChatEvent} and {@link isPresenceEvent}
 * classify events by name, using both an exact-match set and a fuzzy
 * lowercase-includes fallback for forward compatibility with new event names.
 */

// ── Frame Parsing ───────────────────────────────────────────────────────────

/** Parsed result from a single WebSocket frame. */
export interface ParsedSocketFrame {
  /** The event name (e.g. "userJoined", "newGlobalMsg"), or "" if unknown. */
  eventName: string;
  /** The event payload (usually an object), or null if none. */
  data: unknown;
}

/**
 * Parse a raw WebSocket text frame into a structured {@link ParsedSocketFrame}.
 *
 * Handles three wire formats:
 *  1. **Socket.IO `42`-prefix** -- `42["eventName", {data}]`
 *  2. **Raw JSON object** -- `{"eventName":"...", "data":{...}}`
 *  3. **Raw JSON array** -- `["eventName", {data}]` (Socket.IO-style without prefix)
 *
 * Returns `null` for heartbeat pings (bare digits like "2" or "3"),
 * binary frames, or unparseable text.
 */
export function parseSocketIOFrame(text: string): ParsedSocketFrame | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  // Heartbeat pings are 1-2 digit strings (e.g. "2", "3", "40")
  if (!trimmed || /^\d{1,2}$/.test(trimmed)) return null;

  try {
    // Format 1: Socket.IO prefix "42[...]"
    // The "42" means packet type 4 (MESSAGE) + sub-type 2 (EVENT).
    // Everything after "42" is a JSON array: [eventName, ...args].
    if (trimmed.startsWith('42')) {
      const socketPayload = JSON.parse(trimmed.slice(2));
      if (Array.isArray(socketPayload)) {
        const eventName = typeof socketPayload[0] === 'string' ? socketPayload[0] : '';
        const data = socketPayload.length > 1 ? socketPayload[1] : socketPayload[0];
        return { eventName, data: (data && typeof data === 'object') ? data : null };
      }
      // Non-array after "42" -- treat as anonymous object payload
      return socketPayload && typeof socketPayload === 'object'
        ? { eventName: '', data: socketPayload }
        : null;
    }

    // Format 2: Raw JSON object {"eventName":"...", "data":...}
    // This is the format observed in production Sniffies WS traffic.
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.eventName === 'string') {
          // Use parsed.data if available; fall back to the whole object
          return { eventName: parsed.eventName, data: parsed.data ?? parsed };
        }
        // Generic JSON object with no event name
        return { eventName: '', data: parsed };
      }
    }

    // Format 3: Raw JSON array (Socket.IO-style without "42" prefix)
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        // If first element is a string, treat it as the event name
        if (parsed.length >= 2 && typeof parsed[0] === 'string') {
          return { eventName: parsed[0], data: parsed[1] };
        }
        return { eventName: '', data: parsed };
      }
    }
  } catch {
    // Invalid JSON -- silently skip non-JSON frames
  }

  return null;
}

// ── Event Classification ────────────────────────────────────────────────────
//
// WebSocket events fall into three buckets:
//  1. Global chat -- broadcast posts visible to all users in the area.
//  2. Presence    -- user join/leave/move events for the map. Not messages.
//  3. DM          -- everything else (private conversation traffic).
//
// Classification uses exact-match sets for known event names, plus fuzzy
// fallback matching (lowercase includes) to handle future event name
// variations without code changes.

/**
 * Event names that indicate global/cruising chat (broadcast to all users).
 *
 * "newGlobalMsg" is the only event CONFIRMED in production WebSocket traffic
 * (April 2025). The rest are speculative names covering likely variants
 * (camelCase, kebab-case, snake_case) for forward compatibility.
 */
export const GLOBAL_CHAT_EVENTS = new Set([
  // *** CONFIRMED from production WebSocket traffic (April 2025): ***
  'newGlobalMsg',
  // Speculative / observed variants
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

/**
 * Presence/map events that should be SKIPPED entirely -- they carry no
 * chat content.
 *
 * However, the adapter still mines `userJoined` events for contact data
 * (avatar URLs, profile attributes) because they include a full profile
 * payload. The classification here just prevents them from being treated
 * as messages.
 */
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

/**
 * Test whether an event name represents a global/cruising chat event.
 *
 * First checks exact membership in {@link GLOBAL_CHAT_EVENTS}, then falls
 * back to a fuzzy lowercase-includes check against keywords like
 * "cruising", "broadcast", "feed", "globalmsg", etc. The fuzzy fallback
 * provides forward compatibility so new event name variants are caught
 * without a code change.
 */
export function isGlobalChatEvent(eventName: string): boolean {
  if (!eventName) return false;
  // Fast path: exact match against the known set
  if (GLOBAL_CHAT_EVENTS.has(eventName)) return true;
  // Fuzzy fallback: lowercase includes for forward compatibility
  const lower = eventName.toLowerCase();
  return lower.includes('cruising') ||
    lower.includes('broadcast') ||
    lower.includes('feed') ||
    lower.includes('globalchat') ||
    lower.includes('globalmsg') ||
    lower.includes('newglobal') ||
    lower.includes('publicmessage');
}

/**
 * Test whether an event name represents a presence/map event that should
 * be skipped for message extraction.
 *
 * Uses the same exact-then-fuzzy strategy as {@link isGlobalChatEvent}.
 * The fuzzy rule: any event starting with "user" that also contains a
 * lifecycle verb (joined, disconnected, moved, etc.) is presence.
 */
export function isPresenceEvent(eventName: string): boolean {
  if (!eventName) return false;
  if (PRESENCE_EVENTS.has(eventName)) return true;
  // Fuzzy: "user" prefix + lifecycle verb = presence
  const lower = eventName.toLowerCase();
  return lower.startsWith('user') && (
    lower.includes('joined') || lower.includes('disconnected') ||
    lower.includes('removed') || lower.includes('awake') ||
    lower.includes('updated') || lower.includes('moved') ||
    lower.includes('left') || lower.includes('online') || lower.includes('offline')
  );
}
