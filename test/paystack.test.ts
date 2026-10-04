import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  BankNotFoundError,
  InvalidAccountNumberError,
  PaystackProvider,
  ProviderError,
  RateLimitedError,
} from '../src/index.js';
import { expectRejection, headerOf, json, mockFetch, text } from './helpers.js';

const KEY = 'sk_test_super_secret_key';

const resolveOk = (name = 'JOHN DOE') =>
  json(200, {
    status: true,
    message: 'Account number resolved',
    data: { account_number: '1234567896', account_name: name, bank_id: 9 },
  });

function provider(...queue: Parameters<typeof mockFetch>) {
  const mock = mockFetch(...queue);
  return { p: new PaystackProvider({ secretKey: KEY, fetch: mock.fetch }), calls: mock.calls };
}

const input = { accountNumber: '1234567896', bankCode: '058' };

describe('PaystackProvider construction', () => {
  it.each(['', '   '])('rejects a blank secretKey (%j)', (secretKey) => {
    expect(() => new PaystackProvider({ secretKey })).toThrow(TypeError);
  });

  it('rejects a missing secretKey', () => {
    expect(() => new PaystackProvider({} as never)).toThrow(TypeError);
  });

  it('does not expose the key via inspect or JSON', () => {
    const { p } = provider();
    expect(inspect(p, { showHidden: true, depth: 5 })).not.toContain(KEY);
    expect(JSON.stringify(p)).not.toContain(KEY);
  });

  it('reports its name', () => {
    expect(provider().p.name).toBe('paystack');
  });
});

