import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../src/http.js';

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('parses delta-seconds', () => {
    expect(parseRetryAfter('2', now)).toBe(2000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter(' 30 ', now)).toBe(30000);
  });

  it('parses HTTP dates relative to now', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
  });

  it('never returns a negative delay', () => {
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined for missing or garbage values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });
});
