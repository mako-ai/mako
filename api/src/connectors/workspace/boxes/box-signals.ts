/**
 * The fast, short-lived half of box leasing: heartbeats and the run queue
 * (RFC connector-runtime §6.8).
 *
 * Redis when `REDIS_URL` is set, which is how production runs several API
 * instances. An in-process fallback otherwise, with the same semantics, for
 * local development and tests; like the kernel session store it is correct
 * only for a single instance, so the scheduler also writes heartbeats to
 * Mongo when it runs on this fallback.
 */
import { Redis } from "ioredis";
import { BASE_REDIS_OPTIONS } from "../../../utils/redis";
import { loggers } from "../../../logging";

const logger = loggers.connector("box");

/** One waiting run. */
export interface QueueEntry {
  runId: string;
  /**
   * P0 interactive, P1 steady, P2 bulk (RFC §6.5). Stored now, ordered by in
   * iteration 3. Today the queue is FIFO: see `queueScore`.
   */
  priority: number;
  enqueuedAt: number;
}

/**
 * The queue's sort key. FIFO for now: the enqueue time alone.
 *
 * Iteration 3 (priorities and budgets) changes only this function, to order
 * by priority first and enqueue time second, and adds pre-emption on top.
 */
export function queueScore(entry: QueueEntry): number {
  return entry.enqueuedAt;
}

export interface BoxSignals {
  readonly kind: "redis" | "memory";
  /** Record that the lease on `boxId` is alive at `at`. */
  beat(boxId: string, at: number, ttlMs: number): Promise<void>;
  /** Last beat per box, for the boxes that have one. */
  lastBeats(boxIds: string[]): Promise<Map<string, number>>;
  forget(boxId: string): Promise<void>;
  /** Join the queue for a key. `aliveMs` is how long the entry lives unrefreshed. */
  enqueue(key: string, entry: QueueEntry, aliveMs: number): Promise<void>;
  /** Keep a waiting entry alive. */
  touch(key: string, runId: string, aliveMs: number): Promise<void>;
  /** Is this run first in its key's queue? Drops dead entries ahead of it. */
  isHead(key: string, runId: string): Promise<boolean>;
  dequeue(key: string, runId: string): Promise<void>;
  depth(key: string): Promise<number>;
}

// ── In-process ─────────────────────────────────────────────────────────────

export class MemoryBoxSignals implements BoxSignals {
  readonly kind = "memory" as const;
  private readonly beats = new Map<string, number>();
  private readonly queues = new Map<
    string,
    Array<QueueEntry & { aliveUntil: number }>
  >();

  async beat(boxId: string, at: number): Promise<void> {
    this.beats.set(boxId, at);
  }

  async lastBeats(boxIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const id of boxIds) {
      const at = this.beats.get(id);
      if (at !== undefined) out.set(id, at);
    }
    return out;
  }

  async forget(boxId: string): Promise<void> {
    this.beats.delete(boxId);
  }

  async enqueue(
    key: string,
    entry: QueueEntry,
    aliveMs: number,
  ): Promise<void> {
    const queue = this.queues.get(key) ?? [];
    queue.push({ ...entry, aliveUntil: Date.now() + aliveMs });
    queue.sort((a, b) => queueScore(a) - queueScore(b));
    this.queues.set(key, queue);
  }

  async touch(key: string, runId: string, aliveMs: number): Promise<void> {
    const entry = this.queues.get(key)?.find(e => e.runId === runId);
    if (entry) entry.aliveUntil = Date.now() + aliveMs;
  }

  async isHead(key: string, runId: string): Promise<boolean> {
    const queue = this.queues.get(key) ?? [];
    while (queue.length > 0 && queue[0].runId !== runId) {
      if (queue[0].aliveUntil >= Date.now()) return false;
      queue.shift();
    }
    return queue[0]?.runId === runId;
  }

  async dequeue(key: string, runId: string): Promise<void> {
    const queue = this.queues.get(key);
    if (!queue) return;
    const index = queue.findIndex(e => e.runId === runId);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(key);
  }

  async depth(key: string): Promise<number> {
    return this.queues.get(key)?.length ?? 0;
  }
}

// ── Redis ──────────────────────────────────────────────────────────────────

const BEAT_PREFIX = "mako:connector-box:beat:";
const QUEUE_PREFIX = "mako:connector-box:queue:";
const ALIVE_PREFIX = "mako:connector-box:waiting:";

export class RedisBoxSignals implements BoxSignals {
  readonly kind = "redis" as const;
  constructor(private readonly redis: Redis) {}

  async beat(boxId: string, at: number, ttlMs: number): Promise<void> {
    await this.redis.set(BEAT_PREFIX + boxId, String(at), "PX", ttlMs);
  }

  async lastBeats(boxIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (boxIds.length === 0) return out;
    const values = await this.redis.mget(boxIds.map(id => BEAT_PREFIX + id));
    values.forEach((value, index) => {
      const at = Number(value);
      if (value !== null && Number.isFinite(at)) out.set(boxIds[index], at);
    });
    return out;
  }

  async forget(boxId: string): Promise<void> {
    await this.redis.del(BEAT_PREFIX + boxId);
  }

  async enqueue(
    key: string,
    entry: QueueEntry,
    aliveMs: number,
  ): Promise<void> {
    await this.redis
      .multi()
      .set(ALIVE_PREFIX + entry.runId, String(entry.priority), "PX", aliveMs)
      .zadd(QUEUE_PREFIX + key, String(queueScore(entry)), entry.runId)
      .exec();
  }

  async touch(_key: string, runId: string, aliveMs: number): Promise<void> {
    await this.redis.pexpire(ALIVE_PREFIX + runId, aliveMs);
  }

  async isHead(key: string, runId: string): Promise<boolean> {
    // A waiter whose process died stops refreshing its alive key; drop it
    // rather than let it block the queue forever.
    for (let i = 0; i < 50; i++) {
      const [head] = await this.redis.zrange(QUEUE_PREFIX + key, "0", "0");
      if (!head) return false;
      if (head === runId) return true;
      if (await this.redis.exists(ALIVE_PREFIX + head)) return false;
      await this.redis.zrem(QUEUE_PREFIX + key, head);
    }
    return false;
  }

  async dequeue(key: string, runId: string): Promise<void> {
    await this.redis
      .multi()
      .zrem(QUEUE_PREFIX + key, runId)
      .del(ALIVE_PREFIX + runId)
      .exec();
  }

  async depth(key: string): Promise<number> {
    return this.redis.zcard(QUEUE_PREFIX + key);
  }
}

let cached: BoxSignals | null = null;

/** Redis when `REDIS_URL` is set, else in-process. */
export function getBoxSignals(): BoxSignals {
  if (cached) return cached;
  const url = process.env.REDIS_URL;
  if (url) {
    const redis = new Redis(url, {
      ...BASE_REDIS_OPTIONS,
      maxRetriesPerRequest: 3,
    });
    redis.on("error", error =>
      logger.warn("Connector box signals Redis error", { error }),
    );
    cached = new RedisBoxSignals(redis);
  } else {
    cached = new MemoryBoxSignals();
  }
  return cached;
}
