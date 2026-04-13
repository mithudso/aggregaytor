/**
 * text-expander.ts — Text substitution/expansion engine.
 *
 * Monitors input fields for shortcut text and replaces with the full phrase.
 * Works like macOS Text Substitutions but inside platform chat inputs.
 *
 * Triggers on space or Enter after typing a shortcut. For example, typing
 * "hg " expands to "Hey there. How's it going? ".
 *
 * Substitutions are stored in chrome.storage.local (relayed via bridge)
 * and editable in Settings → Data.
 */

interface Substitution {
  shortcut: string;
  phrase: string;
}

let substitutions: Substitution[] = [];
let expanderEnabled = true;

// ── Default substitutions (imported from macOS Text Substitutions.plist) ──

const DEFAULT_SUBSTITUTIONS: Substitution[] = [
  { shortcut: '@park', phrase: 'Garage entrance is on E. Bland. --- When entering the garage go to the left to park in the visitor/restaurant spots.  Go to the callbox in the garage next to the double glass doors. Press 475.   Elevator to 2nd floor. Exit the elevator room INTO the building (not the garage) and turn immediately right and another right, follow the wall of the garage past the next garage door to unit 275.    Call box 475 Apt 275' },
  { shortcut: '@park2', phrase: 'Elevator to floor 2 Exit the elevator, INTO the building (not the garage) and turn immediately right and right, follow the wall of the garage past 2 garage doors to unit 275.' },
  { shortcut: '222', phrase: '222 E. Bland St.' },
  { shortcut: 'asl', phrase: '41sgwm Charlotte South End. Neg on prep and doxy. BB vers bttm, can travel or host. 6\' 190lb 7"cut' },
  { shortcut: 'bb1', phrase: 'Clean, oral, BB vers bttm neg on prep and doxy recently tested, love to get bred.' },
  { shortcut: 'bb2', phrase: 'Bb oral vers bttm neg on prep and doxy. Recently tested. Love a quick breed. Or Makeout, cuddle, mutual, oral, massage, outdoor, pits, etc depending on vibes.' },
  { shortcut: 'bb3', phrase: 'BB oral vers bttm neg on prep and doxy recently tested, I basically cum if a dude nuts in me. Body contact, makeout, cuddle, mutual, oral, pits, massage, etc depending on vibes.' },
  { shortcut: 'bb4', phrase: 'Clean oral BB vers bttm neg on prep and doxy recently tested, love to get bred - I basically cum if a dude nuts in me. Body contact, makeout, cuddle, mutual, oral, pits, massage, etc depending on vibes.' },
  { shortcut: 'bb5', phrase: 'Cum dump, getting bred, pits, restraints, blindfolds, gangbang.' },
  { shortcut: 'bb6', phrase: 'Oral, BBttm neg on prep and doxy recently tested, looking to get bred balls deep.' },
  { shortcut: 'bbb', phrase: 'Clean neg on prep and doxy bb bttm I can travel or host in South End 6\' 200lb 40yo masc musc wm. Kik and Snap: mithudso' },
  { shortcut: 'dd', phrase: 'Doing alright.' },
  { shortcut: 'ddt', phrase: "Doing alright. What're you up to? You looking?" },
  { shortcut: 'gm', phrase: 'Good morning' },
  { shortcut: 'hg', phrase: "Hey there. How's it going?" },
  { shortcut: 'hh', phrase: 'Howdy' },
  { shortcut: 'hig', phrase: "How's it going?" },
  { shortcut: 'ho', phrase: 'Host or travel?' },
  { shortcut: 'ht', phrase: "Hey there. How's it going?" },
  { shortcut: 'htw', phrase: "Hey there. How's it going? What're you up to? You looking?" },
  { shortcut: 'hyd', phrase: "How're you doing?" },
  { shortcut: 'hyl', phrase: "Hey there, how's it going? You happen to be looking? bb bttm here" },
  { shortcut: 'ily', phrase: 'I love you.' },
  { shortcut: 'ntmy', phrase: 'Nice to meet you.' },
  { shortcut: 'omw', phrase: 'On my way!' },
  { shortcut: 'sg', phrase: 'Sounds great.' },
  { shortcut: 'simt', phrase: 'Sorry I missed this.' },
  { shortcut: 'ty', phrase: 'Thank you' },
  { shortcut: 'tyvm', phrase: 'Thank you very much.' },
  { shortcut: 'wbu', phrase: 'What about you?' },
  { shortcut: 'wdyd', phrase: 'What do you do?' },
  { shortcut: 'wfh', phrase: 'Working from home.' },
  { shortcut: 'whm', phrase: 'Woof! Hot man' },
  { shortcut: 'wlt', phrase: "What're you looking to do?" },
  { shortcut: 'wn', phrase: 'When were you thinking?' },
  { shortcut: 'wt', phrase: "What're you up to?" },
  { shortcut: 'wth', phrase: 'What the hell?!' },
  { shortcut: 'wtn', phrase: "What're you up to tonight?" },
  { shortcut: 'wtt', phrase: "What're you up to today?" },
  { shortcut: 'wy', phrase: 'Where are you?' },
  { shortcut: 'wyd', phrase: "What're you doing?" },
  { shortcut: 'wyf', phrase: 'When are you free?' },
  { shortcut: 'wyi', phrase: "What're you into?" },
  { shortcut: 'wylf', phrase: "What're you looking for?" },
  { shortcut: 'wylfn', phrase: 'Were you looking for now?' },
  { shortcut: 'wylft', phrase: "What're you looking for tonight?" },
  { shortcut: 'wyltd', phrase: "What're you looking to do?" },
  { shortcut: 'yl', phrase: 'You looking?' },
  { shortcut: 'ylb', phrase: 'You looking to breed?' },
  { shortcut: 'ylbn', phrase: 'You looking to breed now?' },
  { shortcut: 'ylfl', phrase: 'You looking for later?' },
  { shortcut: 'ylfn', phrase: 'You looking for now?' },
  { shortcut: 'yln', phrase: 'You looking at all tonight?' },
  { shortcut: 'ylt', phrase: 'You looking today?' },
  { shortcut: 'zz', phrase: "Hey there, how's it going?" },
  { shortcut: 'war', phrase: 'When are you free to come breed me?' },
  { shortcut: 'ho', phrase: 'Host or travel?' },
  { shortcut: 'mm', phrase: 'Mitch 5125455965' },
];

