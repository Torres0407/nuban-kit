type MaybePromise<T> = T | Promise<T>;

/**
 * Minimal key-value store used for caching. Values are strings (nuban-kit
 * serialises to JSON itself), so a Redis adapter is a few lines:
 *
 * ```ts
 * const store: CacheStore = {
 *   get: (key) => redis.get(key),                         // null = miss
 *   set: (key, value, ttlMs) => redis.set(key, value, 'PX', ttlMs),
 *   delete: (key) => redis.del(key),
 * };
 * ```
 *
 * Return types are deliberately loose so client libraries can be passed
 * through without wrapping their return values.
 */
export interface CacheStore {
  /** Resolve to the stored string, or `undefined`/`null` on a miss. */
  get(key: string): MaybePromise<string | undefined | null>;
  /** Store `value` for `ttlMs` milliseconds (always > 0). */
  set(key: string, value: string, ttlMs: number): MaybePromise<unknown>;
  delete(key: string): MaybePromise<unknown>;
}

export interface MemoryCacheStoreOptions {
  /** Maximum entries before the least-recently-used is evicted. Default 1000. */
  maxEntries?: number;
  /** Clock override (ms since epoch), mainly for tests. */
  now?: () => number;
}

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * In-process TTL cache with LRU eviction. No timers are used (so it never
 * keeps the process alive); expired entries are dropped when touched or
 * evicted when the store is full.
 */
export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: MemoryCacheStoreOptions = {}) {
    const max = options.maxEntries ?? 1000;
    if (!Number.isInteger(max) || max < 1) {
      throw new TypeError('MemoryCacheStore: "maxEntries" must be a positive integer.');
    }
    this.#maxEntries = max;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): string | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency: Map iterates in insertion order.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string, ttlMs: number): void {
    this.#entries.delete(key);
    if (!(ttlMs > 0)) return;
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Entries currently held, including expired ones not yet touched. */
  get size(): number {
    return this.#entries.size;
  }
}
