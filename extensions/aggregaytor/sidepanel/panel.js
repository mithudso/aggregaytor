/**
 * panel.js — Side panel controller.
 *
 * Views: inbox (thread list with filters + action icons) and
 * thread (message detail with notes, reminders, suggestions).
 */

let currentPlatform = 'all'; // legacy — still used for some checks
let activePlatforms = new Set(); // multi-select toggle: which platforms are shown
let currentThread = null;
let currentMessages = [];

// ── Instant Tooltips ──────────────────────────────────────────────────────────
// Convert all title attributes to data-tip for instant CSS tooltips
// (Chrome's native title tooltip has a ~2 second delay that can't be changed).
//
// v0.57.15: the polling interval is now visibility-gated — when the panel
// is hidden (collapsed sidebar, different tab), the 5s sweep is skipped so
// we don't burn CPU repeatedly walking a stable DOM that the user can't
// see. The panel is hidden roughly half the time for most users.
function convertTitlesToTips() {
  if (document.visibilityState === 'hidden') return;
  document.querySelectorAll('[title]').forEach(el => {
    const title = el.getAttribute('title');
    if (title && !el.hasAttribute('data-tip')) {
      el.setAttribute('data-tip', title);
      el.removeAttribute('title'); // remove native tooltip
      // Header buttons get bottom tooltips (they're at the top of the screen)
      if (el.closest('.header')) el.setAttribute('data-tip-pos', 'bottom');
    }
  });
}
// Run on load and periodically (for dynamically created elements). The
// poll itself short-circuits when hidden; we also re-run on visibilitychange
// to catch elements added while the panel was off-screen.
convertTitlesToTips();
setInterval(convertTitlesToTips, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') convertTitlesToTips();
});

// ── User Preferences (loaded from chrome.storage.local) ─────────────────────
let prefTimestampAbsolute = false; // true = "11:42 PM", false = "5m" (relative)
let prefAutoNavigate = true;       // true = open platform tab on thread click
let prefToolbarMode = 'icon';      // 'icon', 'icon-text', 'text'
let selectedThreadIndex = -1;      // keyboard navigation: currently highlighted thread

// Load preferences from storage at startup
chrome.storage.local.get(['aggregaytor_timestamp_format', 'aggregaytor_auto_navigate', 'aggregaytor_toolbar_mode'], (result) => {
  prefTimestampAbsolute = result.aggregaytor_timestamp_format === 'absolute';
  prefAutoNavigate = result.aggregaytor_auto_navigate !== false;
  prefToolbarMode = result.aggregaytor_toolbar_mode || 'icon';
  applyInboxToolbarMode();
});

/**
 * Rewrite the inbox top-bar buttons (⚡⧉☑📷🖼🔄⚙) according to the current
 * toolbar-display preference. Each button carries its icon + label in
 * data-icon / data-label attributes so we can flip modes without losing
 * either piece. Call this after load AND whenever the mode changes.
 */
function applyInboxToolbarMode() {
  const mode = prefToolbarMode || 'icon';
  document.querySelectorAll('.header-settings[data-icon][data-label]').forEach((btn) => {
    const icon = btn.getAttribute('data-icon') || '';
    const label = btn.getAttribute('data-label') || '';
    if (mode === 'text') btn.textContent = label;
    else if (mode === 'icon-text') btn.textContent = `${icon} ${label}`;
    else btn.textContent = icon;
    btn.classList.toggle('header-settings-text', mode === 'text');
    btn.classList.toggle('header-settings-icon-text', mode === 'icon-text');
  });
}

// ── Global image error handler ──────────────────────────────────────────────
document.addEventListener('error', (e) => {
  if (e.target?.tagName === 'IMG') {
    e.target.style.display = 'none';
  }
}, true);
let currentMeta = null;
let allThreadMeta = new Map();
let activeOnSiteContactId = null;

let filters = {
  searchText: '', bodyType: [], position: [], minDeleteCount: 0,
  maxDistance: 0, unreadOnly: false, newChatsOnly: false,
  hasResponded: false, engagedRecently: false, bookmarked: false, favoritesOnly: false,
};
let currentSort = 'recent';
let savedScrollTop = 0; // #13 scroll position memory

// Debounce helpers — prevent rapid-fire reloads
let _newMsgTimer = null;
function debouncedLoadThreads() {
  clearTimeout(_newMsgTimer);
  _newMsgTimer = setTimeout(() => loadThreads(), 2000); // 2s debounce (was 500ms)
}
let _threadReloadTimer = null;
function debouncedReloadThread() {
  clearTimeout(_threadReloadTimer);
  _threadReloadTimer = setTimeout(() => {
    if (!currentThread) return;
    chrome.runtime.sendMessage({ type: 'GET_MESSAGES_BY_CONTACT', contactId: currentThread.contactId, limit: 500 })
      .then(res => { if (res?.ok) { currentMessages = res.messages || []; renderMessages(currentMessages); } }).catch(() => {});
  }, 3000); // 3 second debounce — no need to reload faster
}
let _draftsTimer = null;
function debouncedLoadDrafts() {
  clearTimeout(_draftsTimer);
  _draftsTimer = setTimeout(() => loadDrafts(), 2000);
}

// ── Inbox ───────────────────────────────────────────────────────────────────

async function loadThreads() {
  // Always fetch ALL summaries (no platform filter) so unread badge counts
  // are correct across all platforms. Filter client-side for display.
  const container = document.getElementById('thread-list');
  if (!container.querySelector('.thread-item') && !container.querySelector('.skeleton-item')) {
    container.innerHTML = Array(5).fill(0).map(() => `
      <div class="skeleton-item"><div class="skeleton-avatar"></div>
        <div class="skeleton-content"><div class="skeleton-line w70"></div><div class="skeleton-line w40"></div></div>
      </div>`).join('');
  }
  try {
    const [threadRes, metaRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_THREAD_SUMMARIES', opts: {} }),
      chrome.runtime.sendMessage({ type: 'GET_ALL_THREAD_META' }),
    ]);
    if (metaRes?.ok) {
      allThreadMeta.clear();
      for (const m of metaRes.metas || []) allThreadMeta.set(m.contactId, m);
    }
    if (threadRes?.ok) {
      const all = threadRes.summaries;
      // Filter by active platforms for display, but use ALL for badge counts
      let filtered;
      if (currentPlatform === 'all' || activePlatforms.size === 0) {
        filtered = all;
      } else if (currentPlatform === 'archived') {
        filtered = all.filter(s => allThreadMeta.get(s.contactId)?.archived);
      } else if (activePlatforms.size > 0) {
        // Multi-select: show threads from any active platform
        filtered = all.filter(s => activePlatforms.has(s.platform));
      } else {
        filtered = all;
      }
      renderThreads(sortThreads(applyFilters(filtered)));
      // #15 Per-platform unread badges — computed from ALL threads, not filtered
      const platformUnread = {};
      const platformTotal = {};
      for (const s of all) {
        platformTotal[s.platform] = (platformTotal[s.platform] || 0) + 1;
        if (s.unreadCount) platformUnread[s.platform] = (platformUnread[s.platform] || 0) + s.unreadCount;
      }
      document.querySelectorAll('.platform-chip[data-platform]').forEach(chip => {
        const p = chip.dataset.platform;
        const existing = chip.querySelector('.chip-badge');
        if (existing) existing.remove();
        const existingCount = chip.querySelector('.chip-count');
        if (existingCount) existingCount.remove();
        if (p !== 'all' && p !== 'archived' && platformUnread[p]) {
          const badge = document.createElement('span');
          badge.className = 'chip-badge';
          badge.textContent = platformUnread[p];
          chip.appendChild(badge);
        }
        // v0.57.28: show total thread count on active chips
        if (p !== 'all' && p !== 'archived' && activePlatforms.has(p) && platformTotal[p]) {
          const count = document.createElement('span');
          count.className = 'chip-count';
          count.textContent = platformTotal[p];
          chip.appendChild(count);
        }
      });
    }
  } catch (err) { console.error('[Panel] Load error:', err); }
}

function applyFilters(summaries) {
  const showingArchive = currentPlatform === 'archived';
  return summaries.filter(t => {
    const meta = allThreadMeta.get(t.contactId) || {};

    // Archive tab: show ONLY archived. All other tabs: hide archived.
    if (showingArchive) {
      if (!meta.archived) return false;
      // In archive view, skip other filters — just show all archived
      return true;
    }
    if (meta.archived) return false;
    if (meta.hiddenUntilResponse && meta.hidden) return false;

    if (filters.searchText) {
      const s = filters.searchText.toLowerCase();
      const name = (meta.alias || t.contact?.displayName || t.contactId).toLowerCase();
      const notes = (meta.notes || '').toLowerCase();
      if (!name.includes(s) && !notes.includes(s)) return false;
    }
    if (filters.bodyType.length) {
      const body = String(t.contact?.metadata?.bodyType || t.contact?.metadata?.body || '').toLowerCase();
      if (!filters.bodyType.some(b => body.includes(b))) return false;
    }
    if (filters.position.length) {
      const pos = String(t.contact?.metadata?.attitude || t.contact?.metadata?.position || '').toLowerCase();
      if (!filters.position.some(p => pos.includes(p))) return false;
    }
    if (filters.minDeleteCount > 0 && (meta.deletedChatCount || 0) < filters.minDeleteCount) return false;
    if (filters.maxDistance > 0) {
      const dist = parseFloat(String(t.contact?.metadata?.distance || meta.distance || '')) || 0;
      if (dist > filters.maxDistance) return false;
    }
    if (filters.unreadOnly && !t.unreadCount) return false;
    if (filters.newChatsOnly) {
      // "New" = created in last 24h (first message timestamp)
      const firstTs = new Date(t.lastMessage?.timestamp || 0).getTime(); // approximation
      if (Date.now() - firstTs > 24 * 3600_000) return false;
    }
    if (filters.hasResponded) {
      if (t.lastMessage?.direction !== 'in' && !t.unreadCount) return false;
    }
    if (filters.engagedRecently) {
      const lastTs = new Date(t.lastMessage?.timestamp || 0).getTime();
      if (Date.now() - lastTs > 24 * 3600_000) return false;
    }
    if (filters.bookmarked && !meta.bookmarked) return false;
    if (filters.favoritesOnly && !meta.favorited) return false;
    return true;
  });
}

function sortThreads(summaries) {
  return [...summaries].sort((a, b) => {
    const metaA = allThreadMeta.get(a.contactId) || {};
    const metaB = allThreadMeta.get(b.contactId) || {};

    // Favorites always sort first regardless of sort mode
    if (metaA.favorited && !metaB.favorited) return -1;
    if (!metaA.favorited && metaB.favorited) return 1;

    switch (currentSort) {
      case 'distance': {
        const dA = parseFloat(String(a.contact?.metadata?.distance || metaA.distance || '')) || 9999;
        const dB = parseFloat(String(b.contact?.metadata?.distance || metaB.distance || '')) || 9999;
        return dA - dB;
      }
      case 'interest': {
        const iA = metaA.sentiment?.interest || 0;
        const iB = metaB.sentiment?.interest || 0;
        return iB - iA;
      }
      case 'commitment': {
        const cA = metaA.sentiment?.commitment || 0;
        const cB = metaB.sentiment?.commitment || 0;
        return cB - cA;
      }
      case 'unread':
        return (b.unreadCount || 0) - (a.unreadCount || 0);
      case 'name': {
        const nA = metaA.alias || a.contact?.displayName || a.contactId;
        const nB = metaB.alias || b.contact?.displayName || b.contactId;
        return nA.localeCompare(nB);
      }
      case 'recent':
      default:
        return new Date(b.lastMessage?.timestamp || 0).getTime() - new Date(a.lastMessage?.timestamp || 0).getTime();
    }
  });
}

function renderThreads(summaries) {
  const container = document.getElementById('thread-list');
  const showingArchive = currentPlatform === 'archived';
  if (!summaries?.length) {
    // #18 Better empty states with actionable guidance
    container.innerHTML = showingArchive
      ? '<div class="empty-state"><h2>Archive empty</h2><p>Swipe left or tap 📦 on any conversation to archive it.</p></div>'
      : `<div class="empty-state"><h2>No conversations yet</h2>
          <p>Open a connected site to start capturing messages.</p>
          <div class="empty-actions">
            <button class="empty-action-btn" id="empty-open-sites">Open all sites</button>
            <button class="empty-action-btn" id="empty-clear-filters">Clear filters</button>
          </div></div>`;
    updateTotalUnread(0);
    // Attach empty state action handlers
    const openBtn = container.querySelector('#empty-open-sites');
    if (openBtn) openBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_ALL_SITES' }).catch(() => {}));
    const clearBtn = container.querySelector('#empty-clear-filters');
    if (clearBtn) clearBtn.addEventListener('click', () => { document.getElementById('filter-clear').click(); });
    return;
  }

  let totalUnread = 0;
  container.innerHTML = summaries.map(t => {
    const meta = allThreadMeta.get(t.contactId) || {};
    const rawName = meta.alias || t.contact?.displayName || '';
    const hexId = stripPrefix(t.contactId);
    // If name is just a hex ID or empty, build a display name:
    // 1. User-set alias (from thread meta)
    // 2. LLM-generated nickname (only after 10+ inbound messages)
    // 3. Stats line from profile metadata (e.g. "M, 5'11", 170lb, athletic, top")
    // 4. Truncated hex ID as last resort
    const isHexOnly = !rawName || /^[0-9a-f]{6,}$/i.test(rawName);
    const name = isHexOnly
      ? (meta.generatedNickname || buildStatsLine(t.contact?.metadata) || hexId.slice(0, 8))
      : rawName;
    const initial = name.charAt(0).toUpperCase();
    const preview = t.lastMessage?.body || '';
    // Don't generate nicknames eagerly on render — it floods the LLM queue
    // Nicknames are generated lazily when hovering or opening a thread
    const time = formatTime(t.lastMessage?.timestamp);
    const unread = t.unreadCount || 0;
    totalUnread += unread;

    let badges = '';
    if (meta.rating > 0) badges += '<span class="meta-badge rating">' + '★'.repeat(meta.rating) + '</span>';
    if (meta.deletedChatCount > 0) badges += `<span class="meta-badge deleted" title="${meta.deletedChatCount} deleted messages">🗑${meta.deletedChatCount}</span>`;
    if (meta.bookmarked) badges += '<span class="meta-badge bookmarked">🔖</span>';
    if (meta.autoRespondEnabled) badges += '<span class="meta-badge autorespond">🤖</span>';

    const avatarUrl = t.contact?.avatarUrl;
    // #12 Last active indicator
    const lastSeen = t.contact?.lastSeen ? new Date(t.contact.lastSeen) : null;
    const isRecentlyActive = lastSeen && (Date.now() - lastSeen.getTime()) < 2 * 3600_000;
    const activityDot = `<span class="activity-dot ${isRecentlyActive ? 'active' : 'inactive'}"></span>`;
    const avatarHtml = avatarUrl
      ? `<div class="avatar"><img src="${esc(avatarUrl)}" alt="" class="avatar-img">${activityDot}<span class="platform-dot ${esc(t.platform)}"></span></div>`
      : `<div class="avatar">${esc(initial)}${activityDot}<span class="platform-dot ${esc(t.platform)}"></span></div>`;

    const isActiveSite = activeOnSiteContactId === t.contactId;
    const isBlocked = meta.blockedByThem || false;
    const isFav = meta.favorited || false;
    const distance = t.contact?.metadata?.distance || meta.distance || '';
    const lastDir = t.lastMessage?.direction;
    const dirArrow = lastDir === 'out' ? '<span class="dir-arrow out">▶</span>' : lastDir === 'in' ? '<span class="dir-arrow in">◀</span>' : '';

    return `
      <div class="thread-item${unread ? ' unread' : ''}${isActiveSite ? ' active-on-site' : ''}${isBlocked ? ' blocked' : ''}"
           data-contact-id="${esc(t.contactId)}" data-platform="${esc(t.platform)}" data-name="${esc(name)}">
        ${avatarHtml}<span class="thread-fav${isFav ? ' active' : ''}" data-action="favorite" title="${isFav ? 'Unstar' : 'Star'}">⭐</span>${platformIcon(t.platform)}
        <div class="thread-content">
          <div class="thread-header">
            <span class="thread-name${isBlocked ? ' strikethrough' : ''}">${esc(name)}</span>${distance ? `<span class="thread-distance">${esc(distance)}</span>` : ''}
            <span class="thread-time">${time}${badges ? ' <span class="meta-badges">' + badges + '</span>' : ''}${unread ? ` <span class="unread-badge">${unread}</span>` : ''}</span>
          </div>
          <div class="thread-preview">${dirArrow}${esc(truncate(preview, 65))}${t.totalMessages ? ` <span class="msg-count">(${t.totalMessages})</span>` : ''}</div>
        </div>
        <div class="thread-actions">
          ${showingArchive
            ? `<span class="action-icon" data-action="unarchive" title="Unarchive">↩</span>`
            : `<span class="action-icon" data-action="like" title="Like">👍</span>
               <span class="action-icon" data-action="dislike" title="Pass & hide">👎</span>
               <span class="action-icon${meta.bookmarked ? ' active' : ''}" data-action="bookmark" title="Bookmark">${meta.bookmarked ? '★' : '☆'}</span>
               <span class="action-icon" data-action="notes" title="Notes">📝</span>
               <span class="action-icon" data-action="archive" title="Archive & hide">📦</span>
               <span class="action-icon" data-action="hide" title="Hide until reply">🙈</span>
               <span class="action-icon" data-action="greet" title="Send greeting">👋</span>
               <span class="action-icon${meta.autoRespondEnabled ? ' active' : ''}" data-action="autorespond" title="Auto-respond">🤖</span>`}
        </div>
        <div class="hover-preview" data-preview-for="${esc(t.contactId)}"></div>
      </div>`;
  }).join('');

  updateTotalUnread(totalUnread);

  // Click handlers
  container.querySelectorAll('.thread-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.thread-actions')) return;
      if (e.target.closest('.thread-fav')) return;
      // Click on avatar opens gallery, click elsewhere opens thread
      if (e.target.closest('.avatar')) {
        e.stopPropagation();
        openGallery(el.dataset.contactId, el.dataset.name);
        return;
      }
      openThread(el.dataset.contactId, el.dataset.platform, el.dataset.name);
    });
  });

  // Action icon handlers
  container.querySelectorAll('.action-icon').forEach(icon => {
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = icon.closest('.thread-item');
      const contactId = item.dataset.contactId;
      const platform = item.dataset.platform;
      handleAction(icon.dataset.action, contactId, platform);
    });
  });

  // Favorite star click handlers
  container.querySelectorAll('.thread-fav').forEach(star => {
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = star.closest('.thread-item');
      handleAction('favorite', item.dataset.contactId, item.dataset.platform);
    });
  });

  // Hover preview handlers
  let hoverTimer = null;
  let activePreview = null;
  container.querySelectorAll('.thread-item').forEach(el => {
    el.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        const contactId = el.dataset.contactId;
        const platform = el.dataset.platform;
        const preview = el.querySelector('.hover-preview');
        if (preview && preview !== activePreview) {
          // Close any other open preview
          if (activePreview) { activePreview.classList.remove('active'); activePreview.innerHTML = ''; }
          activePreview = preview;
          loadHoverPreview(contactId, platform, preview, el);
        }
      }, 300); // 300ms delay before loading
    });
    el.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
      // Small delay before closing to allow moving mouse into preview
      hoverTimer = setTimeout(() => {
        if (activePreview && !activePreview.matches(':hover') && !activePreview.closest('.thread-item:hover')) {
          activePreview.classList.remove('active');
          activePreview.innerHTML = '';
          activePreview = null;
        }
      }, 200);
    });
  });
}

