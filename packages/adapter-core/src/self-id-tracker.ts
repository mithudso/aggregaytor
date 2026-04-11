/**
 * self-id-tracker.ts — Detect and track the user's own IDs across platforms.
 *
 * Generalized from sniffiesplus detectSelfIds() and seedSelfIdsFromWindow().
 */

const SELF_ID_KEYS = [
  'selfId', 'self_id', 'myId', 'my_id', 'currentUserId', 'current_user_id',
  'viewerId', 'viewer_id', 'userId', 'user_id', 'profileId', 'profile_id',
  'ownerId', 'owner_id', 'meId', 'me_id',
];

const SELF_OBJECT_KEYS = ['self', 'me', 'currentUser', 'current_user', 'viewer', 'owner'];

export class SelfIdTracker {
  readonly ids = new Set<string>();

  detectFromPayload(obj: Record<string, unknown>): void {
    // Direct ID fields
    for (const key of SELF_ID_KEYS) {
      const value = obj[key];
      if (value && (typeof value === 'string' || typeof value === 'number')) {
        this.ids.add(String(value));
      }
    }

    // Objects with isMe/isSelf flags
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

  seedFromWindow(target: Window & typeof globalThis): void {
    for (const key of SELF_ID_KEYS) {
      try {
        const value = (target as any)[key];
        if (value && (typeof value === 'string' || typeof value === 'number')) {
          this.ids.add(String(value));
        }
      } catch {
        // ignore cross-origin errors
      }
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  clear(): void {
    this.ids.clear();
  }
}
