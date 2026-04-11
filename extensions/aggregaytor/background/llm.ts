/**
 * llm.ts — Multi-provider LLM integration for context-aware responses.
 *
 * Providers (in priority order):
 *   1. Google Gemini (free tier available)
 *   2. OpenAI (GPT-4o-mini for cost efficiency)
 *   3. Anthropic Claude
 *   4. Local pattern matching fallback (no API key needed)
 */

const LOG = '[Aggregaytor:LLM]';

export type LLMProvider = 'gemini' | 'openai' | 'anthropic' | 'groq' | 'perplexity' | 'mistral' | 'copilot' | 'local';

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
}

interface Message {
  direction: 'in' | 'out';
  body: string;
  timestamp: string;
}

interface SuggestionResult {
  suggestions: string[];
  provider: LLMProvider;
  error?: string;
}

const SETTINGS_KEY = 'aggregaytor_llm_settings';
const RATE_SETTINGS_KEY = 'aggregaytor_llm_rate_settings';

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  gemini: 'gemini-2.5-flash-lite',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  groq: 'llama-3.1-8b-instant',
  perplexity: 'llama-3.1-sonar-small-128k-online',
  mistral: 'mistral-small-latest',
  copilot: 'gpt-4o-mini',
  local: 'local',
};

// Known rate limits per provider (requests per minute on free/tier-1)
// Sources: provider docs as of April 2026
const PROVIDER_RPM: Record<string, number> = {
  gemini: 15,       // Free: 15 RPM (gemini-2.5-flash-lite), gemini-2.0-flash deprecated June 2026
  openai: 500,      // Tier 1 ($5): 500 RPM. Free tier only 3 RPM.
  anthropic: 50,    // Tier 1 ($5): 50 RPM all models
  groq: 30,         // Free: 30 RPM, 14400 RPD, very fast LPU inference
  perplexity: 50,   // Tier 0: 50 RPM (pay-as-you-go, no free tier)
  mistral: 2,       // Free "Experiment": 2 RPM (paid tiers much higher)
  copilot: 10,      // No public API — community proxy only, rate undisclosed
};

// Per-provider request tracking for proactive cycling
const providerRequestCounts = new Map<string, number[]>();

function getProviderRPMUsed(provider: string): number {
  const now = Date.now();
  const timestamps = providerRequestCounts.get(provider) || [];
  const recent = timestamps.filter(t => now - t < 60_000);
  providerRequestCounts.set(provider, recent);
  return recent.length;
}

function recordProviderRequest(provider: string): void {
  const timestamps = providerRequestCounts.get(provider) || [];
  timestamps.push(Date.now());
  providerRequestCounts.set(provider, timestamps);
}

function isProviderNearLimit(provider: string): boolean {
  const limit = PROVIDER_RPM[provider] || 10;
  const used = getProviderRPMUsed(provider);
  return used >= limit - 1; // leave 1 request buffer
}

/**
 * Get the best available provider — cycles proactively before hitting rate limits.
 */
async function getBestProvider(): Promise<LLMConfig> {
  const primary = await getLLMConfig();
  if (primary.provider === 'local' || !primary.apiKey) return primary;

  // If primary is near its limit, try alternatives
  if (!isProviderNearLimit(primary.provider)) return primary;

  console.log(`${LOG} ${primary.provider} near rate limit (${getProviderRPMUsed(primary.provider)}/${PROVIDER_RPM[primary.provider] || '?'} RPM), cycling...`);

  const keys = await getAllProviderKeys();
  // Also include the primary key
  keys[primary.provider] = primary.apiKey;

  // Try providers in order of remaining capacity
  const candidates = Object.entries(keys)
    .filter(([p, k]) => k && p !== 'local')
    .map(([p, k]) => ({ provider: p as LLMProvider, apiKey: k, headroom: (PROVIDER_RPM[p] || 10) - getProviderRPMUsed(p) }))
    .filter(c => c.headroom > 0)
    .sort((a, b) => b.headroom - a.headroom);

  if (candidates.length) {
    const best = candidates[0];
    console.log(`${LOG} Cycling to ${best.provider} (${best.headroom} RPM headroom)`);
    return { provider: best.provider, apiKey: best.apiKey, model: '' };
  }

  // All providers near limit — return primary anyway
  return primary;
}

// ── Rate limiting + backoff ─────────────────────────────────────────────────

export interface LLMRateSettings {
  enabled: boolean;                // master toggle for LLM calls
  maxRequestsPerMinute: number;    // 0 = unlimited
  enableAutoRespond: boolean;      // allow auto-respond LLM calls
  enableSuggestions: boolean;      // allow suggestion LLM calls
  enableDossierExtract: boolean;   // allow dossier extraction calls
  enableNicknames: boolean;        // allow nickname generation calls
  enableSummaries: boolean;        // allow conversation summary calls
}

const DEFAULT_RATE_SETTINGS: LLMRateSettings = {
  enabled: true,
  maxRequestsPerMinute: 10,
  enableAutoRespond: true,
  enableSuggestions: true,
  enableDossierExtract: true,
  enableNicknames: true,
  enableSummaries: true,
};

export async function getLLMRateSettings(): Promise<LLMRateSettings> {
  const data = await chrome.storage.local.get(RATE_SETTINGS_KEY);
  return { ...DEFAULT_RATE_SETTINGS, ...(data[RATE_SETTINGS_KEY] || {}) };
}

export async function saveLLMRateSettings(settings: Partial<LLMRateSettings>): Promise<void> {
  const existing = await getLLMRateSettings();
  await chrome.storage.local.set({ [RATE_SETTINGS_KEY]: { ...existing, ...settings } });
}

// Request queue with exponential backoff
interface QueuedRequest {
  id: string;
  execute: () => Promise<Response>;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
  retries: number;
  feature: string;
}

const requestQueue: QueuedRequest[] = [];
let queueProcessing = false;

function sortQueueByPriority(): void {
  requestQueue.sort((a, b) => {
    const pA = PRIORITY_ORDER[FEATURE_PRIORITY[a.feature] || 'background'] ?? 1;
    const pB = PRIORITY_ORDER[FEATURE_PRIORITY[b.feature] || 'background'] ?? 1;
    return pA - pB;
  });
}
let requestTimestamps: number[] = [];
let backoffUntil = 0;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;

function isRateLimited(maxPerMin: number): boolean {
  if (maxPerMin <= 0) return false;
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < 60_000);
  return requestTimestamps.length >= maxPerMin;
}