// Cache hover preview data to avoid repeated queries.
// v0.57.15: bounded with FIFO eviction. Pre-fix the Map grew unbounded —
// after a long browsing session a heavy user could accumulate hundreds of
// rendered HTML strings in memory (each ~1-3KB).
const hoverPreviewCache = new Map();
const HOVER_CACHE_TTL = 30_000; // 30 seconds
const HOVER_CACHE_MAX_ENTRIES = 100;

function setHoverPreviewCache(contactId, entry) {
  if (hoverPreviewCache.size >= HOVER_CACHE_MAX_ENTRIES) {
    const next = hoverPreviewCache.keys().next();
    if (!next.done) hoverPreviewCache.delete(next.value);
  }
  hoverPreviewCache.set(contactId, entry);
}

async function loadHoverPreview(contactId, platform, previewEl, threadEl) {
  // Check cache first
  const cached = hoverPreviewCache.get(contactId);
  if (cached && Date.now() - cached.ts < HOVER_CACHE_TTL) {
    previewEl.innerHTML = cached.html;
    previewEl.classList.add('active');
    return;
  }

  previewEl.innerHTML = '<div class="hp-loading">Loading...</div>';
  previewEl.classList.add('active');

  try {
    // v0.57.15: avoid the redundant GET_THREAD_SUMMARIES round-trip when
    // possible. The current contact's avatar/displayName/metadata are most
    // efficiently fetched via GET_CONTACT (single PouchDB.get) — that's
    // ~200ms cheaper per hover than re-running the full summaries query
    // (which scans up to 1000 messages on every call).
    const [msgRes, contactRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_MESSAGES_BY_CONTACT', contactId, limit: 6 }),
      chrome.runtime.sendMessage({ type: 'GET_CONTACT', contactId: `contact:${contactId.replace('contact:', '')}` }),
    ]);

    const messages = msgRes?.messages || [];
    const contact = contactRes?.contact;
    const meta = allThreadMeta.get(contactId) || {};
    const md = contact?.metadata || {};

    // Profile section
    const avatar = contact?.avatarUrl;
    const name = meta.alias || contact?.displayName || stripPrefix(contactId);
    const attrs = [];
    if (md.bodyType || md.body) attrs.push(String(md.bodyType || md.body));
    if (md.attitude || md.position) attrs.push(String(md.attitude || md.position));
    if (md.age) attrs.push(md.age + 'yo');
    if (md.height) attrs.push(String(md.height));
    if (md.distance) attrs.push(String(md.distance));

    const pics = [];
    if (avatar) pics.push(avatar);
    if (Array.isArray(md.photos)) pics.push(...md.photos.slice(0, 4));

    // Last few messages (chronological)
    const sorted = [...messages].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    ).slice(-5);

    previewEl.innerHTML = `
      <div class="hp-profile">
        ${avatar ? `<img class="hp-avatar" src="${esc(avatar)}" alt="">` : ''}
        ${platformIcon(platform)}
        <div class="hp-info">
          <div class="hp-name">${esc(name)}</div>
          ${attrs.length ? `<div class="hp-attrs">${attrs.map(a => `<span class="hp-attr">${esc(a)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
      ${pics.length > 1 ? `<div class="hp-pics">${pics.slice(0, 4).map(p => `<img class="hp-pic" src="${esc(p)}" alt="">`).join('')}</div>` : ''}
      ${meta.notes ? `<div class="hp-notes">${esc(truncate(meta.notes, 80))}</div>` : ''}
      <div class="hp-messages">
        ${sorted.length ? sorted.map(m => `
          <div class="hp-msg ${m.direction}">
            <span class="hp-msg-dir">${m.direction === 'out' ? 'You' : 'Them'}:</span>
            ${esc(truncate(m.body, 60))}
            <span class="hp-msg-time">${formatMsgTime(m.timestamp)}</span>
          </div>
        `).join('') : '<div class="hp-empty">No messages</div>'}
      </div>
    `;
    // Cache the rendered preview (v0.57.15: bounded by HOVER_CACHE_MAX_ENTRIES)
    setHoverPreviewCache(contactId, { html: previewEl.innerHTML, ts: Date.now() });
  } catch (err) {
    previewEl.innerHTML = '<div class="hp-loading">Preview unavailable</div>';
  }
}

async function handleAction(action, contactId, platform) {
  switch (action) {
    case 'favorite': {
      const meta = allThreadMeta.get(contactId) || {};
      await chrome.runtime.sendMessage({
        type: 'UPSERT_THREAD_META', contactId, platform,
        updates: { favorited: !meta.favorited },
      });
      loadThreads();
      break;
    }
    case 'like':
      await chrome.runtime.sendMessage({ type: 'RECORD_PREFERENCE', contactId, platform, liked: true });
      break;
    case 'dislike':
      // Record dislike + archive + hide
      await chrome.runtime.sendMessage({ type: 'RECORD_PREFERENCE', contactId, platform, liked: false });
      await chrome.runtime.sendMessage({
        type: 'UPSERT_THREAD_META', contactId, platform,
        updates: { archived: true, hidden: true },
      });
      loadThreads();
      break;
    case 'bookmark': {
      const meta = allThreadMeta.get(contactId) || {};
      await chrome.runtime.sendMessage({
        type: 'UPSERT_THREAD_META', contactId, platform,
        updates: { bookmarked: !meta.bookmarked },
      });
      loadThreads();
      break;
    }
    case 'unarchive':
      await chrome.runtime.sendMessage({
        type: 'UPSERT_THREAD_META', contactId, platform,
        updates: { archived: false, hidden: false },
      });
      loadThreads();
      break;
    case 'archive':
      {
        await chrome.runtime.sendMessage({
          type: 'UPSERT_THREAD_META', contactId, platform,
          updates: { archived: true, hidden: true },
        });
        loadThreads();
      }
      break;
    case 'hide':
      await chrome.runtime.sendMessage({
        type: 'UPSERT_THREAD_META', contactId, platform,
        updates: { hidden: true, hiddenUntilResponse: true },
      });
      loadThreads();
      break;
    case 'greet':
      chrome.runtime.sendMessage({ type: 'SEND_GREETING', platform, contactId });
      break;
    case 'autorespond': {
      const meta = allThreadMeta.get(contactId) || {};
      await chrome.runtime.sendMessage({
        type: 'TOGGLE_AUTO_RESPOND', contactId, platform,
        enabled: !meta.autoRespondEnabled,
      });
      loadThreads();
      break;
    }
    case 'notes':
      openThread(contactId, platform, allThreadMeta.get(contactId)?.alias || stripPrefix(contactId));
      setTimeout(() => {
        document.getElementById('notes-section').style.display = '';
        document.getElementById('notes-input').focus();
      }, 100);
      break;
  }
}

// ── Thread detail ───────────────────────────────────────────────────────────

async function openThread(contactId, platform, displayName) {
  // #13 Save scroll position before opening thread
  const threadList = document.getElementById('thread-list');
  savedScrollTop = threadList.scrollTop;
  currentThread = { contactId, platform, displayName };

  // Nickname generation: only call the LLM after 10+ inbound messages.
  // Before that threshold, the thread list shows a stats line built from
  // profile metadata (age, height, weight, body type, etc.) which is
  // cheaper and more immediately useful than a hex ID stub.
  const hexId = stripPrefix(contactId);

  document.getElementById('header-title').textContent = displayName || stripPrefix(contactId);
  document.body.classList.remove('view-inbox');
  document.body.classList.add('view-thread');
  document.getElementById('suggestions').classList.remove('active');
  document.getElementById('response-input').value = '';

  // Load meta
  const metaRes = await chrome.runtime.sendMessage({ type: 'GET_THREAD_META', contactId });
  currentMeta = metaRes?.meta || {};

  // Show header action icons
  renderHeaderActions();

  // Load notes
  const notesSection = document.getElementById('notes-section');
  const notesInput = document.getElementById('notes-input');
  notesInput.value = currentMeta.notes || '';
  notesSection.style.display = 'none'; // hidden by default, shown via icon

  // Load reminders
  document.getElementById('reminder-section').style.display = 'none';
  loadReminders();

  // Load profile info + dossier
  loadProfileInfo(contactId);
  loadDossier();

  // Navigate parent tab (unless auto-navigate is disabled or contact is deleted/blocked)
  const threadMeta = allThreadMeta.get(contactId) || {};
  if (prefAutoNavigate && !threadMeta.blockedByThem && contactId !== 'sniffies:global-chat') {
    chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_CONVERSATION', platform, contactId }).catch(() => {});
  }
  chrome.runtime.sendMessage({ type: 'MARK_THREAD_READ', threadId: contactId }).catch(() => {});
  // #19 Badge sync — update badge immediately on read
  chrome.runtime.sendMessage({ type: 'GET_UNREAD_COUNT' }).catch(() => {});

  // Load messages — reset scroll state so renderMessages scrolls to bottom
  document.getElementById('message-list').dataset.hasRendered = '';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_MESSAGES_BY_CONTACT', contactId, limit: 500 });
    if (res?.ok) {
      currentMessages = res.messages || [];
      renderMessages(currentMessages);
      loadThreadAnalysis();
      // Generate LLM nickname only after 10+ inbound messages from them
      // (before that, the stats line from metadata is shown instead)
      const inboundCount = currentMessages.filter(m => m.direction === 'in').length;
      const meta = await chrome.runtime.sendMessage({ type: 'GET_THREAD_META', contactId });
      const hasMeta = meta?.meta;
      if (inboundCount >= 10 && !hasMeta?.generatedNickname && !hasMeta?.alias &&
          (!displayName || /^[0-9a-f]{6,}$/i.test(displayName)) && platform === 'sniffies') {
        generateNickname(contactId, platform, null, currentMessages[currentMessages.length - 1]);
      }
    }
  } catch (err) { console.error('[Panel] Message load error:', err); }

  // After the platform tab navigates to this conversation, scrape all visible messages
  // This fills in messages that were missed by the API interceptor
  if (contactId !== 'sniffies:global-chat') {
    const profileId = stripPrefix(contactId);
    setTimeout(async () => {
      try {
        const scrapeRes = await chrome.runtime.sendMessage({
          type: 'SCRAPE_CONVERSATION',
          contactId,
          profileId,
        });
        if (scrapeRes?.count > 0) {
          console.log(`[Panel] Scraped ${scrapeRes.count} messages from conversation`);
          // Reload messages to include newly scraped ones
          const refreshRes = await chrome.runtime.sendMessage({ type: 'GET_MESSAGES_BY_CONTACT', contactId, limit: 500 });
          if (refreshRes?.ok && currentThread?.contactId === contactId) {
            currentMessages = refreshRes.messages || [];
            document.getElementById('message-list').dataset.hasRendered = ''; // force scroll to bottom
            renderMessages(currentMessages);
          }
        }
      } catch {}
    }, 3000); // Wait for SPA navigation to load the conversation
  }
}

