/**
 * Kernel session registry — the shared store that lets any API instance find a
 * notebook's live kernel.
 *
 * Prod runs many stateless Cloud Run instances with no session affinity, so a
 * kernel session held only in one instance's memory is invisible to the others:
 * a cell run that lands elsewhere hits "No kernel session running" and spins a
 * *second* kernel, and variables stop persisting across cells. Backing the
 * registry with Redis (when `REDIS_URL` is set) makes the session record
 * visible to every instance, which then routes execution to the *same* pod.
 *
 * Mirrors `pubsub.service`: Redis when `REDIS_URL` is set (prod), an in-process
 * Map otherwise (local dev / single-instance previews, which never fragment).
 */
import { randomUUID } from "crypto";
import { Redis } from "ioredis";

import { loggers } from "../logging";
import type { KernelEndpoint } from "./kernel-provider";

const logger = loggers.api("kernel-session-store");

/** Serializable kernel session record — everything an instance needs to reach
 * the pod and talk to the kernel. Deliberately excludes the in-memory execution
 * queue (the kernel itself serializes execute-requests per kernel). */
export interface StoredSession {
  sessionId: string;
  workspaceId: string;
  notebookId: string;
  userId: string;
  provider: string;
  endpoint: KernelEndpoint;
  kernelId: string;
  kernelToken: string;
  /** Token expiry (ms) — the service refreshes the token before this lapses. */
  tokenExpMs: number;
  startedAtMs: number;
  lastActivityAtMs: number;
}

/** Fields callers may patch on an existing record without a full rewrite. */
export type SessionPatch = Partial<
  Pick<StoredSession, "lastActivityAtMs" | "kernelToken" | "tokenExpMs">
>;

export interface SessionStore {
  readonly kind: "redis" | "memory";
  get(key: string): Promise<StoredSession | null>;
  /** Store (or replace) a record and (re)arm its idle TTL. */
  put(key: string, session: StoredSession): Promise<void>;
  delete(key: string): Promise<void>;
  /** Patch an existing record and re-arm its TTL (no-op if it's gone). */
  touch(key: string, patch: SessionPatch): Promise<void>;
  /** All live records (for the idle reaper). */
  list(): Promise<StoredSession[]>;
  /** Run `fn` holding a short cross-instance lock on `key`, so two instances
   * can't create two kernels for the same notebook at once. */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

// A record lives a little past the idle TTL, refreshed on every execute; an
// abandoned session self-expires without needing the reaper.
const IDLE_TTL_MS = Number(process.env.KERNEL_SESSION_IDLE_MS || 15 * 60_000);
const RECORD_TTL_MS = IDLE_TTL_MS + 5 * 60_000;
const LOCK_TTL_MS = 30_000;
const LOCK_POLL_MS = 100;

const KEY_PREFIX = "mako:kernel-session:";
const LOCK_PREFIX = "mako:kernel-session-lock:";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── In-process (single instance) ──────────────────────────────────────────
class InProcessSessionStore implements SessionStore {
  readonly kind = "memory" as const;
  private readonly map = new Map<string, StoredSession>();
  /** Per-key mutex tail; each waiter chains onto the previous. */
  private readonly locks = new Map<string, Promise<unknown>>();

  async get(key: string): Promise<StoredSession | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, session: StoredSession): Promise<void> {
    this.map.set(key, session);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async touch(key: string, patch: SessionPatch): Promise<void> {
    const s = this.map.get(key);
    if (s) this.map.set(key, { ...s, ...patch });
  }
  async list(): Promise<StoredSession[]> {
    return [...this.map.values()];
  }
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    this.locks.set(
      key,
      prev.then(() => gate),
    );
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      // Drop the chain once quiescent so the map doesn't grow unbounded.
      if (this.locks.get(key) === prev.then(() => gate)) this.locks.delete(key);
    }
  }
}

// ── Redis (multi-instance) ─────────────────────────────────────────────────
class RedisSessionStore implements SessionStore {
  readonly kind = "redis" as const;
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<StoredSession | null> {
    const raw = await this.redis.get(KEY_PREFIX + key);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  }
  async put(key: string, session: StoredSession): Promise<void> {
    await this.redis.set(
      KEY_PREFIX + key,
      JSON.stringify(session),
      "PX",
      RECORD_TTL_MS,
    );
  }
  async delete(key: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + key);
  }
  async touch(key: string, patch: SessionPatch): Promise<void> {
    const existing = await this.get(key);
    if (!existing) return;
    await this.put(key, { ...existing, ...patch });
  }
  async list(): Promise<StoredSession[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        "MATCH",
        KEY_PREFIX + "*",
        "COUNT",
        100,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (!keys.length) return [];
    const vals = await this.redis.mget(keys);
    return vals
      .filter((v): v is string => !!v)
      .map(v => JSON.parse(v) as StoredSession);
  }
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = LOCK_PREFIX + key;
    const id = randomUUID();
    const deadline = Date.now() + LOCK_TTL_MS;
    while (Date.now() < deadline) {
      const ok = await this.redis.set(lockKey, id, "PX", LOCK_TTL_MS, "NX");
      if (ok === "OK") {
        try {
          return await fn();
        } finally {
          // Release only if still ours (a prior holder may have expired).
          await this.redis
            .eval(
              "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
              1,
              lockKey,
              id,
            )
            .catch(() => undefined);
        }
      }
      await sleep(LOCK_POLL_MS);
    }
    // Couldn't acquire within the window — proceed without it rather than fail
    // the user's run. The caller re-checks the store first, so the worst case
    // is a rare duplicate pod, not a crash.
    logger.warn("kernel session lock not acquired; proceeding best-effort", {
      key,
    });
    return fn();
  }
}

let cached: SessionStore | null = null;

/** The active session store (Redis when `REDIS_URL` is set, else in-process). */
export function getSessionStore(): SessionStore {
  if (cached) return cached;
  const url = process.env.REDIS_URL;
  if (url) {
    const redis = new Redis(url, { maxRetriesPerRequest: null });
    redis.on("error", error =>
      logger.warn("kernel session store Redis error", { error }),
    );
    cached = new RedisSessionStore(redis);
    logger.info("Kernel sessions backed by Redis (multi-instance safe)");
  } else {
    cached = new InProcessSessionStore();
    logger.info(
      "Kernel sessions in-process (single instance only — set REDIS_URL to scale out)",
    );
  }
  return cached;
}

/** Test seam: drop the memoized store (e.g. after changing env). */
export function resetSessionStoreForTests(store?: SessionStore): void {
  cached = store ?? null;
}
