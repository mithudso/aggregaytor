/**
 * panel.js — Side panel controller.
 *
 * Views: inbox (thread list with filters + action icons) and
 * thread (message detail with notes, reminders, suggestions).
 */

let currentPlatform = 'all';
let currentThread = null;
let currentMessages = [];
let currentMeta = null;
let allThreadMeta = new Map();
let activeOnSiteContactId = null; // which conversation is open on the actual site

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
  _newMsgTimer = setTimeout(() => loadThreads(), 500);
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
  const opts = currentPlatform === 'all' ? {} : { platform: currentPlatform };
  // #10 Show skeleton loader if thread list is empty
  const container = document.getElementById('thread-list');
  if (!container.querySelector('.thread-item') && !container.querySelector('.skeleton-item')) {
    container.innerHTML = Array(5).fill(0).map(() => `
      <div class="skeleton-item"><div class="skeleton-avatar"></div>
        <div class="skeleton-content"><div class="skeleton-line w70"></div><div class="skeleton-line w40"></div></div>
      </div>`).join('');
  }
  try {
    const [threadRes, metaRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_THREAD_SUMMARIES', opts }),
      chrome.runtime.sendMessage({ type: 'GET_ALL_THREAD_META' }),
    ]);
    if (metaRes?.ok) {
      allThreadMeta.clear();
      for (const m of metaRes.metas || []) allThreadMeta.set(m.contactId, m);
    }
    if (threadRes?.ok) {
      const all = threadRes.summaries;
      renderThreads(sortThreads(applyFilters(all)));
      // #15 Per-platform unread badges
      const platformUnread = {};
      for (const s of all) {
        if (s.unreadCount) platformUnread[s.platform] = (platformUnread[s.platform] || 0) + s.unreadCount;
      }
      document.querySelectorAll('.platform-chip[data-platform]').forEach(chip => {
        const p = chip.dataset.platform;
        const existing = chip.querySelector('.chip-badge');
        if (existing) existing.remove();
        if (p !== 'all' && p !== 'archived' && platformUnread[p]) {
          const badge = document.createElement('span');
          badge.className = 'chip-badge';
          badge.textContent = platformUnread[p];
          chip.appendChild(badge);
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
    // If name is just a hex ID or empty, we need a nickname
    const isHexOnly = !rawName || /^[0-9a-f]{6,}$/i.test(rawName);
    const name = isHexOnly ? (meta.generatedNickname || hexId.slice(0, 8)) : rawName;
    const initial = name.charAt(0).toUpperCase();
    const preview = t.lastMessage?.body || '';
    // Don't generate nicknames eagerly on render — it floods the LLM queue
    // Nicknames are generated lazily when hovering or opening a thread
    const time = formatTime(t.lastMessage?.timestamp);
    const unread = t.unreadCount || 0;
    totalUnread += unread;

    let badges = '';
    if (meta.bookmarked) badges += '<span class="meta-badge bookmarked">★</span>';
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

// Cache hover preview data to avoid repeated queries
const hoverPreviewCache = new Map();
const HOVER_CACHE_TTL = 30_000; // 30 seconds

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
    const [msgRes, summaryRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_MESSAGES_BY_CONTACT', contactId, limit: 6 }),
      chrome.runtime.sendMessage({ type: 'GET_THREAD_SUMMARIES', opts: {} }),
    ]);

    const messages = msgRes?.messages || [];
    const thread = summaryRes?.summaries?.find(s => s.contactId === contactId);
    const contact = thread?.contact;
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
    // Cache the rendered preview
    hoverPreviewCache.set(contactId, { html: previewEl.innerHTML, ts: Date.now() });
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

  // Lazy nickname: generate only when user actually opens the thread
  const hexId = stripPrefix(contactId);
  if ((!displayName || /^[0-9a-f]{6,}$/i.test(displayName)) && platform === 'sniffies') {
    generateNickname(contactId, platform, null, null);
  }

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

  // Navigate parent tab
  chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_CONVERSATION', platform, contactId }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'MARK_THREAD_READ', threadId: contactId }).catch(() => {});
  // #19 Badge sync — update badge immediately on read
  chrome.runtime.sendMessage({ type: 'GET_UNREAD_COUNT' }).catch(() => {});

  // Load messages
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_MESSAGES_BY_CONTACT', contactId, limit: 500 });
    if (res?.ok) { currentMessages = res.messages || []; renderMessages(currentMessages); loadThreadAnalysis(); }
  } catch (err) { console.error('[Panel] Message load error:', err); }
}

async function loadProfileInfo(contactId) {
  const el = document.getElementById('profile-info');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_THREAD_META', contactId });
    // Also get contact doc for profile data
    const summaries = await chrome.runtime.sendMessage({ type: 'GET_THREAD_SUMMARIES', opts: {} });
    const thread = summaries?.summaries?.find(s => s.contactId === contactId);
    const contact = thread?.contact;
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
      ${!avatar ? `<button class="sync-pic-btn" id="sync-this-pic">📷 Sync photos for this profile</button>` : ''}
      ${meta.notes ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px;border-top:1px solid rgba(255,255,255,0.06);padding-top:4px">${esc(meta.notes)}</div>` : ''}
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
            // Reload profile info to show the new avatar
            loadProfileInfo(contactId);
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
  container.innerHTML = `
    <span class="action-icon${m.bookmarked ? ' active' : ''}" data-action="bookmark" title="Bookmark">${m.bookmarked ? '★' : '☆'}</span>
    <span class="action-icon" data-action="notes" title="Notes">📝</span>
    <span class="action-icon" data-action="dossier" title="Dossier">📋</span>
    <span class="action-icon" data-action="reminder" title="Reminder">⏰</span>
    <span class="action-icon" data-action="archive" title="Archive">📦</span>
    <span class="action-icon" data-action="hide" title="Hide until reply">🙈</span>
    <span class="action-icon" data-action="greet" title="Greeting">👋</span>
    <span class="action-icon${m.autoRespondEnabled ? ' active' : ''}" data-action="autorespond" title="Auto-respond">🤖</span>
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
  document.getElementById('header-title').textContent = 'Aggregaytor';
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
    document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentPlatform = chip.dataset.platform;
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
  if (message.type === 'ACTIVE_PROFILE_CHANGED') {
    activeOnSiteContactId = message.contactId || null;
    // Mark as read since user is looking at it on the site
    if (message.contactId) {
      chrome.runtime.sendMessage({ type: 'MARK_THREAD_READ', threadId: message.contactId }).catch(() => {});
    }
    if (document.body.classList.contains('view-inbox')) loadThreads();
    setTimeout(() => {
      const active = document.querySelector('.thread-item.active-on-site');
      if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
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
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), ms = Date.now() - d.getTime(), m = Math.floor(ms / 60000);
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
    const summRes = await chrome.runtime.sendMessage({ type: 'GET_THREAD_SUMMARIES', opts: {} });
    const thread = summRes?.summaries?.find(s => s.contactId === contactId);
    const contact = thread?.contact;
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
  document.getElementById('header-title').textContent = 'Aggregaytor';
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

document.getElementById('sp-open-full-settings').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
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

function addDevLog(msg) {
  devLogMessages.push(`${new Date().toLocaleTimeString()} ${msg}`);
  if (devLogMessages.length > 200) devLogMessages.shift();
  if (devLogVisible) renderDevLog();
}

function renderDevLog() {
  devLogEl.innerHTML = devLogMessages.slice(-50).map(m => `<div>${esc(m)}</div>`).join('');
  devLogEl.scrollTop = devLogEl.scrollHeight;
}

// Hook into message listener to populate dev log
const origListener = chrome.runtime.onMessage._listeners?.[0];
chrome.runtime.onMessage.addListener((message) => {
  if (message.type) addDevLog(`← ${message.type} ${message.platform || ''} ${message.count || ''}`);
});

// ── Open all sites on title click ───────────────────────────────────────────

document.getElementById('header-title').addEventListener('click', (e) => {
  // Only in inbox view (not thread detail where it shows contact name)
  if (!document.body.classList.contains('view-inbox')) return;
  chrome.runtime.sendMessage({ type: 'OPEN_ALL_SITES' }).catch(() => {});
});

// ── Global search ───────────────────────────────────────────────────────────

let searchDebounce = null;
// Toggle search with Ctrl+F or clicking a search icon
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    toggleGlobalSearch();
  }
  // #5 Escape to go back
  if (e.key === 'Escape') {
    if (document.getElementById('gallery-overlay').style.display !== 'none') {
      document.getElementById('gallery-overlay').style.display = 'none';
    } else if (settingsOpen) {
      closeSettings();
    } else if (document.body.classList.contains('view-thread')) {
      goBack();
    }
  }
});

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
async function checkConnectionStatus() {
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

// #3 Avatar error fallback — delegated event listener
document.addEventListener('error', (e) => {
  if (e.target?.tagName === 'IMG' && e.target.classList.contains('avatar-img')) {
    e.target.style.display = 'none';
  }
}, true);

loadThreads();
loadDrafts();