async function loadProfileInfo(contactId) {
  const el = document.getElementById('profile-info');
  try {
    // v0.57.28: run both lookups in parallel — they're independent
    const [res, contactRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_THREAD_META', contactId }),
      chrome.runtime.sendMessage({ type: 'GET_CONTACT', contactId: `contact:${contactId.replace('contact:', '')}` }),
    ]);
    const contact = contactRes?.contact;
    const meta = res?.meta || {};

    if (!contact && !meta.alias) { el.classList.remove('active'); return; }
    el.classList.add('active');

    const name = meta.alias || contact?.displayName || stripPrefix(contactId);
    const avatar = contact?.avatarUrl;
    const md = contact?.metadata || {};

    // Build attribute chips from metadata
    const attrs = [];
    if (md.bodyType || md.body) attrs.push(String(md.bodyType || md.body));
    if (md.attitude || md.position) attrs.push(String(md.attitude || md.position));
    if (md.age) attrs.push(`${md.age}yo`);
    if (md.ethnicity) attrs.push(String(md.ethnicity));
    if (md.height) attrs.push(String(md.height));
    if (md.distance) attrs.push(String(md.distance));
    if (md.hosting) attrs.push(`Host: ${md.hosting}`);

    // Collect any pictures from metadata
    const pics = [];
    if (avatar) pics.push(avatar);
    if (Array.isArray(md.photos)) pics.push(...md.photos.slice(0, 5));
    if (md.photoUrl) pics.push(String(md.photoUrl));

    el.innerHTML = `
      <div class="profile-header">
        <div class="profile-avatar">${avatar ? `<img src="${esc(avatar)}" alt="">` : `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:20px;color:#6b7280">${esc(name.charAt(0).toUpperCase())}</span>`}</div>
        <div class="profile-details">
          <div class="profile-name">${esc(name)}</div>
          ${contact?.profileUrl ? `<div style="font-size:10px;color:#6b7280">${esc(contact.platform)}</div>` : ''}
          ${attrs.length ? `<div class="profile-attrs">${attrs.map(a => `<span class="profile-attr">${esc(a)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
      ${pics.length > 1 ? `<div class="profile-pics">${pics.map(p => `<div class="profile-pic"><img src="${esc(p)}" alt=""></div>`).join('')}</div>` : ''}
      ${renderStarRating(contactId, contact?.platform || currentThread?.platform || '', meta.rating || 0)}
      ${meta.deletedChatCount ? `<div style="font-size:10px;color:#ef4444;margin-top:4px">🗑 ${meta.deletedChatCount} deleted messages</div>` : ''}
      ${!avatar ? `<button class="sync-pic-btn" id="sync-this-pic">📷 Sync photos for this profile</button>` : ''}
      ${meta.notes ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px;border-top:1px solid rgba(255,255,255,0.06);padding-top:4px">📝 ${esc(meta.notes)}</div>` : ''}
    `;

    // Per-profile sync handler
    const syncBtn = el.querySelector('#sync-this-pic');
    if (syncBtn) {
      syncBtn.addEventListener('click', async () => {
        syncBtn.textContent = '📷 Syncing...';
        syncBtn.disabled = true;
        // Navigate to the profile page to load their photos
        await chrome.runtime.sendMessage({
          type: 'NAVIGATE_TO_CONVERSATION',
          platform: contact?.platform || currentThread?.platform,
          contactId,
        });
        // Wait for the page to load, then scrape
        setTimeout(async () => {
          try {
            await chrome.runtime.sendMessage({ type: 'SYNC_PROFILE_PICS' });
            syncBtn.textContent = '📷 Done!';
            // Wait a bit for async ADAPTER_CONTACTS → upsertContact to complete
            // The CONTACTS_UPDATED listener will also trigger a refresh
            setTimeout(() => loadProfileInfo(contactId), 2000);
          } catch {
            syncBtn.textContent = '📷 Failed — try opening their profile manually';
          }
        }, 4000);
      });
    }
  } catch {
    el.classList.remove('active');
  }
}

async function loadThreadAnalysis() {
  if (!currentThread || !currentMessages.length) return;

  // Request sentiment + preference + summary from service worker
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ANALYZE_THREAD',
      contactId: currentThread.contactId,
      messages: currentMessages.slice(-50).map(m => ({
        direction: m.direction, body: m.body, timestamp: m.timestamp,
      })),
      platform: currentThread.platform,
      contactName: currentThread.displayName || stripPrefix(currentThread.contactId),
    });

    if (res?.ok) {
      renderSentiment(res.sentiment);
      renderPreference(res.preference);
      renderSummary(res.summary);
    }
  } catch (err) { console.warn('[Panel] Analysis error:', err); }
}

function renderSentiment(s) {
  if (!s) return;
  const el = document.getElementById('sentiment-display');
  const barHtml = (label, value) => {
    const pct = Math.round(value * 100);
    const cls = pct > 65 ? 'high' : pct > 35 ? 'medium' : 'low';
    return `<div class="sentiment-bar">
      <span class="sentiment-bar-label">${label}</span>
      <div class="sentiment-bar-track"><div class="sentiment-bar-fill ${cls}" style="width:${pct}%"></div></div>
      <span style="font-size:10px;color:#9ca3af;min-width:28px;text-align:right">${pct}%</span>
    </div>`;
  };
  el.innerHTML = barHtml('Interest', s.interest) + barHtml('Engaged', s.engagement) +
    barHtml('Commit', s.commitment) +
    (s.signals?.length ? `<div class="sentiment-signals">${s.signals.slice(0, 3).join(' | ')}</div>` : '');
}

function renderPreference(p) {
  if (!p) return;
  const el = document.getElementById('preference-display');
  const pct = Math.round(p.score * 100);
  const cls = pct > 60 ? 'like' : pct > 40 ? 'neutral' : 'dislike';
  const label = pct > 60 ? 'Likely match' : pct > 40 ? 'Uncertain' : 'Unlikely match';
  el.innerHTML = `<span class="pref-score ${cls}">${pct}%</span> ${label}` +
    (p.confidence < 0.3 ? `<div class="pref-confidence">Low confidence (need more feedback)</div>` : '');
}

function renderSummary(summary) {
  if (!summary) return;
  const el = document.getElementById('convo-summary');
  el.textContent = summary.text || 'No summary available';
  const commitEl = document.getElementById('commitments-section');
  if (summary.commitments?.length) {
    commitEl.style.display = '';
    document.getElementById('commitments-display').innerHTML =
      summary.commitments.map(c => `<div>- ${esc(c)}</div>`).join('');
  } else {
    commitEl.style.display = 'none';
  }
}

// Preference buttons (no inline onclick)
document.getElementById('pref-like').addEventListener('click', () => recordPrefAction(true));
document.getElementById('pref-dislike').addEventListener('click', () => recordPrefAction(false));

async function recordPrefAction(liked) {
  if (!currentThread) return;
  await chrome.runtime.sendMessage({
    type: 'RECORD_PREFERENCE',
    contactId: currentThread.contactId,
    platform: currentThread.platform,
    liked,
  });
  loadThreadAnalysis();
}

function renderHeaderActions() {
  const container = document.getElementById('header-actions');
  const m = currentMeta || {};
  // Toolbar display mode: icon, icon-text, or text
  const mode = prefToolbarMode;
  function tb(icon, label, extra = '') {
    if (mode === 'text') return `<span class="action-icon toolbar-text${extra}" data-action="${label.toLowerCase()}" title="${label}">${label}</span>`;
    if (mode === 'icon-text') return `<span class="action-icon toolbar-icon-text${extra}" data-action="${label.toLowerCase()}" title="${label}">${icon} ${label}</span>`;
    return `<span class="action-icon${extra}" data-action="${label.toLowerCase()}" title="${label}">${icon}</span>`;
  }
  container.innerHTML = `
    ${tb(m.bookmarked ? '★' : '☆', 'Bookmark', m.bookmarked ? ' active' : '')}
    ${tb('📝', 'Notes')}
    ${tb('📋', 'Dossier')}
    ${tb('⏰', 'Reminder')}
    ${tb('📦', 'Archive')}
    ${tb('🙈', 'Hide')}
    ${tb('👋', 'Greet')}
    ${tb('🤖', 'Autorespond', m.autoRespondEnabled ? ' active' : '')}
  `;
  container.querySelectorAll('.action-icon').forEach(icon => {
    icon.addEventListener('click', () => {
      const action = icon.dataset.action;
      if (action === 'notes') {
        const sec = document.getElementById('notes-section');
        sec.style.display = sec.style.display === 'none' ? '' : 'none';
        if (sec.style.display !== 'none') document.getElementById('notes-input').focus();
      } else if (action === 'reminder') {
        const sec = document.getElementById('reminder-section');
        sec.style.display = sec.style.display === 'none' ? '' : 'none';
      } else if (action === 'dossier') {
        const sec = document.getElementById('dossier-section');
        sec.style.display = sec.style.display === 'none' ? '' : 'none';
      } else {
        handleAction(action, currentThread.contactId, currentThread.platform);
      }
    });
  });
}

function renderMessages(messages) {
  const container = document.getElementById('message-list');
  if (!messages?.length) {
    // #18 Better empty state for messages
    container.innerHTML = '<div class="empty-state"><p>No messages yet.</p><p class="empty-hint">Open their profile on the platform to sync conversation history.</p></div>';
    return;
  }
  const sorted = [...messages].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Detect global/group chat — if messages come from many different senders
  const isGlobalChat = currentThread?.contactId?.includes('global') ||
    currentThread?.contactId?.includes('group') ||
    isMultiSenderThread(sorted);

  const hiddenMsgs = new Set(JSON.parse(localStorage.getItem('aggregaytor_hidden_msgs') || '[]'));

  if (isGlobalChat) {
    container.innerHTML = sorted.map(msg => renderGlobalChatMessage(msg)).join('');
    // Click avatar in global chat to open that sender's profile
    container.querySelectorAll('.msg-global-avatar[data-profile-id]').forEach(el => {
      el.addEventListener('click', () => {
        const pid = el.dataset.profileId;
        if (pid && pid.length > 5) {
          chrome.runtime.sendMessage({
            type: 'NAVIGATE_TO_CONVERSATION', platform: 'sniffies', contactId: `sniffies:${pid}`,
          }).catch(() => {});
        }
      });
    });
  } else {
    let lastDate = '';
    container.innerHTML = sorted.map(msg => {
      const msgDate = formatDate(msg.timestamp);
      let sep = '';
      if (msgDate !== lastDate) { lastDate = msgDate; sep = `<div class="msg-date-sep">${msgDate}</div>`; }
      const dir = msg.direction || 'in';
      const hidden = hiddenMsgs.has(msg._id || msg.id);
      const isFromGC = msg.metadata?.fromGlobalChat;
      return `${sep}<div class="msg-wrapper${hidden ? ' msg-hidden' : ''}" data-msg-id="${esc(msg._id || msg.id || '')}">
        <span class="msg-toggle" title="${hidden ? 'Show' : 'Hide'}">${hidden ? '+' : '−'}</span>
        ${isFromGC ? '<div class="msg-gc-tag">🌐 from Global Chat</div>' : ''}
        <div class="msg-bubble ${dir}">${esc(msg.body || '')}</div>
        <div class="msg-time ${dir}">${formatMsgTime(msg.timestamp)}</div>
        <div class="msg-hidden-label" style="display:${hidden ? 'block' : 'none'}">Message hidden</div>
      </div>`;
    }).join('');
  }
  // #6 Auto-scroll lock — only scroll to bottom if user is already near bottom
  const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  if (isNearBottom || !container.dataset.hasRendered) {
    container.scrollTop = container.scrollHeight;
    container.dataset.hasRendered = '1';
  }

  // Attach hide toggle handlers
  container.querySelectorAll('.msg-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrapper = btn.closest('.msg-wrapper');
      const msgId = wrapper?.dataset.msgId;
      if (!msgId) return;
      const hidden = wrapper.classList.toggle('msg-hidden');
      btn.textContent = hidden ? '+' : '−';
      wrapper.querySelector('.msg-hidden-label').style.display = hidden ? 'block' : 'none';
      // Persist hidden state
      const set = new Set(JSON.parse(localStorage.getItem('aggregaytor_hidden_msgs') || '[]'));
      if (hidden) set.add(msgId); else set.delete(msgId);
      // v0.57.28: cap at 1000 entries with FIFO eviction to prevent unbounded growth
      if (set.size > 1000) {
        const arr = [...set];
        const trimmed = arr.slice(arr.length - 1000);
        set.clear();
        for (const id of trimmed) set.add(id);
      }
      localStorage.setItem('aggregaytor_hidden_msgs', JSON.stringify([...set]));
    });
  });
}

function isMultiSenderThread(messages) {
  // If there are 3+ distinct sender IDs in metadata, it's probably a group/global chat
  const senders = new Set();
  for (const m of messages) {
    const sender = m.metadata?.senderId || m.metadata?.author || m.metadata?.profileId || '';
    if (sender) senders.add(sender);
    if (senders.size >= 3) return true;
  }
  return false;
}

function renderGlobalChatMessage(msg) {
  const md = msg.metadata || {};
  const senderId = md.profileId || md.senderId || '';

  // Use the full attributes string from scraper if available, otherwise build from parts
  let attrStr = md.attrs || '';
  if (!attrStr) {
    const parts = [];
    if (md.age) parts.push(md.age);
    if (md.height) parts.push(md.height);
    if (md.weight) parts.push(md.weight);
    if (md.bodyType || md.body) parts.push(String(md.bodyType || md.body));
    if (md.attitude || md.position) parts.push(String(md.attitude || md.position));
    if (md.ethnicity) parts.push(String(md.ethnicity));
    attrStr = parts.filter(Boolean).join(', ');
  }

  const avatar = md.avatarUrl || md.avatar || '';
  const time = md.timeText || formatTime(msg.timestamp);
  const distance = md.distance || '';
  const senderName = md.displayName || attrStr || senderId.slice(0, 10);

  return `
    <div class="msg-global" data-sender-id="${esc(senderId)}">
      <div class="msg-global-avatar" style="cursor:pointer" title="Open profile" data-profile-id="${esc(senderId)}">
        ${avatar ? `<img src="${esc(avatar)}" alt="">` : `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#6b7280;font-size:14px">?</div>`}
      </div>
      <div class="msg-global-content">
        <div class="msg-global-header">
          <span class="msg-global-attrs">${esc(attrStr || senderName)}</span>
          <span class="msg-global-meta">${esc(time)}${distance ? ', ' + esc(distance) : ''}</span>
        </div>
        <div class="msg-global-body">${esc(msg.body || '')}</div>
      </div>
    </div>`;
}

// ── Draft review ────────────────────────────────────────────────────────────

async function loadDrafts() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_DRAFTS' });
    const drafts = res?.drafts || [];
    const bar = document.getElementById('draft-bar');
    const count = document.getElementById('draft-count');
    if (drafts.length) {
      bar.style.display = ''; count.textContent = drafts.length;
    } else {
      bar.style.display = 'none';
      document.getElementById('draft-panel').style.display = 'none';
    }
    return drafts;
  } catch { return []; }
}

// Draft bar click handler
document.getElementById('draft-bar').addEventListener('click', toggleDraftPanel);

async function toggleDraftPanel() {
  const panel = document.getElementById('draft-panel');
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  const drafts = await loadDrafts();
  if (!drafts.length) { panel.style.display = 'none'; return; }
  panel.innerHTML = drafts.map(d => {
    const name = d.contactId.replace(/^[a-z]+:/, '').slice(0, 12);
    return `
      <div class="draft-item ${d.tier}">
        <div class="draft-header">
          <span>${esc(name)} (${d.platform})</span>
          <span class="draft-tier ${d.tier}">${d.tier}</span>
        </div>
        <div class="draft-body" contenteditable="true" data-id="${d._id}">${esc(d.generatedResponse)}</div>
        ${d.suggestedPictureTag ? `<div style="font-size:10px;color:#6b7280">Picture: ${esc(d.suggestedPictureTag)}</div>` : ''}
        <div class="draft-actions">
          <button class="draft-btn approve" data-approve-draft="${d._id}">Approve & Send</button>
          <button class="draft-btn reject" data-reject-draft="${d._id}">Reject</button>
        </div>
      </div>`;
  }).join('');
  panel.style.display = '';
  // Attach approve/reject handlers
  panel.querySelectorAll('[data-approve-draft]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const body = btn.closest('.draft-item').querySelector('.draft-body');
      const editedResponse = body?.textContent?.trim();
      await chrome.runtime.sendMessage({ type: 'APPROVE_DRAFT', id: btn.dataset.approveDraft, editedResponse });
      loadDrafts();
    });
  });
  panel.querySelectorAll('[data-reject-draft]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'REJECT_DRAFT', id: btn.dataset.rejectDraft });
      loadDrafts();
    });
  });
}

// ── Thread toolbar ──────────────────────────────────────────────────────────

document.getElementById('btn-resync').addEventListener('click', async () => {
  if (!currentThread) return;
  const btn = document.getElementById('btn-resync');
  btn.textContent = '↻ Syncing...';
  btn.disabled = true;

  // Navigate to the conversation on the platform to trigger fresh API intercepts
  await chrome.runtime.sendMessage({
    type: 'NAVIGATE_TO_CONVERSATION',
    platform: currentThread.platform,
    contactId: currentThread.contactId,
  });

  // Wait a few seconds for the adapter to capture fresh messages, then reload
  setTimeout(async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GET_MESSAGES_BY_CONTACT', contactId: currentThread.contactId, limit: 500,
      });
      if (res?.ok) { currentMessages = res.messages || []; renderMessages(currentMessages); }
    } catch {}
    btn.textContent = '↻ Resync';
    btn.disabled = false;
  }, 4000);
});

document.getElementById('btn-archive-thread').addEventListener('click', async () => {
  if (!currentThread) return;
  await chrome.runtime.sendMessage({
    type: 'UPSERT_THREAD_META',
    contactId: currentThread.contactId,
    platform: currentThread.platform,
    updates: { archived: true, hidden: true },
  });
  goBack();
});

// #9 Export conversation
document.getElementById('btn-export').addEventListener('click', () => {
  if (!currentThread || !currentMessages.length) return;
  const sorted = [...currentMessages].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const name = currentThread.displayName || stripPrefix(currentThread.contactId);
  const lines = sorted.map(m => {
    const who = m.direction === 'out' ? 'You' : name;
    const time = new Date(m.timestamp).toLocaleString();
    return `[${time}] ${who}: ${m.body || ''}`;
  });
  const text = `Conversation with ${name} (${currentThread.platform})\nExported ${new Date().toLocaleString()}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}-${currentThread.platform}-export.txt`;
  a.click(); URL.revokeObjectURL(url);
});

document.getElementById('btn-clear-thread').addEventListener('click', async () => {
  if (!currentThread) return;
  if (!confirm('Clear all stored messages for this conversation? This cannot be undone.')) return;

  await chrome.runtime.sendMessage({
    type: 'CLEAR_THREAD_MESSAGES',
    contactId: currentThread.contactId,
  });
  currentMessages = [];
  renderMessages([]);
});

function goBack() {
  currentThread = null; currentMessages = []; currentMeta = null;
  document.body.classList.remove('view-thread');
  document.body.classList.add('view-inbox');
  document.getElementById('header-title').innerHTML = `<span class="version-tag">v${(chrome.runtime.getManifest?.().version || '0.0').replace(/\.\d+$/, '')}</span>`;
  document.getElementById('suggestions').classList.remove('active');
  document.getElementById('notes-section').style.display = 'none';
  document.getElementById('reminder-section').style.display = 'none';
  loadThreads().then(() => {
    // #13 Restore scroll position after thread list re-renders
    document.getElementById('thread-list').scrollTop = savedScrollTop;
  });
}

// ── Notes ───────────────────────────────────────────────────────────────────

let notesSaveTimer = null;
document.getElementById('notes-input').addEventListener('input', () => {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(saveNotes, 1000);
});
document.getElementById('notes-input').addEventListener('blur', saveNotes);

async function saveNotes() {
  if (!currentThread) return;
  const notes = document.getElementById('notes-input').value;
  await chrome.runtime.sendMessage({
    type: 'UPSERT_THREAD_META',
    contactId: currentThread.contactId,
    platform: currentThread.platform,
    updates: { notes },
  });
}

// ── Dossier ─────────────────────────────────────────────────────────────────

const DOSSIER_FIELDS = [
  { key: 'realName', label: 'Real Name', type: 'text' },
  { key: 'birthYear', label: 'Birth Year', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'address', label: 'Address', type: 'text', full: true },
  { key: 'hometown', label: 'From', type: 'text' },
  { key: 'employer', label: 'Work', type: 'text' },
  { key: 'schedule', label: 'Schedule', type: 'text', full: true },
  { key: 'relationshipStatus', label: 'Status', type: 'text' },
  { key: 'position', label: 'Position', type: 'text' },
  { key: 'kinks', label: 'Kinks', type: 'text', full: true, isArray: true },
  { key: 'metInPerson', label: 'Met IRL', type: 'select', options: ['', 'Yes', 'No'] },
  { key: 'meetingNotes', label: 'Meeting Notes', type: 'textarea', full: true },
  { key: 'wouldMeetAgain', label: 'Meet Again?', type: 'select', options: ['', 'Yes', 'No', 'Maybe'] },
  { key: 'wouldDate', label: 'Date?', type: 'select', options: ['', 'Yes', 'No', 'Maybe'] },
  { key: 'hasTransportation', label: 'Transport', type: 'select', options: ['', 'Yes', 'No'] },
  { key: 'hasDog', label: 'Has Dog', type: 'select', options: ['', 'Yes', 'No'] },
  { key: 'isInHotel', label: 'Hotel', type: 'select', options: ['', 'Yes', 'No'] },
  { key: 'sentAddressToThem', label: 'Sent Addr', type: 'select', options: ['', 'Yes', 'No'] },
  { key: 'owesMeMoney', label: 'Owes $', type: 'number' },
  { key: 'paidForAnything', label: 'Paid For', type: 'text', full: true },
  { key: 'isRealOrBot', label: 'Real/Bot', type: 'select', options: ['unknown', 'real', 'bot', 'suspicious'] },
  { key: 'ghostCount', label: 'Ghosted', type: 'number' },
  { key: 'otherProfileLinks', label: 'Other Profiles', type: 'textarea', full: true, isArray: true },
  { key: 'partnerNames', label: 'Partners', type: 'text', isArray: true },
];

async function loadDossier() {
  if (!currentThread) return;
  const section = document.getElementById('dossier-section');
  const container = document.getElementById('dossier-fields');

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_DOSSIER', contactId: currentThread.contactId });
    const d = res?.dossier || {};

    section.style.display = '';
    // Restore expanded state from session
    if (sessionStorage.getItem('dossier_expanded') === '1') {
      section.classList.add('expanded');
    } else {
      section.classList.remove('expanded');
    }
    container.innerHTML = DOSSIER_FIELDS.map(f => {
      const val = d[f.key];
      const displayVal = f.isArray ? (Array.isArray(val) ? val.join(', ') : String(val || '')) : String(val ?? '');
      const autoInfo = d.autoExtracted?.[f.key];
      const badge = autoInfo ? `<span class="auto-badge" title="Auto-extracted ${autoInfo.extractedAt}">⚡</span>` : '';

      if (f.type === 'select') {
        const options = f.options.map(o => `<option value="${o}"${displayVal === o || (displayVal === 'true' && o === 'Yes') || (displayVal === 'false' && o === 'No') ? ' selected' : ''}>${o || '—'}</option>`).join('');
        return `<div class="dossier-field${f.full ? ' full-width' : ''}"><label>${f.label}${badge}</label><select data-dossier-field="${f.key}">${options}</select></div>`;
      }
      if (f.type === 'textarea') {
        return `<div class="dossier-field${f.full ? ' full-width' : ''}"><label>${f.label}${badge}</label><textarea data-dossier-field="${f.key}" rows="2">${esc(displayVal)}</textarea></div>`;
      }
      if (f.type === 'number') {
        return `<div class="dossier-field"><label>${f.label}${badge}</label><input type="number" data-dossier-field="${f.key}" value="${esc(displayVal)}"></div>`;
      }
      return `<div class="dossier-field${f.full ? ' full-width' : ''}"><label>${f.label}${badge}</label><input type="text" data-dossier-field="${f.key}" value="${esc(displayVal)}"></div>`;
    }).join('');

    // Auto-save on change
    container.querySelectorAll('[data-dossier-field]').forEach(el => {
      el.addEventListener('change', saveDossierField);
      el.addEventListener('blur', saveDossierField);
    });
  } catch {
    section.style.display = 'none';
  }
}

async function saveDossierField(e) {
  if (!currentThread) return;
  const el = e.target;
  const field = el.dataset.dossierField;
  const fieldDef = DOSSIER_FIELDS.find(f => f.key === field);
  let value = el.value;

  // Convert arrays
  if (fieldDef?.isArray) {
    value = value.split(',').map(s => s.trim()).filter(Boolean);
  }
  // Convert booleans
  if (value === 'Yes') value = true;
  if (value === 'No') value = false;

  await chrome.runtime.sendMessage({
    type: 'UPSERT_DOSSIER',
    contactId: currentThread.contactId,
    platform: currentThread.platform,
    updates: { [field]: value },
  });
}

document.getElementById('dossier-extract').addEventListener('click', async () => {
  if (!currentThread) return;
  const btn = document.getElementById('dossier-extract');
  btn.textContent = 'Extracting...';
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'EXTRACT_DOSSIER',
      contactId: currentThread.contactId,
      platform: currentThread.platform,
      contactName: currentThread.displayName,
    });
    if (res?.ok) {
      btn.textContent = `Found ${res.fieldCount} fields`;
      loadDossier(); // refresh
    } else {
      btn.textContent = 'Failed';
    }
  } catch {
    btn.textContent = 'Error';
  }
  setTimeout(() => { btn.textContent = 'Auto-fill from chat'; btn.disabled = false; }, 2000);
});

// ── Reminders ───────────────────────────────────────────────────────────────

document.getElementById('reminder-save').addEventListener('click', async () => {
  if (!currentThread) return;
  const datetime = document.getElementById('reminder-datetime').value;
  const note = document.getElementById('reminder-note').value.trim();
  if (!datetime) return;
  await chrome.runtime.sendMessage({
    type: 'CREATE_REMINDER',
    contactId: currentThread.contactId,
    platform: currentThread.platform,
    note: note || 'Reminder',
    dueAt: new Date(datetime).toISOString(),
  });
  document.getElementById('reminder-datetime').value = '';
  document.getElementById('reminder-note').value = '';
  loadReminders();
});

async function loadReminders() {
  if (!currentThread) return;
  const res = await chrome.runtime.sendMessage({
    type: 'GET_REMINDERS', opts: { contactId: currentThread.contactId },
  });
  const list = document.getElementById('reminder-list');
  if (!res?.ok || !res.reminders?.length) { list.innerHTML = ''; return; }
  list.innerHTML = res.reminders.map(r => `
    <div class="reminder-item">
      <span>${esc(r.note)} — ${new Date(r.dueAt).toLocaleString()}</span>
      <button class="reminder-delete" data-id="${r._id}">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('.reminder-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'DELETE_REMINDER', id: btn.dataset.id });
      loadReminders();
    });
  });
}

// ── Suggestions ─────────────────────────────────────────────────────────────

async function generateSuggestions() {
  if (!currentThread || !currentMessages.length) return;
  const btn = document.getElementById('suggest-btn');
  btn.disabled = true; btn.textContent = 'Thinking...';
  const suggestionsEl = document.getElementById('suggestions');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_SUGGESTIONS',
      messages: currentMessages.slice(-30).map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })),
      contactName: currentThread.displayName || stripPrefix(currentThread.contactId),
      platform: currentThread.platform,
    });
    const suggestions = res?.suggestions || ['Hey', 'Sounds good'];
    const label = res?.provider && res.provider !== 'local' ? ` via ${res.provider}` : '';
    suggestionsEl.innerHTML = `<div class="label">Suggested${label}</div>` +
      suggestions.map(s => `<div class="suggestion-chip">${esc(s)}</div>`).join('');
    suggestionsEl.classList.add('active');
    suggestionsEl.querySelectorAll('.suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.getElementById('response-input').value = chip.textContent;
        suggestionsEl.classList.remove('active');
      });
    });
  } catch (err) {
    suggestionsEl.innerHTML = '<div class="label">Error generating suggestions</div>';
    suggestionsEl.classList.add('active');
  }
  btn.disabled = false; btn.textContent = 'Suggest';
}

