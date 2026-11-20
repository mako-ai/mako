import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { type Connection, Types } from "mongoose";
import {
  admitInlineWebhook,
  closeInlineWebhookAdmission,
  type InlineWebhookScope,
} from "./inline-webhook-admission";

let mongo: MongoMemoryReplSet;
let workerA: Connection;
let workerB: Connection;

function database(connection: Connection) {
  assert(connection.db, "The test MongoDB connection must be open");
  return connection.db;
}

function scope(): InlineWebhookScope {
  return {
    workspaceId: new Types.ObjectId(),
    flowId: new Types.ObjectId(),
    sourceConnectionId: new Types.ObjectId(),
  };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  workerA = await mongoose.createConnection(mongo.getUri()).asPromise();
  workerB = await mongoose.createConnection(mongo.getUri()).asPromise();
});

afterAll(async () => {
  await workerA?.close();
  await workerB?.close();
  await mongo?.stop();
});

describe("inline webhook admission", () => {
  it("serializes an in-flight admission with a competing close", async () => {
    const key = scope();
    let entered!: () => void;
    let release!: () => void;
    const inTransaction = new Promise<void>(resolve => {
      entered = resolve;
    });
    const wait = new Promise<void>(resolve => {
      release = resolve;
    });
    const delivery = admitInlineWebhook(workerA, key, async session => {
      await database(workerA)
        .collection("admission_test_deliveries")
        .insertOne({ flow: key.flowId }, { session });
      entered();
      await wait;
      return "stored";
    });
    await inTransaction;
    const closing = closeInlineWebhookAdmission(workerB, key);
    release();
    expect(await delivery).toEqual({ admitted: true, value: "stored" });
    await closing;
    expect(
      await database(workerB)
        .collection("admission_test_deliveries")
        .countDocuments({ flow: key.flowId }),
    ).toBe(1);
    expect(
      await admitInlineWebhook(workerB, key, async () => {
        throw new Error("closed callback ran");
      }),
    ).toEqual({ admitted: false });
  });

  it("closes an absent record before admission and keeps other scopes open", async () => {
    const key = scope();
    await closeInlineWebhookAdmission(workerA, key);
    expect(await admitInlineWebhook(workerB, key, async () => 1)).toEqual({
      admitted: false,
    });
    for (const other of [
      { ...key, workspaceId: new Types.ObjectId() },
      { ...key, flowId: new Types.ObjectId() },
      { ...key, sourceConnectionId: new Types.ObjectId() },
    ]) {
      expect(await admitInlineWebhook(workerB, other, async () => 1)).toEqual({
        admitted: true,
        value: 1,
      });
    }
  });

  it("rolls back the gate and delivery together on persistence failure", async () => {
    const key = scope();
    await expect(
      admitInlineWebhook(workerA, key, async session => {
        await database(workerA)
          .collection("admission_test_deliveries")
          .insertOne({ flow: key.flowId }, { session });
        throw new Error("synthetic failure");
      }),
    ).rejects.toThrow("synthetic failure");
    expect(
      await database(workerB)
        .collection("admission_test_deliveries")
        .countDocuments({ flow: key.flowId }),
    ).toBe(0);
    const record = await database(workerB)
      .collection<{ _id: string; admissions: number }>(
        "inline_webhook_admissions",
      )
      .findOne({
        _id: `${key.workspaceId}:${key.flowId}:${key.sourceConnectionId}`,
      });
    expect(record?.admissions).toBe(0);
  });

  it("keeps closure across worker restart and concurrent attempts", async () => {
    const key = scope();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        closeInlineWebhookAdmission(workerA, key),
      ),
    );
    const restarted = await mongoose
      .createConnection(mongo.getUri())
      .asPromise();
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          admitInlineWebhook(restarted, key, async () => 1),
        ),
      );
      expect(results.every(result => !result.admitted)).toBe(true);
    } finally {
      await restarted.close();
    }
  });
});
