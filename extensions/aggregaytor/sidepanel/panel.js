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

let filters = {
  searchText: '', bodyType: [], position: [], minDeleteCount: 0,
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
    if (filters.hasResponded) {
      // Must have at least one inbound message
      if (t.lastMessage?.direction !== 'in' && !t.unreadCount) return false;
    }
    if (filters.engagedRecently) {
      const lastTs = new Date(t.lastMessage?.timestamp || 0).getTime();
      if (Date.now() - lastTs > 24 * 60 * 60 * 1000) return false;
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
    const name = meta.alias || t.contact?.displayName || stripPrefix(t.contactId) || '?';
    const initial = name.charAt(0).toUpperCase();
    const preview = t.lastMessage?.body || '';
    const time = formatTime(t.lastMessage?.timestamp);
    const unread = t.unreadCount || 0;
    totalUnread += unread;

    let badges = '';
    if (meta.bookmarked) badges += '<span class="meta-badge bookmarked">★</span>';
    if (meta.autoRespondEnabled) badges += '<span class="meta-badge autorespond">🤖</span>';

    return `
      <div class="thread-item${unread ? ' unread' : ''}"
           data-contact-id="${esc(t.contactId)}" data-platform="${esc(t.platform)}" data-name="${esc(name)}">
        <div class="avatar">${esc(initial)}<span class="platform-dot ${esc(t.platform)}"></span></div>
        <div class="thread-content">
          <div class="thread-header">
            <span class="thread-name">${esc(name)}</span>
            <span class="thread-time">${time}${badges ? ' <span class="meta-badges">' + badges + '</span>' : ''}${unread ? ` <span class="unread-badge">${unread}</span>` : ''}</span>
          </div>
          <div class="thread-preview">${esc(truncate(preview, 70))}</div>
        </div>
        <div class="thread-actions">
          <span class="action-icon${meta.bookmarked ? ' active' : ''}" data-action="bookmark" title="Bookmark">${meta.bookmarked ? '★' : '☆'}</span>
          <span class="action-icon" data-action="notes" title="Notes">📝</span>
          <span class="action-icon" data-action="archive" title="Archive">📦</span>
          <span class="action-icon" data-action="hide" title="Hide until reply">🙈</span>
          <span class="action-icon" data-action="greet" title="Send greeting">👋</span>
          <span class="action-icon${meta.autoRespondEnabled ? ' active' : ''}" data-action="autorespond" title="Auto-respond">${meta.autoRespondEnabled ? '🤖' : '🤖'}</span>
        </div>
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
}

async function handleAction(action, contactId, platform) {
  switch (action) {
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

  // Navigate parent tab
  chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_CONVERSATION', platform, contactId }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'MARK_THREAD_READ', threadId: contactId }).catch(() => {});

  // Load messages
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_MESSAGES_BY_CONTACT', contactId, limit: 500 });
    if (res?.ok) { currentMessages = res.messages || []; renderMessages(currentMessages); }
  } catch (err) { console.error('[Panel] Message load error:', err); }
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

window.toggleDraftPanel = async function() {
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
          <button class="draft-btn approve" onclick="approveDraft('${d._id}', this)">Approve & Send</button>
          <button class="draft-btn reject" onclick="rejectDraft('${d._id}')">Reject</button>
        </div>
      </div>`;
  }).join('');
  panel.style.display = '';
};

window.approveDraft = async function(id, btn) {
  const body = btn.closest('.draft-item').querySelector('.draft-body');
  const editedResponse = body?.textContent?.trim();
  await chrome.runtime.sendMessage({ type: 'APPROVE_DRAFT', id, editedResponse });
  loadDrafts();
};

window.rejectDraft = async function(id) {
  await chrome.runtime.sendMessage({ type: 'REJECT_DRAFT', id });
  loadDrafts();
};

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
  filters.hasResponded = document.getElementById('filter-responded').checked;
  filters.engagedRecently = document.getElementById('filter-recent').checked;
  filters.bookmarked = document.getElementById('filter-bookmarked').checked;

  const count = (filters.searchText ? 1 : 0) + filters.bodyType.length + filters.position.length +
    (filters.minDeleteCount ? 1 : 0) + (filters.hasResponded ? 1 : 0) + (filters.engagedRecently ? 1 : 0) + (filters.bookmarked ? 1 : 0);
  const badge = document.getElementById('filter-count');
  if (count) { badge.textContent = count; badge.style.display = ''; } else { badge.style.display = 'none'; }

  loadThreads();
}

for (const id of ['filter-search', 'filter-body', 'filter-position', 'filter-deletes']) {
  document.getElementById(id).addEventListener('change', readFilters);
}
document.getElementById('filter-search').addEventListener('input', readFilters);
for (const id of ['filter-responded', 'filter-recent', 'filter-bookmarked']) {
  document.getElementById(id).addEventListener('change', readFilters);
}
document.getElementById('filter-clear').addEventListener('click', () => {
  document.getElementById('filter-search').value = '';
  document.getElementById('filter-body').selectedIndex = -1;
  document.getElementById('filter-position').selectedIndex = -1;
  document.getElementById('filter-deletes').value = '0';
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
});

// ── Utilities ───────────────────────────────────────────────────────────────

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
