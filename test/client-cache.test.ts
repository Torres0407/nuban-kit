import { describe, expect, it } from 'vitest';
import {
  BankNotFoundError,
  MemoryCacheStore,
  NubanClient,
  PaystackProvider,
  ProviderError,
  RateLimitedError,
} from '../src/index.js';
import type { AccountProvider, Bank, CacheStore, ResolveAccountParams } from '../src/index.js';
import { expectRejection, hangUntilAborted, json, mockFetch, sleepNow, text } from './helpers.js';

const VALID = { accountNumber: '1234567896', bankCode: '058' }; // valid NUBAN for 058
const BANKS: Bank[] = [
  { code: '044', name: 'Access Bank' },
  { code: '058', name: 'GTBank' },
];

/** Counting provider. `delayMs` lets tests overlap calls. */
function counting(opts: { delayMs?: number; fail?: Error } = {}) {
  const state = { resolves: 0, lists: 0, lastParams: undefined as ResolveAccountParams | undefined, bankList: BANKS };
  const wait = () => new Promise<void>((r) => setTimeout(r, opts.delayMs ?? 0));
  const provider: AccountProvider = {
    name: 'counting',
    async resolveAccount(p) {
      state.resolves++;
      state.lastParams = p;
      await wait();
      if (opts.fail) throw opts.fail;
      return { accountNumber: p.accountNumber, bankCode: p.bankCode, accountName: `NAME ${state.resolves}` };
    },
    async listBanks() {
      state.lists++;
      await wait();
      return state.bankList;
    },
  };
  return { provider, state };
}

/** A store you can inspect and sabotage, standing in for Redis. */
function spyStore() {
  const data = new Map<string, string>();
  const sets: Array<{ key: string; value: string; ttlMs: number }> = [];
  const store: CacheStore = {
    get: (k) => data.get(k) ?? null,
    set: (k, v, ttlMs) => (data.set(k, v), sets.push({ key: k, value: v, ttlMs }), 'OK'),
    delete: (k) => data.delete(k),
  };
  return { store, data, sets };
}

