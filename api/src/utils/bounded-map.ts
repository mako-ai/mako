/**
 * A Map with a size cap (least-recently-used entries go first) and an
 * optional time-to-live, for module-level caches that would otherwise grow
 * with every workspace/user the process ever sees.
 *
 * Only for caches: an evicted entry must be safe to recompute (a cache
 * miss, or a throttle that fires once more). Recency is refreshed by `get`
 * and `set`; `has` honours expiry but does not refresh.
 *
 *   const cache = new BoundedMap<string, Value>({ maxEntries: 500, ttlMs: 10 * 60_000 });
 */
export class BoundedMap<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: {
    maxEntries: number;
    /** Entries older than this read as absent. Omit for no expiry. */
    ttlMs?: number;
    /** Clock, for tests. */
    now?: () => number;
  }) {
    if (!Number.isFinite(options.maxEntries) || options.maxEntries < 1) {
      throw new Error("BoundedMap: maxEntries must be at least 1");
    }
    this.maxEntries = Math.floor(options.maxEntries);
    this.ttlMs = options.ttlMs ?? Infinity;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.live(key) !== undefined;
  }

  get(key: K): V | undefined {
    const entry = this.live(key);
    if (!entry) return undefined;
    // Re-insert: Map iteration order is insertion order, so the first key
    // is always the least recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): this {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private live(key: K): { value: V; expiresAt: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
