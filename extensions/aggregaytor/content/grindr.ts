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

// Expose the captured Grindr auth headers on window so the service worker
// (running chrome.scripting.executeScript in world: 'MAIN') can read them
// when it needs to make an authenticated API call (e.g. enrichment pass).
// The adapter populates this via captureAuthHeaders() whenever Grindr's
// own requests fly past our network interceptor.
(window as any).__aggregaytor_get_grindr_auth = function(): Record<string, string> | null {
  return getCapturedAuth('grindr.com') || null;
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

// ── Block by React Fiber Lookup ──────────────────────────────────────────────
// Fallback path for profile cells with no picture, no /chat/ link, no data
// attributes — Grindr still has the profileId in the React component's props.
// The ISOLATED bridge tagged the clicked element with data-aggregaytor-
// fiber-lookup="<marker>"; we find that element and walk its React fiber
// tree to extract the profileId from memoizedProps / pendingProps.
window.addEventListener('__aggregaytor_block_by_fiber', ((event: CustomEvent) => {
  const { marker } = event.detail || {};
  if (!marker) return;
  const el = document.querySelector(`[data-aggregaytor-fiber-lookup="${marker}"]`) as HTMLElement | null;
  if (!el) {
    console.warn(`${LOG} Fiber lookup: marker element not found`);
    return;
  }

  // React attaches fiber references as __reactFiber$<hash> and props as
  // __reactProps$<hash>. We walk up the fiber's .return chain, inspecting
  // memoizedProps / stateNode on each ancestor until we find a numeric id.
  const findProfileIdInFiber = (startEl: HTMLElement): string => {
    const anyEl: any = startEl;
    const keys = Object.keys(anyEl).filter(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!keys.length) {
      console.warn(`${LOG} Fiber lookup: element has no React fiber attached`);
      return '';
    }
    let fiber: any = anyEl[keys[0]];
    let depth = 0;
    while (fiber && depth < 30) {
      const candidates = [fiber.memoizedProps, fiber.pendingProps, fiber.stateNode?.props, fiber.stateNode?.state];
      for (const props of candidates) {
        if (!props || typeof props !== 'object') continue;
        // Common Grindr prop shapes: { profileId }, { profile: { profileId } },
        // { item: { profileId } }, { data: { profileId } }, { id }.
        const checks = [
          props.profileId,
          props.profile?.profileId,
          props.profile?.id,
          props.item?.profileId,
          props.item?.id,
          props.data?.profileId,
          props.data?.id,
          props.user?.profileId,
          props.user?.id,
          props.id,
        ];
        for (const v of checks) {
          const s = String(v || '');
          if (/^\d{7,}$/.test(s)) return s;
        }
      }
      fiber = fiber.return;
      depth++;
    }
    return '';
  };

  const profileId = findProfileIdInFiber(el);
  if (!profileId) {
    console.warn(`${LOG} Fiber lookup: no profile id found in React tree`);
    return;
  }

  console.log(`${LOG} Fiber lookup: resolved to profileId ${profileId}`);
  window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
    detail: { profileId },
  }));
}) as EventListener);

// ── Rate-Limited Block/Hide Queue ──────────────────────────────────────────
// Grindr rate-limits block/hide calls. If you burst too many in a short
// window, Grindr invalidates your session and forces a re-login. We avoid
// that by:
//   1. Queueing all block requests and releasing one every MIN_INTERVAL_MS
//   2. Backing off exponentially on 429 / 401 / 403 responses
//   3. Pausing the queue entirely when we detect a dead session, and
//      resuming once a fresh API call succeeds (session recovered) or the
//      user re-logs in manually.
//
// For users who just want to hide profiles locally without ever calling the
// Grindr API (zero rate-limit risk), the localOnlyHide mode routes all
// block actions to the PROFILE_BLOCKED storage path only — nothing goes
// over the wire to Grindr.

const BLOCK_QUEUE_KEY = 'aggregaytor_grindr_block_settings';
interface BlockSettings {
  localOnlyHide: boolean;      // never call Grindr API, just store locally
  minIntervalMs: number;       // gap between successful calls
  maxPerHour: number;          // hard cap per rolling hour
}
const defaultBlockSettings: BlockSettings = {
  localOnlyHide: false,
  minIntervalMs: 4000,         // 4s between calls is safely under Grindr's limit
  maxPerHour: 200,             // hard cap; real limit is unknown, this is conservative
};

let blockSettings: BlockSettings = { ...defaultBlockSettings };
try {
  const raw = localStorage.getItem(BLOCK_QUEUE_KEY);
  if (raw) blockSettings = { ...blockSettings, ...JSON.parse(raw) };
} catch {}