describe('resolveAccount caching', () => {
  it('serves repeat calls from cache', async () => {
    const { provider, state } = counting();
    const client = new NubanClient({ provider });
    const a = await client.resolveAccount(VALID);
    const b = await client.resolveAccount(VALID);
    expect(b).toEqual(a);
    expect(state.resolves).toBe(1);
  });

  it('keys by bank and account', async () => {
    const { provider, state } = counting();
    const client = new NubanClient({ provider, validation: 'format' });
    await client.resolveAccount(VALID);
    await client.resolveAccount({ ...VALID, bankCode: '044' });
    await client.resolveAccount({ accountNumber: '0000000017', bankCode: '058' });
    expect(state.resolves).toBe(3);
  });

  it('expires after resolveTtlMs', async () => {
    const clock = { t: 0 };
    const store = new MemoryCacheStore({ now: () => clock.t });
    const { provider, state } = counting();
    const client = new NubanClient({ provider, cache: { store, resolveTtlMs: 1000 } });
    await client.resolveAccount(VALID);
    clock.t = 999;
    await client.resolveAccount(VALID);
    expect(state.resolves).toBe(1);
    clock.t = 1000;
    await client.resolveAccount(VALID);
    expect(state.resolves).toBe(2);
  });

  it.each([
    ['resolveTtlMs: 0', { resolveTtlMs: 0 }],
    ['cache: false', false as const],
  ])('does not cache with %s', async (_label, cache) => {
    const { provider, state } = counting();
    const client = new NubanClient({ provider, cache });
    await client.resolveAccount(VALID);
    await client.resolveAccount(VALID);
    expect(state.resolves).toBe(2);
  });

  it('does not cache failures', async () => {
    let fail = true;
    const { provider } = counting();
    const flaky: AccountProvider = {
      ...provider,
      resolveAccount: async (p) => {
        if (fail) throw new ProviderError('nope', { provider: 'counting' });
        return provider.resolveAccount(p);
      },
    };
    const client = new NubanClient({ provider: flaky, retry: false });
    await expectRejection(client.resolveAccount(VALID), ProviderError);
    fail = false;
    expect((await client.resolveAccount(VALID)).accountName).toMatch(/NAME/);
  });

  it('writes JSON strings with the TTL to a pluggable store, without the raw account number in the key', async () => {
    const { store, sets } = spyStore();
    const { provider } = counting();
    await new NubanClient({ provider, cache: { store, resolveTtlMs: 5000 } }).resolveAccount(VALID);

    expect(sets).toHaveLength(1);
    expect(sets[0]?.ttlMs).toBe(5000);
    expect(sets[0]?.key.startsWith('nuban-kit:v1:resolve:counting:058:')).toBe(true);
    expect(sets[0]?.key).not.toContain(VALID.accountNumber);
    expect(JSON.parse(sets[0]?.value ?? 'null').accountNumber).toBe(VALID.accountNumber);
  });

  it('honours a custom keyPrefix', async () => {
    const { store, sets } = spyStore();
    await new NubanClient({ provider: counting().provider, cache: { store, keyPrefix: 'myapp' } }).resolveAccount(VALID);
    expect(sets[0]?.key.startsWith('myapp:resolve:')).toBe(true);
  });

  it('reads from a pre-populated store (e.g. another process wrote it)', async () => {
    const { store, data } = spyStore();
    const { provider, state } = counting();
    const client = new NubanClient({ provider, cache: { store } });
    await client.resolveAccount(VALID);
    // a second client sharing the same store gets a hit
    const other = new NubanClient({ provider, cache: { store } });
    await other.resolveAccount(VALID);
    expect(state.resolves).toBe(1);
    expect(data.size).toBe(1);
  });

  it('survives a broken store and reports it via onError', async () => {
    const errors: Array<[unknown, string]> = [];
    const broken: CacheStore = {
      get: () => {
        throw new Error('redis down');
      },
      set: async () => {
        throw new Error('redis down');
      },
      delete: () => undefined,
    };
    const { provider, state } = counting();
    const client = new NubanClient({ provider, cache: { store: broken, onError: (e, op) => errors.push([e, op]) } });
    expect((await client.resolveAccount(VALID)).accountName).toMatch(/NAME/);
    expect(state.resolves).toBe(1);
    expect(errors.map(([, op]) => op)).toEqual(['get', 'set']);
  });

  it.each(['not json', '{"accountNumber":"1111111111","bankCode":"058","accountName":"WRONG"}', '[1,2]', '{"accountName":5}'])(
    'ignores a corrupt or mismatched cache entry (%s)',
    async (bad) => {
      const { store, data } = spyStore();
      const { provider, state } = counting();
      const client = new NubanClient({ provider, cache: { store } });
      await client.resolveAccount(VALID);
      const [key] = [...data.keys()];
      data.set(key ?? '', bad);
      const result = await client.resolveAccount(VALID);
      expect(state.resolves).toBe(2);
      expect(result.accountNumber).toBe(VALID.accountNumber);
    },
  );
});

