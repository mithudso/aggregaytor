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
let _dragCleanup: (() => void) | null = null;

/**
 * chrome.runtime.sendMessage can THROW SYNCHRONOUSLY once the extension is
 * reloaded/updated mid-session ("Extension context invalidated"). That throw
 * bypasses any .catch() chained onto the returned promise and lands as an
 * uncaught error from a click handler. This panel outlives extension reloads
 * (it sits in the page until the user refreshes), so every send goes through
 * here. Mirrors safeSendMessage in the per-platform bridges.
 */
function safeSend(message: unknown): Promise<any> {
  try {
    const p = chrome.runtime.sendMessage(message);
    return p && typeof p.then === 'function' ? p : Promise.resolve(p);
  } catch (err) {
    return Promise.reject(err);
  }
}

// ── CSS ──────────────────────────────────────────────────────────────────────

/**
 * Inject the panel's stylesheet into <head> once per page.
 * Idempotent — bails if a <style> with STYLE_ID already exists, so repeated
 * showFloatingPanel calls don't stack duplicate stylesheets.
 */
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
      background: none; border: none; padding: 0 1px;
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
      width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 5px;
      padding: 5px 7px; color: #e7e9ea; font-size: 11px;
      font-family: inherit; resize: vertical; min-height: 36px;
    }
    .fp-notes-input:focus { border-color: rgba(59,130,246,0.5); outline: none; }
    .fp-status { font-size: 9px; color: #22c55e; margin-top: 3px; min-height: 12px; }
    #${PANEL_ID} button:focus-visible, #${PANEL_ID} textarea:focus-visible {
      outline: 2px solid #60a5fa;
      outline-offset: 1px;
    }
    #${PANEL_ID} .fp-star:focus-visible {
      outline: 2px solid #f59e0b;
      outline-offset: 1px;
      border-radius: 2px;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ── Panel Creation ───────────────────────────────────────────────────────────

/**
 * Build the floating-actions panel element (header, action buttons, star
 * rating, quick-phrase row, notes editor) and wire its drag + action handlers.
 *
 * Restores the saved on-screen position and collapsed state from (page-origin,
 * untrusted) localStorage, validating the parsed position and clamping it back
 * into the viewport so a panel saved off-screen still appears. Parse failures
 * fall back to the default position.
 * @returns the fully-wired panel element, not yet attached to the DOM.
 */
function createPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;

  let pos = { x: 20, y: 120 };
  try {
    const saved = localStorage.getItem(POS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number' &&
          isFinite(parsed.x) && isFinite(parsed.y)) {
        pos.x = Math.max(0, Math.min(parsed.x, window.innerWidth - 100));
        pos.y = Math.max(0, Math.min(parsed.y, window.innerHeight - 40));
      }
    }
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
          <button class="fp-star" data-star="1" aria-label="1 star">★</button>
          <button class="fp-star" data-star="2" aria-label="2 stars">★</button>
          <button class="fp-star" data-star="3" aria-label="3 stars">★</button>
          <button class="fp-star" data-star="4" aria-label="4 stars">★</button>
          <button class="fp-star" data-star="5" aria-label="5 stars">★</button>
        </div>
      </div>
      <div class="fp-phrases" id="fp-phrases"></div>
      <div class="fp-notes-area" id="fp-notes-area" style="display:none">
        <div class="fp-notes-label">Notes</div>
        <textarea class="fp-notes-input" id="fp-notes-input" placeholder="Add notes..." maxlength="10000"></textarea>
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

/**
 * Make the panel draggable by its header. Persists the final position to
 * localStorage on drag end and records a cleanup fn in `_dragCleanup` so the
 * document-level mousemove/mouseup listeners can be detached when the panel is
 * replaced or hidden (otherwise they'd leak across profile switches).
 * @param panel the panel root element whose `.fp-header` initiates the drag.
 */