async function processQueue(): Promise<void> {
  if (queueProcessing) return;
  queueProcessing = true;

  while (requestQueue.length > 0) {
    sortQueueByPriority(); // interactive requests first
    const rateSettings = await getLLMRateSettings();

    // Check global backoff
    if (Date.now() < backoffUntil) {
      const wait = backoffUntil - Date.now();
      console.log(`${LOG} Backoff: waiting ${Math.round(wait / 1000)}s`);
      await new Promise(r => setTimeout(r, wait));
    }

    // Check rate limit
    if (isRateLimited(rateSettings.maxRequestsPerMinute)) {
      console.log(`${LOG} Rate limited (${rateSettings.maxRequestsPerMinute}/min), waiting 5s`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    const req = requestQueue.shift()!;
    requestTimestamps.push(Date.now());

    try {
      const res = await req.execute();

      if (res.status === 429) {
        // Rate limited by provider — exponential backoff
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, req.retries);
        backoffUntil = Date.now() + backoffMs;
        console.warn(`${LOG} 429 from provider, backoff ${backoffMs}ms (retry ${req.retries + 1}/${MAX_RETRIES})`);

        if (req.retries < MAX_RETRIES) {
          req.retries++;
          requestQueue.unshift(req); // put back at front
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        } else {
          req.reject(new Error(`Rate limited after ${MAX_RETRIES} retries`));
          continue;
        }
      }

      if (res.status >= 500) {
        // Server error — retry with backoff
        if (req.retries < MAX_RETRIES) {
          req.retries++;
          const backoffMs = BASE_BACKOFF_MS * Math.pow(2, req.retries);
          console.warn(`${LOG} Server error ${res.status}, retry ${req.retries}/${MAX_RETRIES} in ${backoffMs}ms`);
          requestQueue.unshift(req);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
      }

      req.resolve(res);
    } catch (err) {
      if (req.retries < MAX_RETRIES) {
        req.retries++;
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, req.retries);
        console.warn(`${LOG} Network error, retry ${req.retries}/${MAX_RETRIES} in ${backoffMs}ms`);
        requestQueue.unshift(req);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        req.reject(err as Error);
      }
    }
  }

  queueProcessing = false;
}

/**
 * Queue a fetch request through the rate limiter + backoff system.
 */
async function queuedFetch(url: string, init: RequestInit, feature: string): Promise<Response> {
  const rateSettings = await getLLMRateSettings();

  // Check if LLM is globally disabled
  if (!rateSettings.enabled) {
    throw new Error('LLM calls disabled');
  }

  // Check feature-specific toggles
  const featureMap: Record<string, keyof LLMRateSettings> = {
    'auto-respond': 'enableAutoRespond',
    'suggestions': 'enableSuggestions',
    'dossier': 'enableDossierExtract',
    'nickname': 'enableNicknames',
    'summary': 'enableSummaries',
    'greeting': 'enableAutoRespond',
  };
  const toggle = featureMap[feature];
  if (toggle && !rateSettings[toggle]) {
    throw new Error(`LLM feature '${feature}' is disabled`);
  }

  return new Promise((resolve, reject) => {
    requestQueue.push({
      id: `${feature}-${Date.now()}`,
      execute: () => fetch(url, init),
      resolve,
      reject,
      retries: 0,
      feature,
    });
    processQueue();
  });
}

export async function getLLMConfig(): Promise<LLMConfig> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = data[SETTINGS_KEY] || {};
  return {
    provider: settings.provider || 'local',
    apiKey: settings.apiKey || '',
    model: settings.model || '',
  };
}

/**
 * Get all configured API keys for failover.
 */
async function getAllProviderKeys(): Promise<Record<string, string>> {
  const data = await chrome.storage.local.get('aggregaytor_all_llm_keys');
  return data.aggregaytor_all_llm_keys || {};
}

export async function saveProviderKey(provider: string, apiKey: string): Promise<void> {
  const keys = await getAllProviderKeys();
  keys[provider] = apiKey;
  await chrome.storage.local.set({ aggregaytor_all_llm_keys: keys });
}

/**
 * Get a working LLM config, trying failover providers if the primary is rate-limited.
 */
async function getConfigWithFailover(rateLimitedProvider?: string): Promise<LLMConfig> {
  const primary = await getLLMConfig();

  // If not rate limited, use primary
  if (!rateLimitedProvider || rateLimitedProvider !== primary.provider) return primary;

  // Try failover: check all stored keys
  const keys = await getAllProviderKeys();
  const providerOrder: LLMProvider[] = ['gemini', 'anthropic', 'openai'];

  for (const p of providerOrder) {
    if (p === rateLimitedProvider) continue;
    const key = keys[p] || (p === primary.provider ? primary.apiKey : '');
    if (key) {
      console.log(`${LOG} Failing over from ${rateLimitedProvider} to ${p}`);
      return { provider: p, apiKey: key, model: '' };
    }
  }

  // No failover available, return primary anyway
  return primary;
}

export function getLLMQueueStatus() {
  const now = Date.now();
  const providerUsage: Record<string, { used: number; limit: number }> = {};
  for (const [provider, limit] of Object.entries(PROVIDER_RPM)) {
    providerUsage[provider] = { used: getProviderRPMUsed(provider), limit };
  }
  return {
    queueLength: requestQueue.length,
    requestsLastMinute: requestTimestamps.filter(t => now - t < 60_000).length,
    backoffUntil: Math.max(0, backoffUntil - now),
    providerUsage,
  };
}

export async function saveLLMConfig(config: Partial<LLMConfig>): Promise<void> {
  const existing = await getLLMConfig();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...existing, ...config },
  });
  // Also save key to failover store
  if (config.provider && config.apiKey) {
    await saveProviderKey(config.provider, config.apiKey);
  }
}

// ── Personality presets + style guide + custom instructions ──────────────────

const PERSONALITY_SETTINGS_KEY = 'aggregaytor_personality';

export interface PersonalitySettings {
  preset: string;           // active preset name
  customInstructions: string;
  styleGuide: string;       // auto-derived from user's messages
  styleGuideUpdatedAt: string;
}

const DEFAULT_PERSONALITY: PersonalitySettings = {
  preset: 'direct',
  customInstructions: '',
  styleGuide: '',
  styleGuideUpdatedAt: '',
};

