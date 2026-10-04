import { describe, expect, it } from 'vitest';
import { BankNotFoundError, InvalidAccountNumberError, ProviderError, RateLimitedError } from '../src/index.js';
import { backoffDelay, isRetryable, normalizeRetryOptions, withRetry } from '../src/retry.js';
import type { RetryInfo, RetryOptions } from '../src/retry.js';
import { expectRejection } from './helpers.js';

/** Options with an instant, recording sleep and deterministic randomness. */
function opts(overrides: RetryOptions = {}) {
  const delays: number[] = [];
  const resolved = normalizeRetryOptions({
    jitter: false,
    sleep: async (ms) => {
      delays.push(ms);
    },
    ...overrides,
  });
  return { resolved, delays };
}

const retryable = () => new ProviderError('down', { provider: 'p', retryable: true });

/** fn that fails with the given errors in order, then succeeds with "ok". */
function failing(...errors: unknown[]) {
  let calls = 0;
  return {
    fn: async () => {
      const e = errors[calls++];
      if (e !== undefined) throw e;
      return 'ok';
    },
    get calls() {
      return calls;
    },
  };
}

describe('isRetryable', () => {
  it('retries rate limits and retryable provider errors only', () => {
    expect(isRetryable(new RateLimitedError('p'))).toBe(true);
    expect(isRetryable(retryable())).toBe(true);
    expect(isRetryable(new ProviderError('x', { provider: 'p' }))).toBe(false);
    expect(isRetryable(new InvalidAccountNumberError('not-found'))).toBe(false);
    expect(isRetryable(new BankNotFoundError('1'))).toBe(false);
    expect(isRetryable(new DOMException('a', 'AbortError'))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
  });
});

describe('backoffDelay', () => {
  const base = { baseDelayMs: 100, maxDelayMs: 1000, jitter: false, random: () => 0.5 };

  it('doubles each attempt and caps at maxDelayMs', () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(n, base))).toEqual([100, 200, 400, 800, 1000]);
  });

  it('jitter keeps the delay within [50%, 100%] of the step', () => {
    expect(backoffDelay(2, { ...base, jitter: true, random: () => 0 })).toBe(100);
    expect(backoffDelay(2, { ...base, jitter: true, random: () => 1 })).toBe(200);
    expect(backoffDelay(2, { ...base, jitter: true, random: () => 0.5 })).toBe(150);
  });
});

describe('normalizeRetryOptions', () => {
  it('applies defaults', () => {
    const o = normalizeRetryOptions();
    expect(o.retries).toBe(2);
    expect(o.baseDelayMs).toBe(250);
    expect(o.maxDelayMs).toBe(5000);
    expect(o.jitter).toBe(true);
  });

  it.each([{ retries: -1 }, { retries: 1.5 }, { baseDelayMs: -1 }, { maxDelayMs: Number.NaN }, { maxRetryAfterMs: Infinity }])(
    'rejects invalid options %j',
    (bad) => {
      expect(() => normalizeRetryOptions(bad)).toThrow(TypeError);
    },
  );
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const { resolved, delays } = opts();
    const f = failing();
    expect(await withRetry(f.fn, resolved)).toBe('ok');
    expect(f.calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('retries retryable failures with exponential backoff, then succeeds', async () => {
    const { resolved, delays } = opts({ baseDelayMs: 100 });
    const f = failing(retryable(), retryable());
    expect(await withRetry(f.fn, resolved)).toBe('ok');
    expect(f.calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it('gives up after `retries` extra attempts and rethrows the last error', async () => {
    const { resolved, delays } = opts({ retries: 2 });
    const last = retryable();
    const f = failing(retryable(), retryable(), last, retryable());
    const e = await expectRejection(withRetry(f.fn, resolved), ProviderError);
    expect(e).toBe(last);
    expect(f.calls).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it('makes a single attempt when retries is 0', async () => {
    const { resolved, delays } = opts({ retries: 0 });
    const f = failing(retryable());
    await expectRejection(withRetry(f.fn, resolved), ProviderError);
    expect(f.calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it.each([
    ['InvalidAccountNumberError', () => new InvalidAccountNumberError('not-found')],
    ['BankNotFoundError', () => new BankNotFoundError('1')],
    ['non-retryable ProviderError', () => new ProviderError('x', { provider: 'p', status: 401 })],
    ['AbortError', () => new DOMException('aborted', 'AbortError')],
    ['unknown error', () => new Error('weird')],
  ])('never retries %s', async (_name, make) => {
    const { resolved } = opts();
    const f = failing(make());
    await expectRejection(withRetry(f.fn, resolved), Error);
    expect(f.calls).toBe(1);
  });

  it('waits exactly Retry-After for a rate limit', async () => {
    const { resolved, delays } = opts({ baseDelayMs: 10 });
    const f = failing(new RateLimitedError('p', 3000));
    expect(await withRetry(f.fn, resolved)).toBe('ok');
    expect(delays).toEqual([3000]);
  });

  it('fails fast when Retry-After exceeds maxRetryAfterMs', async () => {
    const { resolved, delays } = opts({ maxRetryAfterMs: 5000 });
    const limited = new RateLimitedError('p', 60_000);
    const f = failing(limited);
    const e = await expectRejection(withRetry(f.fn, resolved), RateLimitedError);
    expect(e).toBe(limited);
    expect(f.calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('uses backoff for a rate limit with no Retry-After', async () => {
    const { resolved, delays } = opts({ baseDelayMs: 100 });
    const f = failing(new RateLimitedError('p'));
    await withRetry(f.fn, resolved);
    expect(delays).toEqual([100]);
  });

  it('reports each retry through onRetry', async () => {
    const seen: RetryInfo[] = [];
    const { resolved } = opts({ baseDelayMs: 50, onRetry: (i) => seen.push(i) });
    const err = retryable();
    await withRetry(failing(err, err).fn, resolved);
    expect(seen.map((i) => [i.attempt, i.delayMs])).toEqual([[1, 50], [2, 100]]);
    expect(seen[0]?.error).toBe(err);
  });

  it('passes the attempt number to fn', async () => {
    const { resolved } = opts();
    const attempts: number[] = [];
    await withRetry(async (n) => {
      attempts.push(n);
      if (n < 3) throw retryable();
      return 'ok';
    }, resolved);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('stops waiting when the caller aborts during backoff (default sleep)', async () => {
    const resolved = normalizeRetryOptions({ baseDelayMs: 5000, jitter: false });
    const controller = new AbortController();
    const started = Date.now();
    const promise = withRetry(failing(retryable()).fn, resolved, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const e = await expectRejection(promise, DOMException);
    expect(e.name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
