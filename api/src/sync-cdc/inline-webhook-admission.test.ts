import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { type Connection, Types } from "mongoose";
import { WebhookEvent } from "../database/models/webhooks";
import { Flow } from "../database/workspace-schema";
import { resyncFlow } from "./backfill/resync";

vi.mock("./backfill/lifecycle", () => ({ startBackfill: vi.fn() }));
import {
  admitInlineWebhook,
  closeInlineWebhookAdmission,
  retainClosedInlineWebhook,
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
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ["--setParameter", "ttlMonitorSleepSecs=1"] }],
  });
  await mongoose.connect(mongo.getUri());
  workerA = await mongoose.createConnection(mongo.getUri()).asPromise();
  workerB = await mongoose.createConnection(mongo.getUri()).asPromise();
  await workerA.model("WebhookEvent", WebhookEvent.schema).init();
});

afterAll(async () => {
  await workerA?.close();
  await workerB?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

describe("closed webhook retention", () => {
  it("preserves retained deliveries arriving during resync cleanup", async () => {
    const key = scope();
    await Flow.create({
      _id: key.flowId,
      workspaceId: key.workspaceId,
      dataSourceId: key.sourceConnectionId,
      destinationDatabaseId: new Types.ObjectId(),
      createdBy: new Types.ObjectId().toString(),
      schedule: { cron: "0 0 * * *" },
      syncEngine: "cdc",
    });
    await closeInlineWebhookAdmission(workerA, key);
    const retain = (eventId: string) =>
      retainClosedInlineWebhook(workerB, key, {
        sourceConnectionId: key.sourceConnectionId,
        eventId,
        eventType: "created",
        rawPayload: { eventId },
      });
    expect(await retain("earlier")).toBe("retained");
    const inbox = database(workerA).collection("webhookevents");
    const otherFlow = new Types.ObjectId();
    const otherWorkspace = new Types.ObjectId();
    await inbox.insertMany([
      {
        workspaceId: key.workspaceId,
        flowId: key.flowId,
        eventId: "ordinary",
        status: "pending",
        applyStatus: "pending",
      },
      { workspaceId: key.workspaceId, flowId: key.flowId, eventId: "legacy" },
      {
        workspaceId: key.workspaceId,
        flowId: otherFlow,
        eventId: "other-flow",
        status: "pending",
      },
      {
        workspaceId: otherWorkspace,
        flowId: key.flowId,
        eventId: "other-workspace",
        status: "pending",
      },
    ]);
    let entered!: () => void;
    let release!: () => void;
    const atDelete = new Promise<void>(resolve => {
      entered = resolve;
    });
    const proceed = new Promise<void>(resolve => {
      release = resolve;
    });
    const originalDelete = WebhookEvent.collection.deleteMany.bind(
      WebhookEvent.collection,
    );
    const spy = vi
      .spyOn(WebhookEvent.collection, "deleteMany")
      .mockImplementation(async (...args) => {
        entered();
        await proceed;
        return originalDelete(...args);
      });
    const resync = resyncFlow({
      workspaceId: key.workspaceId.toString(),
      flowId: key.flowId.toString(),
      clearWebhookEvents: true,
    });
    try {
      await Promise.race([
        atDelete,
        resync.then(() => {
          throw new Error("Resync skipped webhook cleanup");
        }),
      ]);
      expect(await retain("during")).toBe("retained");
    } finally {
      release();
      try {
        await resync;
      } finally {
        spy.mockRestore();
      }
    }
    const remaining = await inbox
      .find({ $or: [{ flowId: key.flowId }, { flowId: otherFlow }] })
      .toArray();
    expect(remaining.map(row => row.eventId).sort()).toEqual([
      "during",
      "earlier",
      "other-flow",
      "other-workspace",
    ]);
    expect(
      remaining.filter(
        row => row.eventId === "during" || row.eventId === "earlier",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: "earlier",
          status: "dormant",
          applyStatus: "dormant",
        }),
        expect.objectContaining({
          eventId: "during",
          status: "dormant",
          applyStatus: "dormant",
        }),
      ]),
    );
  });
  it("retains one delivery across competing workers and excludes it from TTL and queues", async () => {
    const key = scope();
    const delivery = {
      sourceConnectionId: key.sourceConnectionId,
      eventId: "race",
      eventType: "created",
      rawPayload: { id: 1 },
    };
    await closeInlineWebhookAdmission(workerA, key);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        retainClosedInlineWebhook(i % 2 ? workerA : workerB, key, delivery),
      ),
    );
    expect(results.filter(r => r === "retained")).toHaveLength(1);
    expect(results.filter(r => r === "duplicate")).toHaveLength(7);
    const inbox = database(workerA).collection("webhookevents");
    const old = new Date(Date.now() - 8 * 86400_000);
    await inbox.updateOne(
      { flowId: key.flowId, eventId: "race" },
      { $set: { receivedAt: old } },
    );
    await inbox.insertOne({
      flowId: key.flowId,
      workspaceId: key.workspaceId,
      eventId: "ttl-control",
      eventType: "created",
      rawPayload: {},
      receivedAt: old,
      status: "pending",
      applyStatus: "pending",
    });
    await vi.waitFor(
      async () =>
        expect(
          await inbox.countDocuments({
            flowId: key.flowId,
            eventId: "ttl-control",
          }),
        ).toBe(0),
      { timeout: 15000, interval: 200 },
    );
    expect(
      await inbox.findOne({ flowId: key.flowId, eventId: "race" }),
    ).toMatchObject({
      status: "dormant",
      applyStatus: "dormant",
      dataSourceId: key.sourceConnectionId,
    });
    expect(
      await inbox.countDocuments({ flowId: key.flowId, status: "pending" }),
    ).toBe(0);
    expect(
      await inbox.countDocuments({
        flowId: key.flowId,
        applyStatus: "pending",
      }),
    ).toBe(0);
  });

  it("requires the verified source and the exact closed gate", async () => {
    const key = scope();
    const delivery = {
      sourceConnectionId: key.sourceConnectionId,
      eventId: "wrong",
      eventType: "created",
      rawPayload: {},
    };
    await expect(
      retainClosedInlineWebhook(workerA, key, delivery),
    ).rejects.toThrow("not confirmed closed");
    await closeInlineWebhookAdmission(workerA, {
      ...key,
      workspaceId: new Types.ObjectId(),
    });
    await expect(
      retainClosedInlineWebhook(workerA, key, delivery),
    ).rejects.toThrow("not confirmed closed");
    await closeInlineWebhookAdmission(workerA, key);
    await expect(
      retainClosedInlineWebhook(workerA, key, {
        ...delivery,
        sourceConnectionId: new Types.ObjectId(),
      }),
    ).rejects.toThrow("source does not match");
  });

  it("rejects foreign and unbound duplicate collisions", async () => {
    const key = scope();
    await closeInlineWebhookAdmission(workerA, key);
    const inbox = database(workerA).collection("webhookevents");
    for (const [eventId, fields] of [
      [
        "foreign",
        {
          workspaceId: new Types.ObjectId(),
          dataSourceId: key.sourceConnectionId,
        },
      ],
      ["unbound", { workspaceId: key.workspaceId }],
    ] as const) {
      await inbox.insertOne({
        flowId: key.flowId,
        eventId,
        ...fields,
        eventType: "created",
        rawPayload: {},
        receivedAt: new Date(),
        status: "pending",
        applyStatus: "pending",
      });
      await expect(
        retainClosedInlineWebhook(workerA, key, {
          sourceConnectionId: key.sourceConnectionId,
          eventId,
          eventType: "created",
          rawPayload: {},
        }),
      ).rejects.toMatchObject({ code: 11000 });
    }
  });

  it("propagates persistence and unknown write outcomes", async () => {
    const key = scope();
    await closeInlineWebhookAdmission(workerA, key);
    const db = database(workerA);
    const inbox = db.collection("webhookevents");
    const original = db.collection.bind(db);
    const collectionSpy = vi
      .spyOn(db, "collection")
      .mockImplementation(((name: string) =>
        name === "webhookevents"
          ? inbox
          : original(name)) as typeof db.collection);
    try {
      const delivery = {
        sourceConnectionId: key.sourceConnectionId,
        eventId: "unknown",
        eventType: "created",
        rawPayload: {},
      };
      const originalInsert = inbox.insertOne.bind(inbox);
      const insert = vi.spyOn(inbox, "insertOne");
      insert.mockRejectedValueOnce(new Error("write failed"));
      await expect(
        retainClosedInlineWebhook(workerA, key, delivery),
      ).rejects.toThrow("write failed");
      insert.mockImplementationOnce(async (...args) => {
        await originalInsert(...args);
        throw new Error("unknown write outcome");
      });
      await expect(
        retainClosedInlineWebhook(workerA, key, delivery),
      ).rejects.toThrow("unknown write outcome");
      insert.mockRestore();
      expect(await retainClosedInlineWebhook(workerB, key, delivery)).toBe(
        "duplicate",
      );
    } finally {
      collectionSpy.mockRestore();
    }
  });
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
