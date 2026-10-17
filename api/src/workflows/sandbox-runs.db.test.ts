/**
 * Sandbox runs, kept and waited on, against a real (in-memory) Mongo: the
 * run store and the box lock it holds (sandbox-runs.ts), the server-side
 * wait (wait.ts, status.ts). The box itself is not here: a real sandbox run
 * is verified end to end against a dev API (see the PR).
 *
 * Run with: pnpm --filter api exec tsx src/workflows/sandbox-runs.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { Workspace } from "../database/workspace-schema";
import {
  claimBoxForRun,
  createSandboxRun,
  finishSandboxRun,
  heartbeatSandboxRun,
  isSandboxRunId,
  listSandboxRuns,
  readSandboxRun,
  SandboxRun,
  STALE_AFTER_MS,
  storedResult,
} from "./sandbox-runs";
import { deploySettled, readStatus, waitForRun } from "./status";
import { MAX_WAIT_SECONDS, waitFor, waitSeconds } from "./wait";

const WS = new Types.ObjectId().toString();
const TASK = "33333333-3333-3333-3333-333333333333";

/** What run.mjs leaves for a run of two steps, one with a long output. */
function engineResult(output: string, lines: number) {
  return {
    detail: {
      run: {
        metadata: { id: "embedded-run" },
        status: "COMPLETED",
        input: { input: { limit: 1 }, triggered_by: "manual" },
        output: { ok: true },
        duration: 1234,
      },
      tasks: [
        {
          metadata: { id: TASK },
          actionId: "eval:label",
          status: "COMPLETED",
          taskInsertedAt: "2026-10-16T10:00:00Z",
          output,
        },
      ],
    },
    logs: {
      [TASK]: Array.from({ length: lines }, (_, i) => ({
        message: `line ${i}`,
      })),
    },
  };
}

async function lockTests() {
  const claim = (runId: string, userId = "lock") =>
    claimBoxForRun({ runId, workspaceId: WS, userId });
  // One RUNNING run per box: the next waits QUEUED.
  const a = await createSandboxRun(WS, "lock", "eval", {});
  const b = await createSandboxRun(WS, "lock", "eval", {});
  assert.equal(await claim(a), true);
  assert.equal(await claim(b), false);
  assert.equal((await SandboxRun.findById(b).lean())?.status, "QUEUED");
  // Another person's box is another box.
  const other = await createSandboxRun(WS, "other", "eval", {});
  assert.equal(await claim(other, "other"), true);
  // The box is free once the run ends.
  await finishSandboxRun(a, { error: "done" });
  assert.equal(await claim(b), true);
  await finishSandboxRun(b, { error: "done" });
  // Four race for a free box: exactly one wins.
  const racers = await Promise.all(
    [1, 2, 3, 4].map(() => createSandboxRun(WS, "lock", "eval", {})),
  );
  const won = await Promise.all(racers.map(id => claim(id)));
  assert.equal(won.filter(Boolean).length, 1);
  const winner = racers[won.indexOf(true)];
  // A running run whose driver died (no heartbeat) stops holding the box:
  // the next claim ends it as lost and takes the box.
  await SandboxRun.updateOne(
    { _id: winner },
    { heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 1000) },
  );
  const next = racers.find(id => id !== winner) ?? "";
  assert.equal(await claim(next), true);
  const lost = await SandboxRun.findById(winner).lean();
  assert.equal(lost?.status, "FAILED");
  assert.match(lost?.error ?? "", /stopped before it ended/);
  assert.equal(await heartbeatSandboxRun(winner), false);
  // A run that already ended cannot start.
  await assert.rejects(claim(winner), /ended before it started/);
  await SandboxRun.updateMany(
    { userId: { $in: ["lock", "other"] }, status: { $ne: "FAILED" } },
    { $set: { status: "FAILED" } },
  );
}

