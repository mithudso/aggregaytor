/**
 * floating-actions.ts — Floating quick-action panel injected on platform pages.
 *
 * Provides instant access to common actions (block, notes, ratings, greetings)
 * directly on the Sniffies/Grindr/A4A page when viewing a profile or chat.
 *
 * Runs in ISOLATED world (has chrome.runtime + DOM access).
 * Imported by each platform's bridge script.
 *
 * Features:
 *  - Auto-shows when a profile/chat URL is detected
 *  - Draggable by header, position persisted in localStorage
 *  - Collapsible to a small header bar
 *  - Block/hide profile via API
 *  - Inline notes editor
 *  - 1-5 star rating
 *  - Top 3 quick phrases (click to send)
 */

declare const chrome: any;

const PANEL_ID = 'aggregaytor-floating-actions';
const STYLE_ID = 'aggregaytor-floating-actions-css';
const POS_KEY = 'aggregaytor_floating_panel_pos';
const COLLAPSED_KEY = 'aggregaytor_floating_panel_collapsed';

let currentContactId = '';
let currentPlatform = '';
let panelEl: HTMLElement | null = null;
let isCollapsed = false;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };

// ── CSS ──────────────────────────────────────────────────────────────────────

function injectCSS(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      z-index: 99999;
      width: 260px;
      background: rgba(15, 20, 25, 0.95);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      color: #e7e9ea;
      overflow: hidden;
      transition: width 0.2s, height 0.2s;
    }
    #${PANEL_ID}.collapsed {
      width: 160px;
    }
    #${PANEL_ID}.collapsed .fp-body { display: none; }
    .fp-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px; background: rgba(59, 130, 246, 0.15);
      cursor: move; user-select: none;
      border-bottom: 1px solid rgba(59, 130, 246, 0.2);
    }
    .fp-header-title { font-weight: 600; font-size: 11px; color: #93c5fd; }
    .fp-header-btns { display: flex; gap: 4px; }
    .fp-header-btn {
      background: none; border: none; color: #6b7280; cursor: pointer;
      font-size: 14px; padding: 0 2px; line-height: 1;
    }
    .fp-header-btn:hover { color: #e7e9ea; }
    .fp-body { padding: 8px 10px; }
    .fp-actions {
      display: flex; gap: 6px; align-items: center;
      margin-bottom: 8px; flex-wrap: wrap;
    }
    .fp-action-btn {
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px; padding: 4px 8px; color: #e7e9ea; cursor: pointer;
      font-size: 11px; font-family: inherit; transition: background 0.15s;
    }
    .fp-action-btn:hover { background: rgba(59,130,246,0.2); border-color: rgba(59,130,246,0.4); }
    .fp-action-btn.danger { border-color: rgba(239,68,68,0.3); color: #f87171; }
    .fp-action-btn.danger:hover { background: rgba(239,68,68,0.15); }
    .fp-stars {
      display: flex; gap: 1px; margin-left: auto;
    }
    .fp-star {
      font-size: 14px; cursor: pointer; color: #4b5563;
      user-select: none; transition: color 0.1s;
    }
    .fp-star.active { color: #fbbf24; }
    .fp-star:hover { color: #f59e0b; }
    .fp-phrases {
      display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;
    }
    .fp-phrase-btn {
      background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.25);
      color: #93c5fd; border-radius: 5px; padding: 3px 8px; font-size: 10px;
      cursor: pointer; font-family: inherit; transition: background 0.15s;
      max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fp-phrase-btn:hover { background: rgba(59,130,246,0.2); }
    .fp-notes-area {
      border-top: 1px solid rgba(255,255,255,0.06); padding-top: 6px;
    }
    .fp-notes-label { font-size: 10px; color: #6b7280; margin-bottom: 3px; }
    .fp-notes-input {
      width: 100%; background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 5px;
      padding: 5px 7px; color: #e7e9ea; font-size: 11px;
      font-family: inherit; resize: vertical; min-height: 36px;
    }
    .fp-notes-input:focus { border-color: rgba(59,130,246,0.5); outline: none; }
    .fp-status { font-size: 9px; color: #22c55e; margin-top: 3px; min-height: 12px; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ── Panel Creation ───────────────────────────────────────────────────────────

function createPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;

  // Load saved position or default
  let pos = { x: 20, y: 120 };
  try {
    const saved = localStorage.getItem(POS_KEY);
    if (saved) pos = JSON.parse(saved);
  } catch {}
  panel.style.left = `${pos.x}px`;
  panel.style.top = `${pos.y}px`;

  // Load collapsed state
  try {
    isCollapsed = localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {}
  if (isCollapsed) panel.classList.add('collapsed');

  panel.innerHTML = `
    <div class="fp-header">
      <span class="fp-header-title">⚡ Quick Actions</span>
      <div class="fp-header-btns">
        <button class="fp-header-btn fp-collapse-btn" title="Collapse">${isCollapsed ? '▼' : '▲'}</button>
        <button class="fp-header-btn fp-close-btn" title="Close">×</button>
      </div>
    </div>
    <div class="fp-body">
      <div class="fp-actions">
        <button class="fp-action-btn danger fp-block-btn">🚫 Hide</button>
        <button class="fp-action-btn fp-notes-toggle-btn">📝 Notes</button>
        <div class="fp-stars" id="fp-stars">
          <span class="fp-star" data-star="1">★</span>
          <span class="fp-star" data-star="2">★</span>
          <span class="fp-star" data-star="3">★</span>
          <span class="fp-star" data-star="4">★</span>
          <span class="fp-star" data-star="5">★</span>
        </div>
      </div>
      <div class="fp-phrases" id="fp-phrases"></div>
      <div class="fp-notes-area" id="fp-notes-area" style="display:none">
        <div class="fp-notes-label">Notes</div>
        <textarea class="fp-notes-input" id="fp-notes-input" placeholder="Add notes..."></textarea>
        <div class="fp-status" id="fp-status"></div>
      </div>
    </div>
  `;

  // Event handlers
  setupDrag(panel);
  setupActions(panel);

  return panel;
}

// ── Drag ─────────────────────────────────────────────────────────────────────

function setupDrag(panel: HTMLElement): void {
  const header = panel.querySelector('.fp-header') as HTMLElement;

  header.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.fp-header-btn')) return;
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging) return;
    const x = Math.max(0, Math.min(e.clientX - dragOffset.x, window.innerWidth - 100));
    const y = Math.max(0, Math.min(e.clientY - dragOffset.y, window.innerHeight - 40));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        x: parseInt(panel.style.left),
        y: parseInt(panel.style.top),
      }));
    } catch {}
  });
}

