import { describe, it, expect } from 'vitest';
import { parseSocketIOFrame } from '../src/ws-parser.js';

describe('parseSocketIOFrame', () => {
  it('parses Socket.IO "42" prefixed frames', () => {
    const frame = '42["message",{"id":"abc","body":"hello","timestamp":1700000000}]';
    const result = parseSocketIOFrame(frame);
    expect(result).toEqual({ id: 'abc', body: 'hello', timestamp: 1700000000 });
  });

  it('parses plain JSON objects', () => {
    const result = parseSocketIOFrame('{"msg":"test"}');
    expect(result).toEqual({ msg: 'test' });
  });

  it('parses plain JSON arrays', () => {
    const result = parseSocketIOFrame('[1,2,3]');
    expect(result).toEqual([1, 2, 3]);
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

  it('handles double-encoded JSON', () => {
    const frame = '42["data","{\\"key\\":\\"value\\"}"]';
    const result = parseSocketIOFrame(frame);
    expect(result).toEqual({ key: 'value' });
  });

  it('handles single-element Socket.IO arrays', () => {
    const frame = '42[{"single":true}]';
    const result = parseSocketIOFrame(frame);
    expect(result).toEqual({ single: true });
  });
});
