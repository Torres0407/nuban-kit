# nuban-kit

Nigerian bank account verification for Node.js and TypeScript.

- **Offline NUBAN validation**: the standard check-digit algorithm, plus "which banks could this number belong to?". No network, no API key.
- **Account name resolution** through a provider API (Paystack today; the provider is an interface, so Flutterwave and others can be added).
- **Bank list helper** that can be refreshed from the provider.
- **Built for production**: pluggable cache (in-memory or Redis), retries with exponential backoff, timeouts, `Retry-After` handling, and de-duplication of concurrent identical requests.
- **Typed errors** you can `instanceof` or switch on.
- Zero runtime dependencies. ESM and CommonJS. Node 20+.

> **Status:** pre-1.0. The API may change in minor versions; see the [changelog](./CHANGELOG.md).

## Install

```sh
npm install nuban-kit
```

Requires Node.js 20 or newer (it uses the built-in `fetch`).

## Quick start

```ts
import { NubanClient, PaystackProvider } from 'nuban-kit';

const client = new NubanClient({
  provider: new PaystackProvider({ secretKey: process.env.PAYSTACK_SECRET_KEY! }),
});

// Illustrative: 0000000018 passes the offline check for GTBank (058) but is not a real account;
// replace it with an account you are allowed to check to get a real name back.
const account = await client.resolveAccount({ accountNumber: '0000000018', bankCode: '058' });
console.log(account.accountName);
```

Your secret key always comes from your own config: `nuban-kit` never reads environment variables and has no default key. Keep it server-side.

CommonJS works too:

```js
const { NubanClient, PaystackProvider } = require('nuban-kit');
```

A complete runnable script is in [`examples/resolve-account.ts`](./examples/resolve-account.ts).

## Offline validation

These functions need no network and no key.

```ts
import { validateNuban, getPossibleBanks, computeCheckDigit } from 'nuban-kit';

validateNuban('0000000018', '058'); // true:  consistent with GTBank's code
validateNuban('0000000019', '058'); // false: wrong check digit

computeCheckDigit('058', '000000001'); // 8

getPossibleBanks('0000000018');
// [{ code: '058', name: 'Guaranty Trust Bank' }, ...possibly a few others]
```

The algorithm multiplies the 12 digits of `bankCode + first 9 account digits` by the weights `3,7,3,3,7,3,3,7,3,3,7,3`, sums them, and the check digit is `10 - (sum mod 10)` (10 becomes 0).

Things to understand about it:

- **A pass means "consistent", not "exists".** Only the provider can confirm an account is real.
- **`getPossibleBanks` returns several candidates.** The check digit is one decimal digit, so about 1 in 10 banks match by chance. Use it to narrow a dropdown or catch typos, not to identify a bank.
- **It only covers 3-digit CBN bank codes.** Microfinance banks and fintechs use longer codes (5-6 digits), and their account numbers often don't follow NUBAN at all. They are skipped by the offline functions.
- **Account numbers must be strings.** They can start with `0`, so numbers are rejected rather than silently losing leading zeros.
- The bundled DEFAULT_BANKS is a snapshot of the 57 banks Paystack lists with 3-digit codes (October 2026). Banks merge and licences change, so for current data use the provider-backed client.getPossibleBanks() below, or pass your own list to getPossibleBanks(accountNumber, banks).

## Resolving an account name

```ts
const account = await client.resolveAccount({
  accountNumber: '0000000018',
  bankCode: '058',
});
// { accountNumber: '0000000018', bankCode: '058', accountName: 'ADA OBI' }
```

Before spending an API call, `resolveAccount` checks the account number's format and (for 3-digit bank codes) its check digit, and throws `InvalidAccountNumberError` immediately if they fail. Set `validation: 'format'` to skip the check-digit step.

Pass an `AbortSignal` to cancel:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 2000);
await client.resolveAccount({ accountNumber: '0000000018', bankCode: '058', signal: controller.signal });
```

## Bank list

```ts
const banks = await client.listBanks();              // cached for 24h by default
const fresh = await client.listBanks({ refresh: true }); // force a refresh from the provider

