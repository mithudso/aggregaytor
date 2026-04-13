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
  const hash = String(obj.photoHash || obj.profileImageMediaHash || obj.mediahash || obj.primaryPhotoHash || '');
  if (pid && /^\d+$/.test(pid) && hash) {
    photoHashToProfileId.set(hash, pid);
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

  // Try block API first (POST /v3/me/blocks/{profileId}),
  // fall back to hide (POST /v1/hides/{profileId})
  fetch(`https://web.grindr.com/v3/me/blocks/${profileId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({}),
  }).then(async (res) => {
    if (res.ok) {
      console.log(`${LOG} Block success for ${profileId}`);
      sendToBridge({ type: 'PROFILE_BLOCKED', contactId: `grindr:${profileId}`, platform: 'grindr' });
      return;
    }
    console.warn(`${LOG} Block failed (${res.status}), trying hide API...`);
    const hideRes = await fetch(`https://web.grindr.com/v1/hides/${profileId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({}),
    });
    if (hideRes.ok) {
      console.log(`${LOG} Hide success for ${profileId}`);
      sendToBridge({ type: 'PROFILE_BLOCKED', contactId: `grindr:${profileId}`, platform: 'grindr' });
    } else {
      console.warn(`${LOG} Hide also failed (${hideRes.status})`);
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
