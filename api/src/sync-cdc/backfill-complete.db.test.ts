/**
 * A completed backfill clears an old failure's meta, against an in-memory
 * Mongo: the COMPLETE transition after it is a no-op (status is already
 * completed), so without this a flow kept FLOW_EXECUTION_FAILED from a
 * months-old failure through every clean run since. A live stream error keeps
 * its meta, which the consumer's self-heal reads.
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { Flow } from "../database/workspace-schema";
import { markCdcBackfillCompletedForFlow } from "./backfill";

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    const workspaceId = new Types.ObjectId();
    const insert = async (fields: Record<string, unknown>) => {
      const _id = new Types.ObjectId();
      await Flow.collection.insertOne({
        _id,
        workspaceId,
        syncEngine: "cdc",
        backfillState: { status: "running", runId: "r1" },
        ...fields,
      });
      await markCdcBackfillCompletedForFlow({
        workspaceId: String(workspaceId),
        flowId: String(_id),
      });
      return (await Flow.collection.findOne({ _id }))!;
    };

    const stale = await insert({
      streamState: "active",
      syncStateMeta: {
        lastEvent: "backfill:FAIL",
        lastErrorCode: "FLOW_EXECUTION_FAILED",
        lastErrorMessage: "No matching signature for function TIMESTAMP_TRUNC",
      },
    });
    assert.equal(stale.backfillState.status, "completed");
    assert.equal(stale.backfillState.runId, undefined);
    assert.deepEqual(stale.syncStateMeta, {
      lastEvent: "backfill:COMPLETE",
      lastReason: "Backfill completed",
    });

    const streamError = await insert({
      streamState: "error",
      syncStateMeta: {
        lastEvent: "stream:FAIL",
        lastErrorCode: "MATERIALIZATION_FAILED",
      },
    });
    assert.equal(streamError.backfillState.status, "completed");
    assert.equal(streamError.syncStateMeta.lastErrorCode, "MATERIALIZATION_FAILED");

    const clean = await insert({
      streamState: "active",
      syncStateMeta: { lastEvent: "stream:START", lastReason: "x" },
      syncStateUpdatedAt: new Date(0),
    });
    assert.equal(clean.syncStateMeta.lastEvent, "stream:START");
    assert.equal(clean.syncStateUpdatedAt.getTime(), 0);

    console.log("backfill-complete.db.test: ok");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
