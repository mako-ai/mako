import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { CommandStartedEvent } from "mongodb";
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

  it("commits each of two overlapping admissions once and rejects a third after closure", async () => {
    const key = scope();
    const writeDelivery =
      (worker: Connection, eventId: string) =>
      async (session: mongoose.ClientSession) => {
        await database(worker)
          .collection("admission_test_deliveries")
          .insertOne({ flow: key.flowId, eventId }, { session });
        return eventId;
      };
    function barrier() {
      let open!: () => void;
      const wait = new Promise<void>(resolve => {
        open = resolve;
      });
      return { open, wait };
    }
    const firstWritten = barrier();
    const holdFirst = barrier();
    const secondReady = barrier();
    const holdSecond = barrier();
    const secondRetried = barrier();
    const contender = await mongoose
      .createConnection(mongo.getUri(), { monitorCommands: true })
      .asPromise();
    const startSession = contender.startSession.bind(contender);
    const pauseSecond = vi
      .spyOn(contender, "startSession")
      .mockImplementationOnce(async () => {
        // Finish the gate upsert before worker A holds the transactional lock.
        secondReady.open();
        await holdSecond.wait;
        return startSession();
      });
    const client = contender.getClient();
    const gateTransactions = new Set<string>();
    const observeGate = ({ commandName, command }: CommandStartedEvent) => {
      if (
        commandName === "update" &&
        command.update === "inline_webhook_admissions" &&
        command.autocommit === false
      ) {
        gateTransactions.add(String(command.txnNumber));
        if (gateTransactions.size === 2) secondRetried.open();
      }
    };
    const timer = new AbortController();
    let waitingFor = "the second gate initialization";
    const deadline = delay(10_000, undefined, { signal: timer.signal }).then(
      () => {
        throw new Error(`Timed out waiting for ${waitingFor}`);
      },
    );
    client.on("commandStarted", observeGate);
    try {
      const persistSecond = vi.fn(writeDelivery(contender, "second"));
      const second = admitInlineWebhook(contender, key, persistSecond);
      await Promise.race([secondReady.wait, second, deadline]);
      waitingFor = "the first delivery write";
      const first = admitInlineWebhook(workerA, key, async session => {
        const eventId = await writeDelivery(workerA, "first")(session);
        firstWritten.open();
        await holdFirst.wait;
        return eventId;
      });
      const admitted = Promise.all([first, second]);
      await Promise.race([firstWritten.wait, admitted, deadline]);
      waitingFor = "a second transaction from the competing admission";
      holdSecond.open();
      await Promise.race([secondRetried.wait, admitted, deadline]);
      waitingFor = "both admissions to commit";
      holdFirst.open();
      expect(await Promise.race([admitted, deadline])).toEqual([
        { admitted: true, value: "first" },
        { admitted: true, value: "second" },
      ]);
      expect(persistSecond).toHaveBeenCalledTimes(1);
    } finally {
      holdFirst.open();
      holdSecond.open();
      pauseSecond.mockRestore();
      client.off("commandStarted", observeGate);
      timer.abort();
      await contender.close();
    }

    await closeInlineWebhookAdmission(workerA, key);
    expect(
      await admitInlineWebhook(workerB, key, writeDelivery(workerB, "third")),
    ).toEqual({ admitted: false });
    const readConcern = { level: "majority" } as const;
    const rows = await database(workerB)
      .collection("admission_test_deliveries")
      .find({ flow: key.flowId }, { readConcern })
      .sort({ eventId: 1 })
      .toArray();
    expect(rows.map(row => row.eventId)).toEqual(["first", "second"]);
    const record = await database(workerB)
      .collection<{ _id: string; admissions: number; closed: boolean }>(
        "inline_webhook_admissions",
      )
      .findOne(
        { _id: `${key.workspaceId}:${key.flowId}:${key.sourceConnectionId}` },
        { readConcern },
      );
    expect(record).toMatchObject({ closed: true, admissions: 2 });
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
