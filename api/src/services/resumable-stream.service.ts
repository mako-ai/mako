/**
 * Resumable chat streams
 *
 * Buffers the SSE stream of each chat turn so clients can detach and
 * reattach — page refresh, tab close + return, second device, multiple
 * viewers — without killing or losing the generation. Built on the
 * `resumable-stream` package (the same one used by the official AI SDK
 * resume-streams recipe), with a pluggable pub/sub backend:
 *
 *   - REDIS_URL set: Redis pub/sub. Required when running more than one API
 *     instance, because a resume GET may land on a different instance than
 *     the one producing the stream.
 *   - REDIS_URL unset: in-process pub/sub with identical semantics. Zero
 *     extra infrastructure for local dev and single-instance self-hosting.
 *     Streams don't survive a process restart in this mode; clients then
 *     fall back to the chat saved in MongoDB.
 */
import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import {
  createResumableStreamContext,
  type ResumableStreamContext,
  type Publisher,
  type Subscriber,
} from "resumable-stream/generic";
import { loggers } from "../logging";

const logger = loggers.agent();

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

let streamContext: ResumableStreamContext | null = null;

export function getResumableStreamContext(): ResumableStreamContext {
  if (streamContext) return streamContext;

  // On a long-lived Node server there is no serverless waitUntil; background
  // stream consumption just runs on the event loop. Surface failures in logs.
  const waitUntil = (promise: Promise<unknown>): void => {
    void promise.catch(error =>
      logger.warn("Resumable stream background task failed", { error }),
    );
  };

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    // Separate clients: a Redis connection in subscriber mode cannot issue
    // regular commands.
    streamContext = createResumableStreamContext({
      keyPrefix: "mako:resumable-stream",
      waitUntil,
      publisher: new Redis(redisUrl) as unknown as Publisher,
      subscriber: new Redis(redisUrl) as unknown as Subscriber,
    });
    logger.info("Resumable streams backed by Redis", {
      backend: "redis",
    });
  } else {
    const pubsub = new InMemoryPubSub();
    streamContext = createResumableStreamContext({
      keyPrefix: "mako:resumable-stream",
      waitUntil,
      publisher: pubsub.createPublisher(),
      subscriber: pubsub.createSubscriber(),
    });
    logger.info(
      "Resumable streams backed by in-process pub/sub (single instance only — set REDIS_URL when scaling out)",
      { backend: "memory" },
    );
  }

  return streamContext;
}

/**
 * Per-process registry of in-flight generations, keyed by chatId. Powers the
 * explicit stop endpoint: with resumable streams a client disconnect no
 * longer aborts the turn, so Stop must reach the producing process.
 *
 * Note: when running multiple instances behind Redis, a stop request that
 * lands on a non-producing instance still clears the resume pointer in
 * MongoDB but cannot abort the LLM call on the other instance.
 */
interface ActiveGeneration {
  streamId: string;
  abortController: AbortController;
}

const activeGenerations = new Map<string, ActiveGeneration>();

export function registerActiveGeneration(
  chatId: string,
  streamId: string,
  abortController: AbortController,
): void {
  activeGenerations.set(chatId, { streamId, abortController });
}

/** Abort the in-flight generation for a chat. Returns true if one was found. */
export function stopActiveGeneration(chatId: string): boolean {
  const active = activeGenerations.get(chatId);
  if (!active) return false;
  activeGenerations.delete(chatId);
  active.abortController.abort();
  return true;
}

/** Remove the registry entry, but only if it still belongs to this turn. */
export function clearActiveGeneration(chatId: string, streamId: string): void {
  if (activeGenerations.get(chatId)?.streamId === streamId) {
    activeGenerations.delete(chatId);
  }
}