async function storeTests() {
  const runId = await createSandboxRun(WS, "u1", "eval", { limit: 1 });
  assert.ok(isSandboxRunId(runId));
  assert.equal(isSandboxRunId("22222222-2222-2222-2222-222222222222"), false);

  // Started: the caller sees it queued, then running.
  let run = await readSandboxRun(WS, "u1", runId);
  assert.equal(run?.status, "QUEUED");
  assert.deepEqual(run?.steps, []);
  assert.equal(
    await claimBoxForRun({ runId, workspaceId: WS, userId: "u1" }),
    true,
  );
  assert.equal((await readSandboxRun(WS, "u1", runId))?.status, "RUNNING");
  assert.equal(await heartbeatSandboxRun(runId), true);

  // Only its starter reads it.
  assert.equal(await readSandboxRun(WS, "u2", runId), null);
  assert.equal(
    await readSandboxRun(new Types.ObjectId().toString(), "u1", runId),
    null,
  );

  // Ended: the engine's record, kept whole.
  const long = "x".repeat(300_000);
  await finishSandboxRun(runId, { result: engineResult(long, 500) });
  assert.equal(
    await heartbeatSandboxRun(runId),
    false,
    "ended runs stay ended",
  );
  run = await readSandboxRun(WS, "u1", runId);
  assert.equal(run?.status, "COMPLETED");
  assert.equal(run?.runId, runId, "Mako's id, not the embedded engine's");
  assert.equal(run?.sandbox, true);
  assert.equal(run?.workflowId, "eval");
  assert.equal(run?.input, '{"limit":1}');
  const [step] = run?.steps ?? [];
  // The summary: the start of the output, the last 20 lines.
  assert.equal(step.output?.length, 2000 + "… (300000 chars)".length);
  assert.equal(step.logs.length, 20);
  assert.equal(step.logs.at(-1), "line 499");
  assert.equal(step.logLinesOmitted, 480);
  // Full: all of it.
  const full = await readSandboxRun(WS, "u1", runId, { full: true });
  assert.equal(full?.steps[0].output, long);
  assert.equal(full?.steps[0].logs.length, 500);
  assert.ok(full?.durationMs !== undefined);

  // A second finish does not overwrite the first.
  await finishSandboxRun(runId, { error: "late" });
  assert.equal((await readSandboxRun(WS, "u1", runId))?.status, "COMPLETED");

  // Type errors: a failed run with buildError.
  const broken = await createSandboxRun(WS, "u1", "eval", {});
  await finishSandboxRun(broken, {
    result: { buildError: "workflow.ts(3,1): error TS2304" },
  });
  const brokenRun = await readSandboxRun(WS, "u1", broken);
  assert.equal(brokenRun?.status, "FAILED");
  assert.equal(brokenRun?.buildError, "workflow.ts(3,1): error TS2304");

  // No result at all: the box's output says why.
  const lost = await createSandboxRun(WS, "u1", "eval", {});
  await finishSandboxRun(lost, {
    error: "The sandbox run did not finish.",
    boxLog: `${"install\n".repeat(20_000)}hatchet embedded sidecar exited with code 1`,
  });
  const lostRun = await readSandboxRun(WS, "u1", lost);
  assert.equal(lostRun?.status, "FAILED");
  assert.equal(lostRun?.error, "The sandbox run did not finish.");
  assert.match(lostRun?.boxLog ?? "", /exited with code 1$/);
  assert.ok((lostRun?.boxLog ?? "").length <= 4000);

  // A run whose driver died (no heartbeat) ends as failed when read.
  const orphan = await createSandboxRun(WS, "u1", "eval", {});
  await claimBoxForRun({ runId: orphan, workspaceId: WS, userId: "u1" });
  await SandboxRun.updateOne(
    { _id: orphan },
    { heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 1000) },
  );
  const orphanRun = await readSandboxRun(WS, "u1", orphan);
  assert.equal(orphanRun?.status, "FAILED");
  assert.match(orphanRun?.error ?? "", /stopped before it ended/);

  // The list: newest first, the starter's only.
  await createSandboxRun(WS, "u2", "eval", {});
  const listed = await listSandboxRuns(WS, "u1", 10);
  assert.deepEqual(
    listed.map(r => r.runId),
    [orphan, lost, broken, runId],
  );
  assert.ok(listed.every(r => r.sandbox && r.trigger === "sandbox"));
  assert.equal((await listSandboxRuns(WS, "u1", 2)).length, 2);
}

async function sizeTests() {
  // Small enough: kept as it is.
  const small = engineResult("y".repeat(10), 3);
  assert.deepEqual(JSON.parse(storedResult(small)), small);
  // Larger than a document holds: each text is cut until it fits.
  const huge = engineResult("z".repeat(1_000_000), 0);
  huge.logs[TASK] = Array.from({ length: 40 }, () => ({
    message: "w".repeat(400_000),
  }));
  const stored = storedResult(huge);
  assert.ok(stored.length < 12_000_000);
  const parsed = JSON.parse(stored);
  assert.equal(parsed.detail.run.status, "COMPLETED");
  assert.match(parsed.logs[TASK][0].message, /… \(400000 chars\)$/);
  // And it can be stored and read back.
  const runId = await createSandboxRun(WS, "u3", "eval", {});
  await finishSandboxRun(runId, { result: huge });
  const run = await readSandboxRun(WS, "u3", runId, { full: true });
  assert.equal(run?.status, "COMPLETED");
  assert.equal(run?.steps[0].logs.length, 40);
}

