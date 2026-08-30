/**
 * popup.js — Settings: AI provider, picture library, block rules.
 */

const PROVIDER_INFO = {
  local: 'Pattern-based suggestions, no API key needed.',
  anthropic: 'Claude Haiku (50 RPM, $5 tier). console.anthropic.com',
  gemini: 'Gemini 2.5 Flash Lite (15 RPM free). aistudio.google.com',
  openai: 'GPT-4o-mini (500 RPM, $5 tier). platform.openai.com',
  groq: 'Llama 3.1 8B (30 RPM free, ultra-fast). console.groq.com',
  // Cerebras: largest free daily quota (1M tokens/day) at ~2600 tok/s on
  // wafer-scale chips. Added v0.57.9 to llm.ts; popup option added v0.57.15.
  cerebras: 'Llama 4 Scout (30 RPM, 1M tokens/day free). cloud.cerebras.ai',
  perplexity: 'Sonar (50 RPM, pay-as-you-go). perplexity.ai/settings/api',
  mistral: 'Mistral Small (2 RPM free). console.mistral.ai',
  copilot: 'Via Copilot proxy (unofficial). Needs Copilot sub.',
};

/**
 * chrome.runtime.sendMessage wrapper that never throws.
 *
 * Several handlers below `await chrome.runtime.sendMessage(...)` with no
 * try/catch and then unconditionally report success. If the service worker is
 * suspended, mid-restart, or the handler throws, the await rejects: the click
 * handler dies as an unhandled rejection, no "Saved!" ever appears, and the
 * user gets no explanation. Returns a uniform { ok, error? } instead.
 */
async function popupSend(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res === undefined) return { ok: false, error: 'no response from background' };
    return res;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/**
 * HTML-escape a value before interpolating it into innerHTML.
 *
 * Safe in BOTH text and quoted-attribute contexts (quotes are escaped), which
 * matters because most call sites here are attributes — `src="${...}"`,
 * `alt="${...}"`, `data-delete-pic="${...}"`. Picture labels, picture data
 * URLs and block-rule names are all user- or import-controlled (IMPORT_ALL_DATA
 * ingests an arbitrary JSON file), and were previously interpolated raw.
 *
 * Mirrors panel.js's esc(), including the `|| ''` coercion.
 */
function esc(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Personality settings ────────────────────────────────────────────────────

// NOTE ON LOGGING: this popup is loaded as a plain `<script>` (see
// popup.html), not an ES module, so it cannot import the package's
// `createLogger`. `console.*` is the only logging channel available here.
// Load-time failures below are logged with `console.warn` and, where the user
// needs to know, also surfaced in the UI.

/**
 * Fetch the saved personality settings from the service worker and populate the
 * preset dropdown, description, custom-instructions field, and style-guide
 * display. Runs once on popup open.
 *
 * Failures are non-fatal: on error the section is simply left in its default
 * (empty) state rather than blocking the rest of the popup.
 *
 * @returns {Promise<void>}
 */
async function loadPersonality() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PERSONALITY' });
    if (!res?.ok) return;
    const { personality, presets } = res;

    // Populate preset dropdown
    const select = document.getElementById('personality-preset');
    select.innerHTML = presets.map(p =>
      `<option value="${esc(p.id)}"${p.id === personality.preset ? ' selected' : ''}>${esc(p.label)}</option>`
    ).join('');

    // Show description
    const active = presets.find(p => p.id === personality.preset);
    document.getElementById('preset-description').textContent = active?.description || '';

    // Custom instructions
    document.getElementById('custom-instructions').value = personality.customInstructions || '';

    // Style guide
    document.getElementById('style-guide-display').textContent = personality.styleGuide || 'Not yet derived. Click "Analyze" to scan your sent messages.';
  } catch (err) {
    console.warn('[Aggregaytor:popup] loadPersonality failed:', err);
  }
}

