// Composer resolution + message send. There is NO send-message API on Sniffies — the site sends
// over its WebSocket from app state, so a library must write via the DOM: find the composer,
// fill it, click Send (or synthesize Enter). All selectors here are scoring heuristics — the
// chat pane exposes no stable testids — so every function degrades to null/false, never throws.
import { normalizeProfileId } from './dom.js';

const isVisible = (el) => {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  try {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') < 0.01) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  } catch (_e) { return false; }
};

/**
 * Find the chat composer by scoring visible textareas/inputs/contenteditables. Requires positive
 * evidence (a 0-score candidate is any text input on the page — a search box, a filter field).
 * @param {{skipSelector?: string}} [opts] CSS selector for elements to exclude (e.g. your own UI)
 * @returns {Element|null}
 */
export function findComposer({ skipSelector = '' } = {}) {
  const candidates = Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']"))
    .filter(isVisible)
    .filter((el) => !skipSelector || !el.closest(skipSelector));
  let best = null;
  let bestScore = 0;
  for (const el of candidates) {
    const ph = String((el.getAttribute && el.getAttribute('placeholder')) || '').toLowerCase();
    const aria = String((el.getAttribute && el.getAttribute('aria-label')) || '').toLowerCase();
    let score = 0;
    if (ph.includes('message') || ph.includes('chat')) score += 4;
    if (aria.includes('message') || aria.includes('chat')) score += 4;
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) score += 2;
    try {
      if (el.getBoundingClientRect().bottom > innerHeight * 0.45) score += 1;
    } catch (_e) {}
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

/**
 * Set text into the composer and dispatch the input events Angular listens for.
 * @returns {boolean} whether it filled
 */
export function fill(el, text) {
  if (!el) return false;
  const value = String(text || '');
  try {
    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      } catch (_e) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }
    if ('value' in el) {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  } catch (_e) {}
  return false;
}

/**
 * Click the Send button near a composer. Scoped to the composer's chat/form ancestor — never
 * document-wide, so a stray "send"-labeled button elsewhere can't be clicked.
 * @returns {boolean}
 */
export function clickSend(composerEl, { skipSelector = '' } = {}) {
  const scope = composerEl && composerEl.closest && composerEl.closest("form, [class*='chat'], [class*='message']");
  if (!scope) return false;
  const buttons = Array.from(scope.querySelectorAll("button, [role='button']"))
    .filter(isVisible)
    .filter((btn) => !skipSelector || !btn.closest(skipSelector));
  for (const btn of buttons) {
    const text = String(btn.textContent || '').trim().toLowerCase();
    const aria = String((btn.getAttribute && btn.getAttribute('aria-label')) || '').toLowerCase();
    const title = String((btn.getAttribute && btn.getAttribute('title')) || '').toLowerCase();
    if (text === 'send' || aria.includes('send') || title.includes('send')) {
      btn.click();
      return true;
    }
  }
  return false;
}

/** Fallback submit: synthesize Enter (keydown+keypress+keyup) on the composer. */
export function pressEnter(el) {
  if (!el) return false;
  try {
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    }
    return true;
  } catch (_e) { return false; }
}

/**
 * Send `text` in the currently open chat: find composer → fill → click Send, else Enter.
 * Success is only "the events were dispatched" — confirm delivery by the composer clearing.
 * @returns {{ok:boolean, via:'button'|'enter'|'', profileId:string|null}}
 */
export function sendInCurrentChat(text, { skipSelector = '' } = {}) {
  const composer = findComposer({ skipSelector });
  if (!composer || !fill(composer, text)) return { ok: false, via: '', profileId: null };
  const via = clickSend(composer, { skipSelector }) ? 'button' : (pressEnter(composer) ? 'enter' : '');
  const m = String(location.pathname || '').match(/\/profile\/([0-9a-f]{6,})/i);
  return { ok: !!via, via, profileId: m ? normalizeProfileId(m[1]) : null };
}
