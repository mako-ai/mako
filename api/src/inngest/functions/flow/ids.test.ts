/**
 * Inngest persists function ids (and memoizes runs by them), so the split of
 * `functions/flow.ts` into `functions/flow/*` must not have moved any id or
 * trigger. This pins them.
 */
import assert from "node:assert/strict";
import {
  cancelFlowFunction,
  cdcScheduledBackfillFunction,
  cleanupAbandonedFlowsFunction,
  flowFunction,
  flowSchedulerFunction,
  manualFlowFunction,
} from "../flow";

type Introspectable = {
  id: (prefix?: string) => string;
  opts: { triggers?: unknown };
};

const pinned: Array<[Introspectable, string, unknown]> = [
  [flowFunction, "flow", { event: "flow.execute" }],
  [flowSchedulerFunction, "scheduled-flow", { cron: "*/5 * * * *" }],
  [
    cdcScheduledBackfillFunction,
    "cdc-scheduled-backfill",
    { cron: "*/5 * * * *" },
  ],
  [manualFlowFunction, "manual-flow", { event: "flow.manual" }],
  [cancelFlowFunction, "cancel-flow", { event: "flow.cancel" }],
  [
    cleanupAbandonedFlowsFunction,
    "cleanup-abandoned-flows",
    { cron: "*/5 * * * *" },
  ],
];

for (const [fn, id, triggers] of pinned) {
  assert.equal(fn.id(), id);
  assert.deepEqual(fn.opts.triggers, [triggers], `${id} triggers`);
}

console.log("flow inngest function ids: all assertions passed");
