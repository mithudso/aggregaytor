/**
 * grindr.ts — MAIN world content script for web.grindr.com.
 *
 * Runs in page context to intercept fetch/XHR/WebSocket.
 * Communicates with ISOLATED world bridge via CustomEvents.
 */

import { GrindrAdapter } from '@aggregaytor/adapter-grindr';
import { getCapturedAuth } from '@aggregaytor/adapter-core';

const LOG = '[Aggregaytor:Grindr]';

// ── Profile ID ↔ Photo Hash Map ─────────────────────────────────────────────
// Grindr's cascade grid doesn't expose profile IDs in the DOM. But the API
// responses that populate the grid DO contain profileId + photoHash pairs.
// We build a map of photoHash → profileId from intercepted API data, then
// when the user middle-clicks a profile card, we extract the photoHash from
// the <img> src URL and look up the profileId.
const photoHashToProfileId = new Map<string, string>();

function indexProfileFromPayload(obj: Record<string, unknown>): void {
  const pid = String(obj.profileId || obj.profileID || '');
  if (!pid || !/^\d+$/.test(pid)) return;

  // Index the primary photo hash
  const hash = String(obj.photoHash || obj.profileImageMediaHash || obj.mediahash || obj.primaryPhotoHash || '');
  if (hash && hash !== 'undefined' && hash !== 'null') {
    photoHashToProfileId.set(hash, pid);
  }

  // Also index all hashes from the medias array — Grindr stores additional
  // photos here, and profileImageMediaHash is often null while medias[0]
  // contains the actual display photo hash used in the cascade grid img src.
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
window.addEventListener('__aggregaytor_block_by_hash', ((event: CustomEvent) => {
  const { photoHash } = event.detail || {};
  if (!photoHash) return;
  const profileId = photoHashToProfileId.get(photoHash);
  if (!profileId) {
    console.warn(`${LOG} No profile ID found for hash ${photoHash.slice(0, 12)}... (map has ${photoHashToProfileId.size} entries)`);
    return;
  }
  console.log(`${LOG} Resolved hash → profileId: ${profileId}`);
  // Dispatch the standard block event
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
      // Remove the hidden profile's card from the DOM directly instead of
      // refreshing the entire cascade (which caused Grindr's service worker
      // to throw fetch errors from the pushState navigation trick).
      // Find and fade out the card element containing the blocked profile's image.
      setTimeout(() => {
        document.querySelectorAll(`img[src*="${profileId}"], img[src*="cdns.grindr.com"]`).forEach(img => {
          const card = (img as HTMLElement).closest('[data-testid="cascadeCellContainer"], [class*="cascade"], [class*="profile-card"]');
          if (card) {
            (card as HTMLElement).style.transition = 'opacity 0.3s, height 0.3s';
            (card as HTMLElement).style.opacity = '0';
            setTimeout(() => { (card as HTMLElement).style.display = 'none'; }, 300);
          }
        });
        // Also try to find by the photo hash that triggered the block
        const hashToFind = photoHashToProfileId.entries();
        for (const [hash, pid] of hashToFind) {
          if (pid === profileId) {
            document.querySelectorAll(`img[src*="${hash}"]`).forEach(img => {
              const card = (img as HTMLElement).closest('[data-testid="cascadeCellContainer"], [class*="cascade"], [class*="profile-card"]');
              if (card) {
                (card as HTMLElement).style.transition = 'opacity 0.3s';
                (card as HTMLElement).style.opacity = '0';
                setTimeout(() => { (card as HTMLElement).style.display = 'none'; }, 300);
              }
            });
          }
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
