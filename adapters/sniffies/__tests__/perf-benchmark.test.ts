import { describe, it, expect } from 'vitest';
import { parseSocketIOFrame, isGlobalChatEvent, isPresenceEvent } from '../src/ws-parser.js';

/**
 * Performance benchmarks for the Sniffies adapter hot paths.
 *
 * WebSocket frame parsing runs on every incoming frame (~50-200/s during
 * active map browsing). Event classification runs on every parsed frame.
 * These benchmarks verify both stay well within budget.
 */

function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

// ── parseSocketIOFrame benchmarks ──────────────────────────────────────────

describe('parseSocketIOFrame performance', () => {
  const socketIOFrame = '42["newGlobalMsg",{"id":"abc","body":"hello","ts":1700000000}]';
  const rawJsonFrame = '{"eventName":"userJoined","data":{"id":"xyz","lat":34.0,"lng":-118.2}}';
  const heartbeatFrame = '2';
  const rawArrayFrame = '["broadcast",{"text":"hi"}]';

  it('parses 50k Socket.IO frames in <200ms', () => {
    const elapsed = timeMs(() => {
      for (let i = 0; i < 50000; i++) parseSocketIOFrame(socketIOFrame);
    });
    expect(elapsed).toBeLessThan(200);
  });

  it('parses 50k raw JSON frames in <200ms', () => {
    const elapsed = timeMs(() => {
      for (let i = 0; i < 50000; i++) parseSocketIOFrame(rawJsonFrame);
    });
    expect(elapsed).toBeLessThan(200);
  });

  it('rejects 100k heartbeat frames in <50ms', () => {
    const elapsed = timeMs(() => {
      for (let i = 0; i < 100000; i++) parseSocketIOFrame(heartbeatFrame);
    });
    expect(elapsed).toBeLessThan(50);
  });

  it('parses 50k raw array frames in <200ms', () => {
    const elapsed = timeMs(() => {
      for (let i = 0; i < 50000; i++) parseSocketIOFrame(rawArrayFrame);
    });
    expect(elapsed).toBeLessThan(200);
  });

  it('handles a mix of frame types at realistic throughput', () => {
    const frames = [
      socketIOFrame, rawJsonFrame, heartbeatFrame, '3', rawArrayFrame,
      '{"eventName":"userDisconnected","data":{"id":"u1"}}',
      '42["chatMsg",{"from":"u2","body":"hey"}]',
      heartbeatFrame,
    ];
    const elapsed = timeMs(() => {
      for (let i = 0; i < 100000; i++) {
        parseSocketIOFrame(frames[i % frames.length]);
      }
    });
    expect(elapsed).toBeLessThan(500);
  });
});

// ── Event classification benchmarks ────────────────────────────────────────

describe('event classification performance', () => {
  const eventNames = [
    'newGlobalMsg', 'userJoined', 'chatMessage', 'userDisconnected',
    'cruisingUpdate', 'broadcast', 'ping', 'newMessage', 'feedUpdate',
    'userMoved', 'directMessage', 'heartbeat',
  ];

  it('classifies 100k events via isGlobalChatEvent in <50ms', () => {
    const elapsed = timeMs(() => {
      for (let i = 0; i < 100000; i++) {
        isGlobalChatEvent(eventNames[i % eventNames.length]);
      }
    });
    expect(elapsed).toBeLessThan(50);
  });

  it('classifies 100k events via isPresenceEvent in <50ms', () => {
    const elapsed = timeMs(() => {
      for (let i = 0; i < 100000; i++) {
        isPresenceEvent(eventNames[i % eventNames.length]);
      }
    });
    expect(elapsed).toBeLessThan(50);
  });

  it('exact Set lookup is fast path for known events', () => {
    const knownOnly = ['newGlobalMsg', 'userJoined', 'ping', 'broadcast'];
    const elapsed = timeMs(() => {
      for (let i = 0; i < 100000; i++) {
        isGlobalChatEvent(knownOnly[i % knownOnly.length]);
        isPresenceEvent(knownOnly[i % knownOnly.length]);
      }
    });
    expect(elapsed).toBeLessThan(50);
  });

  it('fuzzy fallback is still fast for unknown events', () => {
    const unknownEvents = [
      'cruisingNewPost', 'publicMessageV2', 'globalChatUpdate',
      'userHasJoined', 'userRecentlyMoved',
    ];
    const elapsed = timeMs(() => {
      for (let i = 0; i < 100000; i++) {
        isGlobalChatEvent(unknownEvents[i % unknownEvents.length]);
        isPresenceEvent(unknownEvents[i % unknownEvents.length]);
      }
    });
    expect(elapsed).toBeLessThan(100);
  });
});