// ── Filters ─────────────────────────────────────────────────────────────────

document.getElementById('filter-toggle').addEventListener('click', () => {
  const panel = document.getElementById('filter-panel');
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
});

function readFilters() {
  filters.searchText = document.getElementById('filter-search').value.trim();
  filters.bodyType = Array.from(document.getElementById('filter-body').selectedOptions).map(o => o.value);
  filters.position = Array.from(document.getElementById('filter-position').selectedOptions).map(o => o.value);
  filters.minDeleteCount = parseInt(document.getElementById('filter-deletes').value) || 0;
  filters.maxDistance = parseInt(document.getElementById('filter-distance').value) || 0;
  filters.unreadOnly = document.getElementById('filter-unread').checked;
  filters.newChatsOnly = document.getElementById('filter-newchats').checked;
  filters.hasResponded = document.getElementById('filter-responded').checked;
  filters.engagedRecently = document.getElementById('filter-recent').checked;
  filters.bookmarked = document.getElementById('filter-bookmarked').checked;
  filters.favoritesOnly = document.getElementById('filter-favorites').checked;

  const count = (filters.searchText ? 1 : 0) + filters.bodyType.length + filters.position.length +
    (filters.minDeleteCount ? 1 : 0) + (filters.maxDistance ? 1 : 0) +
    (filters.unreadOnly ? 1 : 0) + (filters.newChatsOnly ? 1 : 0) +
    (filters.hasResponded ? 1 : 0) + (filters.engagedRecently ? 1 : 0) + (filters.bookmarked ? 1 : 0) +
    (filters.favoritesOnly ? 1 : 0);
  const badge = document.getElementById('filter-count');
  if (count) { badge.textContent = count; badge.style.display = ''; } else { badge.style.display = 'none'; }

  loadThreads();
}

for (const id of ['filter-search', 'filter-body', 'filter-position', 'filter-deletes', 'filter-distance']) {
  document.getElementById(id).addEventListener('change', readFilters);
}
document.getElementById('filter-search').addEventListener('input', readFilters);
for (const id of ['filter-responded', 'filter-recent', 'filter-bookmarked', 'filter-unread', 'filter-newchats', 'filter-favorites']) {
  document.getElementById(id).addEventListener('change', readFilters);
}
document.getElementById('sort-by').addEventListener('change', (e) => {
  currentSort = e.target.value;
  loadThreads();
});
document.getElementById('filter-clear').addEventListener('click', () => {
  document.getElementById('filter-search').value = '';
  document.getElementById('filter-body').selectedIndex = -1;
  document.getElementById('filter-position').selectedIndex = -1;
  document.getElementById('filter-deletes').value = '0';
  document.getElementById('filter-distance').value = '0';
  document.getElementById('filter-unread').checked = false;
  document.getElementById('filter-newchats').checked = false;
  document.getElementById('filter-responded').checked = false;
  document.getElementById('filter-recent').checked = false;
  document.getElementById('filter-bookmarked').checked = false;
  document.getElementById('filter-favorites').checked = false;
  readFilters();
});

// ── Event listeners ─────────────────────────────────────────────────────────

document.getElementById('back-btn').addEventListener('click', () => {
  if (settingsOpen) closeSettings();
  else goBack();
});
document.querySelectorAll('.platform-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const platform = chip.dataset.platform;

    if (platform === 'all') {
      // "All" clears all individual selections and shows everything
      activePlatforms.clear();
      document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentPlatform = 'all';
    } else if (platform === 'archived') {
      // Archive is exclusive (not a toggle with others)
      activePlatforms.clear();
      document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentPlatform = 'archived';
    } else {
      // Platform chips are TOGGLES — click to add/remove from the active set
      // Remove "All" active state when toggling individual platforms
      document.querySelector('.platform-chip[data-platform="all"]')?.classList.remove('active');
      document.querySelector('.platform-chip[data-platform="archived"]')?.classList.remove('active');

      if (activePlatforms.has(platform)) {
        activePlatforms.delete(platform);
        chip.classList.remove('active');
      } else {
        activePlatforms.add(platform);
        chip.classList.add('active');
      }

      // If no platforms selected, revert to "All"
      if (activePlatforms.size === 0) {
        document.querySelector('.platform-chip[data-platform="all"]')?.classList.add('active');
        currentPlatform = 'all';
      } else {
        currentPlatform = 'multi'; // signal that we're using activePlatforms set
      }
    }
    loadThreads();
  });
});
document.getElementById('suggest-btn').addEventListener('click', generateSuggestions);

const textarea = document.getElementById('response-input');
textarea.addEventListener('input', () => {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'NEW_MESSAGES') {
    if (document.body.classList.contains('view-inbox')) debouncedLoadThreads();
    else if (currentThread && message.platform === currentThread.platform) {
      debouncedReloadThread();
    }
    debouncedLoadDrafts();
  }
  if (message.type === 'DRAFTS_UPDATED') loadDrafts();
  if (message.type === 'PROFILE_CLOSED') {
    // User left the profile/chat view on the platform (e.g., clicked map)
    // Go back to inbox if we're in a thread view
    activeOnSiteContactId = null;
    if (document.body.classList.contains('view-thread')) {
      goBack();
    }
  }
  if (message.type === 'ACTIVE_PROFILE_CHANGED') {
    activeOnSiteContactId = message.contactId || null;
    // Mark as read since user is looking at it on the site
    if (message.contactId) {
      chrome.runtime.sendMessage({ type: 'MARK_THREAD_READ', threadId: message.contactId }).catch(() => {});
    }
    // Auto-open the conversation in the side panel when the user opens
    // a profile or chat on the platform site. This keeps the side panel
    // in sync with what's on screen.
    if (message.contactId && message.contactId !== 'sniffies:global-chat') {
      const platform = message.platform || message.contactId.split(':')[0] || '';
      const existingThread = currentThread?.contactId;
      // Only auto-open if we're in inbox view OR viewing a different thread
      if (!existingThread || existingThread !== message.contactId) {
        openThread(message.contactId, platform, '');
      }
    } else {
      // No specific profile — go back to inbox if we're in a thread
      if (document.body.classList.contains('view-inbox')) loadThreads();
    }
  }
  if (message.type === 'CONTACTS_UPDATED') {
    // Don't auto-refresh on every contact update — these fire constantly
    // from userJoined events. The thread list will refresh on next
    // NEW_MESSAGES event or manual navigation. Avatar updates from
    // explicit photo sync are handled by the sync button's own reload.
  }
  if (message.type === 'COMMITMENT_ALERT') {
    // Flash the screen and play alert sound
    document.body.style.animation = 'commitFlash 0.5s ease 3';
    setTimeout(() => { document.body.style.animation = ''; }, 1600);
    try { new Audio('data:audio/wav;base64,UklGRlQFAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YTAFAABkAGQA').play(); } catch {}
  }
});

// ── Nickname generation ─────────────────────────────────────────────────────

const nicknameQueue = new Set();

async function generateNickname(contactId, platform, contact, lastMessage) {
  if (nicknameQueue.has(contactId)) return;
  // v0.57.28: cap at 50 with FIFO eviction to prevent memory leak
  if (nicknameQueue.size >= 50) {
    const oldest = nicknameQueue.values().next().value;
    if (oldest) nicknameQueue.delete(oldest);
  }
  nicknameQueue.add(contactId);

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_NICKNAME',
      contactId, platform,
      metadata: contact?.metadata || {},
      lastMessageBody: lastMessage?.body || '',
      avatarUrl: contact?.avatarUrl || '',
    });
    if (res?.ok && res.nickname) {
      await chrome.runtime.sendMessage({
        type: 'UPSERT_THREAD_META', contactId, platform,
        updates: { generatedNickname: res.nickname },
      });
      // Refresh the thread list to show the new nickname
      loadThreads();
    }
  } catch {}
  nicknameQueue.delete(contactId);
}

// ── Global auto-respond ─────────────────────────────────────────────────────

const globalARCheckbox = document.getElementById('global-ar-checkbox');
globalARCheckbox.addEventListener('change', async () => {
  if (globalARCheckbox.checked) {
    // Show session startup dialog instead of immediately enabling
    globalARCheckbox.checked = false; // revert until confirmed
    showSessionDialog();
  } else {
    // Disable all auto-respond
    await toggleAllAutoRespond(false);
    document.getElementById('session-dialog').style.display = 'none';
  }
});

async function toggleAllAutoRespond(enabled) {
  const metaRes = await chrome.runtime.sendMessage({ type: 'GET_ALL_THREAD_META' });
  const summRes = await chrome.runtime.sendMessage({ type: 'GET_THREAD_SUMMARIES', opts: {} });
  const allContacts = new Set();
  for (const s of summRes?.summaries || []) allContacts.add(s.contactId + ':' + s.platform);
  for (const m of metaRes?.metas || []) allContacts.add(m.contactId + ':' + m.platform);
  for (const key of allContacts) {
    const [contactId, platform] = [key.substring(0, key.lastIndexOf(':')), key.substring(key.lastIndexOf(':') + 1)];
    // Never enable auto-respond on global chat — it's a broadcast feed
    if (contactId.endsWith(':global-chat')) continue;
    await chrome.runtime.sendMessage({ type: 'TOGGLE_AUTO_RESPOND', contactId, platform, enabled });
  }
  await chrome.storage.local.set({ aggregaytor_global_autorespond: enabled });
  loadThreads();
}

async function showSessionDialog() {
  const dialog = document.getElementById('session-dialog');
  dialog.style.display = '';

  // Load calendar availability
  const slotsEl = document.getElementById('session-slots');
  slotsEl.textContent = 'Checking calendar...';
  try {
    const deadline = getDeadlineHours();
    const from = new Date().toISOString();
    const to = new Date(Date.now() + deadline * 3600_000).toISOString();
    const res = await chrome.runtime.sendMessage({ type: 'GET_AVAILABLE_SLOTS', from, to });
    if (res?.ok && res.slots?.length) {
      slotsEl.innerHTML = res.slots.map(s => `<span class="slot">${s.label}</span>`).join('');
    } else {
      slotsEl.innerHTML = '<span style="color:#6b7280">No calendar connected or all slots free</span>';
    }
  } catch {
    slotsEl.innerHTML = '<span style="color:#6b7280">Calendar not connected</span>';
  }

  // Generate preference summary via LLM
  const summaryEl = document.getElementById('session-summary');
  summaryEl.textContent = 'Generating summary...';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GENERATE_SESSION_SUMMARY' });
    if (res?.ok) {
      summaryEl.textContent = res.summary || 'Ready to auto-respond to all conversations.';
    } else {
      summaryEl.textContent = 'Ready to auto-respond to all active conversations.';
    }
  } catch {
    summaryEl.textContent = 'Ready to auto-respond to all active conversations.';
  }
}

function getDeadlineHours() {
  const val = document.getElementById('session-deadline').value;
  if (val === '0') { // "Tonight" — calculate hours until midnight
    const now = new Date();
    return Math.max(1, (24 - now.getHours()));
  }
  if (val === '-1') return 24; // no deadline = 24h
  return parseInt(val) || 2;
}

document.getElementById('session-confirm').addEventListener('click', async () => {
  globalARCheckbox.checked = true;
  document.getElementById('session-dialog').style.display = 'none';
  await toggleAllAutoRespond(true);
});

document.getElementById('session-cancel').addEventListener('click', () => {
  document.getElementById('session-dialog').style.display = 'none';
  globalARCheckbox.checked = false;
});

document.getElementById('session-deadline').addEventListener('change', () => {
  // Refresh calendar slots when deadline changes
  showSessionDialog();
});

// Load global AR state
chrome.storage.local.get('aggregaytor_global_autorespond').then(data => {
  globalARCheckbox.checked = !!data.aggregaytor_global_autorespond;
});

// ── Utilities ───────────────────────────────────────────────────────────────

const PLATFORM_LABELS = {
  sniffies: 'S', grindr: 'G', doublelist: 'DL', adam4adam: 'A4A', gmail: 'GM', yahoo: 'Y',
};
function platformIcon(platform) {
  const label = PLATFORM_LABELS[platform] || platform?.charAt(0)?.toUpperCase() || '?';
  return `<span class="platform-icon ${esc(platform)}">${label}</span>`;
}

function stripPrefix(id) { return String(id || '').replace(/^[a-z]+:/, ''); }
function truncate(str, len) { return !str ? '' : str.length > len ? str.slice(0, len) + '...' : str; }
function esc(text) { const d = document.createElement('div'); d.textContent = String(text || ''); return d.innerHTML; }

/**
 * Build a compact stats line from contact metadata for display in the thread
 * list when no proper name or LLM nickname is available yet.
 * Output format: "M, 5'11", 170lb, athletic, top" (mimics Sniffies profile header)
 * Returns empty string if no useful metadata is found.
 */
function buildStatsLine(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  const parts = [];
  // Age
  const age = metadata.age || metadata.Age;
  if (age) parts.push(String(age));
  // Height
  const height = metadata.height || metadata.Height;
  if (height) parts.push(String(height));
  // Weight
  const weight = metadata.weight || metadata.Weight;
  if (weight) {
    const w = String(weight);
    parts.push(w.includes('lb') || w.includes('kg') ? w : w + 'lb');
  }
  // Body type
  const body = metadata.bodyType || metadata.body || metadata.build || metadata.Body;
  if (body && typeof body === 'string' && body.length < 20) parts.push(body);
  // Position/attitude
  const pos = metadata.position || metadata.attitude || metadata.role || metadata.Position;
  if (pos && typeof pos === 'string' && pos.length < 20) parts.push(pos);
  // Distance
  const dist = metadata.distance || metadata.Distance;
  if (dist) parts.push(String(dist));
  // Ethnicity (only if we have room — keeps the line short)
  if (parts.length < 4) {
    const eth = metadata.ethnicity || metadata.Ethnicity;
    if (eth && typeof eth === 'string' && eth.length < 15) parts.push(eth);
  }
  if (!parts.length) return '';
  // Cap at ~50 chars to fit the thread list row
  const line = parts.join(', ');
  return line.length > 50 ? line.slice(0, 47) + '...' : line;
}
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (prefTimestampAbsolute) {
    // Absolute: "11:42 PM", "Yesterday 3:15 PM", "Apr 10"
    const ms = Date.now() - d.getTime();
    if (ms < 86400_000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (ms < 172800_000) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  // Relative: "now", "5m", "2h", "3d", then full date
  const ms = Date.now() - d.getTime(), m = Math.floor(ms / 60000);
  if (m < 1) return 'now'; if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h';
  const days = Math.floor(h / 24); if (days < 7) return days + 'd';
  return d.toLocaleDateString();
}
function formatDate(iso) {
  if (!iso) return ''; const d = new Date(iso), now = new Date();
  const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return 'Today'; if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function formatMsgTime(iso) {
  if (!iso) return '';
  // #16 Relative timestamps for recent messages
  const d = new Date(iso);
  const ago = Date.now() - d.getTime();
  if (ago < 60_000) return 'just now';
  if (ago < 3600_000) return Math.floor(ago / 60_000) + 'm ago';
  if (ago < 7200_000) return '1h ago';
  // Older than 2h — show full time
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function updateTotalUnread(count) {
  const b = document.getElementById('total-unread');
  if (count > 0) { b.textContent = count; b.style.display = ''; } else { b.style.display = 'none'; }
}

// ── Settings button ─────────────────────────────────────────────────────────

// ── Photo gallery ───────────────────────────────────────────────────────────

async function openGallery(contactId, displayName) {
  const overlay = document.getElementById('gallery-overlay');
  const grid = document.getElementById('gallery-grid');
  document.getElementById('gallery-title').textContent = `${displayName || stripPrefix(contactId)} — Photos`;

  const pics = [];
  try {
    // v0.57.28: use O(1) GET_CONTACT instead of fetching ALL thread summaries
    const contactRes = await chrome.runtime.sendMessage({ type: 'GET_CONTACT', contactId: 'contact:' + contactId.replace('contact:', '') });
    const contact = contactRes?.contact;
    if (contact?.avatarUrl) pics.push(contact.avatarUrl);
    if (Array.isArray(contact?.metadata?.photos)) {
      for (const p of contact.metadata.photos) {
        if (typeof p === 'string' && p.startsWith('http') && !pics.includes(p)) pics.push(p);
      }
    }
    const dossierRes = await chrome.runtime.sendMessage({ type: 'GET_DOSSIER', contactId });
    if (dossierRes?.dossier?.otherProfileLinks) {
      for (const link of dossierRes.dossier.otherProfileLinks) {
        if (/\.(jpg|jpeg|png|webp|gif)/i.test(link) && !pics.includes(link)) pics.push(link);
      }
    }
  } catch {}

  if (!pics.length) {
    grid.innerHTML = '<div class="gallery-empty">No photos synced yet.<br>Open their profile and click 📷 to sync.</div>';
  } else {
    grid.innerHTML = pics.map((url, i) =>
      `<div class="gallery-item" data-index="${i}"><img src="${esc(url)}" alt="Photo ${i + 1}" loading="lazy"></div>`
    ).join('');
    grid.querySelectorAll('.gallery-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.classList.contains('full')) item.classList.remove('full');
        else { grid.querySelectorAll('.gallery-item.full').forEach(f => f.classList.remove('full')); item.classList.add('full'); }
      });
    });
  }
  overlay.style.display = '';
}

document.getElementById('gallery-close').addEventListener('click', () => {
  document.getElementById('gallery-overlay').style.display = 'none';
});

// v0.57.28: click on overlay background (not child elements) to close gallery
document.getElementById('gallery-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.classList.contains('gallery-grid')) {
    document.getElementById('gallery-overlay').style.display = 'none';
  }
});

document.getElementById('btn-gallery').addEventListener('click', () => {
  if (currentThread) openGallery(currentThread.contactId, currentThread.displayName || stripPrefix(currentThread.contactId));
});

// ── Sync pics from header ───────────────────────────────────────────────────

document.getElementById('sync-pics-header').addEventListener('click', async () => {
  const btn = document.getElementById('sync-pics-header');
  btn.textContent = '⏳';
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNC_PROFILE_PICS' });
    btn.textContent = res?.count ? `✓${res.count}` : '📷';
    // Reload threads so avatars update in the list
    if (res?.count) loadThreads();
    // If in thread detail, reload profile info
    if (currentThread) loadProfileInfo(currentThread.contactId);
  } catch {
    btn.textContent = '❌';
  }
  setTimeout(() => { btn.textContent = '📷'; btn.disabled = false; }, 3000);
});

// ── Inline settings panel ───────────────────────────────────────────────────

let settingsOpen = false;

document.getElementById('open-settings').addEventListener('click', () => {
  if (settingsOpen) {
    closeSettings();
  } else {
    openSettings();
  }
});

function openSettings() {
  settingsOpen = true;
  document.body.classList.remove('view-inbox', 'view-thread');
  document.body.classList.add('view-settings');
  document.getElementById('header-title').textContent = 'Settings';
  document.getElementById('settings-panel').style.display = '';
  loadInlineSettings();
}

function closeSettings() {
  settingsOpen = false;
  document.body.classList.remove('view-settings');
  document.body.classList.add('view-inbox');
  document.getElementById('header-title').innerHTML = `<span class="version-tag">v${(chrome.runtime.getManifest?.().version || '0.0').replace(/\.\d+$/, '')}</span>`;
  document.getElementById('settings-panel').style.display = 'none';
  loadThreads();
}

