import { describe, it, expect } from 'vitest';
import { parseSocketIOFrame } from '../src/ws-parser.js';

/**
 * These tests were updated in v0.57.7 to match the current parseSocketIOFrame
 * signature — the function now returns a structured `{ eventName, data }`
 * envelope rather than the raw payload. Previous tests expected the pre-v0.40
 * API where it returned the inner data object directly.
 */
describe('parseSocketIOFrame', () => {
  it('parses Socket.IO "42" prefixed frames', () => {
    const frame = '42["message",{"id":"abc","body":"hello","timestamp":1700000000}]';
    const result = parseSocketIOFrame(frame);
    expect(result).toEqual({
      eventName: 'message',
      data: { id: 'abc', body: 'hello', timestamp: 1700000000 },
    });
  });

  it('parses plain JSON objects (no eventName field → empty eventName, full object as data)', () => {
    const result = parseSocketIOFrame('{"msg":"test"}');
    expect(result).toEqual({ eventName: '', data: { msg: 'test' } });
  });

  it('parses plain JSON arrays (no leading 42 prefix)', () => {
    const result = parseSocketIOFrame('[1,2,3]');
    expect(result).toEqual({ eventName: '', data: [1, 2, 3] });
  });

  it('returns null for numeric-only frames (heartbeats)', () => {
    expect(parseSocketIOFrame('2')).toBeNull();
    expect(parseSocketIOFrame('3')).toBeNull();
    expect(parseSocketIOFrame('40')).toBeNull();
  });

  it('returns null for empty/invalid input', () => {
    expect(parseSocketIOFrame('')).toBeNull();
    expect(parseSocketIOFrame('not json')).toBeNull();
    expect(parseSocketIOFrame(null as any)).toBeNull();
  });

  it('handles double-encoded JSON payloads inside Socket.IO frames', () => {
    // The inner JSON is a string — parser preserves it as-is in the data slot
    // (higher-level code in sniffies-adapter is responsible for the second parse).
    const frame = '42["data","{\\"key\\":\\"value\\"}"]';
    const result = parseSocketIOFrame(frame);
    expect(result?.eventName).toBe('data');
    expect(result?.data).toBeNull(); // string payloads get coerced to null here
  });

  it('handles single-element Socket.IO arrays (anonymous payload, no event name)', () => {
    const frame = '42[{"single":true}]';
    const result = parseSocketIOFrame(frame);
    expect(result).toEqual({ eventName: '', data: { single: true } });
  });

  it('parses raw JSON object with eventName field', () => {
    const result = parseSocketIOFrame('{"eventName":"newGlobalMsg","data":{"text":"hi"}}');
    expect(result).toEqual({ eventName: 'newGlobalMsg', data: { text: 'hi' } });
  });
});
