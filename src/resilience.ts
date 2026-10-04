import type { Bank } from './banks.js';
import type {
  AccountProvider,
  ProviderRequestOptions,
  ResolveAccountParams,
  ResolvedAccount,
} from './provider.js';
import { normalizeRetryOptions, withRetry } from './retry.js';
import type { ResolvedRetryOptions, RetryOptions } from './retry.js';
import { callWithTimeout } from './timeout.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface ResilienceOptions {
  /** Per-attempt timeout. `false` disables it. Default 10000ms. */
  timeoutMs?: number | false | undefined;
  /** Retry policy, or `false` for a single attempt. */
  retry?: RetryOptions | false | undefined;
}

/**
 * Wraps any `AccountProvider` with a per-attempt timeout and retries with
 * exponential backoff. Rate limits are retried too, honouring `Retry-After`.
 *
 * Only retryable failures are retried (see `isRetryable`); validation errors
 * and "account not found" are never retried.
 */
export class ResilientProvider implements AccountProvider {
  readonly name: string;
  readonly #inner: AccountProvider;
  readonly #timeoutMs: number | undefined;
  readonly #retry: ResolvedRetryOptions;

  constructor(inner: AccountProvider, options: ResilienceOptions = {}) {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeout !== false && (!Number.isFinite(timeout) || timeout <= 0)) {
      throw new TypeError('"timeoutMs" must be a positive finite number, or false to disable.');
    }
    this.#inner = inner;
    this.name = inner.name;
    this.#timeoutMs = timeout === false ? undefined : timeout;
    this.#retry = normalizeRetryOptions(options.retry === false ? { retries: 0 } : options.retry);
  }

  resolveAccount(params: ResolveAccountParams): Promise<ResolvedAccount> {
    const { signal, ...rest } = params;
    return this.#run((s) => this.#inner.resolveAccount({ ...rest, signal: s }), signal);
  }

  listBanks(options?: ProviderRequestOptions): Promise<Bank[]> {
    return this.#run((s) => this.#inner.listBanks({ signal: s }), options?.signal);
  }

  #run<T>(op: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    return withRetry(
      () => callWithTimeout(op, { timeoutMs: this.#timeoutMs, provider: this.name, signal }),
      this.#retry,
      signal,
    );
  }
}
