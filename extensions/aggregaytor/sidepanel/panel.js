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
  hasResponded: false, engagedRecently: false, bookmarked: false,
};

// ── Inbox ───────────────────────────────────────────────────────────────────

async function loadThreads() {
  const opts = currentPlatform === 'all' ? {} : { platform: currentPlatform };
  try {
    const [threadRes, metaRes] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_THREAD_SUMMARIES', opts }),
      chrome.runtime.sendMessage({ type: 'GET_ALL_THREAD_META' }),
    ]);
    if (metaRes?.ok) {
      allThreadMeta.clear();
      for (const m of metaRes.metas || []) allThreadMeta.set(m.contactId, m);
    }
    if (threadRes?.ok) renderThreads(applyFilters(threadRes.summaries));
  } catch (err) { console.error('[Panel] Load error:', err); }
}

function applyFilters(summaries) {
  return summaries.filter(t => {
    const meta = allThreadMeta.get(t.contactId) || {};
    // Hide archived and hidden-until-response
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
    return true;
  });
}

function renderThreads(summaries) {
  const container = document.getElementById('thread-list');
  if (!summaries?.length) {
    container.innerHTML = '<div class="empty-state"><h2>No conversations match</h2><p>Try adjusting your filters.</p></div>';
    updateTotalUnread(0);
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
    // Queue nickname generation for hex-only names
    if (isHexOnly && !meta.generatedNickname) {
      generateNickname(t.contactId, t.platform, t.contact, t.lastMessage);
    }
    const time = formatTime(t.lastMessage?.timestamp);
    const unread = t.unreadCount || 0;
    totalUnread += unread;

    let badges = '';
    if (meta.bookmarked) badges += '<span class="meta-badge bookmarked">★</span>';
    if (meta.autoRespondEnabled) badges += '<span class="meta-badge autorespond">🤖</span>';

    const avatarUrl = t.contact?.avatarUrl;
    const avatarHtml = avatarUrl
      ? `<div class="avatar"><img src="${esc(avatarUrl)}" alt="" class="avatar-img"><span class="platform-dot ${esc(t.platform)}"></span></div>`
      : `<div class="avatar">${esc(initial)}<span class="platform-dot ${esc(t.platform)}"></span></div>`;

    const isActiveSite = activeOnSiteContactId === t.contactId;
    const isBlocked = meta.blockedByThem || false;
    const distance = t.contact?.metadata?.distance || meta.distance || '';
    const lastDir = t.lastMessage?.direction;
    const dirArrow = lastDir === 'out' ? '<span class="dir-arrow out">↗</span>' : lastDir === 'in' ? '<span class="dir-arrow in">↙</span>' : '';

    return `
      <div class="thread-item${unread ? ' unread' : ''}${isActiveSite ? ' active-on-site' : ''}${isBlocked ? ' blocked' : ''}"
           data-contact-id="${esc(t.contactId)}" data-platform="${esc(t.platform)}" data-name="${esc(name)}">
        ${avatarHtml}${platformIcon(t.platform)}
        <div class="thread-content">
          <div class="thread-header">
            <span class="thread-name${isBlocked ? ' strikethrough' : ''}">${esc(name)}</span>${distance ? `<span class="thread-distance">${esc(distance)}</span>` : ''}
            <span class="thread-time">${time}${badges ? ' <span class="meta-badges">' + badges + '</span>' : ''}${unread ? ` <span class="unread-badge">${unread}</span>` : ''}</span>
          </div>
          <div class="thread-preview">${dirArrow}${esc(truncate(preview, 65))}</div>
        </div>
        <div class="thread-actions">
          <span class="action-icon" data-action="like" title="Like">👍</span>
          <span class="action-icon" data-action="dislike" title="Pass & hide">👎</span>
          <span class="action-icon${meta.bookmarked ? ' active' : ''}" data-action="bookmark" title="Bookmark">${meta.bookmarked ? '★' : '☆'}</span>
          <span class="action-icon" data-action="notes" title="Notes">📝</span>
          <span class="action-icon" data-action="archive" title="Archive">📦</span>
          <span class="action-icon" data-action="hide" title="Hide until reply">🙈</span>
          <span class="action-icon" data-action="greet" title="Send greeting">👋</span>
          <span class="action-icon${meta.autoRespondEnabled ? ' active' : ''}" data-action="autorespond" title="Auto-respond">🤖</span>
        </div>
        <div class="hover-preview" data-preview-for="${esc(t.contactId)}"></div>
      </div>`;
  }).join('');

  updateTotalUnread(totalUnread);

  // Click handlers
  container.querySelectorAll('.thread-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.thread-actions')) return; // handled by action icons
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

