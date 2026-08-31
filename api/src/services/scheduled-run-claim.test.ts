/**
 * findDueScheduledRuns + claimScheduledRun against in-memory Mongo.
 *
 * Proves the multi-instance contract the schedulers rely on: the scan
 * selects only docs whose precomputed nextAt has passed, and of N racers
 * holding the same snapshot exactly one claim flips nextAt.
 *
 * Run: npx tsx src/services/scheduled-run-claim.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Schema, Types } from "mongoose";

import { claimScheduledRun, findDueScheduledRuns } from "./scheduled-run-claim";

const TestJob = mongoose.model(
  "ScheduledRunClaimTestJob",
  new Schema({
    workspaceId: Types.ObjectId,
    enabled: Boolean,
    schedule: { cron: String, timezone: String },
    scheduledRun: { nextAt: Date },
  }),
);

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const ws = new Types.ObjectId();
  const now = new Date("2026-08-31T12:00:00Z");

  try {
    const due = await TestJob.create({
      workspaceId: ws,
      enabled: true,
      schedule: { cron: "0 * * * *", timezone: "UTC" },
      scheduledRun: { nextAt: new Date("2026-08-31T11:00:00Z") },
    });
    await TestJob.create({
      // Future nextAt — not due.
      workspaceId: ws,
      enabled: true,
      schedule: { cron: "0 * * * *", timezone: "UTC" },
      scheduledRun: { nextAt: new Date("2026-08-31T13:00:00Z") },
    });
    await TestJob.create({
      // No cron — never scanned even with a stale nextAt.
      workspaceId: ws,
      enabled: true,
      schedule: {},
      scheduledRun: { nextAt: new Date("2026-08-31T11:00:00Z") },
    });
    await TestJob.create({
      // Filtered out by the caller's extra filter.
      workspaceId: ws,
      enabled: false,
      schedule: { cron: "0 * * * *", timezone: "UTC" },
      scheduledRun: { nextAt: new Date("2026-08-31T11:00:00Z") },
    });

    const found = await findDueScheduledRuns(TestJob, now, { enabled: true });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, due._id.toString());
    assert.equal(found[0].workspaceId, ws.toString());
    assert.equal(found[0].schedule?.cron, "0 * * * *");

    // First claim wins and advances nextAt to the next occurrence after now.
    const first = await claimScheduledRun(TestJob, found[0], now);
    assert.equal(first.modifiedCount, 1);
    const after = await TestJob.findById(due._id).lean();
    assert.equal(
      after?.scheduledRun?.nextAt?.toISOString(),
      "2026-08-31T13:00:00.000Z",
    );

    // A racer holding the same pre-claim snapshot loses.
    const second = await claimScheduledRun(TestJob, found[0], now);
    assert.equal(second.modifiedCount, 0);

    // nextAt survives step serialization as an ISO string — the claim
    // filter must still match (mongoose casts it back to a Date).
    const reset = await TestJob.findByIdAndUpdate(
      due._id,
      { $set: { "scheduledRun.nextAt": new Date("2026-08-31T11:00:00Z") } },
      { new: true },
    ).lean();
    assert.ok(reset);
    const serialized = {
      ...found[0],
      nextAt: "2026-08-31T11:00:00.000Z",
    };
    const viaString = await claimScheduledRun(TestJob, serialized, now);
    assert.equal(viaString.modifiedCount, 1);

    console.log("scheduled-run-claim tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