async function loadInlineSettings() {
  // Load provider
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
    if (res?.ok) {
      document.getElementById('sp-provider').value = res.config.provider || 'local';
      document.getElementById('sp-apikey').value = res.config.apiKey || '';
      document.getElementById('sp-model').value = res.config.model || '';
    }
  } catch {}

  // Load personality
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PERSONALITY' });
    if (res?.ok) {
      const sel = document.getElementById('sp-personality');
      sel.innerHTML = res.presets.map(p =>
        `<option value="${p.id}"${p.id === res.personality.preset ? ' selected' : ''}>${p.label}</option>`
      ).join('');
      document.getElementById('sp-preset-desc').textContent = res.presets.find(p => p.id === res.personality.preset)?.description || '';
      document.getElementById('sp-custom-instructions').value = res.personality.customInstructions || '';
    }
  } catch {}

  // Load rate settings
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LLM_RATE_SETTINGS' });
    if (res?.ok) {
      document.getElementById('sp-llm-enabled').checked = res.settings.enabled !== false;
      document.getElementById('sp-rpm').value = res.settings.maxRequestsPerMinute || 10;
      document.getElementById('sp-feat-ar').checked = res.settings.enableAutoRespond !== false;
      document.getElementById('sp-feat-suggest').checked = res.settings.enableSuggestions !== false;
      document.getElementById('sp-feat-dossier').checked = res.settings.enableDossierExtract !== false;
    }
  } catch {}

  // Load queue status
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LLM_QUEUE_STATUS' });
    if (res?.ok) {
      const s = res.status;
      const usage = Object.entries(s.providerUsage || {}).map(([p, u]) => `${p}: ${u.used}/${u.limit}`).join(', ');
      document.getElementById('sp-queue-status').textContent = `Queue: ${s.queueLength} | Last min: ${s.requestsLastMinute} | ${usage}`;
    }
  } catch {}

  // Load log level
  try {
    const data = await chrome.storage.local.get('aggregaytor_log_level');
    if (data.aggregaytor_log_level) document.getElementById('sp-log-level').value = data.aggregaytor_log_level;
  } catch {}
  // Load display preferences
  try {
    const prefs = await chrome.storage.local.get(['aggregaytor_timestamp_format', 'aggregaytor_auto_navigate', 'aggregaytor_toolbar_mode']);
    document.getElementById('sp-timestamp-absolute').checked = prefs.aggregaytor_timestamp_format === 'absolute';
    document.getElementById('sp-auto-navigate').checked = prefs.aggregaytor_auto_navigate !== false;
    document.getElementById('sp-toolbar-mode').value = prefs.aggregaytor_toolbar_mode || 'icon';
  } catch {}
}

// Settings save handlers
document.getElementById('sp-save-provider').addEventListener('click', async () => {
  const provider = document.getElementById('sp-provider').value;
  const apiKey = document.getElementById('sp-apikey').value.trim();
  const model = document.getElementById('sp-model').value.trim();
  await chrome.runtime.sendMessage({ type: 'SAVE_LLM_CONFIG', config: { provider, apiKey, model } });
  const status = document.getElementById('sp-provider-status');
  status.textContent = 'Saved!';
  status.style.color = '#34d399';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

document.getElementById('sp-personality').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({ type: 'GET_PERSONALITY' }).then(res => {
    if (res?.ok) {
      const p = res.presets.find(pr => pr.id === e.target.value);
      document.getElementById('sp-preset-desc').textContent = p?.description || '';
    }
  }).catch(() => {});
});

document.getElementById('sp-save-personality').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_PERSONALITY',
    settings: {
      preset: document.getElementById('sp-personality').value,
      customInstructions: document.getElementById('sp-custom-instructions').value.trim(),
    },
  });
});

document.getElementById('sp-save-rate').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_LLM_RATE_SETTINGS',
    settings: {
      enabled: document.getElementById('sp-llm-enabled').checked,
      maxRequestsPerMinute: parseInt(document.getElementById('sp-rpm').value) || 10,
      enableAutoRespond: document.getElementById('sp-feat-ar').checked,
      enableSuggestions: document.getElementById('sp-feat-suggest').checked,
      enableDossierExtract: document.getElementById('sp-feat-dossier').checked,
    },
  });
});

document.getElementById('sp-log-level').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({ type: 'SET_LOG_LEVEL', level: e.target.value }).catch(() => {});
});

// Display preferences
document.getElementById('sp-timestamp-absolute').addEventListener('change', (e) => {
  prefTimestampAbsolute = e.target.checked;
  chrome.storage.local.set({ aggregaytor_timestamp_format: e.target.checked ? 'absolute' : 'relative' });
  // Refresh thread list to show new timestamp format
  if (document.body.classList.contains('view-inbox')) loadThreads();
  else if (currentMessages.length) renderMessages(currentMessages);
});
document.getElementById('sp-auto-navigate').addEventListener('change', (e) => {
  prefAutoNavigate = e.target.checked;
  chrome.storage.local.set({ aggregaytor_auto_navigate: e.target.checked });
});
document.getElementById('sp-toolbar-mode')?.addEventListener('change', (e) => {
  const mode = e.target.value;
  prefToolbarMode = mode;
  chrome.storage.local.set({ aggregaytor_toolbar_mode: mode });
  applyInboxToolbarMode(); // rewrite inbox top-bar icons/labels
  if (currentThread) renderHeaderActions(); // re-render thread-view toolbar
});

// Hotkey help button in settings
document.getElementById('sp-show-hotkeys')?.addEventListener('click', () => {
  toggleHotkeyHelp();
});

// Tab switching
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    const target = document.getElementById(tab.dataset.tab);
    if (target) target.classList.add('active');
    // Load tab-specific data
    if (tab.dataset.tab === 'tab-rules') loadBlockRules();
    if (tab.dataset.tab === 'tab-pictures') loadPictures();
    if (tab.dataset.tab === 'tab-map') { loadMapFilterSettings(); loadGrindrFilterSettings(); }
    if (tab.dataset.tab === 'tab-ai') loadModelStats();
    if (tab.dataset.tab === 'tab-data') loadTextExpansions();
    if (tab.dataset.tab === 'tab-sync') { loadCalendarStatus(); checkGoogleAuth(); }
    if (tab.dataset.tab === 'tab-personality') loadStyleGuide();
  });
});

// Style guide
async function loadStyleGuide() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PERSONALITY' });
    if (res?.ok) document.getElementById('sp-style-guide').textContent = res.personality.styleGuide || 'Not yet derived.';
  } catch {}
}
document.getElementById('sp-derive-style')?.addEventListener('click', async () => {
  const btn = document.getElementById('sp-derive-style');
  btn.textContent = 'Analyzing...'; btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DERIVE_STYLE_GUIDE' });
    if (res?.ok) document.getElementById('sp-style-guide').textContent = res.styleGuide;
  } catch {}
  btn.textContent = 'Analyze my writing style'; btn.disabled = false;
});

// Block rules
async function loadBlockRules() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ALL_BLOCK_RULES' });
    const list = document.getElementById('sp-rule-list');
    if (!res?.ok || !res.rules?.length) { list.innerHTML = '<div class="settings-info">No rules yet.</div>'; return; }
    list.innerHTML = res.rules.map(r => {
      const statusColor = r.enabled ? '#34d399' : '#6b7280';
      const statusDot = r.enabled ? '🟢' : '⚪';
      const statusLabel = r.enabled ? 'Active' : 'Disabled';
      const toggleLabel = r.enabled ? 'Disable' : 'Enable';
      return `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px">
        <span style="font-size:10px" title="${statusLabel}">${statusDot}</span>
        <span style="flex:1">${esc(r.name)}</span>
        <span style="color:#6b7280;font-size:9px" title="Times this rule has triggered">${r.executedCount} triggered</span>
        <button class="settings-btn" data-toggle-rule="${r._id}" data-enabled="${!r.enabled}" style="font-size:10px;padding:2px 6px">${toggleLabel}</button>
        <button class="settings-btn" style="border-color:rgba(239,68,68,0.3);color:#f87171;font-size:10px;padding:2px 6px" data-delete-rule="${r._id}">✕</button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-toggle-rule]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'UPDATE_BLOCK_RULE', id: btn.dataset.toggleRule, updates: { enabled: btn.dataset.enabled === 'true' } });
        loadBlockRules();
      });
    });
    list.querySelectorAll('[data-delete-rule]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'DELETE_BLOCK_RULE', id: btn.dataset.deleteRule });
        loadBlockRules();
      });
    });
  } catch {}
}
document.getElementById('sp-rule-type')?.addEventListener('change', (e) => {
  document.getElementById('sp-rule-keywords').style.display = e.target.value === 'keyword' ? '' : 'none';
});
document.getElementById('sp-add-rule')?.addEventListener('click', async () => {
  const type = document.getElementById('sp-rule-type').value;
  const threshold = parseInt(document.getElementById('sp-rule-threshold').value) || 3;
  const keywords = (document.getElementById('sp-rule-keywords').value || '').split(',').map(k => k.trim()).filter(Boolean);
  const action = document.getElementById('sp-rule-action').value;
  const condition = { type };
  if (type === 'keyword') condition.keywords = keywords;
  else if (type === 'no_response_days') condition.days = threshold;
  else condition.threshold = threshold;
  const names = { ignored_count: `Ignored ${threshold}x`, no_response_days: `No reply ${threshold}d`, deleted_chat: `Deleted ${threshold}x`, keyword: `Keyword: ${keywords.slice(0,2).join(', ')}` };
  await chrome.runtime.sendMessage({ type: 'CREATE_BLOCK_RULE', input: { name: names[type] || type, condition, action } });
  loadBlockRules();
});

// Pictures
async function loadPictures() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ALL_PICTURES' });
    const grid = document.getElementById('sp-pic-grid');
    if (!res?.ok || !res.pictures?.length) { grid.innerHTML = '<div class="settings-info">No pictures yet.</div>'; return; }
    grid.innerHTML = res.pictures.map(p => `
      <div style="position:relative;aspect-ratio:1;border-radius:6px;overflow:hidden;background:rgba(255,255,255,0.05)">
        ${p.thumbnail ? `<img src="${p.thumbnail}" style="width:100%;height:100%;object-fit:cover" alt="">` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6b7280">${p.tag}</div>`}
        <span style="position:absolute;top:2px;left:2px;font-size:8px;padding:1px 4px;border-radius:3px;background:rgba(59,130,246,0.5);color:white">${p.tag}</span>
        <span style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.7);font-size:8px;padding:1px 3px;color:#9ca3af">${p.sentCount}s ${p.responseCount}r ${p.likeCount}l</span>
        <button style="position:absolute;top:2px;right:2px;background:rgba(239,68,68,0.7);border:none;color:white;width:14px;height:14px;border-radius:50%;font-size:9px;cursor:pointer;display:none" data-del-pic="${p._id}">&times;</button>
      </div>
    `).join('');
    grid.querySelectorAll('[data-del-pic]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'DELETE_PICTURE', id: btn.dataset.delPic });
        loadPictures();
      });
    });
  } catch {}
}
document.getElementById('sp-pic-upload')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const tag = document.getElementById('sp-pic-tag').value;
  const label = document.getElementById('sp-pic-label').value.trim() || file.name;
  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 200;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(200 / img.width, 200 / img.height);
      ctx.drawImage(img, (200 - img.width * scale) / 2, (200 - img.height * scale) / 2, img.width * scale, img.height * scale);
      await chrome.runtime.sendMessage({ type: 'ADD_PICTURE', input: { tag, label, dataUrl, thumbnail: canvas.toDataURL('image/jpeg', 0.7) } });
      document.getElementById('sp-pic-label').value = '';
      e.target.value = '';
      loadPictures();
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
});

// Google Account connection
let googleAuthenticated = false;

document.getElementById('sp-google-connect')?.addEventListener('click', async () => {
  const btn = document.getElementById('sp-google-connect');
  const status = document.getElementById('sp-google-status');
  btn.textContent = 'Connecting...'; btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GOOGLE_AUTH' });
    if (res?.ok) {
      googleAuthenticated = true;
      btn.textContent = 'Connected';
      status.textContent = 'Google account connected. Calendar, Tasks, and Gmail are active.';
      status.style.color = '#22c55e';
    } else {
      btn.textContent = 'Connect Google Account';
      btn.disabled = false;
      status.textContent = res?.error || 'Connection failed. Try again.';
      status.style.color = '#ef4444';
    }
  } catch (err) {
    btn.textContent = 'Connect Google Account';
    btn.disabled = false;
    status.textContent = 'Error: ' + (err.message || err);
    status.style.color = '#ef4444';
  }
});

// Check Google auth status on settings open
async function checkGoogleAuth() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GOOGLE_AUTH_STATUS' });
    googleAuthenticated = res?.authenticated || false;
    const btn = document.getElementById('sp-google-connect');
    const status = document.getElementById('sp-google-status');
    if (googleAuthenticated) {
      btn.textContent = 'Connected';
      btn.disabled = true;
      status.textContent = 'Google account connected.';
      status.style.color = '#22c55e';
    }
  } catch {}
}

// Google Drive backup/restore
document.getElementById('sp-drive-backup')?.addEventListener('click', async () => {
  const btn = document.getElementById('sp-drive-backup');
  const status = document.getElementById('sp-drive-status');
  btn.disabled = true; btn.textContent = 'Backing up...';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DRIVE_BACKUP' });
    if (res?.ok) {
      status.textContent = 'Backup saved to Google Drive!'; status.style.color = '#22c55e';
    } else {
      status.textContent = res?.error || 'Backup failed'; status.style.color = '#ef4444';
    }
  } catch (err) { status.textContent = 'Error: ' + err.message; status.style.color = '#ef4444'; }
  btn.disabled = false; btn.textContent = 'Backup to Drive';
});

document.getElementById('sp-drive-restore')?.addEventListener('click', async () => {
  const btn = document.getElementById('sp-drive-restore');
  const status = document.getElementById('sp-drive-status');
  btn.disabled = true; btn.textContent = 'Restoring...';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DRIVE_RESTORE' });
    if (res?.ok) {
      status.textContent = `Restored ${res.imported || 0} items from Drive!`; status.style.color = '#22c55e';
      loadThreads();
    } else {
      status.textContent = res?.error || 'Restore failed'; status.style.color = '#ef4444';
    }
  } catch (err) { status.textContent = 'Error: ' + err.message; status.style.color = '#ef4444'; }
  btn.disabled = false; btn.textContent = 'Restore from Drive';
});

// Sync
document.getElementById('sp-sync-pics')?.addEventListener('click', async () => {
  const btn = document.getElementById('sp-sync-pics');
  const status = document.getElementById('sp-sync-status');
  btn.textContent = 'Syncing...'; btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNC_PROFILE_PICS' });
    status.textContent = res?.count ? `Scraped ${res.count} from ${res.tabs} tab(s)` : 'No avatars found';
  } catch { status.textContent = 'Failed'; }
  btn.textContent = 'Sync Profile Pictures'; btn.disabled = false;
});

// Calendar
async function loadCalendarStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_CALENDAR_SETTINGS' });
    if (res?.ok) {
      const s = res.settings;
      document.getElementById('sp-cal-booking-url').value = s.bookingUrl || '';
      document.getElementById('sp-cal-prep').value = s.prepTimeMinutes || 30;
      document.getElementById('sp-cal-travel').value = s.travelTimeMinutes || 15;
      if (s.bookingUrl) {
        document.getElementById('sp-cal-status').textContent = 'Booking page configured';
        document.getElementById('sp-cal-status').style.color = '#34d399';
      }
    }
  } catch {}
}
document.getElementById('sp-cal-save')?.addEventListener('click', async () => {
  const bookingUrl = document.getElementById('sp-cal-booking-url').value.trim();
  const status = document.getElementById('sp-cal-status');

  // Extract the scheduling iframe URL if they pasted the full iframe embed
  let cleanUrl = bookingUrl;
  const iframeMatch = bookingUrl.match(/src="([^"]+)"/);
  if (iframeMatch) cleanUrl = iframeMatch[1];

  await chrome.runtime.sendMessage({
    type: 'SAVE_CALENDAR_SETTINGS',
    settings: {
      enabled: !!cleanUrl,
      bookingUrl: cleanUrl,
      prepTimeMinutes: parseInt(document.getElementById('sp-cal-prep').value) || 30,
      travelTimeMinutes: parseInt(document.getElementById('sp-cal-travel').value) || 15,
    },
  });
  status.textContent = cleanUrl ? 'Saved!' : 'Cleared';
  status.style.color = '#34d399';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

// Clear all data — two-click confirmation (confirm() is blocked in side panels)
let clearConfirmPending = false;
document.getElementById('sp-clear-all').addEventListener('click', async () => {
  const btn = document.getElementById('sp-clear-all');
  const status = document.getElementById('sp-clear-status');

  if (!clearConfirmPending) {
    // First click — ask for confirmation
    clearConfirmPending = true;
    btn.textContent = 'Click again to confirm DELETE ALL';
    btn.style.background = 'rgba(239,68,68,0.3)';
    status.textContent = 'This will delete ALL messages, contacts, and metadata.';
    status.style.color = '#f87171';
    // Reset after 5 seconds if not confirmed
    setTimeout(() => {
      clearConfirmPending = false;
      btn.textContent = 'Clear all messages & data';
      btn.style.background = '';
      status.textContent = '';
    }, 5000);
    return;
  }

  // Second click — actually clear
  clearConfirmPending = false;
  btn.textContent = 'Clearing...';
  btn.disabled = true;
  status.textContent = 'Deleting all data...';
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_ALL_DATA' });
    status.textContent = 'All data cleared!';
    status.style.color = '#34d399';
    allThreadMeta.clear();
    hoverPreviewCache.clear();
    currentMessages = [];
    currentThread = null;
    setTimeout(() => {
      closeSettings();
      document.getElementById('thread-list').innerHTML = '<div class="empty-state"><h2>All data cleared</h2><p>Open your sites to start capturing messages again.</p></div>';
    }, 500);
  } catch (err) {
    status.textContent = 'Failed: ' + err.message;
    status.style.color = '#f87171';
  }
});

// Developer activity log
const devLogEl = document.getElementById('sp-devlog');
let devLogVisible = false;
const devLogMessages = [];

document.getElementById('sp-toggle-devlog').addEventListener('click', () => {
  devLogVisible = !devLogVisible;
  devLogEl.style.display = devLogVisible ? '' : 'none';
  document.getElementById('sp-toggle-devlog').textContent = devLogVisible ? 'Hide activity log' : 'Show activity log';
  if (devLogVisible) renderDevLog();
});

// ── Blocklists — unhide all per platform ───────────────────────────────────
async function unhidePlatform(platform, label) {
  const status = document.getElementById('sp-unhide-status');
  if (!confirm(`Clear the local ${label} blocklist? ` +
    `This removes the extension's visual filter only — it does NOT contact ${label} ` +
    `to unblock anyone on the platform itself.`)) return;
  status.textContent = `Clearing ${label} blocklist…`;
  status.style.color = '';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'UNHIDE_ALL_PLATFORM', platform });
    if (!res?.ok) {
      status.textContent = 'Error: ' + (res?.error || 'unknown');
      status.style.color = '#f87171';
      return;
    }
    const parts = [];
    if (res.affectedContacts) parts.push(`${res.affectedContacts} contact(s) un-flagged`);
    if (res.tabsNotified) parts.push(`${res.tabsNotified} open ${label} tab(s) refreshed`);
    status.textContent = parts.length
      ? `✓ ${label} unhidden — ${parts.join(', ')}.`
      : `${label} blocklist was already empty.`;
    status.style.color = '#22c55e';
    // Kick the thread list so the un-flagged contacts reappear
    if (typeof loadThreads === 'function') loadThreads().catch(() => {});
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.style.color = '#f87171';
  }
}
document.getElementById('sp-unhide-sniffies')?.addEventListener('click', () => unhidePlatform('sniffies', 'Sniffies'));
document.getElementById('sp-unhide-a4a')?.addEventListener('click', () => unhidePlatform('adam4adam', 'Adam4Adam'));
document.getElementById('sp-unhide-grindr')?.addEventListener('click', () => unhidePlatform('grindr', 'Grindr'));

