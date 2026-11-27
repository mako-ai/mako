import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { expect, it, vi } from "vitest";
import {
  WorkflowRecordedRun,
  WorkflowRecordedWrite,
} from "../database/models/workflow-recorded-writes";
import {
  workflowRecordedRuns,
  workflowRecordedWrites,
} from "../database/pg/schema";
import { setupPgTestDb } from "../test-support/pg-test";
import { workflowRecordedWritesRepo } from "./control-plane-app";

it("commits the Mongo fence, run counter and write together on a prepared service with PG available", async () => {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const pg = await setupPgTestDb();
  vi.stubEnv("K_SERVICE", "mako-canary");
  vi.stubEnv("MAKO_CONTROL_PLANE_FENCE_V1", "1");
  vi.stubEnv("MAKO_CONTROL_PLANE_PG_ACTIVE", undefined);
  vi.stubEnv("MAKO_TEST_MONGO_FALLBACK", "0");
  try {
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      WorkflowRecordedRun.init(),
      WorkflowRecordedWrite.init(),
    ]);
    const workspaceId = new Types.ObjectId();
    const filter = { workspaceId, runId: "prepared-run" };
    const write = {
      workspaceId: workspaceId.toHexString(),
      runId: filter.runId,
      connectionId: new Types.ObjectId().toHexString(),
      connection: "fixture",
      request: { method: "POST", url: "https://fixture.invalid", headers: {} },
    };
    const fences = mongoose.connection.collection<{
      _id: string;
      owner: string;
      serial: number;
    }>("migration_writer_fences");
    const fence = () => fences.findOne({ _id: "control-plane-small-v1" });

    expect(await workflowRecordedWritesRepo.appendWrite(write, 2)).toBe(0);
    expect(await fence()).toMatchObject({ owner: "mongo", serial: 1 });

    // The run counter and fence have been incremented when the insert fails validation.
    await expect(
      workflowRecordedWritesRepo.appendWrite({ ...write, connection: "" }, 2),
    ).rejects.toThrow(/connection/);
    expect(await fence()).toMatchObject({ owner: "mongo", serial: 1 });
    expect(await WorkflowRecordedRun.findOne(filter).lean()).toMatchObject({
      count: 1,
    });
    expect(await WorkflowRecordedWrite.countDocuments(filter)).toBe(1);

    expect(await workflowRecordedWritesRepo.appendWrite(write, 2)).toBe(1);
    expect(await workflowRecordedWritesRepo.appendWrite(write, 2)).toBeNull();
    expect(await WorkflowRecordedRun.findOne(filter).lean()).toMatchObject({
      count: 2,
    });
    expect(
      (await WorkflowRecordedWrite.find(filter).sort({ seq: 1 }).lean()).map(
        row => row.seq,
      ),
    ).toEqual([0, 1]);
    expect(await pg.db.select().from(workflowRecordedRuns)).toEqual([]);
    expect(await pg.db.select().from(workflowRecordedWrites)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await mongoose.disconnect();
    await mongo.stop();
    await pg.close();
  }
});
