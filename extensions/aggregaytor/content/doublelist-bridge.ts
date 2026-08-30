/**
 * doublelist-bridge.ts — ISOLATED world bridge for DoubleList.
 */

const LOG = '[Aggregaytor:Bridge:DList]';
let contextValid = true;

function checkContext(): boolean {
  try { void chrome.runtime.id; return true; }
  catch { if (contextValid) { console.warn(`${LOG} Context invalidated`); contextValid = false; } return false; }
}

// Trust boundary: `__aggregaytor_message` is a plain window CustomEvent, so
// ANY script on doublelist.com can forge it — not just content/doublelist.js.
// Relaying `detail` verbatim would let the page reach every case of the
// service worker's message switch. Only the message types content/doublelist.js
// actually emits are forwarded.
const DLIST_RELAY_TYPES = new Set(['ADAPTER_MESSAGES', 'ADAPTER_CONTACTS', 'ADAPTER_ERROR']);

window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail || typeof detail.type !== 'string') return;
  if (!DLIST_RELAY_TYPES.has(detail.type)) {
    console.warn(`${LOG} Dropped relay message with unexpected type: ${detail.type.slice(0, 40)}`);
    return;
  }
  try { chrome.runtime.sendMessage(detail).catch(() => {}); }
  catch { contextValid = false; }
}) as EventListener);

try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SEND_AUTO_RESPONSE') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
        detail: { text: message.text, contactId: message.contactId },
      }));
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'SPA_NAVIGATE') {
      try { window.location.href = message.url; } catch {}
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'TEXT_EXPANDER_SETTINGS') {
      window.dispatchEvent(new CustomEvent('__aggregaytor_text_expander_settings', {
        detail: { substitutions: message.substitutions, enabled: message.enabled },
      }));
      if (message.substitutions) {
        try { localStorage.setItem('aggregaytor_text_substitutions', JSON.stringify(message.substitutions)); } catch {}
      }
      if (message.enabled !== undefined) {
        try { localStorage.setItem('aggregaytor_text_expander_enabled', String(message.enabled)); } catch {}
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'SCRAPE_AVATARS') {
      let count = 0;
      document.querySelectorAll('.notificationUser-img, [class*="avatar"] img, img[class*="photo"]').forEach(img => {
        const src = (img as HTMLImageElement).src;
        if (!src || !src.startsWith('http')) return;
        const container = img.closest('[data-mess-id], [data-mess-channel], a[href*="/profile/"]');
        const channel = container?.getAttribute('data-mess-channel') || '';
        const messId = container?.getAttribute('data-mess-id') || '';
        const profileId = channel || messId;
        if (!profileId) return;
        chrome.runtime.sendMessage({
          type: 'ADAPTER_CONTACTS', platform: 'doublelist',
          payload: [{
            id: `doublelist:${profileId}`, platform: 'doublelist', platformUserId: profileId,
            displayName: '', profileUrl: '', avatarUrl: src,
            lastSeen: new Date().toISOString(), metadata: {},
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

let lastUrl = location.href;
function checkUrlChange() {
  if (!contextValid) return;
  const url = location.href;
  if (url === lastUrl) return;
  lastUrl = url;
  const match = url.match(/\/messages\?lastMessageKey=(\d+-\d+)/i) || url.match(/\/messages\/([^/?#]+)/i);
  if (match) {
    try {
      chrome.runtime.sendMessage({ type: 'ACTIVE_PROFILE_CHANGED', contactId: `doublelist:${match[1]}`, platform: 'doublelist' }).catch(() => {});
    } catch {}
  }
}
setInterval(checkUrlChange, 3000);
window.addEventListener('popstate', checkUrlChange);

if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/doublelist.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
