/**
 * The one cache every engine keeps its live connections in (pools, clients,
 * Cloud SQL connectors): keyed by string, with
 *
 *  - in-flight dedupe: concurrent first callers for a key share ONE
 *    creation, instead of each building a pool and all but the last leaking;
 *  - invalidation: `close(key)` / `closeConnection(id)` drop the entry
 *    BEFORE closing it (a caller arriving meanwhile builds afresh rather than
 *    being handed something that is closing), and a creation still in flight
 *    is closed once it lands instead of being stored;
 *  - an idle sweep: entries unused for longer than a limit are closed.
 *
 * Not a BoundedMap (utils/bounded-map.ts): an entry here holds sockets, so
 * nothing may be dropped without being closed.
 *
 * Keys are `${connectionId}:${databaseName}` for per-database pools, or the
 * bare connection id; `closeConnection(id)` closes both forms.
 */
import { loggers } from "../logging";

const logger = loggers.db();

export interface CachedConnection<V> {
  readonly value: V;
  /** Epoch ms of the last use: refreshed by `acquire` and `touch`. */
  lastUsed: number;
}

export interface ConnectionCacheOptions<V> {
  /** What is cached, for log lines ("PostgreSQL pool"). */
  name: string;
  /** Release whatever the value holds. Errors are logged, never thrown. */
  close: (value: V, key: string) => Promise<void> | void;
  /** An entry still in use is skipped by the idle sweep. */
  isBusy?: (value: V) => boolean;
  /** Clock, for tests. */
  now?: () => number;
}

export class ConnectionCache<V> {
  private readonly entries = new Map<string, CachedConnection<V>>();
  private readonly pending = new Map<string, Promise<V>>();
  private readonly now: () => number;

  constructor(private readonly options: ConnectionCacheOptions<V>) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Keys of the settled entries. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Keys still being created. */
  pendingKeys(): string[] {
    return [...this.pending.keys()];
  }

  /** The entry for `key` as is (does not count as a use). */
  entry(key: string): CachedConnection<V> | undefined {
    return this.entries.get(key);
  }

  entryList(): Array<[string, CachedConnection<V>]> {
    return [...this.entries.entries()];
  }

  /** The cached value, counted as a use; undefined when there is none. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastUsed = this.now();
    return entry.value;
  }

  /** Count a use of `key` (keeps it from the idle sweep). */
  touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastUsed = this.now();
  }

  /** Store a value created outside `acquire`. */
  set(key: string, value: V): void {
    this.entries.set(key, { value, lastUsed: this.now() });
  }

  /**
   * The cached value for `key`, or the one `create` makes. Concurrent
   * callers share a creation in flight. A value whose key was closed while
   * it was being created is returned to its callers but not stored (the
   * `close` that retired the key closes it).
   */
  acquire(key: string, create: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const creating: Promise<V> = create()
      .then(value => {
        if (this.pending.get(key) === creating) this.set(key, value);
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === creating) this.pending.delete(key);
      });
    this.pending.set(key, creating);
    return creating;
  }

  /**
   * Drop the entry for `key` if (and only if) it still holds `value`: an
   * old value's late close/error event must not evict its replacement.
   * Returns whether it did. Does not close anything.
   */
  forget(key: string, value: V): boolean {
    if (this.entries.get(key)?.value !== value) return false;
    this.entries.delete(key);
    return true;
  }

  /** Close the entry for `key` and any creation in flight for it. */
  async close(key: string): Promise<void> {
    await this.closeKeys([key]);
  }

  /**
   * Close everything cached for a connection: the bare `connectionId` key
   * and every `${connectionId}:…` key.
   */
  async closeConnection(connectionId: string): Promise<void> {
    const prefix = `${connectionId}:`;
    await this.closeMatching(
      key => key === connectionId || key.startsWith(prefix),
    );
  }

  async closeMatching(match: (key: string) => boolean): Promise<void> {
    const keys = new Set(
      [...this.entries.keys(), ...this.pending.keys()].filter(match),
    );
    await this.closeKeys([...keys]);
  }

  async closeAll(): Promise<void> {
    await this.closeMatching(() => true);
  }

  /**
   * Close entries unused for longer than `maxIdleMs` (and not busy).
   * Returns the keys it closed.
   */
  async sweepIdle(maxIdleMs: number): Promise<string[]> {
    const now = this.now();
    const idle = (entry: CachedConnection<V>) =>
      now - entry.lastUsed > maxIdleMs &&
      !(this.options.isBusy?.(entry.value) ?? false);
    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => idle(entry))
      .map(([key]) => key);
    const closed: string[] = [];
    for (const key of candidates) {
      // Re-checked: a use between the passes keeps the entry.
      const entry = this.entries.get(key);
      if (!entry || !idle(entry)) continue;
      // Deleted BEFORE closing, so a request arriving meanwhile connects
      // afresh, and nothing after the await can evict that new entry.
      this.entries.delete(key);
      await this.closeValue(entry.value, key, "idle");
      closed.push(key);
    }
    return closed;
  }

  private async closeKeys(keys: string[]): Promise<void> {
    const work: Promise<void>[] = [];
    for (const key of keys) {
      const creating = this.pending.get(key);
      if (creating) {
        // Removed first: the creation then never stores its value.
        this.pending.delete(key);
        work.push(
          creating.then(
            value => this.closeValue(value, key),
            () => undefined, // A failed creation left nothing to close.
          ),
        );
      }
      const entry = this.entries.get(key);
      if (entry) {
        this.entries.delete(key);
        work.push(this.closeValue(entry.value, key));
      }
    }
    await Promise.all(work);
  }

  private async closeValue(
    value: V,
    key: string,
    reason?: "idle",
  ): Promise<void> {
    try {
      await this.options.close(value, key);
      logger.debug(`Closed ${reason ? "idle " : ""}${this.options.name}`, {
        key,
      });
    } catch (error) {
      logger.error(`Error closing ${this.options.name}`, { key, error });
    }
  }
}