const blockQueue: string[] = [];
const recentBlockTimestamps: number[] = []; // rolling hour window
let blockSessionDead = false;
let blockBackoffUntil = 0;
let queueProcessing = false;

function showGrindrToast(text: string, kind: 'ok' | 'warn' | 'err' = 'warn'): void {
  try {
    const ID = 'aggregaytor-grindr-toast';
    document.getElementById(ID)?.remove();
    const toast = document.createElement('div');
    toast.id = ID;
    const bg = kind === 'ok' ? 'rgba(34,197,94,0.95)'
      : kind === 'err' ? 'rgba(220,38,38,0.95)'
      : 'rgba(234,179,8,0.95)';
    toast.style.cssText =
      `position:fixed;bottom:20px;right:20px;z-index:999999;max-width:340px;` +
      `background:${bg};color:#fff;padding:10px 14px;border-radius:8px;` +
      `font-family:system-ui,sans-serif;font-size:12px;line-height:1.4;` +
      `box-shadow:0 4px 12px rgba(0,0,0,0.4);transition:opacity 0.3s`;
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, 4500);
    setTimeout(() => toast.remove(), 5000);
  } catch {}
}

function removeBlockedCardFromDom(profileId: string): void {
  setTimeout(() => {
    const targetHashes: string[] = [];
    for (const [hash, pid] of photoHashToProfileId.entries()) {
      if (pid === profileId) targetHashes.push(hash);
    }
    if (!targetHashes.length) return;
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

/** Attempt a single block/hide call. Returns {ok, status, sessionDead}. */
async function attemptBlock(profileId: string, auth: Record<string, string>): Promise<{ ok: boolean; status: number; sessionDead: boolean }> {
  try {
    // credentials: 'include' is critical — Grindr's session cookies must be
    // sent alongside any Authorization header, otherwise the API rejects
    // even a valid bearer token with a 401. This was silently broken in the
    // v0.57.0 rewrite and is why middle-click appeared to stop working.
    const res = await fetch(`https://web.grindr.com/api/v1/me/hides/${profileId}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...auth },
    });
    if (res.ok) return { ok: true, status: res.status, sessionDead: false };
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, sessionDead: true };
    if (res.status === 429) return { ok: false, status: res.status, sessionDead: false };
    // Fallback to block API
    const b = await fetch(`https://web.grindr.com/api/v3/me/blocks/${profileId}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...auth },
    });
    if (b.ok) return { ok: true, status: b.status, sessionDead: false };
    if (b.status === 401 || b.status === 403) return { ok: false, status: b.status, sessionDead: true };
    return { ok: false, status: b.status, sessionDead: false };
  } catch (err) {
    console.warn(`${LOG} Block network error:`, err);
    return { ok: false, status: 0, sessionDead: false };
  }
}

async function processBlockQueue(): Promise<void> {
  if (queueProcessing) return;
  queueProcessing = true;
  try {
    while (blockQueue.length) {
      // Respect backoff window
      const waitMs = Math.max(0, blockBackoffUntil - Date.now());
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));

      // Session dead? We used to hard-break here, which meant any single
      // stale 401 (e.g. from a mid-run enrichment pass) permanently paused
      // middle-click blocking until the user saved credentials and got
      // auto-logged back in. That was a footgun — often the session
      // wasn't actually dead and a retry would have worked. Now: try once
      // more with fresh auth; if it works, clear the flag and carry on.
      if (blockSessionDead) {
        console.log(`${LOG} Session-dead flag set; trying one canary call to see if it's actually dead.`);
        // Fall through into the normal call path below — if it 401s again
        // the dead flag stays set and we'll break; if it works, the ok
        // branch clears it.
      }

      // Rolling-hour cap
      const hourAgo = Date.now() - 3600_000;
      while (recentBlockTimestamps.length && recentBlockTimestamps[0] < hourAgo) {
        recentBlockTimestamps.shift();
      }
      if (recentBlockTimestamps.length >= blockSettings.maxPerHour) {
        const waitUntil = recentBlockTimestamps[0] + 3600_000;
        const w = waitUntil - Date.now();
        console.warn(`${LOG} Hourly block cap (${blockSettings.maxPerHour}) hit, waiting ${Math.round(w / 60000)}m`);
        showGrindrToast(`Grindr block cap reached. Pausing ${Math.round(w / 60000)} min to avoid forced logout.`, 'warn');
        await new Promise(r => setTimeout(r, Math.min(w, 60_000))); // re-check every minute
        continue;
      }

      const profileId = blockQueue.shift()!;
      const auth = getCapturedAuth('grindr.com');
      if (!auth) {
        // Don't drop the click. Put the id BACK on the queue and wait for
        // the adapter to capture auth from Grindr's own traffic. We poll
        // once per second and resume as soon as it's available.
        blockQueue.unshift(profileId);
        console.warn(`${LOG} No captured auth yet — waiting for page to issue an API call. ${blockQueue.length} queued.`);
        showGrindrToast('Capturing Grindr auth… (scroll the cascade)', 'warn');
        // Poll for up to 60s
        let waited = 0;
        while (waited < 60_000 && !getCapturedAuth('grindr.com')) {
          await new Promise(r => setTimeout(r, 1000));
          waited += 1000;
        }
        if (!getCapturedAuth('grindr.com')) {
          console.warn(`${LOG} Gave up after 60s of no auth capture; queue retained for next time.`);
          break;
        }
        continue; // loop around and try again with fresh auth
      }

      const result = await attemptBlock(profileId, auth);
      recentBlockTimestamps.push(Date.now());

      if (result.ok) {
        console.log(`${LOG} Hide/block ok for ${profileId}`);
        sendToBridge({ type: 'PROFILE_BLOCKED', contactId: `grindr:${profileId}`, platform: 'grindr' });
        removeBlockedCardFromDom(profileId);
        // Any successful call proves the session is alive — clear the
        // dead-session flag so a previous stale 401 doesn't keep
        // blocking the queue forever.
        if (blockSessionDead) {
          console.log(`${LOG} Canary succeeded — clearing session-dead flag.`);
          blockSessionDead = false;
          blockBackoffUntil = 0;
        }
      } else if (result.sessionDead) {
        blockSessionDead = true;
        // Put this profileId back on the queue so we retry after session recovery
        blockQueue.unshift(profileId);
        console.warn(`${LOG} Session dead (${result.status}). ${blockQueue.length} pending.`);
        showGrindrToast(
          `Grindr forced a re-login (${result.status}). ${blockQueue.length} block(s) paused until you're logged back in.`,
          'err',
        );
        watchForLoginForm(); // starts watching for re-login UI
        break;
      } else if (result.status === 429) {
        // Rate limited — exponential backoff, keep item on queue
        blockQueue.unshift(profileId);
        blockBackoffUntil = Date.now() + 30_000;
        console.warn(`${LOG} 429 rate limited — backing off 30s`);
        showGrindrToast('Grindr rate-limited. Backing off 30s…', 'warn');
      } else {
        console.warn(`${LOG} Block failed (${result.status}) for ${profileId} — dropping`);
      }

      // Gap between successful calls — slow and steady
      if (result.ok) {
        await new Promise(r => setTimeout(r, blockSettings.minIntervalMs));
      }
    }
  } finally {
    queueProcessing = false;
  }
}

