/**
 * The inbound webhook receiver finds a flow by its id, not by `type`.
 *
 * A flow created as `type: "webhook"` must keep taking deliveries exactly as
 * before (Close, Stripe, PandaDoc, Calendly, Claap POST to those URLs). A
 * scheduled flow takes them once its webhooks are switched on (endpoint
 * minted + enabled) — it keeps polling, webhooks only add speed. A scheduled
 * flow never switched on still answers 404.
 *
 * Run: npx tsx src/routes/webhooks-receiver.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    const { Flow, WebhookEvent, SourceConnection } =
      await import("../database/workspace-schema");
    const { connectorRegistry } = await import("../connectors/registry");
    const { webhookRoutes } = await import("./webhooks");

    // A connector without signature verification: the body is taken as JSON.
    (connectorRegistry as any).getConnectorFor = () => ({
      supportsWebhooks: () => false,
    });

    const workspaceId = new Types.ObjectId();
    const source = await SourceConnection.collection.insertOne({
      workspaceId,
      name: "test source",
      type: "test",
      config: {},
    });

    async function flow(fields: Record<string, unknown>) {
      const doc = await Flow.collection.insertOne({
        workspaceId,
        name: "f",
        sourceType: "connector",
        dataSourceId: source.insertedId,
        destinationDatabaseId: new Types.ObjectId(),
        createdBy: "u1",
        syncEngine: "cdc",
        ...fields,
      });
      return String(doc.insertedId);
    }

    async function post(flowId: string) {
      const res = await webhookRoutes.request(
        `/webhooks/${String(workspaceId)}/${flowId}`,
        {
          method: "POST",
          body: JSON.stringify({ id: `evt_${flowId}`, type: "x.updated" }),
          headers: { "content-type": "application/json" },
        },
      );
      return res.status;
    }

    const endpoint = (id: string) =>
      `https://mako.example/api/webhooks/${String(workspaceId)}/${id}`;

    // 1. A webhook flow, unchanged behaviour (even with no stored endpoint).
    const webhookFlow = await flow({
      type: "webhook",
      webhookConfig: { enabled: true, totalReceived: 0 },
    });
    assert.equal(await post(webhookFlow), 200, "webhook flow takes deliveries");

    // 2. A scheduled flow with webhooks switched on: takes deliveries too.
    const hybridId = new Types.ObjectId();
    await Flow.collection.insertOne({
      _id: hybridId,
      workspaceId,
      name: "hybrid",
      type: "scheduled",
      sourceType: "connector",
      dataSourceId: source.insertedId,
      destinationDatabaseId: new Types.ObjectId(),
      createdBy: "u1",
      syncEngine: "cdc",
      schedule: { enabled: true, cron: "0 * * * *", timezone: "UTC" },
      webhookConfig: {
        enabled: true,
        endpoint: endpoint(String(hybridId)),
        totalReceived: 0,
      },
    });
    assert.equal(await post(String(hybridId)), 200, "hybrid takes deliveries");
    const saved = await WebhookEvent.countDocuments({
      flowId: String(hybridId),
    });
    assert.equal(saved, 1, "the hybrid's event is stored for the CDC pump");
    const after = await Flow.collection.findOne({ _id: hybridId });
    assert.equal(after?.type, "scheduled", "the type is never rewritten");
    assert.equal(after?.schedule?.enabled, true, "polling carries on");

    // 3. A scheduled flow never switched on (Mongoose default only): 404.
    const plain = await flow({
      type: "scheduled",
      webhookConfig: { enabled: true, totalReceived: 0 },
    });
    assert.equal(await post(plain), 404, "no endpoint, no deliveries");

    // 4. Switched off again: refused, as a disabled webhook flow always was.
    const offId = new Types.ObjectId();
    await Flow.collection.insertOne({
      _id: offId,
      workspaceId,
      name: "off",
      type: "webhook",
      sourceType: "connector",
      dataSourceId: source.insertedId,
      destinationDatabaseId: new Types.ObjectId(),
      createdBy: "u1",
      webhookConfig: {
        enabled: false,
        endpoint: endpoint(String(offId)),
        totalReceived: 0,
      },
    });
    assert.equal(await post(String(offId)), 403, "disabled stays disabled");

    console.log("webhooks receiver tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
