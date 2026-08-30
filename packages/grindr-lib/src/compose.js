// Composer + send-button resolution. Two composers can be on screen at once (the
// open profile's wide input and the floating chat drawer's narrow textarea); this
// prefers the profile composer so a greeting is not sent into the wrong drawer
// conversation. The Send button is anchored so "send location" (a trap that sits
// left of the input) is never clicked. Message send itself is over the WebSocket;
// success is confirmed by the composer clearing.

const SEND_RE = /^(send|send message|send chat|submit)$/i;
const DRAWER_CTRL = '[aria-label="close drawer"], [aria-label="Open chat list"], [data-testid^="chat-button"]';
const CONFIRM_ATTEMPTS = 8;
const CONFIRM_INTERVAL_MS = 150;

function elName(el) {
  try {
    return String((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || el.innerText || el.textContent || '').trim();
  } catch (_e) { return ''; }
}

/** True when the composer belongs to the floating chat drawer, not the profile. */
export function isDrawerComposer(composer) {
  let scope = composer;
  for (let i = 0; i < 5 && scope; i += 1, scope = scope.parentElement) {
    try { if (scope.querySelector && scope.querySelector(DRAWER_CTRL)) return true; } catch (_e) {}
  }
  return false;
}

/**
 * Find the Send button near a composer via a bounded ancestor scan, restricted to
 * a button on the SAME side of the drawer/profile split as the composer — so a
 * profile greeting can't click the drawer's Send. `disabled` (while the box is
 * empty) is not disqualifying — fill first, then look.
 * @param {Element} composer
 * @returns {Element|null}
 */
export function findSendButton(composer) {
  if (!composer) return null;
  const mine = isDrawerComposer(composer);
  // The composer itself is an <input> whose querySelectorAll is always empty, so
  // walk one extra level to cover the doc's "6 ancestor" scope.
  let scope = composer;
  for (let i = 0; i < 7 && scope; i += 1, scope = scope.parentElement) {
    let btns = [];
    try { btns = scope.querySelectorAll ? [...scope.querySelectorAll('button, [role="button"]')] : []; } catch (_e) {}
    const hit = btns.find((b) => SEND_RE.test(elName(b)) && isDrawerComposer(b) === mine);
    if (hit) return hit;
  }
  return null;
}

/**
 * Find the active composer. Ranks candidates by the `Say something...` placeholder
 * and non-drawer-ness rather than filtering (the selector alone matches every text
 * input, e.g. the inbox search box).
 * @returns {Element|null}
 */
export function findComposer() {
  let inputs = [];
  try { inputs = [...document.querySelectorAll('input[type="text"], textarea')]; } catch (_e) {}
  const score = (c) => {
    let s = 0;
    try { if (/say something/i.test((c.getAttribute && c.getAttribute('placeholder')) || '')) s += 4; } catch (_e) {}
    try { if (!isDrawerComposer(c)) s += 2; } catch (_e) {}
    return s;
  };
  const ranked = inputs.filter((c) => score(c) > 0).sort((a, b) => score(b) - score(a));
  return ranked[0] || null;
}

/**
 * Set the composer value through the NATIVE value setter and fire input+change.
 * Grindr is React: assigning `el.value` directly is tracked by React's value
 * tracker and does NOT trip `onChange`, so the app never sees the text and Send
 * stays disabled. The prototype setter bypasses that tracker.
 */
export function fill(composer, text) {
  if (!composer) return;
  try {
    const proto = (typeof HTMLTextAreaElement !== 'undefined' && composer instanceof HTMLTextAreaElement)
      ? HTMLTextAreaElement.prototype
      : (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(composer, text); else composer.value = text;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (_e) {}
}

/** Click Send (or press Enter). @returns {boolean} whether a send was attempted */
export function submit(composer) {
  const btn = findSendButton(composer);
  if (btn && btn.click) { try { btn.click(); return true; } catch (_e) {} }
  try { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; } catch (_e) {}
  return false;
}

/** The composer emptying is the only proof a WS send landed. */
export function confirmCleared(composer) {
  try { return !composer.value; } catch (_e) { return false; }
}

/**
 * Fill → submit → poll for the composer to clear. The send is over the WebSocket
 * and clears a tick or more later, so a same-tick confirm reports a successful
 * send as a failure — which drives duplicate messages on retry.
 * @param {string} text
 * @param {{composer?:Element}} [opts]
 * @returns {Promise<boolean>}
 */
export async function greet(text, { composer } = {}) {
  const c = composer || findComposer();
  if (!c) return false;
  fill(c, text);
  submit(c);
  for (let i = 0; i < CONFIRM_ATTEMPTS; i += 1) {
    if (confirmCleared(c)) return true;
    await new Promise((r) => setTimeout(r, CONFIRM_INTERVAL_MS));
  }
  return confirmCleared(c);
}
