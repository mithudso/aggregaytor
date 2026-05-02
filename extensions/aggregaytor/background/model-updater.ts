/**
 * model-updater.ts — periodic auto-discovery of newer LLM model versions.
 *
 * v0.57.54: every provider periodically retires old model snapshots and
 * publishes new ones (gemini-2.5 → gemini-3.1, claude-haiku-4-5 → 5-0,
 * gpt-4o-mini → gpt-5-mini, llama-3.1 → llama-4 → llama-4.1, etc).
 * Without auto-discovery the user is stuck on whatever was the latest
 * when the extension shipped, and our hardcoded DEFAULT_MODELS in llm.ts
 * goes stale.
 *
 * Design:
 *   1. For each provider where the user has a usable API key, GET that
 *      provider's /models endpoint. (Cerebras, Groq use the OpenAI
 *      schema; Gemini, Anthropic, OpenAI, Mistral, Perplexity each have
 *      slightly different shapes — handled in extractModels().)
 *   2. Apply a per-provider FAMILY_PATTERN to the returned id list. We
 *      track only "newer than what we ship" — i.e. same family / tier
 *      as the existing DEFAULT_MODELS entry. Family rank is a numeric
 *      score derived from the version digits in the model id.
 *   3. If the highest-ranked model differs from the user's current
 *      configured model AND from our default fallback, surface it as
 *      a suggestion. The user (or the auto-apply toggle) can adopt it.
 *
 * Persisted state: chrome.storage.local key 'aggregaytor_model_updater_v1'
 *   { lastCheckAt, autoApply, suggestions: [{ provider, current, suggested,
 *     reason, foundAt }], lastError }
 */

const STATE_KEY = 'aggregaytor_model_updater_v1';

export interface ModelSuggestion {
  provider: string;
  current: string;        // what the user / default is using now
  suggested: string;      // newer model id we found
  reason: string;         // human-readable explanation
  foundAt: number;        // epoch ms when we discovered it
  applied?: boolean;      // true once the user (or auto) accepts it
}

export interface ModelUpdaterState {
  lastCheckAt: number;
  autoApply: boolean;
  suggestions: ModelSuggestion[];
  lastError: string;
}

const DEFAULT_STATE: ModelUpdaterState = {
  lastCheckAt: 0,
  autoApply: false,
  suggestions: [],
  lastError: '',
};

export async function getUpdaterState(): Promise<ModelUpdaterState> {
  try {
    const got = await chrome.storage.local.get(STATE_KEY);
    const stored = got?.[STATE_KEY];
    if (stored && typeof stored === 'object') {
      return { ...DEFAULT_STATE, ...stored };
    }
  } catch {}
  return { ...DEFAULT_STATE };
}

export async function saveUpdaterState(state: ModelUpdaterState): Promise<void> {
  try { await chrome.storage.local.set({ [STATE_KEY]: state }); } catch {}
}

// ── Per-provider family preferences ────────────────────────────────────────
//
// The pattern matches model ids that belong to the same "tier" (cheap +
// fast, in our default config). The rank function turns the matched id
// into a comparable number — higher = newer / better. We pick the highest-
// ranked candidate from each provider's published list.

interface FamilyRule {
  pattern: RegExp;
  rank: (id: string) => number;
}

const FAMILY_RULES: Record<string, FamilyRule> = {
  // Gemini: prefer flash-lite > flash. Version derived from "X.Y" segment.
  gemini: {
    pattern: /^(?:models\/)?gemini-(\d+)\.(\d+)(?:[.-](?:flash-lite(?:-preview)?|flash))(?:-\d+)?$/i,
    rank: (id) => {
      const m = id.match(/gemini-(\d+)\.(\d+)/);
      if (!m) return 0;
      const major = parseInt(m[1], 10) * 100;
      const minor = parseInt(m[2], 10);
      // flash-lite is preferred over flash by a sub-rank tweak
      const liteBonus = /flash-lite/i.test(id) ? 10 : 0;
      // Stable releases beat preview tag
      const previewPenalty = /preview/i.test(id) ? -1 : 0;
      return major + minor + liteBonus + previewPenalty;
    },
  },
  // Anthropic: prefer haiku family. Version is the 'X-Y' or 'X' segment.
  anthropic: {
    pattern: /^claude-(?:haiku|sonnet)-(\d+)(?:-(\d+))?(?:-(\d{8}))?$/i,
    rank: (id) => {
      const m = id.match(/claude-(haiku|sonnet)-(\d+)(?:-(\d+))?(?:-(\d{8}))?/i);
      if (!m) return 0;
      const tier = m[1].toLowerCase() === 'haiku' ? 1000 : 100; // prefer haiku for the cheap tier
      const major = parseInt(m[2], 10) * 100;
      const minor = m[3] ? parseInt(m[3], 10) : 0;
      const date = m[4] ? parseInt(m[4], 10) / 1e8 : 0;
      return tier + major + minor + date;
    },
  },
  // OpenAI: prefer mini variants. e.g. gpt-4o-mini, gpt-5-mini, gpt-5.1-mini.
  openai: {
    pattern: /^gpt-(\d+(?:\.\d+)?(?:o)?)-mini(?:-\d{4}-\d{2}-\d{2})?$/i,
    rank: (id) => {
      const m = id.match(/gpt-(\d+(?:\.\d+)?)/);
      if (!m) return 0;
      // 4o counts as 4, 5 counts as 5, 5.1 as 5.1
      const ver = parseFloat(m[1].replace('o', ''));
      return ver * 100;
    },
  },
  // Groq: Llama family. Currently default is llama-3.1-8b-instant.
  groq: {
    pattern: /^llama-(\d+(?:\.\d+)?)-(\d+)b-(?:instant|fast|flash)$/i,
    rank: (id) => {
      const m = id.match(/llama-(\d+(?:\.\d+)?)-(\d+)b/i);
      if (!m) return 0;
      const ver = parseFloat(m[1]) * 100;
      const params = parseInt(m[2], 10); // higher param count = better
      return ver + params * 0.01;
    },
  },
  // Cerebras: Llama family.
  cerebras: {
    pattern: /^llama-?(\d+(?:\.\d+)?)?-?(?:scout|maverick|hermes|fast)/i,
    rank: (id) => {
      const m = id.match(/llama-?(\d+(?:\.\d+)?)/i);
      if (!m) return 0;
      return parseFloat(m[1]) * 100;
    },
  },
  // Mistral: Latest tags often suffix '-latest'; prefer them, fall back to
  // small/large with version digits.
  mistral: {
    pattern: /^mistral-(?:small|large)-(?:latest|\d{4})/i,
    rank: (id) => {
      if (/-latest$/i.test(id)) return 10000;
      const m = id.match(/(\d{4})/);
      return m ? parseInt(m[1], 10) : 0;
    },
  },
};

