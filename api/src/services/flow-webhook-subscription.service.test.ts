import assert from "node:assert/strict";
import { Types } from "mongoose";

import { Flow } from "../database/workspace-schema";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import {
  flowEntitySignature,
  syncFlowWebhookSubscription,
} from "./flow-webhook-subscription.service";

const FLOW_ID = new Types.ObjectId();
const DATA_SOURCE_ID = new Types.ObjectId();
const ENDPOINT = "https://mako.example/api/webhooks/ws/flow";

function webhookFlow(overrides: Record<string, unknown> = {}) {
  return {
    _id: FLOW_ID,
    type: "webhook",
    dataSourceId: DATA_SOURCE_ID,
    entityLayouts: [
      { entity: "invoices", enabled: true },
      { entity: "payouts", enabled: true },
      { entity: "coupons", enabled: false },
    ],
    webhookConfig: {
      endpoint: ENDPOINT,
      secret: "whsec_existing",
      providerWebhookId: "we_old",
      enabled: true,
      totalReceived: 0,
    },
    ...overrides,
  } as any;
}

type UpdateCall = Record<string, unknown>;

function stubProvider(
  update: (options: UpdateCall) => Promise<unknown>,
  supportsUpdate = true,
) {
  const calls: UpdateCall[] = [];
  const persisted: unknown[] = [];
  (sourceConnectionManager as any).getSourceConnection = async () => ({
    id: String(DATA_SOURCE_ID),
    type: "stripe",
    config: {},
  });
  (syncConnectorRegistry as any).getConnectorFor = async () => ({
    supportsWebhookSubscriptionUpdate: () => supportsUpdate,
    updateWebhookSubscription: async (options: UpdateCall) => {
      calls.push(options);
      return update(options);
    },
  });
  (Flow as any).updateOne = async (...args: unknown[]) => {
    persisted.push(args);
    return { acknowledged: true };
  };
  return { calls, persisted };
}

function testEntitySignatureIgnoresOrderAndDisabled() {
  const a = flowEntitySignature({
    entityLayouts: [
      { entity: "payouts", enabled: true },
      { entity: "invoices", enabled: true },
      { entity: "coupons", enabled: false },
    ],
  } as any);
  const b = flowEntitySignature({
    entityLayouts: [
      { entity: "invoices", enabled: true },
      { entity: "payouts", enabled: true },
    ],
  } as any);
  assert.equal(a, "invoices,payouts");
  assert.equal(a, b);
}

async function testSkipsFlowsThatWereNeverProvisioned() {
  const { calls } = stubProvider(async () => {
    throw new Error("must not be called");
  });

  assert.deepEqual(
    await syncFlowWebhookSubscription(webhookFlow({ type: "scheduled" })),
    { status: "skipped", reason: "not a webhook flow" },
  );
  assert.equal(
    (
      await syncFlowWebhookSubscription(
        webhookFlow({
          webhookConfig: { endpoint: ENDPOINT, secret: "", enabled: true },
        }),
      )
    ).status,
    "skipped",
  );
  assert.equal(
    (
      await syncFlowWebhookSubscription(
        webhookFlow({
          webhookConfig: { endpoint: ENDPOINT, secret: "x", enabled: false },
        }),
      )
    ).status,
    "skipped",
  );
  assert.equal(calls.length, 0);
}

async function testUpdatesWithEnabledEntitiesAndPersistsNewId() {
  const { calls, persisted } = stubProvider(async () => ({
    providerWebhookId: "we_new",
    endpointUrl: ENDPOINT,
  }));

  const result = await syncFlowWebhookSubscription(webhookFlow());

  assert.deepEqual(result, { status: "updated", providerWebhookId: "we_new" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpointUrl, ENDPOINT);
  assert.equal(calls[0].providerWebhookId, "we_old");
  assert.deepEqual(calls[0].enabledEntities, ["invoices", "payouts"]);
  assert.equal(persisted.length, 1);
  assert.deepEqual((persisted[0] as unknown[])[1], {
    $set: { "webhookConfig.providerWebhookId": "we_new" },
  });
}

async function testUnchangedIdIsNotRewritten() {
  const { persisted } = stubProvider(async () => ({
    providerWebhookId: "we_old",
    endpointUrl: ENDPOINT,
  }));
  const result = await syncFlowWebhookSubscription(webhookFlow());
  assert.equal(result.status, "updated");
  assert.equal(persisted.length, 0);
}

async function testReportsMissingSubscriptionAndProviderErrors() {
  stubProvider(async () => null);
  assert.deepEqual(await syncFlowWebhookSubscription(webhookFlow()), {
    status: "not_found",
  });

  stubProvider(async () => {
    throw new Error("Invalid API Key provided");
  });
  const failed = await syncFlowWebhookSubscription(webhookFlow());
  assert.equal(failed.status, "failed");
  assert.match((failed as { error: string }).error, /Invalid API Key provided/);

  stubProvider(async () => {
    throw new Error("must not be called");
  }, false);
  assert.equal(
    (await syncFlowWebhookSubscription(webhookFlow())).status,
    "skipped",
  );
}

async function main() {
  testEntitySignatureIgnoresOrderAndDisabled();
  await testSkipsFlowsThatWereNeverProvisioned();
  await testUpdatesWithEnabledEntitiesAndPersistsNewId();
  await testUnchangedIdIsNotRewritten();
  await testReportsMissingSubscriptionAndProviderErrors();
}

main().catch((error: unknown) => {
  throw error;
});
