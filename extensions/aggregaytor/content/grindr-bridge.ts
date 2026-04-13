/**
 * grindr-bridge.ts — ISOLATED world bridge for Grindr Web.
 */

const LOG = '[Aggregaytor:Bridge:Grindr]';
let contextValid = true;

function checkContext(): boolean {
  try { void chrome.runtime.id; return true; }
  catch { if (contextValid) { console.warn(`${LOG} Context invalidated`); contextValid = false; } return false; }
}

window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail?.type) return;
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
    if (message.type === 'TEXT_EXPANDER_SETTINGS') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_text_expander_settings', {
        detail: { substitutions: message.substitutions },
      }));
      try { localStorage.setItem('aggregaytor_text_substitutions', JSON.stringify(message.substitutions)); } catch {}
      sendResponse({ ok: true });
      return true;
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

// ── Middle-click to block ─────────────────────────────────────────────────
// Middle-click (button 2 = auxclick, button 1 = mousedown) on a profile
// element extracts the profile ID and dispatches a block request to the
// MAIN world, which has the captured Grindr JWT for API calls.
document.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return; // middle-click only
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
  // data-testid="cascadeCellContainer" on each profile card
  const profileEl = target.closest(
    '[data-testid="cascadeCellContainer"], [data-profile-id], [data-conversation-id], ' +
    'a[href*="/chat/"], [class*="profile-card"], [class*="cascade-item"], ' +
    '[class*="profile-detail"], [class*="ProfileView"], [data-testid*="profile"]'
  );
  if (!profileEl) return;

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
        return;
      }
    }
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
}, true);

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
