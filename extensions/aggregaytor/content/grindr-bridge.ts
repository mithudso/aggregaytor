/**
 * grindr-bridge.ts — ISOLATED world bridge for Grindr Web.
 */

import { showFloatingPanel, hideFloatingPanel } from './floating-actions.js';

const LOG = '[Aggregaytor:Bridge:Grindr]';

// v0.57.44: forward bridge errors to the SW's rolling error log.
function _forwardError(level: 'unhandled' | 'rejection' | 'error', message: string, stack?: string): void {
  try {
    chrome.runtime.sendMessage({
      type: 'LOG_ERROR',
      entry: { source: 'bridge:grindr', level, message, stack, url: location.href },
    }).catch(() => {});
  } catch {}
}
window.addEventListener('error', (ev) => {
  _forwardError('unhandled', ev.message || String(ev.error || 'unknown error'),
    (ev.error && (ev.error as Error).stack) || undefined);
});
window.addEventListener('unhandledrejection', (ev) => {
  const r: any = ev.reason;
  _forwardError('rejection',
    typeof r === 'string' ? r : (r?.message || String(r)),
    r?.stack);
});
let contextValid = true;
const MAIN_WORLD_RESPONSE_EVENT = '__aggregaytor_grindr_bridge_response';

function checkContext(): boolean {
  try { void chrome.runtime.id; return true; }
  catch { if (contextValid) { console.warn(`${LOG} Context invalidated`); contextValid = false; } return false; }
}

function relayMainWorldRequest(
  eventType: string,
  detail: Record<string, unknown>,
  sendResponse: (response?: unknown) => void,
  timeoutMs = 120_000,
): true {
  const requestId = `${eventType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  let settled = false;
  let timer = 0;
  const cleanup = () => {
    if (timer) window.clearTimeout(timer);
    window.removeEventListener(MAIN_WORLD_RESPONSE_EVENT, onResponse as EventListener);
  };
  const onResponse = (event: CustomEvent) => {
    if (event.detail?.requestId !== requestId) return;
    settled = true;
    cleanup();
    sendResponse(event.detail.payload || { ok: false, error: 'empty-response' });
  };
  window.addEventListener(MAIN_WORLD_RESPONSE_EVENT, onResponse as EventListener);
  timer = window.setTimeout(() => {
    if (settled) return;
    cleanup();
    sendResponse({ ok: false, error: 'timeout' });
  }, timeoutMs);
  window.dispatchEvent(new CustomEvent(eventType, { detail: { requestId, ...detail } }));
  return true;
}

// Trust boundary: `__aggregaytor_message` is a plain window CustomEvent, so
// ANY script on web.grindr.com (including injected/third-party ones) can forge
// it — not just content/grindr.js. Relaying `detail` verbatim would let the
// page reach every case of the service worker's message switch. Only the
// message types content/grindr.js actually emits are forwarded.
const GRINDR_RELAY_TYPES = new Set(['ADAPTER_MESSAGES', 'ADAPTER_CONTACTS', 'PROFILE_BLOCKED']);

window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail || typeof detail.type !== 'string') return;
  if (!GRINDR_RELAY_TYPES.has(detail.type)) {
    console.warn(`${LOG} Dropped relay message with unexpected type: ${detail.type.slice(0, 40)}`);
    return;
  }
  try { chrome.runtime.sendMessage(detail).catch(() => {}); }
  catch { contextValid = false; }
}) as EventListener);

try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SPA_NAVIGATE') {
      try {
        const path = message.path || new URL(message.url).pathname;
        window.history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
        setTimeout(() => {
          const link = document.querySelector(`a[href="${path}"], a[href*="${path}"]`) as HTMLAnchorElement;
          if (link) link.click();
        }, 500);
      } catch { window.location.href = message.url; }
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'SEND_AUTO_RESPONSE') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
        detail: { text: message.text, contactId: message.contactId },
      }));
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'GRINDR_FILTER_SETTINGS') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_grindr_filter_settings', {
        detail: message.settings,
      }));
      try { localStorage.setItem('aggregaytor_grindr_filter_settings', JSON.stringify(message.settings)); } catch {}
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'SET_LOG_LEVEL') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_set_log_level', { detail: message.level }));
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'TEXT_EXPANDER_SETTINGS') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_text_expander_settings', {
        detail: { substitutions: message.substitutions },
      }));
      try { localStorage.setItem('aggregaytor_text_substitutions', JSON.stringify(message.substitutions)); } catch {}
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'SHOW_FLOATING_PANEL') {
      showFloatingPanel(message.contactId, message.platform || 'grindr');
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'GRINDR_IMPORT_TRAINING_DATA') {
      return relayMainWorldRequest('__aggregaytor_grindr_import_request', {}, sendResponse);
    }
    if (message.type === 'GRINDR_FETCH_PROFILES') {
      return relayMainWorldRequest('__aggregaytor_grindr_profile_fetch_request', {
        batch: message.batch,
        delayMs: message.delayMs,
        jitterMs: message.jitterMs,
      }, sendResponse);
    }
    if (message.type === 'SCRAPE_AVATARS') {
      let count = 0;
      // Grindr profile images are <img> elements in the grid/chat
      document.querySelectorAll('img[src*="cdns.grindr.com"], img[src*="grindr"]').forEach(img => {
        const src = (img as HTMLImageElement).src;
        if (!src || !src.startsWith('http')) return;
        // Try to find the associated profile ID from nearby elements or URL
        const container = img.closest('[data-profile-id], [data-conversation-id], a[href*="/chat/"]');
        const profileId = container?.getAttribute('data-profile-id')
          || container?.getAttribute('data-conversation-id')
          || container?.getAttribute('href')?.match(/\/chat\/([^/?#]+)/)?.[1]
          || '';
        if (!profileId) return;
        chrome.runtime.sendMessage({
          type: 'ADAPTER_CONTACTS',
          platform: 'grindr',
          payload: [{
            id: `grindr:${profileId}`,
            platform: 'grindr',
            platformUserId: profileId,
            displayName: '',
            profileUrl: `https://web.grindr.com/chat/${profileId}`,
            avatarUrl: src,
            lastSeen: new Date().toISOString(),
            metadata: {},
          }],
        }).catch(() => {});
        count++;
      });
      sendResponse({ ok: true, count });
      return true;
    }
    return false;
  });
} catch { contextValid = false; }

