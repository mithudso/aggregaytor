/**
 * logger.ts — Configurable log levels for the aggregator.
 *
 * Levels: debug < info < warn < error < off
 * Set via chrome.storage.local or programmatically.
 */

 
declare const chrome: any;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, off: 4,
};

let currentLevel: LogLevel = 'info';
const LOG_SETTINGS_KEY = 'aggregaytor_log_level';

/**
 * Narrow an untrusted value to a `LogLevel`.
 *
 * `shouldLog` compares against `LEVEL_ORDER[currentLevel]`; if a bogus value
 * ever reached `currentLevel` that lookup would be `undefined` and every
 * comparison would be `false`, silently disabling all logging with no way to
 * tell why. Values arriving from `chrome.storage` are not type-checked by the
 * compiler, so validate at the boundary.
 */
function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_ORDER, value);
}

/**
 * Set the active log level in memory (does not persist).
 *
 * A bogus value is ignored so `currentLevel` can never become an out-of-range
 * string that would silently disable all logging (see `isLogLevel`).
 *
 * @param level - The desired level; ignored unless it is a valid `LogLevel`.
 */
export function setLogLevel(level: LogLevel): void {
  if (!isLogLevel(level)) return;
  currentLevel = level;
}

/**
 * Read the current in-memory log level.
 * @returns The active `LogLevel`.
 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Hydrate `currentLevel` from `chrome.storage.local`, if a valid value was
 * previously saved. Called once at startup so a user's chosen level survives
 * page/worker reloads.
 *
 * Storage access is guarded and its failure is swallowed deliberately: this
 * module *is* the logger, so it cannot log its own failure without recursion,
 * and a missing/failed read simply leaves the default level in place. Never
 * throws.
 *
 * @returns A promise that resolves once the (best-effort) load completes.
 */
export async function loadLogLevel(): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      const data = await chrome.storage.local.get(LOG_SETTINGS_KEY);
      const stored = data?.[LOG_SETTINGS_KEY];
      if (isLogLevel(stored)) currentLevel = stored;
    }
  } catch {
    // Deliberately silent: cannot self-log, and a failed read just keeps the
    // current default level.
  }
}

/**
 * Persist a log level to `chrome.storage.local` and apply it immediately.
 *
 * Invalid values are rejected before any write. The storage write is guarded
 * and its failure is swallowed deliberately (this module is the logger and
 * cannot log its own failure); the in-memory level is still updated so the
 * choice takes effect for the current session even if persistence fails.
 *
 * @param level - The level to persist and apply; ignored if invalid.
 * @returns A promise that resolves once the (best-effort) write completes.
 */
export async function saveLogLevel(level: LogLevel): Promise<void> {
  if (!isLogLevel(level)) return;
  currentLevel = level;
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      await chrome.storage.local.set({ [LOG_SETTINGS_KEY]: level });
    }
  } catch {
    // Deliberately silent: cannot self-log; the level still applies in memory.
  }
}

/**
 * Whether a message at `level` should be emitted given `currentLevel`.
 *
 * Higher-or-equal severity passes; `off` (the highest) suppresses everything.
 * @param level - The severity of the message being considered.
 * @returns `true` if the message should be written to the console.
 */
function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

/**
 * Create a prefixed console logger whose methods respect the current log level.
 *
 * This is the package's single logging entry point — modules call
 * `createLogger('[Aggregaytor:Foo]')` and use the returned `debug/info/warn/error`
 * methods instead of `console.*` directly, so verbosity is centrally
 * controllable via `setLogLevel`/`saveLogLevel`.
 *
 * @param prefix - Tag prepended to every message (identifies the source module).
 * @returns An object with `debug`, `info`, `warn`, and `error` methods, each of
 *          which is a no-op when the current level suppresses that severity.
 */
export function createLogger(prefix: string) {
  return {
    debug: (...args: unknown[]) => { if (shouldLog('debug')) console.debug(prefix, ...args); },
    info: (...args: unknown[]) => { if (shouldLog('info')) console.log(prefix, ...args); },
    warn: (...args: unknown[]) => { if (shouldLog('warn')) console.warn(prefix, ...args); },
    error: (...args: unknown[]) => { if (shouldLog('error')) console.error(prefix, ...args); },
  };
}
