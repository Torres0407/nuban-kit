import { createHash } from 'node:crypto';
import type { Bank } from './banks.js';
import { MemoryCacheStore } from './cache.js';
import type { CacheStore } from './cache.js';
import { BankNotFoundError, InvalidAccountNumberError } from './errors.js';
import { SingleFlight } from './flight.js';
import { isRecord } from './http.js';
import { getPossibleBanks, isValidAccountNumberFormat, validateNuban } from './nuban.js';
import type { AccountProvider, ProviderRequestOptions, ResolvedAccount } from './provider.js';
import { ResilientProvider } from './resilience.js';
import type { RetryOptions } from './retry.js';

const HOUR_MS = 60 * 60 * 1000;

export interface CacheConfig {
  /** Where to cache. Defaults to a private `MemoryCacheStore`. Pass your own (e.g. Redis). */
  store?: CacheStore | undefined;
  /** How long resolved account names are cached. Default 1 hour; `0` disables. */
  resolveTtlMs?: number | undefined;
  /** How long the bank list is cached. Default 24 hours; `0` disables. */
  banksTtlMs?: number | undefined;
  /** Key namespace. Default `"nuban-kit:v1"`. */
  keyPrefix?: string | undefined;
  /** Called when the store throws. Cache failures never fail the request. */
  onError?: ((error: unknown, operation: 'get' | 'set') => void) | undefined;
}

export interface NubanClientConfig {
  provider: AccountProvider;
  /**
   * Offline checks to run before spending a provider call.
   * - `"check-digit"` (default): 10-digit format, plus the NUBAN check digit
   *   when the bank code is the standard 3 digits.
   * - `"format"`: 10-digit format only.
   */
  validation?: 'check-digit' | 'format' | undefined;
  /** Cache settings, or `false` to disable caching. Default: in-memory. */
  cache?: CacheConfig | false | undefined;
  /** Per-attempt timeout in ms; `false` disables. Default 10000. */
  timeoutMs?: number | false | undefined;
  /** Retry/backoff policy, or `false` for a single attempt. Default: 2 retries. */
  retry?: RetryOptions | false | undefined;
}

export interface ResolveAccountInput extends ProviderRequestOptions {
  accountNumber: string;
  bankCode: string;
}

export interface ListBanksOptions extends ProviderRequestOptions {
  /** Skip the cache, fetch from the provider, and update the cache. */
  refresh?: boolean | undefined;
}

function ttl(name: string, value: number | undefined, fallback: number): number {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v < 0) {
    throw new TypeError(`cache: "${name}" must be a non-negative finite number.`);
  }
  return v;
}

function decodeBanks(raw: unknown): Bank[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const banks: Bank[] = [];
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || typeof item['code'] !== 'string' || typeof item['name'] !== 'string') {
      return undefined;
    }
    banks.push({ code: item['code'], name: item['name'] });
  }
  return banks;
}

function decodeResolved(accountNumber: string, bankCode: string) {
  return (raw: unknown): ResolvedAccount | undefined => {
    if (
      isRecord(raw) &&
      raw['accountNumber'] === accountNumber &&
      raw['bankCode'] === bankCode &&
      typeof raw['accountName'] === 'string'
    ) {
      return { accountNumber, bankCode, accountName: raw['accountName'] };
    }
    return undefined;
  };
}

export class NubanClient {
  readonly #provider: ResilientProvider;
  readonly #providerName: string;
  readonly #checkDigit: boolean;
  readonly #store: CacheStore | undefined;
  readonly #resolveTtlMs: number;
  readonly #banksTtlMs: number;
  readonly #prefix: string;
  readonly #onCacheError: ((error: unknown, operation: 'get' | 'set') => void) | undefined;
  readonly #flights = new SingleFlight();

