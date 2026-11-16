/**
 * What the autoscaler sizes a worker by: the steps Hatchet holds, and a
 * commit the worker has not built yet.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/demand.test.ts
 */
import assert from "node:assert/strict";

import { demandOf } from "./demand";

const A = "a".repeat(40);
const B = "b".repeat(40);
const none = { queued: 0, running: 0 };

// Nothing deployed, nothing queued: no pod.
assert.equal(demandOf(undefined, none).steps, 0);
// The worker runs the wanted commit and Hatchet holds nothing: no pod.
assert.equal(demandOf({ sha: A, running: { sha: A } }, none).steps, 0);
// Queued and running steps both count: a pod with running steps stays.
assert.deepEqual(
  demandOf({ sha: A, running: { sha: A } }, { queued: 40, running: 16 }),
  { steps: 56, queued: 40, running: 16, building: false },
);
// A commit not reported on yet is work for one pod, as is a change of
// triggers (webhook.ts forgets the report).
assert.equal(demandOf({ sha: B, running: { sha: A } }, none).steps, 1);
assert.equal(demandOf({ sha: A }, none).steps, 1);
assert.equal(
  demandOf({ sha: B, running: { sha: A } }, { queued: 3, running: 0 }).steps,
  3,
);
// A commit that failed to build wakes nothing.
assert.equal(
  demandOf({ sha: B, running: { sha: A }, failed: { sha: B } }, none).steps,
  0,
);

console.log("workflow demand tests passed");
