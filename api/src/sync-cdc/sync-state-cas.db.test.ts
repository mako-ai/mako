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
import { pauseStream } from "./backfill/lifecycle";
import { CdcConsumerService } from "./consumer";
import { cdcSyncStateService } from "./sync-state";

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
    // Idle (including old documents without a state) and error flows can
    // both dispatch materialization. The pause service must stop new runs.
    for (const streamState of ["idle", undefined, "error"]) {
      const flowId = await insert(streamState ? { streamState } : {});
      assert.deepEqual(await pauseStream(ids.workspaceId, flowId), {
        paused: true,
      });
      assert.equal((await Flow.findById(flowId).lean())?.streamState, "paused");
      assert.deepEqual(
        await new CdcConsumerService().materializeEntity({
          ...ids,
          flowId,
          entity: "recordings",
        }),
        { skipped: true, reason: "streamState is paused" },
      );
      const backfillStarted = await cdcSyncStateService.applyStreamTransition({
        ...ids,
        flowId,
        event: { type: "START" },
      });
      assert.equal(backfillStarted.toState, "paused");
      const inFlightFailed = await cdcSyncStateService.applyStreamTransition({
        ...ids,
        flowId,
        event: { type: "FAIL", errorCode: "MATERIALIZATION_FAILED" },
      });
      assert.equal(inFlightFailed.toState, "paused");
      const inFlightRecovered = await cdcSyncStateService.applyStreamTransition(
        {
          ...ids,
          flowId,
          event: { type: "RECOVER" },
          onlyFrom: ["error"],
        },
      );
      assert.equal(inFlightRecovered.toState, "paused");
      const resumed = await cdcSyncStateService.applyStreamTransition({
        ...ids,
        flowId,
        event: { type: "RESUME" },
      });
      assert.equal(resumed.toState, "active");
    }

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

    // 2. An in-flight failure cannot undo a racing operator pause.
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
    assert.equal(final?.streamState, "paused");

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
