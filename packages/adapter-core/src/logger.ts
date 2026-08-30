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

export function setLogLevel(level: LogLevel): void {
  if (!isLogLevel(level)) return;
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export async function loadLogLevel(): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      const data = await chrome.storage.local.get(LOG_SETTINGS_KEY);
      const stored = data?.[LOG_SETTINGS_KEY];
      if (isLogLevel(stored)) currentLevel = stored;
    }
  } catch {}
}

export async function saveLogLevel(level: LogLevel): Promise<void> {
  if (!isLogLevel(level)) return;
  currentLevel = level;
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      await chrome.storage.local.set({ [LOG_SETTINGS_KEY]: level });
    }
  } catch {}
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

export function createLogger(prefix: string) {
  return {
    debug: (...args: unknown[]) => { if (shouldLog('debug')) console.debug(prefix, ...args); },
    info: (...args: unknown[]) => { if (shouldLog('info')) console.log(prefix, ...args); },
    warn: (...args: unknown[]) => { if (shouldLog('warn')) console.warn(prefix, ...args); },
    error: (...args: unknown[]) => { if (shouldLog('error')) console.error(prefix, ...args); },
  };
}