function setupDrag(panel: HTMLElement): void {
  const header = panel.querySelector('.fp-header') as HTMLElement;

  header.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.fp-header-btn')) return;
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.preventDefault();
  });

  const onDragMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const x = Math.max(0, Math.min(e.clientX - dragOffset.x, window.innerWidth - 100));
    const y = Math.max(0, Math.min(e.clientY - dragOffset.y, window.innerHeight - 40));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  };
  const onDragEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        x: parseInt(panel.style.left),
        y: parseInt(panel.style.top),
      }));
    } catch {}
  };
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  _dragCleanup = () => {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * Wire every interactive control in the panel: collapse/close, block/hide,
 * notes toggle, debounced notes save, and star rating. Each action that mutates
 * stored state relays it to the service worker via safeSend and/or dispatches a
 * MAIN-world CustomEvent for the page adapter to act on. The notes save
 * snapshots contactId/platform at INPUT time (not flush time) so a profile
 * switch inside the debounce window can't save one profile's note onto another.
 * @param panel the panel root element to attach handlers to.
 */
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
    safeSend({
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

  // Notes save (debounced).
  // contactId/platform are snapshotted at INPUT time. They live in module
  // scope and showFloatingPanel rewrites them on every profile change, so
  // reading them at flush time meant a profile switch inside the 800ms window
  // saved profile A's note onto profile B's thread_meta.
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  panel.querySelector('#fp-notes-input')?.addEventListener('input', (e) => {
    if (noteTimer) clearTimeout(noteTimer);
    const forContactId = currentContactId;
    const forPlatform = currentPlatform;
    const notes = (e.target as HTMLTextAreaElement).value;
    noteTimer = setTimeout(() => {
      if (!forContactId) return;
      safeSend({
        type: 'UPSERT_THREAD_META',
        contactId: forContactId,
        platform: forPlatform,
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
      safeSend({
        type: 'SET_RATING',
        contactId: currentContactId,
        platform: currentPlatform,
        rating: newRating,
      }).catch(() => {});
    });
  });
}

// ── Populate Panel ───────────────────────────────────────────────────────────

/**
 * Load and render this contact's persisted state into the panel — notes, rating
 * stars, and the top-3 quick phrases. Both loads are best-effort and isolated:
 * a failed thread-meta fetch or a malformed quick-phrases blob leaves the
 * corresponding section empty rather than aborting the panel. Quick phrases are
 * coerced to strings and HTML-escaped before injection (untrusted user data).
 *
 * The two catch branches are intentionally silent: safeSend rejects with
 * "Extension context invalidated" on every send after a mid-session extension
 * reload, so logging here would spam the console on every reload.
 * @param panel the attached panel element to populate.
 * @param contactId platform-scoped contact id (e.g. "sniffies:abc123").
 * @param platform originating platform key, forwarded with phrase sends.
 */
async function populatePanel(panel: HTMLElement, contactId: string, platform: string): Promise<void> {
  // Load thread meta (notes, rating)
  try {
    const res = await safeSend({ type: 'GET_THREAD_META', contactId });
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
    // Stored phrases are user data of unknown shape (older builds, hand edits,
    // a partially-written sync). Coerce to strings before any .replace/.length
    // so one bad row can't throw the whole panel's phrase section away.
    const raw = data.aggregaytor_quick_phrases;
    const phrases: string[] = (Array.isArray(raw) && raw.length ? raw : ['Hey there!', "What's up?", 'Looking?'])
      .filter((p: unknown) => typeof p === 'string' && p !== '')
      .slice(0, 3);
    const container = panel.querySelector('#fp-phrases') as HTMLElement;
    if (container) {
      // One escaper: escaping the quote as well is harmless in text position
      // and required in attribute position, so both sinks can share it.
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      container.innerHTML = phrases.map((p: string) =>
        `<button class="fp-phrase-btn" title="${esc(p)}">${esc(p.length > 20 ? p.slice(0, 18) + '...' : p)}</button>`
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

/**
 * Show (or re-target) the floating quick-action panel for a contact.
 * No-ops when already showing the same contact. Tears down any previous panel
 * and its drag listeners first, then builds, attaches, and populates a fresh
 * one. Snapshots contactId/platform into module scope for the action handlers.
 * @param contactId platform-scoped contact id; a falsy value is ignored.
 * @param platform originating platform key.
 */
export function showFloatingPanel(contactId: string, platform: string): void {
  if (!contactId) return;

  // Don't re-show for same contact
  if (panelEl && currentContactId === contactId) return;

  currentContactId = contactId;
  currentPlatform = platform;

  injectCSS();

  // Remove existing panel and clean up drag listeners
  if (_dragCleanup) { _dragCleanup(); _dragCleanup = null; }
  const existing = document.getElementById(PANEL_ID);
  if (existing) existing.remove();

  panelEl = createPanel();
  document.body.appendChild(panelEl);
  populatePanel(panelEl, contactId, platform);
}

/**
 * Remove the panel from the DOM and reset module state (current contact, drag
 * listeners). Safe to call when no panel is present.
 */
export function hideFloatingPanel(): void {
  const el = document.getElementById(PANEL_ID);
  if (el) el.remove();
  panelEl = null;
  currentContactId = '';
  if (_dragCleanup) { _dragCleanup(); _dragCleanup = null; }
}