async function loadHoverPreview(contactId, platform, previewEl, threadEl) {
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
  } catch (err) {
    previewEl.innerHTML = '<div class="hp-loading">Preview unavailable</div>';
  }
}

async function handleAction(action, contactId, platform) {
  switch (action) {
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
    case 'archive':
      if (confirm('Archive this conversation?')) {
        await chrome.runtime.sendMessage({
          type: 'UPSERT_THREAD_META', contactId, platform,
          updates: { archived: true },
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
  currentThread = { contactId, platform, displayName };
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

  // Load profile info
  loadProfileInfo(contactId);

  // Navigate parent tab
  chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_CONVERSATION', platform, contactId }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'MARK_THREAD_READ', threadId: contactId }).catch(() => {});

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
      ${meta.notes ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px;border-top:1px solid rgba(255,255,255,0.06);padding-top:4px">${esc(meta.notes)}</div>` : ''}
    `;
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
      } else {
        handleAction(action, currentThread.contactId, currentThread.platform);
      }
    });
  });
}

function renderMessages(messages) {
  const container = document.getElementById('message-list');
  if (!messages?.length) {
    container.innerHTML = '<div class="empty-state"><p>No messages yet.</p></div>';
    return;
  }
  const sorted = [...messages].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  let lastDate = '';
  container.innerHTML = sorted.map(msg => {
    const msgDate = formatDate(msg.timestamp);
    let sep = '';
    if (msgDate !== lastDate) { lastDate = msgDate; sep = `<div class="msg-date-sep">${msgDate}</div>`; }
    const dir = msg.direction || 'in';
    return `${sep}<div class="msg-bubble ${dir}">${esc(msg.body || '')}</div><div class="msg-time ${dir}">${formatMsgTime(msg.timestamp)}</div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
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

function goBack() {
  currentThread = null; currentMessages = []; currentMeta = null;
  document.body.classList.remove('view-thread');
  document.body.classList.add('view-inbox');
  document.getElementById('header-title').textContent = 'Aggregaytor';
  document.getElementById('suggestions').classList.remove('active');
  document.getElementById('notes-section').style.display = 'none';
  document.getElementById('reminder-section').style.display = 'none';
  loadThreads();
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

  const count = (filters.searchText ? 1 : 0) + filters.bodyType.length + filters.position.length +
    (filters.minDeleteCount ? 1 : 0) + (filters.maxDistance ? 1 : 0) +
    (filters.unreadOnly ? 1 : 0) + (filters.newChatsOnly ? 1 : 0) +
    (filters.hasResponded ? 1 : 0) + (filters.engagedRecently ? 1 : 0) + (filters.bookmarked ? 1 : 0);
  const badge = document.getElementById('filter-count');
  if (count) { badge.textContent = count; badge.style.display = ''; } else { badge.style.display = 'none'; }

  loadThreads();
}

for (const id of ['filter-search', 'filter-body', 'filter-position', 'filter-deletes', 'filter-distance']) {
  document.getElementById(id).addEventListener('change', readFilters);
}
document.getElementById('filter-search').addEventListener('input', readFilters);
for (const id of ['filter-responded', 'filter-recent', 'filter-bookmarked', 'filter-unread', 'filter-newchats']) {
  document.getElementById(id).addEventListener('change', readFilters);
}
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
  readFilters();
});

// ── Event listeners ─────────────────────────────────────────────────────────

document.getElementById('back-btn').addEventListener('click', goBack);
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
    if (document.body.classList.contains('view-inbox')) loadThreads();
    else if (currentThread && message.platform === currentThread.platform) {
      chrome.runtime.sendMessage({ type: 'GET_MESSAGES_BY_CONTACT', contactId: currentThread.contactId, limit: 500 })
        .then(res => { if (res?.ok) { currentMessages = res.messages || []; renderMessages(currentMessages); } }).catch(() => {});
    }
    loadDrafts();
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
function formatMsgTime(iso) { return !iso ? '' : new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function updateTotalUnread(count) {
  const b = document.getElementById('total-unread');
  if (count > 0) { b.textContent = count; b.style.display = ''; } else { b.style.display = 'none'; }
}

loadThreads();
loadDrafts();