const gtb = await client.getBank('058');             // throws BankNotFoundError if absent

// Offline check run against the provider's bank list. Returns [] unless the
// input is 10 digits, so it is safe to call on every keystroke.
const candidates = await client.getPossibleBanks('0000000018');
```

If several entries share a code, `getBank` returns the first. A bank added very recently may be missing from a cached list; use `{ refresh: true }`.

## Caching

Resolved names are cached for 1 hour and the bank list for 24 hours, in memory, by default.

```ts
const client = new NubanClient({
  provider,
  cache: {
    resolveTtlMs: 10 * 60 * 1000, // 10 minutes. 0 disables caching of names.
    banksTtlMs: 6 * 60 * 60 * 1000,
  },
});

const noCache = new NubanClient({ provider, cache: false });
```

### Using Redis (or anything else)

A cache store is three methods with string values:

```ts
import Redis from 'ioredis';
import { NubanClient } from 'nuban-kit';
import type { CacheStore } from 'nuban-kit';

const redis = new Redis(process.env.REDIS_URL!);

const store: CacheStore = {
  get: (key) => redis.get(key), // null / undefined = miss
  set: (key, value, ttlMs) => redis.set(key, value, 'PX', ttlMs),
  delete: (key) => redis.del(key),
};

const client = new NubanClient({
  provider,
  cache: { store, onError: (error, op) => console.warn('cache', op, error) },
});
```

If the store throws, the request still succeeds (it is treated as a cache miss) and `onError` is called. Corrupt entries are ignored the same way.

> **Privacy:** cached values contain account holder names. Account numbers are hashed in cache keys so raw numbers don't appear in key listings, but this is obfuscation only (10-digit numbers are easy to brute-force). Treat a shared cache as holding personal data: restrict access and keep TTLs short.

## Reliability

Every provider call goes through, in order: a per-attempt timeout, then retries with exponential backoff. Concurrent identical requests share a single call.

```ts
const client = new NubanClient({
  provider,
  timeoutMs: 5000,            // per attempt; default 10000; false disables
  retry: {
    retries: 2,               // extra attempts after the first (default 2)
    baseDelayMs: 250,         // doubles each retry (default 250)
    maxDelayMs: 5000,         // cap for one backoff step (default 5000)
    maxRetryAfterMs: 10_000,  // give up instead of waiting longer than this (default 10000)
    onRetry: ({ attempt, delayMs, error }) => console.warn('retrying', attempt, delayMs, error),
  },
});

const singleAttempt = new NubanClient({ provider, retry: false });
```

What is retried, and what is not:

| Situation | Retried? |
| --- | --- |
| Network error, timeout, HTTP 5xx, 408, 425 | Yes |
| Rate limited (HTTP 429) | Yes, waiting exactly `Retry-After` when the provider sends it |
| `Retry-After` longer than `maxRetryAfterMs` | No: `RateLimitedError` is thrown immediately so your request doesn't hang |
| Account not found, bad bank code, rejected API key, other 4xx | No |
| Caller abort (`AbortSignal`) | No, and it also interrupts a backoff wait |

Notes:

- **Worst-case latency with the defaults is roughly 3 × 10s plus backoff (about 31s).** For interactive flows, use something like `timeoutMs: 4000, retry: { retries: 1 }`.
- **Cancellation is shared fairly.** If several callers are waiting on the same request, one caller aborting only stops *that caller* waiting; the underlying request is aborted when the *last* waiter leaves.
- Rate-limit handling is reactive (it honours the provider's 429s). There is no proactive client-side rate limiter; the cache and request de-duplication reduce how often you hit the limit.

## Errors

All errors extend `NubanKitError` and carry a stable `code`. Messages never contain account numbers or API keys.

```ts
import {
  BankNotFoundError,
  InvalidAccountNumberError,
  ProviderError,
  RateLimitedError,
  isNubanKitError,
} from 'nuban-kit';

