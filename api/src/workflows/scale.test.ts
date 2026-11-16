/**
 * How many pods a workspace's worker gets: what its steps need, grown at
 * once, shrunk a pod at a time, and none only after a while without work.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/scale.test.ts
 */
import assert from "node:assert/strict";

import { IDLE_AFTER_MS, decide } from "./scale";

const NOW = new Date("2026-11-16T20:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const demand = (steps: number) => ({
  steps,
  queued: steps,
  running: 0,
  building: false,
});
const SLOTS = 128;
const MOST = 5;
const pods = (replicas: number, steps: number | null, lastNeededAt?: Date) =>
  decide(
    { replicas, lastNeededAt, demand: steps === null ? null : demand(steps) },
    NOW,
    SLOTS,
    MOST,
  );

// Work wakes a sleeping worker, and one step is enough.
assert.deepEqual(pods(0, 1), { replicas: 1, needed: true });
// One pod per 128 steps, at once, and never more than the most.
assert.equal(pods(1, 128).replicas, 1);
assert.equal(pods(1, 129).replicas, 2);
assert.equal(pods(1, 400).replicas, 4);
assert.equal(pods(1, 5000).replicas, 5);
// Less work: one pod fewer per sweep, not all at once.
assert.equal(pods(5, 129).replicas, 4);
assert.equal(pods(2, 10).replicas, 1);
assert.equal(pods(3, 0).replicas, 2);
// The last pod stays while there is work, and for a while after.
assert.equal(pods(1, 1).replicas, 1);
assert.deepEqual(pods(1, 0, ago(IDLE_AFTER_MS - 1000)), {
  replicas: 1,
  needed: false,
});
// Idle long enough, or never seen needed: it sleeps.
assert.equal(pods(1, 0, ago(IDLE_AFTER_MS + 1000)).replicas, 0);
assert.equal(pods(1, 0).replicas, 0);
assert.equal(pods(0, 0).replicas, 0);
// Hatchet did not answer: the worker is left as it is, awake or asleep.
assert.deepEqual(pods(3, null), { replicas: 3, needed: false });
assert.deepEqual(pods(0, null), { replicas: 0, needed: false });

console.log("workflow scale tests passed");
