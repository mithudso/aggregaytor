/**
 * error-logger.ts — Rolling error capture for the entire extension.
 *
 * v0.57.44: every error from every context (service worker, content
 * scripts, side panel) lands in a single rolling buffer in
 * chrome.storage.local. The user exports the buffer to a JSON file
 * from Settings, opens it locally, and we have a self-service trail
 * for diagnosing whatever went wrong without asking them to copy
 * console output.
 *
 * Why chrome.storage.local rather than IndexedDB:
 *   - simpler, atomic key-level reads/writes
 *   - 5 MB quota is plenty for 500 capped entries
 *   - persists across SW restarts AND across extension reloads
 *   - easy to inspect via chrome://extensions devtools if needed
 *
 * Why a downloaded JSON file rather than chrome.storage UI:
 *   - the file is a real artifact the user can keep / paste / email
 *   - the storage inspector in DevTools is awkward and incomplete
 *   - we control the schema and naming so the user always knows
 *     what they're looking at
 */

const STORAGE_KEY = 'aggregaytor_error_log_v1';
const MAX_ENTRIES = 500;

export interface ErrorLogEntry {
  ts: string;          // ISO timestamp
  source: string;      // 'sw' | 'panel' | 'bridge:sniffies' | 'bridge:grindr' | ...
  level: 'error' | 'warn' | 'unhandled' | 'rejection';
  message: string;
  stack?: string;
  url?: string;        // page URL when fired (content scripts)
  context?: Record<string, unknown>;
}

// In-memory mirror so the SW doesn't have to await chrome.storage.local
// on every error during a flurry. Flushed via a 1s debounce so a burst
// of 100 errors writes once instead of 100 times.
let buffer: ErrorLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let rehydrated = false;

/**
 * Load the persisted log into the in-memory buffer on first use so entries
 * survive SW restarts and extension reloads. Runs at most once per context
 * (guarded on `rehydrated`).
 * @returns nothing; a storage read failure is deliberately swallowed — this is
 *          the error logger itself, so it must never throw or it would drop the
 *          very errors it exists to capture.
 */
async function rehydrate(): Promise<void> {
  if (rehydrated) return;
  rehydrated = true;
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const stored = got?.[STORAGE_KEY];
    if (Array.isArray(stored)) buffer = stored.slice(-MAX_ENTRIES);
  } catch {}
}

/**
 * Schedule a single debounced flush of the in-memory buffer to storage,
 * coalescing a burst of errors into one write (~1s). No-op if a flush is
 * already pending.
 * @returns nothing; the write failure inside the timer is deliberately
 *          swallowed (the logger must not throw from a background flush).
 */
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try { await chrome.storage.local.set({ [STORAGE_KEY]: buffer }); } catch {}
  }, 1000);
}

// Entries arrive from untrusted contexts (content scripts forward errors via
// the LOG_ERROR message), so every free-form field is bounded before it lands
// in chrome.storage.local. `context` is the only object-shaped field, so it
// gets a serialized-size budget rather than a string slice: without one, a
// single caller could park megabytes per entry × MAX_ENTRIES in storage.
const MAX_CONTEXT_BYTES = 4000;
/**
 * Bound an untrusted `context` value to a serialized-size budget before it's
 * stored, so a single caller can't park megabytes per entry × MAX_ENTRIES.
 * Non-objects are stringified and sliced; unserializable (cyclic) values are
 * flagged; oversized objects are replaced with a truncated preview.
 * @param context caller-supplied context (from untrusted contexts via LOG_ERROR).
 * @returns a bounded object safe to persist, or `undefined` when `context` is null.
 */
function boundContext(context: unknown): Record<string, unknown> | undefined {
  if (context == null) return undefined;
  if (typeof context !== 'object' || Array.isArray(context)) {
    return { value: String(context).slice(0, MAX_CONTEXT_BYTES) };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(context) || '';
  } catch {
    // Cyclic or otherwise unserializable — it would fail the storage write too.
    return { _unserializable: true };
  }
  if (serialized.length <= MAX_CONTEXT_BYTES) return context as Record<string, unknown>;
  return { _truncated: true, preview: serialized.slice(0, MAX_CONTEXT_BYTES) };
}

/**
 * Append one error entry to the rolling buffer and schedule a flush. Every
 * free-form field is bounded (the entry may originate from an untrusted content
 * script via LOG_ERROR) and the buffer is FIFO-capped at MAX_ENTRIES.
 * @param entry the error to record; `ts` defaults to now if omitted.
 * @returns nothing; does not throw for malformed input (fields are coerced).
 */
export async function logError(entry: Omit<ErrorLogEntry, 'ts'> & { ts?: string }): Promise<void> {
  await rehydrate();
  const full: ErrorLogEntry = {
    ts: entry.ts || new Date().toISOString(),
    source: String(entry.source || 'unknown').slice(0, 100),
    level: entry.level,
    message: String(entry.message || '').slice(0, 2000), // cap length defensively
    stack: entry.stack ? String(entry.stack).slice(0, 4000) : undefined,
    url: entry.url ? String(entry.url).slice(0, 1000) : undefined,
    context: boundContext(entry.context),
  };
  buffer.push(full);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  scheduleFlush();
}

/** Return a shallow copy of the current log. */
export async function getErrorLog(): Promise<ErrorLogEntry[]> {
  await rehydrate();
  return buffer.slice();
}