try {
  await client.resolveAccount({ accountNumber, bankCode });
} catch (error) {
  if (error instanceof InvalidAccountNumberError) {
    // error.reason: 'format' | 'check-digit' | 'not-found'
  } else if (error instanceof BankNotFoundError) {
    // error.bankCode
  } else if (error instanceof RateLimitedError) {
    // error.retryAfterMs (may be undefined)
  } else if (error instanceof ProviderError) {
    // error.status, error.providerMessage, error.retryable, error.cause
  } else {
    throw error; // includes caller aborts (AbortError), which are never wrapped
  }
}
```

| Class | `code` | Meaning |
| --- | --- | --- |
| `InvalidAccountNumberError` | `INVALID_ACCOUNT_NUMBER` | Bad format, failed check digit, or the provider could not resolve the account at that bank (see `reason`) |
| `BankNotFoundError` | `BANK_NOT_FOUND` | Empty or unrecognised bank code |
| `ProviderError` | `PROVIDER_ERROR` | Provider failure, timeout, or unusable response (see `status`, `retryable`) |
| `RateLimitedError` | `RATE_LIMITED` | Provider rate limit, after retries were exhausted or the wait was too long |

Use `isNubanKitError(e)` to check for any of them.

> If your process loads *both* the ESM and the CommonJS build of this package (for example through a mix of `import` and `require` in dependencies), the two copies have separate error classes and `instanceof` will not match across them. Switch on `error.code` instead; it is stable in either case.

## Writing another provider

`PaystackProvider` is one implementation of `AccountProvider`. To add another (Flutterwave, a bank's own API, a mock), implement the interface and throw nuban-kit's typed errors:

```ts
import {
  InvalidAccountNumberError,
  NubanClient,
  ProviderError,
  RateLimitedError,
} from 'nuban-kit';
import type { AccountProvider, Bank, ProviderRequestOptions, ResolveAccountParams, ResolvedAccount } from 'nuban-kit';

class ExampleProvider implements AccountProvider {
  readonly name = 'example';

  constructor(private readonly apiKey: string) {}