// ── Per-provider /models endpoint + auth + JSON shape ─────────────────────

interface ProviderEndpoint {
  url: (apiKey: string) => string;
  headers?: (apiKey: string) => Record<string, string>;
  extract: (json: any) => string[];
}

const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoint> = {
  gemini: {
    url: (k) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`,
    extract: (j) => Array.isArray(j?.models)
      ? (j.models as any[]).map(m => String(m.name || m.id || '').replace(/^models\//, ''))
      : [],
  },
  openai: {
    url: () => 'https://api.openai.com/v1/models',
    headers: (k) => ({ 'Authorization': `Bearer ${k}` }),
    extract: (j) => Array.isArray(j?.data) ? (j.data as any[]).map(m => String(m.id || '')) : [],
  },
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/models',
    headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
    extract: (j) => Array.isArray(j?.data) ? (j.data as any[]).map(m => String(m.id || '')) : [],
  },
  groq: {
    url: () => 'https://api.groq.com/openai/v1/models',
    headers: (k) => ({ 'Authorization': `Bearer ${k}` }),
    extract: (j) => Array.isArray(j?.data) ? (j.data as any[]).map(m => String(m.id || '')) : [],
  },
  cerebras: {
    url: () => 'https://api.cerebras.ai/v1/models',
    headers: (k) => ({ 'Authorization': `Bearer ${k}` }),
    extract: (j) => Array.isArray(j?.data) ? (j.data as any[]).map(m => String(m.id || '')) : [],
  },
  mistral: {
    url: () => 'https://api.mistral.ai/v1/models',
    headers: (k) => ({ 'Authorization': `Bearer ${k}` }),
    extract: (j) => Array.isArray(j?.data) ? (j.data as any[]).map(m => String(m.id || '')) : [],
  },
};

/**
 * Check a single provider for newer models. Returns the best candidate or
 * null if nothing exceeds the current model's family rank.
 */
async function checkProvider(
  provider: string,
  apiKey: string,
  currentModel: string,
): Promise<ModelSuggestion | null> {
  const ep = PROVIDER_ENDPOINTS[provider];
  const rule = FAMILY_RULES[provider];
  if (!ep || !rule) return null;

  let ids: string[] = [];
  try {
    const headers: Record<string, string> = ep.headers ? ep.headers(apiKey) : {};
    headers['Accept'] = 'application/json';
    const res = await fetch(ep.url(apiKey), { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`${provider} /models returned ${res.status}`);
    }
    const json = await res.json();
    ids = ep.extract(json);
  } catch (err) {
    // Single-provider failure shouldn't kill the whole sweep — caller
    // collects errors but still returns suggestions from successful
    // providers.
    throw err;
  }

  // Filter to family + rank
  const matching = ids.filter(id => rule.pattern.test(id));
  if (!matching.length) return null;

  const currentRank = rule.rank(currentModel);
  let best = currentModel;
  let bestRank = currentRank;
  for (const id of matching) {
    const r = rule.rank(id);
    if (r > bestRank) {
      best = id;
      bestRank = r;
    }
  }

  if (best === currentModel) return null;

  return {
    provider,
    current: currentModel,
    suggested: best,
    reason: `Family rank ${bestRank} > current ${currentRank} (matched ${matching.length} ${provider} models)`,
    foundAt: Date.now(),
  };
}

/**
 * Run a check across all providers the user has API keys for. Caller
 * supplies a getApiKey callback so this module doesn't need to know
 * about the LLMConfig schema (which lives in llm.ts).
 *
 * Returns the list of suggestions and any errors. Callers decide whether
 * to auto-apply or surface them in the UI.
 */
export async function checkAllProviders(
  getApiKey: (provider: string) => string | undefined,
  getCurrentModel: (provider: string) => string,
): Promise<{ suggestions: ModelSuggestion[]; errors: Array<{ provider: string; error: string }> }> {
  const suggestions: ModelSuggestion[] = [];
  const errors: Array<{ provider: string; error: string }> = [];
  for (const provider of Object.keys(PROVIDER_ENDPOINTS)) {
    const key = getApiKey(provider);
    if (!key) continue;
    const cur = getCurrentModel(provider);
    if (!cur) continue;
    try {
      const s = await checkProvider(provider, key, cur);
      if (s) suggestions.push(s);
    } catch (err) {
      errors.push({ provider, error: (err as Error).message });
    }
  }
  return { suggestions, errors };
}

export const MODEL_UPDATER_ALARM = 'model-updater-daily-check';
