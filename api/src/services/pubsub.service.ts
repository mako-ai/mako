/**
 * Shared pub/sub backend
 *
 * Single place that selects and constructs the pub/sub backend used by
 * features needing cross-instance fan-out:
 *
 *   - Resumable chat streams (resumable-stream.service.ts)
 *   - The workspace realtime channel (realtime.service.ts)
 *
 * Backend selection:
 *
 *   - REDIS_URL set: Redis pub/sub. Required when running more than one API
 *     instance, because a subscriber may be connected to a different
 *     instance than the one producing an event.
 *   - REDIS_URL unset: in-process pub/sub with identical semantics. Zero
 *     extra infrastructure for local dev and single-instance self-hosting.
 *
 * The Publisher/Subscriber interfaces come from `resumable-stream/generic`
 * so the same backend plugs directly into the resumable-stream context.
 *
 * Connection semantics:
 *   - Redis mode: every call to createPubSubPublisher/createPubSubSubscriber
 *     returns a fresh connection. A Redis connection in subscriber mode
 *     cannot issue regular commands, so consumers must never share a
 *     publisher and a subscriber connection.
 *   - Memory mode: all handles share one process-wide InMemoryPubSub so
 *     publishers and subscribers can see each other.
 */
import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import type { Publisher, Subscriber } from "resumable-stream/generic";
import { loggers } from "../logging";

export type { Publisher, Subscriber } from "resumable-stream/generic";

const logger = loggers.api("pubsub");

// ── Failure reporting ─────────────────────────────────────────────
//
// A broken Redis backend silently downgrades two headline features at once:
// resumable chat streams (reload/second-device reattach) and the workspace
// realtime channel. That must surface as an ERROR (Cloud Error Reporting
// alerts on it), not a per-event warn buried in the noise — the July 2026
// Upstash max_requests quota exhaustion ran for hours as swallowed warns.
//
// Throttled: an outage emits failures per chunk/event/turn, so unthrottled
// error logs would flood Error Reporting without adding signal.
const FAILURE_LOG_INTERVAL_MS = 60_000;
let lastFailureLogAt = 0;

/**
 * Report a Redis pub/sub failure. Logs at ERROR level at most once per
 * minute (per process); other calls in the window log at debug so the full
 * failure rate stays reconstructable from debug logs.
 */
export function reportPubSubFailure(context: string, error: unknown): void {
  const now = Date.now();
  if (now - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
    lastFailureLogAt = now;
    logger.error(
      "Redis pub/sub backend failing — resumable chat streams and workspace realtime events are degraded until it recovers",
      { context, error },
    );
  } else {
    logger.debug("Redis pub/sub failure (throttled)", { context, error });
  }
}

/** Attach a structured error listener to an ioredis connection. */
function attachRedisErrorListener(redis: Redis, context: string): Redis {
  redis.on("error", (error: unknown) => {
    reportPubSubFailure(context, error);
  });
  return redis;
}

// Mirrors the 24h TTL resumable-stream applies to its own keys; only used
// for keys the library creates via INCR (no explicit expiry).
const DEFAULT_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface InMemoryEntry {
  value: string;
  expiresAt: number;
}

/**
 * In-process implementation of resumable-stream's Publisher/Subscriber
 * interfaces: an EventEmitter stands in for Redis pub/sub channels and a
 * Map with TTLs stands in for the key/value state.
 */
class InMemoryPubSub {
  private readonly emitter = new EventEmitter();
  private readonly store = new Map<string, InMemoryEntry>();

