/**
 * logger.ts — Configurable log levels for the aggregator.
 *
 * Levels: debug < info < warn < error < off
 * Set via chrome.storage.local or programmatically.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, off: 4,
};

let currentLevel: LogLevel = 'info';
const LOG_SETTINGS_KEY = 'aggregaytor_log_level';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export async function loadLogLevel(): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      const data = await chrome.storage.local.get(LOG_SETTINGS_KEY);
      if (data[LOG_SETTINGS_KEY]) currentLevel = data[LOG_SETTINGS_KEY] as LogLevel;
    }
  } catch {}
}

export async function saveLogLevel(level: LogLevel): Promise<void> {
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
