/**
 * service-worker.ts — Extension background service worker.
 *
 * Routes messages from content scripts to PouchDB store,
 * manages badge counts, and serves UI queries.
 */

// Note: In the final Vite build, these imports will be bundled.
// For now, this serves as the architectural reference.

import type { UnifiedMessage, UnifiedContact, Platform } from '@aggregaytor/adapter-core';
import { upsertMessages, upsertContact, getUnreadCount, getThreadSummaries } from '@aggregaytor/store';
import type { ThreadSummary } from '@aggregaytor/store';

// Message routing from content scripts
chrome.runtime.onMessage.addListener(
  (message: any, _sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) => {
    if (message.type === 'ADAPTER_MESSAGES') {
      handleIncomingMessages(message.payload as UnifiedMessage[], message.platform as Platform)
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true; // async response
    }

    if (message.type === 'ADAPTER_CONTACTS') {
      handleIncomingContacts(message.payload as UnifiedContact[])
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    if (message.type === 'GET_THREAD_SUMMARIES') {
      getThreadSummaries(message.opts)
        .then((summaries: ThreadSummary[]) => sendResponse({ ok: true, summaries }))
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    if (message.type === 'GET_UNREAD_COUNT') {
      getUnreadCount(message.platform)
        .then((count: number) => sendResponse({ ok: true, count }))
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    return false;
  },
);

async function handleIncomingMessages(
  messages: UnifiedMessage[],
  platform: Platform,
): Promise<{ created: number; updated: number }> {
  const result = await upsertMessages(messages);
  await updateBadgeCount();
  // Notify side panel of new messages
  try {
    chrome.runtime.sendMessage({
      type: 'NEW_MESSAGES',
      platform,
      count: result.created,
    });
  } catch {
    // side panel may not be open
  }
  return result;
}

async function handleIncomingContacts(contacts: UnifiedContact[]): Promise<void> {
  for (const contact of contacts) {
    await upsertContact(contact);
  }
}

async function updateBadgeCount(): Promise<void> {
  const count = await getUnreadCount();
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF6B6B' });
}

// Update badge on startup
updateBadgeCount().catch(() => {});

// Periodic badge refresh
chrome.alarms.create('badge-refresh', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badge-refresh') {
    updateBadgeCount().catch(() => {});
  }
});