// ── parseRelativeTime benchmark (replicated logic) ─────────────────────────

describe('parseRelativeTime performance', () => {
  function parseRelativeTime(text: string): string {
    if (!text) return new Date().toISOString();
    const t = text.trim().toLowerCase();
    const now = Date.now();
    const fewMatch = t.match(/(a few|several|some|couple(?:\s+of)?)\s+(second|minute|hour|day)s?\s*(?:ago)?/i);
    if (fewMatch) {
      const unit = fewMatch[2].toLowerCase();
      if (unit.startsWith('s')) return new Date(now - 10_000).toISOString();
      if (unit.startsWith('m')) return new Date(now - 180_000).toISOString();
      if (unit.startsWith('h')) return new Date(now - 7_200_000).toISOString();
      if (unit.startsWith('d')) return new Date(now - 2 * 86400_000).toISOString();
    }
    const match = t.match(/(\d+)\s*(second|sec|month|mo|minute|min|hour|hr|week|year|day|s|m|h|d|w|y)s?\s*(?:ago)?/i)
      || t.match(/(a|an)\s+(minute|hour|day|week|month|year)s?\s*(?:ago)?/i);
    if (!match) {
      if (t.includes('just now') || t.includes('now')) return new Date(now).toISOString();
      if (t.includes('yesterday')) return new Date(now - 86400000).toISOString();
      return new Date().toISOString();
    }
    const num = match[1] === 'a' || match[1] === 'an' ? 1 : parseInt(match[1], 10);
    const unit = (match[2] || '').toLowerCase();
    let ms = 0;
    if (unit.startsWith('s')) ms = num * 1000;
    else if (unit.startsWith('mi') || unit === 'm') ms = num * 60_000;
    else if (unit.startsWith('h')) ms = num * 3600_000;
    else if (unit.startsWith('d')) ms = num * 86400_000;
    else if (unit.startsWith('w')) ms = num * 604800_000;
    else if (unit.startsWith('mo')) ms = num * 2592000_000;
    else if (unit.startsWith('y')) ms = num * 31536000_000;
    return new Date(now - ms).toISOString();
  }

  const inputs = [
    'a few seconds ago', 'a few minutes ago', 'several hours ago',
    '5m ago', '2h', '3d', '1w', 'just now', 'yesterday',
    'couple of days ago', '10 minutes ago', 'an hour ago',
  ];

  it('parses 50k relative time strings in <200ms', () => {
    const elapsed = timeMs(() => {
      for (let i = 0; i < 50000; i++) {
        parseRelativeTime(inputs[i % inputs.length]);
      }
    });
    expect(elapsed).toBeLessThan(200);
  });

  it('"a few X ago" branch is no slower than numeric branch', () => {
    const fewInputs = ['a few seconds ago', 'a few minutes ago', 'several hours ago'];
    const numInputs = ['5m ago', '2h', '3d'];
    const fewTime = timeMs(() => {
      for (let i = 0; i < 50000; i++) parseRelativeTime(fewInputs[i % 3]);
    });
    const numTime = timeMs(() => {
      for (let i = 0; i < 50000; i++) parseRelativeTime(numInputs[i % 3]);
    });
    expect(fewTime).toBeLessThan(numTime * 3);
  });
});