/** Clear everything. */
export async function clearErrorLog(): Promise<void> {
  buffer = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try { await chrome.storage.local.remove(STORAGE_KEY); } catch {}
}

/**
 * Trigger a JSON download of the current log via chrome.downloads.
 * Filename includes timestamp so multiple exports don't collide.
 * Returns the download id (or null if downloads API unavailable).
 */
export async function exportErrorLog(): Promise<{ id: number | null; count: number; filename: string }> {
  await rehydrate();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `aggregaytor-errors-${stamp}.json`;
  const payload = {
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    entryCount: buffer.length,
    entries: buffer,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  // Service-worker-safe: we have to use a data: URL because the SW context
  // doesn't have URL.createObjectURL stable across MV3 lifecycle.
  // Reading the blob to a base64 data URL avoids the worker's missing URL
  // object-URL support.
  const dataUrl = await blobToDataUrl(blob);
  if (!dataUrl) {
    console.warn('[Aggregaytor:ErrorLog] export failed: could not read log blob as a data URL');
    return { id: null, count: buffer.length, filename };
  }
  try {
    const id = await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
    });
    return { id, count: buffer.length, filename };
  } catch (err) {
    // console.warn (not console.error) on purpose: console.error is patched by
    // installGlobalErrorCapture and would re-enter this module.
    console.warn('[Aggregaytor:ErrorLog] export download failed:', (err as Error)?.message || err);
    return { id: null, count: buffer.length, filename };
  }
}

/**
 * Read a Blob into a base64 `data:` URL. Needed because the MV3 service worker
 * lacks stable `URL.createObjectURL`, so downloads must use a data URL.
 * @param blob the blob to encode.
 * @returns the data URL, or `null` on any read error (never rejects) so the
 *          caller can degrade gracefully instead of throwing from the logger.
 */
function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    try { reader.readAsDataURL(blob); } catch { resolve(null); }
  });
}

/**
 * Install global error capture for a long-lived JS context (SW, panel,
 * bridge, MAIN world). Hooks both error events and unhandled promise
 * rejections, and patches console.error so existing call sites
 * automatically participate. Idempotent — calling twice is a no-op.
 */
let _globalsInstalled = false;
/**
 * Install global `error` / `unhandledrejection` capture plus a `console.error`
 * patch that forwards to the persisted error log, tagged with `source`.
 * Idempotent per context; must never throw (it is the error path itself).
 * @param source short label for the capturing context (e.g. 'service-worker')
 * @returns nothing
 */
export function installGlobalErrorCapture(source: string): void {
  if (_globalsInstalled) return;
  _globalsInstalled = true;
  const target: any = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis);

  try {
    target.addEventListener?.('error', (ev: ErrorEvent) => {
      try {
        logError({
          source, level: 'unhandled',
          message: ev.message || String(ev.error || 'unknown error'),
          stack: (ev.error && (ev.error as Error).stack) || undefined,
          url: ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : undefined,
        });
      } catch {}
    });
  } catch {}

  try {
    target.addEventListener?.('unhandledrejection', (ev: PromiseRejectionEvent) => {
      try {
        const reason: any = ev.reason;
        const msg = typeof reason === 'string' ? reason : (reason?.message || JSON.stringify(reason).slice(0, 500));
        // Drop CORS-class rejections — same pattern as the console.error
        // filter. The fetch call site already handles them via static
        // fallback list, so they're not actionable in the log.
        if (/(blocked by cors|preflight|access-control-allow-origin|^(?:typeerror: )?failed to fetch$)/i.test(msg)) return;
        logError({ source, level: 'rejection', message: msg, stack: reason?.stack });
      } catch {}
    });
  } catch {}

  // Patch console.error so existing console.error('...', err) call sites
  // also flow into the log. We DON'T patch console.warn — too noisy.
  //
  // v0.57.57: filter known browser-emitted noise that we already handle
  // gracefully in code. CORS preflight failures are the canonical case —
  // the browser logs them synchronously before our fetch try/catch can
  // see the rejection, so they appeared in the rolling log every daily
  // model-updater check despite us already falling back to the static
  // model list. Anything matching these patterns is a known "we know,
  // it's fine" signal and gets dropped from the captured log (still
  // shows in the live console for debugging).
  const NOISE_PATTERNS: RegExp[] = [
    /access to fetch at .* has been blocked by cors policy/i,
    /preflight (?:request|response)/i,
    /no 'access-control-allow-origin'/i,
    /response to preflight request doesn't pass access control check/i,
    // Failed to fetch with no other context — almost always CORS or
    // network; the call site that cares already logs a meaningful error.
    /^(?:typeerror: )?failed to fetch$/i,
  ];
  const origError = console.error.bind(console);
  console.error = function (...args: unknown[]) {
    try {
      const [first, ...rest] = args;
      const message = typeof first === 'string' ? first : String(first);
      const err = rest.find((a) => a instanceof Error) as Error | undefined;
      const fullMsg = [message, ...rest.filter(a => a !== err).map(a =>
        typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
      )].join(' ');
      const isNoise = NOISE_PATTERNS.some((re) => re.test(fullMsg));
      if (!isNoise) {
        logError({
          source, level: 'error',
          message: fullMsg.slice(0, 2000),
          stack: err?.stack,
        });
      }
    } catch {}
    origError.apply(console, args as []);
  };
}
