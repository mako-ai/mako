/**
 * claimDueScheduledFlows against an in-memory Mongo: due flows are claimed
 * once, a dispatched-but-still-queued flow (no `lastRunAt` bump yet) is not
 * dispatched again on the next tick, a flow with a running execution is
 * skipped, and racing scans claim each flow exactly once.
 *
 * Run: npx tsx src/services/flow-schedule-claim.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { Flow, FlowExecution } from "../database/workspace-schema";
import {
  claimDueScheduledFlows,
  scheduledFlowEventId,
} from "./flow-schedule-claim";

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const workspaceId = new Types.ObjectId();
  const insertFlow = async (fields: Record<string, unknown>) => {
    const _id = new Types.ObjectId();
    await Flow.collection.insertOne({
      _id,
      workspaceId,
      name: `flow-${_id.toString().slice(-4)}`,
      schedule: { enabled: true, cron: "0 * * * *", timezone: "UTC" },
      ...fields,
    });
    return _id;
  };

  try {
    const t0 = new Date("2026-11-14T10:02:00Z");
    // Ran at 08:00 → the 09:00 and 10:00 occurrences have passed: due.
    const due = await insertFlow({
      lastRunAt: new Date("2026-11-14T08:00:00Z"),
    });
    // Ran at 10:01 → next is 11:00: not due.
    const recent = await insertFlow({
      lastRunAt: new Date("2026-11-14T10:01:00Z"),
    });
    // Due, but an execution is running.
    const busy = await insertFlow({
      lastRunAt: new Date("2026-11-14T08:00:00Z"),
    });
    await FlowExecution.collection.insertOne({
      _id: new Types.ObjectId(),
      flowId: busy,
      workspaceId,
      status: "running",
      startedAt: t0,
    });
    // Disabled schedule: never selected.
    await insertFlow({
      schedule: { enabled: false, cron: "0 * * * *", timezone: "UTC" },
    });

    const first = await claimDueScheduledFlows(t0);
    assert.equal(first.checked, 3);
    assert.deepEqual(
      first.claimed.map(c => c.flowId),
      [due.toString()],
    );
    assert.equal(first.claimed[0].dispatchedAt, t0.toISOString());
    assert.equal(
      scheduledFlowEventId(first.claimed[0]),
      `flow-schedule:${due.toString()}:${t0.toISOString()}`,
    );

    // Next tick, 5 minutes later: the run is still queued behind the flow
    // function's concurrency (lastRunAt unchanged) — not dispatched again.
    const t1 = new Date("2026-11-14T10:07:00Z");
    const second = await claimDueScheduledFlows(t1);
    assert.deepEqual(second.claimed, []);

    // At the next occurrence it is due again.
    const t2 = new Date("2026-11-14T11:01:00Z");
    const third = await claimDueScheduledFlows(t2);
    // The 10:01 flow is now due too; the busy one is still running.
    assert.deepEqual(
      third.claimed.map(c => c.flowId).sort(),
      [due.toString(), recent.toString()].sort(),
    );

    // Racing scans: each flow claimed exactly once across both.
    const t3 = new Date("2026-11-14T12:01:00Z");
    const [a, b] = await Promise.all([
      claimDueScheduledFlows(t3),
      claimDueScheduledFlows(t3),
    ]);
    const all = [...a.claimed, ...b.claimed].map(c => c.flowId);
    assert.equal(new Set(all).size, all.length);
    assert.ok(all.includes(due.toString()));

    console.info("flow-schedule-claim.db.test: ok");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