document.getElementById('personality-preset')?.addEventListener('change', (e) => {
  // Update description dynamically — fetch presets again
  chrome.runtime.sendMessage({ type: 'GET_PERSONALITY' }).then(res => {
    if (res?.ok) {
      const active = res.presets.find(p => p.id === e.target.value);
      document.getElementById('preset-description').textContent = active?.description || '';
    }
  }).catch(() => {});
});

document.getElementById('save-personality')?.addEventListener('click', async () => {
  const res = await popupSend({
    type: 'SAVE_PERSONALITY',
    settings: {
      preset: document.getElementById('personality-preset').value,
      customInstructions: document.getElementById('custom-instructions').value.trim(),
    },
  });
  const desc = document.getElementById('preset-description');
  if (res?.ok === false) {
    // Don't claim "Saved!" when nothing was saved.
    if (desc) desc.textContent = `Save failed: ${res.error || 'unknown error'}`;
    return;
  }
  const msg = document.getElementById('personality-saved');
  msg.classList.add('show'); setTimeout(() => msg.classList.remove('show'), 2000);
});

document.getElementById('derive-style')?.addEventListener('click', async () => {
  const btn = document.getElementById('derive-style');
  btn.textContent = 'Analyzing...';
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DERIVE_STYLE_GUIDE' });
    if (res?.ok) {
      document.getElementById('style-guide-display').textContent = res.styleGuide;
    } else {
      document.getElementById('style-guide-display').textContent = 'Failed to derive style.';
    }
  } catch {
    document.getElementById('style-guide-display').textContent = 'Error analyzing messages.';
  }
  btn.textContent = 'Analyze my writing style';
  btn.disabled = false;
});

// ── Sync profile pics ───────────────────────────────────────────────────────

document.getElementById('sync-pics')?.addEventListener('click', async () => {
  const status = document.getElementById('sync-status');
  const btn = document.getElementById('sync-pics');
  btn.disabled = true;
  btn.textContent = 'Syncing...';
  status.textContent = 'Sending scrape request to all platform tabs...';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNC_PROFILE_PICS' });
    if (res?.ok) {
      status.textContent = `Done! Scraped ${res.count || 0} avatars from ${res.tabs || 0} tab(s).`;
      status.style.color = '#34d399';
    } else {
      status.textContent = res?.error || 'No platform tabs open. Open Sniffies or Grindr first.';
      status.style.color = '#f87171';
    }
  } catch (err) {
    status.textContent = 'Failed: ' + (err.message || err);
    status.style.color = '#f87171';
  }
  btn.disabled = false;
  btn.textContent = 'Sync Profile Pictures';
});

// Section toggle handlers (no inline onclick — CSP disallows it in MV3)
document.querySelectorAll('[data-toggle]').forEach(el => {
  el.addEventListener('click', () => {
    const target = document.getElementById(el.dataset.toggle);
    if (target) target.classList.toggle('open');
  });
});

// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * Fetch the unread-message count from the service worker and render it into the
 * stats box. On failure (e.g. the worker is still spinning up) shows a
 * "Connecting..." placeholder instead of an error.
 *
 * @returns {Promise<void>}
 */
async function loadStats() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_COUNT' });
    document.getElementById('stats').innerHTML = `<div class="stat"><span class="stat-label">Unread</span><span class="stat-value">${res?.count || 0}</span></div>`;
  } catch (err) {
    console.warn('[Aggregaytor:popup] loadStats failed:', err);
    document.getElementById('stats').innerHTML = `<div class="stat"><span class="stat-label">Status</span><span class="stat-value">Connecting...</span></div>`;
  }
}

// ── LLM settings ────────────────────────────────────────────────────────────

/**
 * Fetch the saved LLM provider config from the service worker and populate the
 * provider dropdown, API-key field, and model field, then sync the dependent UI
 * via `updateProviderUI`. Runs once on popup open.
 *
 * @returns {Promise<void>}
 */
