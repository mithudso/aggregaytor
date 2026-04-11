/**
 * popup.js — Extension popup with stats and LLM settings.
 */

const PROVIDER_INFO = {
  local: 'Pattern-based suggestions, no API key needed. Works offline.',
  anthropic: 'Uses Claude (Haiku by default). Get your key at console.anthropic.com',
  gemini: 'Uses Gemini Flash (free tier). Get your key at aistudio.google.com',
  openai: 'Uses GPT-4o-mini. Get your key at platform.openai.com',
};

const DEFAULT_MODELS = {
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  local: '',
};

async function loadStats() {
  const container = document.getElementById('stats');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_COUNT' });
    container.innerHTML = `<div class="stat"><span class="stat-label">Unread messages</span><span class="stat-value">${res?.count || 0}</span></div>`;
  } catch {
    container.innerHTML = `<div class="stat"><span class="stat-label">Status</span><span class="stat-value">Connecting...</span></div>`;
  }
}

async function loadSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
    if (res?.ok) {
      const config = res.config;
      document.getElementById('provider').value = config.provider || 'local';
      document.getElementById('api-key').value = config.apiKey || '';
      document.getElementById('model').value = config.model || '';
      updateProviderUI(config.provider || 'local');
    }
  } catch {
    // service worker not ready yet
  }
}

function updateProviderUI(provider) {
  const info = document.getElementById('provider-info');
  const keySection = document.getElementById('api-key-section');
  const modelSection = document.getElementById('model-section');
  const saveBtn = document.getElementById('save-btn');

  info.textContent = PROVIDER_INFO[provider] || '';

  if (provider === 'local') {
    keySection.style.display = 'none';
    modelSection.style.display = 'none';
    saveBtn.style.display = 'none';
  } else {
    keySection.style.display = '';
    modelSection.style.display = '';
    saveBtn.style.display = '';
    document.getElementById('model').placeholder = DEFAULT_MODELS[provider] || 'Default model';
  }
}

async function saveSettings() {
  const provider = document.getElementById('provider').value;
  const apiKey = document.getElementById('api-key').value.trim();
  const model = document.getElementById('model').value.trim();

  try {
    await chrome.runtime.sendMessage({
      type: 'SAVE_LLM_CONFIG',
      config: { provider, apiKey, model },
    });
    const msg = document.getElementById('saved-msg');
    msg.classList.add('show');
    setTimeout(() => msg.classList.remove('show'), 2000);
  } catch (err) {
    alert('Failed to save: ' + err.message);
  }
}

// Event listeners
document.getElementById('open-panel').addEventListener('click', async () => {
  try {
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
    window.close();
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/panel.html') });
    window.close();
  }
});

document.getElementById('provider').addEventListener('change', (e) => {
  updateProviderUI(e.target.value);
  // Auto-save when switching to local (no key needed)
  if (e.target.value === 'local') {
    chrome.runtime.sendMessage({
      type: 'SAVE_LLM_CONFIG',
      config: { provider: 'local', apiKey: '', model: '' },
    }).catch(() => {});
  }
});

document.getElementById('save-btn').addEventListener('click', saveSettings);

loadStats();
loadSettings();