  constructor() {
    // Pub/sub fan-out scales with concurrent streams + viewers, not a bug.
    this.emitter.setMaxListeners(0);
    setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS).unref();
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  private read(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  createPublisher(): Publisher {
    return {
      connect: async () => undefined,
      publish: async (channel: string, message: string) => {
        return this.emitter.emit(channel, message) ? 1 : 0;
      },
      set: async (key: string, value: string, options?: { EX?: number }) => {
        const ttlMs = options?.EX ? options.EX * 1000 : DEFAULT_KEY_TTL_MS;
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
        return "OK";
      },
      get: async (key: string) => this.read(key),
      incr: async (key: string) => {
        const next = Number(this.read(key) ?? "0") + 1;
        this.store.set(key, {
          value: String(next),
          expiresAt: Date.now() + DEFAULT_KEY_TTL_MS,
        });
        return next;
      },
    };
  }

  createSubscriber(): Subscriber {
    // Each subscriber tracks its own listeners so unsubscribe(channel) only
    // detaches itself, matching Redis client semantics.
    const listeners = new Map<string, (message: string) => void>();
    return {
      connect: async () => undefined,
      subscribe: async (
        channel: string,
        callback: (message: string) => void,
      ) => {
        const existing = listeners.get(channel);
        if (existing) this.emitter.off(channel, existing);
        listeners.set(channel, callback);
        this.emitter.on(channel, callback);
      },
      unsubscribe: async (channel: string) => {
        const listener = listeners.get(channel);
        if (listener) {
          this.emitter.off(channel, listener);
          listeners.delete(channel);
        }
      },
    };
  }
}

// Process-wide singleton for the in-memory backend so that publishers and
// subscribers created by different consumers can reach each other.
let inMemoryPubSub: InMemoryPubSub | null = null;

function getInMemoryPubSub(): InMemoryPubSub {
  if (!inMemoryPubSub) {
    inMemoryPubSub = new InMemoryPubSub();
  }
  return inMemoryPubSub;
}

/** Which backend the process is using ("redis" when REDIS_URL is set). */
export function getPubSubBackendKind(): "redis" | "memory" {
  return process.env.REDIS_URL ? "redis" : "memory";
}

/**
 * Create a publisher handle. Redis mode: a fresh connection the caller owns.
 * Memory mode: a handle onto the shared in-process backend.
 */
export function createPubSubPublisher(): Publisher {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    return attachRedisErrorListener(
      new Redis(redisUrl),
      "publisher",
    ) as unknown as Publisher;
  }
  return getInMemoryPubSub().createPublisher();
}

/**
 * Create a subscriber handle. Redis mode: a fresh connection the caller owns
 * (a subscriber-mode connection cannot issue regular commands — never reuse
 * it as a publisher). Memory mode: a handle onto the shared backend.
 */
export function createPubSubSubscriber(): Subscriber {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    return attachRedisErrorListener(
      new Redis(redisUrl),
      "subscriber",
    ) as unknown as Subscriber;
  }
  return getInMemoryPubSub().createSubscriber();
}

/**
 * Startup health check: when Redis is configured, verify it actually answers
 * (connectivity, auth, AND quota — Upstash returns errors on commands once
 * `max_requests` is exhausted, so a bare TCP connect is not enough). Logs an
 * ERROR when the backend is configured but unusable; the server still starts
 * (streaming to the originating client works without Redis, and Redis may
 * recover), but the degradation is loud from minute zero.
 */
export async function checkPubSubBackendHealth(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.info(
      "Pub/sub backend: in-process (single instance only — set REDIS_URL when scaling out)",
    );
    return;
  }

  const probe = new Redis(redisUrl, {
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    // The probe owns its own error reporting below; a listener stops ioredis
    // from spamming "[ioredis] Unhandled error event" during the check.
    lazyConnect: true,
  });
  probe.on("error", () => {
    /* surfaced via the ping result below */
  });
  try {
    await probe.connect();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("PING timed out after 5s")), 5_000),
    );
    await Promise.race([probe.ping(), timeout]);
    logger.info("Pub/sub backend: Redis healthy");
  } catch (error) {
    logger.error(
      "REDIS_URL is set but Redis is unusable (connectivity/auth/quota) — resumable chat streams and workspace realtime events will be degraded",
      { error },
    );
  } finally {
    probe.disconnect();
  }
}
