/**
 * sniffies-migrate.ts — One-time migration from sniffiesplus localStorage
 * into the Aggregaytor PouchDB store.
 *
 * Reads:
 *   - sniffiesSoftFilterChatActivity_v1 (chat timestamps per profile)
 *   - sniffiesSoftFilterBookmarks_v1 (bookmarked profiles with aliases)
 *   - sniffiesSoftFilterNotes_v1 (profile notes)
 *
 * This runs in ISOLATED world (has chrome.runtime access) but reads
 * localStorage from the sniffies.com page via the bridge.
 */

const MIGRATION_DONE_KEY = 'aggregaytor_sniffies_migration_v1';

interface ChatActivityEntry {
  myLastTs?: number | string;
  theirLastTs?: number | string;
  anyLastTs?: number | string;
  updatedAt?: number | string;
}

interface BookmarkEntry {
  profileId?: string;
  id?: string;
  profileUrl?: string;
  profileLabel?: string;
  alias?: string;
  categories?: string[];
  tags?: string[];
  lastSeenAt?: number | string;
  createdAt?: number | string;
  updatedAt?: number | string;
}

function parseTs(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === 'number') {
    const ms = val < 1e12 ? val * 1000 : val;
    return new Date(ms).toISOString();
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function profileUrl(id: string): string {
  return `https://sniffies.com/profile/${id}`;
}

/**
 * Request localStorage data from the MAIN world via CustomEvent.
 */
function requestLocalStorageKey(key: string): Promise<string | null> {
  // v0.57.39: this used to inject an inline <script>{textContent: ...}</script>
  // to bridge MAIN-world localStorage back to ISOLATED world. That was wrong
  // on two counts: (1) localStorage is per-origin not per-world, so ISOLATED
  // can read it directly, and (2) sites with a strict CSP (no 'unsafe-inline')
  // would block the inline tag entirely. Direct localStorage access works
  // everywhere and skips the round-trip.
  try {
    return Promise.resolve(localStorage.getItem(key));
  } catch {
    return Promise.resolve(null);
  }
}

async function runMigration(): Promise<void> {
  // Check if already migrated
  const done = await chrome.storage.local.get(MIGRATION_DONE_KEY);
  if (done[MIGRATION_DONE_KEY]) return;

  console.log('[Aggregaytor] Starting sniffiesplus data migration...');

  const messages: any[] = [];
  const contacts: any[] = [];

  // 1. Migrate chat activity (timestamps per profile)
  const activityRaw = await requestLocalStorageKey('sniffiesSoftFilterChatActivity_v1');
  if (activityRaw) {
    try {
      const activity: Record<string, ChatActivityEntry> = JSON.parse(activityRaw);
      for (const [profileId, entry] of Object.entries(activity)) {
        if (!profileId || !entry) continue;
        const id = profileId.toLowerCase().trim();
        if (!id || !/^[0-9a-f]{6,}$/.test(id)) continue;

        const theirTs = parseTs(entry.theirLastTs);
        const myTs = parseTs(entry.myLastTs);
        const anyTs = parseTs(entry.anyLastTs);

        // Create placeholder contact
        contacts.push({
          id: `sniffies:${id}`,
          platform: 'sniffies',
          platformUserId: id,
          displayName: id.slice(0, 10),
          profileUrl: profileUrl(id),
          avatarUrl: '',
          lastSeen: anyTs || theirTs || myTs || new Date().toISOString(),
          metadata: { migrated: true },
        });

        // Create synthetic messages from timestamps
        if (theirTs) {
          messages.push({
            id: `sniffies:migrated-in-${id}`,
            platform: 'sniffies',
            threadId: `sniffies:${id}`,
            contactId: `sniffies:${id}`,
            direction: 'in',
            body: '(migrated — message text not available)',
            timestamp: theirTs,
            read: true,
            metadata: { migrated: true },
          });
        }
        if (myTs) {
          messages.push({
            id: `sniffies:migrated-out-${id}`,
            platform: 'sniffies',
            threadId: `sniffies:${id}`,
            contactId: `sniffies:${id}`,
            direction: 'out',
            body: '(migrated — message text not available)',
            timestamp: myTs,
            read: true,
            metadata: { migrated: true },
          });
        }
      }
    } catch (e) {
      console.warn('[Aggregaytor] Failed to parse chat activity:', e);
    }
  }

  // 2. Migrate bookmarks (profiles with aliases/labels)
  const bookmarksRaw = await requestLocalStorageKey('sniffiesSoftFilterBookmarks_v1');
  if (bookmarksRaw) {
    try {
      const parsed = JSON.parse(bookmarksRaw);
      const rows: BookmarkEntry[] = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
      for (const row of rows) {
        const id = ((row.profileId || row.id) || '').toLowerCase().trim();
        if (!id || !/^[0-9a-f]{6,}$/.test(id)) continue;

        // Update contact with bookmark data
        const existing = contacts.find(c => c.platformUserId === id);
        if (existing) {
          existing.displayName = row.alias || row.profileLabel || existing.displayName;
          existing.metadata = {
            ...existing.metadata,
            bookmarked: true,
            categories: row.categories || [],
            tags: row.tags || [],
          };
        } else {
          contacts.push({
            id: `sniffies:${id}`,
            platform: 'sniffies',
            platformUserId: id,
            displayName: row.alias || row.profileLabel || id.slice(0, 10),
            profileUrl: row.profileUrl || profileUrl(id),
            avatarUrl: '',
            lastSeen: parseTs(row.lastSeenAt) || new Date().toISOString(),
            metadata: {
              migrated: true,
              bookmarked: true,
              categories: row.categories || [],
              tags: row.tags || [],
            },
          });
        }
      }
    } catch (e) {
      console.warn('[Aggregaytor] Failed to parse bookmarks:', e);
    }
  }

  // 3. Migrate notes
  const notesRaw = await requestLocalStorageKey('sniffiesSoftFilterNotes_v1');
  if (notesRaw) {
    try {
      const notes: Record<string, string> = JSON.parse(notesRaw);
      for (const [id, note] of Object.entries(notes)) {
        if (!id || !note) continue;
        const normalizedId = id.toLowerCase().trim();
        const existing = contacts.find(c => c.platformUserId === normalizedId);
        if (existing) {
          existing.metadata = { ...existing.metadata, notes: note };
        }
      }
    } catch (e) {
      console.warn('[Aggregaytor] Failed to parse notes:', e);
    }
  }

  // Send to service worker.
  //
  // This is a ONE-SHOT migration: once MIGRATION_DONE_KEY is set we never look
  // at the legacy localStorage again. So the done-marker must only be written
  // when the hand-off actually succeeded. This script runs at document_start,
  // which is exactly when the MV3 service worker is most likely to still be
  // spinning up — sendMessage then rejects with "Receiving end does not
  // exist", and the previous code swallowed that, marked the migration
  // complete, and silently dropped every bookmark, note and timestamp the
  // user had in sniffiesplus. On failure we now leave the marker unset so the
  // next page load retries.
  let allDelivered = true;

  if (contacts.length) {
    try {
      await chrome.runtime.sendMessage({
        type: 'ADAPTER_CONTACTS',
        platform: 'sniffies',
        payload: contacts,
      });
    } catch (e) {
      allDelivered = false;
      console.warn('[Aggregaytor] Failed to send migrated contacts:', e);
    }
  }

  if (messages.length) {
    try {
      await chrome.runtime.sendMessage({
        type: 'ADAPTER_MESSAGES',
        platform: 'sniffies',
        payload: messages,
      });
    } catch (e) {
      allDelivered = false;
      console.warn('[Aggregaytor] Failed to send migrated messages:', e);
    }
  }

  if (!allDelivered) {
    console.warn('[Aggregaytor] Migration NOT marked done — service worker did not accept the payload; will retry on next page load');
    return;
  }

  // Mark as done
  await chrome.storage.local.set({ [MIGRATION_DONE_KEY]: Date.now() });
  console.log(`[Aggregaytor] Migration complete: ${contacts.length} contacts, ${messages.length} messages`);
}

// Run migration on page load
runMigration().catch(e => console.warn('[Aggregaytor] Migration error:', e));
