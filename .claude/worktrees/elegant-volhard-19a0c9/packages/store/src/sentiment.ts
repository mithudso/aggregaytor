/**
 * sentiment.ts — Conversation sentiment analysis.
 *
 * Scores each thread on interest, engagement, and commitment likelihood
 * using both pattern-based heuristics and LLM analysis.
 */

import type { MessageDoc, SentimentScore } from './types.js';

// ── Pattern-based sentiment scoring ─────────────────────────────────────────

const INTEREST_POSITIVE = /\b(cute|hot|sexy|handsome|attractive|nice|interested|into you|want|looking|love|damn|yes|definitely|absolutely|for sure)\b/i;
const INTEREST_NEGATIVE = /\b(not interested|no thanks|pass|nah|nope|busy|taken|not looking|sorry|stop)\b/i;
const ENGAGEMENT_POSITIVE = /\?|tell me|what about|how about|wbu|hbu|you\?|pics|photo|more/i;
const COMMITMENT_POSITIVE = /\b(tonight|tomorrow|when|free|available|meet|come over|host|my place|your place|address|omw|on my way|heading|see you|what time|down)\b/i;
const COMMITMENT_NEGATIVE = /\b(maybe|idk|not sure|we'll see|sometime|another time|rain check|later)\b/i;

export function analyzeConversationSentiment(messages: MessageDoc[]): SentimentScore {
  if (!messages.length) {
    return { interest: 0, engagement: 0, commitment: 0, overall: 0, signals: ['No messages'] };
  }

  const inbound = messages.filter(m => m.direction === 'in');
  const outbound = messages.filter(m => m.direction === 'out');
  const signals: string[] = [];

  // ── Interest score ──
  let interest = 0.3; // baseline

  // Response ratio
  const responseRatio = outbound.length > 0 ? inbound.length / outbound.length : 0;
  if (responseRatio >= 0.8) { interest += 0.2; signals.push('Good response ratio'); }
  else if (responseRatio < 0.3 && outbound.length >= 3) { interest -= 0.2; signals.push('Low response rate'); }

  // Message length
  const avgInboundLength = inbound.length ? inbound.reduce((s, m) => s + m.body.length, 0) / inbound.length : 0;
  if (avgInboundLength > 50) { interest += 0.1; signals.push('Detailed messages'); }
  if (avgInboundLength < 10 && inbound.length > 2) { interest -= 0.1; signals.push('Short responses'); }

  // Positive/negative interest keywords
  const positiveCount = inbound.filter(m => INTEREST_POSITIVE.test(m.body)).length;
  const negativeCount = inbound.filter(m => INTEREST_NEGATIVE.test(m.body)).length;
  interest += Math.min(positiveCount * 0.08, 0.3);
  interest -= Math.min(negativeCount * 0.15, 0.4);

  // They initiated?
  if (messages.length > 0 && messages[0].direction === 'in') { interest += 0.1; signals.push('They initiated'); }

  // ── Engagement score ──
  let engagement = 0.2;

  // Questions asked by them
  const questionsFromThem = inbound.filter(m => ENGAGEMENT_POSITIVE.test(m.body)).length;
  engagement += Math.min(questionsFromThem * 0.1, 0.3);
  if (questionsFromThem > 2) signals.push('Asking questions');

  // Response speed (recent messages)
  const recentPairs = getResponsePairs(messages).slice(-5);
  const avgResponseMs = recentPairs.length ? recentPairs.reduce((s, p) => s + p.delayMs, 0) / recentPairs.length : Infinity;
  if (avgResponseMs < 5 * 60_000) { engagement += 0.2; signals.push('Fast responses'); }
  else if (avgResponseMs < 30 * 60_000) { engagement += 0.1; }
  else if (avgResponseMs > 2 * 3600_000) { engagement -= 0.1; signals.push('Slow to respond'); }

  // Conversation depth
  if (messages.length > 10) { engagement += 0.1; signals.push('Extended conversation'); }
  if (messages.length > 20) engagement += 0.1;

  // ── Commitment score ──
  let commitment = 0.1;

  const commitPositive = inbound.filter(m => COMMITMENT_POSITIVE.test(m.body)).length;
  const commitNegative = inbound.filter(m => COMMITMENT_NEGATIVE.test(m.body)).length;
  commitment += Math.min(commitPositive * 0.12, 0.5);
  commitment -= Math.min(commitNegative * 0.1, 0.3);

  if (commitPositive > 0) signals.push('Discussing logistics');
  if (commitNegative > commitPositive && commitNegative > 0) signals.push('Noncommittal language');

  // Time-specific mentions are strong commitment signals
  const timeSpecific = inbound.filter(m => /\d+\s*(am|pm)|tonight|right now|heading over/i.test(m.body)).length;
  if (timeSpecific > 0) { commitment += 0.2; signals.push('Specific time mentioned'); }

  // Clamp all scores to 0-1
  interest = Math.max(0, Math.min(1, interest));
  engagement = Math.max(0, Math.min(1, engagement));
  commitment = Math.max(0, Math.min(1, commitment));

  const overall = interest * 0.3 + engagement * 0.4 + commitment * 0.3;

  return {
    interest: Math.round(interest * 100) / 100,
    engagement: Math.round(engagement * 100) / 100,
    commitment: Math.round(commitment * 100) / 100,
    overall: Math.round(overall * 100) / 100,
    signals,
  };
}

interface ResponsePair {
  outTs: number;
  inTs: number;
  delayMs: number;
}

function getResponsePairs(messages: MessageDoc[]): ResponsePair[] {
  const sorted = [...messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const pairs: ResponsePair[] = [];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].direction === 'in' && sorted[i - 1].direction === 'out') {
      const outTs = new Date(sorted[i - 1].timestamp).getTime();
      const inTs = new Date(sorted[i].timestamp).getTime();
      pairs.push({ outTs, inTs, delayMs: inTs - outTs });
    }
  }
  return pairs;
}

/**
 * Generate a human-readable sentiment summary.
 */
export function formatSentimentSummary(s: SentimentScore): string {
  const labels: Record<string, string> = {};
  labels.interest = s.interest > 0.7 ? 'High' : s.interest > 0.4 ? 'Moderate' : 'Low';
  labels.engagement = s.engagement > 0.7 ? 'Active' : s.engagement > 0.4 ? 'Moderate' : 'Passive';
  labels.commitment = s.commitment > 0.6 ? 'Likely' : s.commitment > 0.3 ? 'Possible' : 'Unlikely';

  return `Interest: ${labels.interest} (${Math.round(s.interest * 100)}%) | Engagement: ${labels.engagement} (${Math.round(s.engagement * 100)}%) | Commitment: ${labels.commitment} (${Math.round(s.commitment * 100)}%)`;
}
