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
