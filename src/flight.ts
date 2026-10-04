interface Flight<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
}

/**
 * Share one in-flight operation between concurrent callers with the same key.
 *
 * Cancellation is reference-counted: a caller aborting only stops *that
 * caller* waiting. The shared operation's signal aborts when the **last**
 * waiter leaves, so nobody else's request is cancelled and an abandoned
 * request doesn't keep burning rate limit.
 */
export class SingleFlight {
  readonly #flights = new Map<string, Flight<unknown>>();

  join<T>(key: string, factory: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);

    let flight = this.#flights.get(key) as Flight<T> | undefined;
    if (flight === undefined) {
      const controller = new AbortController();
      const created: Flight<T> = {
        controller,
        waiters: 0,
        promise: factory(controller.signal).finally(() => {
          if (this.#flights.get(key) === created) this.#flights.delete(key);
        }),
      };
      this.#flights.set(key, created);
      flight = created;
    }

    const joined = flight;
    joined.waiters++;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const leave = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        joined.waiters--;
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        if (joined.waiters === 0) {
          // Nobody is waiting any more: stop the work and let new callers start fresh.
          if (this.#flights.get(key) === joined) this.#flights.delete(key);
          joined.controller.abort(signal?.reason);
        }
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      joined.promise.then(
        (value) => {
          if (leave()) resolve(value);
        },
        (error: unknown) => {
          if (leave()) reject(error);
        },
      );
    });
  }
}
