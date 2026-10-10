import assert from "node:assert/strict";
import { Types } from "mongoose";

import { Flow } from "../database/workspace-schema";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { WiseConnector } from "../connectors/wise/connector";
import {
  flowEntitySignature,
  removeFlowWebhookSubscription,
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

function stubCommit(result: { ok: boolean; sourceBlobSha?: string }) {
  const commits: Array<{ providerWebhookId?: string; message?: string }> = [];
  const deps = {
    commitFlowFile: (async (flow: any, _actor?: string, message?: string) => {
      // Snapshot what would be serialized into flows/<slug>.yml.
      commits.push({
        providerWebhookId: flow.webhookConfig?.providerWebhookId,
        message,
      });
      return { changed: result.ok, ...result };
    }) as any,
  };
  return { commits, deps };
}

async function testNewIdIsCommittedToTheFlowFileThenIndexed() {
  const { calls, persisted } = stubProvider(async () => ({
    providerWebhookId: "we_new",
    endpointUrl: ENDPOINT,
  }));
  const { commits, deps } = stubCommit({ ok: true, sourceBlobSha: "sha_1" });

  const flow = webhookFlow();
  const result = await syncFlowWebhookSubscription(flow, deps);

  assert.deepEqual(result, { status: "updated", providerWebhookId: "we_new" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpointUrl, ENDPOINT);
  assert.equal(calls[0].providerWebhookId, "we_old");
  assert.deepEqual(calls[0].enabledEntities, ["invoices", "payouts"]);
  // The file is the source of truth: committed first, with the new id…
  assert.equal(commits.length, 1);
  assert.equal(commits[0].providerWebhookId, "we_new");
  assert.match(commits[0].message ?? "", /we_new/);
  // …then mirrored into the index with the committed blob sha.
  assert.equal(persisted.length, 1);
  assert.deepEqual((persisted[0] as unknown[])[1], {
    $set: {
      "webhookConfig.providerWebhookId": "we_new",
      sourceBlobSha: "sha_1",
    },
  });
}

async function testFailedCommitLeavesIndexUntouched() {
  const { persisted } = stubProvider(async () => ({
    providerWebhookId: "we_new",
    endpointUrl: ENDPOINT,
  }));
  const { commits, deps } = stubCommit({ ok: false });

  const flow = webhookFlow();
  const result = await syncFlowWebhookSubscription(flow, deps);

  assert.equal(result.status, "updated");
  assert.equal(commits.length, 1);
  assert.equal(persisted.length, 0, "no index write without a commit");
  assert.equal(flow.webhookConfig.providerWebhookId, "we_old");
}

async function testUnchangedIdIsNotRewritten() {
  const { persisted } = stubProvider(async () => ({
    providerWebhookId: "we_old",
    endpointUrl: ENDPOINT,
  }));
  const { commits, deps } = stubCommit({ ok: true });
  const result = await syncFlowWebhookSubscription(webhookFlow(), deps);
  assert.equal(result.status, "updated");
  assert.equal(commits.length, 0);
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

async function testRemoveDeletesThroughTheConnector() {
  const deleted: unknown[] = [];
  (sourceConnectionManager as any).getSourceConnection = async () => ({
    id: String(DATA_SOURCE_ID),
    type: "wise",
    config: {},
  });
  (syncConnectorRegistry as any).getConnectorFor = async () => ({
    supportsWebhookSubscriptionDelete: () => true,
    deleteWebhookSubscription: async (options: unknown) => {
      deleted.push(options);
      return 2;
    },
  });
  const target = {
    flowId: String(FLOW_ID),
    dataSourceId: String(DATA_SOURCE_ID),
    endpoint: ENDPOINT,
    providerWebhookId: "10:a,20:b",
  };
  assert.deepEqual(await removeFlowWebhookSubscription(target), {
    status: "removed",
    count: 2,
  });
  assert.deepEqual(deleted, [
    { endpointUrl: ENDPOINT, providerWebhookId: "10:a,20:b" },
  ]);

  (syncConnectorRegistry as any).getConnectorFor = async () => ({
    supportsWebhookSubscriptionDelete: () => false,
  });
  assert.equal((await removeFlowWebhookSubscription(target)).status, "skipped");

  (syncConnectorRegistry as any).getConnectorFor = async () => ({
    supportsWebhookSubscriptionDelete: () => true,
    deleteWebhookSubscription: async () => {
      throw new Error("Wise is down");
    },
  });
  const failed = await removeFlowWebhookSubscription(target);
  assert.equal(failed.status, "failed");
}

/**
 * The real Wise connector behind the generic service: enabling `transfers`
 * on a flow provisioned for `balance_updates` subscribes the transfer events
 * on the same URL and commits the new id set to the flow file.
 */
async function testWiseFlowRetargetsThroughTheService() {
  const subscriptions: Array<Record<string, any>> = [
    {
      id: "bal",
      trigger_on: "balances#update",
      delivery: { version: "4.0.0", url: ENDPOINT },
    },
  ];
  let next = 1;
  const connector = new WiseConnector({
    id: String(DATA_SOURCE_ID),
    name: "Wise",
    type: "wise",
    config: { api_key: "t", profile_id: "10" },
  } as any);
  (connector as any).wiseApi = {
    get: async () => ({ data: [...subscriptions] }),
    post: async (_path: string, body: Record<string, unknown>) => {
      const created = { id: `t${next++}`, ...body };
      subscriptions.push(created);
      return { data: created };
    },
    delete: async () => ({ data: undefined }),
  };
  (sourceConnectionManager as any).getSourceConnection = async () => ({
    id: String(DATA_SOURCE_ID),
    type: "wise",
    config: {},
  });
  (syncConnectorRegistry as any).getConnectorFor = async () => connector;
  (Flow as any).updateOne = async () => ({ acknowledged: true });
  const { commits, deps } = stubCommit({ ok: true });

  const flow = webhookFlow({
    entityLayouts: [
      { entity: "balance_updates", enabled: true },
      { entity: "transfers", enabled: true },
    ],
    webhookConfig: {
      endpoint: ENDPOINT,
      secret: "production",
      providerWebhookId: "10:bal",
      enabled: true,
      totalReceived: 0,
    },
  });
  const result = await syncFlowWebhookSubscription(flow, deps);

  assert.equal(result.status, "updated");
  assert.deepEqual(subscriptions.map(s => s.trigger_on).sort(), [
    "balances#update",
    "transfers#active-cases",
    "transfers#payout-failure",
    "transfers#refund",
    "transfers#state-change",
  ]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].providerWebhookId, "10:bal,10:t1,10:t2,10:t3,10:t4");
}

async function main() {
  testEntitySignatureIgnoresOrderAndDisabled();
  await testSkipsFlowsThatWereNeverProvisioned();
  await testNewIdIsCommittedToTheFlowFileThenIndexed();
  await testFailedCommitLeavesIndexUntouched();
  await testUnchangedIdIsNotRewritten();
  await testReportsMissingSubscriptionAndProviderErrors();
  await testRemoveDeletesThroughTheConnector();
  await testWiseFlowRetargetsThroughTheService();
}

main().catch((error: unknown) => {
  throw error;
});
