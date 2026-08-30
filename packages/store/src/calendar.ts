/**
 * calendar.ts — Google Calendar integration: OAuth, availability, event creation.
 */

 
declare const chrome: any;

import type { Platform } from '@aggregaytor/adapter-core';
import type { CalendarEventDoc, TimeSlot } from './types.js';
import { getDB } from './db.js';

const CAL_SETTINGS_KEY = 'aggregaytor_calendar_settings';
const CAL_TOKEN_KEY = 'aggregaytor_calendar_token';

// Storage abstraction — chrome.storage.local is injected at runtime
let _storage: { get(k: string): Promise<any>; set(k: string, v: any): Promise<void> } | null = null;

/**
 * Inject a storage backend (used by tests to replace chrome.storage.local).
 * When unset, the helpers fall back to chrome.storage.local at runtime.
 */
export function setCalendarStorage(storage: { get(k: string): Promise<any>; set(k: string, v: any): Promise<void> }): void {
  _storage = storage;
}

/**
 * Read a value from the injected storage, else chrome.storage.local.
 * Returns null when neither is available (e.g. a non-extension context).
 */
async function storageGet(key: string): Promise<any> {
  if (_storage) return _storage.get(key);
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    const data = await chrome.storage.local.get(key);
    return data[key];
  }
  return null;
}

/**
 * Write a value to the injected storage, else chrome.storage.local. Silently
 * no-ops when neither backend is available.
 */
async function storageSet(key: string, value: any): Promise<void> {
  if (_storage) { await _storage.set(key, value); return; }
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    await chrome.storage.local.set({ [key]: value });
  }
}

export interface CalendarSettings {
  enabled: boolean;
  prepTimeMinutes: number;     // buffer before events (default 30)
  travelTimeMinutes: number;   // travel buffer (default 15)
  calendarId: string;          // default 'primary'
  bookingUrl: string;          // Google Calendar booking page URL
}

export interface CalendarToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const DEFAULT_CAL_SETTINGS: CalendarSettings = {
  enabled: false,
  prepTimeMinutes: 30,
  travelTimeMinutes: 15,
  calendarId: 'primary',
  bookingUrl: '',
};

/** Load calendar settings, back-filled with DEFAULT_CAL_SETTINGS for any missing keys. */
export async function getCalendarSettings(): Promise<CalendarSettings> {
  const data = await storageGet(CAL_SETTINGS_KEY);
  return { ...DEFAULT_CAL_SETTINGS, ...(data || {}) };
}

/** Merge a partial settings patch over the stored settings and persist it. */
export async function saveCalendarSettings(settings: Partial<CalendarSettings>): Promise<void> {
  const existing = await getCalendarSettings();
  await storageSet(CAL_SETTINGS_KEY, { ...existing, ...settings });
}

/** Load the stored OAuth token, or null if none is saved. */
export async function getCalendarToken(): Promise<CalendarToken | null> {
  return await storageGet(CAL_TOKEN_KEY) || null;
}

/** Persist the OAuth token. Never logged (see isTokenUsable / clearRejectedToken). */
export async function saveCalendarToken(token: CalendarToken): Promise<void> {
  await storageSet(CAL_TOKEN_KEY, token);
}

/**
 * A stored token is usable only while it has an access token and hasn't
 * expired. There is no refresh token (chrome.identity owns refresh), so an
 * expired token can only ever produce 401s — checking here avoids the
 * pointless request and lets the caller degrade the same way it would on a
 * missing token.
 */
function isTokenUsable(token: CalendarToken | null): token is CalendarToken {
  return !!token?.accessToken && (!token.expiresAt || token.expiresAt > Date.now());
}

/**
 * Forget a token the API just rejected, so the settings UI stops reporting
 * "connected" and the user is prompted to re-authenticate.
 */
async function clearRejectedToken(): Promise<void> {
  try {
    await storageSet(CAL_TOKEN_KEY, null);
  } catch (err) {
    console.warn('[Calendar] Could not clear rejected token:', err);
  }
}

/**
 * Get free/busy slots from Google Calendar.
 */