async function loadLLMSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LLM_CONFIG' });
    if (res?.ok) {
      document.getElementById('provider').value = res.config.provider || 'local';
      document.getElementById('api-key').value = res.config.apiKey || '';
      document.getElementById('model').value = res.config.model || '';
      updateProviderUI(res.config.provider || 'local');
    }
  } catch (err) {
    console.warn('[Aggregaytor:popup] loadLLMSettings failed:', err);
  }
}

// Log level: persist the chosen level to the background (via popupSend, which
// never throws) on change, and initialise the dropdown from stored state.
document.getElementById('log-level').addEventListener('change', async (e) => {
  await popupSend({ type: 'SET_LOG_LEVEL', level: e.target.value });
});
chrome.storage.local.get('aggregaytor_log_level').then(data => {
  if (data.aggregaytor_log_level) document.getElementById('log-level').value = data.aggregaytor_log_level;
}).catch(err => {
  console.warn('[Aggregaytor:popup] could not read stored log level:', err);
});

/**
 * Sync the provider-dependent parts of the LLM settings UI: show the provider's
 * description, and reveal or hide the API-key / model / save controls (hidden
 * for the `local` provider, which needs no key).
 *
 * @param {string} provider - The selected provider id (a key of `PROVIDER_INFO`).
 * @returns {void}
 */
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
  const res = await popupSend({
    type: 'SAVE_LLM_CONFIG',
    config: {
      provider: document.getElementById('provider').value,
      apiKey: document.getElementById('api-key').value.trim(),
      model: document.getElementById('model').value.trim(),
    },
  });
  if (res?.ok === false) {
    document.getElementById('provider-info').textContent = `Save failed: ${res.error || 'unknown error'}`;
    return;
  }
  const msg = document.getElementById('llm-saved');
  msg.classList.add('show'); setTimeout(() => msg.classList.remove('show'), 2000);
});

// ── Rate settings ───────────────────────────────────────────────────────────

/**
 * Populate the LLM rate-limit / feature-toggle controls and the live queue
 * status line from the service worker. Also called after saving rate settings
 * to reflect the persisted values back into the form.
 *
 * The settings load and the queue-status load are independent try/catch blocks
 * so a failure of one does not blank out the other.
 *
 * @returns {Promise<void>}
 */
async function loadRateSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LLM_RATE_SETTINGS' });
    if (res?.ok) {
      const s = res.settings;
      document.getElementById('llm-enabled').checked = s.enabled !== false;
      document.getElementById('llm-rpm').value = s.maxRequestsPerMinute || 10;
      document.getElementById('llm-feat-ar').checked = s.enableAutoRespond !== false;
      document.getElementById('llm-feat-suggest').checked = s.enableSuggestions !== false;
      document.getElementById('llm-feat-dossier').checked = s.enableDossierExtract !== false;
      document.getElementById('llm-feat-nick').checked = s.enableNicknames !== false;
      document.getElementById('llm-feat-summary').checked = s.enableSummaries !== false;
    }
  } catch (err) {
    console.warn('[Aggregaytor:popup] loadRateSettings (settings) failed:', err);
  }
  // Show queue status
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LLM_QUEUE_STATUS' });
    if (res?.ok) {
      const s = res.status;
      document.getElementById('llm-queue-status').textContent =
        `Queue: ${s.queueLength} | Last min: ${s.requestsLastMinute} req` +
        (s.backoffUntil > 0 ? ` | Backoff: ${Math.round(s.backoffUntil / 1000)}s` : '');
    }
  } catch (err) {
    console.warn('[Aggregaytor:popup] loadRateSettings (queue status) failed:', err);
  }
}

