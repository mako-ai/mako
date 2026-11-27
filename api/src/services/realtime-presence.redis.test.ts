/**
 * Set TEST_REDIS_URL to a disposable Redis to exercise heartbeat-only pruning.
 * Advance the application's heartbeat scores while keeping the Redis key live.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock, test } from "node:test";
import { Redis } from "ioredis";
import { BASE_REDIS_OPTIONS } from "../utils/redis";
import {
  resetRealtimePresenceForTests,
  touchRealtimePresence,
} from "./realtime-presence.service";

const url = process.env.TEST_REDIS_URL;
void test(
  "heartbeats reap orphaned clients in an always-active workspace",
  { skip: !url },
  async () => {
    if (!url) return;
    process.env.REDIS_URL = url;
    const redis = new Redis(url, BASE_REDIS_OPTIONS);
    const workspace = `test-${randomUUID()}`;
    const key = `mako:realtime:presence:${workspace}`;
    const start = Date.now();
    let now = start;
    const clock = mock.method(Date, "now", () => now);
    try {
      await touchRealtimePresence(workspace, "orphan", "user");
      await touchRealtimePresence(workspace, "live", "user");
      for (let beat = 1; beat <= 5; beat++) {
        now = start + beat * 15_000;
        await touchRealtimePresence(workspace, "live", "user");
      }
      assert.equal(await redis.zscore(key, "orphan"), String(start));

      now = start + 90_000;
      await touchRealtimePresence(workspace, "live", "user");
      // Inspect Redis directly. A presence lookup would itself reap the orphan.
      assert.deepEqual(await redis.zrange(key, "0", "-1", "WITHSCORES"), [
        "live",
        String(now),
      ]);
      assert.ok((await redis.ttl(key)) > 0);
    } finally {
      clock.mock.restore();
      resetRealtimePresenceForTests();
      try {
        await redis.del(key);
      } finally {
        redis.disconnect();
      }
    }
  },
);