export const PERSONALITY_PRESETS: Record<string, { label: string; description: string; prompt: string }> = {
  eager: {
    label: 'Eager',
    description: 'Enthusiastic, excited, proactive about meeting',
    prompt: 'Be enthusiastic and clearly interested. Show excitement. Proactively suggest meeting up. Use exclamation points sparingly but genuinely. Show you are keen.',
  },
  flirty: {
    label: 'Flirty',
    description: 'Playful, teasing, suggestive without being crass',
    prompt: 'Be playful and flirtatious. Use innuendo and light teasing. Be charming and witty. Keep it fun and suggestive without being vulgar. Make them smile.',
  },
  conversational: {
    label: 'Conversational',
    description: 'Friendly, engaging, asks questions, keeps dialogue flowing',
    prompt: 'Be warm and conversational. Ask follow-up questions. Show genuine curiosity about them. Keep the dialogue flowing naturally. Be a good listener.',
  },
  stoic: {
    label: 'Stoic',
    description: 'Calm, measured, unbothered, confident silence',
    prompt: 'Be calm and measured. Use few words but make them count. Do not show eagerness or neediness. Let silences speak. Be confident and unhurried.',
  },
  direct: {
    label: 'Direct',
    description: 'Straightforward, no games, clear about intentions',
    prompt: 'Be straightforward and clear. State what you want directly. No beating around the bush. Cut through small talk efficiently. Be honest and transparent.',
  },
  dismissive: {
    label: 'Dismissive',
    description: 'Disinterested energy, makes them work for attention',
    prompt: 'Be slightly aloof and hard to impress. Give short responses. Make them earn your interest. Do not chase. Show you have better options.',
  },
  pleasant: {
    label: 'Pleasant',
    description: 'Warm, polite, genuinely nice, easy to talk to',
    prompt: 'Be genuinely warm and pleasant. Be polite and considerate. Make them feel comfortable. Be the person everyone wants to talk to. Kind but not pushover.',
  },
  aloof: {
    label: 'Aloof',
    description: 'Mysterious, gives little away, creates intrigue',
    prompt: 'Be enigmatic and give away little about yourself. Create curiosity. Answer questions with questions. Be intriguing without being rude.',
  },
  assertive: {
    label: 'Assertive',
    description: 'Takes charge, leads the conversation, decisive',
    prompt: 'Take charge of the conversation. Be decisive — suggest specific times and places. Lead without being pushy. Show you know what you want.',
  },
  witty: {
    label: 'Witty',
    description: 'Clever, uses humor, quick on the uptake',
    prompt: 'Be clever and use dry humor. Make witty observations. Be quick on the uptake. Use banter. Keep it intelligent and amusing.',
  },
  masculine: {
    label: 'Masculine',
    description: 'Confident, protective energy, takes the lead',
    prompt: 'Project confidence and masculinity. Be protective without being controlling. Take the lead. Be strong and dependable. Use a commanding but warm tone.',
  },
  submissive: {
    label: 'Submissive',
    description: 'Accommodating, follows their lead, eager to please',
    prompt: 'Be accommodating and let them take the lead. Show eagerness to please. Be flexible with their preferences. Express desire to fulfill their needs.',
  },
  hookup: {
    label: 'Hookup-focused',
    description: 'Efficient, logistics-focused, cuts to the chase',
    prompt: 'Focus on logistics. Get to the point quickly — hosting, travel, timing. Skip extensive small talk. Be efficient but not rude. Close the deal.',
  },
  dating: {
    label: 'Dating-focused',
    description: 'Getting to know them, building genuine connection',
    prompt: 'Focus on building a genuine connection. Ask about their interests, life, and goals. Suggest date activities. Show you are interested in them as a person, not just physically.',
  },
};

export async function getPersonalitySettings(): Promise<PersonalitySettings> {
  const data = await chrome.storage.local.get(PERSONALITY_SETTINGS_KEY);
  return { ...DEFAULT_PERSONALITY, ...(data[PERSONALITY_SETTINGS_KEY] || {}) };
}

export async function savePersonalitySettings(settings: Partial<PersonalitySettings>): Promise<void> {
  const existing = await getPersonalitySettings();
  await chrome.storage.local.set({ [PERSONALITY_SETTINGS_KEY]: { ...existing, ...settings } });
}

/**
 * Derive a style guide from the user's own sent messages.
 * Analyzes message length, vocabulary, punctuation, emoji usage, etc.
 */
export async function deriveStyleGuide(sentMessages: Message[]): Promise<string> {
  if (sentMessages.length < 5) return 'Not enough messages to derive style (need 5+).';

  const bodies = sentMessages.map(m => m.body);
  const avgLength = Math.round(bodies.reduce((s, b) => s + b.length, 0) / bodies.length);
  const usesEmoji = bodies.some(b => /[\u{1F600}-\u{1F9FF}]/u.test(b));
  const usesExclamation = bodies.filter(b => b.includes('!')).length / bodies.length;
  const usesQuestion = bodies.filter(b => b.includes('?')).length / bodies.length;
  const avgWords = Math.round(bodies.reduce((s, b) => s + b.split(/\s+/).length, 0) / bodies.length);
  const usesSlang = bodies.some(b => /\b(wbu|hbu|tbh|ngl|fr|imo|smh|lol|lmao|bruh)\b/i.test(b));
  const usesCapitals = bodies.filter(b => b === b.toUpperCase() && b.length > 3).length / bodies.length;
  const startsLowercase = bodies.filter(b => /^[a-z]/.test(b)).length / bodies.length;

  const traits: string[] = [];
  traits.push(`Average message length: ${avgLength} chars, ${avgWords} words`);
  if (avgWords <= 5) traits.push('Very brief messages — keep responses short');
  else if (avgWords <= 15) traits.push('Medium-length messages');
  else traits.push('Longer, more detailed messages');

  if (usesEmoji) traits.push('Uses emoji occasionally');
  else traits.push('Does NOT use emoji — avoid emoji in responses');

  if (usesExclamation > 0.3) traits.push('Uses exclamation marks frequently');
  else if (usesExclamation < 0.05) traits.push('Rarely uses exclamation marks — keep responses calm');

  if (usesQuestion > 0.3) traits.push('Asks lots of questions — include questions in responses');

  if (usesSlang) traits.push('Uses casual slang (wbu, tbh, lol)');
  else traits.push('Formal/standard language — avoid heavy slang');

  if (startsLowercase > 0.5) traits.push('Often starts with lowercase — match this style');
  if (usesCapitals > 0.1) traits.push('Sometimes uses ALL CAPS for emphasis');

  // Sample some actual messages for LLM to analyze
  const samples = bodies.slice(-10).map(b => `"${b.slice(0, 60)}"`).join(', ');
  traits.push(`Recent message samples: ${samples}`);

  return traits.join('. ') + '.';
}

async function buildSystemPrompt(contactName: string, platform: string): Promise<string> {
  const personality = await getPersonalitySettings();
  const presetPrompt = PERSONALITY_PRESETS[personality.preset]?.prompt || PERSONALITY_PRESETS.direct.prompt;

  let prompt = `You are composing responses for a dating/hookup chat on ${platform}. The user is chatting with "${contactName}".

PERSONALITY: ${presetPrompt}

Your job: suggest 3-4 short, natural response options matching this personality.`;

  if (personality.customInstructions) {
    prompt += `\n\nUSER'S CUSTOM INSTRUCTIONS (follow these strictly):\n${personality.customInstructions}`;
  }

  if (personality.styleGuide) {
    prompt += `\n\nSTYLE GUIDE (match the user's writing style):\n${personality.styleGuide}`;
  }

  prompt += `\n\nRules:
- Keep responses short (1-2 sentences max)
- Match the conversation tone and flow
- If they asked a question, at least one suggestion should answer it
- Return ONLY a JSON array of strings, no other text

Example output: ["Hey, sounds good! When works for you?", "I'm free tonight", "What area are you in?"]`;

  return prompt;
}

// ── Optimization layer ──────────────────────────────────────────────────────

// 1. Response cache — cache LLM responses by prompt hash
const responseCache = new Map<string, { response: string; timestamp: number; tokens: number }>();
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const MAX_CACHE_SIZE = 100;

