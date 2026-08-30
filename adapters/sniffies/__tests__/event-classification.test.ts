import { describe, it, expect } from 'vitest';
import { isGlobalChatEvent, isPresenceEvent, GLOBAL_CHAT_EVENTS, PRESENCE_EVENTS } from '../src/ws-parser.js';

describe('isGlobalChatEvent', () => {
  it('matches confirmed production event "newGlobalMsg"', () => {
    expect(isGlobalChatEvent('newGlobalMsg')).toBe(true);
  });

  it('matches all exact entries in GLOBAL_CHAT_EVENTS', () => {
    // Guard: an empty set would make the loop below vacuously pass.
    expect(GLOBAL_CHAT_EVENTS.size).toBeGreaterThan(0);
    for (const name of GLOBAL_CHAT_EVENTS) {
      expect(isGlobalChatEvent(name)).toBe(true);
    }
  });

  it('matches fuzzy "cruising" variants', () => {
    expect(isGlobalChatEvent('cruisingFeed')).toBe(true);
    expect(isGlobalChatEvent('MyCruisingPost')).toBe(true);
  });

  it('matches fuzzy "broadcast" variants', () => {
    expect(isGlobalChatEvent('broadcastNew')).toBe(true);
  });

  it('matches fuzzy "globalchat" variants', () => {
    expect(isGlobalChatEvent('globalChatUpdate')).toBe(true);
  });

  it('matches fuzzy "globalmsg" variants', () => {
    expect(isGlobalChatEvent('newGlobalMsgV2')).toBe(true);
  });

  it('matches fuzzy "publicmessage" variants', () => {
    expect(isGlobalChatEvent('publicMessageSent')).toBe(true);
  });

  it('returns false for DM events', () => {
    expect(isGlobalChatEvent('newMessage')).toBe(false);
    expect(isGlobalChatEvent('directMessage')).toBe(false);
    expect(isGlobalChatEvent('chatMessage')).toBe(false);
  });

  it('returns false for presence events', () => {
    expect(isGlobalChatEvent('userJoined')).toBe(false);
    expect(isGlobalChatEvent('userDisconnected')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGlobalChatEvent('')).toBe(false);
  });
});

describe('isPresenceEvent', () => {
  it('matches all exact entries in PRESENCE_EVENTS', () => {
    // Guard: an empty set would make the loop below vacuously pass.
    expect(PRESENCE_EVENTS.size).toBeGreaterThan(0);
    for (const name of PRESENCE_EVENTS) {
      expect(isPresenceEvent(name)).toBe(true);
    }
  });

  it('matches fuzzy "user" + lifecycle verb', () => {
    expect(isPresenceEvent('userHasJoined')).toBe(true);
    expect(isPresenceEvent('userWasDisconnected')).toBe(true);
    expect(isPresenceEvent('userRecentlyUpdated')).toBe(true);
    expect(isPresenceEvent('userMovedLocation')).toBe(true);
  });

  it('does not match "user" without lifecycle verb', () => {
    expect(isPresenceEvent('userMessage')).toBe(false);
    expect(isPresenceEvent('userData')).toBe(false);
    expect(isPresenceEvent('userProfile')).toBe(false);
  });

  it('returns false for chat events', () => {
    expect(isPresenceEvent('newGlobalMsg')).toBe(false);
    expect(isPresenceEvent('newMessage')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPresenceEvent('')).toBe(false);
  });
});
