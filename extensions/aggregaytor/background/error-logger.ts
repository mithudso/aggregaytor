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

async function rehydrate(): Promise<void> {
  if (rehydrated) return;
  rehydrated = true;
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const stored = got?.[STORAGE_KEY];
    if (Array.isArray(stored)) buffer = stored.slice(-MAX_ENTRIES);
  } catch {}
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try { await chrome.storage.local.set({ [STORAGE_KEY]: buffer }); } catch {}
  }, 1000);
}

/** Append an error entry. Caps at MAX_ENTRIES with FIFO eviction. */
export async function logError(entry: Omit<ErrorLogEntry, 'ts'> & { ts?: string }): Promise<void> {
  await rehydrate();
  const full: ErrorLogEntry = {
    ts: entry.ts || new Date().toISOString(),
    source: entry.source,
    level: entry.level,
    message: String(entry.message || '').slice(0, 2000), // cap length defensively
    stack: entry.stack ? String(entry.stack).slice(0, 4000) : undefined,
    url: entry.url,
    context: entry.context,
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
  if (!dataUrl) return { id: null, count: buffer.length, filename };
  try {
    const id = await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
    });
    return { id, count: buffer.length, filename };
  } catch (err) {
    return { id: null, count: buffer.length, filename };
  }
}

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
        logError({
          source, level: 'rejection',
          message: typeof reason === 'string' ? reason : (reason?.message || JSON.stringify(reason).slice(0, 500)),
          stack: reason?.stack,
        });
      } catch {}
    });
  } catch {}

  // Patch console.error so existing console.error('...', err) call sites
  // also flow into the log. We DON'T patch console.warn — too noisy.
  const origError = console.error.bind(console);
  console.error = function (...args: unknown[]) {
    try {
      const [first, ...rest] = args;
      const message = typeof first === 'string' ? first : String(first);
      const err = rest.find((a) => a instanceof Error) as Error | undefined;
      logError({
        source, level: 'error',
        message: [message, ...rest.filter(a => a !== err).map(a =>
          typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
        )].join(' ').slice(0, 2000),
        stack: err?.stack,
      });
    } catch {}
    origError.apply(console, args as []);
  };
}
