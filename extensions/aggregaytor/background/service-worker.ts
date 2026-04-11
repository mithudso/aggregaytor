/**
 * service-worker.ts — Extension background service worker.
 */

import type { UnifiedMessage, UnifiedContact, Platform } from '@aggregaytor/adapter-core';
import {
  upsertMessages, upsertContact, getUnreadCount, getThreadSummaries,
  getMessagesByContact, markThreadRead,
} from '@aggregaytor/store';
import { generateSuggestions, getLLMConfig, saveLLMConfig } from './llm.js';
import type { ThreadSummary } from '@aggregaytor/store';

const LOG = '[Aggregaytor:SW]';

console.log(`${LOG} Service worker starting...`);

/** Platform → base URL for opening conversations. */
const PLATFORM_URLS: Record<string, (contactId: string) => string> = {
  sniffies: (id) => `https://sniffies.com/profile/${id.replace('sniffies:', '')}/chat`,
  grindr: (id) => `https://web.grindr.com/chat/${id.replace('grindr:', '')}`,
  doublelist: (_id) => `https://doublelist.com/inbox/`,
  adam4adam: (id) => `https://www.adam4adam.com/messages/${id.replace('adam4adam:', '')}`,
  gmail: (_id) => `https://mail.google.com/mail/`,
  yahoo: (_id) => `https://mail.yahoo.com/`,
};

chrome.runtime.onMessage.addListener(
  (message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) => {
    console.log(`${LOG} Received:`, message.type, message.platform || '');

    if (message.type === 'ADAPTER_MESSAGES') {
      handleIncomingMessages(message.payload as UnifiedMessage[], message.platform as Platform)
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
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

    if (message.type === 'GET_MESSAGES_BY_CONTACT') {
      getMessagesByContact(message.contactId, { limit: message.limit || 200 })
        .then(messages => sendResponse({ ok: true, messages }))
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    if (message.type === 'MARK_THREAD_READ') {
      markThreadRead(message.threadId)
        .then(count => {
          updateBadgeCount();
          sendResponse({ ok: true, count });
        })
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    if (message.type === 'GENERATE_SUGGESTIONS') {
      generateSuggestions(message.messages, message.contactName, message.platform)
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    if (message.type === 'GET_LLM_CONFIG') {
      getLLMConfig()
        .then(config => sendResponse({ ok: true, config }))
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    if (message.type === 'SAVE_LLM_CONFIG') {
      saveLLMConfig(message.config)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    if (message.type === 'NAVIGATE_TO_CONVERSATION') {
      navigateToConversation(message.platform, message.contactId)
        .then(() => sendResponse({ ok: true }))
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
  } catch { /* side panel may not be open */ }
  return result;
}

async function handleIncomingContacts(contacts: UnifiedContact[]): Promise<void> {
  for (const contact of contacts) {
    await upsertContact(contact);
  }
}

async function navigateToConversation(platform: string, contactId: string): Promise<void> {
  const urlFn = PLATFORM_URLS[platform];
  if (!urlFn) return;
  const url = urlFn(contactId);

  // Try to find an existing tab for this platform
  const tabs = await chrome.tabs.query({});
  const platformHost = new URL(url).hostname;
  const existing = tabs.find(t => {
    try { return t.url && new URL(t.url).hostname === platformHost; } catch { return false; }
  });

  if (existing?.id) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function updateBadgeCount(): Promise<void> {
  try {
    const count = await getUnreadCount();
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF6B6B' });
  } catch { /* ignore */ }
}

updateBadgeCount().catch(() => {});
chrome.alarms.create('badge-refresh', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badge-refresh') updateBadgeCount().catch(() => {});
});

console.log(`${LOG} Service worker ready`);
