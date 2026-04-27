/**
 * adam4adam-bridge.ts — ISOLATED world bridge for Adam4Adam.
 *
 * Relays adapter events from MAIN world to service worker, handles
 * service worker commands (auto-send, avatar scraping, settings relay),
 * provides middle-click-to-block + local hide filter + floating quick
 * actions panel, and injects the MAIN world script.
 *
 * A4A differs from Grindr/Sniffies architecturally: it's a traditional
 * server-rendered site with multi-page navigation, profile IDs are
 * usernames (not numeric), and there's no React fiber tree to walk.
 * Profile cards are identifiable by their /profile/{username} links.
 */

const LOG = '[Aggregaytor:Bridge:A4A]';
const HIDE_CLASS = 'aggregaytor-a4a-hide';
const BLOCKED_KEY = 'aggregaytor_a4a_blocked';
let contextValid = true;

function checkContext(): boolean {
  try { void chrome.runtime.id; return true; }
  catch { if (contextValid) { console.warn(`${LOG} Context invalidated`); contextValid = false; } return false; }
}

// ── Local Hide Filter ──────────────────────────────────────────────────────
// A4A has a native block feature but the endpoint is behind a CSRF-protected
// form that's fragile to change and varies by account tier. For reliable
// filtering we keep our own blocklist in localStorage and visually hide any
// profile card on the page that matches. The PROFILE_BLOCKED event still
// flows to the service worker for aggregator tracking + preference training.
const blockedUsernames = new Set<string>();
try {
  const raw = localStorage.getItem(BLOCKED_KEY);
  if (raw) {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) for (const u of arr) blockedUsernames.add(String(u).toLowerCase());
  }
} catch {}

function saveBlockedList(): void {
  try { localStorage.setItem(BLOCKED_KEY, JSON.stringify([...blockedUsernames])); } catch {}
}