function enqueueBlock(profileId: string): void {
  if (blockQueue.includes(profileId)) return; // dedupe
  blockQueue.push(profileId);
  processBlockQueue();
}

window.addEventListener('__aggregaytor_block_profile', ((event: CustomEvent) => {
  const { profileId } = event.detail || {};
  if (!profileId) return;

  // Local-only mode: never touch Grindr's API. Just mark the profile blocked
  // in our storage and hide the card visually. Zero rate-limit risk.
  if (blockSettings.localOnlyHide) {
    console.log(`${LOG} Local-only hide for ${profileId}`);
    sendToBridge({ type: 'PROFILE_BLOCKED', contactId: `grindr:${profileId}`, platform: 'grindr' });
    removeBlockedCardFromDom(profileId);
    return;
  }

  enqueueBlock(profileId);
}) as EventListener);

// Manual recovery hook — from DevTools console on the Grindr tab:
//   __aggregaytor_grindr_reset_queue()
// Use when you KNOW you're logged in but the queue got wedged thinking
// the session was dead. Clears all gating state and re-kicks processing.
(window as any).__aggregaytor_grindr_reset_queue = function(): void {
  console.log(`${LOG} Manual reset: clearing session-dead flag & backoff. ${blockQueue.length} queued.`);
  blockSessionDead = false;
  blockBackoffUntil = 0;
  processBlockQueue();
};

// Expose a settings-update hook so the side panel / settings UI can flip
// localOnlyHide and the rate-limit parameters at runtime.
window.addEventListener('__aggregaytor_grindr_block_settings', ((event: CustomEvent) => {
  const update = event.detail || {};
  blockSettings = { ...blockSettings, ...update };
  try { localStorage.setItem(BLOCK_QUEUE_KEY, JSON.stringify(blockSettings)); } catch {}
  console.log(`${LOG} Block settings updated:`, blockSettings);
}) as EventListener);

