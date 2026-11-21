import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  CdcChangeEvent,
  DatabaseConnection,
  Flow,
  WebhookEvent,
} from "../database/workspace-schema";
import * as flowSync from "../services/flow-sync.service";
import * as adapters from "./adapters/registry";
import { reconcileWebhookApplyStatus } from "./backfill/webhook-maintenance";
import { resolveOrphanedWebhookApplyStatusForFlow } from "./cdc-orphan-applystatus";
import { CdcConsumerService } from "./consumer";
import { getCdcEventStore } from "./event-store";

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function setup() {
  const workspaceId = new Types.ObjectId();
  const flowId = new Types.ObjectId();
  const connectionId = new Types.ObjectId();
  await DatabaseConnection.collection.insertOne({
    _id: connectionId,
    workspaceId,
    type: "bigquery",
  });
  await Flow.collection.insertOne({
    _id: flowId,
    workspaceId,
    type: "webhook",
    syncEngine: "cdc",
    streamState: "active",
    destinationDatabaseId: connectionId,
    tableDestination: { connectionId, schema: "fixture" },
    webhookConfig: { enabled: true },
  });
  const scope = { workspaceId: String(workspaceId), flowId: String(flowId) };
  const applyEvents = vi.fn().mockResolvedValue({ applied: 1 });
  vi.spyOn(adapters, "resolveCdcDestinationAdapter").mockReturnValue({
    destinationType: "bigquery",
    ensureLiveTable: async () => undefined,
    applyEvents,
    applyBatch: async () => ({ written: 0 }),
  });
  vi.spyOn(flowSync, "ensureFlowDerivedCache").mockResolvedValue("ok");
  const consumer = new CdcConsumerService();
  return {
    scope,
    applyEvents,
    materialize: (entity: string) =>
      consumer.materializeEntity({ ...scope, entity }),
    createReceipt: (eventId: string) =>
      WebhookEvent.create({
        workspaceId,
        flowId,
        eventId,
        eventType: "recording_added",
        status: "completed",
        applyStatus: "pending",
        rawPayload: {},
      }),
  };
}

it.each(["pending", "failed"] as const)(
  "waits for the recording when the transcript applies first and the recording is %s",
  async recordingStatus => {
    const { scope, applyEvents, materialize, createReceipt } = await setup();
    const receipt = await createReceipt("mixed-entities");
    const webhookEventId = String(receipt._id);
    const eventStore = getCdcEventStore();
    await eventStore.appendEvents({
      ...scope,
      events: ["recordings", "recording_transcripts"].map(entity => ({
        entity,
        operation: "upsert",
        recordId: "synthetic-record",
        payload: { id: "synthetic-record" },
        source: "webhook",
        sourceTs: new Date(),
        webhookEventId,
      })),
    });
    if (recordingStatus === "failed") {
      applyEvents.mockRejectedValueOnce(
        new Error("simulated recording write failure"),
      );
      await expect(materialize("recordings")).rejects.toThrow(
        "simulated recording write failure",
      );
    }

    await expect(materialize("recording_transcripts")).resolves.toMatchObject({
      applied: 1,
    });
    const receiptStatus = async () =>
      (await WebhookEvent.findById(receipt._id).lean())?.applyStatus;
    expect(await receiptStatus()).toBe(recordingStatus);
    await expect(
      reconcileWebhookApplyStatus(scope.workspaceId, scope.flowId),
    ).resolves.toBe(0);
    expect(await receiptStatus()).toBe(recordingStatus);

    // A re-enqueued inbox can be pending while a linked CDC row still shows a failure.
    await WebhookEvent.updateOne(
      { _id: receipt._id },
      { $set: { status: "completed", applyStatus: "pending" } },
    );
    await expect(resolveOrphanedWebhookApplyStatusForFlow(scope)).resolves.toBe(
      0,
    );
    expect(await receiptStatus()).toBe("pending");

    const recording = {
      flowId: scope.flowId,
      webhookEventId,
      entity: "recordings",
    };
    await expect(
      CdcChangeEvent.findOne(recording).lean(),
    ).resolves.toMatchObject({ materializationStatus: recordingStatus });
    await CdcChangeEvent.updateOne(recording, {
      $set: { materializationStatus: "pending" },
    });
    await expect(materialize("recordings")).resolves.toMatchObject({
      applied: 1,
    });
    expect(await receiptStatus()).toBe("applied");
  },
);

it("keeps ordinary orphan reconciliation for a deduplicated inbox", async () => {
  const { scope, createReceipt } = await setup();
  const receipt = await createReceipt("deduplicated");
  await expect(resolveOrphanedWebhookApplyStatusForFlow(scope)).resolves.toBe(
    1,
  );
  await expect(
    WebhookEvent.findById(receipt._id).lean(),
  ).resolves.toMatchObject({ applyStatus: "applied" });
});
