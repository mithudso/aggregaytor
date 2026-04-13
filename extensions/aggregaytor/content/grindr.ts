/**
 * grindr.ts — MAIN world content script for web.grindr.com.
 *
 * Runs in page context to intercept fetch/XHR/WebSocket.
 * Communicates with ISOLATED world bridge via CustomEvents.
 */

import { GrindrAdapter } from '@aggregaytor/adapter-grindr';
import { getCapturedAuth } from '@aggregaytor/adapter-core';
import { initTextExpander } from './text-expander.js';
import { initGrindrFilters, indexGrindrProfile } from './grindr-filters.js';

const LOG = '[Aggregaytor:Grindr]';

// ── Profile ID ↔ Photo Hash Map ─────────────────────────────────────────────
// Grindr's cascade grid doesn't expose profile IDs in the DOM. The adapter
// (which patches fetch BEFORE the page loads) indexes all profileId + photoHash
// pairs from API responses into window.__grindr_hash_map. We use that global
// map for lookups, plus maintain our own as a supplement.
const photoHashToProfileId = new Map<string, string>();

// Getter that checks both the adapter's global map and our local one
function lookupProfileId(hash: string): string {
  // Check adapter's map first (has cascade API data we might miss)
  const w = window as any;
  if (w.__grindr_hash_map instanceof Map) {
    const pid = w.__grindr_hash_map.get(hash);
    if (pid) return pid;
  }
  return photoHashToProfileId.get(hash) || '';
}

function indexProfileFromPayload(obj: Record<string, unknown>): void {
  const pid = String(obj.profileId || obj.profileID || '');
  if (!pid || !/^\d+$/.test(pid)) return;

  // Index the primary photo hash
  const hash = String(obj.photoHash || obj.profileImageMediaHash || obj.mediahash || obj.primaryPhotoHash || '');
  if (hash && hash !== 'undefined' && hash !== 'null') {
    photoHashToProfileId.set(hash, pid);
  }

  // Index from photoMediaHashes array — THIS IS THE KEY FIELD.
  // The cascade API (/api/v3/cascade/) uses items[].data.photoMediaHashes
  // (an array of hash strings), NOT profileImageMediaHash.
  const photoMediaHashes = obj.photoMediaHashes;
  if (Array.isArray(photoMediaHashes)) {
    for (const h of photoMediaHashes) {
      if (typeof h === 'string' && h.length > 10) {
        photoHashToProfileId.set(h, pid);
      }
    }
  }

  // Also index from medias array (individual profile API format)
  const medias = obj.medias;
  if (Array.isArray(medias)) {
    for (const m of medias) {
      const mHash = String((m as any)?.mediaHash || '');
      if (mHash && mHash !== 'undefined') {
        photoHashToProfileId.set(mHash, pid);
      }
    }
  }
}

// Expose the lookup function on window so the bridge can use it
(window as any).__aggregaytor_grindr_lookupProfileId = function(photoHash: string): string {
  return photoHashToProfileId.get(photoHash) || '';
};

function sendToBridge(message: Record<string, unknown>): void {
  try {
    window.dispatchEvent(
      new CustomEvent('__aggregaytor_message', {
        detail: JSON.parse(JSON.stringify(message)),
      }),
    );
  } catch {
    // silently ignore
  }
}

const adapter = new GrindrAdapter({ platform: 'grindr' });

adapter.on('messages', (event) => {
  console.log(`${LOG} Messages captured:`, (event.payload as any[]).length);
  // Index profileIds from message metadata for middle-click block lookup
  for (const m of event.payload as any[]) {
    if (m.metadata?.profileId && m.metadata?.conversationId) {
      photoHashToProfileId.set(m.metadata.conversationId, m.metadata.profileId);
    }
  }
  sendToBridge({
    type: 'ADAPTER_MESSAGES',
    platform: 'grindr',
    payload: event.payload,
  });
});

adapter.on('contacts', (event) => {
  console.log(`${LOG} Contacts captured:`, (event.payload as any[]).length);
  // Index photo hashes for middle-click profile ID lookup
  for (const c of event.payload as any[]) {
    if (c.avatarUrl && c.platformUserId) {
      const hashMatch = c.avatarUrl.match(/\/([a-f0-9]{32,})/i);
      if (hashMatch) photoHashToProfileId.set(hashMatch[1], c.platformUserId);
    }
  }
  sendToBridge({
    type: 'ADAPTER_CONTACTS',
    platform: 'grindr',
    payload: event.payload,
  });
});

adapter.init().then(() => {
  console.log(`${LOG} Adapter initialized`);
}).catch((err) => {
  console.error(`${LOG} Adapter init failed:`, err);
});

// Text expander — type "hg " to expand to "Hey there. How's it going?"
initTextExpander();

// Grindr cascade filters — hide/show profiles by ethnicity, gender, keywords
initGrindrFilters();

