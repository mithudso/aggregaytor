/**
 * service-worker.ts — Extension background service worker.
 */

import type { UnifiedMessage, UnifiedContact, Platform } from '@aggregaytor/adapter-core';
import { upsertMessages, upsertContact, getUnreadCount, getThreadSummaries } from '@aggregaytor/store';
import type { ThreadSummary } from '@aggregaytor/store';

const LOG = '[Aggregaytor:SW]';

console.log(`${LOG} Service worker starting...`);

chrome.runtime.onMessage.addListener(
  (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) => {
    console.log(`${LOG} Received message:`, message.type, message.platform || '', 'from tab:', sender.tab?.id);

    if (message.type === 'ADAPTER_MESSAGES') {
      const msgs = message.payload as UnifiedMessage[];
      console.log(`${LOG} Processing ${msgs.length} messages from ${message.platform}`);
      handleIncomingMessages(msgs, message.platform as Platform)
        .then(result => {
          console.log(`${LOG} Stored: ${result.created} new, ${result.updated} updated`);
          sendResponse({ ok: true, ...result });
        })
        .catch(err => {
          console.error(`${LOG} Store error:`, err);
          sendResponse({ ok: false, error: (err as Error).message });
        });
      return true;
    }

    if (message.type === 'ADAPTER_CONTACTS') {
      const contacts = message.payload as UnifiedContact[];
      console.log(`${LOG} Processing ${contacts.length} contacts from ${message.platform}`);
      handleIncomingContacts(contacts)
        .then(() => sendResponse({ ok: true }))
        .catch(err => {
          console.error(`${LOG} Contact store error:`, err);
          sendResponse({ ok: false, error: (err as Error).message });
        });
      return true;
    }

    if (message.type === 'GET_THREAD_SUMMARIES') {
      getThreadSummaries(message.opts)
        .then((summaries: ThreadSummary[]) => {
          console.log(`${LOG} Returning ${summaries.length} thread summaries`);
          sendResponse({ ok: true, summaries });
        })
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
  try {
    chrome.runtime.sendMessage({ type: 'NEW_MESSAGES', platform, count: result.created });
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
  try {
    const count = await getUnreadCount();
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF6B6B' });
  } catch (err) {
    console.warn(`${LOG} Badge update failed:`, err);
  }
}

updateBadgeCount().catch(() => {});

chrome.alarms.create('badge-refresh', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badge-refresh') updateBadgeCount().catch(() => {});
});

console.log(`${LOG} Service worker ready`);
