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

export type LLMProvider = 'gemini' | 'openai' | 'anthropic' | 'local';

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

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  local: 'local',
};

export async function getLLMConfig(): Promise<LLMConfig> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = data[SETTINGS_KEY] || {};
  return {
    provider: settings.provider || 'local',
    apiKey: settings.apiKey || '',
    model: settings.model || '',
  };
}

export async function saveLLMConfig(config: Partial<LLMConfig>): Promise<void> {
  const existing = await getLLMConfig();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { ...existing, ...config },
  });
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

// ── Gemini ──────────────────────────────────────────────────────────────────

async function callGemini(config: LLMConfig, systemPrompt: string, conversation: string): Promise<string[]> {
  const model = config.model || DEFAULT_MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{
        parts: [{ text: `Here is the conversation:\n\n${conversation}\n\nGenerate 3-4 suggested responses as a JSON array of strings.` }],
      }],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return parseJsonArray(text);
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

async function callOpenAI(config: LLMConfig, systemPrompt: string, conversation: string): Promise<string[]> {
  const model = config.model || DEFAULT_MODELS.openai;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here is the conversation:\n\n${conversation}\n\nGenerate 3-4 suggested responses as a JSON array of strings.` },
      ],
      temperature: 0.9,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return parseJsonArray(text);
}

// ── Anthropic ───────────────────────────────────────────────────────────────

async function callAnthropic(config: LLMConfig, systemPrompt: string, conversation: string): Promise<string[]> {
  const model = config.model || DEFAULT_MODELS.anthropic;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Here is the conversation:\n\n${conversation}\n\nGenerate 3-4 suggested responses as a JSON array of strings.` },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.content?.[0]?.text || '';
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
  const config = await getLLMConfig();
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
  const config = await getLLMConfig();
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
    switch (config.provider) {
      case 'gemini': {
        const model = config.model || DEFAULT_MODELS.gemini;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.9, maxOutputTokens: 128 },
          }),
        });
        if (!res.ok) throw new Error(`Gemini ${res.status}`);
        const data = await res.json();
        text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        break;
      }
      case 'openai': {
        const model = config.model || DEFAULT_MODELS.openai;
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            temperature: 0.9, max_tokens: 128,
          }),
        });
        if (!res.ok) throw new Error(`OpenAI ${res.status}`);
        const data = await res.json();
        text = (data?.choices?.[0]?.message?.content || '').trim();
        break;
      }
      case 'anthropic': {
        const model = config.model || DEFAULT_MODELS.anthropic;
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', 'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({ model, max_tokens: 128, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
        });
        if (!res.ok) throw new Error(`Anthropic ${res.status}`);
        const data = await res.json();
        text = (data?.content?.[0]?.text || '').trim();
        break;
      }
      default:
        text = localSuggestions(messages)[0] || 'Hey';
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
  const config = await getLLMConfig();
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
  const config = await getLLMConfig();

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
    let text = '';
    switch (config.provider) {
      case 'gemini': {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.model || 'gemini-2.0-flash'}:generateContent?key=${config.apiKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 1.0, maxOutputTokens: 20 } }),
        });
        if (res.ok) text = (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        break;
      }
      case 'openai': {
        const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 1.0, max_tokens: 20 }),
        });
        if (res.ok) text = (await res.json())?.choices?.[0]?.message?.content || '';
        break;
      }
      case 'anthropic': {
        const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: config.model || 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: prompt }] }),
        });
        if (res.ok) text = (await res.json())?.content?.[0]?.text || '';
        break;
      }
    }
    return text.replace(/^["']|["']$/g, '').trim().slice(0, 30) || `${platform} Guy`;
  } catch {
    return `${platform.charAt(0).toUpperCase() + platform.slice(1)} Guy`;
  }
}

// ── Conversation summary ────────────────────────────────────────────────────

export async function generateConversationSummary(
  messages: Message[],
  contactName: string,
  platform: string,
): Promise<{ text: string; commitments: string[] }> {
  const config = await getLLMConfig();
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
    let text: string;
    switch (config.provider) {
      case 'gemini': {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model || 'gemini-2.0-flash'}:generateContent?key=${config.apiKey}`;
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 256, responseMimeType: 'application/json' } }) });
        if (!res.ok) throw new Error(`Gemini ${res.status}`);
        text = (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        break;
      }
      case 'openai': {
        const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 256, response_format: { type: 'json_object' } }) });
        if (!res.ok) throw new Error(`OpenAI ${res.status}`);
        text = (await res.json())?.choices?.[0]?.message?.content || '';
        break;
      }
      case 'anthropic': {
        const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: config.model || 'claude-haiku-4-5-20251001', max_tokens: 256, messages: [{ role: 'user', content: prompt }] }) });
        if (!res.ok) throw new Error(`Anthropic ${res.status}`);
        text = (await res.json())?.content?.[0]?.text || '';
        break;
      }
      default: return localSummary(messages);
    }

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
