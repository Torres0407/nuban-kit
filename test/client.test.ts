import { describe, expect, it } from 'vitest';
import {
  BankNotFoundError,
  InvalidAccountNumberError,
  NubanClient,
  PaystackProvider,
  ProviderError,
} from '../src/index.js';
import type { AccountProvider, Bank, ResolveAccountParams, ResolvedAccount } from '../src/index.js';
import { expectRejection, json, mockFetch } from './helpers.js';

/** A hand-rolled provider that records calls. Stands in for any future provider. */
function fakeProvider(overrides: Partial<AccountProvider> = {}) {
  const resolveCalls: ResolveAccountParams[] = [];
  const provider: AccountProvider = {
    name: 'fake',
    async resolveAccount(params) {
      resolveCalls.push(params);
      return { accountNumber: params.accountNumber, bankCode: params.bankCode, accountName: 'FAKE NAME' };
    },
    async listBanks() {
      return [{ code: '058', name: 'GTBank' }];
    },
    ...overrides,
  };
  return { provider, resolveCalls };
}

// 1234567896 is a valid NUBAN for bank 058 (see nuban.test.ts).
const VALID = { accountNumber: '1234567896', bankCode: '058' };

describe('NubanClient construction', () => {
  it('requires a provider', () => {
    expect(() => new NubanClient({} as never)).toThrow(TypeError);
  });
});

describe('NubanClient.resolveAccount offline validation', () => {
  it('rejects a bad format without calling the provider', async () => {
    const { provider, resolveCalls } = fakeProvider();
    const client = new NubanClient({ provider });
    const e = await expectRejection(client.resolveAccount({ accountNumber: '12345', bankCode: '058' }), InvalidAccountNumberError);
    expect(e.reason).toBe('format');
    expect(resolveCalls).toHaveLength(0);
  });

  it('rejects a failed check digit without calling the provider', async () => {
    const { provider, resolveCalls } = fakeProvider();
    const client = new NubanClient({ provider });
    const e = await expectRejection(client.resolveAccount({ accountNumber: '1234567890', bankCode: '058' }), InvalidAccountNumberError);
    expect(e.reason).toBe('check-digit');
    expect(resolveCalls).toHaveLength(0);
  });

  it('skips the check digit when validation is "format"', async () => {
    const { provider, resolveCalls } = fakeProvider();
    const client = new NubanClient({ provider, validation: 'format' });
    await client.resolveAccount({ accountNumber: '1234567890', bankCode: '058' });
    expect(resolveCalls).toHaveLength(1);
  });

  it('skips the check digit for non-3-digit bank codes (fintechs / MFBs)', async () => {
    const { provider, resolveCalls } = fakeProvider();
    const client = new NubanClient({ provider });
    await client.resolveAccount({ accountNumber: '1234567890', bankCode: '999992' });
    expect(resolveCalls).toHaveLength(1);
  });

  it.each(['', '   '])('rejects an empty bank code (%j) as BankNotFoundError', async (bankCode) => {
    const { provider, resolveCalls } = fakeProvider();
    const client = new NubanClient({ provider });
    await expectRejection(client.resolveAccount({ accountNumber: '1234567896', bankCode }), BankNotFoundError);
    expect(resolveCalls).toHaveLength(0);
  });
});

describe('NubanClient.resolveAccount delegation', () => {
  it('returns the provider result and gives the provider an abort signal', async () => {
    const { provider, resolveCalls } = fakeProvider();
    const controller = new AbortController();
    const result: ResolvedAccount = await new NubanClient({ provider }).resolveAccount({ ...VALID, signal: controller.signal });

    expect(result).toEqual({ ...VALID, accountName: 'FAKE NAME' });
    expect(resolveCalls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('propagates provider errors unchanged', async () => {
    const failure = new ProviderError('down', { provider: 'fake', retryable: true });
    const { provider } = fakeProvider({
      async resolveAccount() {
        throw failure;
      },
    });
    const e = await expectRejection(new NubanClient({ provider, retry: false }).resolveAccount(VALID), ProviderError);
    expect(e).toBe(failure);
  });

  it('delegates listBanks', async () => {
    const { provider } = fakeProvider();
    const banks: Bank[] = await new NubanClient({ provider }).listBanks();
    expect(banks).toEqual([{ code: '058', name: 'GTBank' }]);
  });
});

describe('NubanClient + PaystackProvider (end to end, mocked HTTP)', () => {
  it('resolves an account name', async () => {
    const mock = mockFetch(json(200, { status: true, message: 'Account number resolved', data: { account_number: '1234567896', account_name: 'ADA OBI', bank_id: 9 } }));
    const client = new NubanClient({ provider: new PaystackProvider({ secretKey: 'sk_test_x', fetch: mock.fetch }) });

    const result = await client.resolveAccount(VALID);
    expect(result.accountName).toBe('ADA OBI');
    expect(mock.calls).toHaveLength(1);
  });

  it('never reaches the network for an offline-invalid account', async () => {
    const mock = mockFetch();
    const client = new NubanClient({ provider: new PaystackProvider({ secretKey: 'sk_test_x', fetch: mock.fetch }) });

    await expectRejection(client.resolveAccount({ accountNumber: '1234567890', bankCode: '058' }), InvalidAccountNumberError);
    expect(mock.calls).toHaveLength(0);
  });
});
