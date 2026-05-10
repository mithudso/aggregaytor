/**
 * self-id-tracker.ts -- Detect and track the logged-in user's own IDs.
 *
 * Generalized from sniffiesplus detectSelfIds() and seedSelfIdsFromWindow().
 *
 * ## Why self-ID detection is critical
 *
 * When we intercept a message payload, we need to classify it as either
 * `direction: 'in'` (received) or `direction: 'out'` (sent by the user).
 * Without knowing the user's own ID(s) on each platform, every message
 * would appear as inbound -- or worse, the aggregator would route
 * outbound messages to the "new messages" inbox, showing the user their
 * own messages as if they came from someone else.
 *
 * The challenge is that different platforms expose the logged-in user's ID
 * under different field names (`selfId`, `currentUserId`, `viewer_id`,
 * etc.), and sometimes the ID is only discoverable from nested objects
 * with boolean flags like `{ isMe: true, id: "abc" }`.
 *
 * This tracker uses two complementary strategies:
 *  1. **Payload sniffing** (`detectFromPayload`): scans every API response
 *     object for common "self ID" field patterns and boolean flags.
 *  2. **Window globals** (`seedFromWindow`): reads well-known global
 *     variables that some platforms set (e.g. `window.userId`).
 *
 * Detected IDs accumulate in a `Set<string>` so that adapters can call
 * `selfIds.has(senderId)` to determine direction.
 */

// ---------------------------------------------------------------------------
// Field-name heuristics
// ---------------------------------------------------------------------------

/**
 * JSON keys that typically hold the logged-in user's ID as a direct value
 * (string or number). These cover common naming conventions across many
 * REST/WebSocket APIs.
 */
const SELF_ID_KEYS = [
  'selfId', 'self_id', 'myId', 'my_id', 'currentUserId', 'current_user_id',
  'viewerId', 'viewer_id', 'userId', 'user_id', 'profileId', 'profile_id',
  'ownerId', 'owner_id', 'meId', 'me_id',
];

/**
 * JSON keys whose value is expected to be an object representing the
 * logged-in user, potentially containing boolean flags (`isMe`, `isSelf`)
 * and an `id` sub-field.
 */
const SELF_OBJECT_KEYS = ['self', 'me', 'currentUser', 'current_user', 'viewer', 'owner'];

/**
 * Accumulates the logged-in user's platform IDs and provides a fast
 * `has(id)` check for direction classification.
 *
 * Typical lifecycle:
 *  1. Adapter calls `selfIds.seedFromWindow(window)` during `init()` to
 *     pick up any globals the platform already set.
 *  2. As intercepted payloads arrive, the adapter (or its PayloadVisitor)
 *     calls `selfIds.detectFromPayload(obj)` on each object node.
 *  3. When building a `UnifiedMessage`, the adapter calls
 *     `selfIds.has(senderId)` to set `direction`.
 */
export class SelfIdTracker {
  /**
   * All detected IDs (as strings) belonging to the logged-in user.
   * Multiple IDs can exist when a platform uses different ID types
   * (e.g. a numeric user ID and a UUID profile ID).
   */
  readonly ids = new Set<string>();

  // -------------------------------------------------------------------------
  // Detection strategies
  // -------------------------------------------------------------------------

  /**
   * Scan an API response object for fields that look like they hold the
   * logged-in user's ID.
   *
   * Two heuristics are used:
   *  - **Direct ID keys**: if `obj.selfId` (or similar) is a string/number,
   *    treat it as a self ID.
   *  - **Object-with-flag keys**: if `obj.me` (or similar) is an object
   *    with `isMe: true`, extract its `id` sub-field.
   *
   * @param obj - A single object node from a parsed API payload.
   */
  detectFromPayload(obj: Record<string, unknown>): void {
    // Strategy 1: Direct ID fields (e.g. `{ currentUserId: "abc123" }`)
    for (const key of SELF_ID_KEYS) {
      const value = obj[key];
      if (value && (typeof value === 'string' || typeof value === 'number')) {
        this.ids.add(String(value));
      }
    }

    // Strategy 2: Nested objects with boolean "is me" flags
    // e.g. `{ viewer: { isMe: true, id: "abc123" } }`
    for (const key of SELF_OBJECT_KEYS) {
      const value = obj[key];
      if (value && typeof value === 'object') {
        const sub = value as Record<string, unknown>;
        if (sub.isMe === true || sub.is_me === true || sub.isSelf === true) {
          const id = sub.id || sub._id || sub.userId || sub.user_id || sub.profileId;
          if (id) this.ids.add(String(id));
        }
      }
    }
  }

  /**
   * Read well-known global variables from the page's `window` that may
   * contain the logged-in user's ID.
   *
   * Some platforms set globals like `window.userId` or `window.currentUserId`
   * during page load. This is a quick way to seed the tracker before any
   * API responses have arrived.
   *
   * @param target - The MAIN-world window to inspect.
   */
  seedFromWindow(target: Window & typeof globalThis): void {
    for (const key of SELF_ID_KEYS) {
      try {
        const value = (target as any)[key];
        if (value && (typeof value === 'string' || typeof value === 'number')) {
          this.ids.add(String(value));
        }
      } catch {
        // Swallow cross-origin errors (e.g. if target is an iframe with
        // a different origin, reading properties will throw).
      }
    }
  }

  // -------------------------------------------------------------------------
  // Query & lifecycle
  // -------------------------------------------------------------------------

  /**
   * Check if the given ID belongs to the logged-in user.
   * @param id - A sender/user ID from a message payload.
   * @returns `true` if this ID was previously detected as the user's own.
   */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Remove all tracked IDs (called during adapter `destroy()`). */
  clear(): void {
    this.ids.clear();
  }
}
