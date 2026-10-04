import type { Bank } from '../banks.js';
import {
  BankNotFoundError,
  InvalidAccountNumberError,
  ProviderError,
  RateLimitedError,
} from '../errors.js';
import { isAbortError, isRecord, parseRetryAfter } from '../http.js';
import type {
  AccountProvider,
  ProviderRequestOptions,
  ResolveAccountParams,
  ResolvedAccount,
} from '../provider.js';

const PROVIDER = 'paystack';
const DEFAULT_BASE_URL = 'https://api.paystack.co';
const PER_PAGE = 100; // Paystack's maximum
const MAX_PAGES = 20;
const MAX_MESSAGE_LENGTH = 200;

export interface PaystackProviderConfig {
  /** Your Paystack secret key (`sk_live_...` / `sk_test_...`). Never hardcode it. */
  secretKey: string;
  /** Override the API origin (useful for proxies and tests). */
  baseUrl?: string;
  /** Country filter for `listBanks`. Defaults to `"nigeria"`. */
  country?: string;
  /** Custom `fetch` implementation. Defaults to the global `fetch` (Node 20+). */
  fetch?: typeof globalThis.fetch;
}

interface RawResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or `undefined` if the body was empty or not JSON. */
  body: unknown;
}

function messageOf(body: unknown): string | undefined {
  if (isRecord(body) && typeof body['message'] === 'string') {
    return body['message'].slice(0, MAX_MESSAGE_LENGTH);
  }
  return undefined;
}

export class PaystackProvider implements AccountProvider {
  readonly name = PROVIDER;

  // ES private fields keep the key out of console.log / util.inspect / JSON.stringify.
  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #country: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: PaystackProviderConfig) {
    const key = typeof config?.secretKey === 'string' ? config.secretKey.trim() : '';
    if (key === '') {
      throw new TypeError('PaystackProvider: "secretKey" is required.');
    }
    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('PaystackProvider: no global fetch found; use Node 20+ or pass config.fetch.');
    }
    this.#secretKey = key;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#country = config.country ?? 'nigeria';
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async resolveAccount(params: ResolveAccountParams): Promise<ResolvedAccount> {
    const { accountNumber, bankCode, signal } = params;
    const res = await this.#get(
      '/bank/resolve',
      { account_number: accountNumber, bank_code: bankCode },
      signal,
    );

    if (res.ok) {
      const data = isRecord(res.body) && res.body['status'] === true ? res.body['data'] : undefined;
      const name = isRecord(data) ? data['account_name'] : undefined;
      if (typeof name !== 'string' || name.trim() === '') {
        throw this.#unexpected(res.status);
      }
      return { accountNumber, bankCode, accountName: name.trim() };
    }

    // Paystack reports bad input as 4xx with a human-readable message.
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      const message = messageOf(res.body) ?? '';
      if (/bank code/i.test(message)) {
        throw new BankNotFoundError(bankCode);
      }
      if (/could not resolve|account number|not valid|invalid account/i.test(message)) {
        throw new InvalidAccountNumberError('not-found');
      }
    }
    throw this.#failure(res);
  }

  async listBanks(options?: ProviderRequestOptions): Promise<Bank[]> {
    const banks: Bank[] = [];
    const seenCursors = new Set<string>();
    const seenBanks = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string> = {
        country: this.#country,
        use_cursor: 'true',
        perPage: String(PER_PAGE),
      };
      if (cursor !== undefined) query['next'] = cursor;

      const res = await this.#get('/bank', query, options?.signal);
      if (!res.ok) throw this.#failure(res);
      if (!isRecord(res.body) || res.body['status'] !== true || !Array.isArray(res.body['data'])) {
        throw this.#unexpected(res.status);
      }

      for (const item of res.body['data'] as unknown[]) {
        if (!isRecord(item) || item['is_deleted'] === true) continue;
        const { code, name } = item;
        if (typeof code === 'string' && code !== '' && typeof name === 'string' && name !== '') {
          // Paystack occasionally lists the same bank twice. Drop exact repeats, but keep
          // different names that share a code: hiding those would lose information.
          const id = `${code}\u0000${name}`;
          if (seenBanks.has(id)) continue;
          seenBanks.add(id);
          banks.push({ code, name });
        }
      }

      const meta = res.body['meta'];
      const next = isRecord(meta) ? meta['next'] : undefined;
      if (typeof next !== 'string' || next === '') return banks;
      if (seenCursors.has(next)) {
        throw new ProviderError('Paystack returned a repeating pagination cursor.', { provider: PROVIDER });
      }
      seenCursors.add(next);
      cursor = next;
    }
    throw new ProviderError(`Paystack bank list exceeded ${MAX_PAGES} pages.`, { provider: PROVIDER });
  }

  /**
   * Performs the request and handles the failures common to every endpoint:
   * transport errors and 429. Everything else is returned for the caller to classify.
   */
  async #get(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<RawResponse> {
    const url = `${this.#baseUrl}${path}?${new URLSearchParams(query).toString()}`;
    const init: RequestInit = {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.#secretKey}`, Accept: 'application/json' },
    };
    if (signal !== undefined) init.signal = signal;

    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(url, init);
      if (res.status === 429) {
        throw new RateLimitedError(PROVIDER, parseRetryAfter(res.headers.get('retry-after')));
      }
      text = await res.text();
    } catch (cause) {
      if (cause instanceof RateLimitedError || isAbortError(cause)) throw cause;
      throw new ProviderError('Network error while contacting Paystack.', {
        provider: PROVIDER,
        retryable: true,
        cause,
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, ok: res.ok, body };
  }

  #failure(res: RawResponse): ProviderError {
    const authFailure = res.status === 401 || res.status === 403;
    const retryable = res.status >= 500 || res.status === 408 || res.status === 425;
    return new ProviderError(
      authFailure
        ? `Paystack rejected the credentials (HTTP ${res.status}). Check your secret key.`
        : `Paystack request failed (HTTP ${res.status}).`,
      { provider: PROVIDER, status: res.status, providerMessage: messageOf(res.body), retryable },
    );
  }

  #unexpected(status: number): ProviderError {
    return new ProviderError('Paystack returned an unexpected response shape.', {
      provider: PROVIDER,
      status,
    });
  }
}
