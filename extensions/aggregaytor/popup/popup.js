/**
 * popup.js — Settings: AI provider, picture library, block rules.
 */

const PROVIDER_INFO = {
  local: 'Pattern-based suggestions, no API key needed.',
  anthropic: 'Claude Haiku. Get key at console.anthropic.com',
  gemini: 'Gemini Flash (free tier). Get key at aistudio.google.com',
  openai: 'GPT-4o-mini. Get key at platform.openai.com',
};

// Section toggle handlers (no inline onclick — CSP disallows it in MV3)
document.querySelectorAll('[data-toggle]').forEach(el => {
  el.addEventListener('click', () => {
    const target = document.getElementById(el.dataset.toggle);
    if (target) target.classList.toggle('open');
  });
});

// ── Stats ───────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_COUNT' });
    document.getElementById('stats').innerHTML = `<div class="stat"><span class="stat-label">Unread</span><span class="stat-value">${res?.count || 0}</span></div>`;
  } catch {
    document.getElementById('stats').innerHTML = `<div class="stat"><span class="stat-label">Status</span><span class="stat-value">Connecting...</span></div>`;
  }
}

// ── LLM settings ────────────────────────────────────────────────────────────

async function loadLLMSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
    if (res?.ok) {
      document.getElementById('provider').value = res.config.provider || 'local';
      document.getElementById('api-key').value = res.config.apiKey || '';
      document.getElementById('model').value = res.config.model || '';
      updateProviderUI(res.config.provider || 'local');
    }
  } catch {}
}

function updateProviderUI(provider) {
  document.getElementById('provider-info').textContent = PROVIDER_INFO[provider] || '';
  const show = provider !== 'local';
  document.getElementById('api-key-section').style.display = show ? '' : 'none';
  document.getElementById('model-section').style.display = show ? '' : 'none';
  document.getElementById('save-llm').style.display = show ? '' : 'none';
}

document.getElementById('provider').addEventListener('change', (e) => {
  updateProviderUI(e.target.value);
  if (e.target.value === 'local') {
    chrome.runtime.sendMessage({ type: 'SAVE_LLM_CONFIG', config: { provider: 'local', apiKey: '', model: '' } }).catch(() => {});
  }
});

document.getElementById('save-llm').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_LLM_CONFIG',
    config: {
      provider: document.getElementById('provider').value,
      apiKey: document.getElementById('api-key').value.trim(),
      model: document.getElementById('model').value.trim(),
    },
  });
  const msg = document.getElementById('llm-saved');
  msg.classList.add('show'); setTimeout(() => msg.classList.remove('show'), 2000);
});

// ── Calendar ────────────────────────────────────────────────────────────────

document.getElementById('cal-connect').addEventListener('click', async () => {
  const status = document.getElementById('cal-status');
  status.textContent = 'Connecting...';
  const res = await chrome.runtime.sendMessage({ type: 'AUTHENTICATE_CALENDAR' });
  if (res?.ok && res.success) {
    status.textContent = 'Connected!';
    status.style.color = '#34d399';
    document.getElementById('cal-settings-fields').style.display = '';
    loadCalendarSettings();
  } else {
    status.textContent = 'Failed to connect. Make sure you approve the Google sign-in.';
    status.style.color = '#f87171';
  }
});

document.getElementById('cal-save').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_CALENDAR_SETTINGS',
    settings: {
      enabled: true,
      prepTimeMinutes: parseInt(document.getElementById('cal-prep').value) || 30,
      travelTimeMinutes: parseInt(document.getElementById('cal-travel').value) || 15,
    },
  });
  document.getElementById('cal-status').textContent = 'Settings saved!';
  document.getElementById('cal-status').style.color = '#34d399';
});

async function loadCalendarSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_CALENDAR_SETTINGS' });
    if (res?.ok && res.settings?.enabled) {
      document.getElementById('cal-settings-fields').style.display = '';
      document.getElementById('cal-prep').value = res.settings.prepTimeMinutes || 30;
      document.getElementById('cal-travel').value = res.settings.travelTimeMinutes || 15;
      document.getElementById('cal-status').textContent = 'Calendar connected';
      document.getElementById('cal-status').style.color = '#34d399';
    }
  } catch {}
}

// ── Picture library ─────────────────────────────────────────────────────────