// ── Middle-click / Shift+right-click to block ────────────────────────────
// Middle-click (button 2 = auxclick, button 1 = mousedown) on a profile
// element extracts the profile ID and dispatches a block request to the
// MAIN world, which has the captured Grindr JWT for API calls.
//
// Shift+right-click is the trackpad-friendly equivalent: trackpads can't
// produce a middle-click, so users with no mouse get the same gesture by
// holding Shift while right-clicking. Both events fire `attemptBlock`,
// which calls e.preventDefault() inside any strategy that succeeds —
// strategies that bail out leave the default (new-tab / context menu)
// alone so unrelated clicks aren't hijacked.
function attemptBlock(e: MouseEvent): void {
  if (!contextValid || !checkContext()) return;

  const target = e.target as HTMLElement;

  // Strategy 0: Check if we're on a profile view page — the URL or query
  // params contain the profile ID directly (most reliable source).
  // Grindr URLs: /chat/{profileId}, /?profile=true with profileId in URL
  const urlMatch = location.href.match(/\/chat\/(\d{6,})/);
  const profileParam = new URLSearchParams(location.search).get('profileId');
  if (urlMatch || profileParam) {
    const urlProfileId = urlMatch?.[1] || profileParam || '';
    if (urlProfileId && /^\d+$/.test(urlProfileId)) {
      e.preventDefault();
      console.log(`${LOG} Middle-click block from URL: ${urlProfileId}`);
      window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
        detail: { profileId: urlProfileId },
      }));
      chrome.runtime.sendMessage({
        type: 'PROFILE_BLOCKED', contactId: `grindr:${urlProfileId}`, platform: 'grindr',
      }).catch(() => {});
      return;
    }
  }

  // Find the nearest profile container — Grindr's cascade grid uses
  // data-testid="cascadeCellContainer" on each profile card.
  // v0.57.47: broaden the selector list because Grindr's DOM keeps
  // drifting (we'd silently hit `return` whenever none of these matched).
  let profileEl = target.closest(
    '[data-testid="cascadeCellContainer"], [data-profile-id], [data-conversation-id], ' +
    'a[href*="/chat/"], [class*="profile-card"], [class*="cascade-item"], ' +
    '[class*="profile-detail"], [class*="ProfileView"], [data-testid*="profile"], ' +
    '[class*="cascade-cell" i], [class*="cascade-grid" i] > div, ' +
    '[class*="cascade" i] [class*="cell" i], [class*="profile-tile" i], ' +
    '[role="article"][class*="profile" i], [data-testid*="cascade" i], ' +
    '[data-testid*="cell" i], [data-testid*="profileTile" i]'
  ) as HTMLElement | null;

  // Walk-up fallback — any clicked element that contains a Grindr CDN
  // photo URL is almost certainly inside a profile card. Walk up until
  // we find a container with reasonable dimensions (>=80x80) so we
  // don't pick the bare img tag.
  if (!profileEl) {
    let node: HTMLElement | null = target;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      const html = node.outerHTML || '';
      if (/cdns?\.grindr\.com\/images\/profile/i.test(html) || /\.cloudfront\.net\/profile/i.test(html)) {
        const r = node.getBoundingClientRect();
        if (r.width >= 80 && r.height >= 80) { profileEl = node; break; }
      }
    }
  }

  if (!profileEl) {
    // Diagnostic — surfaces in the v0.57.44 error log so we can see when
    // every selector misses on a fresh Grindr DOM revision.
    console.warn(`${LOG} Middle-click: no profile container matched. target=${target.tagName}.${target.className?.toString().slice(0, 60)} url=${location.href}`);
    return;
  }

  // Extract profile ID — Grindr's DOM doesn't expose IDs directly, but
  // profile card images use CDN URLs with the photo hash:
  //   https://cdns.grindr.com/images/profile/1024x1024/{hash}
  // The MAIN world adapter builds a photoHash→profileId map from API data.
  // We extract the hash from the <img> src and look up the profile ID.

  // Strategy 1: data-profile-id attribute (rare but possible)
  let profileId = profileEl.getAttribute('data-profile-id')
    || profileEl.getAttribute('data-conversation-id')
    || '';

  // Strategy 2: /chat/ link href
  if (!profileId) {
    const link = profileEl.querySelector('a[href*="/chat/"]') || profileEl.closest('a[href*="/chat/"]');
    const href = link?.getAttribute('href') || '';
    const match = href.match(/\/chat\/([^/?#]+)/);
    if (match) profileId = match[1];
  }

  // Strategy 3: Extract photo hash from img src → dispatch to MAIN world
  // for profileId lookup via the photoHash→profileId map built from API data.
  // Since bridge (ISOLATED) can't access MAIN world variables, we dispatch
  // a CustomEvent with the photo hash and let the MAIN world handle the block.
  if (!profileId) {
    const img = profileEl.querySelector('img[src*="cdns.grindr.com"]') || target.closest('img');
    if (img) {
      const src = img.getAttribute('src') || '';
      const hashMatch = src.match(/\/([a-f0-9]{32,})/i);
      if (hashMatch) {
        console.log(`${LOG} Middle-click: dispatching block-by-hash for ${hashMatch[1].slice(0, 12)}...`);
        // Send hash to MAIN world — it will look up the profileId and call the block API
        window.dispatchEvent(new CustomEvent('__aggregaytor_block_by_hash', {
          detail: { photoHash: hashMatch[1] },
        }));
        // Visual feedback
        const orig = (profileEl as HTMLElement).style.opacity;
        (profileEl as HTMLElement).style.opacity = '0.3';
        setTimeout(() => { (profileEl as HTMLElement).style.opacity = orig || ''; }, 500);
        e.preventDefault();
        return;
      }
    }
  }

  // Strategy 4: scan every attribute on the cell and its descendants for a
  // numeric profile id. Grindr sometimes embeds profileId in data-testid,
  // aria-label, id, or similar attributes on the card even without a picture.
  if (!profileId) {
    const candidates = [profileEl, ...profileEl.querySelectorAll('*')];
    for (const el of candidates) {
      for (const attr of Array.from((el as Element).attributes || [])) {
        const m = String(attr.value || '').match(/(?<![0-9])([0-9]{7,})(?![0-9])/);
        if (m) { profileId = m[1]; break; }
      }
      if (profileId) break;
    }
  }

  // Strategy 5 (last resort — picture-less cells): let the MAIN world walk
  // React's fiber tree to pull the profileId from component props. ISOLATED
  // world can't read __reactFiber$... properties because React attaches them
  // via MAIN-world JS. We tag the element with a one-shot marker attr and
  // fire an event; MAIN world finds the element and handles the block.
  if (!profileId) {
    const marker = `fiber-lookup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    (profileEl as HTMLElement).setAttribute('data-aggregaytor-fiber-lookup', marker);
    console.log(`${LOG} Middle-click: dispatching React fiber lookup (marker=${marker})`);
    window.dispatchEvent(new CustomEvent('__aggregaytor_block_by_fiber', {
      detail: { marker },
    }));
    // Visual feedback
    const orig = (profileEl as HTMLElement).style.opacity;
    (profileEl as HTMLElement).style.opacity = '0.3';
    setTimeout(() => {
      (profileEl as HTMLElement).style.opacity = orig || '';
      // Leave the marker in place for ~2s so MAIN world has time to find it
      setTimeout(() => (profileEl as HTMLElement).removeAttribute('data-aggregaytor-fiber-lookup'), 2000);
    }, 500);
    e.preventDefault();
    return;
  }

  if (!profileId || !/^\d+$/.test(profileId)) {
    console.log(`${LOG} Middle-click: could not extract profile ID from element`);
    return;
  }

  e.preventDefault();
  console.log(`${LOG} Middle-click block on profile: ${profileId}`);

  // Dispatch to MAIN world for API call (has captured auth headers)
  window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
    detail: { profileId },
  }));

  // Visual feedback: briefly flash the element
  const orig = (profileEl as HTMLElement).style.opacity;
  (profileEl as HTMLElement).style.opacity = '0.3';
  setTimeout(() => { (profileEl as HTMLElement).style.opacity = orig || ''; }, 500);

  // Also tell the service worker to mark as blocked in the aggregator
  chrome.runtime.sendMessage({
    type: 'PROFILE_BLOCKED',
    contactId: `grindr:${profileId}`,
    platform: 'grindr',
  }).catch(() => {});
}

// v0.57.47: redundant `mousedown` + `auxclick` capture for middle-click. Some
// Chrome builds + trackpad gesture configs DO fire mousedown (button:1) but
// suppress the matching auxclick — the user's "doesn't work anymore" report.
// Capturing both events behind one shared dedupe window means we catch
// whichever fires; if both fire we run the handler exactly once.
//
// The dedupe check has to live in BOTH handlers. It previously guarded only
// `mousedown` while a separate auxclick listener merely re-stamped the
// timestamp — so a normal mouse (mousedown *then* auxclick) ran attemptBlock
// twice, double-dispatching __aggregaytor_block_profile and sending two
// PROFILE_BLOCKED messages per click.
const MIDDLE_CLICK_DEDUPE_MS = 150;
let _grindrLastMiddleAt = 0;

function onMiddleClick(e: MouseEvent): void {
  if (e.button !== 1) return; // middle-click only
  if (Date.now() - _grindrLastMiddleAt < MIDDLE_CLICK_DEDUPE_MS) return;
  _grindrLastMiddleAt = Date.now();
  attemptBlock(e);
}

document.addEventListener('mousedown', onMiddleClick, true);
document.addEventListener('auxclick', onMiddleClick, true);

// Shift+right-click — trackpad-friendly equivalent of middle-click. Only
// suppresses the native context menu when a strategy actually fired
// e.preventDefault() inside attemptBlock; plain right-clicks (no Shift)
// behave normally.
document.addEventListener('contextmenu', (e) => {
  if (!e.shiftKey) return;
  attemptBlock(e);
}, true);

// ── Session Keepalive ─────────────────────────────────────────────────────
// Grindr aggressively logs out after inactivity. This keepalive prevents
// that by periodically triggering a lightweight action that refreshes the
// session. We simulate minimal activity to keep the auth token alive.
let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

let keepaliveSkipCount = 0;

function startSessionKeepalive(): void {
  if (keepaliveInterval) return;
  keepaliveInterval = setInterval(() => {
    if (!contextValid) return;
    if (document.hidden) {
      keepaliveSkipCount++;
      if (keepaliveSkipCount < 3) return;
      keepaliveSkipCount = 0;
    }
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));

      fetch('https://web.grindr.com/api/v3/me', {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      }).catch(() => {});
    } catch {}
  }, 4 * 60_000);
}

startSessionKeepalive();

// Watch for URL changes (user opening conversations on Grindr web)
let lastUrl = location.href;
function checkUrlChange() {
  if (!contextValid) return;
  const url = location.href;
  if (url === lastUrl) return;
  lastUrl = url;
  // Grindr URL: /chat/{conversationId}
  const match = url.match(/\/chat\/([^/?#]+)/i);
  if (match) {
    const contactId = `grindr:${match[1]}`;
    try {
      chrome.runtime.sendMessage({ type: 'ACTIVE_PROFILE_CHANGED', contactId, platform: 'grindr' }).catch(() => {});
    } catch {}
  }
}
setInterval(checkUrlChange, 3000);
window.addEventListener('popstate', checkUrlChange);

if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/grindr.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