describe('PaystackProvider.resolveAccount', () => {
  it('sends an authenticated GET with encoded query params and maps the result', async () => {
    const { p, calls } = provider(resolveOk('  JOHN DOE  '));
    const result = await p.resolveAccount(input);

    expect(result).toEqual({ accountNumber: '1234567896', bankCode: '058', accountName: 'JOHN DOE' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.paystack.co/bank/resolve?account_number=1234567896&bank_code=058');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(headerOf(calls[0], 'Authorization')).toBe(`Bearer ${KEY}`);
  });

  it('honours a custom baseUrl and tolerates trailing slashes', async () => {
    const mock = mockFetch(resolveOk());
    const p = new PaystackProvider({ secretKey: KEY, baseUrl: 'https://proxy.example.com/', fetch: mock.fetch });
    await p.resolveAccount(input);
    expect(mock.calls[0]?.url.startsWith('https://proxy.example.com/bank/resolve?')).toBe(true);
  });

  it('forwards the abort signal to fetch', async () => {
    const { p, calls } = provider(resolveOk());
    const controller = new AbortController();
    await p.resolveAccount({ ...input, signal: controller.signal });
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it('maps "could not resolve" (422) to InvalidAccountNumberError(not-found)', async () => {
    const { p } = provider(json(422, { status: false, message: 'Could not resolve account name. Check parameters or try again.' }));
    const e = await expectRejection(p.resolveAccount(input), InvalidAccountNumberError);
    expect(e.reason).toBe('not-found');
  });

  it('maps an invalid bank code to BankNotFoundError', async () => {
    const { p } = provider(json(400, { status: false, message: 'Invalid Bank Code' }));
    const e = await expectRejection(p.resolveAccount({ ...input, bankCode: '000' }), BankNotFoundError);
    expect(e.bankCode).toBe('000');
  });

  it('maps 401 to a non-retryable ProviderError without leaking the key', async () => {
    const { p } = provider(json(401, { status: false, message: 'Invalid key' }));
    const e = await expectRejection(p.resolveAccount(input), ProviderError);
    expect(e.status).toBe(401);
    expect(e.retryable).toBe(false);
    expect(e.providerMessage).toBe('Invalid key');
    expect(e.message).not.toContain(KEY);
  });

  it('maps 5xx (even with a non-JSON body) to a retryable ProviderError', async () => {
    const { p } = provider(text(500, 'Internal Server Error'));
    const e = await expectRejection(p.resolveAccount(input), ProviderError);
    expect(e.status).toBe(500);
    expect(e.retryable).toBe(true);
    expect(e.providerMessage).toBeUndefined();
  });

  it('treats an unrecognised 4xx as a non-retryable ProviderError', async () => {
    const { p } = provider(json(400, { status: false, message: 'Something odd' }));
    const e = await expectRejection(p.resolveAccount(input), ProviderError);
    expect(e.retryable).toBe(false);
    expect(e.providerMessage).toBe('Something odd');
  });

  it('maps 429 to RateLimitedError with Retry-After', async () => {
    const { p } = provider(json(429, { status: false, message: 'slow down' }, { 'retry-after': '2' }));
    const e = await expectRejection(p.resolveAccount(input), RateLimitedError);
    expect(e.retryAfterMs).toBe(2000);
  });

  it('maps 429 without Retry-After to RateLimitedError with undefined delay', async () => {
    const { p } = provider(text(429, ''));
    const e = await expectRejection(p.resolveAccount(input), RateLimitedError);
    expect(e.retryAfterMs).toBeUndefined();
  });

  it('wraps network failures as retryable ProviderError, preserving the cause', async () => {
    const cause = new TypeError('fetch failed');
    const { p } = provider(cause);
    const e = await expectRejection(p.resolveAccount(input), ProviderError);
    expect(e.retryable).toBe(true);
    expect(e.cause).toBe(cause);
  });

  it('lets AbortError through unchanged', async () => {
    const abort = new DOMException('The operation was aborted', 'AbortError');
    const { p } = provider(abort);
    const e = await expectRejection(p.resolveAccount(input), DOMException);
    expect(e).toBe(abort);
  });

  it('rejects a 200 with an unexpected shape', async () => {
    const { p } = provider(json(200, { status: true, data: {} }));
    await expectRejection(p.resolveAccount(input), ProviderError);
  });

  it('rejects a 200 with status:false', async () => {
    const { p } = provider(json(200, { status: false, data: { account_name: 'X' } }));
    await expectRejection(p.resolveAccount(input), ProviderError);
  });

  it('rejects a 200 with a non-JSON body', async () => {
    const { p } = provider(text(200, '<html>oops</html>'));
    await expectRejection(p.resolveAccount(input), ProviderError);
  });
});

describe('PaystackProvider.listBanks', () => {
  const bank = (code: string, name: string, extra: Record<string, unknown> = {}) => ({ code, name, ...extra });

  it('requests Nigeria with cursor pagination and maps code + name', async () => {
    const { p, calls } = provider(
      json(200, { status: true, data: [bank('044', 'Access Bank', { slug: 'access-bank' }), bank('058', 'GTBank')], meta: { perPage: 100 } }),
    );
    const banks = await p.listBanks();

    expect(banks).toEqual([
      { code: '044', name: 'Access Bank' },
      { code: '058', name: 'GTBank' },
    ]);
    expect(calls[0]?.url).toBe('https://api.paystack.co/bank?country=nigeria&use_cursor=true&perPage=100');
  });

  it('follows the next cursor until it is absent', async () => {
    const { p, calls } = provider(
      json(200, { status: true, data: [bank('044', 'Access Bank')], meta: { next: 'abc=' } }),
      json(200, { status: true, data: [bank('058', 'GTBank')], meta: { next: 'def=' } }),
      json(200, { status: true, data: [bank('057', 'Zenith Bank')], meta: { next: null } }),
    );
    const banks = await p.listBanks();

    expect(banks.map((b) => b.code)).toEqual(['044', '058', '057']);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toContain('next=abc%3D');
    expect(calls[2]?.url).toContain('next=def%3D');
  });

  it('uses a configured country', async () => {
    const mock = mockFetch(json(200, { status: true, data: [] }));
    await new PaystackProvider({ secretKey: KEY, country: 'ghana', fetch: mock.fetch }).listBanks();
    expect(mock.calls[0]?.url).toContain('country=ghana');
  });

  it('skips deleted and malformed entries', async () => {
    const { p } = provider(
      json(200, {
        status: true,
        data: [bank('044', 'Access Bank'), bank('011', 'Old Bank', { is_deleted: true }), { code: 12, name: 'Bad' }, { name: 'No code' }, null, bank('', 'Empty')],
      }),
    );
    expect(await p.listBanks()).toEqual([{ code: '044', name: 'Access Bank' }]);
  });

    it('drops exact duplicate entries but keeps different banks that share a code', async () => {
    const { p } = provider(
      json(200, {
        status: true,
        data: [bank('057', 'Zenith Bank'), bank('057', 'Zenith Bank'), bank('51253', 'YCT MFB'), bank('51253', 'Stellas MFB')],
      }),
    );
    expect(await p.listBanks()).toEqual([
      { code: '057', name: 'Zenith Bank' },
      { code: '51253', name: 'YCT MFB' },
      { code: '51253', name: 'Stellas MFB' },
    ]);
  });

  it('dedupes across pages too', async () => {
    const { p } = provider(
      json(200, { status: true, data: [bank('057', 'Zenith Bank')], meta: { next: 'n1' } }),
      json(200, { status: true, data: [bank('057', 'Zenith Bank'), bank('058', 'GTBank')] }),
    );
    expect((await p.listBanks()).map((b) => b.code)).toEqual(['057', '058']);
  });
  
  it('fails the whole call if a later page fails (no partial lists)', async () => {
    const { p } = provider(
      json(200, { status: true, data: [bank('044', 'Access Bank')], meta: { next: 'abc' } }),
      json(503, { status: false, message: 'down' }),
    );
    const e = await expectRejection(p.listBanks(), ProviderError);
    expect(e.retryable).toBe(true);
  });

  it('detects a repeating cursor instead of looping forever', async () => {
    const page = () => json(200, { status: true, data: [bank('044', 'Access Bank')], meta: { next: 'same' } });
    const { p, calls } = provider(page(), page(), page());
    await expectRejection(p.listBanks(), ProviderError);
    expect(calls).toHaveLength(2);
  });

  it('rejects an unexpected response shape', async () => {
    const { p } = provider(json(200, { status: true, data: 'nope' }));
    await expectRejection(p.listBanks(), ProviderError);
  });

  it('maps 401 and 429 like resolveAccount does', async () => {
    await expectRejection(provider(json(401, { status: false, message: 'bad key' })).p.listBanks(), ProviderError);
    await expectRejection(provider(text(429, '')).p.listBanks(), RateLimitedError);
  });
});
