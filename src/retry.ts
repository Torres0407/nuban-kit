import { ProviderError, RateLimitedError } from './errors.js';

export interface RetryInfo {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** How long we will wait before the next attempt. */
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  /** Extra attempts after the first. Default 2 (so up to 3 attempts). */
  retries?: number | undefined;
  /** First backoff step. Doubles each retry. Default 250ms. */
  baseDelayMs?: number | undefined;
  /** Upper bound for a single backoff step. Default 5000ms. */
  maxDelayMs?: number | undefined;
  /**
   * If a rate-limited provider asks us to wait longer than this, give up
   * immediately with `RateLimitedError` instead of blocking the caller.
   * Default 10000ms.
   */
  maxRetryAfterMs?: number | undefined;
  /** Randomise each delay between 50% and 100% of its step. Default true. */
  jitter?: boolean | undefined;
  /** Called before each wait; handy for logging/metrics. */
  onRetry?: ((info: RetryInfo) => void) | undefined;
  /** Replace the wait (tests). Must reject if `signal` aborts. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Replace `Math.random` (tests). */
  random?: (() => number) | undefined;
}

export interface ResolvedRetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  jitter: boolean;
  onRetry: ((info: RetryInfo) => void) | undefined;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
}

function nonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`retry: "${name}" must be a non-negative finite number.`);
  }
  return value;
}

export function normalizeRetryOptions(options: RetryOptions = {}): ResolvedRetryOptions {
  const retries = options.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new TypeError('retry: "retries" must be a non-negative integer.');
  }
  return {
    retries,
    baseDelayMs: nonNegative('baseDelayMs', options.baseDelayMs ?? 250),
    maxDelayMs: nonNegative('maxDelayMs', options.maxDelayMs ?? 5000),
    maxRetryAfterMs: nonNegative('maxRetryAfterMs', options.maxRetryAfterMs ?? 10_000),
    jitter: options.jitter ?? true,
    onRetry: options.onRetry,
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
  };
}

/** Rate limits and failures the provider marked retryable. Nothing else. */
export function isRetryable(error: unknown): boolean {
  return error instanceof RateLimitedError || (error instanceof ProviderError && error.retryable);
}

/**
 * Exponential backoff for the n-th failed attempt (1-based):
 * `min(maxDelay, base * 2^(n-1))`, optionally jittered into [50%, 100%].
 */
export function backoffDelay(
  failedAttempt: number,
  options: Pick<ResolvedRetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitter' | 'random'>,
): number {
  const step = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (failedAttempt - 1));
  return options.jitter ? Math.round(step / 2 + (options.random() * step) / 2) : step;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn`, retrying retryable failures with exponential backoff.
 *
 * - A `RateLimitedError` with `retryAfterMs` waits exactly that long (or fails
 *   fast if it exceeds `maxRetryAfterMs`).
 * - Validation errors, non-retryable provider errors and aborts are rethrown at once.
 * - When attempts run out, the last error is rethrown.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: ResolvedRetryOptions,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt > options.retries || !isRetryable(error)) throw error;

      let delayMs = backoffDelay(attempt, options);
      if (error instanceof RateLimitedError && error.retryAfterMs !== undefined) {
        if (error.retryAfterMs > options.maxRetryAfterMs) throw error;
        delayMs = error.retryAfterMs;
      }

      options.onRetry?.({ attempt, delayMs, error });
      await options.sleep(delayMs, signal);
    }
  }
}