function getCacheKey(systemPrompt: string, userPrompt: string, feature: string): string {
  // Simple hash — same prompt = same response (within TTL)
  let hash = 0;
  const str = `${feature}:${systemPrompt.slice(0, 200)}:${userPrompt.slice(-500)}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `c_${hash.toString(36)}`;
}

function getCachedResponse(key: string): string | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  console.log(`${LOG} Cache hit (saved ${entry.tokens} tokens)`);
  return entry.response;
}

function setCachedResponse(key: string, response: string, estimatedTokens: number): void {
  if (responseCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest
    const oldest = [...responseCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) responseCache.delete(oldest[0]);
  }
  responseCache.set(key, { response, timestamp: Date.now(), tokens: estimatedTokens });
}

// 2. System prompt cache — don't rebuild when personality hasn't changed
let cachedSystemPrompt = '';
let systemPromptHash = '';

async function getCachedSystemPrompt(contactName: string, platform: string): Promise<string> {
  const personality = await getPersonalitySettings();
  const hash = `${personality.preset}:${personality.customInstructions?.slice(0, 50)}:${personality.styleGuide?.slice(0, 50)}`;
  if (hash !== systemPromptHash) {
    cachedSystemPrompt = '';
    systemPromptHash = hash;
  }
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = await buildSystemPrompt(contactName, platform);
  }
  // Replace contact name (the only variable part)
  return cachedSystemPrompt.replace(/chatting with "[^"]*"/, `chatting with "${contactName}"`);
}

// 3. Conversation windowing — use fewer messages for simpler tasks
const CONTEXT_WINDOWS: Record<string, number> = {
  suggestions: 10,      // was 30 — suggestions only need recent context
  'auto-respond': 15,   // was 30 — auto-respond needs slightly more
  dossier: 25,          // was 50 — dossier still needs depth
  summary: 20,          // was 30
  nickname: 5,          // minimal context needed
  greeting: 0,          // no context needed
};

function buildConversationContext(messages: Message[], contactName: string, feature = 'suggestions'): string {
  const windowSize = CONTEXT_WINDOWS[feature] || 15;
  const recent = messages.slice(-windowSize);

  // Context compaction: for long messages, truncate to first 100 chars
  return recent.map(m => {
    const body = m.body.length > 100 ? m.body.slice(0, 100) + '...' : m.body;
    return `${m.direction === 'out' ? 'You' : contactName}: ${body}`;
  }).join('\n');
}

// 4. Incremental dossier extraction — only process new messages
const lastDossierExtractTimestamp = new Map<string, string>();

function getNewMessagesSinceLastExtraction(contactId: string, messages: Message[]): Message[] {
  const lastTs = lastDossierExtractTimestamp.get(contactId);
  if (!lastTs) return messages; // first extraction — use all
  return messages.filter(m => m.timestamp > lastTs);
}

function markDossierExtracted(contactId: string, messages: Message[]): void {
  if (messages.length) {
    const latest = messages.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    lastDossierExtractTimestamp.set(contactId, latest.timestamp);
  }
}

// 5. Model routing — best models for interactive, cheapest for background
//    premium: user-facing responses that need quality (suggestions, auto-respond)
//    standard: analytical tasks that need accuracy but not style (summary, dossier)
//    economy: trivial tasks where any output works (nickname, greeting)
const TASK_TIER: Record<string, 'premium' | 'standard' | 'economy'> = {
  suggestions: 'premium',
  'auto-respond': 'premium',
  summary: 'standard',
  dossier: 'standard',
  nickname: 'economy',
  greeting: 'economy',
};

// Best model per provider per tier
const TIERED_MODELS: Record<string, Record<string, string>> = {
  openai: {
    premium: 'gpt-4o',            // best quality for responses
    standard: 'gpt-4o-mini',      // good enough for analysis
    economy: 'gpt-4o-mini',       // cheapest
  },
  anthropic: {
    premium: 'claude-sonnet-4-20250514',   // best for natural conversation
    standard: 'claude-haiku-4-5-20251001', // fast + cheap for analysis
    economy: 'claude-haiku-4-5-20251001',
  },
  gemini: {
    premium: 'gemini-2.5-flash',     // best free model
    standard: 'gemini-2.5-flash-lite', // cheaper
    economy: 'gemini-2.5-flash-lite',
  },
  groq: {
    premium: 'llama-3.3-70b-versatile',  // best quality on Groq
    standard: 'llama-3.1-8b-instant',    // fast + cheap
    economy: 'llama-3.1-8b-instant',
  },
  perplexity: {
    premium: 'sonar',
    standard: 'sonar',
    economy: 'sonar',
  },
  mistral: {
    premium: 'mistral-medium-latest',
    standard: 'mistral-small-latest',
    economy: 'mistral-small-latest',
  },
  copilot: {
    premium: 'gpt-4o',
    standard: 'gpt-4o-mini',
    economy: 'gpt-4o-mini',
  },
};

function getModelForTask(config: LLMConfig, feature: string): string {
  // If user explicitly set a model, always use it
  if (config.model) return config.model;

  const tier = TASK_TIER[feature] || 'standard';
  const providerModels = TIERED_MODELS[config.provider];
  if (providerModels) {
    return providerModels[tier] || providerModels.standard || DEFAULT_MODELS[config.provider] || '';
  }
  return DEFAULT_MODELS[config.provider] || '';
}

// 6. Token estimation — rough estimate to track usage
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // rough approximation: 4 chars per token
}

// 7. Stats tracking
let totalTokensSaved = 0;
let totalCacheHits = 0;
let totalApiCalls = 0;

export function getLLMOptimizationStats() {
  return { totalTokensSaved, totalCacheHits, totalApiCalls, cacheSize: responseCache.size, coalescedRequests: totalCoalesced };
}

// 8. Request coalescing — dedupe concurrent identical prompts
const inflightRequests = new Map<string, Promise<string>>();
let totalCoalesced = 0;

async function coalescedCallProvider(
  config: LLMConfig, systemPrompt: string, userPrompt: string,
  feature: string, opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
): Promise<string> {
  const key = getCacheKey(systemPrompt, userPrompt, feature);
  const inflight = inflightRequests.get(key);
  if (inflight) {
    totalCoalesced++;
    console.log(`${LOG} Coalesced request (${feature})`);
    return inflight;
  }
  const promise = callProvider(config, systemPrompt, userPrompt, feature, opts);
  inflightRequests.set(key, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    inflightRequests.delete(key);
  }
}

// 9. Rolling conversation summary — compress old messages into a summary
const conversationSummaryCache = new Map<string, { summary: string; messageCount: number; timestamp: number }>();
const SUMMARY_CACHE_TTL = 10 * 60_000; // 10 min

async function getCompactConversationContext(
  messages: Message[], contactName: string, contactId: string, feature: string,
): Promise<string> {
  const windowSize = CONTEXT_WINDOWS[feature] || 15;

  // If conversation fits in window, no compression needed
  if (messages.length <= windowSize) {
    return buildConversationContext(messages, contactName, feature);
  }

  // Check if we have a cached summary for the older messages
  const cached = conversationSummaryCache.get(contactId);
  const recentMessages = messages.slice(-windowSize);
  const olderMessages = messages.slice(0, -windowSize);

  // Use cached summary if it covers roughly the same older messages
  if (cached && Math.abs(cached.messageCount - olderMessages.length) < 5 &&
      Date.now() - cached.timestamp < SUMMARY_CACHE_TTL) {
    const recentContext = recentMessages.map(m => {
      const body = m.body.length > 100 ? m.body.slice(0, 100) + '...' : m.body;
      return `${m.direction === 'out' ? 'You' : contactName}: ${body}`;
    }).join('\n');
    return `[Earlier conversation summary: ${cached.summary}]\n\n${recentContext}`;
  }

  // Generate a local summary of older messages (no LLM call)
  const inCount = olderMessages.filter(m => m.direction === 'in').length;
  const outCount = olderMessages.filter(m => m.direction === 'out').length;
  const topics = extractTopics(olderMessages);
  const summary = `${olderMessages.length} earlier messages (${inCount} from them, ${outCount} from you). Topics: ${topics || 'general chat'}.`;

  conversationSummaryCache.set(contactId, {
    summary, messageCount: olderMessages.length, timestamp: Date.now(),
  });

  const recentContext = recentMessages.map(m => {
    const body = m.body.length > 100 ? m.body.slice(0, 100) + '...' : m.body;
    return `${m.direction === 'out' ? 'You' : contactName}: ${body}`;
  }).join('\n');

  return `[Earlier: ${summary}]\n\n${recentContext}`;
}

function extractTopics(messages: Message[]): string {
  const keywords = new Map<string, number>();
  const topicPatterns = /\b(host|travel|meet|tonight|tomorrow|pics|photo|looking for|top|bottom|vers|fun|chill|hang|hookup|date|drink|place|car|hotel|address|age|height|weight)\b/gi;
  for (const m of messages) {
    const matches = m.body.match(topicPatterns) || [];
    for (const match of matches) {
      const word = match.toLowerCase();
      keywords.set(word, (keywords.get(word) || 0) + 1);
    }
  }
  return [...keywords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word)
    .join(', ');
}

// 10. Priority levels for request queue
type RequestPriority = 'interactive' | 'background' | 'batch';
const PRIORITY_ORDER: Record<RequestPriority, number> = { interactive: 0, background: 1, batch: 2 };

const FEATURE_PRIORITY: Record<string, RequestPriority> = {
  suggestions: 'interactive',
  'auto-respond': 'interactive',
  greeting: 'interactive',
  nickname: 'background',
  dossier: 'background',
  summary: 'background',
};

// ── Centralized provider call (all LLM requests go through here) ────────────

/**
 * Make an LLM API call through the rate-limited queue with backoff.
 * Returns the raw response text from the provider.
 */
async function callProvider(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
  feature: string,
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
): Promise<string> {
  totalApiCalls++;

  // Check response cache first (skip for high-temperature creative tasks)
  const temp = opts?.temperature ?? 0.9;
  if (temp < 0.5) { // deterministic tasks can be cached
    const cacheKey = getCacheKey(systemPrompt, userPrompt, feature);
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      totalCacheHits++;
      totalTokensSaved += estimateTokens(systemPrompt + userPrompt);
      return cached;
    }
  }

  // Use cheapest model for simple tasks
  const routedModel = getModelForTask(config, feature);
  const routedConfig = { ...config, model: routedModel };

  const maxTokens = opts?.maxTokens ?? 256;

  let url: string;
  let init: RequestInit;

  switch (routedConfig.provider) {
    case 'gemini': {
      const model = routedConfig.model || DEFAULT_MODELS.gemini;
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${routedConfig.apiKey}`;
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(systemPrompt ? { system_instruction: { parts: [{ text: systemPrompt }] } } : {}),
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: temp, maxOutputTokens: maxTokens, ...(opts?.jsonMode ? { responseMimeType: 'application/json' } : {}) },
        }),
      };
      break;
    }
    case 'openai': {
      const model = routedConfig.model || DEFAULT_MODELS.openai;
      url = 'https://api.openai.com/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${routedConfig.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens, ...(opts?.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
      };
      break;
    }
    case 'anthropic': {
      const model = routedConfig.model || DEFAULT_MODELS.anthropic;
      url = 'https://api.anthropic.com/v1/messages';
      // Use Anthropic prompt caching — cache the system prompt (90% savings on cached tokens)
      const anthropicSystem = systemPrompt ? [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ] : undefined;
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': routedConfig.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model, max_tokens: maxTokens, ...(anthropicSystem ? { system: anthropicSystem } : {}), messages: [{ role: 'user', content: userPrompt }] }),
      };
      break;
    }
    case 'groq': {
      // Groq uses OpenAI-compatible API
      const model = routedConfig.model || DEFAULT_MODELS.groq;
      url = 'https://api.groq.com/openai/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${routedConfig.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'perplexity': {
      const model = routedConfig.model || DEFAULT_MODELS.perplexity;
      url = 'https://api.perplexity.ai/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${routedConfig.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'mistral': {
      const model = routedConfig.model || DEFAULT_MODELS.mistral;
      url = 'https://api.mistral.ai/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${routedConfig.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'copilot': {
      // GitHub Copilot uses OpenAI-compatible endpoint
      const model = routedConfig.model || DEFAULT_MODELS.copilot;
      url = 'https://api.githubcopilot.com/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${routedConfig.apiKey}`,
          'Editor-Version': 'aggregaytor/0.19.1',
        },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    default:
      throw new Error(`Unknown provider: ${routedConfig.provider}`);
  }

  const res = await queuedFetch(url, init, feature);

  if (!res.ok) {
    // On 429 rate limit, try failover to another provider
    if (res.status === 429) {
      const failoverConfig = await getConfigWithFailover(routedConfig.provider);
      if (failoverConfig.provider !== routedConfig.provider) {
        console.log(`${LOG} Failing over from ${routedConfig.provider} to ${failoverConfig.provider}`);
        return callProvider(failoverConfig, systemPrompt, userPrompt, feature, opts);
      }
    }
    const err = await res.text();
    throw new Error(`${routedConfig.provider} ${res.status}: ${err.slice(0, 200)}`);
  }

  // Record this successful request for rate tracking
  recordProviderRequest(routedConfig.provider);

  const data = await res.json();
  let result = '';
  switch (routedConfig.provider) {
    case 'gemini': result = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''; break;
    case 'anthropic': result = data?.content?.[0]?.text || ''; break;
    case 'openai': case 'groq': case 'perplexity': case 'mistral': case 'copilot':
      result = data?.choices?.[0]?.message?.content || ''; break;
  }

  // Cache deterministic responses
  if (temp < 0.5 && result) {
    const cacheKey = getCacheKey(systemPrompt, userPrompt, feature);
    setCachedResponse(cacheKey, result, estimateTokens(systemPrompt + userPrompt));
  }

  return result;
}

