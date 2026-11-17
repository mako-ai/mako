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