document.getElementById('save-rate').addEventListener('click', async () => {
  await popupSend({
    type: 'SAVE_LLM_RATE_SETTINGS',
    settings: {
      enabled: document.getElementById('llm-enabled').checked,
      maxRequestsPerMinute: parseInt(document.getElementById('llm-rpm').value) || 10,
      enableAutoRespond: document.getElementById('llm-feat-ar').checked,
      enableSuggestions: document.getElementById('llm-feat-suggest').checked,
      enableDossierExtract: document.getElementById('llm-feat-dossier').checked,
      enableNicknames: document.getElementById('llm-feat-nick').checked,
      enableSummaries: document.getElementById('llm-feat-summary').checked,
    },
  });
  loadRateSettings();
});

// ── Calendar ────────────────────────────────────────────────────────────────

document.getElementById('cal-connect').addEventListener('click', async () => {
  const status = document.getElementById('cal-status');
  status.textContent = 'Connecting...';
  // Was a bare await: an SW-side throw here rejected out of the handler, so the
  // status stayed stuck on "Connecting..." forever with no error shown.
  const res = await popupSend({ type: 'AUTHENTICATE_CALENDAR' });
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
  const status = document.getElementById('cal-status');
  const res = await popupSend({
    type: 'SAVE_CALENDAR_SETTINGS',
    settings: {
      enabled: true,
      prepTimeMinutes: parseInt(document.getElementById('cal-prep').value, 10) || 30,
      travelTimeMinutes: parseInt(document.getElementById('cal-travel').value, 10) || 15,
    },
  });
  if (res?.ok === false) {
    status.textContent = `Save failed: ${res.error || 'unknown error'}`;
    status.style.color = '#f87171';
    return;
  }
  status.textContent = 'Settings saved!';
  status.style.color = '#34d399';
});

/**
 * Fetch saved Google Calendar settings from the service worker; if calendar
 * integration is connected/enabled, reveal the settings fields and populate the
 * prep-time / travel-time values and the connected-status line. Runs once on
 * popup open.
 *
 * @returns {Promise<void>}
 */
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
  } catch (err) {
    console.warn('[Aggregaytor:popup] loadCalendarSettings failed:', err);
  }
}

// ── Picture library ─────────────────────────────────────────────────────────

/**
 * Fetch the saved picture library from the service worker and render it as a
 * grid of thumbnails with per-picture send/response/like stats and a delete
 * button. Delete buttons are wired to `DELETE_PICTURE` + a re-render.
 *
 * All interpolated picture fields (labels, tags, data URLs, ids) are run
 * through `esc()` because they can originate from imported JSON.
 *
 * @returns {Promise<void>}
 */
