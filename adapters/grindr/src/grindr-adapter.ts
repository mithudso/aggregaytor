/**
 * grindr-adapter.ts — Grindr Web platform adapter.
 *
 * Grindr Web (web.grindr.com) is a React/Vite SPA.
 * API: /v3/inbox, /v4/chat/conversation/{id}, /v1/inbox/conversation
 * WebSocket: /v1/ws
 *
 * Message fields: isFromMe, conversationId, profileId, messageId, body, text, timestamp
 */

import {
  BaseAdapter,
  walkPayload,
  createLogger,
} from '@aggregaytor/adapter-core';
import type { Platform, UnifiedMessage, UnifiedContact } from '@aggregaytor/adapter-core';
// Profile-id plausibility now delegates to @aggregaytor/grindr-lib (5–10
// digits — tighter than the old bare /^\d+$/ check, by design). The lib
// exposes it on the `dom` namespace export, not as a top-level named export.
import { dom as grindrDom } from '@aggregaytor/grindr-lib';

const { isPlausibleProfileId } = grindrDom;

// Level-gated logger. Bare console.* calls ran unconditionally on the parse
// hot path inside a page we do not control, dumping conversation IDs and
// profile IDs into the host page's console with no way to silence them.
const log = createLogger('[Aggregaytor:Grindr]');

const BODY_KEYS = ['body', 'text', 'message', 'content', 'snippet', 'messageBody', 'lastMessage', 'preview'];

/** Hosts whose responses may legitimately be parsed as Grindr data. */
const GRINDR_HOST_RE = /(^|\.)grindr\.com$/i;

/**
 * Test whether `url` resolves to a Grindr-owned host.
 *
 * A bare `url.includes('grindr.com')` test also accepts third-party URLs that
 * merely mention the domain (`https://evil.example/?ref=grindr.com`), which
 * would let anything running on the page feed forged JSON straight into the
 * user's message and contact store. Relative URLs resolve against the page
 * origin; anything unparseable is rejected.
 */
function isGrindrHost(url: string): boolean {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    return GRINDR_HOST_RE.test(new URL(String(url), base).hostname);
  } catch {
    return false;
  }
}

/** Largest absolute epoch-ms magnitude the ECMAScript Date type can represent. */
const MAX_EPOCH_MS = 8.64e15;

/**
 * Coerce a timestamp value to epoch-ms, rejecting anything a `Date` cannot
 * render. `{"timestamp": 1e20}` is valid JSON, and the resulting
 * `new Date(1e20).toISOString()` throws `RangeError: Invalid time value`
 * from inside the walkPayload visitor — which aborts the rest of the walk
 * and silently drops every message later in the same response.
 */
function parseTs(value: unknown): number {
  if (!value) return 0;
  let ms = 0;
  if (typeof value === 'number') ms = value < 1e12 ? value * 1000 : value;
  else if (typeof value === 'string') { const p = Date.parse(value); ms = isNaN(p) ? 0 : p; }
  else return 0;
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_EPOCH_MS ? ms : 0;
}

/** Upper bound on the photo-hash -> profileId index (see setHash). */
const MAX_HASH_MAP_ENTRIES = 20_000;

/**
 * Insert into the photo-hash index with a FIFO cap.
 *
 * Every cascade page adds fresh hashes and nothing ever removed them, so a
 * long browsing session grew this map without bound. Map preserves insertion
 * order, so dropping from the front evicts the oldest entries.
 */
function setHash(map: Map<string, string>, hash: string, profileId: string): void {
  map.set(hash, profileId);
  if (map.size > MAX_HASH_MAP_ENTRIES) {
    const iter = map.keys();
    for (let i = 0; i < 5_000; i++) {
      const next = iter.next();
      if (next.done) break;
      map.delete(next.value);
    }
  }
}

function extractBody(obj: Record<string, unknown>): string {
  for (const key of BODY_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length >= 1) return value.trim();
  }
  return '';
}

export class GrindrAdapter extends BaseAdapter {
  readonly platform: Platform = 'grindr';
  private captureCount = 0;

