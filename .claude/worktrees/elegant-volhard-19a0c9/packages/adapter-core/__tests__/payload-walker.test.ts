import { describe, it, expect } from 'vitest';
import { walkPayload } from '../src/payload-walker.js';
import type { PayloadVisitor } from '../src/types.js';

describe('walkPayload', () => {
  it('visits all objects in a nested structure', () => {
    const visited: Record<string, unknown>[] = [];
    const visitor: PayloadVisitor = {
      onObject(obj) { visited.push(obj); },
    };

    const payload = {
      level1: { level2: { level3: 'deep' } },
      sibling: { value: 42 },
    };

    walkPayload(payload, null, visitor);
    expect(visited.length).toBe(4); // root + level1 + level2 + sibling
  });

  it('respects max depth', () => {
    const visited: number[] = [];
    const visitor: PayloadVisitor = {
      onObject(_obj, _ctx, depth) { visited.push(depth); },
    };

    let payload: any = { nested: {} };
    let current = payload.nested;
    for (let i = 0; i < 10; i++) {
      current.child = {};
      current = current.child;
    }

    walkPayload(payload, null, visitor, 3);
    expect(Math.max(...visited)).toBeLessThanOrEqual(3);
  });

  it('handles circular references', () => {
    const obj: any = { a: 1 };
    obj.self = obj;

    const visited: Record<string, unknown>[] = [];
    const visitor: PayloadVisitor = {
      onObject(o) { visited.push(o); },
    };

    walkPayload(obj, null, visitor);
    expect(visited.length).toBe(1); // visited once, not infinite
  });

  it('skips non-object values', () => {
    const visited: Record<string, unknown>[] = [];
    const visitor: PayloadVisitor = {
      onObject(obj) { visited.push(obj); },
    };

    walkPayload('string', null, visitor);
    expect(visited.length).toBe(0);

    walkPayload(null, null, visitor);
    expect(visited.length).toBe(0);
  });

  it('walks arrays', () => {
    const visited: Record<string, unknown>[] = [];
    const visitor: PayloadVisitor = {
      onObject(obj) { visited.push(obj); },
    };

    walkPayload([{ a: 1 }, { b: 2 }], null, visitor);
    expect(visited.length).toBe(3); // array + 2 objects
  });
});