// Legacy wrappers for backward compatibility
async function callGemini(config: LLMConfig, systemPrompt: string, conversation: string): Promise<string[]> {
  const text = await callProvider(config, systemPrompt,
    `Here is the conversation:\n\n${conversation}\n\nGenerate 3-4 suggested responses as a JSON array of strings.`,
    'suggestions', { jsonMode: true });
  return parseJsonArray(text);
}

async function callOpenAI(config: LLMConfig, systemPrompt: string, conversation: string): Promise<string[]> {
  const text = await callProvider(config, systemPrompt,
    `Here is the conversation:\n\n${conversation}\n\nGenerate 3-4 suggested responses as a JSON array of strings.`,
    'suggestions', { jsonMode: true });
  return parseJsonArray(text);
}

async function callAnthropic(config: LLMConfig, systemPrompt: string, conversation: string): Promise<string[]> {
  const text = await callProvider(config, systemPrompt,
    `Here is the conversation:\n\n${conversation}\n\nGenerate 3-4 suggested responses as a JSON array of strings.`,
    'suggestions');
  return parseJsonArray(text);
}

// ── Local fallback ──────────────────────────────────────────────────────────

function localSuggestions(messages: Message[]): string[] {
  const last = messages[messages.length - 1];
  if (!last) return ['Hey, what\'s up?', 'How\'s it going?'];

  const body = (last.body || '').toLowerCase();
  const suggestions: string[] = [];

  if (last.direction === 'in') {
    if (/^(hey|hi|hello|howdy|sup|what'?s up|yo)\b/.test(body)) {
      suggestions.push('Hey! How are you?', "What's up?", "How's your night going?");
    } else if (/\?$/.test(body)) {
      if (/host|place|where|location/.test(body)) {
        suggestions.push('I can host', "Can't host, can you?", 'Let me check');
      } else if (/when|tonight|now|free|available|time/.test(body)) {
        suggestions.push("I'm free now", 'Later tonight works', 'What time works for you?');
      } else {
        suggestions.push('Yeah for sure', 'Let me think about it', 'What about you?');
      }
    } else if (/hot|sexy|cute|handsome|nice/.test(body)) {
      suggestions.push('Thanks! You too', "Appreciate that");
    } else {
      suggestions.push('Nice', 'Tell me more', 'Sounds good');
    }
  } else {
    const age = Date.now() - new Date(last.timestamp).getTime();
    if (age > 30 * 60_000) {
      suggestions.push('Still interested?', 'Let me know if you\'re still around');
    } else {
      suggestions.push('So what do you think?');
    }
  }

  if (suggestions.length < 3) {
    suggestions.push('What are you looking for?', 'Got any pics?');
  }
  return suggestions.slice(0, 4);
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function generateSuggestions(
  messages: Message[],
  contactName: string,
  platform: string,
): Promise<SuggestionResult> {
  const config = await getBestProvider();
  const systemPrompt = await getCachedSystemPrompt(contactName, platform);
  const conversation = buildConversationContext(messages, contactName, "suggestions");

  console.log(`${LOG} Generating suggestions via ${routedConfig.provider} (${messages.length} msgs, ~${estimateTokens(systemPrompt + conversation)} tokens)`);

  if (routedConfig.provider === 'local' || !routedConfig.apiKey) {
    return { suggestions: localSuggestions(messages), provider: 'local' };
  }

  try {
    const text = await coalescedCallProvider(config, systemPrompt,
      `Here is the conversation:\n\n${conversation}\n\nGenerate 3-4 suggested responses as a JSON array of strings.`,
      'suggestions', { jsonMode: true });
    let suggestions = parseJsonArray(text);
    if (!suggestions.length) {
      suggestions = localSuggestions(messages);
    }
    console.log(`${LOG} Got ${suggestions.length} suggestions from ${routedConfig.provider}`);
    return { suggestions, provider: routedConfig.provider };
  } catch (err) {
    console.error(`${LOG} ${routedConfig.provider} failed, falling back to local:`, err);
    return {
      suggestions: localSuggestions(messages),
      provider: 'local',
      error: (err as Error).message,
    };
  }
}

// ── Auto-respond with escalation tiers ──────────────────────────────────────

export interface AutoRespondSettings {
  aggressiveness?: 'chill' | 'normal' | 'eager';
  preferredTime?: string;
  preferredPlace?: string;
  timeFlexibility?: 'firm' | 'flexible' | 'open';
  placeFlexibility?: 'firm' | 'flexible' | 'open';
  allowPictures?: boolean;
  pictureTagsAllowed?: string[];
}

const AGGRESSIVENESS_PROMPTS: Record<string, string> = {
  chill: 'Be laid-back and casual. Do not push to meet up or suggest times/places. Let them lead the conversation. Keep it light.',
  normal: 'Be direct but not pushy. Express interest naturally. If the conversation is going well, you can mention wanting to meet but do not push hard.',
  eager: 'Be enthusiastic and proactive. If the conversation is flowing well, suggest meeting up. Propose times and show clear interest.',
};

async function buildAutoRespondPrompt(contactName: string, platform: string, settings?: AutoRespondSettings): Promise<string> {
  const personality = await getPersonalitySettings();
  const presetPrompt = PERSONALITY_PRESETS[personality.preset]?.prompt || PERSONALITY_PRESETS.direct.prompt;
  const agg = AGGRESSIVENESS_PROMPTS[settings?.aggressiveness || 'normal'];
  const timeStr = settings?.preferredTime ? `\nUser's preferred time: "${settings.preferredTime}" (flexibility: ${settings?.timeFlexibility || 'flexible'})` : '';
  const placeStr = settings?.preferredPlace ? `\nUser's preferred place: "${settings.preferredPlace}" (flexibility: ${settings?.placeFlexibility || 'flexible'})` : '';
  const picStr = settings?.allowPictures ? `\nUser allows sending pictures tagged: ${(settings.pictureTagsAllowed || []).join(', ') || 'any'}. If appropriate, include "sendPicture" in your response.` : '';

  let prompt = `You are composing a response in a dating/hookup chat on ${platform}. You ARE the user — write a single response, not options.

PERSONALITY: ${presetPrompt}
TONE: ${agg}
${timeStr}${placeStr}${picStr}`;

  if (personality.customInstructions) {
    prompt += `\n\nCUSTOM INSTRUCTIONS (follow strictly):\n${personality.customInstructions}`;
  }
  if (personality.styleGuide) {
    prompt += `\n\nWRITING STYLE:\n${personality.styleGuide}`;
  }

  prompt += `\n\nKeep it short (1-2 sentences). Be direct and confident.

CRITICAL: You MUST return a JSON object with these fields:
{
  "response": "your message text here",
  "tier": "low" | "medium" | "high",
  "reason": "why you chose this tier",
  "sendPicture": null or { "tag": "face" | "body" | "other" }
}

TIER CLASSIFICATION:
- "low": Safe to auto-send. Greetings, small talk, compliments, "wbu?", casual chat. NO logistics.
- "medium": Needs user review. Suggesting a TIME ("tonight?", "8pm?"), mentioning a general AREA ("I'm near uptown"), asking about availability.
- "high": NEVER auto-send. Specific ADDRESSES, "come over", "on my way", phone numbers, exact meetup locations, confirming plans.

When in doubt, classify as "medium". Any response involving time, place, or meeting plans is AT LEAST "medium".

Return ONLY the JSON object, nothing else.`;
}

function buildGreetingPrompt(platform: string): string {
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  return `Write a single casual, friendly greeting for a ${timeOfDay} chat on ${platform}.
Be natural and confident, not desperate or overly eager. One short sentence.
Return ONLY a JSON object: { "response": "your greeting", "tier": "low", "reason": "greeting" }`;
}

export interface AutoRespondResult {
  response: string;
  tier: 'low' | 'medium' | 'high';
  reason: string;
  sendPicture: { tag: string } | null;
  provider: LLMProvider;
  error?: string;
}

export async function generateAutoResponse(
  messages: Message[],
  contactName: string,
  platform: string,
  settings?: AutoRespondSettings,
): Promise<AutoRespondResult> {
  const config = await getBestProvider();
  const systemPrompt = await buildAutoRespondPrompt(contactName, platform, settings);
  const conversation = buildConversationContext(messages, contactName, "auto-respond");
  const userPrompt = `Here is the conversation:\n\n${conversation}\n\nGenerate your JSON response:`;

  console.log(`${LOG} Auto-responding via ${routedConfig.provider} (${messages.length} messages, ${settings?.aggressiveness || 'normal'})`);

  if (routedConfig.provider === 'local' || !routedConfig.apiKey) {
    const suggestions = localSuggestions(messages);
    return { response: suggestions[0] || 'Hey', tier: 'low', reason: 'local fallback', sendPicture: null, provider: 'local' };
  }

  try {
    let text: string;
    if (routedConfig.provider === 'local') {
      text = localSuggestions(messages)[0] || 'Hey';
    } else {
      text = (await callProvider(config, systemPrompt, userPrompt, 'auto-respond', { maxTokens: 128 })).trim();
    }

    // Parse the JSON response to extract tier + picture suggestion
    const parsed = parseAutoRespondJson(text);
    console.log(`${LOG} Auto-response: tier=${parsed.tier}, response="${parsed.response.slice(0, 50)}..."`);
    return { ...parsed, provider: routedConfig.provider };
  } catch (err) {
    console.error(`${LOG} Auto-respond failed:`, err);
    return { response: localSuggestions(messages)[0] || 'Hey', tier: 'low', reason: 'fallback', sendPicture: null, provider: 'local', error: (err as Error).message };
  }
}

function parseAutoRespondJson(text: string): { response: string; tier: 'low' | 'medium' | 'high'; reason: string; sendPicture: { tag: string } | null } {
  try {
    const parsed = JSON.parse(text);
    return {
      response: String(parsed.response || text).replace(/^["']|["']$/g, '').trim(),
      tier: ['low', 'medium', 'high'].includes(parsed.tier) ? parsed.tier : 'medium',
      reason: String(parsed.reason || ''),
      sendPicture: parsed.sendPicture && parsed.sendPicture.tag ? parsed.sendPicture : null,
    };
  } catch {
    // Not JSON — treat as plain text response, classify conservatively
    const lower = text.toLowerCase();
    let tier: 'low' | 'medium' | 'high' = 'low';
    if (/come over|my place|your place|address|on my way|omw|meet at|meet me/i.test(lower)) tier = 'high';
    else if (/tonight|tomorrow|\d+\s*(am|pm)|when.*free|what time|this week/i.test(lower)) tier = 'medium';
    return { response: text.replace(/^["']|["']$/g, '').trim(), tier, reason: 'auto-classified', sendPicture: null };
  }
}

export async function generateGreeting(
  platform: string,
): Promise<AutoRespondResult> {
  const config = await getBestProvider();
  const prompt = buildGreetingPrompt(platform);

  if (routedConfig.provider === 'local' || !routedConfig.apiKey) {
    const hour = new Date().getHours();
    const greetings = hour < 12
      ? ['Good morning!', 'Morning, how are you?']
      : hour < 17
      ? ['Hey, how\'s your afternoon?', 'Hey there']
      : ['Hey, how\'s your evening going?', 'What\'s up tonight?'];
    return { response: greetings[Math.floor(Math.random() * greetings.length)], tier: 'low', reason: 'greeting', sendPicture: null, provider: 'local' };
  }

  try {
    // Reuse the auto-respond path with no conversation context
    const result = await generateAutoResponse(
      [],
      'someone new',
      platform,
    );
    // Override with greeting prompt if we got a generic response
    if (result.response.length < 3) {
      return { response: 'Hey, how\'s it going?', tier: 'low', reason: 'greeting', sendPicture: null, provider: 'local' };
    }
    return result;
  } catch {
    return { response: 'Hey, how\'s it going?', tier: 'low', reason: 'greeting fallback', sendPicture: null, provider: 'local' };
  }
}

// ── Nickname generation ──────────────────────────────────────────────────────

export async function generateNickname(
  metadata: Record<string, unknown>,
  lastMessageBody: string,
  platform: string,
): Promise<string> {
  const config = await getBestProvider();

  // Build context clues
  const clues: string[] = [];
  if (metadata.bodyType || metadata.body) clues.push(`Body: ${metadata.bodyType || metadata.body}`);
  if (metadata.attitude || metadata.position) clues.push(`Position: ${metadata.attitude || metadata.position}`);
  if (metadata.age) clues.push(`Age: ${metadata.age}`);
  if (metadata.ethnicity) clues.push(`Ethnicity: ${metadata.ethnicity}`);
  if (lastMessageBody) clues.push(`Last message: "${lastMessageBody.slice(0, 60)}"`);

  if (routedConfig.provider === 'local' || !routedConfig.apiKey) {
    // Generate a simple descriptive nickname locally
    const parts: string[] = [];
    if (metadata.bodyType || metadata.body) parts.push(String(metadata.bodyType || metadata.body));
    if (metadata.attitude || metadata.position) parts.push(String(metadata.attitude || metadata.position));
    if (parts.length) return parts.join(' ').replace(/\b\w/g, c => c.toUpperCase());
    return `${platform.charAt(0).toUpperCase() + platform.slice(1)} Guy`;
  }

  const prompt = `Generate a SHORT, descriptive, memorable nickname (2-3 words max) for a person on ${platform} based on these clues:
${clues.join('\n')}

The nickname should be friendly, descriptive, and help identify this person at a glance.
Examples: "Athletic Top", "Chill Bear", "Uptown Jock", "Night Owl", "Tatted Muscle"
Return ONLY the nickname, nothing else.`;

  try {
    const text = await callProvider(config, '', prompt, 'nickname', { temperature: 1.0, maxTokens: 20 });
    return text.replace(/^["']|["']$/g, '').trim().slice(0, 30) || `${platform} Guy`;
  } catch {
    return `${platform.charAt(0).toUpperCase() + platform.slice(1)} Guy`;
  }
}

// ── Dossier auto-extraction ─────────────────────────────────────────────────

export async function extractDossierFields(
  messages: Message[],
  contactName: string,
  existingDossier: Record<string, unknown>,
): Promise<Record<string, string>> {
  const config = await getBestProvider();
  if (routedConfig.provider === 'local' || !routedConfig.apiKey) {
    return localDossierExtraction(messages);
  }

  const recent = messages.slice(-50);
  const conversation = recent.map(m =>
    `${m.direction === 'out' ? 'You' : contactName}: ${m.body}`
  ).join('\n');

  const alreadyKnown = Object.entries(existingDossier)
    .filter(([k, v]) => v && typeof v === 'string' && v.length > 0 && k !== 'docType' && k !== '_id')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const prompt = `Analyze this conversation and extract any personal information mentioned by "${contactName}" (the other person, NOT "You").

Already known:
${alreadyKnown || 'Nothing yet'}

Conversation:
${conversation}

Extract ANY of these fields IF they are mentioned or can be inferred from what ${contactName} said:
- realName: their actual name
- birthYear: year born or age (convert to year)
- phone: phone number
- address: where they live (any specificity)
- hometown: where they're from originally
- employer: where they work or what they do
- schedule: when they're free/busy
- relationshipStatus: single, partnered, married, etc.
- partnerNames: names of partners
- position: sexual position preference
- kinks: any mentioned kinks/preferences
- hasTransportation: can they drive/get there
- isInHotel: are they staying in a hotel
- hasDog: do they have a dog or pets
- isRealOrBot: any signs of being a bot (scripted responses, no specifics, too generic)

Return ONLY a JSON object with the fields you found new info for. Omit fields with no new info. Example: {"realName":"Mike","position":"vers top","hasTransportation":"true"}`;

  try {
    const text = await callProvider(config, '', prompt, 'dossier', { temperature: 0.2, maxTokens: 512, jsonMode: true });
    try {
      const parsed = JSON.parse(text);
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && v !== undefined && String(v).trim()) {
          result[k] = String(v).trim();
        }
      }
      console.log(`${LOG} Dossier extraction found ${Object.keys(result).length} fields`);
      return result;
    } catch { return {}; }
  } catch (err) {
    console.error(`${LOG} Dossier extraction failed:`, err);
    return localDossierExtraction(messages);
  }
}

export function localDossierExtraction(messages: Message[]): Record<string, string> {
  const result: Record<string, string> = {};
  const inbound = messages.filter(m => m.direction === 'in').map(m => m.body.toLowerCase());
  const allText = inbound.join(' ');

  // Phone number
  const phoneMatch = allText.match(/\b(\d{3}[-.]?\d{3}[-.]?\d{4})\b/);
  if (phoneMatch) result.phone = phoneMatch[1];

  // Age/birth year
  const ageMatch = allText.match(/\bi(?:'m|m)\s+(\d{2})\b/) || allText.match(/\b(\d{2})\s*(?:yo|y\/o|years?\s*old)\b/);
  if (ageMatch) result.birthYear = String(new Date().getFullYear() - parseInt(ageMatch[1]));

  // Position
  if (/\b(top|bottom|vers|versatile|side)\b/i.test(allText)) {
    const match = allText.match(/\b(vers top|vers bottom|power bottom|top|bottom|vers|versatile|side)\b/i);
    if (match) result.position = match[1];
  }

  // Hosting/transportation
  if (/\bcan host\b/i.test(allText)) result.hasTransportation = 'true';
  if (/\bcan'?t host\b/i.test(allText) || /\bno car\b/i.test(allText)) result.hasTransportation = 'false';
  if (/\bhotel\b/i.test(allText)) result.isInHotel = 'true';

  // Name
  const nameMatch = allText.match(/\b(?:my name(?:'s| is))\s+([A-Z][a-z]+)\b/i) || allText.match(/\b(?:i'm|im|i am)\s+([A-Z][a-z]{2,})\b/);
  if (nameMatch) result.realName = nameMatch[1];

  return result;
}

// ── Conversation summary ────────────────────────────────────────────────────

export async function generateConversationSummary(
  messages: Message[],
  contactName: string,
  platform: string,
): Promise<{ text: string; commitments: string[] }> {
  const config = await getBestProvider();
  if (routedConfig.provider === 'local' || !routedConfig.apiKey) {
    return localSummary(messages);
  }

  const conversation = buildConversationContext(messages, contactName, "summary");
  const prompt = `Analyze this ${platform} conversation and return a JSON object:
{
  "text": "2-3 sentence summary of the conversation state, tone, and what they want",
  "commitments": ["list of any agreed times, places, or action items"],
  "likelyOutcome": "one sentence prediction of where this is heading"
}

Conversation:
${conversation}

Return ONLY the JSON object.`;

  try {
    const text = await callProvider(config, '', prompt, 'summary', { temperature: 0.3, maxTokens: 256, jsonMode: true });
    try {
      const parsed = JSON.parse(text);
      return {
        text: String(parsed.text || parsed.summary || ''),
        commitments: Array.isArray(parsed.commitments) ? parsed.commitments.map(String) : [],
      };
    } catch {
      return { text: text.slice(0, 200), commitments: [] };
    }
  } catch (err) {
    console.error(`${LOG} Summary generation failed:`, err);
    return localSummary(messages);
  }
}

function localSummary(messages: Message[]): { text: string; commitments: string[] } {
  if (!messages.length) return { text: 'No conversation yet.', commitments: [] };
  const inbound = messages.filter(m => m.direction === 'in');
  const outbound = messages.filter(m => m.direction === 'out');
  const last = messages[messages.length - 1];
  const parts = [`${messages.length} messages exchanged (${inbound.length} from them, ${outbound.length} from you).`];
  if (last) parts.push(`Last message was ${last.direction === 'in' ? 'from them' : 'from you'}: "${last.body.slice(0, 50)}..."`);

  const commitments: string[] = [];
  for (const m of messages.slice(-10)) {
    if (/tonight|tomorrow|\d+\s*(am|pm)|meet|come over|my place|your place/i.test(m.body)) {
      commitments.push(m.body.slice(0, 80));
    }
  }

  return { text: parts.join(' '), commitments };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseJsonArray(text: string): string[] {
  try {
    // Try direct parse
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(s => typeof s === 'string');
    // OpenAI json_object mode wraps in an object
    if (parsed?.suggestions) return parsed.suggestions.filter((s: any) => typeof s === 'string');
    if (parsed?.responses) return parsed.responses.filter((s: any) => typeof s === 'string');
    // Try to find array in values
    for (const val of Object.values(parsed)) {
      if (Array.isArray(val)) return (val as any[]).filter(s => typeof s === 'string');
    }
  } catch {
    // Try to extract JSON array from text
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) return arr.filter(s => typeof s === 'string');
      } catch { /* ignore */ }
    }
  }
  return ['Sure', 'Sounds good', 'What do you think?'];
}
