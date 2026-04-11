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
    if (message.type === 'SET_LOG_LEVEL') {
      // Forward to MAIN world
      window.dispatchEvent(new CustomEvent('__aggregaytor_set_log_level', { detail: message.level }));
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
    if (message.type === 'SCRAPE_GLOBAL_CHAT') {
      // Scrape all visible global chat messages from the DOM
      const messages: any[] = [];
      const contacts: any[] = [];

      // Global chat messages are in scrollable containers with profile info + body
      // Each message block has: avatar, attributes line, timestamp/distance, message bubbles
      document.querySelectorAll('[class*="cruising-update"], [class*="global-chat-message"], [class*="feed-item"], [class*="post"]').forEach(el => {
        try {
          // Get avatar
          const avatarEl = el.querySelector('img') as HTMLImageElement;
          const avatarUrl = avatarEl?.src || '';
          const bgEl = el.querySelector('[style*="background-image"]') as HTMLElement;
          const bgMatch = bgEl?.style?.backgroundImage?.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
          const bgAvatar = bgMatch?.[1] || '';

          // Get profile attributes line (e.g., "30m, 6'1", 185lb, 8", bi, vers top")
          // This is typically in a small text element before the message body
          const allText = el.textContent || '';
          const attrMatch = allText.match(/(\d+m?,\s*\d+['"]\d*"?,\s*\d+lb.*?)(?:\d+\s*(?:minute|second|hour))/i);
          const attrs = attrMatch?.[1]?.trim() || '';

          // Get timestamp and distance
          const timeMatch = allText.match(/(\d+\s*(?:minutes?|seconds?|hours?)\s*ago)/i);
          const distMatch = allText.match(/([\d.]+\s*miles?)/i);
          const timeText = timeMatch?.[1] || '';
          const distance = distMatch?.[1] || '';

          // Get message body — the actual content bubbles
          const bodyEls = el.querySelectorAll('[class*="message"], [class*="body"], [class*="content"], [class*="text"], p');
          const bodyParts: string[] = [];
          bodyEls.forEach(b => {
            const t = b.textContent?.trim();
            if (t && t.length > 1 && !t.match(/^\d+m,/) && !t.includes('ago') && !t.includes('miles')) {
              bodyParts.push(t);
            }
          });
          // Fallback: if no body elements found, use the main text minus the attributes
          let body = bodyParts.join('\n').trim();
          if (!body) {
            body = allText.replace(attrs, '').replace(timeText, '').replace(distance, '').trim();
            // Clean up — remove very short or attribute-like content
            body = body.split('\n').filter(l => l.trim().length > 3).join('\n').trim();
          }
          if (!body || body.length < 3) return;

          // Extract a pseudo profile ID from the avatar URL or attributes hash
          let profileId = '';
          const idFromAvatar = (avatarUrl || bgAvatar).match(/\/([0-9a-f]{6,})\//i);
          if (idFromAvatar) profileId = idFromAvatar[1].toLowerCase();
          else profileId = `gc-${btoa(attrs.slice(0, 30)).slice(0, 12)}`;

          messages.push({
            id: `sniffies:gc-${profileId}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            platform: 'sniffies',
            threadId: 'sniffies:global-chat',
            contactId: 'sniffies:global-chat',
            direction: 'in',
            body,
            timestamp: new Date().toISOString(),
            read: true,
            metadata: {
              senderId: profileId,
              avatarUrl: avatarUrl || bgAvatar,
              displayName: attrs || profileId.slice(0, 10),
              bodyType: '', position: '', age: '',
              distance, timeText, attrs,
              source: 'global-chat-scrape',
            },
          });

          if (profileId && (avatarUrl || bgAvatar)) {
            contacts.push({
              id: `sniffies:${profileId}`,
              platform: 'sniffies',
              platformUserId: profileId,
              displayName: attrs || profileId.slice(0, 10),
              profileUrl: `https://sniffies.com/profile/${profileId}`,
              avatarUrl: avatarUrl || bgAvatar,
              lastSeen: new Date().toISOString(),
              metadata: { distance, attrs },
            });
          }
        } catch {}
      });

      // Send to service worker
      if (messages.length) {
        chrome.runtime.sendMessage({ type: 'ADAPTER_MESSAGES', platform: 'sniffies', payload: messages }).catch(() => {});
      }
      if (contacts.length) {
        chrome.runtime.sendMessage({ type: 'ADAPTER_CONTACTS', platform: 'sniffies', payload: contacts }).catch(() => {});
      }

      sendResponse({ ok: true, count: messages.length });
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