async function waitTests() {
  assert.equal(waitSeconds(undefined), 0);
  assert.equal(waitSeconds(-5), 0);
  assert.equal(waitSeconds(30), 30);
  assert.equal(waitSeconds(600), MAX_WAIT_SECONDS);
  assert.ok(MAX_WAIT_SECONDS * 1000 < 120_000, "under the MCP exchange limit");

  // A fake clock: reads until done, or until the time is up.
  let clock = 0;
  const fake = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
  let reads = 0;
  const done = await waitFor(
    async () => ++reads,
    n => n >= 3,
    { seconds: 10, intervalMs: 1000, ...fake },
  );
  assert.deepEqual(done, { value: 3, done: true });
  reads = 0;
  clock = 0;
  const timedOut = await waitFor(
    async () => ++reads,
    () => false,
    {
      seconds: 5,
      intervalMs: 2000,
      ...fake,
    },
  );
  assert.equal(timedOut.done, false);
  assert.equal(clock, 5000, "never sleeps past the deadline");
  assert.equal(reads, 4);
  // No wait: one read.
  reads = 0;
  assert.equal(
    (
      await waitFor(
        async () => ++reads,
        () => false,
        { seconds: 0, ...fake },
      )
    ).done,
    false,
  );
  assert.equal(reads, 1);

  // A sandbox run ending during the wait: answered when it ends.
  const runId = await createSandboxRun(WS, "u4", "eval", {});
  await claimBoxForRun({ runId, workspaceId: WS, userId: "u4" });
  setTimeout(
    () => void finishSandboxRun(runId, { result: engineResult("done", 1) }),
    1500,
  );
  const started = Date.now();
  const ended = await waitForRun(WS, "u4", runId, { wait: 20 });
  assert.equal(ended.done, true);
  assert.equal(ended.run.status, "COMPLETED");
  assert.ok(Date.now() - started < 5000);
  // `full` after a wait: the whole run.
  const whole = await waitForRun(WS, "u4", runId, { wait: 5, full: true });
  assert.equal(whole.run.steps[0].output, "done");
  // Still going at the end of the wait: said so.
  const going = await createSandboxRun(WS, "u4", "eval", {});
  const still = await waitForRun(WS, "u4", going, { wait: 1 });
  assert.deepEqual([still.done, still.run.status], [false, "QUEUED"]);
  // Not the caller's: not found, whether or not they wait.
  await assert.rejects(waitForRun(WS, "u5", going, { wait: 1 }), /not found/);
}

async function deployWaitTests() {
  assert.equal(
    deploySettled({ liveSha: "a", targetSha: "a", buildError: null }),
    true,
  );
  assert.equal(
    deploySettled({ liveSha: "a", targetSha: "b", buildError: null }),
    false,
  );
  assert.equal(
    deploySettled({ liveSha: "a", targetSha: "b", buildError: "TS" }),
    true,
  );
  assert.equal(
    deploySettled({ liveSha: null, targetSha: null, buildError: null }),
    true,
  );

  // The worker reports the new commit during the wait: answered then.
  const id = new Types.ObjectId();
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  await Workspace.collection.insertOne({
    _id: id,
    name: "deploy",
    slug: `deploy-${id}`,
    createdBy: "tester",
    workflows: { live: { sha: b, tree: "t", names: [], running: { sha: a } } },
  });
  setTimeout(
    () =>
      void Workspace.collection.updateOne(
        { _id: id },
        { $set: { "workflows.live.running.sha": b } },
      ),
    2500,
  );
  const started = Date.now();
  const status = await readStatus(id.toString(), {
    userId: "u1",
    limit: 5,
    asAdmin: false,
    wait: 20,
  });
  const took = Date.now() - started;
  assert.ok(took >= 2000 && took < 8000, `answered when live (${took}ms)`);
  assert.equal(status.deployment.liveSha, b);
  assert.equal("deploying" in status, false);

  // A deploy that does not go live within the wait: `deploying`.
  await Workspace.collection.updateOne(
    { _id: id },
    { $set: { "workflows.live.sha": a.replace(/a/g, "c") } },
  );
  const pending = await readStatus(id.toString(), {
    limit: 5,
    asAdmin: false,
    wait: 1,
  });
  assert.equal(pending.deploying, true);
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    await SandboxRun.init();
    await lockTests();
    await storeTests();
    await sizeTests();
    await waitTests();
    await deployWaitTests();
    console.log("sandbox runs tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