  async resolveAccount({ accountNumber, bankCode, signal }: ResolveAccountParams): Promise<ResolvedAccount> {
    const res = await fetch(`https://api.example.com/resolve?account=${accountNumber}&bank=${bankCode}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      ...(signal ? { signal } : {}),
    });
    if (res.status === 429) throw new RateLimitedError(this.name);
    if (res.status === 404) throw new InvalidAccountNumberError('not-found');
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, { provider: this.name, status: res.status, retryable: res.status >= 500 });
    const body = (await res.json()) as { name: string };
    return { accountNumber, bankCode, accountName: body.name };
  }

  async listBanks(_options?: ProviderRequestOptions): Promise<Bank[]> {
    return [{ code: '058', name: 'Guaranty Trust Bank' }];
  }
}

const client = new NubanClient({ provider: new ExampleProvider(process.env.EXAMPLE_KEY ?? '') });
```

Set `retryable` honestly: the client only retries what the provider says is retryable. Let `AbortError` propagate unchanged. The `name` is used in errors and cache keys.

## API reference

### Offline functions

| Function | Description |
| --- | --- |
| `validateNuban(accountNumber: string, bankCode: string): boolean` | True if the 10-digit number passes the check-digit test for the 3-digit bank code. Never throws. |
| `computeCheckDigit(bankCode: string, serialNumber: string): number \| null` | Check digit (0-9) for a 3-digit bank code and 9-digit serial; `null` if either is malformed. |
| `isValidAccountNumberFormat(value: unknown): value is string` | True for a string of exactly 10 digits. |
| `getPossibleBanks(accountNumber: string, banks?: readonly Bank[]): Bank[]` | Banks whose code validates the number. Defaults to `DEFAULT_BANKS`; skips non-3-digit codes; `[]` for malformed input. |

Also exported: `DEFAULT_BANKS`, `NUBAN_LENGTH` (10), `BANK_CODE_LENGTH` (3), and the `Bank` type (`{ readonly code: string; readonly name: string }`).

### `new NubanClient(config)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `AccountProvider` | required | e.g. a `PaystackProvider` |
| `validation` | `'check-digit' \| 'format'` | `'check-digit'` | Offline checks before calling the provider |
| `cache` | `CacheConfig \| false` | in-memory | See below |
| `timeoutMs` | `number \| false` | `10000` | Per-attempt timeout |
| `retry` | `RetryOptions \| false` | 2 retries | See [Reliability](#reliability) |

`CacheConfig`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `store` | `CacheStore` | new `MemoryCacheStore` | Where to cache |
| `resolveTtlMs` | `number` | `3600000` (1h) | `0` disables caching names |
| `banksTtlMs` | `number` | `86400000` (24h) | `0` disables caching the bank list |
| `keyPrefix` | `string` | `'nuban-kit:v1'` | Key namespace |
| `onError` | `(error, 'get' \| 'set') => void` | none | Called when the store throws |

Methods:

| Method | Description |
| --- | --- |
| `resolveAccount({ accountNumber, bankCode, signal? }): Promise<ResolvedAccount>` | Resolve the holder's name. Throws the typed errors above. |
| `listBanks({ refresh?, signal? }): Promise<Bank[]>` | The provider's bank list, cached. Returns a copy. |
| `getBank(code, { refresh?, signal? }): Promise<Bank>` | One bank by exact code; throws `BankNotFoundError`. |
| `getPossibleBanks(accountNumber, { refresh?, signal? }): Promise<Bank[]>` | Offline check against the provider's list; `[]` for malformed input. |

Invalid config (negative TTL, `timeoutMs: 0`, etc.) throws a `TypeError` at construction.

### `new PaystackProvider(config)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `secretKey` | `string` | required | Your Paystack secret key. A blank value throws `TypeError`. Held in a private field, so it doesn't appear in logs or `JSON.stringify`. |
| `baseUrl` | `string` | `https://api.paystack.co` | Override for proxies/tests |
| `country` | `string` | `'nigeria'` | Country filter for the bank list |
| `fetch` | `typeof fetch` | global `fetch` | Custom fetch implementation |

It uses `GET /bank/resolve` for names and cursor-paginated `GET /bank` for the bank list (every page is fetched; a failure mid-way throws rather than returning a partial list).

You can use the provider on its own (`provider.resolveAccount(...)`, `provider.listBanks()`), but then you don't get caching, retries or timeouts. Wrap it with `ResilientProvider` for those without the client:

```ts
import { PaystackProvider, ResilientProvider } from 'nuban-kit';

const resilient = new ResilientProvider(new PaystackProvider({ secretKey: process.env.PAYSTACK_SECRET_KEY! }), {
  timeoutMs: 5000,
  retry: { retries: 1 },
});
```

### Interfaces

```ts
interface AccountProvider {
  readonly name: string;
  resolveAccount(params: ResolveAccountParams): Promise<ResolvedAccount>;
  listBanks(options?: ProviderRequestOptions): Promise<Bank[]>;
}

interface ResolveAccountParams { accountNumber: string; bankCode: string; signal?: AbortSignal }
interface ResolvedAccount { accountNumber: string; bankCode: string; accountName: string }

interface CacheStore {
  get(key: string): string | undefined | null | Promise<string | undefined | null>;
  set(key: string, value: string, ttlMs: number): unknown;
  delete(key: string): unknown;
}
```

`MemoryCacheStore` (`new MemoryCacheStore({ maxEntries?: number, now?: () => number })`) is a TTL + LRU in-process store (default 1000 entries) with `get`, `set`, `delete`, `clear()` and `size`. It uses no timers, so it never keeps your process alive.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test            # Vitest; all HTTP is mocked, no network or keys needed
npm run build       # tsup: dist/ with ESM, CJS and .d.ts
npm run check:package   # publint + are-the-types-wrong against the built package
```

## Releasing

See [RELEASING.md](./RELEASING.md).

## License

[MIT](./LICENSE)