// ── Export / Import ──────────────────────────────────────────────────────────
document.getElementById('sp-export-encrypt')?.addEventListener('change', (e) => {
  document.getElementById('sp-export-passphrase').style.display = e.target.checked ? '' : 'none';
});

document.getElementById('sp-export-all')?.addEventListener('click', async () => {
  const status = document.getElementById('sp-export-status');
  status.textContent = 'Exporting...';
  try {
    const encrypt = document.getElementById('sp-export-encrypt').checked;
    const passphrase = encrypt ? document.getElementById('sp-export-passphrase').value : undefined;
    if (encrypt && !passphrase) { status.textContent = 'Enter a passphrase first'; return; }
    const res = await chrome.runtime.sendMessage({ type: 'EXPORT_ALL_DATA', passphrase });
    if (res?.ok) {
      const blob = new Blob([res.data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `aggregaytor-export-${new Date().toISOString().slice(0,10)}.json`;
      a.click(); URL.revokeObjectURL(url);
      status.textContent = 'Export downloaded!'; status.style.color = '#22c55e';
    } else { status.textContent = res?.error || 'Export failed'; status.style.color = '#ef4444'; }
  } catch (err) { status.textContent = 'Error: ' + err.message; status.style.color = '#ef4444'; }
});

document.getElementById('sp-export-blocked')?.addEventListener('click', async () => {
  const status = document.getElementById('sp-export-status');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'EXPORT_BLOCKED' });
    if (res?.ok) {
      const blob = new Blob([res.data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `aggregaytor-blocked-${new Date().toISOString().slice(0,10)}.json`;
      a.click(); URL.revokeObjectURL(url);
      status.textContent = 'Blocked list exported!'; status.style.color = '#22c55e';
    }
  } catch (err) { status.textContent = 'Error: ' + err.message; }
});

let importMode = 'all'; // 'all' or 'blocked'
document.getElementById('sp-import-all')?.addEventListener('click', () => {
  importMode = 'all';
  document.getElementById('sp-import-file').click();
});
document.getElementById('sp-import-blocked')?.addEventListener('click', () => {
  importMode = 'blocked';
  document.getElementById('sp-import-file').click();
});
document.getElementById('sp-import-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById('sp-export-status');
  status.textContent = 'Importing...';
  try {
    const text = await file.text();
    const encrypt = document.getElementById('sp-export-encrypt').checked;
    const passphrase = encrypt ? document.getElementById('sp-export-passphrase').value : undefined;
    const msgType = importMode === 'blocked' ? 'IMPORT_BLOCKED' : 'IMPORT_ALL_DATA';
    const res = await chrome.runtime.sendMessage({ type: msgType, data: text, passphrase });
    if (res?.ok) {
      status.textContent = `Imported ${res.imported} items!`; status.style.color = '#22c55e';
      loadThreads();
    } else { status.textContent = res?.error || 'Import failed'; status.style.color = '#ef4444'; }
  } catch (err) { status.textContent = 'Error: ' + err.message; status.style.color = '#ef4444'; }
  e.target.value = ''; // reset file input
});

// ── Quick Phrases ────────────────────────────────────────────────────────────
let quickPhrases = [];

document.getElementById('sp-save-phrases')?.addEventListener('click', () => {
  const text = document.getElementById('sp-quick-phrases').value;
  quickPhrases = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  chrome.storage.local.set({ aggregaytor_quick_phrases: quickPhrases });
});

// Load phrases on startup
chrome.storage.local.get('aggregaytor_quick_phrases', (data) => {
  quickPhrases = data.aggregaytor_quick_phrases || ['Hey there!', "What's up?", 'Looking?', 'You host?'];
  const el = document.getElementById('sp-quick-phrases');
  if (el) el.value = quickPhrases.join('\n');
});

document.getElementById('phrase-toggle')?.addEventListener('click', () => {
  const panel = document.getElementById('phrase-panel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : '';
  if (!visible) renderPhrasePanel();
});
document.getElementById('phrase-close')?.addEventListener('click', () => {
  document.getElementById('phrase-panel').style.display = 'none';
});

function renderPhrasePanel() {
  const list = document.getElementById('phrase-list');
  if (!quickPhrases.length) {
    list.innerHTML = '<div class="phrase-empty">No phrases yet. Add them in Settings → Data.</div>';
    return;
  }
  list.innerHTML = quickPhrases.map((p, i) =>
    `<button class="phrase-item" data-phrase-idx="${i}">${esc(p)}</button>`
  ).join('');
  list.querySelectorAll('.phrase-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = quickPhrases[parseInt(btn.dataset.phraseIdx)];
      if (!text || !currentThread) return;
      // Put in the response input and auto-send
      const input = document.getElementById('response-input');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Send via platform
      chrome.runtime.sendMessage({
        type: 'SEND_AUTO_RESPONSE_DIRECT',
        text,
        contactId: currentThread.contactId,
        platform: currentThread.platform,
      }).catch(() => {});
      document.getElementById('phrase-panel').style.display = 'none';
    });
  });
}

// ── Broadcast ────────────────────────────────────────────────────────────────
document.getElementById('sp-broadcast-send')?.addEventListener('click', async () => {
  const msg = document.getElementById('sp-broadcast-msg').value.trim();
  if (!msg) return;
  const platform = document.getElementById('sp-broadcast-platform').value;
  const status = document.getElementById('sp-broadcast-status');
  const btn = document.getElementById('sp-broadcast-send');
  btn.disabled = true; btn.textContent = 'Sending...';
  status.textContent = 'Broadcasting... this may take a while';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'BROADCAST_TO_FAVORITES',
      message: msg,
      platform,
      maxRecipients: 50,
      delay: 5000,
    });
    if (res?.ok) {
      status.textContent = `Sent to ${res.sent} of ${res.total} favorites`; status.style.color = '#22c55e';
    } else { status.textContent = res?.error || 'Failed'; status.style.color = '#ef4444'; }
  } catch (err) { status.textContent = 'Error: ' + err.message; status.style.color = '#ef4444'; }
  btn.disabled = false; btn.textContent = 'Send Broadcast';
});

// ── Preference Auto-Training ─────────────────────────────────────────────────

document.getElementById('sp-auto-train')?.addEventListener('change', (e) => {
  chrome.storage.local.set({ aggregaytor_auto_train_preferences: e.target.checked });
});

document.getElementById('sp-train-now')?.addEventListener('click', async () => {
  const status = document.getElementById('sp-train-status');
  status.textContent = 'Training...';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AUTO_TRAIN_NOW' });
    if (res?.ok) {
      status.textContent = `Trained on ${res.trained} new signals!`;
      status.style.color = '#22c55e';
      loadModelStats();
    } else {
      status.textContent = res?.error || 'Failed'; status.style.color = '#ef4444';
    }
  } catch (err) { status.textContent = 'Error: ' + err.message; status.style.color = '#ef4444'; }
});

document.getElementById('sp-train-grindr')?.addEventListener('click', async () => {
  const status = document.getElementById('sp-train-status');
  status.textContent = 'Importing Grindr blocked/hidden lists...';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'BULK_TRAIN_FROM_PLATFORM', platform: 'grindr' });
    if (res?.ok) {
      status.textContent = `Imported and trained on ${res.trained} signals!`;
      status.style.color = '#22c55e';
      loadModelStats();
    } else {
      status.textContent = res?.error || 'Failed — is Grindr tab open?';
      status.style.color = '#ef4444';
    }
  } catch (err) { status.textContent = 'Error: ' + err.message; status.style.color = '#ef4444'; }
});

document.getElementById('sp-train-sniffies')?.addEventListener('click', async () => {
  const status = document.getElementById('sp-train-status');
  status.textContent = 'Importing Sniffies signals…';
  status.style.color = '';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'BULK_TRAIN_FROM_PLATFORM', platform: 'sniffies' });
    if (res?.ok) {
      status.textContent = `Imported and trained on ${res.trained} signals!`;
      status.style.color = '#22c55e';
      loadModelStats();
    } else {
      status.textContent = 'Error: ' + (res?.error || 'unknown');
      status.style.color = '#f87171';
    }
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.style.color = '#f87171';
  }
});

document.getElementById('sp-retrain-model')?.addEventListener('click', async () => {
  const status = document.getElementById('sp-train-status');
  status.textContent = 'Retraining from scratch...';
  try {
    await chrome.runtime.sendMessage({ type: 'RETRAIN_MODEL' });
    status.textContent = 'Model retrained!'; status.style.color = '#22c55e';
    loadModelStats();
  } catch (err) { status.textContent = 'Error: ' + err.message; }
});

function renderEnrichState(state) {
  const grindrBtn = document.getElementById('sp-enrich-blocked');
  const sniffiesBtn = document.getElementById('sp-enrich-sniffies');
  const stopBtn = document.getElementById('sp-enrich-stop');
  const progress = document.getElementById('sp-enrich-progress');
  if (!grindrBtn || !sniffiesBtn || !stopBtn || !progress || !state) return;
  const running = state.status === 'running' || state.status === 'paused';
  const platform = state.platform || 'grindr';
  stopBtn.style.display = running ? '' : 'none';
  const label = platform === 'sniffies' ? 'Sniffies' : 'Grindr';
  const activeBtn = platform === 'sniffies' ? sniffiesBtn : grindrBtn;
  const idleBtn = platform === 'sniffies' ? grindrBtn : sniffiesBtn;
  activeBtn.textContent = state.status === 'paused' ? `Resume ${label} Enrich`
    : state.status === 'running' ? `Enriching ${label}…`
    : `Enrich ${label}`;
  activeBtn.disabled = state.status === 'running';
  // Disable the OTHER platform's button while an enrichment is running so
  // users don't accidentally interrupt mid-pass.
  idleBtn.disabled = state.status === 'running';
  if (state.total === 0 && state.status === 'idle') {
    progress.style.display = 'none';
    progress.textContent = '';
    return;
  }
  progress.style.display = 'block';
  const pct = state.total ? Math.round((state.processed / state.total) * 100) : 0;
  // Show the honest breakdown: enriched-with-features vs empty-shell
  // responses vs network failures. Previous version conflated all three
  // into "enriched", which is why the total appeared to keep growing
  // (empty-shell responses re-entered the needs-enrich pool each tick).
  const noFeat = state.noFeatures || 0;
  const base = noFeat > 0
    ? `${state.processed}/${state.total} (${pct}%) — ${state.enriched} with features, ${noFeat} empty shell, ${state.failed} failed`
    : `${state.processed}/${state.total} (${pct}%) — ${state.enriched} enriched, ${state.failed} failed`;
  if (state.status === 'paused') {
    progress.style.color = '#fbbf24';
    const reasonMsg = {
      'no-auth': 'Waiting for Grindr auth — scroll the cascade on the Grindr tab so the adapter can capture a token.',
      'no-tab': 'Open web.grindr.com in a tab — enrichment will resume on the next tick.',
      'session-dead': 'Grindr logged you out. Log back in (auto-login will do it if creds are saved) — auto-resumes.',
      'manual': 'Paused manually — click Resume Enrich to continue.',
      'error': state.lastError || 'Error — click Resume Enrich to retry.',
    };
    progress.textContent = `Paused — ${base}. ${reasonMsg[state.pauseReason] || 'Retrying on next tick.'}`;
  } else if (state.status === 'running') {
    progress.style.color = '';
    // Estimate remaining time: ~40/min = 2400/hour.
    const remaining = Math.max(0, state.total - state.processed);
    const etaHours = remaining / 2400;
    const eta = etaHours < 1
      ? `~${Math.ceil(etaHours * 60)}m remaining`
      : `~${etaHours.toFixed(1)}h remaining`;
    progress.textContent = `Enriching: ${base} — ${eta}. Runs in the background at ~40/min; safe to close this panel, the extension, or even the browser.`;
  } else if (state.processed > 0) {
    progress.style.color = '#22c55e';
    progress.textContent = `Enrichment complete — ${base}. Click Full Retrain to use the new data.`;
  }
}

async function refreshEnrichStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ENRICH_BLOCKED_STATUS' });
    if (res?.ok && res.state) renderEnrichState(res.state);
  } catch {}
}

async function startEnrich(platform) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ENRICH_BLOCKED_START', platform });
    const progress = document.getElementById('sp-enrich-progress');
    if (!res?.ok) {
      progress.style.display = 'block';
      progress.style.color = '#fbbf24';
      progress.textContent = res?.error || 'Unknown error starting enrichment';
      return;
    }
    if (res.total === 0) {
      progress.style.display = 'block';
      progress.style.color = '#6b7280';
      progress.textContent = res.message || `Nothing to enrich for ${platform}.`;
      return;
    }
    await refreshEnrichStatus();
  } catch (err) {
    const progress = document.getElementById('sp-enrich-progress');
    progress.style.display = 'block';
    progress.style.color = '#f87171';
    progress.textContent = 'Error: ' + err.message;
  }
}

document.getElementById('sp-enrich-blocked')?.addEventListener('click', () => startEnrich('grindr'));
document.getElementById('sp-enrich-sniffies')?.addEventListener('click', () => startEnrich('sniffies'));

document.getElementById('sp-enrich-stop')?.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'ENRICH_BLOCKED_STOP' });
    await refreshEnrichStatus();
  } catch {}
});

// Refresh once on load so a paused run from a previous session shows up
refreshEnrichStatus();

// ── Grindr Auto-Login Credentials ──────────────────────────────────────────
async function refreshGrindrCredStatus() {
  const el = document.getElementById('sp-grindr-cred-status');
  if (!el) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_GRINDR_CREDENTIAL_STATUS' });
    if (!res?.ok) { el.textContent = ''; return; }
    if (!res.saved) {
      el.textContent = 'No credentials stored. Auto-login is disabled until you save.';
      el.style.color = '#6b7280';
      document.getElementById('sp-grindr-auto-login').checked = true; // sensible default
    } else {
      const ts = res.savedAt ? new Date(res.savedAt).toLocaleString() : 'unknown';
      el.textContent = `✓ Credentials saved (${ts}). Auto-login: ${res.autoLogin ? 'ON' : 'OFF'}.`;
      el.style.color = '#22c55e';
      document.getElementById('sp-grindr-auto-login').checked = res.autoLogin;
    }
  } catch { el.textContent = ''; }
}

document.getElementById('sp-grindr-cred-save')?.addEventListener('click', async () => {
  const emailEl = document.getElementById('sp-grindr-email');
  const passEl = document.getElementById('sp-grindr-password');
  const autoEl = document.getElementById('sp-grindr-auto-login');
  const statusEl = document.getElementById('sp-grindr-cred-status');
  const username = emailEl.value.trim();
  const password = passEl.value;
  if (!username || !password) {
    statusEl.textContent = 'Enter both email and password.';
    statusEl.style.color = '#f87171';
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SET_GRINDR_CREDENTIALS',
      username, password, autoLogin: !!autoEl.checked,
    });
    if (res?.ok) {
      // Clear the password field from memory
      passEl.value = '';
      statusEl.textContent = '✓ Saved & encrypted.';
      statusEl.style.color = '#22c55e';
      setTimeout(refreshGrindrCredStatus, 1000);
    } else {
      statusEl.textContent = 'Error: ' + (res?.error || 'unknown');
      statusEl.style.color = '#f87171';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.style.color = '#f87171';
  }
});

document.getElementById('sp-grindr-cred-clear')?.addEventListener('click', async () => {
  if (!confirm('Delete stored Grindr credentials? Auto-login will be disabled.')) return;
  try {
    await chrome.runtime.sendMessage({ type: 'SET_GRINDR_CREDENTIALS', username: '', password: '' });
    document.getElementById('sp-grindr-email').value = '';
    document.getElementById('sp-grindr-password').value = '';
    await refreshGrindrCredStatus();
  } catch {}
});

// When the user changes the auto-login toggle, re-save the same creds with
// the new flag. We can't toggle without knowing the password, so this only
// works if creds are currently saved — otherwise Save Credentials is the path.
document.getElementById('sp-grindr-auto-login')?.addEventListener('change', async (e) => {
  const statusEl = document.getElementById('sp-grindr-cred-status');
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_GRINDR_CREDENTIAL_STATUS' });
    if (!st?.saved) return; // nothing to update yet
    // We don't have the password in memory, so fetch the decrypted creds
    // and re-encrypt with the new autoLogin flag.
    const got = await chrome.runtime.sendMessage({ type: 'GET_GRINDR_CREDENTIALS' });
    if (!got?.credentials) {
      statusEl.textContent = 'Re-enter your password to change this setting.';
      statusEl.style.color = '#fbbf24';
      return;
    }
    await chrome.runtime.sendMessage({
      type: 'SET_GRINDR_CREDENTIALS',
      username: got.credentials.username,
      password: got.credentials.password,
      autoLogin: !!e.target.checked,
    });
    refreshGrindrCredStatus();
  } catch {}
});

// Refresh credential status whenever the settings view is opened
document.addEventListener('DOMContentLoaded', () => refreshGrindrCredStatus());
refreshGrindrCredStatus();

// Live progress pushed by the service worker after every tick. The state
// payload now contains the full EnrichState so the UI can render status,
// pauseReason, and exact counts without another round-trip.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'ENRICH_BLOCKED_PROGRESS' && msg.state) {
    renderEnrichState(msg.state);
  }
});

document.getElementById('sp-diagnose-training')?.addEventListener('click', async () => {
  const status = document.getElementById('sp-train-status');
  status.textContent = 'Auditing training data…';
  status.style.color = '';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'DIAGNOSE_TRAINING_DATA' });
    if (!r?.ok) { status.textContent = 'Error: ' + (r?.error || 'unknown'); return; }
    const fmt = (b, label) => {
      const total = (b.liked || 0) + (b.disliked || 0);
      if (!total) return '';
      return `\n${label}: ${total} samples (${b.liked}👍 ${b.disliked}👎) — ` +
        `${b.withBody} with body, ${b.withPosition} with position, ${b.withAge} with age, ` +
        `${b.withEthnicity} with ethnicity, ${b.withPhoto} with photo — ` +
        `${b.empty} EMPTY (${b.emptyPct}%)`;
    };
    const lines = [
      `Total: ${r.total} training samples`,
      fmt(r.grindr, 'Grindr'),
      fmt(r.sniffies, 'Sniffies'),
      fmt(r.other, 'Other'),
      `\nVerdict: ${r.verdict}`,
    ].filter(Boolean).join('');
    // Show the full multi-line report in a scrollable pre instead of the
    // single-line status span — easier to read.
    const el = document.getElementById('sp-model-stats');
    if (el) {
      el.textContent = lines;
      el.style.whiteSpace = 'pre-wrap';
      el.style.fontSize = '11px';
    }
    status.textContent = 'Diagnostic complete — see details above. Full samples in the service worker console.';
    status.style.color = '#22c55e';
    console.log('[Aggregaytor] Training data diagnostic:', r);
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.style.color = '#f87171';
  }
});

async function loadModelStats() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_MODEL_STATS' });
    const el = document.getElementById('sp-model-stats');
    if (res?.ok && el) {
      const s = res.stats;
      const topFeatures = (s.topFeatures || []).slice(0, 5)
        .map(f => `${f.feature}: ${f.weight > 0 ? '+' : ''}${f.weight.toFixed(2)}`).join(', ');
      el.textContent = `${s.trainingCount} samples | ${Math.round(s.accuracy * 100)}% accuracy | Top: ${topFeatures || 'none yet'}`;
    }
  } catch {}
}

