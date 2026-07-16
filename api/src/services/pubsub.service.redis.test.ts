/**
 * Redis-mode pub/sub adapter test. Guards against the class of bug where a
 * `new Redis() as unknown as Subscriber` cast type-checks but silently drops
 * every message — ioredis routes messages to its "message" event, not to the
 * subscribe() callback that resumable-stream's node-redis-shaped interface
 * expects. In-process coverage (realtime.service.test.ts) cannot catch this.
 *
 * Run with a disposable Redis, e.g.:
 *   docker run -d --rm -p 6399:6379 redis:7-alpine
 *   TEST_REDIS_URL=redis://127.0.0.1:6399 \
 *     pnpm --filter api exec tsx src/services/pubsub.service.redis.test.ts
 *
 * No-ops when TEST_REDIS_URL is unset so CI without Redis stays green. The
 * factories read REDIS_URL at call time, so it is set inside main() (below the
 * skip guard) rather than at module load.
 */
import assert from "node:assert/strict";

import {
  createPubSubPublisher,
  createPubSubSubscriber,
  getPubSubBackendKind,
} from "./pubsub.service";

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  const testRedisUrl = process.env.TEST_REDIS_URL;
  if (!testRedisUrl) {
    console.info("⏭  TEST_REDIS_URL unset — skipping Redis-mode pub/sub test");
    return;
  }
  process.env.REDIS_URL = testRedisUrl;

  assert.equal(
    getPubSubBackendKind(),
    "redis",
    "must select the Redis backend",
  );

  const pub = createPubSubPublisher();
  const sub = createPubSubSubscriber();

  // One subscriber, many channels, each with its own handler — the pattern
  // realtime.service uses (a shared subscriber fanning out per workspace).
  const gotA: string[] = [];
  const gotB: string[] = [];
  await sub.subscribe("mako:test:A", m => gotA.push(m));
  await sub.subscribe("mako:test:B", m => gotB.push(m));
  await delay(150);

  await pub.publish("mako:test:A", "a1");
  await pub.publish("mako:test:B", "b1");
  await pub.publish("mako:test:A", "a2");
  await delay(150);

  assert.deepEqual(gotA, ["a1", "a2"], "channel A messages delivered in order");
  assert.deepEqual(gotB, ["b1"], "channel B delivered without cross-talk");

  await sub.unsubscribe("mako:test:A");
  await delay(50);
  await pub.publish("mako:test:A", "a3");
  await delay(100);
  assert.deepEqual(gotA, ["a1", "a2"], "no delivery after unsubscribe");

  // Publisher key ops (used by resumable-stream) must survive the ioredis
  // positional-arg translation of `set(key, value, { EX })`.
  await pub.set("mako:test:k", "v", { EX: 60 });
  assert.equal(
    await pub.get("mako:test:k"),
    "v",
    "set/get round-trips with EX",
  );
  const n = await pub.incr("mako:test:counter");
  assert.equal(typeof n, "number", "incr returns a number");

  console.info(
    "✅ Redis-mode pub/sub: delivers, isolates channels, unsubscribes, set/get/incr ok",
  );
}

main()
  .then(() => {
    // Redis sockets keep the event loop alive; exit deterministically.
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  })
  .catch(error => {
    console.error("❌ Redis-mode pub/sub test failed:", error);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