  async init(): Promise<void> {
    log.info('Initializing adapter...');
    this.selfIds.seedFromWindow(window as Window & typeof globalThis);
    this.setupNetworkInterception(window as Window & typeof globalThis);
    log.info('Adapter initialized. Self IDs:', [...this.selfIds.ids]);
  }

  protected shouldInterceptUrl(url: string): boolean {
    const s = String(url).toLowerCase();
    // Coarse gate first (cheap), then a real host check so look-alike
    // third-party URLs cannot inject forged payloads. See isGrindrHost().
    if (!s.includes('grindr.com')) return false;
    return isGrindrHost(url);
  }

  protected parseApiResponse(url: string, payload: unknown): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];
    const contacts: UnifiedContact[] = [];

    walkPayload(payload, null, {
      onObject: (obj, _ctx, _depth) => {
        this.selfIds.detectFromPayload(obj);

        // Index profileId ↔ photoMediaHashes for middle-click block lookup.
        // This runs inside the adapter's fetch interceptor which is installed
        // BEFORE the page's own fetch, so it catches cascade API responses
        // that the grindr.ts interceptor might miss.
        //
        // NOTE: `window.__grindr_hash_map` is a documented exception to the
        // "don't expose anything on window.*" rule — it is the handoff to the
        // MAIN-world reader in extensions/aggregaytor/content/grindr.ts. It
        // holds only photo hashes the host page already knows, no auth state.
        const pid = String(obj.profileId || '');
        if (pid && isPlausibleProfileId(pid)) {   // delegates to @aggregaytor/grindr-lib
          const w = (typeof window !== 'undefined' ? window : globalThis) as any;
          if (!(w.__grindr_hash_map instanceof Map)) w.__grindr_hash_map = new Map<string, string>();
          const hashMap = w.__grindr_hash_map as Map<string, string>;
          // Index photoMediaHashes (cascade API format)
          const pmh = obj.photoMediaHashes;
          if (Array.isArray(pmh)) {
            for (const h of pmh) {
              if (typeof h === 'string' && h.length > 10) setHash(hashMap, h, pid);
            }
          }
          // Index profileImageMediaHash (individual profile API format)
          const pimh = String(obj.profileImageMediaHash || '');
          if (pimh && pimh.length > 10) setHash(hashMap, pimh, pid);
          // Index medias[].mediaHash
          const medias = obj.medias;
          if (Array.isArray(medias)) {
            for (const m of medias) {
              const mh = String((m as any)?.mediaHash || '');
              if (mh && mh.length > 10) setHash(hashMap, mh, pid);
            }
          }
        }

        const body = extractBody(obj);
        const conversationId = String(obj.conversationId || obj.conversation_id || '');
        const profileId = String(obj.profileId || obj.senderId || obj.sender_id || '');
        const messageId = String(obj.messageId || obj.message_id || obj.id || obj.chatMessageId || '');

        // Extract timestamp
        let ts = parseTs(obj.timestamp || obj.createdAt || obj.created_at || obj.sentAt || obj.sent_at || obj.date || obj.ts);

        // Need body text or at least a conversation/profile context
        if (body && (conversationId || profileId || ts)) {
          // Direction: Grindr uses isFromMe boolean
          let direction: 'in' | 'out' = 'in';
          if (obj.isFromMe === true || obj.is_from_me === true) {
            direction = 'out';
          } else if (profileId && this.selfIds.has(profileId)) {
            direction = 'out';
          }

          const contactKey = direction === 'out'
            ? (conversationId || profileId)
            : (profileId || conversationId);

          if (!ts) ts = Date.now();

          messages.push({
            id: `grindr:${messageId || `${contactKey}:${ts}`}`,
            platform: 'grindr',
            threadId: `grindr:${conversationId || profileId || 'unknown'}`,
            contactId: `grindr:${contactKey || 'unknown'}`,
            direction,
            body,
            timestamp: new Date(ts).toISOString(),
            read: direction === 'out',
            metadata: { conversationId, profileId, messageType: String(obj.messageType || obj.type || ''), url },
          });
        }

        // Extract contact info — from any object with a profile ID, EXCEPT
        // our own. Without the self filter the logged-in user's own profile
        // was stored as a contact (every sibling adapter already skips self).
        if (profileId && !this.selfIds.has(profileId)) {
          const displayName = String(obj.displayName || obj.name || obj.username || '').trim();
          const photoHash = String(obj.photoHash || obj.profileImageMediaHash || obj.mediahash || obj.primaryPhotoHash || '');
          // Grindr CDN: https://cdns.grindr.com/images/profile/1024x1024/{hash}
          const avatarUrl = photoHash
            ? `https://cdns.grindr.com/images/profile/1024x1024/${photoHash}`
            : String(obj.avatar || obj.avatarUrl || obj.photoUrl || '');
          const md: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(obj)) {
            const k = key.toLowerCase();
            if (typeof value === 'string' && value.length < 100) {
              if (/bodytype|build/.test(k)) md.bodyType = value;
              if (/position|tribe|sexualposition/.test(k)) md.position = value;
              if (k === 'age' || k === 'showage') md.age = value;
              if (/ethnicity/.test(k)) md.ethnicity = value;
              if (/height/.test(k)) md.height = value;
              if (/weight/.test(k)) md.weight = value;
              if (/distance|approximatedistance/.test(k)) md.distance = value;
              if (/aboutme|bio/.test(k)) md.profileText = value;
              if (/lookingfor/.test(k)) md.lookingFor = value;
            }
          }
          // Capture preference signals for auto-training
          if (obj.isFavorite === true) md.isFavorite = true;
          if (obj.isBlocked === true || obj.isHidden === true) md.isBlocked = true;
          if (obj.isBoosting === true) md.isBoosting = true;
          // URL-based tagging — Grindr's block/favorite/taps list endpoints
          // return profile objects WITHOUT an isFavorite/isBlocked flag on
          // each row (membership in the list is the signal). Tag by URL so
          // these contacts can drive auto-training without manual labels.
          // Source endpoints observed in real traffic:
          //   /api/v3.1/me/blocks  → blocked profiles (negative signal)
          //   /api/v5/favorites    → favorited profiles (positive signal)
          //   /api/v2/taps/received→ incoming taps (weak positive signal)
          //   /api/v1/hides, /api/me/hides → hidden profiles (negative)
          const urlLower = String(url).toLowerCase();
          if (/\/blocks(\b|\?|$)/.test(urlLower) || /\/me\/blocks/.test(urlLower)) {
            md.isBlocked = true;
          }
          if (/\/hides(\b|\?|$)/.test(urlLower) || /\/me\/hides/.test(urlLower)) {
            md.isBlocked = true; // hides are treated the same as blocks for training
          }
          if (/\/favorites(\b|\?|$)/.test(urlLower) || /\/me\/favorites/.test(urlLower)) {
            md.isFavorite = true;
          }
          if (/\/taps\/received/.test(urlLower)) {
            md.wasTapped = true; // received a tap from this profile
          }
          contacts.push({
            id: `grindr:${profileId}`,
            platform: 'grindr',
            platformUserId: profileId,
            displayName,
            profileUrl: `https://web.grindr.com/chat/${conversationId || profileId}`,
            avatarUrl,
            lastSeen: ts ? new Date(ts).toISOString() : new Date().toISOString(),
            metadata: md,
          });
        }
      },
    });

    if (messages.length) {
      this.captureCount += messages.length;
      log.info(`Captured ${messages.length} messages from ${url} (total: ${this.captureCount})`);
    }
    if (contacts.length) {
      log.debug(`Captured ${contacts.length} contacts from ${url}`);
      this.emit({ type: 'contacts', payload: contacts });
    }

    return messages;
  }

  protected parseWebSocketFrame(data: string | ArrayBuffer): UnifiedMessage[] {
    if (typeof data !== 'string') return [];
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') {
        return this.parseApiResponse('[ws]', parsed);
      }
    } catch {
      // not JSON
    }
    return [];
  }
}