// Load auto-train preference and model stats
chrome.storage.local.get('aggregaytor_auto_train_preferences', (data) => {
  const el = document.getElementById('sp-auto-train');
  if (el) el.checked = data.aggregaytor_auto_train_preferences !== false;
});

// ── Text Expansions ──────────────────────────────────────────────────────────

function loadTextExpansions() {
  chrome.storage.local.get(['aggregaytor_text_substitutions', 'aggregaytor_text_expander_enabled'], (data) => {
    let subs = data.aggregaytor_text_substitutions || [];
    const textarea = document.getElementById('sp-text-expansions');
    const count = document.getElementById('sp-expansion-count');
    const enabledCb = document.getElementById('sp-text-expander-enabled');

    // Show enabled state — default is auto-detected (disabled on macOS)
    if (enabledCb) {
      const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
      const stored = data.aggregaytor_text_expander_enabled;
      enabledCb.checked = stored !== undefined ? stored : !isMac;
    }

    if (textarea && subs.length) {
      textarea.value = subs.map(s => `${s.shortcut} → ${s.phrase}`).join('\n');
      if (count) count.textContent = `${subs.length} expansions`;
    } else {
      // No saved expansions — load defaults into the textarea so user can see them
      if (textarea) {
        textarea.value = DEFAULT_TEXT_EXPANSIONS.map(s => `${s.shortcut} → ${s.phrase}`).join('\n');
      }
      if (count) count.textContent = `${DEFAULT_TEXT_EXPANSIONS.length} defaults (not yet saved)`;
    }
  });
}

// Default text expansions — shown when no saved expansions exist
const DEFAULT_TEXT_EXPANSIONS = [
  { shortcut: 'hg', phrase: "Hey there. How's it going?" },
  { shortcut: 'ht', phrase: "Hey there. How's it going?" },
  { shortcut: 'htw', phrase: "Hey there. How's it going? What're you up to? You looking?" },
  { shortcut: 'hh', phrase: 'Howdy' },
  { shortcut: 'dd', phrase: 'Doing alright.' },
  { shortcut: 'ddt', phrase: "Doing alright. What're you up to? You looking?" },
  { shortcut: 'wt', phrase: "What're you up to?" },
  { shortcut: 'wtn', phrase: "What're you up to tonight?" },
  { shortcut: 'wtt', phrase: "What're you up to today?" },
  { shortcut: 'yl', phrase: 'You looking?' },
  { shortcut: 'yln', phrase: 'You looking at all tonight?' },
  { shortcut: 'ylt', phrase: 'You looking today?' },
  { shortcut: 'ylb', phrase: 'You looking to breed?' },
  { shortcut: 'ylbn', phrase: 'You looking to breed now?' },
  { shortcut: 'wylf', phrase: "What're you looking for?" },
  { shortcut: 'wylft', phrase: "What're you looking for tonight?" },
  { shortcut: 'wyf', phrase: 'When are you free?' },
  { shortcut: 'wbu', phrase: 'What about you?' },
  { shortcut: 'wyd', phrase: "What're you doing?" },
  { shortcut: 'ho', phrase: 'Host or travel?' },
  { shortcut: 'whm', phrase: 'Woof! Hot man' },
  { shortcut: 'omw', phrase: 'On my way!' },
  { shortcut: 'ty', phrase: 'Thank you' },
  { shortcut: 'sg', phrase: 'Sounds great.' },
  { shortcut: 'gm', phrase: 'Good morning' },
  { shortcut: 'wfh', phrase: 'Working from home.' },
  { shortcut: 'zz', phrase: "Hey there, how's it going?" },
];

document.getElementById('sp-text-expander-enabled')?.addEventListener('change', (e) => {
  const enabled = e.target.checked;
  chrome.storage.local.set({ aggregaytor_text_expander_enabled: enabled });
  // Relay to all tabs
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, {
        type: 'TEXT_EXPANDER_SETTINGS',
        substitutions: null, // don't change subs, just toggle
        enabled,
      }).catch(() => {});
    }
  });
});

document.getElementById('sp-load-defaults')?.addEventListener('click', () => {
  const textarea = document.getElementById('sp-text-expansions');
  if (textarea) textarea.value = DEFAULT_TEXT_EXPANSIONS.map(s => `${s.shortcut} → ${s.phrase}`).join('\n');
  document.getElementById('sp-expansion-count').textContent = `${DEFAULT_TEXT_EXPANSIONS.length} defaults loaded — click Save to apply`;
});

document.getElementById('sp-save-expansions')?.addEventListener('click', () => {
  const text = document.getElementById('sp-text-expansions').value;
  const lines = text.split('\n').filter(l => l.trim());
  const subs = [];
  for (const line of lines) {
    // Parse "shortcut → phrase" or "shortcut = phrase" or "shortcut: phrase"
    const match = line.match(/^(.+?)\s*[→=:]\s*(.+)$/);
    if (match) {
      subs.push({ shortcut: match[1].trim(), phrase: match[2].trim() });
    }
  }
  chrome.storage.local.set({ aggregaytor_text_substitutions: subs });
  document.getElementById('sp-expansion-count').textContent = `${subs.length} expansions saved!`;

  // Relay to all platform tabs
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, {
        type: 'TEXT_EXPANDER_SETTINGS',
        substitutions: subs,
      }).catch(() => {});
    }
  });
});

// ── Grindr Filter Settings ───────────────────────────────────────────────────

document.getElementById('sp-grindr-filter-save')?.addEventListener('click', () => {
  const s = {
    enabled: document.getElementById('gf-enabled').checked,
    autoBlock: document.getElementById('gf-auto-block').checked,
    ethnicityFilter: document.getElementById('gf-ethnicity-mode').value,
    ethnicityValues: [...document.querySelectorAll('[data-eth]:checked')].map(el => parseInt(el.dataset.eth)),
    genderFilter: document.getElementById('gf-gender-mode').value,
    genderValues: [...document.querySelectorAll('[data-gender]:checked')].map(el => parseInt(el.dataset.gender)),
    neverChattedFilter: document.getElementById('gf-chatted-mode').value,
    keywordFilter: document.getElementById('gf-keyword-mode').value,
    keywords: (document.getElementById('gf-keywords').value || '').split('\n').map(l => l.trim()).filter(l => l),
  };
  chrome.storage.local.set({ aggregaytor_grindr_filter_settings: s });
  // Relay to Grindr tabs
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (tab.id && tab.url?.includes('web.grindr.com')) {
        chrome.tabs.sendMessage(tab.id, { type: 'GRINDR_FILTER_SETTINGS', settings: s }).catch(() => {});
      }
    }
  });
  const status = document.getElementById('sp-grindr-filter-status');
  if (status) { status.textContent = 'Saved!'; status.style.color = '#22c55e'; }
});

function loadGrindrFilterSettings() {
  chrome.storage.local.get('aggregaytor_grindr_filter_settings', (data) => {
    const s = data.aggregaytor_grindr_filter_settings || {};
    if (s.enabled) document.getElementById('gf-enabled').checked = true;
    if (s.autoBlock) document.getElementById('gf-auto-block').checked = true;
    if (s.ethnicityFilter) document.getElementById('gf-ethnicity-mode').value = s.ethnicityFilter;
    if (s.genderFilter) document.getElementById('gf-gender-mode').value = s.genderFilter;
    if (s.neverChattedFilter) document.getElementById('gf-chatted-mode').value = s.neverChattedFilter;
    if (s.keywordFilter) document.getElementById('gf-keyword-mode').value = s.keywordFilter;
    if (s.keywords?.length) document.getElementById('gf-keywords').value = s.keywords.join('\n');
    (s.ethnicityValues || []).forEach(v => {
      const el = document.querySelector(`[data-eth="${v}"]`);
      if (el) el.checked = true;
    });
    (s.genderValues || []).forEach(v => {
      const el = document.querySelector(`[data-gender="${v}"]`);
      if (el) el.checked = true;
    });
  });
}

// ── Map Filter Settings ──────────────────────────────────────────────────────

document.getElementById('sp-map-save')?.addEventListener('click', () => {
  const update = {};
  document.querySelectorAll('[data-map-filter]').forEach(el => {
    update[el.dataset.mapFilter] = el.checked;
  });
  update.excludeTerms = (document.getElementById('sp-map-exclude-terms')?.value || '')
    .split('\n').map(l => l.trim()).filter(l => l);
  update.includeTerms = (document.getElementById('sp-map-include-terms')?.value || '')
    .split('\n').map(l => l.trim()).filter(l => l);

  // Save to chrome.storage and relay to Sniffies tabs
  chrome.storage.local.set({ aggregaytor_map_filter_settings: update });
  // Relay to all Sniffies tabs
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (tab.id && tab.url?.includes('sniffies.com')) {
        chrome.tabs.sendMessage(tab.id, { type: 'MAP_FILTER_SETTINGS', settings: update }).catch(() => {});
      }
    }
  });
  const status = document.getElementById('sp-map-status');
  if (status) { status.textContent = 'Saved!'; status.style.color = '#22c55e'; }
});

document.getElementById('sp-map-undo-hide')?.addEventListener('click', () => {
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (tab.id && tab.url?.includes('sniffies.com')) {
        chrome.tabs.sendMessage(tab.id, { type: 'UNDO_LAST_HIDE' }).catch(() => {});
      }
    }
  });
  const status = document.getElementById('sp-map-status');
  if (status) { status.textContent = 'Last hide undone!'; status.style.color = '#22c55e'; }
});

document.getElementById('sp-map-clear-blocked')?.addEventListener('click', () => {
  chrome.storage.local.set({ aggregaytor_map_blocked: [] });
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (tab.id && tab.url?.includes('sniffies.com')) {
        chrome.tabs.sendMessage(tab.id, { type: 'MAP_FILTER_SETTINGS', settings: { blockedIds: [] } }).catch(() => {});
      }
    }
  });
  const status = document.getElementById('sp-map-status');
  if (status) { status.textContent = 'All hidden profiles cleared!'; status.style.color = '#22c55e'; }
});

// Load map filter settings when Map tab is opened
function loadMapFilterSettings() {
  chrome.storage.local.get('aggregaytor_map_filter_settings', (data) => {
    const s = data.aggregaytor_map_filter_settings || {};
    document.querySelectorAll('[data-map-filter]').forEach(el => {
      if (s[el.dataset.mapFilter] !== undefined) el.checked = !!s[el.dataset.mapFilter];
    });
    if (s.excludeTerms) document.getElementById('sp-map-exclude-terms').value = (s.excludeTerms || []).join('\n');
    if (s.includeTerms) document.getElementById('sp-map-include-terms').value = (s.includeTerms || []).join('\n');
  });
}

// ── Star Ratings (in thread view) ────────────────────────────────────────────
function renderStarRating(contactId, platform, currentRating) {
  const stars = [1, 2, 3, 4, 5].map(n =>
    `<span class="star-btn ${n <= (currentRating || 0) ? 'active' : ''}" data-star="${n}">★</span>`
  ).join('');
  return `<div class="star-rating" data-contact="${esc(contactId)}" data-platform="${esc(platform)}">${stars}</div>`;
}

// Delegate star click handler
document.addEventListener('click', (e) => {
  const star = e.target.closest('.star-btn');
  if (!star) return;
  const container = star.closest('.star-rating');
  const contactId = container?.dataset.contact;
  const platform = container?.dataset.platform;
  const rating = parseInt(star.dataset.star);
  if (!contactId || !rating) return;
  // Toggle: clicking same star = clear rating
  const current = container.querySelectorAll('.star-btn.active').length;
  const newRating = rating === current ? 0 : rating;
  chrome.runtime.sendMessage({ type: 'SET_RATING', contactId, platform, rating: newRating }).catch(() => {});
  container.querySelectorAll('.star-btn').forEach((s, i) => {
    s.classList.toggle('active', i < newRating);
  });
});

function addDevLog(msg) {
  devLogMessages.push(`${new Date().toLocaleTimeString()} ${msg}`);
  if (devLogMessages.length > 200) devLogMessages.shift();
  if (devLogVisible) renderDevLog();
}

function renderDevLog() {
  devLogEl.innerHTML = '<button id="devlog-refresh-stats" style="font-size:10px;margin-bottom:4px;padding:2px 8px;border-radius:4px;border:1px solid rgba(59,130,246,0.4);background:rgba(59,130,246,0.15);color:#93c5fd;cursor:pointer;">Refresh Stats</button>' +
    devLogMessages.slice(-50).map(m => `<div>${esc(m)}</div>`).join('');
  devLogEl.scrollTop = devLogEl.scrollHeight;
  // v0.57.28: wire up refresh stats button
  document.getElementById('devlog-refresh-stats')?.addEventListener('click', async () => {
    try {
      const [perfRes, idxRes] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_SW_PERF' }),
        chrome.runtime.sendMessage({ type: 'GET_SEARCH_INDEX_INFO' }),
      ]);
      if (perfRes?.ok) {
        const m = perfRes.memory || {};
        addDevLog(`[PERF] uptime=${perfRes.uptimeHrs}h threads=${m.threadCacheHasData ? 'cached' : 'cold'} contacts=${m.recentContactUpserts}/${m.recentContactUpsertsCap} dossierQ=${m.dossierQueueSize}/${m.dossierQueueCap}`);
        if (m.dossierFirstQueuedAgoSec) addDevLog(`[PERF] dossier queued ${m.dossierFirstQueuedAgoSec}s ago`);
      }
      if (idxRes?.ok) {
        addDevLog(`[SEARCH] ready=${idxRes.ready} size=${idxRes.size}/${idxRes.cap} (${idxRes.utilization}%) evicted=${idxRes.evictedCount}${idxRes.lifetimeSeeds != null ? ' seeds=' + idxRes.lifetimeSeeds + ' adds=' + idxRes.lifetimeAdds : ''}`);
      }
    } catch (err) {
      addDevLog(`[STATS] Error: ${err.message}`);
    }
  });
}

// Hook into message listener to populate dev log
const origListener = chrome.runtime.onMessage._listeners?.[0];
chrome.runtime.onMessage.addListener((message) => {
  if (message.type) addDevLog(`← ${message.type} ${message.platform || ''} ${message.count || ''}`);
});

// ── Right-click context menu on platform chips ─────────────────────────────
// Right-click "All" → Open all sites
// Right-click individual chip → Open that platform
const PLATFORM_OPEN_URLS = {
  sniffies: 'https://sniffies.com',
  grindr: 'https://web.grindr.com',
  doublelist: 'https://doublelist.com',
  adam4adam: 'https://www.adam4adam.com',
  gmail: 'https://mail.google.com',
  yahoo: 'https://mail.yahoo.com',
};

document.querySelectorAll('.platform-chip').forEach(chip => {
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const platform = chip.dataset.platform;
    if (platform === 'all') {
      chrome.runtime.sendMessage({ type: 'OPEN_ALL_SITES' }).catch(() => {});
    } else if (PLATFORM_OPEN_URLS[platform]) {
      chrome.tabs.create({ url: PLATFORM_OPEN_URLS[platform] }).catch(() => {});
    }
  });
});

// ── Pop out / Pop back in ────────────────────────────────────────────────────
// Detects if we're running in the side panel or a popup window.
// In side panel: ⧉ opens panel.html in a standalone popup window.
// In popup window: ⧉ closes the window (side panel auto-reopens on icon click).
const isPopout = window.location.search.includes('popout=true') ||
  (window.outerWidth > 0 && window.outerWidth < 600 && !window.chrome?.sidePanel);

document.getElementById('btn-popout')?.addEventListener('click', () => {
  if (isPopout) {
    // We're in a popup window — close it (user can reopen side panel via extension icon)
    window.close();
  } else {
    // We're in the side panel — open panel.html as a standalone popup window
    const panelUrl = chrome.runtime.getURL('sidepanel/panel.html?popout=true');
    chrome.windows.create({
      url: panelUrl,
      type: 'popup',
      width: 380,
      height: 700,
      focused: true,
    }).catch(() => {
      // Fallback: open as a regular tab
      chrome.tabs.create({ url: panelUrl }).catch(() => {});
    });
  }
});

// Update button tooltip based on context
if (isPopout) {
  const btn = document.getElementById('btn-popout');
  if (btn) { btn.title = 'Pop back into side panel'; btn.textContent = '⧉'; }
}

// Show floating quick actions panel on the active platform tab
document.getElementById('btn-show-floating')?.addEventListener('click', () => {
  if (!currentThread) return;
  const platformHosts = {
    sniffies: 'sniffies.com', grindr: 'web.grindr.com',
    doublelist: 'doublelist.com', adam4adam: 'adam4adam.com',
  };
  const platform = currentThread.platform || currentThread.contactId?.split(':')[0] || '';
  const host = platformHosts[platform];
  if (!host) return;
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (tab.id && tab.url?.includes(host)) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'SHOW_FLOATING_PANEL',
          contactId: currentThread.contactId,
          platform,
        }).catch(() => {});
        break;
      }
    }
  });
});

// Camera button — placeholder for take-picture feature
document.getElementById('btn-camera')?.addEventListener('click', () => {
  // TODO: implement camera capture
  alert('Camera feature coming soon');
});

// Gallery button — open gallery overlay
document.getElementById('btn-gallery')?.addEventListener('click', () => {
  // Open the gallery overlay if it exists
  const gallery = document.getElementById('gallery-overlay');
  if (gallery) gallery.style.display = '';
});

// ── Global search ───────────────────────────────────────────────────────────

let searchDebounce = null;

// ── Gmail-Style Keyboard Navigation ─────────────────────────────────────────
// Mirrors Gmail's keyboard shortcuts for inbox and conversation views.
// Press ? to see all available shortcuts in a help overlay.

function getThreadItems() {
  return [...document.querySelectorAll('.thread-item')];
}

