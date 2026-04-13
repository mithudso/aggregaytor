/**
 * adam4adam-bridge.ts — ISOLATED world bridge for Adam4Adam.
 *
 * Relays adapter events from MAIN world to service worker, handles
 * service worker commands (auto-send, avatar scraping, settings relay),
 * and injects the MAIN world script.
 */

const LOG = '[Aggregaytor:Bridge:A4A]';
let contextValid = true;

function checkContext(): boolean {
  try { void chrome.runtime.id; return true; }
  catch { if (contextValid) { console.warn(`${LOG} Context invalidated`); contextValid = false; } return false; }
}

// Relay MAIN world adapter events to service worker
window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail?.type) return;
  try { chrome.runtime.sendMessage(detail).catch(() => {}); }
  catch { contextValid = false; }
}) as EventListener);

try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Auto-send response (from auto-respond or quick phrases)
    if (message.type === 'SEND_AUTO_RESPONSE') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
        detail: { text: message.text, contactId: message.contactId },
      }));
      sendResponse({ ok: true });
      return true;
    }

    // SPA navigation
    if (message.type === 'SPA_NAVIGATE') {
      try {
        window.location.href = message.url;
      } catch {}
      sendResponse({ ok: true });
      return true;
    }

    // Text expander settings relay
    if (message.type === 'TEXT_EXPANDER_SETTINGS') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_text_expander_settings', {
        detail: { substitutions: message.substitutions },
      }));
      try { localStorage.setItem('aggregaytor_text_substitutions', JSON.stringify(message.substitutions)); } catch {}
      sendResponse({ ok: true });
      return true;
    }

    // Avatar scraping — find profile photos in the DOM
    if (message.type === 'SCRAPE_AVATARS') {
      let count = 0;
      // A4A profile photos: look for img elements with profile photo URLs
      document.querySelectorAll('img[src*="adam4adam"], img[src*="a4a"], .avatar img, .profile-photo img, [class*="avatar"] img, [class*="photo"] img').forEach(img => {
        const src = (img as HTMLImageElement).src;
        if (!src || !src.startsWith('http')) return;
        // Try to find associated profile from nearby elements
        const container = img.closest('[data-author], [data-user-id], [data-profile-id], a[href*="/profile/"], [class*="profile"]');
        let profileId = container?.getAttribute('data-author')
          || container?.getAttribute('data-user-id')
          || container?.getAttribute('data-profile-id')
          || '';
        if (!profileId) {
          const link = container?.querySelector('a[href*="/profile/"]') || container?.closest('a[href*="/profile/"]');
          const href = link?.getAttribute('href') || '';
          const match = href.match(/\/profile\/([^/?#]+)/);
          if (match) profileId = match[1];
        }
        if (!profileId) return;

        chrome.runtime.sendMessage({
          type: 'ADAPTER_CONTACTS',
          platform: 'adam4adam',
          payload: [{
            id: `adam4adam:${profileId}`,
            platform: 'adam4adam',
            platformUserId: profileId,
            displayName: '',
            profileUrl: `https://www.adam4adam.com/profile/${profileId}`,
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

// Watch URL changes for active profile detection
let lastUrl = location.href;
function checkUrlChange() {
  if (!contextValid) return;
  const url = location.href;
  if (url === lastUrl) return;
  lastUrl = url;
  // A4A URL patterns: /messages/{username}, /profile/{username}, /mailbox
  const match = url.match(/\/messages\/([^/?#]+)/i) || url.match(/\/profile\/([^/?#]+)/i);
  if (match) {
    try {
      chrome.runtime.sendMessage({
        type: 'ACTIVE_PROFILE_CHANGED',
        contactId: `adam4adam:${match[1]}`,
        platform: 'adam4adam',
      }).catch(() => {});
    } catch {}
  }
}
setInterval(checkUrlChange, 3000);
window.addEventListener('popstate', checkUrlChange);

// Inject MAIN world script
if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/adam4adam.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
