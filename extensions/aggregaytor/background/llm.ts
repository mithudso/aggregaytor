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

function buildSystemPrompt(contactName: string, platform: string): string {
  return `You are a dating/hookup chat assistant helping compose responses on ${platform}. The user is chatting with "${contactName}".

Your job: suggest 3-4 short, natural response options based on the conversation context.

Rules:
- Be casual and conversational — match the tone of the chat
- Keep responses short (1-2 sentences max)
- Be direct and confident
- Read the vibe — flirty, logistics, casual, etc.
- If they asked a question, make sure at least one suggestion answers it
- If the conversation seems to be going well, suggest escalation (meeting up, exchanging info)
- If the user sent the last message and it's been a while, suggest a follow-up
- Never be desperate or overly eager
- Return ONLY a JSON array of strings, no other text

Example output: ["Hey, sounds good! When works for you?", "I'm free tonight if you want to hang", "What area are you in?"]`;
}

function buildConversationContext(messages: Message[], contactName: string): string {
  const recent = messages.slice(-30);
  return recent.map(m =>
    `${m.direction === 'out' ? 'You' : contactName}: ${m.body}`
  ).join('\n');
}

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
  const temp = opts?.temperature ?? 0.9;
  const maxTokens = opts?.maxTokens ?? 256;

  let url: string;
  let init: RequestInit;

  switch (config.provider) {
    case 'gemini': {
      const model = config.model || DEFAULT_MODELS.gemini;
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;
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
      const model = config.model || DEFAULT_MODELS.openai;
      url = 'https://api.openai.com/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens, ...(opts?.jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
      };
      break;
    }
    case 'anthropic': {
      const model = config.model || DEFAULT_MODELS.anthropic;
      url = 'https://api.anthropic.com/v1/messages';
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model, max_tokens: maxTokens, ...(systemPrompt ? { system: systemPrompt } : {}), messages: [{ role: 'user', content: userPrompt }] }),
      };
      break;
    }
    case 'groq': {
      // Groq uses OpenAI-compatible API
      const model = config.model || DEFAULT_MODELS.groq;
      url = 'https://api.groq.com/openai/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'perplexity': {
      const model = config.model || DEFAULT_MODELS.perplexity;
      url = 'https://api.perplexity.ai/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'mistral': {
      const model = config.model || DEFAULT_MODELS.mistral;
      url = 'https://api.mistral.ai/v1/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    case 'copilot': {
      // GitHub Copilot uses OpenAI-compatible endpoint
      const model = config.model || DEFAULT_MODELS.copilot;
      url = 'https://api.githubcopilot.com/chat/completions';
      const msgs: any[] = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userPrompt });
      init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          'Editor-Version': 'aggregaytor/0.19.1',
        },
        body: JSON.stringify({ model, messages: msgs, temperature: temp, max_tokens: maxTokens }),
      };
      break;
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }

  const res = await queuedFetch(url, init, feature);

  if (!res.ok) {
    // On 429 rate limit, try failover to another provider
    if (res.status === 429) {
      const failoverConfig = await getConfigWithFailover(config.provider);
      if (failoverConfig.provider !== config.provider) {
        console.log(`${LOG} Failing over from ${config.provider} to ${failoverConfig.provider}`);
        return callProvider(failoverConfig, systemPrompt, userPrompt, feature, opts);
      }
    }
    const err = await res.text();
    throw new Error(`${config.provider} ${res.status}: ${err.slice(0, 200)}`);
  }

  // Record this successful request for rate tracking
  recordProviderRequest(config.provider);

  const data = await res.json();
  switch (config.provider) {
    case 'gemini': return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    case 'anthropic': return data?.content?.[0]?.text || '';
    // OpenAI-compatible: openai, groq, perplexity, mistral, copilot
    case 'openai': case 'groq': case 'perplexity': case 'mistral': case 'copilot':
      return data?.choices?.[0]?.message?.content || '';
    default: return '';
  }
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
  const systemPrompt = buildSystemPrompt(contactName, platform);
  const conversation = buildConversationContext(messages, contactName);

  console.log(`${LOG} Generating suggestions via ${config.provider} (${messages.length} messages)`);

  if (config.provider === 'local' || !config.apiKey) {
    return { suggestions: localSuggestions(messages), provider: 'local' };
  }

  try {
    let suggestions: string[];
    switch (config.provider) {
      case 'gemini':
        suggestions = await callGemini(config, systemPrompt, conversation);
        break;
      case 'openai':
        suggestions = await callOpenAI(config, systemPrompt, conversation);
        break;
      case 'anthropic':
        suggestions = await callAnthropic(config, systemPrompt, conversation);
        break;
      default:
        suggestions = localSuggestions(messages);
    }
    console.log(`${LOG} Got ${suggestions.length} suggestions from ${config.provider}`);
    return { suggestions, provider: config.provider };
  } catch (err) {
    console.error(`${LOG} ${config.provider} failed, falling back to local:`, err);
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

function buildAutoRespondPrompt(contactName: string, platform: string, settings?: AutoRespondSettings): string {
  const agg = AGGRESSIVENESS_PROMPTS[settings?.aggressiveness || 'normal'];
  const timeStr = settings?.preferredTime ? `\nUser's preferred time: "${settings.preferredTime}" (flexibility: ${settings?.timeFlexibility || 'flexible'})` : '';
  const placeStr = settings?.preferredPlace ? `\nUser's preferred place: "${settings.preferredPlace}" (flexibility: ${settings?.placeFlexibility || 'flexible'})` : '';
  const picStr = settings?.allowPictures ? `\nUser allows sending pictures tagged: ${(settings.pictureTagsAllowed || []).join(', ') || 'any'}. If appropriate, include "sendPicture" in your response.` : '';

  return `You are composing a response in a dating/hookup chat on ${platform}. You ARE the user — write a single response, not options.

TONE: ${agg}
${timeStr}${placeStr}${picStr}

Match the user's tone and style from their previous "You:" messages.
Keep it short (1-2 sentences). Be direct and confident.

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
  const systemPrompt = buildAutoRespondPrompt(contactName, platform, settings);
  const conversation = buildConversationContext(messages, contactName);
  const userPrompt = `Here is the conversation:\n\n${conversation}\n\nGenerate your JSON response:`;

  console.log(`${LOG} Auto-responding via ${config.provider} (${messages.length} messages, ${settings?.aggressiveness || 'normal'})`);

  if (config.provider === 'local' || !config.apiKey) {
    const suggestions = localSuggestions(messages);
    return { response: suggestions[0] || 'Hey', tier: 'low', reason: 'local fallback', sendPicture: null, provider: 'local' };
  }

  try {
    let text: string;
    if (config.provider === 'local') {
      text = localSuggestions(messages)[0] || 'Hey';
    } else {
      text = (await callProvider(config, systemPrompt, userPrompt, 'auto-respond', { maxTokens: 128 })).trim();
    }

    // Parse the JSON response to extract tier + picture suggestion
    const parsed = parseAutoRespondJson(text);
    console.log(`${LOG} Auto-response: tier=${parsed.tier}, response="${parsed.response.slice(0, 50)}..."`);
    return { ...parsed, provider: config.provider };
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

  if (config.provider === 'local' || !config.apiKey) {
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

  if (config.provider === 'local' || !config.apiKey) {
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
  if (config.provider === 'local' || !config.apiKey) {
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

function localDossierExtraction(messages: Message[]): Record<string, string> {
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
  if (config.provider === 'local' || !config.apiKey) {
    return localSummary(messages);
  }

  const conversation = buildConversationContext(messages, contactName);
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