async function loadPictures() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ALL_PICTURES' });
    const grid = document.getElementById('pic-grid');
    if (!res?.ok || !res.pictures?.length) { grid.innerHTML = '<div class="info">No pictures yet.</div>'; return; }
    grid.innerHTML = res.pictures.map(p => `
      <div class="pic-item">
        ${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="${esc(p.label || p.tag)}">` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6b7280">${esc(p.tag)}</div>`}
        <span class="pic-tag">${esc(p.tag)}</span>
        <span class="pic-stats">${Number(p.sentCount) || 0}s ${Number(p.responseCount) || 0}r ${Number(p.likeCount) || 0}l</span>
        <button class="pic-del" data-delete-pic="${esc(p._id)}">&times;</button>
      </div>
    `).join('');
    // Attach delete handlers
    grid.querySelectorAll('[data-delete-pic]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await popupSend({ type: 'DELETE_PICTURE', id: btn.dataset.deletePic });
        loadPictures();
      });
    });
  } catch (err) {
    console.warn('[Aggregaytor:popup] loadPictures failed:', err);
  }
}

// Picture upload: read the user-selected file (untrusted input), decode it as
// an image, downscale it to a 200x200 center-cropped JPEG thumbnail on a
// canvas, and send both the full data URL and the thumbnail to the service
// worker. Every failure branch (unreadable file, undecodable/hostile image,
// missing 2D context) is handled so a bad file surfaces an error instead of
// leaving the upload silently hung.
document.getElementById('pic-upload').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const tag = document.getElementById('pic-tag').value;
  const label = document.getElementById('pic-label').value.trim() || file.name;

  /** Reset the picker on failure so the user can retry the same file. */
  const failUpload = (reason, err) => {
    console.warn(`[Aggregaytor:popup] picture upload failed: ${reason}`, err || '');
    e.target.value = '';
  };

  const reader = new FileReader();
  reader.onerror = () => failUpload('could not read file', reader.error);
  reader.onload = async () => {
    const dataUrl = reader.result;
    // Create thumbnail (resize to 200px)
    const img = new Image();
    // A non-image or corrupt file never fires `onload`; without this the whole
    // upload would hang with no feedback.
    img.onerror = () => failUpload('file is not a decodable image');
    img.onload = async () => {
      try {
        const canvas = document.createElement('canvas');
        const size = 200;
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        // getContext can return null (e.g. context lost / blocked); bail rather
        // than throw on `ctx.drawImage`.
        if (!ctx) { failUpload('2D canvas context unavailable'); return; }
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const thumbnail = canvas.toDataURL('image/jpeg', 0.7);

        const res = await popupSend({
          type: 'ADD_PICTURE',
          input: { tag, label, dataUrl, thumbnail },
        });
        if (res?.ok === false) { failUpload(`background rejected picture: ${res.error || 'unknown error'}`); return; }
        document.getElementById('pic-label').value = '';
        e.target.value = '';
        loadPictures();
      } catch (err) {
        failUpload('thumbnail generation threw', err);
      }
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

/**
 * Fetch the saved auto-block rules from the service worker and render them as a
 * list with per-rule execution counts and enable/disable + delete controls.
 * Those controls are wired to `UPDATE_BLOCK_RULE` / `DELETE_BLOCK_RULE` plus a
 * re-render. Rule names are `esc()`-escaped (user/import-controlled).
 *
 * @returns {Promise<void>}
 */
async function loadRules() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ALL_BLOCK_RULES' });
    const list = document.getElementById('rule-list');
    if (!res?.ok || !res.rules?.length) { list.innerHTML = '<div class="info">No rules yet.</div>'; return; }
    list.innerHTML = res.rules.map(r => `
      <div class="rule-item">
        <span class="rule-name">${esc(r.name)} ${r.enabled ? '' : '(off)'}</span>
        <span class="rule-count">${Number(r.executedCount) || 0}x</span>
        <div class="rule-actions">
          <button class="btn btn-sm" data-toggle-rule="${esc(r._id)}" data-enabled="${!r.enabled}">${r.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm btn-danger" data-delete-rule="${esc(r._id)}">Del</button>
        </div>
      </div>
    `).join('');
    // Attach handlers
    list.querySelectorAll('[data-toggle-rule]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await popupSend({ type: 'UPDATE_BLOCK_RULE', id: btn.dataset.toggleRule, updates: { enabled: btn.dataset.enabled === 'true' } });
        loadRules();
      });
    });
    list.querySelectorAll('[data-delete-rule]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await popupSend({ type: 'DELETE_BLOCK_RULE', id: btn.dataset.deleteRule });
        loadRules();
      });
    });
  } catch (err) {
    console.warn('[Aggregaytor:popup] loadRules failed:', err);
  }
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

  const res = await popupSend({
    type: 'CREATE_BLOCK_RULE',
    input: { name: names[type] || type, condition, action },
  });
  const list = document.getElementById('rule-list');
  if (res?.ok === false && list) {
    // Previously a failed create just silently re-rendered the unchanged list.
    list.innerHTML = `<div class="info">Failed to add rule: ${esc(res.error || 'unknown error')}</div>`;
    return;
  }
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
loadPersonality();
loadLLMSettings();
loadRateSettings();
loadCalendarSettings();
loadPictures();
loadRules();
