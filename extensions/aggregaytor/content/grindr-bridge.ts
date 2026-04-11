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
setInterval(checkUrlChange, 1000);
window.addEventListener('popstate', checkUrlChange);

if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/grindr.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
