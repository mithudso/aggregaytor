/**
 * service-worker.ts — Extension background service worker.
 */

import type { UnifiedMessage, UnifiedContact, Platform } from '@aggregaytor/adapter-core';
import {
  upsertMessages, upsertContact, upsertContacts, getUnreadCount, getThreadSummaries,
  getMessagesByContact, markThreadRead,
  getThreadMeta, upsertThreadMeta, getAllThreadMeta,
  createReminder, getReminders, markReminderNotified, deleteReminder,
  queueAutoRespond, getPendingAutoResponds, getDraftAutoResponds, getApprovedAutoResponds, updateAutoRespondStatus,
  addPicture, getAllPictures, getPictureByTag, incrementPictureStat, deletePicture,
  createBlockRule, getAllBlockRules, updateBlockRule, deleteBlockRule, evaluateRules, executeAction,
  getCalendarSettings, saveCalendarSettings, getAvailableSlots, createCalendarEvent, authenticateCalendar,
  recordFeedback, predictPreference, getModelStats, retrainModel,
  analyzeConversationSentiment, formatSentimentSummary,
  createTask, getAllTasks, updateTask, deleteTask, getTasksByContact,
  createGoogleTask, updateGoogleTask, deleteGoogleTask, pullGoogleTasks, syncGoogleTasks, authenticateGoogle, isGoogleAuthenticated,
  backupToDrive, restoreFromDrive, getDriveBackupStatus,
  getContact, getDB, destroyDB,
  exportAllData, importAllData, exportBlocked, importBlocked,
} from '@aggregaytor/store';
import type { ThreadSummary, AutoRespondSettings, ProfileFeatures } from '@aggregaytor/store';
import { generateSuggestions, generateAutoResponse, generateGreeting, generateNickname as llmNickname, extractDossierFields, localDossierExtraction, getLLMConfig, saveLLMConfig, getLLMRateSettings, saveLLMRateSettings, getLLMQueueStatus, getLLMOptimizationStats, getPersonalitySettings, savePersonalitySettings, deriveStyleGuide, PERSONALITY_PRESETS } from './llm.js';
import { getDossier, upsertDossier, setAutoExtractedField } from '@aggregaytor/store';
import { handleDebugCommand } from './debug-bridge.js';

const LOG = '[Aggregaytor:SW]';
console.log(`${LOG} Service worker starting...`);

// ── Service Worker Performance Counters ─────────────────────────────────────
// Lightweight in-memory counters tracking call counts and cumulative time
// for PouchDB operations and message handling in the service worker.
// Accessible via: chrome.runtime.sendMessage({type:'GET_SW_PERF'})
const swPerf: Record<string, { calls: number; totalMs: number; maxMs: number }> = {};
const swPerfStart = Date.now();
function swPerfTrack(name: string): () => void {
  const t0 = performance.now();
  return () => {
    const ms = performance.now() - t0;
    if (!swPerf[name]) swPerf[name] = { calls: 0, totalMs: 0, maxMs: 0 };
    swPerf[name].calls++;
    swPerf[name].totalMs += ms;
    if (ms > swPerf[name].maxMs) swPerf[name].maxMs = ms;
  };
}

// ── Thread Summary Cache ──────────────────────────────────────────────────
// getThreadSummaries is the most expensive operation (81ms avg, 14x/min).
// It queries 5000 messages from PouchDB + N contact lookups on every call.
// Cache the result for 3 seconds to avoid redundant PouchDB round-trips
// when multiple triggers fire in rapid succession (CONTACTS_UPDATED,
// NEW_MESSAGES, panel opening, etc.)
let threadSummaryCache: { data: any; time: number; key: string } | null = null;
const THREAD_CACHE_TTL = 5000; // 5 seconds

function invalidateThreadCache(): void {
  threadSummaryCache = null;
}

function safeNotify(id: string, opts: chrome.notifications.NotificationOptions): void {
  try {
    chrome.notifications.create(id, opts, () => {
      if (chrome.runtime.lastError) {
        console.warn(`${LOG} Notification failed:`, chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.warn(`${LOG} Notification error:`, e);
  }
}

const PLATFORM_URLS: Record<string, (contactId: string) => string> = {
  sniffies: (id) => {
    const stripped = id.replace('sniffies:', '');
    if (stripped === 'global-chat') return 'https://sniffies.com/global-chat';
    return `https://sniffies.com/profile/${stripped}/chat`;
  },
  grindr: (id) => `https://web.grindr.com/chat/${id.replace('grindr:', '')}`,
  doublelist: () => `https://doublelist.com/inbox/`,
  adam4adam: (id) => `https://www.adam4adam.com/mailbox`,
  gmail: () => `https://mail.google.com/mail/`,
  yahoo: () => `https://mail.yahoo.com/`,
};

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: (err as Error).message }));
  return true;
});

