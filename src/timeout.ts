import { ProviderError } from './errors.js';

export interface TimeoutOptions {
  /** `undefined` disables the timeout (caller abort still works). */
  timeoutMs: number | undefined;
  /** Provider name, for the error. */
  provider: string;
  /** Caller cancellation. */
  signal?: AbortSignal | undefined;
}

const noop = () => undefined;

/**
 * Run `op` with a deadline and caller cancellation.
 *
 * `op` receives a signal that aborts on timeout or caller abort. The result is
 * also *raced* against both, so a provider that ignores the signal still
 * can't hang the caller.
 *
 * - Timeout: rejects with a retryable `ProviderError`.
 * - Caller abort: rejects with the caller's abort reason, untouched.
 */
export async function callWithTimeout<T>(
  op: (signal: AbortSignal) => Promise<T>,
  options: TimeoutOptions,
): Promise<T> {
  const { timeoutMs, provider, signal: caller } = options;
  caller?.throwIfAborted();

  const controller = new AbortController();
  let rejectGuard: (reason: unknown) => void = noop;
  const guard = new Promise<never>((_, reject) => {
    rejectGuard = reject;
  });
  guard.catch(noop); // never an unhandled rejection if nobody is racing anymore

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeCallerListener: () => void = noop;

  if (caller !== undefined) {
    const onAbort = () => {
      rejectGuard(caller.reason);
      controller.abort(caller.reason);
    };
    caller.addEventListener('abort', onAbort, { once: true });
    removeCallerListener = () => caller.removeEventListener('abort', onAbort);
  }

  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      const message = `${provider} request timed out after ${timeoutMs}ms.`;
      // Reject the guard first so the timeout, not the resulting AbortError, wins the race.
      rejectGuard(new ProviderError(message, { provider, retryable: true }));
      controller.abort(new DOMException(message, 'TimeoutError'));
    }, timeoutMs);
  }

  try {
    const work = (async () => op(controller.signal))();
    work.catch(noop); // the loser of the race must not surface as unhandled
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
    removeCallerListener();
  }
}
