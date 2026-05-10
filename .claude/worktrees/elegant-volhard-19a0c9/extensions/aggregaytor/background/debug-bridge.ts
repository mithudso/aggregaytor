/**
 * debug-bridge.ts — WebSocket bridge for MCP debug server.
 *
 * Exposes extension internals to the MCP server via WebSocket on port 9222.
 * Only active when debug mode is enabled in settings.
 *
 * Since service workers can't run a WebSocket server, this uses a
 * chrome.runtime.connectNative or polling approach instead.
 * Alternative: the debug server connects via chrome.debugger API.
 *
 * For now, we expose a REST-like message handler that the MCP server
 * can call via chrome.runtime.sendMessage from a companion extension,
 * or via the existing message passing system.
 */

import {
  getDB, getThreadSummaries, getMessagesByContact, getAllContacts,
  getThreadMeta, getAllThreadMeta, getDossier, getUnreadCount,
} from '@aggregaytor/store';
import { getLLMConfig, getLLMRateSettings, getLLMQueueStatus } from './llm.js';

const LOG = '[Aggregaytor:Debug]';

export async function handleDebugCommand(type: string, params: Record<string, any> = {}): Promise<any> {
  switch (type) {
    case 'query_messages': {
      const db = await getDB();
      const selector: Record<string, any> = { docType: 'message' };
      if (params.contactId) selector.contactId = params.contactId;
      if (params.platform) selector.platform = params.platform;
      const result = await db.find({ selector, limit: params.limit || 20 });
      let docs = result.docs as any[];
      if (params.search) {
        const q = params.search.toLowerCase();
        docs = docs.filter((d: any) => d.body?.toLowerCase().includes(q));
      }
      return { count: docs.length, messages: docs.slice(0, params.limit || 20) };
    }

    case 'query_contacts': {
      let contacts = await getAllContacts();
      if (params.platform) contacts = contacts.filter(c => c.platform === params.platform);
      if (params.search) {
        const q = params.search.toLowerCase();
        contacts = contacts.filter(c => c.displayName?.toLowerCase().includes(q));
      }
      return { count: contacts.length, contacts };
    }

    case 'query_threads': {
      const summaries = await getThreadSummaries(params.platform ? { platform: params.platform } : {});
      return { count: summaries.length, threads: summaries.slice(0, params.limit || 50) };
    }

    case 'get_thread_meta': {
      const meta = await getThreadMeta(params.contactId);
      return meta || { error: 'No metadata found for this contact' };
    }

    case 'get_dossier': {
      const dossier = await getDossier(params.contactId);
      return dossier || { error: 'No dossier found for this contact' };
    }

    case 'get_extension_status': {
      const db = await getDB();
      const info = await db.info();
      const unread = await getUnreadCount();
      const allMeta = await getAllThreadMeta();
      const llmConfig = await getLLMConfig();
      const llmQueue = getLLMQueueStatus();

      return {
        database: { name: info.db_name, docCount: info.doc_count, updateSeq: info.update_seq },
        unreadCount: unread,
        threadMetaCount: allMeta.length,
        archivedCount: allMeta.filter(m => m.archived).length,
        autoRespondCount: allMeta.filter(m => m.autoRespondEnabled).length,
        favoritedCount: allMeta.filter(m => m.favorited).length,
        llmProvider: llmConfig.provider,
        llmQueue,
      };
    }

    case 'get_llm_status': {
      const config = await getLLMConfig();
      const rateSettings = await getLLMRateSettings();
      const queueStatus = getLLMQueueStatus();
      return { config: { provider: config.provider, model: config.model }, rateSettings, queueStatus };
    }

    case 'trigger_action': {
      const { action: act, params: p } = params;
      switch (act) {
        case 'set_log_level':
          await chrome.storage.local.set({ aggregaytor_log_level: p?.level || 'debug' });
          return { ok: true, level: p?.level };
        default:
          return { error: `Unknown action: ${act}` };
      }
    }

    case 'execute_query': {
      const db = await getDB();
      const result = await db.find({ selector: params.selector, limit: params.limit || 50 });
      return { count: result.docs.length, docs: result.docs };
    }

    case 'get_service_worker_logs': {
      // Service worker logs aren't persisted — return a note
      return { note: 'Service worker logs are only visible in chrome://extensions → service worker inspector. Set log level to debug for more output.' };
    }

    default:
      return { error: `Unknown debug command: ${type}` };
  }
}
