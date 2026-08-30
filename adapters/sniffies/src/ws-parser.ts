/**
 * @file ws-parser.ts -- WebSocket frame parsing for Sniffies.
 *
 * Frame decoding now DELEGATES to `@aggregaytor/sniffies-lib` — the vendored
 * canonical `decodeSocketFrame`. {@link parseSocketIOFrame} is a thin wrapper
 * that returns the library's shape verbatim: `{ event, data }` (note the field
 * is `event`, NOT the pre-adoption `eventName`).
 *
 * The library's Socket.IO/Engine.IO decode differs from the old hand-rolled
 * parser in three observable ways (this is an intentional behavior adoption):
 *  1. It UNWRAPS double-encoded inner JSON strings (a `"{...}"` payload inside a
 *     frame is parsed a second time).
 *  2. A raw JSON object frame maps to `{ event: '', data: wholeObject }` — it
 *     does NOT read an `eventName` field off the object.
 *  3. A leading-digit-then-`[` frame (including a bare `[...]` array) is treated
 *     as a Socket.IO event tuple: `[a, b]` → `{ event: String(a), data: b }`.
 *
 * ## Event Classification
 * After parsing the frame, the adapter needs to know whether the event
 * represents a global/cruising chat message, a presence update, or a DM.
 * The exported helpers {@link isGlobalChatEvent} and {@link isPresenceEvent}
 * classify events by name, using both an exact-match set and a fuzzy
 * lowercase-includes fallback for forward compatibility with new event names.
 */

import { decodeSocketFrame } from '@aggregaytor/sniffies-lib';

// ── Frame Parsing ───────────────────────────────────────────────────────────

/**
 * Parsed result from a single WebSocket frame — the shape of
 * `@aggregaytor/sniffies-lib`'s `decodeSocketFrame`.
 */
export interface ParsedSocketFrame {
  /** The event name (e.g. "userJoined", "newGlobalMsg"), or "" if unknown. */
  event: string;
  /** The event payload (object, array, primitive), or null if none. */
  data: unknown;
}

/**
 * Parse a raw WebSocket text frame into a structured {@link ParsedSocketFrame}.
 *
 * Thin wrapper that now delegates to `@aggregaytor/sniffies-lib`'s
 * `decodeSocketFrame`; the returned object is the library's `{ event, data }`
 * shape. Returns `null` for heartbeat pings (bare digits), binary frames, or
 * unparseable text.
 */
export function parseSocketIOFrame(text: string): ParsedSocketFrame | null {
  return decodeSocketFrame(text) as ParsedSocketFrame | null;
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