async function handleMessage(msg: any): Promise<any> {
  switch (msg.type) {
    // ── Performance stats ──
    case 'GET_SW_PERF': {
      const uptimeMin = Math.max(1, (Date.now() - swPerfStart) / 60_000);
      const stats: Record<string, any> = {};
      for (const [k, v] of Object.entries(swPerf)) {
        stats[k] = { ...v,
          totalMs: Math.round(v.totalMs * 10) / 10,
          maxMs: Math.round(v.maxMs * 10) / 10,
          avgMs: v.calls ? Math.round((v.totalMs / v.calls) * 10) / 10 : 0,
          callsPerMin: Math.round((v.calls / uptimeMin) * 10) / 10,
        };
      }
      return { ok: true, stats, uptimeMin: Math.round(uptimeMin * 10) / 10 };
    }
    case 'ADAPTER_MESSAGES': {
      invalidateThreadCache();
      const end = swPerfTrack('handleIncomingMessages');
      const result = await handleIncomingMessages(msg.payload, msg.platform);
      end();
      return result;
    }
    case 'ADAPTER_CONTACTS': {
      // Do NOT invalidate thread cache — contact updates (avatar, metadata)
      // don't change the thread list (which is based on messages/unread counts).
      // This lets the 3s cache actually work instead of being invalidated 37x/min.
      const end = swPerfTrack('handleIncomingContacts');
      await handleIncomingContacts(msg.payload);
      end();
      return { ok: true };
    }
    case 'GET_CONTACT': {
      // Direct single-contact lookup — O(1) PouchDB get instead of the
      // full thread summaries query. Use this when you only need one contact.
      const contact = await getContact(msg.contactId);
      return { ok: true, contact };
    }
    case 'GET_THREAD_SUMMARIES': {
      const cacheKey = JSON.stringify(msg.opts || {});
      const now = Date.now();
      if (threadSummaryCache && threadSummaryCache.key === cacheKey &&
          (now - threadSummaryCache.time) < THREAD_CACHE_TTL) {
        swPerfTrack('getThreadSummaries:cached')();
        return { ok: true, summaries: threadSummaryCache.data };
      }
      const end = swPerfTrack('getThreadSummaries');
      const summaries = await getThreadSummaries(msg.opts);
      threadSummaryCache = { data: summaries, time: now, key: cacheKey };
      end();
      return { ok: true, summaries };
    }
    case 'GET_UNREAD_COUNT': return { ok: true, count: await getUnreadCount(msg.platform) };
    case 'GET_MESSAGES_BY_CONTACT': {
      let msgs = await getMessagesByContact(msg.contactId, { limit: msg.limit || 200 });

      // For non-global-chat contacts, also include their messages from global chat
      // (tagged by metadata.senderId matching the profile ID)
      if (msg.contactId !== 'sniffies:global-chat') {
        const profileId = msg.contactId.replace(/^[a-z]+:/, '');
        if (profileId) {
          const globalMsgs = await getMessagesByContact('sniffies:global-chat', { limit: 500 });
          const fromThisSender = globalMsgs.filter(m =>
            m.metadata?.senderId === profileId || m.metadata?.profileId === profileId
          );
          if (fromThisSender.length) {
            // Tag global chat messages so the UI can show them differently
            const tagged = fromThisSender.map(m => ({ ...m, metadata: { ...m.metadata, fromGlobalChat: true } }));
            msgs = [...msgs, ...tagged];
          }
        }
      }

      return { ok: true, messages: msgs };
    }
    case 'MARK_THREAD_READ': { const c = await markThreadRead(msg.threadId); await updateBadgeCount(); return { ok: true, count: c }; }
    case 'SEARCH_MESSAGES': {
      const db = await getDB();
      const result = await db.find({ selector: { docType: 'message' }, limit: 5000 });
      const q = String(msg.query || '').toLowerCase();
      const matches = (result.docs as any[])
        .filter((d: any) => d.body && d.body.toLowerCase().includes(q))
        .sort((a: any, b: any) => (b.timestamp || '').localeCompare(a.timestamp || ''))
        .slice(0, msg.limit || 50);
      return { ok: true, messages: matches };
    }
    case 'CLEAR_ALL_DATA': {
      // Destroy and recreate the entire database
      await destroyDB();
      await getDB(); // force recreation
      console.log(`${LOG} Cleared all data — database destroyed and recreated`);
      await updateBadgeCount();
      // Re-seed global chat contact
      await upsertContact({
        id: 'sniffies:global-chat', platform: 'sniffies', platformUserId: 'global-chat',
        displayName: '🌐 Global Chat', profileUrl: 'https://sniffies.com/global-chat',
        avatarUrl: '', lastSeen: new Date().toISOString(), metadata: { isGlobalChat: true },
      });
      return { ok: true };
    }
    case 'NAVIGATE_TO_CONVERSATION': {
      await navigateToConversation(msg.platform, msg.contactId);
      if (msg.contactId === 'sniffies:global-chat') {
        setTimeout(async () => {
          const tabs = await chrome.tabs.query({});
          const gcTab = tabs.find(t => t.url?.includes('sniffies.com/global-chat'));
          if (gcTab?.id) {
            chrome.tabs.sendMessage(gcTab.id, { type: 'SCRAPE_GLOBAL_CHAT' }).catch(() => {});
          }
        }, 3000);
      }
      return { ok: true };
    }
    case 'OPEN_ALL_SITES': { await openAllSites(); return { ok: true }; }
    case 'SYNC_PROFILE_PICS': {
      // Send scrape request to all platform tabs
      const platformHosts = ['sniffies.com', 'web.grindr.com', 'doublelist.com', 'adam4adam.com'];
      const allTabs = await chrome.tabs.query({});
      let tabCount = 0;
      let totalScraped = 0;
      for (const tab of allTabs) {
        if (!tab.id || !tab.url) continue;
        const isMatch = platformHosts.some(h => tab.url!.includes(h));
        if (!isMatch) continue;
        tabCount++;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_AVATARS' });
          totalScraped += res?.count || 0;
          console.log(`${LOG} Scraped ${res?.count || 0} avatars from tab ${tab.id} (${tab.url?.slice(0, 40)})`);
        } catch (err) {
          console.warn(`${LOG} SCRAPE_AVATARS failed on tab ${tab.id} (${tab.url?.slice(0, 40)}):`, (err as Error).message);
        }
      }
      return { ok: true, count: totalScraped, tabs: tabCount };
    }
    case 'SCRAPE_CONVERSATION': {
      // Ask the Sniffies tab to scrape all visible messages in the current conversation
      const platformHosts = ['sniffies.com', 'web.grindr.com', 'doublelist.com', 'adam4adam.com'];
      const tabs = await chrome.tabs.query({});
      let scraped = 0;
      for (const tab of tabs) {
        if (!tab.id || !tab.url) continue;
        if (!platformHosts.some(h => tab.url!.includes(h))) continue;
        try {
          const res = await chrome.tabs.sendMessage(tab.id, {
            type: 'SCRAPE_CONVERSATION',
            contactId: msg.contactId,
            profileId: msg.profileId,
          });
          scraped += res?.count || 0;
        } catch {}
      }
      return { ok: true, count: scraped };
    }
    case 'CLEAR_THREAD_MESSAGES': {
      const db = await getDB();
      const result = await db.find({ selector: { docType: 'message', contactId: msg.contactId } });
      for (const doc of result.docs) { await db.remove(doc); }
      console.log(`${LOG} Cleared ${result.docs.length} messages for ${msg.contactId}`);
      return { ok: true, count: result.docs.length };
    }
    case 'PROFILE_BLOCKED': {
      console.log(`${LOG} Block detected: ${msg.contactId}`);
      await upsertThreadMeta(msg.contactId, msg.platform, { blockedByThem: true, archived: true });
      chrome.runtime.sendMessage({ type: 'NEW_MESSAGES', platform: msg.platform, count: 0 }).catch(() => {})
      return { ok: true };
    }
    case 'ACTIVE_PROFILE_CHANGED': {
      // Relay to side panel so it can highlight the active conversation
      chrome.runtime.sendMessage({ type: 'ACTIVE_PROFILE_CHANGED', contactId: msg.contactId, platform: msg.platform }).catch(() => {})
      return { ok: true };
    }

    // Thread meta
    case 'GET_THREAD_META': return { ok: true, meta: await getThreadMeta(msg.contactId) };
    case 'UPSERT_THREAD_META': return { ok: true, meta: await upsertThreadMeta(msg.contactId, msg.platform, msg.updates) };
    case 'GET_ALL_THREAD_META': return { ok: true, metas: await getAllThreadMeta() };

    // Reminders
    case 'CREATE_REMINDER': return { ok: true, reminder: await createReminder(msg.contactId, msg.platform, msg.note, msg.dueAt) };
    case 'GET_REMINDERS': return { ok: true, reminders: await getReminders(msg.opts) };
    case 'DELETE_REMINDER': { await deleteReminder(msg.id); return { ok: true }; }

    // LLM
    case 'GENERATE_SUGGESTIONS': return { ok: true, ...(await generateSuggestions(msg.messages, msg.contactName, msg.platform)) };
    case 'GET_LLM_CONFIG': return { ok: true, config: await getLLMConfig() };
    case 'SAVE_LLM_CONFIG': { await saveLLMConfig(msg.config); return { ok: true }; }
    case 'SET_LOG_LEVEL': {
      await chrome.storage.local.set({ aggregaytor_log_level: msg.level });
      const allTabs = await chrome.tabs.query({});
      for (const tab of allTabs) {
        if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'SET_LOG_LEVEL', level: msg.level }).catch(() => {});
      }
      return { ok: true };
    }
    case 'GET_PERSONALITY': return { ok: true, personality: await getPersonalitySettings(), presets: Object.entries(PERSONALITY_PRESETS).map(([k, v]) => ({ id: k, ...v })) };
    case 'SAVE_PERSONALITY': { await savePersonalitySettings(msg.settings); return { ok: true }; }
    case 'DERIVE_STYLE_GUIDE': {
      // Collect all outbound messages (user's own writing, excluding auto-responses)
      const db = await getDB();
      const result = await db.find({ selector: { docType: 'message', direction: 'out' }, limit: 200 });
      const sentMsgs = (result.docs as any[])
        .filter(d => !d.metadata?.autoRespond && !d.metadata?.suggested)
        .map(d => ({ direction: 'out' as const, body: d.body, timestamp: d.timestamp }));
      const guide = await deriveStyleGuide(sentMsgs);
      await savePersonalitySettings({ styleGuide: guide, styleGuideUpdatedAt: new Date().toISOString() });
      return { ok: true, styleGuide: guide };
    }
    case 'GET_LLM_RATE_SETTINGS': return { ok: true, settings: await getLLMRateSettings() };
    case 'SAVE_LLM_RATE_SETTINGS': { await saveLLMRateSettings(msg.settings); return { ok: true }; }
    case 'GET_LLM_QUEUE_STATUS': return { ok: true, status: getLLMQueueStatus(), optimization: getLLMOptimizationStats() };

    // Session summary
    case 'GENERATE_SESSION_SUMMARY': {
      const summaries = await getThreadSummaries({ limit: 20 });
      const activeCount = summaries.filter(s => {
        const lastTs = new Date(s.lastMessage?.timestamp || 0).getTime();
        return Date.now() - lastTs < 48 * 3600_000; // active in last 48h
      }).length;
      const config = await getLLMConfig();
      if (config.provider === 'local' || !config.apiKey) {
        return { ok: true, summary: `${activeCount} active conversations in the last 48 hours. Auto-respond will handle incoming messages with contextual replies.` };
      }
      try {
        const res = await generateConversationSummary([], 'all contacts', 'all platforms');
        return { ok: true, summary: `${activeCount} active conversations. ${res.text || 'Auto-respond ready.'}` };
      } catch {
        return { ok: true, summary: `${activeCount} active conversations. Auto-respond ready.` };
      }
    }

    // Nickname
    case 'GENERATE_NICKNAME': {
      const nickname = await llmNickname(msg.metadata, msg.lastMessageBody, msg.platform);
      return { ok: true, nickname };
    }

    // Greeting
    case 'SEND_GREETING': {
      const g = await generateGreeting(msg.platform);
      const delay = 5000 + Math.floor(Math.random() * 10000);
      setTimeout(() => sendMessageToTab(msg.platform, msg.contactId, g.response), delay);
      return { ok: true, greeting: g.response, delay };
    }

    // Auto-respond
    case 'TOGGLE_AUTO_RESPOND': return { ok: true, meta: await upsertThreadMeta(msg.contactId, msg.platform, { autoRespondEnabled: msg.enabled }) };
    case 'UPDATE_AUTO_RESPOND_SETTINGS': return { ok: true, meta: await upsertThreadMeta(msg.contactId, msg.platform, { autoRespondSettings: msg.settings }) };

    // Drafts
    case 'GET_DRAFTS': return { ok: true, drafts: await getDraftAutoResponds() };
    case 'APPROVE_DRAFT': {
      await updateAutoRespondStatus(msg.id, 'approved', msg.editedResponse ? { generatedResponse: msg.editedResponse } : undefined);
      chrome.alarms.create('auto-respond-check', { delayInMinutes: 0.05 });
      return { ok: true };
    }
    case 'REJECT_DRAFT': { await updateAutoRespondStatus(msg.id, 'rejected'); return { ok: true }; }

    // Pictures
    case 'ADD_PICTURE': return { ok: true, picture: await addPicture(msg.input) };
    case 'GET_ALL_PICTURES': return { ok: true, pictures: await getAllPictures(msg.tag) };
    case 'DELETE_PICTURE': { await deletePicture(msg.id); return { ok: true }; }
    case 'INCREMENT_PICTURE_STAT': { await incrementPictureStat(msg.id, msg.stat); return { ok: true }; }

    // Block rules
    case 'CREATE_BLOCK_RULE': return { ok: true, rule: await createBlockRule(msg.input) };
    case 'GET_ALL_BLOCK_RULES': return { ok: true, rules: await getAllBlockRules() };
    case 'UPDATE_BLOCK_RULE': { await updateBlockRule(msg.id, msg.updates); return { ok: true }; }
    case 'DELETE_BLOCK_RULE': { await deleteBlockRule(msg.id); return { ok: true }; }

    // Calendar
    case 'AUTHENTICATE_CALENDAR': return { ok: true, success: await authenticateCalendar() };
    case 'GET_CALENDAR_SETTINGS': return { ok: true, settings: await getCalendarSettings() };
    case 'SAVE_CALENDAR_SETTINGS': { await saveCalendarSettings(msg.settings); return { ok: true }; }
    case 'GET_AVAILABLE_SLOTS': return { ok: true, slots: await getAvailableSlots(msg.from, msg.to) };
    case 'CREATE_CALENDAR_EVENT': return { ok: true, event: await createCalendarEvent(msg.contactId, msg.platform, msg.title, msg.startTime, msg.duration, msg.location, msg.notes) };

    // ML Preference + Sentiment
    case 'RECORD_PREFERENCE': {
      const contact = await getContact(msg.contactId);
      const features: ProfileFeatures = {
        bodyType: String(contact?.metadata?.bodyType || contact?.metadata?.body || ''),
        position: String(contact?.metadata?.attitude || contact?.metadata?.position || ''),
        age: String(contact?.metadata?.age || ''),
        ethnicity: String(contact?.metadata?.ethnicity || ''),
        height: String(contact?.metadata?.height || ''),
        profileTextLength: String(contact?.metadata?.profileText || '').length,
        profileTextKeywords: String(contact?.metadata?.profileText || '').toLowerCase().split(/\s+/).slice(0, 20),
        hasPhoto: !!contact?.avatarUrl,
        photoCount: Number(contact?.metadata?.photoCount || (contact?.avatarUrl ? 1 : 0)),
        distance: String(contact?.metadata?.distance || ''),
        conversationLength: (await getMessagesByContact(msg.contactId, { limit: 500 })).length,
        responseRate: 0,
      };
      await recordFeedback(msg.contactId, msg.platform, msg.liked, features);
      const prediction = await predictPreference(features);
      await upsertThreadMeta(msg.contactId, msg.platform, { preferenceScore: prediction.score });
      return { ok: true, prediction };
    }
    case 'GET_MODEL_STATS': return { ok: true, stats: await getModelStats() };
    case 'RETRAIN_MODEL': { await retrainModel(); return { ok: true }; }

    // Thread analysis (sentiment + preference + summary)
    case 'ANALYZE_THREAD': {
      const sentiment = analyzeConversationSentiment(msg.messages);
      const contact = await getContact(msg.contactId);
      const features: ProfileFeatures = {
        bodyType: String(contact?.metadata?.bodyType || ''),
        position: String(contact?.metadata?.position || ''),
        age: '', ethnicity: '', height: '',
        profileTextLength: 0, profileTextKeywords: [],
        hasPhoto: !!contact?.avatarUrl, photoCount: 0,
        distance: '', conversationLength: msg.messages.length, responseRate: 0,
      };
      const preference = await predictPreference(features);

      // Update thread meta with latest sentiment
      await upsertThreadMeta(msg.contactId, msg.platform, {
        sentiment, preferenceScore: preference.score,
      });

      // Generate conversation summary via LLM
      let summary = { text: '', commitments: [] as string[] };
      try {
        summary = await generateConversationSummary(msg.messages, msg.contactName, msg.platform);
      } catch {}

      // Check if commitment opportunity — flash alert if so
      if (sentiment.commitment > 0.6 || summary.commitments.length > 0) {
        safeNotify(`commit-alert-${msg.contactId}`, {
          type: 'basic', iconUrl: 'icons/icon-128.png',
          title: 'Commitment opportunity!',
          message: `${msg.contactName} seems ready to commit. ${summary.commitments[0] || 'Check the conversation.'}`,
          requireInteraction: true, priority: 2,
        });
        // Flash the side panel
        chrome.runtime.sendMessage({ type: 'COMMITMENT_ALERT', contactId: msg.contactId, contactName: msg.contactName }).catch(() => {})
      }

      return { ok: true, sentiment, preference, summary };
    }

    // Dossier
    case 'GET_DOSSIER': return { ok: true, dossier: await getDossier(msg.contactId) };
    case 'UPSERT_DOSSIER': return { ok: true, dossier: await upsertDossier(msg.contactId, msg.platform, msg.updates) };
    case 'EXTRACT_DOSSIER': {
      const messages = await getMessagesByContact(msg.contactId, { limit: 100 });
      const existing = await getDossier(msg.contactId) || {};
      const extracted = await extractDossierFields(
        messages.map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })),
        msg.contactName || msg.contactId.replace(/^[a-z]+:/, '').slice(0, 10),
        existing,
      );
      // Save each extracted field with source attribution
      for (const [field, value] of Object.entries(extracted)) {
        await setAutoExtractedField(msg.contactId, msg.platform, field, value, 'llm-extraction');
      }
      return { ok: true, extracted, fieldCount: Object.keys(extracted).length };
    }

    // Tasks
    case 'CREATE_TASK': {
      const task = await createTask(msg);
      return { ok: true, task };
    }
    case 'GET_TASKS': {
      const tasks = await getAllTasks(msg.opts);
      return { ok: true, tasks };
    }
    case 'UPDATE_TASK': {
      const task = await updateTask(msg.id, msg.updates);
      return { ok: true, task };
    }
    case 'DELETE_TASK': {
      await deleteTask(msg.id);
      return { ok: true };
    }
    case 'GET_TASKS_BY_CONTACT': {
      const tasks = await getTasksByContact(msg.contactId);
      return { ok: true, tasks };
    }
    case 'SYNC_TASK_TO_CALENDAR': {
      // Create a Google Calendar event from a task
      try {
        const event = await createCalendarEvent({
          contactId: msg.contactId || '',
          platform: msg.platform || 'sniffies',
          title: msg.title,
          startTime: msg.dueAt,
          endTime: msg.endAt || new Date(new Date(msg.dueAt).getTime() + 3600000).toISOString(),
          location: msg.location || '',
          notes: msg.notes || '',
        });
        // Update the task with the calendar event ID
        if (event && msg.taskId) {
          await updateTask(msg.taskId, { calendarEventId: event.googleEventId || event._id });
        }
        return { ok: true, event };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    // ── Google OAuth + Tasks API ──────────────────────────────────────────
    case 'GOOGLE_AUTH': {
      try {
        const token = await authenticateGoogle();
        return { ok: !!token, token };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'GOOGLE_AUTH_STATUS': {
      const authed = await isGoogleAuthenticated();
      return { ok: true, authenticated: authed };
    }
    case 'GOOGLE_TASKS_CREATE': {
      try {
        const gTask = await createGoogleTask({ title: msg.title, notes: msg.notes, dueAt: msg.dueAt });
        // Also create local task with Google Task ID linked
        const localTask = await createTask({
          title: msg.title, notes: msg.notes, dueAt: msg.dueAt,
          priority: msg.priority || 'medium',
          contactId: msg.contactId, platform: msg.platform,
        });
        if (gTask?.id) await updateTask(localTask._id, { googleTaskId: gTask.id, lastSyncedAt: new Date().toISOString() });
        return { ok: true, task: localTask, googleTask: gTask };
      } catch (err) {
        // Fall back to local-only if Google API fails
        const localTask = await createTask({
          title: msg.title, notes: msg.notes, dueAt: msg.dueAt,
          priority: msg.priority || 'medium',
          contactId: msg.contactId, platform: msg.platform,
        });
        return { ok: true, task: localTask, googleError: (err as Error).message };
      }
    }
    case 'GOOGLE_TASKS_UPDATE': {
      try {
        if (msg.googleTaskId) {
          await updateGoogleTask(msg.googleTaskId, msg.updates);
        }
        if (msg.localTaskId) {
          await updateTask(msg.localTaskId, msg.updates);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'GOOGLE_TASKS_DELETE': {
      try {
        if (msg.googleTaskId) await deleteGoogleTask(msg.googleTaskId);
        if (msg.localTaskId) await deleteTask(msg.localTaskId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'GOOGLE_TASKS_PULL': {
      try {
        const remoteTasks = await pullGoogleTasks();
        return { ok: true, tasks: remoteTasks };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    case 'SYNC_TASKS': {
      try {
        const result = await syncGoogleTasks();
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }

    // ── Export/Import ──────────────────────────────────────────────────────
    case 'EXPORT_ALL_DATA': {
      try {
        const json = await exportAllData(msg.passphrase);
        return { ok: true, data: json };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'IMPORT_ALL_DATA': {
      try {
        invalidateThreadCache();
        const result = await importAllData(msg.data, msg.passphrase);
        return { ok: true, ...result };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'EXPORT_BLOCKED': {
      try {
        const json = await exportBlocked();
        return { ok: true, data: json };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'IMPORT_BLOCKED': {
      try {
        const result = await importBlocked(msg.data);
        return { ok: true, ...result };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }

    // ── Broadcast Message ──────────────────────────────────────────────────
    case 'BROADCAST_TO_FAVORITES': {
      // Send a message to all favorited contacts on a specific platform
      try {
        const allMeta = await getAllThreadMeta();
        const favorites = allMeta.filter(m =>
          (m.bookmarked || m.favorited) &&
          (!msg.platform || m.platform === msg.platform)
        );
        let sent = 0;
        const maxRecipients = Math.min(favorites.length, msg.maxRecipients || 50);

        for (let i = 0; i < maxRecipients; i++) {
          const meta = favorites[i];
          const contactId = meta._id?.replace('meta:', '') || meta.contactId;
          if (!contactId) continue;

          // Queue as auto-respond with the broadcast message
          try {
            const platform = meta.platform || contactId.split(':')[0];
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
              if (!tab.id || !tab.url) continue;
              const platformHosts: Record<string, string> = {
                sniffies: 'sniffies.com', grindr: 'web.grindr.com',
                doublelist: 'doublelist.com', adam4adam: 'adam4adam.com',
              };
              if (tab.url.includes(platformHosts[platform] || '___none___')) {
                await chrome.tabs.sendMessage(tab.id, {
                  type: 'SEND_AUTO_RESPONSE',
                  text: msg.message,
                  contactId,
                }).catch(() => {});
                // Navigate to the conversation first
                await chrome.tabs.sendMessage(tab.id, {
                  type: 'SPA_NAVIGATE',
                  url: PLATFORM_URLS[platform]?.(contactId) || '',
                  path: new URL(PLATFORM_URLS[platform]?.(contactId) || 'about:blank').pathname,
                }).catch(() => {});
                sent++;
                // Wait between sends to avoid rate limiting
                await new Promise(r => setTimeout(r, msg.delay || 3000));
                break;
              }
            }
          } catch {}
        }
        return { ok: true, sent, total: favorites.length };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }

    // ── Profile Rating ─────────────────────────────────────────────────────
    case 'SET_RATING': {
      const meta = await upsertThreadMeta(msg.contactId, msg.platform, { rating: msg.rating });
      return { ok: true, meta };
    }
    case 'CAPTURE_QUICK_PHRASE': {
      // Save captured text as a quick phrase in chrome.storage
      const data = await chrome.storage.local.get('aggregaytor_quick_phrases');
      const phrases: string[] = data.aggregaytor_quick_phrases || [];
      if (msg.text && !phrases.includes(msg.text)) {
        phrases.push(msg.text);
        await chrome.storage.local.set({ aggregaytor_quick_phrases: phrases });
      }
      return { ok: true, count: phrases.length };
    }

    // ── Google Drive Sync ──────────────────────────────────────────────────
    case 'DRIVE_BACKUP': {
      try {
        return await backupToDrive();
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'DRIVE_RESTORE': {
      try {
        invalidateThreadCache();
        return await restoreFromDrive();
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }
    case 'DRIVE_STATUS': {
      try {
        return { ok: true, ...(await getDriveBackupStatus()) };
      } catch (err) { return { ok: false, error: (err as Error).message }; }
    }

    // Debug commands (from MCP server or dev tools)
    case 'DEBUG_COMMAND': return { ok: true, result: await handleDebugCommand(msg.command, msg.params) };

    default: return { ok: false, error: `Unknown: ${msg.type}` };
  }
}

// ── Core handlers ───────────────────────────────────────────────────────────

async function handleIncomingMessages(messages: UnifiedMessage[], platform: Platform): Promise<any> {
  const result = await upsertMessages(messages);
  await updateBadgeCount();
  chrome.runtime.sendMessage({ type: 'NEW_MESSAGES', platform, count: result.created }).catch(() => {})

  if (result.created > 0) {
    for (const msg of messages) {
      if (msg.direction !== 'in') continue;
      // Never auto-respond to global chat — it's a broadcast feed, not a conversation
      if (msg.contactId.endsWith(':global-chat')) continue;
      try {
        const meta = await getThreadMeta(msg.contactId);
        if (meta?.autoRespondEnabled) {
          const queued = await queueAutoRespond(msg.contactId, msg.platform, msg.id);
          if (queued) {
            console.log(`${LOG} Auto-respond queued for ${msg.contactId}`);
            chrome.alarms.create('auto-respond-check', { delayInMinutes: 0.5 });
          }
        }
        if (meta?.hiddenUntilResponse) {
          await upsertThreadMeta(msg.contactId, msg.platform, { hiddenUntilResponse: false, hidden: false });
        }
      } catch {}
    }
    // Run block rules
    await runBlockRules(messages).catch(e => console.warn(`${LOG} Block rules error:`, e));

    // Queue dossier auto-extraction — waits for 30s of inactivity before starting
    const contactIds = new Set(messages.filter(m => m.direction === 'in').map(m => m.contactId));
    for (const cid of contactIds) {
      dossierExtractionQueue.add(`${cid}:${messages[0]?.platform || platform}`);
    }
    // Reset the idle timer on every new message — only starts after 30s of silence
    if (dossierExtractionQueue.size > 0) {
      if (dossierExtractionTimer) clearTimeout(dossierExtractionTimer);
      dossierExtractionTimer = setTimeout(processDossierExtractions, 30_000); // 30s idle debounce
    }
  }

  return { ok: true, ...result };
}

// Debounced dossier extraction — serial processing, 30s idle trigger
const dossierExtractionQueue = new Set<string>();
let dossierExtractionTimer: ReturnType<typeof setTimeout> | null = null;
let dossierProcessing = false;

async function processDossierExtractions(): Promise<void> {
  dossierExtractionTimer = null;
  if (dossierProcessing) return; // already running, will pick up queued items
  dossierProcessing = true;

  try {
    // Process one contact at a time (serial, not parallel)
    while (dossierExtractionQueue.size > 0) {
      const entry = dossierExtractionQueue.values().next().value;
      dossierExtractionQueue.delete(entry);
    const [contactId, platform] = [entry.substring(0, entry.lastIndexOf(':')), entry.substring(entry.lastIndexOf(':') + 1)];
    try {
      const allMessages = await getMessagesByContact(contactId, { limit: 50 });
      if (allMessages.length < 3) continue;

      // Incremental: only use NEW inbound messages since last extraction
      const inbound = allMessages.filter(m => m.direction === 'in');
      const existing = await getDossier(contactId) || {};
      const lastExtract = (existing as any).updatedAt || '';
      const newMessages = lastExtract
        ? inbound.filter(m => m.timestamp > lastExtract)
        : inbound;

      if (newMessages.length < 3) continue; // need at least 3 new messages to justify LLM call

      // Use local extraction first (free, no LLM), then LLM for remaining
      const { extractDossierFields: llmExtract } = await import('./llm.js');
      const { localDossierExtraction } = await import('./llm.js');

      // Step 1: Local regex extraction (always, no cost)
      const localResult = localDossierExtraction(newMessages.map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })));
      for (const [field, value] of Object.entries(localResult)) {
        await setAutoExtractedField(contactId, platform as Platform, field, value, 'local-pattern');
      }

      // Step 2: LLM extraction only if enough new content and LLM enabled
      const rateSettings = await getLLMRateSettings();
      if (rateSettings.enableDossierExtract && newMessages.length >= 5) {
        const contactName = contactId.replace(/^[a-z]+:/, '').slice(0, 10);
        const extracted = await llmExtract(
          newMessages.map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })),
          contactName, existing,
        );
        for (const [field, value] of Object.entries(extracted)) {
          await setAutoExtractedField(contactId, platform as Platform, field, value, 'llm-extraction');
        }
        if (Object.keys(extracted).length) {
          console.log(`${LOG} Auto-extracted ${Object.keys(extracted).length} dossier fields for ${contactId} (${Object.keys(localResult).length} local + ${Object.keys(extracted).length} LLM)`);
        }
      } else if (Object.keys(localResult).length) {
        console.log(`${LOG} Local-extracted ${Object.keys(localResult).length} dossier fields for ${contactId}`);
      }
    } catch (err) {
      console.warn(`${LOG} Dossier extraction failed for ${contactId}:`, err);
    }

      // Small delay between contacts to avoid API spam
      if (dossierExtractionQueue.size > 0) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } // end while
  } finally {
    dossierProcessing = false;
  }
}

// ── Contact Upsert Deduplication ────────────────────────────────────────────
// Track recently-upserted contacts to skip redundant PouchDB writes.
// Key: contactId, Value: hash of relevant fields + timestamp
// A contact is only written to PouchDB if its data has changed since the
// last write, OR if 60+ seconds have passed (to catch metadata drift).
const recentContactUpserts = new Map<string, { hash: string; time: number }>();

function contactHash(c: UnifiedContact): string {
  // Quick hash of the fields that matter — if these haven't changed,
  // the PouchDB write would be a no-op anyway
  return `${c.displayName}|${c.avatarUrl}|${JSON.stringify(c.metadata || {}).slice(0, 200)}`;
}

// Throttle CONTACTS_UPDATED notifications to at most once per 10 seconds
let lastContactsNotify = 0;
let contactsNotifyTimer: ReturnType<typeof setTimeout> | null = null;

async function handleIncomingContacts(contacts: UnifiedContact[]): Promise<void> {
  // Filter: skip empty contacts and recently-written identical data
  const toWrite: UnifiedContact[] = [];
  for (const c of contacts) {
    if (!c.displayName && !c.avatarUrl && (!c.metadata || Object.keys(c.metadata).length === 0)) {
      continue;
    }
    const id = `${c.platform}:${c.platformUserId}`;
    const hash = contactHash(c);
    const recent = recentContactUpserts.get(id);
    if (recent && recent.hash === hash && (Date.now() - recent.time) < 60_000) {
      continue;
    }
    toWrite.push(c);
  }

  // Batch write: 1 allDocs + 1 bulkDocs instead of N sequential get+put
  if (toWrite.length) {
    await upsertContacts(toWrite);
    const now = Date.now();
    for (const c of toWrite) {
      const id = `${c.platform}:${c.platformUserId}`;
      recentContactUpserts.set(id, { hash: contactHash(c), time: now });
    }
  }

  // Cap the dedup cache
  if (recentContactUpserts.size > 500) {
    const oldest = [...recentContactUpserts.entries()].sort((a, b) => a[1].time - b[1].time).slice(0, 200);
    for (const [k] of oldest) recentContactUpserts.delete(k);
  }

  // Debounced notification
  const now = Date.now();
  if (now - lastContactsNotify > 10000) {
    lastContactsNotify = now;
    chrome.runtime.sendMessage({ type: 'CONTACTS_UPDATED', count: toWrite.length }).catch(() => {});
  } else if (!contactsNotifyTimer) {
    contactsNotifyTimer = setTimeout(() => {
      contactsNotifyTimer = null;
      lastContactsNotify = Date.now();
      chrome.runtime.sendMessage({ type: 'CONTACTS_UPDATED', count: 1 }).catch(() => {});
    }, 10000);
  }
}

// ── Auto-respond with tier-based processing ─────────────────────────────────

async function processAutoResponds(): Promise<void> {
  // #8 Auto-close stale drafts older than 10 minutes
  const staleDrafts = await getDraftAutoResponds();
  for (const d of staleDrafts) {
    const age = Date.now() - new Date(d.updatedAt || d.createdAt).getTime();
    if (age > 10 * 60_000) {
      await updateAutoRespondStatus(d._id, 'rejected', { error: 'expired' });
      console.log(`${LOG} Auto-closed stale draft for ${d.contactId} (age: ${Math.round(age / 60_000)}m)`);
    }
  }

  // Process pending (newly queued)
  const pending = await getPendingAutoResponds();
  for (const entry of pending) {
    try {
      await updateAutoRespondStatus(entry._id, 'generating');
      const messages = await getMessagesByContact(entry.contactId, { limit: 30 });
      const meta = await getThreadMeta(entry.contactId);
      const settings: AutoRespondSettings = meta?.autoRespondSettings || {} as any;
      const contactName = meta?.alias || entry.contactId.replace(/^[a-z]+:/, '').slice(0, 10);

      const result = await generateAutoResponse(
        messages.map(m => ({ direction: m.direction, body: m.body, timestamp: m.timestamp })),
        contactName, entry.platform, settings,
      );

      if (result.tier === 'low') {
        // Auto-send immediately
        await updateAutoRespondStatus(entry._id, 'sending', {
          generatedResponse: result.response, tier: result.tier,
          suggestedPictureTag: result.sendPicture?.tag || '',
        });
        await sendMessageToTab(entry.platform, entry.contactId, result.response);
        if (result.sendPicture?.tag && settings.allowPictures) {
          await handlePictureSend(result.sendPicture.tag, entry.contactId, entry.platform);
        }
        await updateAutoRespondStatus(entry._id, 'sent');
        console.log(`${LOG} Auto-sent (low tier): "${result.response.slice(0, 40)}..."`);
      } else {
        // Queue as draft for approval
        await updateAutoRespondStatus(entry._id, 'draft', {
          generatedResponse: result.response, tier: result.tier,
          suggestedPictureTag: result.sendPicture?.tag || '',
        });
        // Notify user
        safeNotify(`draft-${entry._id}`, {
          type: 'basic', iconUrl: 'icons/icon-128.png',
          title: result.tier === 'high' ? 'Review required' : 'Draft response ready',
          message: `${contactName}: "${result.response.slice(0, 100)}"`,
          requireInteraction: result.tier === 'high',
        });
        chrome.runtime.sendMessage({ type: 'DRAFTS_UPDATED' }).catch(() => {})
        console.log(`${LOG} Draft created (${result.tier} tier): "${result.response.slice(0, 40)}..."`);
      }
    } catch (err) {
      console.error(`${LOG} Auto-respond failed:`, err);
      await updateAutoRespondStatus(entry._id, 'failed', { error: (err as Error).message });
    }
  }

  // Process approved drafts
  const approved = await getApprovedAutoResponds();
  for (const entry of approved) {
    try {
      await updateAutoRespondStatus(entry._id, 'sending');
      await sendMessageToTab(entry.platform, entry.contactId, entry.generatedResponse);
      if (entry.suggestedPictureTag) {
        const meta = await getThreadMeta(entry.contactId);
        if (meta?.autoRespondSettings?.allowPictures) {
          await handlePictureSend(entry.suggestedPictureTag, entry.contactId, entry.platform);
        }
      }
      await updateAutoRespondStatus(entry._id, 'sent');
    } catch (err) {
      await updateAutoRespondStatus(entry._id, 'failed', { error: (err as Error).message });
    }
  }
}

async function handlePictureSend(tag: string, contactId: string, platform: string): Promise<void> {
  const pic = await getPictureByTag(tag);
  if (!pic) { console.log(`${LOG} No picture found for tag: ${tag}`); return; }
  await incrementPictureStat(pic._id, 'sentCount');
  console.log(`${LOG} Picture sent: ${pic.label || pic.tag} (sent: ${pic.sentCount + 1})`);
  // TODO: actual picture sending via platform API/DOM — for now just tracks the stat
}

// ── Block rules ─────────────────────────────────────────────────────────────

async function runBlockRules(newMessages: UnifiedMessage[]): Promise<void> {
  const rules = await getAllBlockRules();
  if (!rules.length) return;

  const contactIds = new Set(newMessages.filter(m => m.direction === 'in').map(m => m.contactId));
  for (const contactId of contactIds) {
    const messages = await getMessagesByContact(contactId, { limit: 50 });
    const meta = await getThreadMeta(contactId);
    const actions = evaluateRules(rules, messages, meta);
    for (const { rule, action } of actions) {
      console.log(`${LOG} Block rule "${rule.name}" triggered for ${contactId} → ${action}`);
      await executeAction(contactId, newMessages[0].platform, action, rule._id);
    }
  }
}

// ── Navigation + messaging ──────────────────────────────────────────────────

async function navigateToConversation(platform: string, contactId: string): Promise<void> {
  const urlFn = PLATFORM_URLS[platform]; if (!urlFn) return;
  const url = urlFn(contactId);
  const tabs = await chrome.tabs.query({});
  const host = new URL(url).hostname;
  const tab = tabs.find(t => { try { return t.url && new URL(t.url).hostname === host; } catch { return false; } });

  if (tab?.id) {
    // SPA navigation: send message to content script to navigate internally
    // This avoids a full page refresh on SPAs like Sniffies and Grindr
    const path = new URL(url).pathname + new URL(url).search;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SPA_NAVIGATE', url, path });
    } catch {
      // Content script not ready — fall back to full navigation
      await chrome.tabs.update(tab.id, { url });
    }
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function sendMessageToTab(platform: string, contactId: string, text: string): Promise<void> {
  console.log(`${LOG} Sending to ${contactId}: "${text.slice(0, 50)}..."`);
  const urlFn = PLATFORM_URLS[platform]; if (!urlFn) return;
  const url = urlFn(contactId);
  const tabs = await chrome.tabs.query({});
  const host = new URL(url).hostname;
  const tab = tabs.find(t => { try { return t.url && new URL(t.url).hostname === host; } catch { return false; } });
  const targetId = tab?.id ? (await chrome.tabs.update(tab.id, { url, active: true }), tab.id) : (await chrome.tabs.create({ url })).id;
  if (targetId) {
    setTimeout(() => {
      chrome.tabs.sendMessage(targetId, { type: 'SEND_AUTO_RESPONSE', text, contactId }).catch(() => {});
    }, tab?.id ? 3000 : 5000);
  }
}

// ── Alarms + reminders ──────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // keepalive removed — was causing CPU overhead
  if (alarm.name === 'badge-refresh') await updateBadgeCount().catch(() => {});
  if (alarm.name === 'auto-respond-check') await processAutoResponds().catch(e => console.error(`${LOG} AR error:`, e));
  if (alarm.name === 'reminder-check') await processReminders().catch(e => console.error(`${LOG} Reminder error:`, e));
  if (alarm.name === 'task-sync') {
    // Auto-sync tasks with Google Tasks every 5 minutes (only if authenticated)
    try {
      const authed = await isGoogleAuthenticated();
      if (authed) {
        const result = await syncGoogleTasks();
        if (result.pulled + result.pushed + result.deleted > 0) {
          console.log(`${LOG} Task sync: pulled=${result.pulled} pushed=${result.pushed} deleted=${result.deleted}`);
        }
      }
    } catch (e) { console.warn(`${LOG} Task sync error:`, e); }
  }
  if (alarm.name === 'block-rule-check') {
    // Periodic block rule evaluation across all active threads
    try {
      const rules = await getAllBlockRules();
      if (!rules.length) return;
      const summaries = await getThreadSummaries({});
      for (const s of summaries) {
        const messages = await getMessagesByContact(s.contactId, { limit: 50 });
        const meta = await getThreadMeta(s.contactId);
        const actions = evaluateRules(rules, messages, meta);
        for (const { rule, action } of actions) {
          console.log(`${LOG} Periodic block rule "${rule.name}" → ${action} on ${s.contactId}`);
          await executeAction(s.contactId, s.platform, action, rule._id);
        }
      }
    } catch {}
  }
});

async function processReminders(): Promise<void> {
  const reminders = await getReminders({ upcoming: true });
  const now = Date.now();
  for (const r of reminders) {
    const due = new Date(r.dueAt).getTime();
    if (!r.notifiedApproach && (due - now) <= 20 * 60_000 && (due - now) > 0) {
      safeNotify(`rem-a-${r._id}`, { type: 'basic', iconUrl: 'icons/icon-128.png', title: 'Reminder approaching', message: `${r.note} — ${Math.round((due - now) / 60_000)} min` });
      await markReminderNotified(r._id, 'approach');
    }
    if (!r.notifiedDue && due <= now) {
      safeNotify(`rem-d-${r._id}`, { type: 'basic', iconUrl: 'icons/icon-128.png', title: 'Reminder', message: r.note });
      await markReminderNotified(r._id, 'due');
    }
  }
}

async function updateBadgeCount(): Promise<void> {
  try {
    const count = await getUnreadCount();
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF6B6B' });
  } catch {}
}

updateBadgeCount().catch(() => {});
chrome.alarms.create('badge-refresh', { periodInMinutes: 1 });
chrome.alarms.create('reminder-check', { periodInMinutes: 0.25 });
// Removed 25s keepalive alarm — was causing unnecessary CPU usage

// Ensure Global Chat contact always exists (runs on every SW startup)
upsertContact({
  id: 'sniffies:global-chat',
  platform: 'sniffies',
  platformUserId: 'global-chat',
  displayName: '🌐 Global Chat',
  profileUrl: 'https://sniffies.com/global-chat',
  avatarUrl: '',
  lastSeen: new Date().toISOString(),
  metadata: { isGlobalChat: true },
}).catch(() => {});

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Right-click context menu ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'open-settings', title: 'Settings', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'open-all-sites', title: 'Open all sites', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'sync-pics', title: 'Sync profile pictures', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'sep1', type: 'separator', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'toggle-autorespond', title: 'Toggle auto-respond all', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'sep2', type: 'separator', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'open-archive', title: 'View archive', contexts: ['action'] });

  // Seed the Global Chat contact so it always appears in the inbox
  upsertContact({
    id: 'sniffies:global-chat',
    platform: 'sniffies',
    platformUserId: 'global-chat',
    displayName: '🌐 Global Chat',
    profileUrl: 'https://sniffies.com/global-chat',
    avatarUrl: '',
    lastSeen: new Date().toISOString(),
    metadata: { isGlobalChat: true },
  }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  switch (info.menuItemId) {
    case 'open-settings':
      chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
      break;
    case 'open-all-sites':
      await openAllSites();
      break;
    case 'sync-pics': {
      const allTabs = await chrome.tabs.query({});
      const platformHosts = ['sniffies.com', 'web.grindr.com', 'doublelist.com', 'adam4adam.com'];
      for (const tab of allTabs) {
        if (!tab.id || !tab.url) continue;
        if (platformHosts.some(h => tab.url!.includes(h))) {
          chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_AVATARS' }).catch(() => {});
        }
      }
      break;
    }
    case 'toggle-autorespond': {
      const data = await chrome.storage.local.get('aggregaytor_global_autorespond');
      const newState = !data.aggregaytor_global_autorespond;
      await chrome.storage.local.set({ aggregaytor_global_autorespond: newState });
      // Toggle on all threads (except global chat — it's a broadcast feed)
      const summRes = await getThreadSummaries({});
      for (const s of summRes) {
        if (s.contactId.endsWith(':global-chat')) continue;
        await upsertThreadMeta(s.contactId, s.platform, { autoRespondEnabled: newState });
      }
      safeNotify('ar-toggle', {
        type: 'basic', iconUrl: 'icons/icon-128.png',
        title: 'Auto-respond', message: newState ? 'Enabled for all conversations' : 'Disabled',
      });
      break;
    }
    case 'open-archive':
      // Open side panel — the user can click the archive tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
      break;
  }
});

// ── Open all sites ──────────────────────────────────────────────────────────

const ALL_SITES = [
  'https://sniffies.com',
  'https://web.grindr.com',
  'https://doublelist.com',
  'https://www.adam4adam.com/mailbox',
  'https://mail.google.com',
];

async function openAllSites(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const siteUrl of ALL_SITES) {
    const host = new URL(siteUrl).hostname;
    const existing = tabs.find(t => { try { return t.url && new URL(t.url).hostname === host; } catch { return false; } });
    if (existing?.id) {
      // Already open — just make sure it's not stale
      await chrome.tabs.update(existing.id, { active: false });
    } else {
      await chrome.tabs.create({ url: siteUrl, active: false });
    }
  }
}

// ── Grindr auto-relogin check ───────────────────────────────────────────────

chrome.alarms.create('grindr-login-check', { periodInMinutes: 2 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'grindr-login-check') return;
  try {
    const tabs = await chrome.tabs.query({});
    const grindrTab = tabs.find(t => t.url?.includes('web.grindr.com'));
    if (!grindrTab?.id) return;

    // Check if Grindr is showing login page
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: grindrTab.id },
      func: () => {
        // Grindr shows a login page with specific elements when logged out
        const isLoginPage = !!document.querySelector('[data-testid="login-button"], .login-page, button[aria-label="Sign in"], [class*="login"]')
          || document.title.toLowerCase().includes('login')
          || document.title.toLowerCase().includes('sign in');
        return { isLoginPage, url: location.href };
      },
    });

    if (result?.result?.isLoginPage) {
      console.log(`${LOG} Grindr logged out detected, attempting relogin...`);
      safeNotify('grindr-relogin', {
        type: 'basic', iconUrl: 'icons/icon-128.png',
        title: 'Grindr logged out',
        message: 'Attempting to log back in via Apple Sign-In...',
        requireInteraction: true,
      });

      // Try clicking the Apple Sign-In button
      await chrome.scripting.executeScript({
        target: { tabId: grindrTab.id },
        func: () => {
          // Look for Apple sign-in button
          const appleBtn = document.querySelector<HTMLElement>(
            'button[data-testid="apple-login"], [aria-label*="Apple"], [class*="apple"], button:has(svg[class*="apple"])'
          );
          if (appleBtn) {
            appleBtn.click();
            return 'clicked';
          }
          // Fallback: look for any "Sign in" or "Log in" button and click it first
          const signInBtn = document.querySelector<HTMLElement>(
            'button[data-testid="login-button"], button:has(span:text("Sign in")), a[href*="login"]'
          );
          if (signInBtn) signInBtn.click();
          return 'no-apple-button';
        },
      });
    }
  } catch (err) {
    // Tab might not be accessible (e.g., chrome:// page)
  }
});
chrome.alarms.create('block-rule-check', { periodInMinutes: 5 });
chrome.alarms.create('task-sync', { periodInMinutes: 5 });
console.log(`${LOG} Service worker ready`);