// ── Proactive Profile Indexing ──────────────────────────────────────────────
// Intercept ALL fetch responses on grindr.com to build the photoHash→profileId
// map. This catches cascade API responses, profile fetches, and any other
// endpoint that returns profile data with mediaHash fields.
const origFetch = window.fetch;
window.fetch = async function(...args: Parameters<typeof fetch>) {
  const res = await origFetch.apply(this, args);
  try {
    const url = String((args[0] as any)?.url || args[0] || '');
    if (!url.includes('grindr.com')) return res;
    const ct = String(res.headers?.get('content-type') || '');
    if (!ct.includes('json')) return res;
    const clone = res.clone();
    clone.json().then((data: any) => {
      // Walk the response for profile objects with profileId + medias/photoHash
      const walk = (obj: any, depth = 0) => {
        if (!obj || typeof obj !== 'object' || depth > 5) return;
        if (Array.isArray(obj)) { obj.slice(0, 50).forEach(item => walk(item, depth + 1)); return; }
        indexProfileFromPayload(obj);
        // Also index for Grindr cascade filters (ethnicity, gender, etc.)
        indexGrindrProfile(obj);
        for (const v of Object.values(obj)) {
          if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(data);
    }).catch(() => {});
  } catch {}
  return res;
} as typeof fetch;

// ── Block by Photo Hash Handler ──────────────────────────────────────────────
// When the bridge can't find a profile ID directly in the DOM (most common
// on the cascade grid), it sends the photo hash from the img src. We look it
// up in our photoHash→profileId map and trigger the block.
window.addEventListener('__aggregaytor_block_by_hash', (async (event: CustomEvent) => {
  const { photoHash } = event.detail || {};
  if (!photoHash) return;

  let profileId = lookupProfileId(photoHash);

  // Fallback: scan visible grid images for a /chat/ link near the matching img
  if (!profileId) {
    const adapterMapSize = (window as any).__grindr_hash_map?.size || 0;
    console.log(`${LOG} Hash ${photoHash.slice(0, 12)} not in maps (adapter: ${adapterMapSize}, local: ${photoHashToProfileId.size}), scanning DOM...`);

    const allImages = document.querySelectorAll('img[src*="cdns.grindr.com"]');
    for (const img of allImages) {
      const src = (img as HTMLImageElement).src;
      if (src.includes(photoHash)) {
        const card = (img as HTMLElement).closest('[data-testid="cascadeCellContainer"]');
        if (card) {
          const link = card.querySelector('a[href*="/chat/"]');
          const href = link?.getAttribute('href') || '';
          const match = href.match(/\/chat\/(\d+)/);
          if (match) {
            profileId = match[1];
            photoHashToProfileId.set(photoHash, profileId);
            break;
          }
        }
      }
    }
  }

  if (!profileId) {
    console.warn(`${LOG} Could not resolve hash ${photoHash.slice(0, 12)} to profileId`);
    return;
  }

  console.log(`${LOG} Resolved hash → profileId: ${profileId}`);
  window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
    detail: { profileId },
  }));
}) as EventListener);

// ── Block/Hide Profile Handler ──────────────────────────────────────────────
// Middle-click on a profile triggers this via the bridge. Uses the captured
// Grindr auth token (from intercepted API calls) to call the block API,
// falling back to the hide API if blocking fails.
window.addEventListener('__aggregaytor_block_profile', ((event: CustomEvent) => {
  const { profileId } = event.detail || {};
  if (!profileId) return;
  console.log(`${LOG} Blocking profile: ${profileId}`);

  const auth = getCapturedAuth('grindr.com');
  if (!auth) {
    console.warn(`${LOG} No captured auth for Grindr — browse a bit first to capture the JWT`);
    return;
  }

  // Hide API: POST /api/v1/me/hides/{profileId} (confirmed from HAR capture)
  // No request body needed. Falls back to block API if hide fails.
  fetch(`https://web.grindr.com/api/v1/me/hides/${profileId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
  }).then(async (res) => {
    let success = false;
    if (res.ok) {
      console.log(`${LOG} Hide success for ${profileId}`);
      success = true;
    } else {
      console.warn(`${LOG} Hide failed (${res.status}), trying block API...`);
      const blockRes = await fetch(`https://web.grindr.com/api/v3/me/blocks/${profileId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
      });
      if (blockRes.ok) {
        console.log(`${LOG} Block success for ${profileId}`);
        success = true;
      } else {
        console.warn(`${LOG} Block also failed (${blockRes.status})`);
      }
    }
    if (success) {
      sendToBridge({ type: 'PROFILE_BLOCKED', contactId: `grindr:${profileId}`, platform: 'grindr' });
      // Remove ONLY the blocked profile's card from the DOM.
      // Find the card by matching photo hashes associated with this profileId.
      setTimeout(() => {
        // Collect all hashes that map to this profileId
        const targetHashes: string[] = [];
        for (const [hash, pid] of photoHashToProfileId.entries()) {
          if (pid === profileId) targetHashes.push(hash);
        }
        if (!targetHashes.length) return;

        // Find images matching any of the target hashes and fade their card
        let found = false;
        for (const hash of targetHashes) {
          document.querySelectorAll(`img[src*="${hash}"]`).forEach(img => {
            const card = (img as HTMLElement).closest(
              '[data-testid="cascadeCellContainer"], [class*="cascade-cell"], [class*="profile-card"]'
            );
            if (card && !found) {
              found = true;
              (card as HTMLElement).style.transition = 'opacity 0.3s';
              (card as HTMLElement).style.opacity = '0';
              setTimeout(() => { (card as HTMLElement).style.display = 'none'; }, 300);
            }
          });
          if (found) break;
        }
      }, 300);
    }
  }).catch(err => console.warn(`${LOG} Block/hide error:`, err));
}) as EventListener);

// Auto-send handler
window.addEventListener('__aggregaytor_send_message', ((event: CustomEvent) => {
  const { text } = event.detail || {};
  if (!text) return;
  console.log(`${LOG} Auto-sending:`, text.slice(0, 30));
  const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    'textarea, [contenteditable="true"], input[type="text"]'
  );
  if (!input) { console.warn(`${LOG} Chat input not found`); return; }
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSet) nativeSet.call(input, text);
  else (input as any).value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  setTimeout(() => {
    const sendBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label*="send" i], button[type="submit"], [data-testid*="send"]'
    );
    if (sendBtn) { sendBtn.click(); console.log(`${LOG} Send clicked`); }
    else console.warn(`${LOG} Send button not found`);
  }, 500);
}) as EventListener);
