/**
 * panel.js — Side panel controller.
 *
 * Views: inbox (thread list) and thread (message detail).
 * Features: click-to-navigate, full conversation display, response suggestions.
 */

let currentPlatform = 'all';
let currentThread = null; // { contactId, platform, contact }
let currentMessages = [];

// ── Inbox view ──────────────────────────────────────────────────────────────

async function loadThreads() {
  const opts = currentPlatform === 'all' ? {} : { platform: currentPlatform };
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_THREAD_SUMMARIES', opts });
    if (res?.ok) renderThreads(res.summaries);
  } catch (err) {
    console.error('[Aggregaytor:Panel] Failed to load threads:', err);
  }
}

function renderThreads(summaries) {
  const container = document.getElementById('thread-list');
  if (!summaries?.length) {
    container.innerHTML = '<div class="empty-state"><h2>No messages yet</h2><p>Visit a connected site to start capturing messages.</p></div>';
    updateTotalUnread(0);
    return;
  }

  let totalUnread = 0;
  container.innerHTML = summaries.map(t => {
    const name = t.contact?.displayName || stripPrefix(t.contactId) || 'Unknown';
    const initial = name.charAt(0).toUpperCase();
    const preview = t.lastMessage?.body || '';
    const time = formatTime(t.lastMessage?.timestamp);
    const unread = t.unreadCount || 0;
    totalUnread += unread;

    return `
      <div class="thread-item${unread ? ' unread' : ''}"
           data-contact-id="${esc(t.contactId)}"
           data-platform="${esc(t.platform)}"
           data-name="${esc(name)}">
        <div class="avatar">
          ${esc(initial)}
          <span class="platform-dot ${esc(t.platform)}"></span>
        </div>
        <div class="thread-content">
          <div class="thread-header">
            <span class="thread-name">${esc(name)}</span>
            <span class="thread-time">${time}${unread ? ` <span class="unread-badge">${unread}</span>` : ''}</span>
          </div>
          <div class="thread-preview">${esc(truncate(preview, 80))}</div>
        </div>
      </div>`;
  }).join('');

  updateTotalUnread(totalUnread);

  // Attach click handlers
  container.querySelectorAll('.thread-item').forEach(el => {
    el.addEventListener('click', () => {
      const contactId = el.dataset.contactId;
      const platform = el.dataset.platform;
      const name = el.dataset.name;
      openThread(contactId, platform, name);
    });
  });
}

// ── Thread detail view ──────────────────────────────────────────────────────

async function openThread(contactId, platform, displayName) {
  currentThread = { contactId, platform, displayName };
  document.getElementById('header-title').textContent = displayName || stripPrefix(contactId);
  document.body.classList.remove('view-inbox');
  document.body.classList.add('view-thread');
  document.getElementById('suggestions').classList.remove('active');
  document.getElementById('response-input').value = '';

  // Navigate the parent tab to this conversation
  chrome.runtime.sendMessage({
    type: 'NAVIGATE_TO_CONVERSATION',
    platform,
    contactId,
  }).catch(() => {});

  // Mark thread as read
  chrome.runtime.sendMessage({
    type: 'MARK_THREAD_READ',
    threadId: contactId,
  }).catch(() => {});

  // Load messages
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_MESSAGES_BY_CONTACT',
      contactId,
      limit: 500,
    });
    if (res?.ok) {
      currentMessages = res.messages || [];
      renderMessages(currentMessages);
    }
  } catch (err) {
    console.error('[Aggregaytor:Panel] Failed to load messages:', err);
  }
}

function renderMessages(messages) {
  const container = document.getElementById('message-list');
  if (!messages?.length) {
    container.innerHTML = '<div class="empty-state"><p>No messages in this conversation yet.</p></div>';
    return;
  }

  // Sort chronologically
  const sorted = [...messages].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  let lastDate = '';
  container.innerHTML = sorted.map(msg => {
    const msgDate = formatDate(msg.timestamp);
    let dateSep = '';
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      dateSep = `<div class="msg-date-sep">${msgDate}</div>`;
    }
    const dir = msg.direction || 'in';
    const time = formatMsgTime(msg.timestamp);
    const body = msg.body || '';
    const migrated = msg.metadata?.migrated;

    return `${dateSep}
      <div class="msg-bubble ${dir}">${esc(body)}</div>
      <div class="msg-time ${dir}">${time}${migrated ? ' (migrated)' : ''}</div>`;
  }).join('');

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function goBack() {
  currentThread = null;
  currentMessages = [];
  document.body.classList.remove('view-thread');
  document.body.classList.add('view-inbox');
  document.getElementById('header-title').textContent = 'Aggregaytor';
  document.getElementById('suggestions').classList.remove('active');
  loadThreads();
}

// ── Response suggestions ────────────────────────────────────────────────────

async function generateSuggestions() {
  if (!currentThread || !currentMessages.length) return;

  const btn = document.getElementById('suggest-btn');
  btn.disabled = true;
  btn.textContent = 'Thinking...';

  const suggestionsEl = document.getElementById('suggestions');

  try {
    // Send to service worker which calls the configured LLM
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_SUGGESTIONS',
      messages: currentMessages.slice(-30).map(m => ({
        direction: m.direction,
        body: m.body,
        timestamp: m.timestamp,
      })),
      contactName: currentThread.displayName || stripPrefix(currentThread.contactId),
      platform: currentThread.platform,
    });

    const suggestions = res?.suggestions || ['Hey', 'Sounds good', 'What do you think?'];
    const provider = res?.provider || 'local';
    const providerLabel = provider === 'local' ? '' : ` via ${provider}`;

    suggestionsEl.innerHTML = `<div class="label">Suggested responses${providerLabel}${res?.error ? ' (fallback)' : ''}</div>` +
      suggestions.map(s =>
        `<div class="suggestion-chip">${esc(s)}</div>`
      ).join('');
    suggestionsEl.classList.add('active');

    suggestionsEl.querySelectorAll('.suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.getElementById('response-input').value = chip.textContent;
        suggestionsEl.classList.remove('active');
      });
    });
  } catch (err) {
    console.error('[Aggregaytor:Panel] Suggestion error:', err);
    suggestionsEl.innerHTML = '<div class="label">Could not generate suggestions</div>';
    suggestionsEl.classList.add('active');
  }

  btn.disabled = false;
  btn.textContent = 'Suggest';
}

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

// Auto-resize textarea
const textarea = document.getElementById('response-input');
textarea.addEventListener('input', () => {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
});

// Listen for real-time updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'NEW_MESSAGES') {
    if (document.body.classList.contains('view-inbox')) {
      loadThreads();
    } else if (currentThread && message.platform === currentThread.platform) {
      // Refresh current thread
      chrome.runtime.sendMessage({
        type: 'GET_MESSAGES_BY_CONTACT',
        contactId: currentThread.contactId,
        limit: 500,
      }).then(res => {
        if (res?.ok) {
          currentMessages = res.messages || [];
          renderMessages(currentMessages);
        }
      }).catch(() => {});
    }
  }
});

// ── Utilities ───────────────────────────────────────────────────────────────

function stripPrefix(id) {
  return String(id || '').replace(/^[a-z]+:/, '');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function esc(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML;
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return diffMin + 'm';
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + 'h';
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return diffDay + 'd';
  return date.toLocaleDateString();
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - msgDay) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function formatMsgTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function updateTotalUnread(count) {
  const badge = document.getElementById('total-unread');
  if (count > 0) {
    badge.textContent = String(count);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// Initial load
loadThreads();
