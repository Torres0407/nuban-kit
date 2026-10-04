import { describe, expect, it } from 'vitest';
import { ProviderError, RateLimitedError, ResilientProvider } from '../src/index.js';
import type { AccountProvider, ResolveAccountParams, ResolvedAccount } from '../src/index.js';
import { callWithTimeout } from '../src/timeout.js';
import { expectRejection, sleepNow } from './helpers.js';

const OK: ResolvedAccount = { accountNumber: '1234567896', bankCode: '058', accountName: 'ADA OBI' };
const params = { accountNumber: '1234567896', bankCode: '058' };

type Step = ResolvedAccount | Error | 'hang' | ((p: ResolveAccountParams) => Promise<ResolvedAccount>);

/** Provider following a script; the last step repeats. 'hang' ignores the signal entirely. */
function scripted(...steps: Step[]) {
  const calls: ResolveAccountParams[] = [];
  const provider: AccountProvider = {
    name: 'scripted',
    async resolveAccount(p) {
      calls.push(p);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step === 'hang') return new Promise<ResolvedAccount>(() => undefined);
      if (step instanceof Error) throw step;
      if (typeof step === 'function') return step(p);
      if (step === undefined) throw new Error('empty script');
      return step;
    },
    async listBanks() {
      return [{ code: '058', name: 'GTBank' }];
    },
  };
  return { provider, calls };
}

const retryable = () => new ProviderError('down', { provider: 'scripted', retryable: true });

describe('callWithTimeout', () => {
  it('returns the result when fast enough', async () => {
    expect(await callWithTimeout(async () => 'ok', { timeoutMs: 1000, provider: 'p' })).toBe('ok');
  });

  it('rejects with a retryable ProviderError even if the op ignores the signal', async () => {
    const started = Date.now();
    const e = await expectRejection(
      callWithTimeout(() => new Promise<string>(() => undefined), { timeoutMs: 30, provider: 'p' }),
      ProviderError,
    );
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/timed out after 30ms/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('aborts the signal handed to the op on timeout', async () => {
    let seen: AbortSignal | undefined;
    await expectRejection(
      callWithTimeout((s) => ((seen = s), new Promise<string>(() => undefined)), { timeoutMs: 20, provider: 'p' }),
      ProviderError,
    );
    expect(seen?.aborted).toBe(true);
  });

  it('rejects at once if the caller already aborted, without calling the op', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await expectRejection(
      callWithTimeout(async () => ((called = true), 'x'), { timeoutMs: 1000, provider: 'p', signal: controller.signal }),
      DOMException,
    );
    expect(called).toBe(false);
  });

  it('propagates a caller abort as-is (not as a ProviderError)', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const promise = callWithTimeout((s) => ((seen = s), new Promise<string>(() => undefined)), {
      timeoutMs: 5000,
      provider: 'p',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const e = await expectRejection(promise, DOMException);
    expect(e.name).toBe('AbortError');
    expect(seen?.aborted).toBe(true);
  });

  it('has no deadline when timeoutMs is undefined', async () => {
    const result = await callWithTimeout(() => new Promise<string>((r) => setTimeout(() => r('late'), 40)), {
      timeoutMs: undefined,
      provider: 'p',
    });
    expect(result).toBe('late');
  });
});

describe('ResilientProvider', () => {
  it('forwards the name and passes through success', async () => {
    const { provider, calls } = scripted(OK);
    const r = new ResilientProvider(provider);
    expect(r.name).toBe('scripted');
    expect(await r.resolveAccount(params)).toEqual(OK);
    expect(calls).toHaveLength(1);
  });

  it('retries retryable failures then succeeds', async () => {
    const delays: number[] = [];
    const { provider, calls } = scripted(retryable(), retryable(), OK);
    const r = new ResilientProvider(provider, {
      retry: { baseDelayMs: 100, jitter: false, sleep: async (ms) => void delays.push(ms) },
    });
    expect(await r.resolveAccount(params)).toEqual(OK);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });

  it('gives every attempt a fresh abort signal', async () => {
    const { provider, calls } = scripted(retryable(), OK);
    await new ResilientProvider(provider, { retry: { sleep: sleepNow } }).resolveAccount(params);
    expect(calls[0]?.signal).not.toBe(calls[1]?.signal);
  });

  it('times out each attempt separately and retries', async () => {
    const { provider, calls } = scripted('hang', OK);
    const r = new ResilientProvider(provider, { timeoutMs: 30, retry: { sleep: sleepNow } });
    expect(await r.resolveAccount(params)).toEqual(OK);
    expect(calls).toHaveLength(2);
  });

  it('surfaces the timeout once attempts are exhausted', async () => {
    const { provider, calls } = scripted('hang');
    const r = new ResilientProvider(provider, { timeoutMs: 20, retry: { retries: 1, sleep: sleepNow } });
    const e = await expectRejection(r.resolveAccount(params), ProviderError);
    expect(e.message).toMatch(/timed out/);
    expect(calls).toHaveLength(2);
  });

  it('does not retry non-retryable failures', async () => {
    const { provider, calls } = scripted(new ProviderError('bad key', { provider: 'scripted', status: 401 }));
    await expectRejection(new ResilientProvider(provider, { retry: { sleep: sleepNow } }).resolveAccount(params), ProviderError);
    expect(calls).toHaveLength(1);
  });

  it('honours Retry-After on rate limits', async () => {
    const delays: number[] = [];
    const { provider } = scripted(new RateLimitedError('scripted', 1200), OK);
    const r = new ResilientProvider(provider, { retry: { sleep: async (ms) => void delays.push(ms) } });
    await r.resolveAccount(params);
    expect(delays).toEqual([1200]);
  });

  it('makes a single attempt when retry is false', async () => {
    const { provider, calls } = scripted(retryable(), OK);
    await expectRejection(new ResilientProvider(provider, { retry: false }).resolveAccount(params), ProviderError);
    expect(calls).toHaveLength(1);
  });

  it('retries listBanks too', async () => {
    let n = 0;
    const provider: AccountProvider = {
      name: 'p',
      resolveAccount: async () => OK,
      listBanks: async () => {
        if (n++ === 0) throw retryable();
        return [{ code: '044', name: 'Access' }];
      },
    };
    const r = new ResilientProvider(provider, { retry: { sleep: sleepNow } });
    expect(await r.listBanks()).toEqual([{ code: '044', name: 'Access' }]);
  });

  it('stops retrying when the caller aborts', async () => {
    const controller = new AbortController();
    const { provider, calls } = scripted(retryable());
    const r = new ResilientProvider(provider, {
      retry: { sleep: async () => void controller.abort(), retries: 5 },
    });
    const promise = r.resolveAccount({ ...params, signal: controller.signal });
    const e = await expectRejection(promise, Error);
    expect(e.name).toBe('AbortError');
    expect(calls).toHaveLength(1);
  });

  it.each([0, -5, Number.NaN, Infinity])('rejects an invalid timeoutMs (%d)', (timeoutMs) => {
    expect(() => new ResilientProvider(scripted(OK).provider, { timeoutMs })).toThrow(TypeError);
  });
});
