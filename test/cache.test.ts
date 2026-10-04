import { describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../src/index.js';

function store(max?: number) {
  const clock = { t: 1_000 };
  const s = new MemoryCacheStore({ now: () => clock.t, ...(max === undefined ? {} : { maxEntries: max }) });
  return { s, clock };
}

describe('MemoryCacheStore', () => {
  it('stores and returns values', () => {
    const { s } = store();
    s.set('a', '1', 1000);
    expect(s.get('a')).toBe('1');
    expect(s.get('missing')).toBeUndefined();
  });

  it('expires entries after their TTL', () => {
    const { s, clock } = store();
    s.set('a', '1', 1000);
    clock.t += 999;
    expect(s.get('a')).toBe('1');
    clock.t += 1;
    expect(s.get('a')).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it('overwriting resets the TTL and value', () => {
    const { s, clock } = store();
    s.set('a', '1', 1000);
    clock.t += 900;
    s.set('a', '2', 1000);
    clock.t += 900;
    expect(s.get('a')).toBe('2');
  });

  it('does not store when ttl is zero or negative', () => {
    const { s } = store();
    s.set('a', '1', 0);
    s.set('b', '1', -5);
    expect(s.size).toBe(0);
  });

  it('delete and clear remove entries', () => {
    const { s } = store();
    s.set('a', '1', 1000);
    s.set('b', '2', 1000);
    s.delete('a');
    expect(s.get('a')).toBeUndefined();
    s.clear();
    expect(s.size).toBe(0);
  });

  it('evicts the least recently used entry when full', () => {
    const { s } = store(2);
    s.set('a', '1', 1000);
    s.set('b', '2', 1000);
    s.get('a'); // a is now most recent
    s.set('c', '3', 1000); // evicts b
    expect(s.get('a')).toBe('1');
    expect(s.get('b')).toBeUndefined();
    expect(s.get('c')).toBe('3');
    expect(s.size).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid maxEntries (%d)', (maxEntries) => {
    expect(() => new MemoryCacheStore({ maxEntries })).toThrow(TypeError);
  });
});