describe('single-flight', () => {
  it('shares one provider call between concurrent identical requests', async () => {
    const { provider, state } = counting({ delayMs: 30 });
    const client = new NubanClient({ provider, cache: false });
    const [a, b, c] = await Promise.all([client.resolveAccount(VALID), client.resolveAccount(VALID), client.resolveAccount(VALID)]);
    expect(state.resolves).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('shares a failure, then allows a fresh attempt afterwards', async () => {
    const err = new ProviderError('down', { provider: 'counting' });
    const { provider, state } = counting({ delayMs: 20, fail: err });
    const client = new NubanClient({ provider, retry: false });
    const results = await Promise.allSettled([client.resolveAccount(VALID), client.resolveAccount(VALID)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(state.resolves).toBe(1);
    await expectRejection(client.resolveAccount(VALID), ProviderError);
    expect(state.resolves).toBe(2);
  });

  it("one caller's abort does not cancel the others", async () => {
    const { provider, state } = counting({ delayMs: 40 });
    const client = new NubanClient({ provider });
    const controller = new AbortController();
    const quitter = client.resolveAccount({ ...VALID, signal: controller.signal });
    const stayer = client.resolveAccount(VALID);
    setTimeout(() => controller.abort(), 5);
    const e = await expectRejection(quitter, DOMException);
    expect(e.name).toBe('AbortError');
    expect((await stayer).accountName).toMatch(/NAME/);
    expect(state.resolves).toBe(1);
  });

  it('aborts the underlying request when the sole caller aborts, and a new call starts fresh', async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const provider: AccountProvider = {
      name: 'abortable',
      async resolveAccount(p) {
        calls++;
        if (p.signal) signals.push(p.signal);
        if (calls > 1) return { accountNumber: p.accountNumber, bankCode: p.bankCode, accountName: 'SECOND' };
        return new Promise((_, reject) => p.signal?.addEventListener('abort', () => reject(p.signal?.reason), { once: true }));
      },
      listBanks: async () => BANKS,
    };
    const client = new NubanClient({ provider, cache: false, retry: false });
    const controller = new AbortController();
    const first = client.resolveAccount({ ...VALID, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expectRejection(first, DOMException);
    expect(signals[0]?.aborted).toBe(true);
    expect((await client.resolveAccount(VALID)).accountName).toBe('SECOND');
    expect(calls).toBe(2);
  });

  it('keeps the shared request alive until the LAST waiter leaves', async () => {
    let providerSignal: AbortSignal | undefined;
    const provider: AccountProvider = {
      name: 'shared',
      resolveAccount: (p) =>
        new Promise((_, reject) => {
          providerSignal = p.signal;
          p.signal?.addEventListener('abort', () => reject(p.signal?.reason), { once: true });
        }),
      listBanks: async () => BANKS,
    };
    const client = new NubanClient({ provider, cache: false, retry: false });
    const a = new AbortController();
    const b = new AbortController();
    const pa = client.resolveAccount({ ...VALID, signal: a.signal });
    const pb = client.resolveAccount({ ...VALID, signal: b.signal });
    await new Promise((r) => setTimeout(r, 5));
    a.abort();
    await expectRejection(pa, DOMException);
    expect(providerSignal?.aborted).toBe(false);
    b.abort();
    await expectRejection(pb, DOMException);
    expect(providerSignal?.aborted).toBe(true);
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const { provider, state } = counting();
    const controller = new AbortController();
    controller.abort();
    await expectRejection(new NubanClient({ provider }).resolveAccount({ ...VALID, signal: controller.signal }), DOMException);
    expect(state.resolves).toBe(0);
  });
});

describe('bank list helper', () => {
  it('caches the list and returns copies', async () => {
    const { provider, state } = counting();
    const client = new NubanClient({ provider });
    const first = await client.listBanks();
    first.pop();
    const second = await client.listBanks();
    expect(second).toEqual(BANKS);
    expect(state.lists).toBe(1);
  });

  it('refresh: true bypasses the cache and updates it', async () => {
    const { provider, state } = counting();
    const client = new NubanClient({ provider });
    await client.listBanks();
    state.bankList = [...BANKS, { code: '101', name: 'Providus Bank' }];
    expect(await client.listBanks()).toHaveLength(2);
    expect(await client.listBanks({ refresh: true })).toHaveLength(3);
    expect(await client.listBanks()).toHaveLength(3);
    expect(state.lists).toBe(2);
  });

  it('expires after banksTtlMs', async () => {
    const clock = { t: 0 };
    const { provider, state } = counting();
    const client = new NubanClient({
      provider,
      cache: { store: new MemoryCacheStore({ now: () => clock.t }), banksTtlMs: 500 },
    });
    await client.listBanks();
    clock.t = 500;
    await client.listBanks();
    expect(state.lists).toBe(2);
  });

  it('getBank finds a bank by code, or throws BankNotFoundError', async () => {
    const { provider, state } = counting();
    const client = new NubanClient({ provider });
    expect(await client.getBank('058')).toEqual({ code: '058', name: 'GTBank' });
    const e = await expectRejection(client.getBank('999'), BankNotFoundError);
    expect(e.bankCode).toBe('999');
    expect(state.lists).toBe(1);
  });

  it('getBank can refresh to pick up a newly added bank', async () => {
    const { provider, state } = counting();
    const client = new NubanClient({ provider });
    await expectRejection(client.getBank('101'), BankNotFoundError);
    state.bankList = [...BANKS, { code: '101', name: 'Providus Bank' }];
    expect((await client.getBank('101', { refresh: true })).name).toBe('Providus Bank');
  });

  it('getPossibleBanks runs the offline check against the provider list', async () => {
    const { provider, state } = counting();
    state.bankList = [...BANKS, { code: '999992', name: 'Fintech' }];
    const client = new NubanClient({ provider });
    const codes = (await client.getPossibleBanks('1234567896')).map((b) => b.code);
    expect(codes).toContain('058');
    expect(codes).not.toContain('999992');
  });

  it('getPossibleBanks returns [] for incomplete input without calling the provider', async () => {
    const { provider, state } = counting();
    const client = new NubanClient({ provider });
    expect(await client.getPossibleBanks('12345')).toEqual([]);
    expect(state.lists).toBe(0);
  });
});

describe('config validation', () => {
  it.each([{ resolveTtlMs: -1 }, { banksTtlMs: Number.NaN }, { resolveTtlMs: Infinity }])('rejects invalid cache config %j', (cache) => {
    expect(() => new NubanClient({ provider: counting().provider, cache })).toThrow(TypeError);
  });

  it('rejects an invalid timeout', () => {
    expect(() => new NubanClient({ provider: counting().provider, timeoutMs: 0 })).toThrow(TypeError);
  });
});

describe('NubanClient + PaystackProvider resilience (mocked HTTP)', () => {
  const ok = () => json(200, { status: true, data: { account_name: 'ADA OBI' } });
  const make = (mock: ReturnType<typeof mockFetch>, extra: Partial<ConstructorParameters<typeof NubanClient>[0]> = {}) =>
    new NubanClient({
      provider: new PaystackProvider({ secretKey: 'sk_test_x', fetch: mock.fetch }),
      retry: { sleep: sleepNow },
      ...extra,
    });

  it('retries a 503 and then succeeds', async () => {
    const mock = mockFetch(text(503, 'unavailable'), ok());
    expect((await make(mock).resolveAccount(VALID)).accountName).toBe('ADA OBI');
    expect(mock.calls).toHaveLength(2);
  });

  it('retries a network error and then succeeds', async () => {
    const mock = mockFetch(new TypeError('fetch failed'), ok());
    await make(mock).resolveAccount(VALID);
    expect(mock.calls).toHaveLength(2);
  });

  it('waits for Retry-After on a 429, then succeeds', async () => {
    const delays: number[] = [];
    const mock = mockFetch(json(429, { status: false }, { 'retry-after': '2' }), ok());
    const client = make(mock, { retry: { sleep: async (ms) => void delays.push(ms) } });
    await client.resolveAccount(VALID);
    expect(delays).toEqual([2000]);
  });

  it('surfaces RateLimitedError when Retry-After is too long', async () => {
    const mock = mockFetch(json(429, { status: false }, { 'retry-after': '120' }));
    const e = await expectRejection(make(mock).resolveAccount(VALID), RateLimitedError);
    expect(e.retryAfterMs).toBe(120_000);
    expect(mock.calls).toHaveLength(1);
  });

  it('gives up after the retry budget and rethrows the last ProviderError', async () => {
    const mock = mockFetch(text(500, 'a'), text(502, 'b'), text(503, 'c'), text(500, 'd'));
    const e = await expectRejection(make(mock).resolveAccount(VALID), ProviderError);
    expect(e.status).toBe(503);
    expect(mock.calls).toHaveLength(3);
  });

  it('does not retry a rejected key', async () => {
    const mock = mockFetch(json(401, { status: false, message: 'Invalid key' }));
    await expectRejection(make(mock).resolveAccount(VALID), ProviderError);
    expect(mock.calls).toHaveLength(1);
  });

  it('does not retry "account not found"', async () => {
    const mock = mockFetch(json(422, { status: false, message: 'Could not resolve account name' }));
    await expectRejection(make(mock).resolveAccount(VALID), Error);
    expect(mock.calls).toHaveLength(1);
  });

  it('times out a hung request and aborts the underlying fetch', async () => {
    const mock = mockFetch(hangUntilAborted);
    const client = make(mock, { timeoutMs: 30, retry: false });
    const e = await expectRejection(client.resolveAccount(VALID), ProviderError);
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/timed out/);
    expect((mock.calls[0]?.init?.signal as AbortSignal).aborted).toBe(true);
  });

  it('retries after a timeout and succeeds', async () => {
    const mock = mockFetch(hangUntilAborted, ok());
    const result = await make(mock, { timeoutMs: 30 }).resolveAccount(VALID);
    expect(result.accountName).toBe('ADA OBI');
    expect(mock.calls).toHaveLength(2);
  });

  it('caches across the full stack: one HTTP call for repeated resolves', async () => {
    const mock = mockFetch(ok());
    const client = make(mock);
    await client.resolveAccount(VALID);
    await client.resolveAccount(VALID);
    expect(mock.calls).toHaveLength(1);
  });

  it('lists banks across pages through the full stack and caches the result', async () => {
    const mock = mockFetch(
      json(200, { status: true, data: [{ code: '044', name: 'Access Bank' }], meta: { next: 'n1' } }),
      json(200, { status: true, data: [{ code: '058', name: 'GTBank' }], meta: {} }),
    );
    const client = make(mock);
    expect((await client.listBanks()).map((b) => b.code)).toEqual(['044', '058']);
    await client.listBanks();
    expect(mock.calls).toHaveLength(2);
  });
});