export async function getAvailableSlots(
  from: string,
  to: string,
): Promise<TimeSlot[]> {
  const settings = await getCalendarSettings();
  const token = await getCalendarToken();
  if (!settings.enabled || !isTokenUsable(token)) return [];

  try {
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token.accessToken}`,
      },
      body: JSON.stringify({
        timeMin: from,
        timeMax: to,
        items: [{ id: settings.calendarId || 'primary' }],
      }),
    });

    if (res.status === 401) await clearRejectedToken();
    if (!res.ok) throw new Error(`Calendar API ${res.status}`);
    const data = await res.json();
    const busy = data?.calendars?.[settings.calendarId || 'primary']?.busy || [];

    // Invert busy periods to get free slots
    return invertBusyToFree(from, to, busy, settings);
  } catch (err) {
    console.error('[Calendar] FreeBusy error:', err);
    return [];
  }
}

/** A free gap shorter than this isn't worth offering as a meetup slot. */
const MIN_SLOT_MS = 30 * 60_000;

/**
 * Turn Google's busy periods into free meetup slots within [from, to].
 *
 * Each busy block is pushed earlier by the prep+travel buffer so a slot never
 * runs right up against an existing event, and gaps shorter than MIN_SLOT_MS
 * are dropped as too small to offer.
 *
 * @param from      ISO 8601 window start.
 * @param to        ISO 8601 window end.
 * @param busy      Google free/busy periods.
 * @param settings  Provides prep/travel buffers.
 * @returns Free TimeSlots, each at least MIN_SLOT_MS long.
 */
function invertBusyToFree(
  from: string, to: string,
  busy: Array<{ start: string; end: string }>,
  settings: CalendarSettings,
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const bufferMs = (settings.prepTimeMinutes + settings.travelTimeMinutes) * 60_000;
  let cursor = new Date(from).getTime();
  const end = new Date(to).getTime();

  const pushSlot = (startMs: number, endMs: number): void => {
    if (endMs - startMs < MIN_SLOT_MS) return;
    slots.push({
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      label: formatSlotLabel(startMs, endMs),
    });
  };

  // Sort busy periods
  const sorted = [...busy].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  for (const period of sorted) {
    const busyStart = new Date(period.start).getTime() - bufferMs; // need buffer before
    if (cursor < busyStart) pushSlot(cursor, busyStart);
    cursor = Math.max(cursor, new Date(period.end).getTime());
  }

  // Final slot after last busy period — held to the same minimum as the gaps
  // above, which it previously bypassed.
  if (cursor < end) pushSlot(cursor, end);

  return slots;
}

/** Render a slot as a human-readable "7:00 PM - 9:00 PM" label in local time. */
function formatSlotLabel(startMs: number, endMs: number): string {
  const fmt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${fmt(startMs)} - ${fmt(endMs)}`;
}

/**
 * Create a Google Calendar event for a confirmed meetup.
 */
export async function createCalendarEvent(
  contactId: string,
  platform: Platform,
  title: string,
  startTime: string,
  durationMinutes: number,
  location?: string,
  notes?: string,
): Promise<CalendarEventDoc | null> {
  const settings = await getCalendarSettings();
  const token = await getCalendarToken();
  if (!settings.enabled || !isTokenUsable(token)) return null;

  const start = new Date(startTime);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const prepStart = new Date(start.getTime() - settings.prepTimeMinutes * 60_000);

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.calendarId || 'primary')}/events`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token.accessToken}`,
        },
        body: JSON.stringify({
          summary: title,
          description: notes || `${platform} contact: ${contactId}`,
          location: location || '',
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'popup', minutes: settings.prepTimeMinutes },
              { method: 'popup', minutes: 5 },
            ],
          },
        }),
      },
    );

    if (res.status === 401) await clearRejectedToken();
    if (!res.ok) throw new Error(`Calendar create ${res.status}`);
    const event = await res.json();

    // Store in PouchDB
    const store = await getDB();
    const doc: CalendarEventDoc = {
      _id: `calevent:${contactId}:${Date.now()}`,
      docType: 'calendar_event',
      contactId,
      platform,
      googleEventId: event.id,
      title,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      prepStartTime: prepStart.toISOString(),
      location: location || '',
      notes: notes || '',
      status: 'confirmed',
      createdAt: new Date().toISOString(),
    };
    await store.put(doc);
    return doc;
  } catch (err) {
    console.error('[Calendar] Event create error:', err);
    return null;
  }
}

/**
 * Initiate Google Calendar OAuth via chrome.identity and persist the token.
 *
 * Must run in the extension context (service worker) where chrome.identity is
 * available. On success stores a token with a 1-hour expiry (chrome.identity
 * owns refresh, so no refresh token is kept). Auth failures are logged without
 * the token and reported as `false`.
 *
 * @returns true if a token was obtained and saved, false otherwise.
 */
export async function authenticateCalendar(): Promise<boolean> {
  try {
    if (typeof chrome !== 'undefined' && chrome?.identity?.getAuthToken) {
      const token = await chrome.identity.getAuthToken({
        interactive: true,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      } as any);
      const tokenStr = (token as any)?.token || token;
      if (tokenStr) {
        await saveCalendarToken({
          accessToken: String(tokenStr),
          refreshToken: '',
          expiresAt: Date.now() + 3600_000,
        });
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('[Calendar] Auth error:', err);
    return false;
  }
}
