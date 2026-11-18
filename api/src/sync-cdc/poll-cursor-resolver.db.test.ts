/**
 * The poll cursor's Mongo side, against an in-memory Mongo: a completed poll
 * stamps its run start, the stamp never moves back, webhook materialization
 * never touches it, and the next poll resolves `since` from it.
 *
 * Run: npx tsx src/sync-cdc/poll-cursor-resolver.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { CdcEntityState, Flow } from "../database/workspace-schema";
import {
  resolvePollCursorForEntity,
  stampPollRunStartedAt,
} from "./poll-cursor-resolver";
import { cdcSyncStateService } from "./sync-state";

const MIN = 60_000;

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    const workspaceId = String(new Types.ObjectId());
    const flowId = String(new Types.ObjectId());
    const entity = "activities:Call";
    const execution = async (startedAt: string) => {
      const _id = new Types.ObjectId();
      await Flow.db
        .collection("flow_executions")
        .insertOne({ _id, flowId, startedAt: new Date(startedAt) });
      return String(_id);
    };

    // First poll ever: no stamp → destination fallback, run start known.
    const exec14 = await execution("2026-11-17T14:00:00Z");
    const first = await resolvePollCursorForEntity({
      flowId,
      entity,
      executionId: exec14,
      overlapMs: 10 * MIN,
    });
    assert.equal(first.since, undefined);
    assert.equal(first.runStartedAt, "2026-11-17T14:00:00.000Z");

    await stampPollRunStartedAt({
      workspaceId,
      flowId,
      entity,
      runStartedAt: first.runStartedAt!,
    });

    // Webhooks land and materialize: the poll stamp does not move.
    await cdcSyncStateService.advanceConsumerCursor({
      workspaceId,
      flowId,
      entity,
      lastIngestSeq: 42,
      rowsAppliedDelta: 3,
    });
    const afterWebhooks = await CdcEntityState.findOne({ flowId, entity })
      .lean()
      .exec();
    assert.equal(
      afterWebhooks?.lastPollRunStartedAt?.toISOString(),
      "2026-11-17T14:00:00.000Z",
    );
    assert.equal(afterWebhooks?.lastMaterializedSeq, 42);

    // The 15:00 poll reads from 14:00 minus 10 min.
    const exec15 = await execution("2026-11-17T15:00:00Z");
    const second = await resolvePollCursorForEntity({
      flowId,
      entity,
      executionId: exec15,
      overlapMs: 10 * MIN,
    });
    assert.equal(second.since, "2026-11-17T13:50:00.000Z");
    assert.equal(second.runStartedAt, "2026-11-17T15:00:00.000Z");

    // A late, older stamp (a slow retry) never moves the cursor back.
    await stampPollRunStartedAt({
      workspaceId,
      flowId,
      entity,
      runStartedAt: "2026-11-17T15:00:00Z",
    });
    await stampPollRunStartedAt({
      workspaceId,
      flowId,
      entity,
      runStartedAt: "2026-11-17T13:00:00Z",
    });
    const stamped = await CdcEntityState.findOne({ flowId, entity })
      .lean()
      .exec();
    assert.equal(
      stamped?.lastPollRunStartedAt?.toISOString(),
      "2026-11-17T15:00:00.000Z",
    );
    assert.equal(
      await CdcEntityState.countDocuments({ flowId, entity }),
      1,
      "one state document per entity",
    );

    // No execution id: no run start, so the run stamps nothing.
    const noExec = await resolvePollCursorForEntity({ flowId, entity });
    assert.equal(noExec.runStartedAt, undefined);
    assert.equal(noExec.since, "2026-11-17T14:50:00.000Z");

    // ── No stamp: the last successful run that synced the entity ──
    // ES Stripe, 2026-11-18: charges had no stamp at the 04:01 poll. The
    // previous day's 04:00 run synced charges; that is the anchor, not the
    // newest webhook row.
    {
      const flowOid = new Types.ObjectId();
      const flow2 = String(flowOid);
      const run = async (
        startedAt: string,
        extra: Record<string, unknown> = {},
      ) => {
        const _id = new Types.ObjectId();
        await Flow.db.collection("flow_executions").insertOne({
          _id,
          flowId: flowOid,
          startedAt: new Date(startedAt),
          status: "completed",
          success: true,
          stats: { syncedEntities: ["charges", "customers"] },
          ...extra,
        });
        return String(_id);
      };
      await run("2026-11-16T04:01:40Z");
      await run("2026-11-17T04:00:48Z");
      // Later runs that do not count: failed, or another entity only.
      await run("2026-11-17T10:00:00Z", { status: "failed", success: false });
      await run("2026-11-17T12:00:00Z", {
        stats: { syncedEntities: ["balance_transactions"] },
      });
      const current = await run("2026-11-18T04:01:15Z", {
        status: "running",
        success: false,
        stats: {},
      });
      const resolved = await resolvePollCursorForEntity({
        flowId: flow2,
        entity: "charges",
        executionId: current,
        overlapMs: 10 * MIN,
      });
      assert.equal(resolved.since, "2026-11-17T03:50:48.000Z");
      assert.match(resolved.reason, /last successful run/);

      // An entity no run ever synced: destination fallback.
      const none = await resolvePollCursorForEntity({
        flowId: flow2,
        entity: "refunds",
        executionId: current,
        overlapMs: 10 * MIN,
      });
      assert.equal(none.since, undefined);

      // Once stamped, the stamp wins.
      await stampPollRunStartedAt({
        workspaceId,
        flowId: flow2,
        entity: "charges",
        runStartedAt: "2026-11-18T04:01:15Z",
      });
      const next = await run("2026-11-19T04:00:00Z", {
        status: "running",
        success: false,
        stats: {},
      });
      const stampedNext = await resolvePollCursorForEntity({
        flowId: flow2,
        entity: "charges",
        executionId: next,
        overlapMs: 10 * MIN,
      });
      assert.equal(stampedNext.since, "2026-11-18T03:51:15.000Z");
    }

    console.log("poll-cursor-resolver.db.test.ts: all assertions passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
