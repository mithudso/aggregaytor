/**
 * calendar.ts — Google Calendar integration: OAuth, availability, event creation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;

import type { Platform } from '@aggregaytor/adapter-core';
import type { CalendarEventDoc, TimeSlot } from './types.js';
import { getDB } from './db.js';

const CAL_SETTINGS_KEY = 'aggregaytor_calendar_settings';
const CAL_TOKEN_KEY = 'aggregaytor_calendar_token';

// Storage abstraction — chrome.storage.local is injected at runtime
let _storage: { get(k: string): Promise<any>; set(k: string, v: any): Promise<void> } | null = null;

export function setCalendarStorage(storage: { get(k: string): Promise<any>; set(k: string, v: any): Promise<void> }): void {
  _storage = storage;
}

async function storageGet(key: string): Promise<any> {
  if (_storage) return _storage.get(key);
  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    const data = await chrome.storage.local.get(key);
    return data[key];
  }
  return null;
}

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

export async function getCalendarSettings(): Promise<CalendarSettings> {
  const data = await storageGet(CAL_SETTINGS_KEY);
  return { ...DEFAULT_CAL_SETTINGS, ...(data || {}) };
}

export async function saveCalendarSettings(settings: Partial<CalendarSettings>): Promise<void> {
  const existing = await getCalendarSettings();
  await storageSet(CAL_SETTINGS_KEY, { ...existing, ...settings });
}

export async function getCalendarToken(): Promise<CalendarToken | null> {
  return await storageGet(CAL_TOKEN_KEY) || null;
}

export async function saveCalendarToken(token: CalendarToken): Promise<void> {
  await storageSet(CAL_TOKEN_KEY, token);
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
  if (!settings.enabled || !token?.accessToken) return [];

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

function invertBusyToFree(
  from: string, to: string,
  busy: Array<{ start: string; end: string }>,
  settings: CalendarSettings,
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const bufferMs = (settings.prepTimeMinutes + settings.travelTimeMinutes) * 60_000;
  let cursor = new Date(from).getTime();
  const end = new Date(to).getTime();

  // Sort busy periods
  const sorted = [...busy].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  for (const period of sorted) {
    const busyStart = new Date(period.start).getTime() - bufferMs; // need buffer before
    if (cursor < busyStart) {
      const slotDuration = busyStart - cursor;
      if (slotDuration >= 30 * 60_000) { // minimum 30 min slot
        slots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(busyStart).toISOString(),
          label: formatSlotLabel(cursor, busyStart),
        });
      }
    }
    cursor = Math.max(cursor, new Date(period.end).getTime());
  }

  // Final slot after last busy period
  if (cursor < end) {
    slots.push({
      start: new Date(cursor).toISOString(),
      end: new Date(end).toISOString(),
      label: formatSlotLabel(cursor, end),
    });
  }

  return slots;
}

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
  if (!settings.enabled || !token?.accessToken) return null;

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
 * Initiate Google Calendar OAuth using chrome.identity.
 */
/**
 * Authenticate with Google Calendar.
 * Must be called from the extension context (service worker) where chrome.identity is available.
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
