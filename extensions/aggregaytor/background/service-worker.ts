/**
 * service-worker.ts — Extension background service worker.
 */

import type { UnifiedMessage, UnifiedContact, Platform } from '@aggregaytor/adapter-core';
import {
  upsertMessages, upsertContact, getUnreadCount, getThreadSummaries,
  getMessagesByContact, markThreadRead,
  getThreadMeta, upsertThreadMeta, getAllThreadMeta,
  createReminder, getReminders, markReminderNotified, deleteReminder,
  queueAutoRespond, getPendingAutoResponds, updateAutoRespondStatus,
} from '@aggregaytor/store';
import type { ThreadSummary } from '@aggregaytor/store';
import { generateSuggestions, generateAutoResponse, generateGreeting, getLLMConfig, saveLLMConfig } from './llm.js';

const LOG = '[Aggregaytor:SW]';
console.log(`${LOG} Service worker starting...`);

const PLATFORM_URLS: Record<string, (contactId: string) => string> = {
  sniffies: (id) => `https://sniffies.com/profile/${id.replace('sniffies:', '')}/chat`,
  grindr: (id) => `https://web.grindr.com/chat/${id.replace('grindr:', '')}`,
  doublelist: (_id) => `https://doublelist.com/inbox/`,
  adam4adam: (id) => `https://www.adam4adam.com/messages/${id.replace('adam4adam:', '')}`,
  gmail: (_id) => `https://mail.google.com/mail/`,
  yahoo: (_id) => `https://mail.yahoo.com/`,
};

chrome.runtime.onMessage.addListener(
  (message: any, _sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void) => {
    handleMessage(message).then(sendResponse).catch(err =>
      sendResponse({ ok: false, error: (err as Error).message })
    );
    return true; // async
  },
);

async function handleMessage(msg: any): Promise<any> {
  switch (msg.type) {
    // ── Messages ──
    case 'ADAPTER_MESSAGES':
      return handleIncomingMessages(msg.payload, msg.platform);
    case 'ADAPTER_CONTACTS':
      await handleIncomingContacts(msg.payload);
      return { ok: true };
    case 'GET_THREAD_SUMMARIES':
      return { ok: true, summaries: await getThreadSummaries(msg.opts) };
    case 'GET_UNREAD_COUNT':
      return { ok: true, count: await getUnreadCount(msg.platform) };
    case 'GET_MESSAGES_BY_CONTACT':
      return { ok: true, messages: await getMessagesByContact(msg.contactId, { limit: msg.limit || 200 }) };
    case 'MARK_THREAD_READ': {
      const count = await markThreadRead(msg.threadId);
      await updateBadgeCount();
      return { ok: true, count };
    }
    case 'NAVIGATE_TO_CONVERSATION':
      await navigateToConversation(msg.platform, msg.contactId);
      return { ok: true };

    // ── Thread metadata ──
    case 'GET_THREAD_META':
      return { ok: true, meta: await getThreadMeta(msg.contactId) };
    case 'UPSERT_THREAD_META':
      return { ok: true, meta: await upsertThreadMeta(msg.contactId, msg.platform, msg.updates) };
    case 'GET_ALL_THREAD_META':
      return { ok: true, metas: await getAllThreadMeta() };

    // ── Reminders ──
    case 'CREATE_REMINDER':
      return { ok: true, reminder: await createReminder(msg.contactId, msg.platform, msg.note, msg.dueAt) };
    case 'GET_REMINDERS':
      return { ok: true, reminders: await getReminders(msg.opts) };
    case 'DELETE_REMINDER':
      await deleteReminder(msg.id);
      return { ok: true };

    // ── LLM ──
    case 'GENERATE_SUGGESTIONS':
      return { ok: true, ...(await generateSuggestions(msg.messages, msg.contactName, msg.platform)) };
    case 'GET_LLM_CONFIG':
      return { ok: true, config: await getLLMConfig() };
    case 'SAVE_LLM_CONFIG':
      await saveLLMConfig(msg.config);
      return { ok: true };

    // ── Greeting ──
    case 'SEND_GREETING': {
      const greeting = await generateGreeting(msg.platform);
      // Queue with 5-15s delay
      const delay = 5000 + Math.floor(Math.random() * 10000);
      setTimeout(() => sendMessageToTab(msg.platform, msg.contactId, greeting.response), delay);
      return { ok: true, greeting: greeting.response, delay };
    }

    // ── Auto-respond ──
    case 'TOGGLE_AUTO_RESPOND':
      return { ok: true, meta: await upsertThreadMeta(msg.contactId, msg.platform, { autoRespondEnabled: msg.enabled }) };

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

// ── Core handlers ───────────────────────────────────────────────────────────

async function handleIncomingMessages(
  messages: UnifiedMessage[],
  platform: Platform,
): Promise<any> {
  const result = await upsertMessages(messages);
  await updateBadgeCount();
  try { chrome.runtime.sendMessage({ type: 'NEW_MESSAGES', platform, count: result.created }); } catch {}

  // Check auto-respond for each new inbound message
  if (result.created > 0) {
    for (const msg of messages) {
      if (msg.direction !== 'in') continue;
      try {
        const meta = await getThreadMeta(msg.contactId);
        if (meta?.autoRespondEnabled) {
          const queued = await queueAutoRespond(msg.contactId, msg.platform, msg.id);
          if (queued) {
            console.log(`${LOG} Auto-respond queued for ${msg.contactId}, scheduled at ${queued.scheduledAt}`);
            chrome.alarms.create('auto-respond-check', { delayInMinutes: 0.5 });
          }
        }
        // Unhide if hiddenUntilResponse
        if (meta?.hiddenUntilResponse) {
          await upsertThreadMeta(msg.contactId, msg.platform, { hiddenUntilResponse: false, hidden: false });
        }
      } catch (err) {
        console.warn(`${LOG} Auto-respond check failed:`, err);
      }
    }
  }

  return { ok: true, ...result };
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
  const tabs = await chrome.tabs.query({});
  const platformHost = new URL(url).hostname;
  const existing = tabs.find(t => { try { return t.url && new URL(t.url).hostname === platformHost; } catch { return false; } });
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { url, active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function sendMessageToTab(platform: string, contactId: string, text: string): Promise<void> {
  console.log(`${LOG} Sending message to ${contactId}: "${text.slice(0, 50)}..."`);
  const urlFn = PLATFORM_URLS[platform];
  if (!urlFn) return;
  const url = urlFn(contactId);
  const tabs = await chrome.tabs.query({});
  const platformHost = new URL(url).hostname;
  const tab = tabs.find(t => { try { return t.url && new URL(t.url).hostname === platformHost; } catch { return false; } });

  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url, active: true });
    // Wait for page load, then send
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id!, { type: 'SEND_AUTO_RESPONSE', text, contactId }).catch(err => {
        console.warn(`${LOG} DOM send failed:`, err);
      });
    }, 3000);
  } else {
    const newTab = await chrome.tabs.create({ url });
    setTimeout(() => {
      if (newTab.id) {
        chrome.tabs.sendMessage(newTab.id, { type: 'SEND_AUTO_RESPONSE', text, contactId }).catch(err => {
          console.warn(`${LOG} DOM send failed:`, err);
        });
      }
    }, 5000);
  }
}

