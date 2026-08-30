import { describe, it, expect } from 'vitest';
import { parseSocketIOFrame } from '../src/ws-parser.js';

/**
 * parseSocketIOFrame now delegates to @aggregaytor/sniffies-lib's
 * `decodeSocketFrame` and returns its `{ event, data }` shape (field is
 * `event`, not the pre-adoption `eventName`). These assertions were updated to
 * the library's real output — computed from packages/sniffies-lib/src/observe.js.
 */
describe('parseSocketIOFrame', () => {
  it('parses Socket.IO "42" prefixed frames', () => {
    const frame = '42["message",{"id":"abc","body":"hello","timestamp":1700000000}]';
    const result = parseSocketIOFrame(frame);
    // updated: now asserts @aggregaytor/sniffies-lib decodeSocketFrame output ({event,...})
    expect(result).toEqual({
      event: 'message',
      data: { id: 'abc', body: 'hello', timestamp: 1700000000 },
    });
  });

  it('parses plain JSON objects (no eventName field → empty event, full object as data)', () => {
    const result = parseSocketIOFrame('{"msg":"test"}');
    // updated: now asserts @aggregaytor/sniffies-lib decodeSocketFrame output ({event:'', data: wholeObject})
    expect(result).toEqual({ event: '', data: { msg: 'test' } });
  });

  it('treats a bare JSON array as a Socket.IO event tuple ([a,b] → event=String(a), data=b)', () => {
    const result = parseSocketIOFrame('[1,2,3]');
    // updated: now asserts @aggregaytor/sniffies-lib decodeSocketFrame output —
    // the /^\d*\[/ branch consumes bare arrays; [1,2,3] → { event:'1', data:2 }.
    expect(result).toEqual({ event: '1', data: 2 });
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

  it('UNWRAPS double-encoded JSON payloads inside Socket.IO frames', () => {
    const frame = '42["data","{\\"key\\":\\"value\\"}"]';
    const result = parseSocketIOFrame(frame);
    // updated: now asserts @aggregaytor/sniffies-lib decodeSocketFrame output —
    // the inner JSON string is parsed a second time (unwrapped) rather than
    // coerced to null.
    expect(result?.event).toBe('data');
    expect(result?.data).toEqual({ key: 'value' });
  });

  it('handles single-element Socket.IO arrays (anonymous payload, no event name)', () => {
    const frame = '42[{"single":true}]';
    const result = parseSocketIOFrame(frame);
    // updated: now asserts @aggregaytor/sniffies-lib decodeSocketFrame output ({event:''})
    expect(result).toEqual({ event: '', data: { single: true } });
  });

  it('does NOT read an eventName field — maps the whole object to data', () => {
    const result = parseSocketIOFrame('{"eventName":"newGlobalMsg","data":{"text":"hi"}}');
    // updated: now asserts @aggregaytor/sniffies-lib decodeSocketFrame output —
    // a raw JSON object becomes { event:'', data: wholeObject }; the lib ignores
    // any `eventName` field.
    expect(result).toEqual({
      event: '',
      data: { eventName: 'newGlobalMsg', data: { text: 'hi' } },
    });
  });
});
