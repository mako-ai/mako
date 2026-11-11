/**
 * Writes an agent's run recorded (recorded-writes.ts), in in-memory Mongo:
 * the per-run cap holds under parallel writes; a run's answer
 * (`withRecordedWrites`, what workflows_status adds) carries the count, one
 * bounded page and where the next starts, and a line in each step's logs;
 * a sandbox run's are its person's only; a run that recorded none is
 * answered unchanged.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/recorded-writes.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import {
  MAX_RECORDED_PER_RUN,
  RECORDED_PAGE_SIZE,
  WorkflowRecordedRun,
  WorkflowRecordedWrite,
  keepRecordedWrite,
  recordedWritesOf,
  withRecordedWrites,
} from "./recorded-writes";

const RUN = "1f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const SANDBOX_RUN = "sandbox-5f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

const slack = { _id: new Types.ObjectId(), name: "slack" };
const post = (text: string) => ({
  method: "POST",
  url: "https://slack.com/api/chat.postMessage",
  headers: { authorization: "Bearer [redacted]" },
  body: { channel: "C1", text },
});

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await WorkflowRecordedWrite.init();
  await WorkflowRecordedRun.init();
  try {
    const ws = String(new Types.ObjectId());

    // A run that recorded nothing is answered as it is.
    const plain = { status: "COMPLETED", steps: [{ step: "send", logs: [] }] };
    assert.equal(await withRecordedWrites(ws, RUN, plain), plain);

    // Parallel steps cannot record past the cap.
    const outcomes = await Promise.all(
      Array.from({ length: MAX_RECORDED_PER_RUN + 15 }, (_, i) =>
        keepRecordedWrite(
          ws,
          { runId: RUN, step: i % 2 ? "send" : "notify" },
          slack,
          post(`m${i}`),
        ),
      ),
    );
    assert.equal(
      outcomes.filter(o => o === "kept").length,
      MAX_RECORDED_PER_RUN,
    );
    assert.equal(outcomes.filter(o => o === "full").length, 15);
    assert.equal(
      await WorkflowRecordedWrite.countDocuments({ runId: RUN }),
      MAX_RECORDED_PER_RUN,
    );
    const seqs = (
      await WorkflowRecordedWrite.find({ runId: RUN }).select("seq").lean()
    )
      .map(row => row.seq)
      .sort((a, b) => a - b);
    assert.deepEqual(
      seqs,
      Array.from({ length: MAX_RECORDED_PER_RUN }, (_, i) => i),
    );

    // One bounded page, the count, and where the next page starts.
    const deployed = {
      status: "COMPLETED",
      steps: [
        { step: "notify", logs: ["info: start"] },
        { step: "send", logs: [] },
      ],
    };
    const first = await withRecordedWrites(ws, RUN, deployed);
    assert.equal(first.recordedWriteCount, MAX_RECORDED_PER_RUN);
    assert.equal(first.recordedWrites?.length, RECORDED_PAGE_SIZE);
    assert.equal(first.recordedWritesNext, RECORDED_PAGE_SIZE);
    const last = await recordedWritesOf(ws, RUN, {
      from: MAX_RECORDED_PER_RUN - 5,
    });
    assert.equal(last.writes.length, 5);
    assert.equal(last.next, undefined);
    // A page stops near its character budget; `full` bodies stay whole.
    await WorkflowRecordedWrite.updateMany(
      { runId: RUN },
      { $set: { "request.body": { text: "y".repeat(30_000) } } },
    );
    const big = await recordedWritesOf(ws, RUN, { full: true });
    assert.ok(big.writes.length >= 1 && big.writes.length < 5);
    assert.deepEqual(big.writes[0].body, { text: "y".repeat(30_000) });
    assert.equal(big.next, big.writes.length);
    const summary = await recordedWritesOf(ws, RUN);
    assert.equal(summary.writes.length, RECORDED_PAGE_SIZE);
    assert.match(String(summary.writes[0].body), /\(30011 chars; full: true/);

    // Each step's logs say how many of its writes were recorded, when the
    // page holds them all.
    const ws2 = String(new Types.ObjectId());
    for (const step of ["send", "send", "notify"]) {
      await keepRecordedWrite(ws2, { runId: RUN, step }, slack, post(step));
    }
    const counted = await withRecordedWrites(ws2, RUN, deployed);
    assert.equal(counted.recordedWriteCount, 3);
    assert.equal(counted.recordedWritesNext, undefined);
    assert.deepEqual(
      counted.steps.map(step => step.logs.at(-1)),
      [
        "warn: 1 connection write recorded, not sent (an agent started this run): see recordedWrites",
        "warn: 2 connection writes recorded, not sent (an agent started this run): see recordedWrites",
      ],
    );
    assert.equal(counted.steps[0].logs[0], "info: start");

    // A sandbox run's are its person's only; another workspace sees none.
    await keepRecordedWrite(
      ws2,
      { runId: SANDBOX_RUN, userId: "marc" },
      slack,
      post("mine"),
    );
    const sandboxRun = { status: "COMPLETED", steps: [] };
    const marc = await withRecordedWrites(ws2, SANDBOX_RUN, sandboxRun, {
      userId: "marc",
    });
    assert.deepEqual(marc.recordedWrites?.[0].body, {
      channel: "C1",
      text: "mine",
    });
    assert.equal(
      await withRecordedWrites(ws2, SANDBOX_RUN, sandboxRun, {
        userId: "vera",
      }),
      sandboxRun,
    );
    assert.equal((await recordedWritesOf(ws, SANDBOX_RUN)).total, 0);

    console.log("recorded writes tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
