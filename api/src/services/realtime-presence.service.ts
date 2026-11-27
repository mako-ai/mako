/**
 * Realtime client presence
 *
 * Tracks which browser tabs currently hold an open realtime (SSE)
 * connection, per workspace. The SSE route heartbeats presence while a
 * connection is open. This gives a multi-instance-correct answer to "is any
 * browser attached?" without pub/sub KV scans.
 *
 * Storage: one Redis sorted set per workspace when REDIS_URL is set
 * (member = clientId, score = last heartbeat in ms), shared across API
 * instances like the chat stream state. Without REDIS_URL it lives in
 * process memory with the same freshness rules — correct for a single API
 * instance (local dev, tests). Presence is ephemeral by nature: a lost
 * entry heals on the next 15s heartbeat, so nothing here needs durability.
 *
 * Consumers:
 *   - agent.routes.ts "no client attached" fallback for client-only tools.
 */
import {
  touchLegacyPresence,
  clearLegacyPresence,
  hasFreshLegacyPresence,
} from "./realtime-presence-compat";
import { Redis } from "ioredis";
import { BASE_REDIS_OPTIONS } from "../utils/redis";
import { loggers } from "../logging";

const logger = loggers.api("realtime");

/**
 * A client counts as attached if it heartbeated within this window. The SSE
 * heartbeat fires every 15s.
 */
const PRESENCE_FRESHNESS_MS = 60_000;

/**
 * Entries older than this are pruned, and an idle workspace's whole key
 * expires after it. Matches the 90s TTL index the Mongo collection used.
 */
const PRESENCE_TTL_SECONDS = 90;
const PRESENCE_TTL_MS = PRESENCE_TTL_SECONDS * 1000;

function presenceKey(workspaceId: string): string {
  return `mako:realtime:presence:${workspaceId}`;
}

// --------------------------------------------------------------------------
// Storage: Redis when configured, else in-process with the same windows.
// --------------------------------------------------------------------------

interface PresenceStore {
  disconnect?(): void;
  touch(workspaceId: string, clientId: string, now: number): Promise<void>;
  clear(workspaceId: string, clientId: string): Promise<void>;
  hasFresh(workspaceId: string, now: number): Promise<boolean>;
}

function memoryStore(): PresenceStore {
  const byWorkspace = new Map<string, Map<string, number>>();
  return {
    async touch(workspaceId, clientId, now) {
      let clients = byWorkspace.get(workspaceId);
      if (!clients) {
        clients = new Map();
        byWorkspace.set(workspaceId, clients);
      }
      clients.set(clientId, now);
    },
    async clear(workspaceId, clientId) {
      const clients = byWorkspace.get(workspaceId);
      if (!clients) return;
      clients.delete(clientId);
      if (clients.size === 0) byWorkspace.delete(workspaceId);
    },
    async hasFresh(workspaceId, now) {
      const clients = byWorkspace.get(workspaceId);
      if (!clients) return false;
      let fresh = 0;
      for (const [clientId, lastSeenAt] of clients) {
        if (lastSeenAt <= now - PRESENCE_TTL_MS) {
          clients.delete(clientId);
        } else if (lastSeenAt >= now - PRESENCE_FRESHNESS_MS) {
          fresh++;
        }
      }
      if (clients.size === 0) byWorkspace.delete(workspaceId);
      return fresh > 0;
    },
  };
}