function setSelectedThread(index) {
  const items = getThreadItems();
  // Remove previous selection
  items.forEach(el => el.classList.remove('selected'));
  selectedThreadIndex = Math.max(-1, Math.min(index, items.length - 1));
  if (selectedThreadIndex >= 0 && items[selectedThreadIndex]) {
    items[selectedThreadIndex].classList.add('selected');
    items[selectedThreadIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function openSelectedThread() {
  const items = getThreadItems();
  if (selectedThreadIndex >= 0 && items[selectedThreadIndex]) {
    items[selectedThreadIndex].click();
  }
}

function actionOnSelected(actionType) {
  const items = getThreadItems();
  if (selectedThreadIndex < 0 || !items[selectedThreadIndex]) return;
  const el = items[selectedThreadIndex];
  const contactId = el.dataset.contactId;
  const platform = el.dataset.platform;
  if (contactId) handleAction(actionType, contactId, platform);
}

let hotkeyHelpVisible = false;
function toggleHotkeyHelp() {
  const overlay = document.getElementById('hotkey-help');
  if (!overlay) return;
  hotkeyHelpVisible = !hotkeyHelpVisible;
  overlay.style.display = hotkeyHelpVisible ? 'flex' : 'none';
}

document.addEventListener('keydown', (e) => {
  // Always handle Ctrl/Cmd+F for search
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    toggleGlobalSearch();
    return;
  }

  // Escape: close overlays, help, settings, or go back
  if (e.key === 'Escape') {
    if (hotkeyHelpVisible) { toggleHotkeyHelp(); return; }
    const gallery = document.getElementById('gallery-overlay');
    if (gallery && gallery.style.display !== 'none') { gallery.style.display = 'none'; return; }
    const taskPanel = document.getElementById('task-panel');
    if (taskPanel && taskPanel.style.display !== 'none') { taskPanel.style.display = 'none'; return; }
    if (settingsOpen) { closeSettings(); return; }
    if (document.body.classList.contains('view-thread')) { goBack(); return; }
    return;
  }

  // Skip hotkeys when user is typing in an input/textarea/select
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // Skip modifier combos (except Shift which we use for some hotkeys)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const inInbox = document.body.classList.contains('view-inbox');
  const inThread = document.body.classList.contains('view-thread');

  // ── Universal hotkeys ──────────────────────────────────────────────────
  if (e.key === '?') { toggleHotkeyHelp(); return; }
  if (e.key === '/') { e.preventDefault(); toggleGlobalSearch(); return; }

  // ── Inbox hotkeys ──────────────────────────────────────────────────────
  if (inInbox) {
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedThread(selectedThreadIndex + 1);
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedThread(selectedThreadIndex - 1);
      return;
    }
    if (e.key === 'o' || e.key === 'Enter') {
      if (selectedThreadIndex >= 0) { e.preventDefault(); openSelectedThread(); }
      return;
    }
    if (e.key === 's') { actionOnSelected('favorite'); return; }
    if (e.key === 'x') { actionOnSelected('bookmark'); return; }
    if (e.key === 'e') { actionOnSelected('archive'); return; }
    return;
  }

  // ── Thread view hotkeys ────────────────────────────────────────────────
  if (inThread) {
    if (e.key === 'u') { goBack(); return; }
    if (e.key === 'r') {
      e.preventDefault();
      document.getElementById('response-input')?.focus();
      return;
    }
    if (e.key === 'j' || e.key === 'ArrowDown') {
      document.getElementById('message-list')?.scrollBy({ top: 100, behavior: 'smooth' });
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      document.getElementById('message-list')?.scrollBy({ top: -100, behavior: 'smooth' });
      return;
    }
    if (e.key === 's') {
      if (currentThread) handleAction('favorite', currentThread.contactId, currentThread.platform);
      return;
    }
    if (e.key === 'e') {
      if (currentThread) handleAction('archive', currentThread.contactId, currentThread.platform);
      return;
    }
    if (e.key === 'N' && e.shiftKey) {
      document.getElementById('btn-resync')?.click();
      return;
    }
    if (e.key === 'T' && e.shiftKey) {
      // Add task for current thread
      if (currentThread) createTaskFromThread();
      return;
    }
    return;
  }
});

// ── Hotkey help overlay ─────────────────────────────────────────────────────
document.getElementById('hotkey-close')?.addEventListener('click', () => toggleHotkeyHelp());

// ── Task Panel ──────────────────────────────────────────────────────────────
let taskPanelOpen = false;
let editingTaskContactId = null;
let editingTaskPlatform = null;

document.getElementById('open-tasks')?.addEventListener('click', () => toggleTaskPanel());
document.getElementById('task-back-btn')?.addEventListener('click', () => toggleTaskPanel());
document.getElementById('task-add-btn')?.addEventListener('click', () => showTaskForm());
document.getElementById('task-sync-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('task-sync-btn');
  btn.textContent = '...'; btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNC_TASKS' });
    if (res?.ok) {
      const total = (res.pulled || 0) + (res.pushed || 0) + (res.deleted || 0);
      btn.textContent = total > 0 ? `↻ ${total}` : '↻';
      loadTasks();
    } else {
      btn.textContent = '!';
    }
  } catch { btn.textContent = '!'; }
  btn.disabled = false;
  setTimeout(() => { btn.textContent = '↻'; }, 3000);
});
document.getElementById('task-cancel-btn')?.addEventListener('click', () => hideTaskForm());
document.getElementById('btn-add-task')?.addEventListener('click', () => createTaskFromThread());

document.getElementById('task-save-btn')?.addEventListener('click', async () => {
  const title = document.getElementById('task-title').value.trim();
  if (!title) return;
  const dueVal = document.getElementById('task-due').value;
  const taskData = {
    title,
    notes: document.getElementById('task-notes').value.trim(),
    dueAt: dueVal ? new Date(dueVal).toISOString() : undefined,
    priority: document.getElementById('task-priority').value,
    contactId: editingTaskContactId || undefined,
    platform: editingTaskPlatform || undefined,
  };
  // Use Google Tasks API if authenticated, with local fallback
  if (googleAuthenticated) {
    await chrome.runtime.sendMessage({ type: 'GOOGLE_TASKS_CREATE', ...taskData });
  } else {
    await chrome.runtime.sendMessage({ type: 'CREATE_TASK', ...taskData });
  }
  hideTaskForm();
  loadTasks();
});

function toggleTaskPanel() {
  const panel = document.getElementById('task-panel');
  taskPanelOpen = !taskPanelOpen;
  panel.style.display = taskPanelOpen ? '' : 'none';
  if (taskPanelOpen) loadTasks();
}

function showTaskForm(contactId, platform, prefillTitle) {
  editingTaskContactId = contactId || null;
  editingTaskPlatform = platform || null;
  const form = document.getElementById('task-form');
  form.style.display = '';
  document.getElementById('task-title').value = prefillTitle || '';
  document.getElementById('task-notes').value = '';
  document.getElementById('task-due').value = '';
  document.getElementById('task-priority').value = 'medium';
  const link = document.getElementById('task-contact-link');
  link.textContent = contactId ? `Linked: ${stripPrefix(contactId)}` : '';
  document.getElementById('task-title').focus();
}

function hideTaskForm() {
  document.getElementById('task-form').style.display = 'none';
  editingTaskContactId = null;
  editingTaskPlatform = null;
}

function createTaskFromThread() {
  if (!currentThread) return;
  const name = document.getElementById('header-title')?.textContent || stripPrefix(currentThread.contactId);
  if (!taskPanelOpen) toggleTaskPanel();
  showTaskForm(currentThread.contactId, currentThread.platform, `Follow up with ${name}`);
}

async function loadTasks() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_TASKS', opts: {} });
  const list = document.getElementById('task-list');
  if (!res?.ok || !res.tasks?.length) {
    list.innerHTML = '<div class="task-empty">No tasks yet. Click + New to add one.</div>';
    return;
  }
  list.innerHTML = res.tasks.map(t => {
    const dueStr = t.dueAt ? formatTime(t.dueAt) : '';
    const priorityDot = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢';
    const contactStr = t.contactId ? `<span class="task-contact" data-contact="${esc(t.contactId)}">${esc(stripPrefix(t.contactId).slice(0, 12))}</span>` : '';
    return `
      <div class="task-item ${t.completed ? 'completed' : ''}" data-task-id="${esc(t._id)}">
        <input type="checkbox" class="task-check" ${t.completed ? 'checked' : ''}>
        <div class="task-body">
          <div class="task-title">${priorityDot} ${esc(t.title)}</div>
          <div class="task-meta">${dueStr ? `Due: ${dueStr}` : ''} ${contactStr}</div>
          ${t.notes ? `<div class="task-notes-preview">${esc(truncate(t.notes, 60))}</div>` : ''}
        </div>
        <button class="task-delete" title="Delete">&times;</button>
      </div>
    `;
  }).join('');

  // Attach handlers
  list.querySelectorAll('.task-check').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const taskId = e.target.closest('.task-item').dataset.taskId;
      await chrome.runtime.sendMessage({
        type: 'UPDATE_TASK', id: taskId,
        updates: { completed: e.target.checked, completedAt: e.target.checked ? new Date().toISOString() : '' },
      });
      loadTasks();
    });
  });
  list.querySelectorAll('.task-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const taskId = e.target.closest('.task-item').dataset.taskId;
      await chrome.runtime.sendMessage({ type: 'DELETE_TASK', id: taskId });
      loadTasks();
    });
  });
  list.querySelectorAll('.task-contact').forEach(link => {
    link.addEventListener('click', (e) => {
      const cid = e.target.dataset.contact;
      if (cid && taskPanelOpen) toggleTaskPanel();
      // Navigate to the contact's thread
      const platform = cid.split(':')[0];
      openThread(cid, platform, '');
    });
  });
}

function toggleGlobalSearch() {
  const bar = document.getElementById('search-bar');
  const results = document.getElementById('search-results');
  if (bar.style.display === 'none') {
    bar.style.display = '';
    document.getElementById('search-input').focus();
  } else {
    bar.style.display = 'none';
    results.style.display = 'none';
    document.getElementById('search-input').value = '';
  }
}

document.getElementById('search-close').addEventListener('click', toggleGlobalSearch);

document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => performGlobalSearch(e.target.value.trim()), 300);
});

async function performGlobalSearch(query) {
  const results = document.getElementById('search-results');
  if (!query || query.length < 2) { results.style.display = 'none'; return; }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'SEARCH_MESSAGES', query, limit: 50 });
    if (!res?.ok || !res.messages?.length) {
      results.innerHTML = '<div class="empty-state"><p>No results</p></div>';
      results.style.display = '';
      return;
    }

    const q = query.toLowerCase();
    results.innerHTML = res.messages.map(m => {
      const body = m.body || '';
      const highlighted = body.replace(new RegExp(`(${escRegex(query)})`, 'gi'), '<mark>$1</mark>');
      const contact = stripPrefix(m.contactId);
      return `<div class="search-result" data-contact-id="${esc(m.contactId)}" data-platform="${esc(m.platform)}">
        <div class="search-result-contact">${esc(contact)} ${platformIcon(m.platform)}</div>
        <div class="search-result-body">${highlighted}</div>
        <div class="search-result-time">${formatTime(m.timestamp)}</div>
      </div>`;
    }).join('');
    results.style.display = '';

    results.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        toggleGlobalSearch();
        openThread(el.dataset.contactId, el.dataset.platform, stripPrefix(el.dataset.contactId));
      });
    });
  } catch {
    results.innerHTML = '<div class="empty-state"><p>Search failed</p></div>';
    results.style.display = '';
  }
}

function escRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Thread search ───────────────────────────────────────────────────────────

document.getElementById('btn-thread-search').addEventListener('click', () => {
  const bar = document.getElementById('thread-search-bar');
  bar.style.display = bar.style.display === 'none' ? '' : 'none';
  if (bar.style.display !== 'none') document.getElementById('thread-search-input').focus();
});

document.getElementById('thread-search-input').addEventListener('input', (e) => {
  const query = e.target.value.trim().toLowerCase();
  const container = document.getElementById('message-list');
  const wrappers = container.querySelectorAll('.msg-wrapper, .msg-global');
  let count = 0;

  wrappers.forEach(w => {
    if (!query) { w.style.display = ''; return; }
    const text = (w.textContent || '').toLowerCase();
    if (text.includes(query)) { w.style.display = ''; count++; }
    else { w.style.display = 'none'; }
  });

  document.getElementById('thread-search-count').textContent = query ? `${count} found` : '';
});

// ── Dossier collapse ────────────────────────────────────────────────────────
// Dossier starts minimized, remembers expanded state per-session

document.addEventListener('click', (e) => {
  if (e.target.closest('.dossier-header')) {
    const section = e.target.closest('.dossier-section');
    if (section) {
      section.classList.toggle('expanded');
      sessionStorage.setItem('dossier_expanded', section.classList.contains('expanded') ? '1' : '0');
    }
  }
});

// #11 Compact mode toggle
const compactCheckbox = document.getElementById('compact-mode');
compactCheckbox.addEventListener('change', () => {
  document.body.classList.toggle('compact', compactCheckbox.checked);
  localStorage.setItem('aggregaytor_compact', compactCheckbox.checked ? '1' : '0');
});
if (localStorage.getItem('aggregaytor_compact') === '1') {
  compactCheckbox.checked = true;
  document.body.classList.add('compact');
}

// #14 Connection status indicator
// v0.57.20: visibility-gated. The 30s probe was firing continuously even when
// the side panel was hidden (collapsed sidebar, other tab). A side panel that
// the user can't see doesn't need a live health check — and `GET_UNREAD_COUNT`
// is a full PouchDB read that can't just be ignored by the SW when things are
// quiet. Re-runs once on `visibilitychange` so the dot is fresh the moment
// the panel comes back into view.
async function checkConnectionStatus() {
  if (document.visibilityState === 'hidden') return;
  const dot = document.getElementById('connection-dot');
  if (!dot) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_COUNT' });
    dot.className = 'connection-dot ' + (res?.ok ? 'connected' : 'disconnected');
  } catch {
    dot.className = 'connection-dot disconnected';
  }
}
setInterval(checkConnectionStatus, 30_000);
checkConnectionStatus();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkConnectionStatus();
});

// #3 Avatar error fallback — delegated event listener
document.addEventListener('error', (e) => {
  if (e.target?.tagName === 'IMG' && e.target.classList.contains('avatar-img')) {
    e.target.style.display = 'none';
  }
}, true);

// ── AI Query ──────────────────────────────────────────────────────────────
// Natural-language search over contacts using LLM + profile context.
// Toggle with the 🔎 button, Ctrl/Cmd+K, enter query + press Go or Enter.
// v0.57.20: adds Ctrl+K/Cmd+K hotkey, "cached" badge when the SW returned
// a 60s-cached response, safer platform inference (pre-split by platform
// since the SW now returns the already-stripped contact id), advisory banner
// integration.

let aiQueryBusy = false;

document.getElementById('open-ai-query').addEventListener('click', toggleAIQuery);

function toggleAIQuery() {
  const bar = document.getElementById('ai-query-bar');
  const results = document.getElementById('ai-query-results');
  const threadList = document.getElementById('thread-list');
  if (bar.style.display === 'none') {
    bar.style.display = '';
    document.getElementById('ai-query-input').focus();
  } else {
    bar.style.display = 'none';
    results.style.display = 'none';
    document.getElementById('ai-query-status').style.display = 'none';
    document.getElementById('ai-query-input').value = '';
    threadList.style.display = '';
  }
}

document.getElementById('ai-query-close').addEventListener('click', toggleAIQuery);

document.getElementById('ai-query-go').addEventListener('click', runAIQuery);
document.getElementById('ai-query-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runAIQuery(); }
  if (e.key === 'Escape') toggleAIQuery();
});

// Global Ctrl/Cmd+K hotkey. Only intercept when we're not inside another
// input — we don't want to steal keystrokes from textareas or the response
// bar during a reply.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    const active = document.activeElement;
    const inText = active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && active.type === 'text'));
    if (inText && active.id !== 'ai-query-input') return; // user is typing
    e.preventDefault();
    const bar = document.getElementById('ai-query-bar');
    if (!bar) return;
    if (bar.style.display === 'none') toggleAIQuery();
    else document.getElementById('ai-query-input').focus();
  }
});

async function runAIQuery() {
  const input = document.getElementById('ai-query-input');
  const status = document.getElementById('ai-query-status');
  const results = document.getElementById('ai-query-results');
  const threadList = document.getElementById('thread-list');
  const query = input.value.trim();

  if (!query || query.length < 3 || aiQueryBusy) return;
  aiQueryBusy = true;

  status.textContent = 'Querying AI...';
  status.className = 'ai-query-status';
  status.style.display = '';
  results.style.display = 'none';
  threadList.style.display = 'none';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'QUERY_CONTACTS', query, limit: 20 });
    if (!res?.ok) {
      status.textContent = res?.error || 'Query failed';
      status.className = 'ai-query-status error';
      threadList.style.display = '';
      aiQueryBusy = false;
      return;
    }

    if (!res.matches?.length) {
      status.textContent = res.explanation || 'No matches found.';
      status.className = 'ai-query-status';
      threadList.style.display = '';
      aiQueryBusy = false;
      return;
    }

    // Fetch contact docs for avatars/display names. v0.57.20: the SW now
    // returns thread-facing ids (e.g. "grindr:12345"), not the PouchDB
    // "contact:…" form, so we derive platform by a single split and can
    // pass the id straight to openThread() without any further massaging.
    const contactDocs = new Map();
    await Promise.all(res.matches.map(async (m) => {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'GET_CONTACT', contactId: m.contactId });
        if (r?.ok && r.contact) contactDocs.set(m.contactId, r.contact);
      } catch {}
    }));

    const cachedBadge = res.cached ? '<span class="ai-query-cached-badge" title="Served from 60s cache">cached</span>' : '';
    const candidateNote = (typeof res.totalCandidates === 'number' && typeof res.sentToLLM === 'number' && res.totalCandidates > res.sentToLLM)
      ? ` · reviewed top ${res.sentToLLM} of ${res.totalCandidates}`
      : '';
    status.innerHTML = `${esc(res.explanation || '')} <span style="color:#6b7280">(${esc(String(res.provider || ''))}${esc(candidateNote)})</span>${cachedBadge}`;
    status.className = 'ai-query-status';

    results.innerHTML = `<div class="ai-query-explanation">${esc(res.explanation)}${cachedBadge}</div>` +
      res.matches.map((m, i) => {
        const c = contactDocs.get(m.contactId);
        const name = c?.displayName || stripPrefix(m.contactId);
        const avatar = c?.avatarUrl || '';
        // The returned id is "{platform}:{userId}" — split once and take the
        // first component. Falls back to the contact doc's platform field.
        const plat = c?.platform || String(m.contactId).split(':')[0] || '';
        return `<div class="ai-query-result" data-contact-id="${esc(m.contactId)}" data-platform="${esc(plat)}" data-name="${esc(name)}">
          <span class="ai-query-result-rank">${i + 1}</span>
          ${avatar ? `<img class="ai-query-result-avatar" src="${esc(avatar)}" alt="">` : '<div class="ai-query-result-avatar"></div>'}
          <div class="ai-query-result-info">
            <div class="ai-query-result-name">${esc(name)} <span class="platform-tag">${esc(plat)}</span></div>
            <div class="ai-query-result-reason">${esc(m.reason)}</div>
          </div>
        </div>`;
      }).join('');
    results.style.display = '';

    // Click to open thread
    results.querySelectorAll('.ai-query-result').forEach(el => {
      el.addEventListener('click', () => {
        openThread(el.dataset.contactId, el.dataset.platform, el.dataset.name);
      });
    });
  } catch (err) {
    status.textContent = String(err?.message || 'Query failed');
    status.className = 'ai-query-status error';
    threadList.style.display = '';
  }
  aiQueryBusy = false;
}

// ── Deprecation Advisory Banner ─────────────────────────────────────────────
// v0.57.20: surface LLM-provider deprecations to the user in-panel so they
// can pin a different provider before the auto-fallback kicks in.
async function loadAdvisoryBanner() {
  const banner = document.getElementById('advisory-banner');
  if (!banner) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_DEPRECATION_WARNINGS' });
    if (!res?.ok || !res.warnings?.length) { banner.style.display = 'none'; return; }
    // Respect user-dismissed banner IDs for the current day.
    const dismissed = JSON.parse(localStorage.getItem('aggregaytor_advisory_dismissed') || '{}');
    const today = new Date().toISOString().slice(0, 10);
    const active = res.warnings.find(w => dismissed[w.id] !== today);
    if (!active) { banner.style.display = 'none'; return; }
    banner.className = 'advisory-banner' + (active.active ? ' active' : '');
    banner.innerHTML = `<span class="advisory-text">⚠ ${esc(active.message)}</span>` +
      `<button class="advisory-close" data-banner-id="${esc(active.id)}" title="Dismiss for today">✕</button>`;
    banner.style.display = '';
    banner.querySelector('.advisory-close').addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.bannerId;
      const next = { ...dismissed, [id]: today };
      try { localStorage.setItem('aggregaytor_advisory_dismissed', JSON.stringify(next)); } catch {}
      banner.style.display = 'none';
    });
  } catch {
    banner.style.display = 'none';
  }
}
loadAdvisoryBanner();

loadThreads();
loadDrafts();
