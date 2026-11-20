/**
 * The CDC state machine's transitions are compare-and-swap, against an
 * in-memory Mongo. Before, they were findOne → mutate → save with nothing
 * in the write filter: two concurrent actors could both read `active`, both
 * "apply" a transition and log a `fromState` that was never true.
 *
 * Run: npx tsx src/sync-cdc/sync-state-cas.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { CdcStateTransition, Flow } from "../database/workspace-schema";
import { cdcSyncStateService } from "./sync-state";
import {
  automaticRecoveryFilter,
  scheduledBackfillGate,
} from "./backfill/attempt";
import { startBackfill } from "./backfill/lifecycle";
import { markCdcBackfillCompletedForFlow } from "./backfill/completion";
import {
  createFlowRunContext,
  type FlowRunContext,
} from "../inngest/functions/flow/run-context";
import { backfillResumeDue } from "../inngest/functions/flow/infra-failure";

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const workspaceId = new Types.ObjectId();
  const insert = async (fields: Record<string, unknown>) => {
    const _id = new Types.ObjectId();
    await Flow.collection.insertOne({
      _id,
      workspaceId,
      syncEngine: "cdc",
      ...fields,
    });
    return String(_id);
  };
  const ids = { workspaceId: String(workspaceId) };

  try {
    // 1. Ten concurrent PAUSEs from `active`: exactly one applies.
    const racing = await insert({ streamState: "active" });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        cdcSyncStateService.applyStreamTransition({
          ...ids,
          flowId: racing,
          event: { type: "PAUSE" },
        }),
      ),
    );
    assert.equal(results.filter(r => r.changed).length, 1);
    assert.ok(
      results
        .filter(r => !r.changed)
        .every(r => r.fromState === "paused" && r.toState === "paused"),
    );
    const audit = await CdcStateTransition.find({
      flowId: new Types.ObjectId(racing),
    }).lean();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].fromState, "active");

    // 2. PAUSE racing FAIL from `active`: whichever loses re-reads and is
    //    applied (or not) against the winner's state, so the audit rows
    //    form a chain (each fromState is the previous toState).
    const chained = await insert({ streamState: "active" });
    await Promise.all([
      cdcSyncStateService.applyStreamTransition({
        ...ids,
        flowId: chained,
        event: { type: "PAUSE" },
      }),
      cdcSyncStateService.applyStreamTransition({
        ...ids,
        flowId: chained,
        event: { type: "FAIL", errorCode: "X" },
      }),
    ]);
    const rows = await CdcStateTransition.find({
      flowId: new Types.ObjectId(chained),
    })
      .sort({ at: 1, _id: 1 })
      .lean();
    assert.equal(rows[0].fromState, "active");
    for (let i = 1; i < rows.length; i++) {
      assert.equal(rows[i].fromState, rows[i - 1].toState);
    }
    const final = await Flow.collection.findOne({
      _id: new Types.ObjectId(chained),
    });
    assert.equal(final?.streamState, rows[rows.length - 1].toState);

    // 3. A missing state reads as idle and is CAS-matched as idle.
    const fresh = await insert({});
    const started = await cdcSyncStateService.applyStreamTransition({
      ...ids,
      flowId: fresh,
      event: { type: "START" },
    });
    assert.deepEqual(started, {
      changed: true,
      fromState: "idle",
      toState: "active",
    });

    // 4. Backfill with a null subdocument: START creates it.
    const nullGate = await insert({ backfillState: null });
    const bf = await cdcSyncStateService.applyBackfillTransition({
      ...ids,
      flowId: nullGate,
      event: { type: "START" },
    });
    assert.equal(bf.toState, "running");
    const nullGateDoc = await Flow.collection.findOne({
      _id: new Types.ObjectId(nullGate),
    });
    assert.equal(nullGateDoc?.backfillState?.status, "running");

    // 5. onlyFrom: abandoned-flow cleanup fails a `running` backfill, but
    //    leaves one the user paused in the meantime.
    const paused = await insert({ backfillState: { status: "paused" } });
    const cleanup = await cdcSyncStateService.applyBackfillTransition({
      ...ids,
      flowId: paused,
      event: { type: "FAIL", errorCode: "WORKER_TIMEOUT" },
      onlyFrom: ["running"],
    });
    assert.equal(cleanup.changed, false);
    const pausedDoc = await Flow.collection.findOne({
      _id: new Types.ObjectId(paused),
    });
    assert.equal(pausedDoc?.backfillState?.status, "paused");

    // 6. Workspace scoping: another workspace's id is "not found".
    await assert.rejects(
      cdcSyncStateService.applyStreamTransition({
        workspaceId: String(new Types.ObjectId()),
        flowId: racing,
        event: { type: "RESUME" },
      }),
      /Flow not found/,
    );

    // 7. Cooldown and scope survive a fresh initialisation of the Mongo client.
    const runId = "cooldown-test-run";
    const scope = { mode: "subset", entities: ["ad_creatives"] };
    const throttled = await insert({
      backfillState: { status: "running", runId, scope },
    });
    const deadline = new Date("2026-11-20T20:30:00Z");
    await cdcSyncStateService.applyBackfillTransition({
      ...ids,
      flowId: throttled,
      onlyFrom: ["running"],
      event: { type: "FAIL", providerRetryAt: deadline },
    });
    await mongoose.disconnect();
    await mongoose.connect(mongo.getUri());
    const stored = await Flow.findById(throttled).lean();
    assert.equal(stored?.backfillState?.status, "error");
    assert.equal(stored?.backfillState?.runId, runId);
    assert.deepEqual(stored?.backfillState?.scope?.entities, scope.entities);
    assert.deepEqual(stored?.backfillState?.providerRetryAt, deadline);
    assert.equal(
      backfillResumeDue(stored?.backfillState, new Date(+deadline - 1)),
      false,
    );
    assert.equal(backfillResumeDue(stored?.backfillState, deadline), true);

    // 8. Explicit pause wins a concurrent throttle regardless of write order.
    for (const failureFirst of [false, true]) {
      const flowId = await insert({
        backfillState: { status: "running", runId, scope },
      });
      const pause = () =>
        cdcSyncStateService.applyBackfillTransition({
          ...ids,
          flowId,
          event: { type: "PAUSE" },
        });
      const fail = () =>
        cdcSyncStateService.applyBackfillTransition({
          ...ids,
          flowId,
          onlyFrom: ["running"],
          event: { type: "FAIL", providerRetryAt: deadline },
        });
      await Promise.all(
        (failureFirst ? [fail, pause] : [pause, fail]).map(fn => fn()),
      );
      const final = await Flow.findById(flowId).lean();
      assert.equal(final?.backfillState?.status, "paused");
      assert.equal(final?.backfillState?.runId, runId);
    }

    // 9. An unrelated failure has no persisted delay.
    const unrelated = await insert({
      backfillState: { status: "running", runId },
    });
    await cdcSyncStateService.applyBackfillTransition({
      ...ids,
      flowId: unrelated,
      event: { type: "FAIL", errorCode: "HTTP_401" },
    });
    const ordinary = await Flow.findById(unrelated).lean();
    assert.equal(ordinary?.backfillState?.status, "error");
    assert.equal(ordinary?.backfillState?.providerRetryAt, undefined);
    assert.equal(
      backfillResumeDue(ordinary?.backfillState, new Date(+deadline - 1)),
      true,
    );

    // 10. Pause beats a cleanup snapshot or a dispatch already claimed.
    const ready = await insert({
      backfillState: {
        status: "error",
        runId,
        attemptId: "failed-attempt",
        scope,
        providerRetryAt: new Date(0),
      },
    });
    const readyDoc = await Flow.findById(ready).lean();
    const recoveryState = readyDoc?.backfillState;
    assert.ok(recoveryState);
    assert.ok(automaticRecoveryFilter(recoveryState, new Date(+deadline + 1)));
    await cdcSyncStateService.applyBackfillTransition({
      ...ids,
      flowId: ready,
      event: { type: "PAUSE" },
    });
    await assert.rejects(
      startBackfill(ids.workspaceId, ready, {
        reuseExistingRunId: true,
        automaticRecovery: recoveryState,
      }),
      /lost its claim/,
    );
    assert.equal(
      (await Flow.findById(ready).lean())?.backfillState?.status,
      "paused",
    );
    // An event sent just before a Pause cannot start work after it.
    const queued = await insert({
      backfillState: { status: "running", runId, attemptId: "queued" },
    });
    await cdcSyncStateService.applyBackfillTransition({
      ...ids,
      flowId: queued,
      event: { type: "PAUSE" },
    });
    const ctx = createFlowRunContext({
      step: {
        run: (_id: string, fn: () => unknown) => fn(),
      } as FlowRunContext["step"],
      logger: {} as FlowRunContext["logger"],
      data: {
        flowId: queued,
        backfill: true,
        backfillRunId: runId,
        backfillAttemptId: "queued",
      },
    });
    await assert.rejects(
      ctx.throwIfExecutionCancelled("test"),
      /attempt cancelled or superseded/,
    );

    // 11. A schedule cannot stamp a due time or replace the throttled run.
    const scheduledAt = new Date("2026-11-20T20:32:00Z");
    const scheduleTarget = await insert({
      backfillState: {
        status: "error",
        runId,
        attemptId: "throttled",
        scope,
        providerRetryAt: deadline,
      },
    });
    const claim = await Flow.updateOne(
      { _id: scheduleTarget, ...scheduledBackfillGate },
      { $set: { "backfillSchedule.lastRunAt": scheduledAt } },
    );
    assert.equal(claim.modifiedCount, 0);
    await assert.rejects(
      startBackfill(ids.workspaceId, scheduleTarget, {
        trigger: "scheduled",
        entities: ["ads"],
      }),
      /lost its claim/,
    );
    const held = await Flow.findById(scheduleTarget).lean();
    assert.equal(held?.backfillSchedule?.lastRunAt, undefined);
    assert.equal(held?.backfillState?.runId, runId);
    assert.deepEqual(held?.backfillState?.providerRetryAt, deadline);

    // 12. A delayed failure from the same checkpoint cannot charge its successor.
    const successor = await insert({
      backfillState: {
        status: "running",
        runId,
        attemptId: "successor",
        dispatchPendingAt: deadline,
        consecutiveFailures: 2,
      },
    });
    const failAttempt = (attemptId: string) =>
      cdcSyncStateService.applyBackfillTransition({
        ...ids,
        flowId: successor,
        onlyFrom: ["running"],
        expectedAttempt: { runId, attemptId },
        event: { type: "FAIL", providerRetryAt: deadline },
        failureUpdate: {
          $inc: { "backfillState.consecutiveFailures": 1 },
          $set: {},
        },
      });
    assert.equal((await failAttempt("predecessor")).changed, false);
    const running = await Flow.findById(successor).lean();
    assert.equal(running?.backfillState?.status, "running");
    assert.equal(running?.backfillState?.consecutiveFailures, 2);
    assert.deepEqual(running?.backfillState?.dispatchPendingAt, deadline);
    assert.equal(running?.backfillState?.providerRetryAt, undefined);
    assert.equal((await failAttempt("successor")).changed, true);
    assert.equal((await failAttempt("successor")).changed, false);
    const failed = await Flow.findById(successor).lean();
    assert.equal(failed?.backfillState?.consecutiveFailures, 3);
    assert.equal(failed?.backfillState?.dispatchPendingAt, undefined);
    assert.deepEqual(failed?.backfillState?.providerRetryAt, deadline);

    // 13. Replaying a completed attempt can finish its success steps.
    const finished = await insert({
      backfillState: { status: "running", runId, attemptId: "finishing" },
    });
    const memo = new Map<string, unknown>();
    const replay = createFlowRunContext({
      step: {
        run: async (id: string, fn: () => unknown) => {
          if (!memo.has(id)) memo.set(id, await fn());
          return memo.get(id);
        },
      } as FlowRunContext["step"],
      logger: {} as FlowRunContext["logger"],
      data: {
        flowId: finished,
        backfill: true,
        backfillRunId: runId,
        backfillAttemptId: "finishing",
      },
    });
    await replay.throwIfExecutionCancelled("before-initialize-logger");
    await markCdcBackfillCompletedForFlow({ ...ids, flowId: finished });
    assert.equal(
      (await Flow.findById(finished).lean())?.backfillState?.runId,
      undefined,
    );
    await replay.throwIfExecutionCancelled("before-initialize-logger");
    await replay.throwIfExecutionCancelled("connector-before-success-mark");
    await assert.rejects(
      replay.throwIfExecutionCancelled("connector-before-entity", {
        entity: "new",
      }),
      /cancelled or superseded/,
    );

    // 14. Pause is a schedule gate even if a throttle never wrote a deadline.
    const pausedWithoutDeadline = await insert({
      backfillState: { status: "paused", runId },
    });
    const pausedClaim = await Flow.updateOne(
      { _id: pausedWithoutDeadline, ...scheduledBackfillGate },
      { $set: { "backfillSchedule.lastRunAt": scheduledAt } },
    );
    assert.equal(pausedClaim.modifiedCount, 0);

    // 15. Cancel discards the cooldown with the run and unblocks a future schedule.
    await cdcSyncStateService.applyBackfillTransition({
      ...ids,
      flowId: scheduleTarget,
      expectedAttempt: { runId, attemptId: "throttled" },
      event: { type: "CANCEL" },
    });
    const discarded = await Flow.findById(scheduleTarget).lean();
    assert.equal(discarded?.backfillState?.status, "idle");
    assert.equal(discarded?.backfillState?.runId, undefined);
    assert.equal(discarded?.backfillState?.attemptId, undefined);
    assert.equal(discarded?.backfillState?.providerRetryAt, undefined);
    assert.ok(
      await Flow.exists({ _id: scheduleTarget, ...scheduledBackfillGate }),
    );

    // 16. An earlier attempt cannot complete a replacement on the same cursor.
    const replacement = await insert({
      backfillState: { status: "running", runId, attemptId: "replacement" },
    });
    const finish = (attemptId: string) =>
      markCdcBackfillCompletedForFlow({
        ...ids,
        flowId: replacement,
        expectedAttempt: { runId, attemptId },
      });
    assert.equal(await finish("old"), false);
    assert.equal(
      (await Flow.findById(replacement).lean())?.backfillState?.runId,
      runId,
    );
    assert.equal(await finish("replacement"), true);
    assert.equal(await finish("replacement"), true);

    // 17. A returned dispatch with no execution is replaceable after 10 minutes.
    // A worker which started after the sweep read the flow wins that race.
    const dispatchPendingAt = new Date("2026-11-20T20:00:00Z");
    const queuedState = {
      status: "running" as const,
      runId,
      attemptId: "pending",
      dispatchPendingAt,
    };
    const missingWorker = await insert({ backfillState: queuedState });
    assert.equal(
      automaticRecoveryFilter(
        queuedState,
        new Date(+dispatchPendingAt + 599_999),
      ),
      null,
    );
    const elapsed = automaticRecoveryFilter(
      queuedState,
      new Date(+dispatchPendingAt + 600_000),
    );
    assert.ok(elapsed);
    await Flow.updateOne(
      { _id: missingWorker },
      { $unset: { "backfillState.dispatchPendingAt": "" } },
    );
    assert.equal(
      (
        await Flow.updateOne(
          { _id: missingWorker, ...elapsed },
          { $set: { "backfillState.attemptId": "wrong" } },
        )
      ).matchedCount,
      0,
    );
    const stillPending = await insert({ backfillState: queuedState });
    assert.equal(
      (
        await Flow.updateOne(
          { _id: stillPending, ...elapsed },
          { $set: { "backfillState.attemptId": "recovered" } },
        )
      ).matchedCount,
      1,
    );
    assert.equal(
      (await Flow.findById(stillPending).lean())?.backfillState?.runId,
      runId,
    );

    console.info("sync-state-cas.db.test: ok");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
