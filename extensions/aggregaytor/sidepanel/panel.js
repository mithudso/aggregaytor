/**
 * panel.js — Side panel UI controller.
 *
 * Queries the service worker for thread summaries and renders them.
 * Listens for NEW_MESSAGES broadcasts to update in real time.
 */

let currentPlatform = 'all';

async function loadThreads() {
  const opts = currentPlatform === 'all' ? {} : { platform: currentPlatform };
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_THREAD_SUMMARIES',
      opts,
    });
    if (response?.ok) {
      renderThreads(response.summaries);
    }
  } catch (err) {
    console.error('[Aggregaytor] Failed to load threads:', err);
  }
}

function renderThreads(summaries) {
  const container = document.getElementById('thread-list');
  if (!summaries || !summaries.length) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No messages yet</h2>
        <p>Visit a connected site to start capturing messages.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = summaries.map(thread => {
    const name = thread.contact?.displayName || thread.contactId.split(':').pop() || 'Unknown';
    const initial = name.charAt(0).toUpperCase();
    const preview = thread.lastMessage?.body || '';
    const time = formatTime(thread.lastMessage?.timestamp);
    const unreadClass = thread.unreadCount > 0 ? ' unread' : '';
    const badge = thread.unreadCount > 0
      ? `<span class="unread-badge">${thread.unreadCount}</span>`
      : '';

    return `
      <div class="thread-item${unreadClass}" data-contact-id="${thread.contactId}">
        <div class="avatar">${initial}</div>
        <div class="thread-content">
          <div class="thread-header">
            <span class="thread-name">${escapeHtml(name)}</span>
            <span class="thread-time">${time} ${badge}</span>
          </div>
          <div class="thread-preview">${escapeHtml(preview)}</div>
        </div>
      </div>
    `;
  }).join('');

  // Update total unread
  const totalUnread = summaries.reduce((sum, t) => sum + t.unreadCount, 0);
  const badge = document.getElementById('total-unread');
  if (totalUnread > 0) {
    badge.textContent = String(totalUnread);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return date.toLocaleDateString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Platform filter chips
document.querySelectorAll('.platform-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentPlatform = chip.dataset.platform;
    loadThreads();
  });
});

// Listen for real-time updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'NEW_MESSAGES') {
    loadThreads();
  }
});

// Initial load
loadThreads();