// ── Grindr Login Form Detection + Auto-Fill ────────────────────────────────
// When Grindr forces a re-login (either from inactivity or from too many
// block calls), we want to help the user get back in without them having
// to remember to re-type creds. This watcher looks for the login form
// markers, and if the user has opted in to auto-login (via settings), fills
// in the fields from stored credentials and clicks submit.
//
// Credentials are stored by the side panel in chrome.storage.local under
// aggregaytor_grindr_credentials, encrypted with the user's passphrase.
// We ask the service worker to decrypt them on demand — raw creds never
// live in content-script memory except during the brief fill operation.

let loginWatchObserver: MutationObserver | null = null;
let loginFillInFlight = false;

function isLoginScreen(): boolean {
  // Grindr's login page varies. Check several markers.
  if (/\/login|\/signin|\/auth/i.test(location.pathname)) return true;
  const emailEl = document.querySelector(
    'input[type="email"], input[name="email"], input[id*="email" i], ' +
    'input[autocomplete="email"], input[autocomplete="username"], ' +
    'input[placeholder*="email" i], input[name="username"], input[id*="username" i]',
  );
  const pwEl = document.querySelector('input[type="password"]');
  return !!(emailEl && pwEl && document.body.contains(emailEl) && document.body.contains(pwEl));
}

async function attemptAutoFill(): Promise<void> {
  if (loginFillInFlight) return;
  loginFillInFlight = true;
  try {
    // Ask the service worker for decrypted credentials (returns null if
    // user hasn't enabled auto-login or if decryption fails).
    const response: any = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_GRINDR_CREDENTIALS' }, (r: any) => resolve(r || null));
      } catch { resolve(null); }
    });
    const creds = response?.credentials;
    if (!creds?.username || !creds?.password) {
      console.log(`${LOG} Auto-login: no stored credentials`);
      showGrindrToast('Grindr logged you out. Save credentials in Settings → Sync to auto-login next time.', 'warn');
      return;
    }

    // Find the fields
    const emailEl = document.querySelector<HTMLInputElement>(
      'input[type="email"], input[name="email"], input[id*="email" i], ' +
      'input[autocomplete="email"], input[autocomplete="username"], ' +
      'input[name="username"]',
    );
    const pwEl = document.querySelector<HTMLInputElement>('input[type="password"]');
    if (!emailEl || !pwEl) return;

    // Fill using native value setters (React compatibility)
    const setVal = (el: HTMLInputElement, v: string) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    emailEl.focus(); setVal(emailEl, creds.username);
    pwEl.focus(); setVal(pwEl, creds.password);
    console.log(`${LOG} Auto-login fields filled`);
    showGrindrToast('Auto-filled Grindr login — submitting…', 'ok');

    // Find and click submit
    await new Promise(r => setTimeout(r, 400));
    const submit = pwEl.closest('form')?.querySelector<HTMLButtonElement>('button[type="submit"], button')
      || document.querySelector<HTMLButtonElement>('button[type="submit"]')
      || Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find(b => /sign ?in|log ?in|continue/i.test(b.textContent || ''))
      || null;
    if (submit && !submit.disabled) {
      submit.click();
      console.log(`${LOG} Auto-login submitted`);
    } else {
      // Fallback: Enter key on password field
      pwEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }

    // After a successful login, the session is revived. Clear the dead flag
    // so queued blocks resume. We optimistically clear after 8s; if auth is
    // still missing then, the next block call will detect it.
    setTimeout(() => {
      if (!isLoginScreen()) {
        console.log(`${LOG} Login appears successful — resuming block queue`);
        blockSessionDead = false;
        blockBackoffUntil = 0;
        processBlockQueue();
      }
    }, 8000);
  } catch (err) {
    console.warn(`${LOG} Auto-login error:`, err);
  } finally {
    loginFillInFlight = false;
  }
}

function watchForLoginForm(): void {
  // Debounce via existing observer
  if (loginWatchObserver) return;
  // Immediate check
  if (isLoginScreen()) { attemptAutoFill(); }
  // DOM mutation watcher for SPA transitions back to the login screen
  loginWatchObserver = new MutationObserver(() => {
    if (isLoginScreen()) {
      // Disconnect the observer while we fill to avoid re-trigger loops
      loginWatchObserver?.disconnect();
      loginWatchObserver = null;
      attemptAutoFill();
      // After a minute, re-enable watching in case we need another attempt
      setTimeout(() => watchForLoginForm(), 60_000);
    }
  });
  loginWatchObserver.observe(document.body, { childList: true, subtree: true });
}

// Start watching immediately on page load — covers the case where the user
// arrives at grindr.com already logged out.
watchForLoginForm();

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