// ── Auto-respond alarm ──────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'badge-refresh') {
    await updateBadgeCount().catch(() => {});
    return;
  }
  if (alarm.name === 'auto-respond-check') {
    await processAutoResponds().catch(err => console.error(`${LOG} Auto-respond error:`, err));
    return;
  }
  if (alarm.name === 'reminder-check') {
    await processReminders().catch(err => console.error(`${LOG} Reminder error:`, err));
  }
});

async function processAutoResponds(): Promise<void> {
  const pending = await getPendingAutoResponds();
  if (!pending.length) return;
  console.log(`${LOG} Processing ${pending.length} auto-responds`);

  for (const entry of pending) {
    try {
      await updateAutoRespondStatus(entry._id, 'generating');
      const messages = await getMessagesByContact(entry.contactId, { limit: 30 });
      const contactName = entry.contactId.replace(/^[a-z]+:/, '').slice(0, 10);
      const result = await generateAutoResponse(
        messages.map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })),
        contactName,
        entry.platform,
      );
      await updateAutoRespondStatus(entry._id, 'sending', { generatedResponse: result.response });
      await sendMessageToTab(entry.platform, entry.contactId, result.response);
      await updateAutoRespondStatus(entry._id, 'sent');
    } catch (err) {
      console.error(`${LOG} Auto-respond failed for ${entry.contactId}:`, err);
      await updateAutoRespondStatus(entry._id, 'failed', { error: (err as Error).message });
    }
  }
}

async function processReminders(): Promise<void> {
  const reminders = await getReminders({ upcoming: true });
  const now = Date.now();
  const approachMs = 20 * 60_000; // 20 min before

  for (const r of reminders) {
    const dueMs = new Date(r.dueAt).getTime();
    if (!r.notifiedApproach && (dueMs - now) <= approachMs && (dueMs - now) > 0) {
      chrome.notifications.create(`reminder-approach-${r._id}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: 'Reminder approaching',
        message: `${r.note} — in ${Math.round((dueMs - now) / 60_000)} min`,
      });
      await markReminderNotified(r._id, 'approach');
    }
    if (!r.notifiedDue && dueMs <= now) {
      chrome.notifications.create(`reminder-due-${r._id}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: 'Reminder',
        message: r.note,
      });
      await markReminderNotified(r._id, 'due');
    }
  }
}

// ── Badge + alarms ──────────────────────────────────────────────────────────

async function updateBadgeCount(): Promise<void> {
  try {
    const count = await getUnreadCount();
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF6B6B' });
  } catch {}
}

updateBadgeCount().catch(() => {});
chrome.alarms.create('badge-refresh', { periodInMinutes: 1 });
chrome.alarms.create('reminder-check', { periodInMinutes: 0.25 }); // every 15 seconds

console.log(`${LOG} Service worker ready`);