// ── Expansion Logic ────────────────────────────────────────────────────────

// Build a fast lookup map from shortcut → phrase
let shortcutMap = new Map<string, string>();

function rebuildMap(): void {
  shortcutMap.clear();
  for (const s of substitutions) {
    if (s.shortcut && s.phrase) shortcutMap.set(s.shortcut.toLowerCase(), s.phrase);
  }
}

/**
 * Check if the text before the cursor ends with a shortcut, and if so,
 * replace it with the expanded phrase.
 */
function tryExpand(input: HTMLTextAreaElement | HTMLInputElement): boolean {
  if (!expanderEnabled || !shortcutMap.size) return false;

  const val = input.value;
  const cursorPos = input.selectionStart ?? val.length;
  // Get the text before the cursor
  const before = val.slice(0, cursorPos);

  // Find the last word (text after last space or start of string)
  const lastSpaceIdx = before.lastIndexOf(' ', cursorPos - 2);
  const lastNewlineIdx = before.lastIndexOf('\n', cursorPos - 2);
  const wordStart = Math.max(lastSpaceIdx, lastNewlineIdx) + 1;
  // The "word" is everything from wordStart to just before the trigger char
  const word = before.slice(wordStart, cursorPos - 1).trim(); // -1 to exclude the space/enter

  if (!word) return false;
  const phrase = shortcutMap.get(word.toLowerCase());
  if (!phrase) return false;

  // Replace the shortcut with the phrase
  const newVal = val.slice(0, wordStart) + phrase + ' ' + val.slice(cursorPos);
  // Use native setter to work with React/Angular
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSet) nativeSet.call(input, newVal);
  else input.value = newVal;
  // Move cursor to end of inserted phrase
  const newPos = wordStart + phrase.length + 1;
  input.setSelectionRange(newPos, newPos);
  // Dispatch events so React/Angular picks up the change
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * Also handle contenteditable elements (some platforms use these instead of textarea).
 */
function tryExpandContentEditable(el: HTMLElement): boolean {
  if (!expanderEnabled || !shortcutMap.size) return false;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return false;

  const text = textNode.textContent || '';
  const offset = range.startOffset;
  const before = text.slice(0, offset);

  const lastSpace = before.lastIndexOf(' ', offset - 2);
  const wordStart = lastSpace + 1;
  const word = before.slice(wordStart, offset - 1).trim();

  if (!word) return false;
  const phrase = shortcutMap.get(word.toLowerCase());
  if (!phrase) return false;

  // Replace in the text node
  textNode.textContent = text.slice(0, wordStart) + phrase + ' ' + text.slice(offset);
  // Move cursor
  const newOffset = wordStart + phrase.length + 1;
  range.setStart(textNode, Math.min(newOffset, textNode.textContent.length));
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  // Trigger input event
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// ── Event Listener ─────────────────────────────────────────────────────────

function handleInput(e: Event): void {
  const target = e.target as HTMLElement;
  if (!target) return;

  // Check if the last character typed was a space or Enter (trigger)
  if (e instanceof InputEvent) {
    if (e.data !== ' ' && e.inputType !== 'insertLineBreak') return;
  }

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    tryExpand(target);
  } else if (target.isContentEditable) {
    tryExpandContentEditable(target);
  }
}

// ── Settings Update ────────────────────────────────────────────────────────

window.addEventListener('__aggregaytor_text_expander_settings', ((event: CustomEvent) => {
  const update = event.detail;
  if (Array.isArray(update?.substitutions)) {
    substitutions = update.substitutions;
    rebuildMap();
  }
  if (update?.enabled !== undefined) {
    expanderEnabled = !!update.enabled;
  }
}) as EventListener);

// ── Initialization ─────────────────────────────────────────────────────────

export function initTextExpander(): void {
  // Load from localStorage (synced from chrome.storage via bridge)
  try {
    const raw = localStorage.getItem('aggregaytor_text_substitutions');
    if (raw) {
      substitutions = JSON.parse(raw);
    } else {
      substitutions = DEFAULT_SUBSTITUTIONS;
      localStorage.setItem('aggregaytor_text_substitutions', JSON.stringify(substitutions));
    }
  } catch {
    substitutions = DEFAULT_SUBSTITUTIONS;
  }
  rebuildMap();

  // Listen for input events on the entire document (captures all inputs)
  document.addEventListener('input', handleInput, true);

  console.log(`[Aggregaytor:TextExpander] Initialized with ${substitutions.length} substitutions`);
}