// ── Actions ──────────────────────────────────────────────────────────────────

function setupActions(panel: HTMLElement): void {
  // Collapse
  panel.querySelector('.fp-collapse-btn')?.addEventListener('click', () => {
    isCollapsed = !isCollapsed;
    panel.classList.toggle('collapsed', isCollapsed);
    (panel.querySelector('.fp-collapse-btn') as HTMLElement).textContent = isCollapsed ? '▼' : '▲';
    try { localStorage.setItem(COLLAPSED_KEY, String(isCollapsed)); } catch {}
  });

  // Close
  panel.querySelector('.fp-close-btn')?.addEventListener('click', () => {
    hideFloatingPanel();
  });

  // Block/Hide
  panel.querySelector('.fp-block-btn')?.addEventListener('click', () => {
    if (!currentContactId) return;
    chrome.runtime.sendMessage({
      type: 'PROFILE_BLOCKED',
      contactId: currentContactId,
      platform: currentPlatform,
    }).catch(() => {});
    // Also dispatch to MAIN world for API block call (Grindr/Sniffies)
    const profileId = currentContactId.replace(/^[a-z]+:/, '');
    window.dispatchEvent(new CustomEvent('__aggregaytor_block_profile', {
      detail: { profileId },
    }));
    hideFloatingPanel();
  });

  // Notes toggle
  panel.querySelector('.fp-notes-toggle-btn')?.addEventListener('click', () => {
    const area = panel.querySelector('#fp-notes-area') as HTMLElement;
    area.style.display = area.style.display === 'none' ? '' : 'none';
  });

  // Notes save (debounced)
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  panel.querySelector('#fp-notes-input')?.addEventListener('input', (e) => {
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      const notes = (e.target as HTMLTextAreaElement).value;
      chrome.runtime.sendMessage({
        type: 'UPSERT_THREAD_META',
        contactId: currentContactId,
        platform: currentPlatform,
        updates: { notes },
      }).catch(() => {});
      const status = panel.querySelector('#fp-status') as HTMLElement;
      if (status) { status.textContent = 'Saved'; setTimeout(() => { status.textContent = ''; }, 1500); }
    }, 800);
  });

  // Star rating
  panel.querySelectorAll('.fp-star').forEach(star => {
    star.addEventListener('click', () => {
      const rating = parseInt((star as HTMLElement).dataset.star || '0');
      const currentRating = panel.querySelectorAll('.fp-star.active').length;
      const newRating = rating === currentRating ? 0 : rating;
      panel.querySelectorAll('.fp-star').forEach((s, i) => {
        s.classList.toggle('active', i < newRating);
      });
      chrome.runtime.sendMessage({
        type: 'SET_RATING',
        contactId: currentContactId,
        platform: currentPlatform,
        rating: newRating,
      }).catch(() => {});
    });
  });
}

