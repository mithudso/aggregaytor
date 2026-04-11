/**
 * popup.js — Extension popup quick actions.
 */

async function loadStats() {
  const container = document.getElementById('stats');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_COUNT' });
    const count = response?.count || 0;
    container.innerHTML = `
      <div class="stat">
        <span class="stat-label">Unread messages</span>
        <span class="stat-value">${count}</span>
      </div>
    `;
  } catch {
    container.innerHTML = `
      <div class="stat">
        <span class="stat-label">Status</span>
        <span class="stat-value">Connecting...</span>
      </div>
    `;
  }
}

document.getElementById('open-panel').addEventListener('click', async () => {
  // Open side panel
  try {
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
    window.close();
  } catch {
    // Fallback: open as a tab
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/panel.html') });
    window.close();
  }
});

loadStats();
