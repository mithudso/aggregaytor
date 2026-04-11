/**
 * sniffies-bridge.ts — ISOLATED world bridge for Sniffies.
 *
 * Listens for CustomEvents from MAIN world, forwards to service worker.
 * Handles extension context invalidation gracefully (extension reloads).
 */

const LOG = '[Aggregaytor:Bridge:Sniffies]';
let contextValid = true;

function checkContext(): boolean {
  try {
    // This throws if extension was reloaded/uninstalled
    void chrome.runtime.id;
    return true;
  } catch {
    if (contextValid) {
      console.warn(`${LOG} Extension context invalidated — bridge disabled until page reload`);
      contextValid = false;
    }
    return false;
  }
}

window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail?.type) return;

  try {
    chrome.runtime.sendMessage(detail).catch(() => {
      // Silently ignore — extension may have reloaded
    });
  } catch {
    contextValid = false;
  }
}) as EventListener);

// Listen for auto-send requests from the service worker
try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SEND_AUTO_RESPONSE') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
        detail: { text: message.text, contactId: message.contactId },
      }));
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'SCRAPE_AVATARS') {
      // Tell MAIN world to scrape and report back via events
      window.dispatchEvent(new CustomEvent('__aggregaytor_scrape_avatars'));
      // Also scrape from ISOLATED world (can see the DOM)
      let count = 0;
      document.querySelectorAll('[style*="sniffiesassets"], .maplibregl-marker, .marker-avatar-image').forEach(el => {
        const bg = (el as HTMLElement).style?.backgroundImage || '';
        const match = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
        if (!match) return;
        const url = match[1];
        const idMatch = url.match(/sniffiesassets\.com\/([0-9a-f]{6,})\//i);
        if (!idMatch) return;
        const profileId = idMatch[1].toLowerCase();
        chrome.runtime.sendMessage({
          type: 'ADAPTER_CONTACTS',
          platform: 'sniffies',
          payload: [{
            id: `sniffies:${profileId}`,
            platform: 'sniffies',
            platformUserId: profileId,
            displayName: '',
            profileUrl: `https://sniffies.com/profile/${profileId}`,
            avatarUrl: url,
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
} catch {
  contextValid = false;
}

// Also forward error events (block detection)
window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  // Handle block detection from adapter error events
  if (detail?.type === 'ADAPTER_ERROR' && detail?.error?.startsWith?.('BLOCKED:')) {
    const profileId = detail.error.replace('BLOCKED:', '');
    try {
      chrome.runtime.sendMessage({
        type: 'PROFILE_BLOCKED',
        contactId: `sniffies:${profileId}`,
        platform: 'sniffies',
      }).catch(() => {});
    } catch {}
  }
}) as EventListener);

// Watch for URL changes (user opening profiles/conversations on the site)
let lastUrl = location.href;
function checkUrlChange() {
  if (!contextValid) return;
  const url = location.href;
  if (url === lastUrl) return;
  lastUrl = url;
  // Extract profile ID from Sniffies URL: /profile/{hex}/chat or /profile/{hex}
  const match = url.match(/\/profile\/([0-9a-f]{6,})(?:\/chat)?/i);
  if (match) {
    const contactId = `sniffies:${match[1].toLowerCase()}`;
    try {
      chrome.runtime.sendMessage({ type: 'ACTIVE_PROFILE_CHANGED', contactId, platform: 'sniffies' }).catch(() => {});
    } catch {}
  }
}
// Poll for SPA navigation (pushState doesn't fire popstate)
setInterval(checkUrlChange, 1000);
// Also listen for popstate
window.addEventListener('popstate', checkUrlChange);

// Inject MAIN world script
if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/sniffies.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