async function loadPictures() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ALL_PICTURES' });
    const grid = document.getElementById('pic-grid');
    if (!res?.ok || !res.pictures?.length) { grid.innerHTML = '<div class="info">No pictures yet.</div>'; return; }
    grid.innerHTML = res.pictures.map(p => `
      <div class="pic-item">
        ${p.thumbnail ? `<img src="${p.thumbnail}" alt="${p.label || p.tag}">` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6b7280">${p.tag}</div>`}
        <span class="pic-tag">${p.tag}</span>
        <span class="pic-stats">${p.sentCount}s ${p.responseCount}r ${p.likeCount}l</span>
        <button class="pic-del" data-delete-pic="${p._id}">&times;</button>
      </div>
    `).join('');
    // Attach delete handlers
    grid.querySelectorAll('[data-delete-pic]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'DELETE_PICTURE', id: btn.dataset.deletePic });
        loadPictures();
      });
    });
  } catch {}
}

document.getElementById('pic-upload').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const tag = document.getElementById('pic-tag').value;
  const label = document.getElementById('pic-label').value.trim() || file.name;

  const reader = new FileReader();
  reader.onload = async () => {
    const dataUrl = reader.result;
    // Create thumbnail (resize to 200px)
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      const size = 200;
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      const thumbnail = canvas.toDataURL('image/jpeg', 0.7);

      await chrome.runtime.sendMessage({
        type: 'ADD_PICTURE',
        input: { tag, label, dataUrl, thumbnail },
      });
      document.getElementById('pic-label').value = '';
      e.target.value = '';
      loadPictures();
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
});

// deletePic is now handled via data attributes above

// ── Block rules ─────────────────────────────────────────────────────────────

document.getElementById('rule-type').addEventListener('change', (e) => {
  document.getElementById('rule-keywords').style.display = e.target.value === 'keyword' ? '' : 'none';
  document.getElementById('rule-threshold').style.display = e.target.value === 'keyword' ? 'none' : '';
});

async function loadRules() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ALL_BLOCK_RULES' });
    const list = document.getElementById('rule-list');
    if (!res?.ok || !res.rules?.length) { list.innerHTML = '<div class="info">No rules yet.</div>'; return; }
    list.innerHTML = res.rules.map(r => `
      <div class="rule-item">
        <span class="rule-name">${r.name} ${r.enabled ? '' : '(off)'}</span>
        <span class="rule-count">${r.executedCount}x</span>
        <div class="rule-actions">
          <button class="btn btn-sm" data-toggle-rule="${r._id}" data-enabled="${!r.enabled}">${r.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm btn-danger" data-delete-rule="${r._id}">Del</button>
        </div>
      </div>
    `).join('');
    // Attach handlers
    list.querySelectorAll('[data-toggle-rule]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'UPDATE_BLOCK_RULE', id: btn.dataset.toggleRule, updates: { enabled: btn.dataset.enabled === 'true' } });
        loadRules();
      });
    });
    list.querySelectorAll('[data-delete-rule]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: 'DELETE_BLOCK_RULE', id: btn.dataset.deleteRule });
        loadRules();
      });
    });
  } catch {}
}

document.getElementById('add-rule').addEventListener('click', async () => {
  const type = document.getElementById('rule-type').value;
  const threshold = parseInt(document.getElementById('rule-threshold').value) || 3;
  const keywords = document.getElementById('rule-keywords').value.split(',').map(k => k.trim()).filter(Boolean);
  const action = document.getElementById('rule-action').value;

  const condition = { type };
  if (type === 'keyword') condition.keywords = keywords;
  else if (type === 'no_response_days') condition.days = threshold;
  else condition.threshold = threshold;

  const names = {
    ignored_count: `Ignored ${threshold}x`,
    no_response_days: `No reply ${threshold}d`,
    deleted_chat: `Deleted ${threshold}x`,
    keyword: `Keyword: ${keywords.slice(0, 2).join(', ')}`,
  };

  await chrome.runtime.sendMessage({
    type: 'CREATE_BLOCK_RULE',
    input: { name: names[type] || type, condition, action },
  });
  loadRules();
});

// toggleRule and deleteRule are now handled via data attributes above

// ── Open panel ──────────────────────────────────────────────────────────────

document.getElementById('open-panel').addEventListener('click', async () => {
  try {
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
    window.close();
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/panel.html') });
    window.close();
  }
});

// ── Init ────────────────────────────────────────────────────────────────────

loadStats();
loadLLMSettings();
loadCalendarSettings();
loadPictures();
loadRules();