  constructor(config: NubanClientConfig) {
    if (!config?.provider) {
      throw new TypeError('NubanClient: "provider" is required.');
    }
    this.#providerName = config.provider.name;
    this.#provider = new ResilientProvider(config.provider, {
      timeoutMs: config.timeoutMs,
      retry: config.retry,
    });
    this.#checkDigit = (config.validation ?? 'check-digit') === 'check-digit';

    const cache = config.cache === false ? undefined : (config.cache ?? {});
    this.#store = cache === undefined ? undefined : (cache.store ?? new MemoryCacheStore());
    this.#resolveTtlMs = cache === undefined ? 0 : ttl('resolveTtlMs', cache.resolveTtlMs, HOUR_MS);
    this.#banksTtlMs = cache === undefined ? 0 : ttl('banksTtlMs', cache.banksTtlMs, 24 * HOUR_MS);
    this.#prefix = cache?.keyPrefix ?? 'nuban-kit:v1';
    this.#onCacheError = cache?.onError;
  }

  /**
   * Resolve the account holder's name. Served from cache when possible;
   * concurrent identical calls share one provider request.
   *
   * @throws {InvalidAccountNumberError} bad format, failed check digit, or not found at that bank
   * @throws {BankNotFoundError} unknown or empty bank code
   * @throws {RateLimitedError} rate limited and retries exhausted (or the wait was too long)
   * @throws {ProviderError} timeout or any other provider failure after retries
   */
  async resolveAccount(input: ResolveAccountInput): Promise<ResolvedAccount> {
    const { accountNumber, bankCode, signal } = input;

    if (typeof bankCode !== 'string' || bankCode.trim() === '') {
      throw new BankNotFoundError(String(bankCode));
    }
    if (!isValidAccountNumberFormat(accountNumber)) {
      throw new InvalidAccountNumberError('format');
    }
    if (this.#checkDigit && /^\d{3}$/.test(bankCode) && !validateNuban(accountNumber, bankCode)) {
      throw new InvalidAccountNumberError('check-digit');
    }

    // The account number is hashed so raw numbers don't sit in key listings.
    // This is obfuscation, not protection (10 digits are trivially brute-forced):
    // the cached value contains the account name, so secure your store.
    const digest = createHash('sha256').update(accountNumber).digest('hex').slice(0, 32);
    const key = `${this.#prefix}:resolve:${this.#providerName}:${encodeURIComponent(bankCode)}:${digest}`;

    return this.#cached({
      key,
      ttlMs: this.#resolveTtlMs,
      decode: decodeResolved(accountNumber, bankCode),
      load: (flightSignal) => this.#provider.resolveAccount({ accountNumber, bankCode, signal: flightSignal }),
      signal,
    });
  }

  /**
   * The provider's bank list. Cached (24h by default); pass `refresh: true`
   * to force a fresh fetch and update the cache.
   */
  async listBanks(options: ListBanksOptions = {}): Promise<Bank[]> {
    const banks = await this.#cached({
      key: `${this.#prefix}:banks:${this.#providerName}`,
      ttlMs: this.#banksTtlMs,
      decode: decodeBanks,
      load: (flightSignal) => this.#provider.listBanks({ signal: flightSignal }),
      signal: options.signal,
      refresh: options.refresh === true,
    });
    return [...banks];
  }

  /**
   * Look up one bank by code in the (cached) provider list.
   * If several entries share a code, the first wins.
   *
   * @throws {BankNotFoundError} when no bank has that code. A bank added very
   *   recently may be missing from a cached list: retry with `refresh: true`.
   */
  async getBank(code: string, options: ListBanksOptions = {}): Promise<Bank> {
    const bank = (await this.listBanks(options)).find((b) => b.code === code);
    if (bank === undefined) throw new BankNotFoundError(code);
    return bank;
  }

  /**
   * Banks this account number could belong to: the offline NUBAN check run
   * against the provider's (cached) bank list. Expect several candidates.
   * Returns `[]` for anything that isn't 10 digits, so it is safe to call
   * on every keystroke.
   */
  async getPossibleBanks(accountNumber: string, options: ListBanksOptions = {}): Promise<Bank[]> {
    if (!isValidAccountNumberFormat(accountNumber)) return [];
    return getPossibleBanks(accountNumber, await this.listBanks(options));
  }

  async #cached<T>(args: {
    key: string;
    ttlMs: number;
    decode: (raw: unknown) => T | undefined;
    load: (signal: AbortSignal) => Promise<T>;
    signal: AbortSignal | undefined;
    refresh?: boolean;
  }): Promise<T> {
    const { key, ttlMs, decode, load, signal, refresh = false } = args;
    signal?.throwIfAborted();

    if (!refresh && ttlMs > 0) {
      const hit = await this.#read(key, decode);
      if (hit !== undefined) return hit;
    }

    return this.#flights.join(
      key,
      async (flightSignal) => {
        const value = await load(flightSignal);
        if (ttlMs > 0) await this.#write(key, value, ttlMs);
        return value;
      },
      signal,
    );
  }

  async #read<T>(key: string, decode: (raw: unknown) => T | undefined): Promise<T | undefined> {
    if (this.#store === undefined) return undefined;
    try {
      const raw = await this.#store.get(key);
      if (raw === undefined || raw === null) return undefined;
      return decode(JSON.parse(raw));
    } catch (error) {
      // Store failure or corrupt entry: treat as a miss.
      this.#onCacheError?.(error, 'get');
      return undefined;
    }
  }

  async #write(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (this.#store === undefined) return;
    try {
      await this.#store.set(key, JSON.stringify(value), ttlMs);
    } catch (error) {
      this.#onCacheError?.(error, 'set');
    }
  }
}