function redisStore(url: string): PresenceStore {
  // Fail fast. The presence check sits on the agent's tool path: while Redis
  // is down it must fail open in milliseconds, not after a queued command
  // and its retries. No offline queue, one retry.
  const redis = new Redis(url, {
    ...BASE_REDIS_OPTIONS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  redis.on("error", error =>
    logger.warn("Realtime presence redis error", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  // A fresh connection can see an empty dataset after a restart. Give SSE
  // writers two 15s heartbeats to repopulate it before trusting a zero.
  const recoveryWindowMs = 30_000;
  let trustEmptyAfter = Date.now() + recoveryWindowMs;
  redis.on("ready", () => {
    trustEmptyAfter = Date.now() + recoveryWindowMs;
  });
  // Share one bounded wait for the initial handshake. After the first
  // attempt, disabling the offline queue makes outages fail immediately.
  const firstReady = new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      redis.off("ready", done);
      redis.off("close", done);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    redis.once("ready", done);
    redis.once("close", done);
    if (redis.status === "ready") done();
  });
  return {
    disconnect: () => redis.disconnect(),
    async touch(workspaceId, clientId, now) {
      await firstReady;
      const key = presenceKey(workspaceId);
      const results = await redis
        .multi()
        .zadd(key, now, clientId)
        // A busy workspace keeps extending its key's TTL even if a tab vanishes.
        .zremrangebyscore(key, "-inf", now - PRESENCE_TTL_MS)
        .expire(key, PRESENCE_TTL_SECONDS)
        .exec();
      throwOnMultiError(results);
    },
    async clear(workspaceId, clientId) {
      await firstReady;
      await redis.zrem(presenceKey(workspaceId), clientId);
    },
    async hasFresh(workspaceId, now) {
      await firstReady;
      const key = presenceKey(workspaceId);
      // Bounds are inclusive: prune scores <= now - 90s, count scores
      // >= now - 60s, matching the memory store.
      const results = await redis
        .multi()
        .zremrangebyscore(key, "-inf", now - PRESENCE_TTL_MS)
        .zcount(key, now - PRESENCE_FRESHNESS_MS, "+inf")
        .exec();
      throwOnMultiError(results);
      const count = results?.[1]?.[1];
      if (typeof count !== "number") throw new Error("Missing presence count");
      return count > 0 || Date.now() < trustEmptyAfter;
    },
  };
}

/** ioredis reports per-command failures inside exec()'s result tuples. */
function throwOnMultiError(
  results: Array<[Error | null, unknown]> | null,
): void {
  if (!results) throw new Error("Redis transaction aborted");
  for (const [error] of results) {
    if (error) throw error;
  }
}

let store: PresenceStore | null = null;
function getStore(): PresenceStore {
  if (!store) {
    store = process.env.REDIS_URL
      ? redisStore(process.env.REDIS_URL)
      : memoryStore();
  }
  return store;
}

/** Test seam: drop the store so the next call rebuilds it from REDIS_URL. */
export function resetRealtimePresenceForTests(): void {
  store?.disconnect?.();
  store = null;
}

// --------------------------------------------------------------------------
// API
// --------------------------------------------------------------------------

// A failed write on one revision's store must not cut short the other write.
async function finishPresenceWrites(writes: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(writes);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}

/** Refresh a client's presence. Best-effort, never throws. */
export async function touchRealtimePresence(
  workspaceId: string,
  clientId: string,
  userId: string,
): Promise<void> {
  if (!clientId) return;
  try {
    const now = Date.now();
    await finishPresenceWrites([
      touchLegacyPresence(workspaceId, clientId, userId, now),
      getStore().touch(workspaceId, clientId, now),
    ]);
  } catch (error) {
    logger.debug("Failed to touch realtime presence", {
      error,
      workspaceId,
      clientId,
    });
  }
}

/** Remove a client's presence on clean disconnect. Best-effort. */
export async function clearRealtimePresence(
  workspaceId: string,
  clientId: string,
): Promise<void> {
  if (!clientId) return;
  try {
    await finishPresenceWrites([
      clearLegacyPresence(workspaceId, clientId),
      getStore().clear(workspaceId, clientId),
    ]);
  } catch (error) {
    logger.debug("Failed to clear realtime presence", {
      error,
      workspaceId,
      clientId,
    });
  }
}

/** Is at least one browser tab attached to this workspace right now? */
export async function hasAttachedClients(
  workspaceId: string,
): Promise<boolean> {
  try {
    const now = Date.now();
    return (
      (await getStore().hasFresh(workspaceId, now)) ||
      (await hasFreshLegacyPresence(workspaceId, now - PRESENCE_FRESHNESS_MS))
    );
  } catch (error) {
    // Fail open: assuming a client is attached preserves today's behavior
    // (client-driven tool loop) rather than risking a wrong synthetic result.
    logger.warn("Presence check failed; assuming clients attached", {
      error,
      workspaceId,
    });
    return true;
  }
}
