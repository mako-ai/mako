import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
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
import { activateControlPlane } from "./control-plane-fence";
import {
  appsBoxPolicyRepo,
  workflowRecordedWritesRepo,
} from "./control-plane-app";

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
    // A converted standalone source cannot activate just because it now supports transactions.
    await mongoose.connection
      .collection<{ _id: string }>("migration_writer_fences")
      .updateOne(
        { _id: "control-plane-small-v1" },
        { $set: { standaloneOnly: true } },
      );
    const copy = vi.fn(async () => {});
    await expect(activateControlPlane(copy)).rejects.toThrow(
      /unfenced standalone/,
    );
    expect(copy).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await mongoose.disconnect();
    await mongo.stop();
    await pg.close();
  }
});

it("serves unmarked self-hosted standalone Mongo while refusing prepared writers and activation", async () => {
  const mongo = await MongoMemoryServer.create();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("K_SERVICE", undefined);
  vi.stubEnv("MAKO_CONTROL_PLANE_FENCE_V1", undefined);
  vi.stubEnv("MAKO_CONTROL_PLANE_PG_ACTIVE", undefined);
  try {
    await mongoose.connect(mongo.getUri());
    const now = new Date();
    expect(
      await appsBoxPolicyRepo.ensureSince("activity-tracking", now),
    ).toEqual(now);
    expect(await appsBoxPolicyRepo.readSince("activity-tracking")).toEqual(now);
    const row = await mongoose.connection
      .collection<{ _id: string }>("migration_writer_fences")
      .findOne({ _id: "control-plane-small-v1" });
    expect(row).toMatchObject({ owner: "mongo", standaloneOnly: true });
    const copy = vi.fn(async () => {});
    await expect(activateControlPlane(copy)).rejects.toThrow(/replica set/);
    expect(copy).not.toHaveBeenCalled();
    vi.stubEnv("MAKO_CONTROL_PLANE_FENCE_V1", "1");
    await expect(appsBoxPolicyRepo.ensureSince("marked", now)).rejects.toThrow(
      /replica set/,
    );
    vi.stubEnv("MAKO_CONTROL_PLANE_FENCE_V1", undefined);
    vi.stubEnv("K_SERVICE", "mako-canary");
    await expect(appsBoxPolicyRepo.ensureSince("cloud", now)).rejects.toThrow(
      /replica set/,
    );
    expect(await appsBoxPolicyRepo.readSince("cloud")).toBeNull();
  } finally {
    vi.unstubAllEnvs();
    await mongoose.disconnect();
    await mongo.stop();
  }
});