function injectHideStyles(): void {
  if (document.getElementById('aggregaytor-a4a-css')) return;
  const style = document.createElement('style');
  style.id = 'aggregaytor-a4a-css';
  style.textContent = `
    .${HIDE_CLASS} { display: none !important; visibility: hidden !important;
      opacity: 0 !important; pointer-events: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Walk up from a profile link to find the smallest ancestor that represents
 * just THIS one card. The boundary is: as soon as we step into a parent that
 * contains multiple /profile/ links, the previous node was the card. If we
 * walk up 10 levels without ever finding a sibling profile link, we fall
 * back to the link itself (safer than hiding a big chunk of the page).
 *
 * The previous implementation used class-substring selectors like
 * [class*="user"] which match container elements like <div class="users-list">
 * that wrap ALL profiles — one block caused the whole page to vanish.
 */
function findCardContainer(link: HTMLElement): HTMLElement {
  let prev: HTMLElement = link;
  let node: HTMLElement | null = link.parentElement;
  let steps = 0;
  while (node && node !== document.body && node !== document.documentElement && steps < 10) {
    const profileLinks = node.querySelectorAll('a[href*="/profile/"]');
    if (profileLinks.length > 1) {
      // node contains multiple cards → prev was the card boundary
      return prev;
    }
    prev = node;
    node = node.parentElement;
    steps += 1;
  }
  // Reached the top without ever seeing a sibling profile link — the whole
  // page is about this one profile (/profile/{username} detail page). Don't
  // hide anything big; fall back to the link.
  return link;
}

/** Find the wrapper element for a profile card, given any descendant. */
function resolveProfileCard(el: HTMLElement): { card: HTMLElement; username: string } | null {
  // A4A profile cards are almost always anchored on <a href="/profile/...">
  const link = el.closest('a[href*="/profile/"]') as HTMLElement | null;
  if (link) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/profile\/([^/?#]+)/i);
    if (match) {
      return { card: findCardContainer(link), username: match[1] };
    }
  }
  // Fallback: check common data attributes
  const dataEl = el.closest('[data-author], [data-user-id], [data-profile-id], [data-username]') as HTMLElement | null;
  if (dataEl) {
    const username = dataEl.getAttribute('data-author')
      || dataEl.getAttribute('data-user-id')
      || dataEl.getAttribute('data-profile-id')
      || dataEl.getAttribute('data-username') || '';
    if (username) return { card: dataEl, username };
  }
  return null;
}

/** Scan the page for blocked usernames and hide matching cards. Cheap — runs
 *  on DOM mutations (debounced) and once after each page load. */
function applyHideFilter(): void {
  if (!blockedUsernames.size) return;
  injectHideStyles();
  // Safety: if we'd end up hiding more profile links than we see NOT blocked,
  // something's wrong with card detection — bail and log rather than nuking
  // the page. This is belt-and-suspenders on top of findCardContainer.
  const allLinks = Array.from(document.querySelectorAll<HTMLElement>('a[href*="/profile/"]'));
  const toHide: HTMLElement[] = [];
  let matched = 0;
  for (const link of allLinks) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/profile\/([^/?#]+)/i);
    if (!match) continue;
    const username = match[1].toLowerCase();
    if (!blockedUsernames.has(username)) continue;
    matched++;
    const card = findCardContainer(link);
    // Sanity check: the resolved card must not contain MORE than one profile
    // link — if it does, our walk-up got confused and we'd hide a mega-
    // container. In that case, just hide the link itself.
    if (card.querySelectorAll('a[href*="/profile/"]').length <= 1) {
      toHide.push(card);
    } else {
      console.warn(`${LOG} Card for ${username} contained multiple profile links; falling back to link-only hide.`);
      toHide.push(link);
    }
  }
  if (matched && toHide.length === 0) {
    console.warn(`${LOG} Hide filter found ${matched} match(es) but resolved zero safe cards — skipping.`);
    return;
  }
  for (const el of toHide) el.classList.add(HIDE_CLASS);
}

function hideCard(card: HTMLElement): void {
  injectHideStyles();
  card.style.transition = 'opacity 0.3s';
  card.style.opacity = '0';
  setTimeout(() => card.classList.add(HIDE_CLASS), 300);
}

// ── Middle-Click to Block ──────────────────────────────────────────────────
// Middle-click any profile card (thumbnail grid, message row, anywhere the
// username is linked) → username added to local blocklist, card faded out,
// PROFILE_BLOCKED event fired for aggregator tracking + ML training.
document.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return; // middle-click only
  if (!contextValid || !checkContext()) return;

  const target = e.target as HTMLElement;
  if (!target) return;

  // If we're in a chat composer area, skip — middle-click there should not
  // be intercepted (user might be pasting or invoking native behavior).
  if (target.closest('textarea, input, [contenteditable="true"], form, [class*="composer" i], [class*="compose" i]')) {
    return;
  }

  const resolved = resolveProfileCard(target);
  if (!resolved) return;

  const { card, username } = resolved;
  if (!username) return;

  // Safety: refuse to hide a container that encloses more than one profile
  // link. Better a missed block than a nuked page. User can re-click after
  // we log a warning.
  const enclosedProfileLinks = card.querySelectorAll('a[href*="/profile/"]').length;
  if (enclosedProfileLinks > 1) {
    console.warn(`${LOG} Middle-click refused: card for ${username} contains ${enclosedProfileLinks} profile links (would hide multiple). Pick a more specific element.`);
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  const lower = username.toLowerCase();
  blockedUsernames.add(lower);
  saveBlockedList();
  hideCard(card);
  console.log(`${LOG} Middle-click block: ${username}`);

  // Notify service worker so the aggregator tracks it + ML model trains.
  try {
    chrome.runtime.sendMessage({
      type: 'PROFILE_BLOCKED',
      contactId: `adam4adam:${lower}`,
      platform: 'adam4adam',
    }).catch(() => {});
  } catch {}

  // Fire a bridge event that the MAIN world may use for platform-side
  // blocking (opt-in in settings). The handler there decides whether to
  // actually call A4A's block endpoint or stay local-only.
  window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
    detail: { username: lower, platform: 'adam4adam' },
  }));
}, true);

// Shift+right-click toggles block — trackpad-friendly equivalent of
// middle-click, with the added "click-again-to-undo" behaviour.
//
// The previous binding was on plain `click` + shiftKey, which collided
// with the browser's native Shift+click ("open in new window"): every
// time a user opened a profile in a new window, the username got
// silently added to the local blocklist, eventually hiding the entire
// page. Switching to `contextmenu` confines the gesture to an
// intentional Shift+right-click and stops normal navigation from
// poisoning the blocklist.
document.addEventListener('contextmenu', (e) => {
  if (!e.shiftKey) return;
  if (!contextValid) return;
  const target = e.target as HTMLElement;
  const resolved = resolveProfileCard(target);
  if (!resolved) return;
  const lower = resolved.username.toLowerCase();
  e.preventDefault();
  e.stopPropagation();
  if (blockedUsernames.has(lower)) {
    blockedUsernames.delete(lower);
    resolved.card.classList.remove(HIDE_CLASS);
    resolved.card.style.opacity = '';
    console.log(`${LOG} Shift+right-click unblock: ${lower}`);
  } else {
    blockedUsernames.add(lower);
    hideCard(resolved.card);
    console.log(`${LOG} Shift+right-click block: ${lower}`);
  }
  saveBlockedList();
}, true);

// Apply hide filter on load + whenever new profile cards render (A4A
// sometimes lazy-loads additional rows as you scroll).
injectHideStyles();
applyHideFilter();
setTimeout(applyHideFilter, 1500); // after initial render
let filterDebounce: ReturnType<typeof setTimeout> | null = null;
try {
  const observer = new MutationObserver(() => {
    if (filterDebounce) return;
    filterDebounce = setTimeout(() => { filterDebounce = null; applyHideFilter(); }, 400);
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
} catch {}

// Receive blocklist updates from the side panel (e.g. IMPORT_BLOCKED).
window.addEventListener('__aggregaytor_a4a_blocked_update', ((event: CustomEvent) => {
  const arr = event.detail?.usernames;
  if (!Array.isArray(arr)) return;
  blockedUsernames.clear();
  for (const u of arr) blockedUsernames.add(String(u).toLowerCase());
  saveBlockedList();
  applyHideFilter();
}) as EventListener);

// Self-heal: if any element on the page is currently hidden (HIDE_CLASS OR
// inline opacity:0 left over from hideCard's fade-out animation) AND contains
// multiple profile links, it was hidden by the buggy v0.57.13 container
// selector. Un-hide it. applyHideFilter will then re-apply proper per-card
// hides using the corrected findCardContainer walk-up.
function selfHeal(): void {
  let unhidden = 0;
  // 1. Elements with our HIDE_CLASS that contain multiple profile links
  document.querySelectorAll<HTMLElement>(`.${HIDE_CLASS}`).forEach(el => {
    if (el.querySelectorAll('a[href*="/profile/"]').length > 1) {
      el.classList.remove(HIDE_CLASS);
      el.style.opacity = '';
      el.style.display = '';
      el.style.visibility = '';
      unhidden++;
    }
  });
  // 2. Elements with inline opacity:0 that contain multiple profile links
  //    (hideCard set opacity=0 BEFORE adding HIDE_CLASS via setTimeout —
  //    if the page was captured mid-animation, the inline style lingered)
  document.querySelectorAll<HTMLElement>('[style*="opacity"]').forEach(el => {
    if (el.style.opacity === '0' && el.querySelectorAll('a[href*="/profile/"]').length > 1) {
      el.style.opacity = '';
      el.style.transition = '';
      unhidden++;
    }
  });
  // 3. Also unhide any element we hid that's now matching the old greedy
  //    container selector (ancestors with class*=user, card, tile, etc)
  //    — only if they contain >1 profile link.
  if (unhidden > 0) {
    console.log(`${LOG} Self-heal: un-hid ${unhidden} container(s) left over from the v0.57.13 over-greedy hide.`);
  }
}
setTimeout(() => { selfHeal(); applyHideFilter(); }, 1000);
// Repeat after 3s in case A4A finishes rendering late
setTimeout(() => { selfHeal(); applyHideFilter(); }, 3000);

// ── Emergency Recovery Helpers (DevTools console) ──────────────────────────
// __aggregaytor_a4a_reset()       — clear blocklist, un-hide everything
// __aggregaytor_a4a_unhide_all()  — un-hide currently-hidden cards but keep
//                                    the blocklist (hide re-applies on scroll)
// __aggregaytor_a4a_list_blocked()— print the stored blocklist
//
// Bridge content scripts run in the ISOLATED world, so assigning to
// `window.foo` only exposes the helper to the extension's console
// context — not to the page's default console where users actually
// type. We mirror the helpers into MAIN world via a one-shot injected
// <script> so `__aggregaytor_a4a_reset()` works straight from the
// regular DevTools prompt. The MAIN-world stubs use localStorage
// (shared across worlds) and a CustomEvent to ping the bridge so the
// in-memory blocklist + DOM hide state stay in sync.
(window as any).__aggregaytor_a4a_reset = function(): void {
  clearA4ABlocklist();
};
(window as any).__aggregaytor_a4a_unhide_all = function(): void {
  document.querySelectorAll<HTMLElement>(`.${HIDE_CLASS}`).forEach(el => {
    el.classList.remove(HIDE_CLASS);
    el.style.opacity = '';
  });
  console.log(`${LOG} All hidden cards revealed. Blocklist unchanged (${blockedUsernames.size} entries).`);
};
(window as any).__aggregaytor_a4a_list_blocked = function(): string[] {
  const list = [...blockedUsernames].sort();
  console.log(`${LOG} ${list.length} blocked username(s):`, list);
  return list;
};

// MAIN-world bridge: listen for the CustomEvents the page-side stubs
// fire and run the real helpers in the ISOLATED world.
window.addEventListener('__aggregaytor_a4a_console_reset', () => clearA4ABlocklist());
window.addEventListener('__aggregaytor_a4a_console_unhide_all', () => {
  document.querySelectorAll<HTMLElement>(`.${HIDE_CLASS}`).forEach(el => {
    el.classList.remove(HIDE_CLASS);
    el.style.opacity = '';
  });
  console.log(`${LOG} All hidden cards revealed. Blocklist unchanged (${blockedUsernames.size} entries).`);
});

// v0.57.39: previously injected an inline <script>{textContent: ...}</script>
// here to expose console helpers in the MAIN world. A4A's CSP forbids
// inline scripts, so every page load logged 30+ "Executing inline script
// violates Content Security Policy" errors. The MAIN-world content script
// (content/adam4adam.ts) defines the same three helpers directly and is
// loaded via src= which every CSP allows. The bridge keeps its own copies
// on the ISOLATED-world window (immediately above) for the rare case
// where the user switches the DevTools execution context.

// Relay MAIN world adapter events to service worker
window.addEventListener('__aggregaytor_message', ((event: CustomEvent) => {
  if (!contextValid || !checkContext()) return;
  const detail = event.detail;
  if (!detail?.type) return;
  try { chrome.runtime.sendMessage(detail).catch(() => {}); }
  catch { contextValid = false; }
}) as EventListener);

/** Clear our local A4A blocklist AND remove any hide styling from the DOM.
 *  Does NOT contact A4A's servers — this is purely resetting our own filter. */
function clearA4ABlocklist(): void {
  const n = blockedUsernames.size;
  blockedUsernames.clear();
  saveBlockedList();
  // Remove every visual hide we've applied in any form: the class, inline
  // opacity fade-out, and inline display:none belt-and-suspenders.
  document.querySelectorAll<HTMLElement>(`.${HIDE_CLASS}, [style*="opacity"], [style*="display: none"]`).forEach(el => {
    el.classList.remove(HIDE_CLASS);
    if (el.style.opacity === '0') el.style.opacity = '';
    if (el.style.display === 'none' && el.querySelectorAll('a[href*="/profile/"]').length > 0) {
      el.style.display = '';
    }
    el.style.transition = '';
    el.style.visibility = '';
  });
  console.log(`${LOG} Cleared ${n} blocked username(s); removed hide styling from the DOM.`);
}

try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Clear local A4A blocklist (from Settings → Data → Unhide A4A)
    if (message.type === 'A4A_UNHIDE_ALL') {
      clearA4ABlocklist();
      sendResponse({ ok: true });
      return true;
    }
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

// ── Floating Quick Actions Panel ───────────────────────────────────────────
// Shown on /profile/ and /messages/ pages. Mirrors the Sniffies/Grindr panel:
// block, notes, rating, quick phrases, reminder.
const FP_ID = 'aggregaytor-a4a-fp';
let fpUsername = '';

function injectFpStyles(): void {
  if (document.getElementById('aggregaytor-a4a-fp-css')) return;
  const s = document.createElement('style');
  s.id = 'aggregaytor-a4a-fp-css';
  s.textContent = `
    #${FP_ID}{position:fixed;z-index:99999;width:300px;background:rgba(15,20,25,0.95);border:1px solid rgba(59,130,246,0.3);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.5);font-family:system-ui,sans-serif;font-size:12px;color:#e7e9ea;overflow:hidden}
    #${FP_ID}.collapsed .fp-body{display:none}#${FP_ID}.collapsed{width:170px}
    #${FP_ID} .fp-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:rgba(59,130,246,0.15);cursor:move;user-select:none;border-bottom:1px solid rgba(59,130,246,0.2)}
    #${FP_ID} .fp-header-title{font-weight:600;font-size:11px;color:#93c5fd}#${FP_ID} .fp-header-btns{display:flex;gap:4px}
    #${FP_ID} .fp-header-btn{background:none;border:none;color:#6b7280;cursor:pointer;font-size:14px;padding:0 2px}#${FP_ID} .fp-header-btn:hover{color:#e7e9ea}
    #${FP_ID} .fp-body{padding:8px 10px}#${FP_ID} .fp-actions{display:flex;gap:6px;align-items:center;margin-bottom:8px}
    #${FP_ID} .fp-action-btn{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 8px;color:#e7e9ea;cursor:pointer;font-size:11px}
    #${FP_ID} .fp-action-btn:hover{background:rgba(59,130,246,0.2)}
    #${FP_ID} .fp-action-btn.danger{border-color:rgba(239,68,68,0.3);color:#f87171}#${FP_ID} .fp-action-btn.danger:hover{background:rgba(239,68,68,0.15)}
    #${FP_ID} .fp-stars{display:flex;gap:1px;margin-left:auto}#${FP_ID} .fp-star{font-size:14px;cursor:pointer;color:#4b5563}#${FP_ID} .fp-star.active{color:#fbbf24}
    #${FP_ID} .fp-phrases{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
    #${FP_ID} .fp-phrase-btn{background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.25);color:#93c5fd;border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${FP_ID} .fp-notes-input{width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:5px 7px;color:#e7e9ea;font-size:11px;resize:vertical;min-height:32px;box-sizing:border-box}
    #${FP_ID} .fp-status{font-size:9px;color:#22c55e;margin-top:2px;min-height:11px}
  `;
  (document.head || document.documentElement).appendChild(s);
}

function showFloatingPanel(username: string): void {
  if (!username || !contextValid) return;
  if (document.getElementById(FP_ID) && fpUsername === username) return;
  document.getElementById(FP_ID)?.remove();
  fpUsername = username;

  injectFpStyles();
  const panel = document.createElement('div');
  panel.id = FP_ID;
  let pos = { x: 20, y: 120 };
  try { const s = localStorage.getItem('aggregaytor_a4a_fp_pos'); if (s) pos = JSON.parse(s); } catch {}
  panel.style.left = `${pos.x}px`; panel.style.top = `${pos.y}px`;
  if (localStorage.getItem('aggregaytor_a4a_fp_collapsed') === 'true') panel.classList.add('collapsed');

  panel.innerHTML = `
    <div class="fp-header">
      <span class="fp-header-title">⚡ ${username}</span>
      <div class="fp-header-btns">
        <button class="fp-header-btn fp-minimize-btn" title="Minimize">−</button>
        <button class="fp-header-btn fp-close-btn" title="Close">×</button>
      </div>
    </div>
    <div class="fp-body">
      <div class="fp-actions">
        <button class="fp-action-btn danger fp-block-btn" title="Block/hide this profile">🚫</button>
        <button class="fp-action-btn fp-notes-btn" title="Notes">📝</button>
        <button class="fp-action-btn fp-reminder-btn" title="Set 1-hour reminder">⏰</button>
        <div class="fp-stars">${[1,2,3,4,5].map(n => `<span class="fp-star" data-star="${n}">★</span>`).join('')}</div>
      </div>
      <div class="fp-phrases" id="fp-phrases"></div>
      <div id="fp-notes-area" style="display:none">
        <textarea class="fp-notes-input" id="fp-notes-input" placeholder="Notes..."></textarea>
        <div class="fp-status" id="fp-status"></div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  // Drag
  let dragging = false, dx = 0, dy = 0;
  panel.querySelector('.fp-header')!.addEventListener('mousedown', (e: Event) => {
    const me = e as MouseEvent;
    if ((me.target as HTMLElement).closest('.fp-header-btn')) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    dx = me.clientX - r.left; dy = me.clientY - r.top;
    me.preventDefault();
  });
  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    panel.style.left = `${Math.max(0, e.clientX - dx)}px`;
    panel.style.top = `${Math.max(0, e.clientY - dy)}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    try { localStorage.setItem('aggregaytor_a4a_fp_pos', JSON.stringify({ x: parseInt(panel.style.left), y: parseInt(panel.style.top) })); } catch {}
  });

  panel.querySelector('.fp-minimize-btn')!.addEventListener('click', () => {
    const c = panel.classList.toggle('collapsed');
    try { localStorage.setItem('aggregaytor_a4a_fp_collapsed', String(c)); } catch {}
  });
  panel.querySelector('.fp-close-btn')!.addEventListener('click', () => panel.remove());

  panel.querySelector('.fp-block-btn')!.addEventListener('click', () => {
    blockedUsernames.add(fpUsername.toLowerCase());
    saveBlockedList();
    applyHideFilter();
    try {
      chrome.runtime.sendMessage({
        type: 'PROFILE_BLOCKED',
        contactId: `adam4adam:${fpUsername.toLowerCase()}`,
        platform: 'adam4adam',
      }).catch(() => {});
    } catch {}
    window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
      detail: { username: fpUsername.toLowerCase(), platform: 'adam4adam' },
    }));
    // Go back to the previous page so the now-blocked profile stops being
    // the active view (mirrors the Sniffies/Grindr block flow).
    if (window.history.length > 1) window.history.back();
    panel.remove();
  });

  panel.querySelector('.fp-reminder-btn')!.addEventListener('click', () => {
    const dueAt = new Date(Date.now() + 3600_000).toISOString();
    try {
      chrome.runtime.sendMessage({
        type: 'CREATE_REMINDER',
        contactId: `adam4adam:${fpUsername.toLowerCase()}`,
        platform: 'adam4adam',
        note: 'Follow up',
        dueAt,
      }).catch(() => {});
    } catch {}
    const btn = panel.querySelector('.fp-reminder-btn') as HTMLElement;
    btn.textContent = '✅';
    setTimeout(() => { btn.textContent = '⏰'; }, 1500);
  });

  panel.querySelector('.fp-notes-btn')!.addEventListener('click', () => {
    const a = panel.querySelector('#fp-notes-area') as HTMLElement;
    a.style.display = a.style.display === 'none' ? '' : 'none';
  });

  let nt: ReturnType<typeof setTimeout> | null = null;
  panel.querySelector('#fp-notes-input')!.addEventListener('input', (e) => {
    if (nt) clearTimeout(nt);
    nt = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({
          type: 'UPSERT_THREAD_META',
          contactId: `adam4adam:${fpUsername.toLowerCase()}`,
          platform: 'adam4adam',
          updates: { notes: (e.target as HTMLTextAreaElement).value },
        }).catch(() => {});
      } catch {}
      const st = panel.querySelector('#fp-status') as HTMLElement;
      if (st) { st.textContent = 'Saved'; setTimeout(() => st.textContent = '', 1500); }
    }, 800);
  });

  panel.querySelectorAll('.fp-star').forEach(star => {
    star.addEventListener('click', () => {
      const r = parseInt((star as HTMLElement).dataset.star || '0');
      const cur = panel.querySelectorAll('.fp-star.active').length;
      const nr = r === cur ? 0 : r;
      panel.querySelectorAll('.fp-star').forEach((s, i) => s.classList.toggle('active', i < nr));
      try {
        chrome.runtime.sendMessage({
          type: 'SET_RATING',
          contactId: `adam4adam:${fpUsername.toLowerCase()}`,
          platform: 'adam4adam',
          rating: nr,
        }).catch(() => {});
      } catch {}
    });
  });

  // Pre-fill from thread meta
  try {
    chrome.runtime.sendMessage({ type: 'GET_THREAD_META', contactId: `adam4adam:${fpUsername.toLowerCase()}` })
      .then((res: any) => {
        const m = res?.meta || {};
        (panel.querySelector('#fp-notes-input') as HTMLTextAreaElement).value = m.notes || '';
        const rating = m.rating || 0;
        panel.querySelectorAll('.fp-star').forEach((s, i) => s.classList.toggle('active', i < rating));
        if (m.notes) (panel.querySelector('#fp-notes-area') as HTMLElement).style.display = '';
      }).catch(() => {});
  } catch {}

  // Quick phrases
  try {
    chrome.storage.local.get('aggregaytor_quick_phrases', (data: any) => {
      const phrases = (data.aggregaytor_quick_phrases || ['Hey', "What's up?"]).slice(0, 3);
      const c = panel.querySelector('#fp-phrases') as HTMLElement;
      if (!c) return;
      c.innerHTML = phrases.map((p: string) => `<button class="fp-phrase-btn" title="${p}">${p.length > 18 ? p.slice(0, 16) + '…' : p}</button>`).join('');
      c.querySelectorAll('.fp-phrase-btn').forEach((btn, i) => {
        btn.addEventListener('click', () => {
          window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
            detail: { text: phrases[i], contactId: `adam4adam:${fpUsername.toLowerCase()}` },
          }));
          (btn as HTMLElement).style.background = 'rgba(34,197,94,0.2)';
          setTimeout(() => { (btn as HTMLElement).style.background = ''; }, 500);
        });
      });
    });
  } catch {}
}

// ── URL Change Detection ───────────────────────────────────────────────────
let lastUrl = location.href;
function checkUrlChange() {
  if (!contextValid) return;
  const url = location.href;
  if (url === lastUrl) return;
  lastUrl = url;
  const match = url.match(/\/messages\/([^/?#]+)/i) || url.match(/\/profile\/([^/?#]+)/i);
  if (match) {
    const username = match[1];
    try {
      chrome.runtime.sendMessage({
        type: 'ACTIVE_PROFILE_CHANGED',
        contactId: `adam4adam:${username}`,
        platform: 'adam4adam',
      }).catch(() => {});
    } catch {}
    showFloatingPanel(username);
  } else {
    document.getElementById(FP_ID)?.remove();
    fpUsername = '';
    try {
      chrome.runtime.sendMessage({ type: 'PROFILE_CLOSED', platform: 'adam4adam' }).catch(() => {});
    } catch {}
  }
  // Re-apply hide filter after each navigation (new DOM)
  setTimeout(applyHideFilter, 500);
}
setInterval(checkUrlChange, 2000);
window.addEventListener('popstate', checkUrlChange);
// Also run once for the initial page load (full page loads on this server-
// rendered site don't fire popstate, and the /profile/ URL may already be
// current from first render).
setTimeout(checkUrlChange, 500);
// Force-show the panel for the initial URL since the diff-only checkUrlChange
// skips it when lastUrl === location.href
(() => {
  const m = location.href.match(/\/messages\/([^/?#]+)/i) || location.href.match(/\/profile\/([^/?#]+)/i);
  if (m) setTimeout(() => showFloatingPanel(m[1]), 800);
})();

// Inject MAIN world script
if (checkContext()) {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('content/adam4adam.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}
