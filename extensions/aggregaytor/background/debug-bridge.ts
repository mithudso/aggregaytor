/**
 * debug-bridge.ts — read-mostly introspection surface for the MCP debug server.
 *
 * Since service workers can't run a WebSocket server, there is no socket here:
 * the commands below are reached through the normal message-passing system, via
 * the service worker's `DEBUG_COMMAND` case.
 *
 * SECURITY — this surface IS gated by `authorizeDebugCommand` (called from the
 * service worker's `DEBUG_COMMAND` case before any handler runs):
 *
 * 1. Sender-origin check (primary): only the extension's own pages — service
 *    worker, side panel, popup — are trusted (`sender.id === chrome.runtime.id`
 *    and no `sender.tab`). Content scripts always have `sender.tab` set and are
 *    refused unconditionally; so are external extensions and web pages. This is
 *    the real gate: no token can rescue a tab/content-script sender.
 * 2. Shared-secret token (optional extra guard): if `aggregaytor_debug_token`
 *    is set in `chrome.storage.local` (set it manually; nothing in the codebase
 *    generates or persists it), trusted senders must ALSO supply a matching
 *    `debugToken` on the message. A stored token shorter than 16 chars is
 *    treated as misconfigured and fails closed (everything refused). When the
 *    key is unset (the default), the origin check alone governs, so the
 *    extension's own pages keep working without wiring a token through.
 *
 * Handlers stay read-only + bounded (clamped limits, plain-object selector
 * checks) as defense in depth behind the gate.
 */

import {
  getDB, getThreadSummaries, getMessagesByContact, getAllContacts,
  getThreadMeta, getAllThreadMeta, getDossier, getUnreadCount,
} from '@aggregaytor/store';
import { getLLMConfig, getLLMRateSettings, getLLMQueueStatus } from './llm.js';

const LOG = '[Aggregaytor:Debug]';

/** Storage key holding the optional shared-secret debug token (set manually). */
const DEBUG_TOKEN_KEY = 'aggregaytor_debug_token';
/** Minimum length for a stored token to count as valid configuration. */
const MIN_DEBUG_TOKEN_LENGTH = 16;

// Warn at most once per SW lifetime so a probing content script can't spam
// the log. Never include the supplied or stored token in the message.
let warnedRefusal = false;

/**
 * Decide whether a DEBUG_COMMAND message may run. See the module docstring
 * for the full policy. Rule: allow iff the sender is the extension itself
 * (`sender.id === chrome.runtime.id` and no `sender.tab`); refuse every
 * tab/content-script or external sender regardless of any token. If a stored
 * token exists, trusted senders must additionally present it.
 *
 * This is deliberately not a hot path (debug commands are rare), so the token
 * is read via `chrome.storage.local.get` directly rather than the settings
 * cache; a read failure fails closed.
 */
export async function authorizeDebugCommand(
  sender: chrome.runtime.MessageSender | undefined,
  suppliedToken: unknown,
): Promise<boolean> {
  // Primary gate: sender must be the extension's own pages/worker. Content
  // scripts have `sender.tab` set; external extensions have a different id.
  const originTrusted = !!sender && sender.id === chrome.runtime.id && !sender.tab;
  if (!originTrusted) {
    if (!warnedRefusal) {
      warnedRefusal = true;
      console.warn(`${LOG} DEBUG_COMMAND refused: sender is not a trusted extension page (content-script/tab and external senders are never allowed).`);
    }
    return false;
  }

  // Secondary gate: only enforced when a token has been set manually. Read
  // defensively — unset/empty means "no token configured", which leaves the
  // origin check as the sole gate so the extension's own pages keep working.
  let storedToken: unknown;
  try {
    const data = await chrome.storage.local.get(DEBUG_TOKEN_KEY);
    storedToken = data?.[DEBUG_TOKEN_KEY];
  } catch {
    // Storage unreadable — fail closed rather than guessing.
    if (!warnedRefusal) {
      warnedRefusal = true;
      console.warn(`${LOG} DEBUG_COMMAND refused: debug-token storage read failed.`);
    }
    return false;
  }
  if (typeof storedToken !== 'string' || storedToken.length === 0) return true;

  // A token is configured: it must be sane and the caller must match it.
  const ok =
    storedToken.length >= MIN_DEBUG_TOKEN_LENGTH &&
    typeof suppliedToken === 'string' &&
    suppliedToken.length === storedToken.length &&
    suppliedToken === storedToken;
  if (!ok && !warnedRefusal) {
    warnedRefusal = true;
    console.warn(`${LOG} DEBUG_COMMAND refused: debug token missing, too short (<${MIN_DEBUG_TOKEN_LENGTH} chars stored), or mismatched.`);
  }
  return ok;
}

/**
 * Clamp a caller-supplied `limit` into a sane range. Callers reach this module
 * through an untrusted message boundary, so an unbounded `limit` would let a
 * single command pull the entire corpus into the service worker's heap.
 */
const MAX_DEBUG_LIMIT = 500;
function clampLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_DEBUG_LIMIT);
}

export async function handleDebugCommand(type: string, params: Record<string, any> = {}): Promise<any> {
  switch (type) {
    case 'query_messages': {
      const db = await getDB();
      const limit = clampLimit(params.limit, 20);
      const selector: Record<string, any> = { docType: 'message' };
      if (params.contactId) selector.contactId = params.contactId;
      if (params.platform) selector.platform = params.platform;
      const result = await db.find({ selector, limit });
      let docs = result.docs as any[];
      if (params.search) {
        const q = String(params.search).toLowerCase();
        docs = docs.filter((d: any) => d.body?.toLowerCase().includes(q));
      }
      return { count: docs.length, messages: docs.slice(0, limit) };
    }

    case 'query_contacts': {
      const limit = clampLimit(params.limit, MAX_DEBUG_LIMIT);
      let contacts = await getAllContacts();
      if (params.platform) contacts = contacts.filter(c => c.platform === params.platform);
      if (params.search) {
        const q = String(params.search).toLowerCase();
        contacts = contacts.filter(c => c.displayName?.toLowerCase().includes(q));
      }
      return { count: contacts.length, contacts: contacts.slice(0, limit) };
    }

    case 'query_threads': {
      const summaries = await getThreadSummaries(params.platform ? { platform: params.platform } : {});
      return { count: summaries.length, threads: summaries.slice(0, clampLimit(params.limit, 50)) };
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
      // `selector` crosses an untrusted boundary — reject anything that isn't a
      // plain object so a string/array can't reach PouchDB's query planner.
      const selector = params.selector;
      if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
        console.warn(`${LOG} execute_query rejected: selector was ${Array.isArray(selector) ? 'an array' : typeof selector}`);
        return { error: 'execute_query requires a plain-object selector' };
      }
      const db = await getDB();
      const result = await db.find({ selector, limit: clampLimit(params.limit, 50) });
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