// ── Populate Panel ───────────────────────────────────────────────────────────

async function populatePanel(panel: HTMLElement, contactId: string, platform: string): Promise<void> {
  // Load thread meta (notes, rating)
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_THREAD_META', contactId });
    const meta = res?.meta || {};

    // Set notes
    const notesInput = panel.querySelector('#fp-notes-input') as HTMLTextAreaElement;
    if (notesInput) notesInput.value = meta.notes || '';

    // Set rating stars
    const rating = meta.rating || 0;
    panel.querySelectorAll('.fp-star').forEach((s, i) => {
      s.classList.toggle('active', i < rating);
    });

    // Show notes area if notes exist
    if (meta.notes) {
      const area = panel.querySelector('#fp-notes-area') as HTMLElement;
      if (area) area.style.display = '';
    }
  } catch {}

  // Load quick phrases (top 3)
  try {
    const data = await chrome.storage.local.get('aggregaytor_quick_phrases');
    const phrases = (data.aggregaytor_quick_phrases || ['Hey there!', "What's up?", 'Looking?']).slice(0, 3);
    const container = panel.querySelector('#fp-phrases') as HTMLElement;
    if (container) {
      container.innerHTML = phrases.map((p: string) =>
        `<button class="fp-phrase-btn" title="${p}">${p.length > 20 ? p.slice(0, 18) + '...' : p}</button>`
      ).join('');
      container.querySelectorAll('.fp-phrase-btn').forEach((btn, i) => {
        btn.addEventListener('click', () => {
          // Send phrase to MAIN world for auto-send
          window.dispatchEvent(new CustomEvent('__aggregaytor_send_message', {
            detail: { text: phrases[i], contactId },
          }));
          // Brief visual feedback
          (btn as HTMLElement).style.background = 'rgba(34,197,94,0.2)';
          setTimeout(() => { (btn as HTMLElement).style.background = ''; }, 500);
        });
      });
    }
  } catch {}
}

// ── Public API ───────────────────────────────────────────────────────────────

export function showFloatingPanel(contactId: string, platform: string): void {
  if (!contactId) return;

  // Don't re-show for same contact
  if (panelEl && currentContactId === contactId) return;

  currentContactId = contactId;
  currentPlatform = platform;

  injectCSS();

  // Remove existing panel
  const existing = document.getElementById(PANEL_ID);
  if (existing) existing.remove();

  panelEl = createPanel();
  document.body.appendChild(panelEl);
  populatePanel(panelEl, contactId, platform);
}

export function hideFloatingPanel(): void {
  const el = document.getElementById(PANEL_ID);
  if (el) el.remove();
  panelEl = null;
  currentContactId = '';
}
