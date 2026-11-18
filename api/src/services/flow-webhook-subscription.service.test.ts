import assert from "node:assert/strict";
import { Types } from "mongoose";

import { Flow } from "../database/workspace-schema";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { WiseConnector } from "../connectors/wise/connector";
import {
  flowEntitySignature,
  PROVISION_NEEDS_ADMIN,
  removeFlowWebhookSubscription,
  syncFlowWebhookSubscription,
} from "./flow-webhook-subscription.service";

const FLOW_ID = new Types.ObjectId();
const WORKSPACE_ID = new Types.ObjectId();
const DATA_SOURCE_ID = new Types.ObjectId();
// The URL is the server's (generateWebhookEndpoint), so the test server's.
process.env.WEBHOOK_PUBLIC_BASE_URL = "https://mako.example";
const ENDPOINT = `https://mako.example/api/webhooks/${WORKSPACE_ID}/${FLOW_ID}`;

/** A save by an owner/admin: it may create a subscription. */
const OWNER = { mayProvision: true };

function webhookFlow(overrides: Record<string, unknown> = {}) {
  return {
    _id: FLOW_ID,
    workspaceId: WORKSPACE_ID,
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
  provision?: {
    create: (options: UpdateCall) => Promise<unknown>;
    creates: UpdateCall[];
  },
  /** Absent: the connector cannot pause (as Stripe, Wise). */
  pause?: { calls: UpdateCall[]; changed?: number; error?: Error },
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
    supportsWebhookProvisioning: () => Boolean(provision),
    supportsWebhookSubscriptionPause: () => Boolean(pause),
    setWebhookSubscriptionPaused: async (options: UpdateCall) => {
      if (!pause) throw new Error("must not be called");
      pause.calls.push(options);
      if (pause.error) throw pause.error;
      return pause.changed ?? 1;
    },
    updateWebhookSubscription: async (options: UpdateCall) => {
      calls.push(options);
      return update(options);
    },
    createWebhookSubscription: async (options: UpdateCall) => {
      if (!provision) throw new Error("must not be called");
      provision.creates.push(options);
      return provision.create(options);
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

  // A scheduled flow whose webhooks were never switched on: no endpoint.
  assert.deepEqual(
    await syncFlowWebhookSubscription(
      webhookFlow({
        type: "scheduled",
        webhookConfig: { enabled: true, totalReceived: 0 },
      }),
      OWNER,
    ),
    { status: "skipped", reason: "not a webhook flow" },
  );
  assert.equal(
    (
      await syncFlowWebhookSubscription(
        webhookFlow({
          webhookConfig: { endpoint: ENDPOINT, secret: "", enabled: true },
        }),
        OWNER,
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
        OWNER,
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
  const result = await syncFlowWebhookSubscription(flow, OWNER, deps);

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
  const result = await syncFlowWebhookSubscription(flow, OWNER, deps);

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
  const result = await syncFlowWebhookSubscription(webhookFlow(), OWNER, deps);
  assert.equal(result.status, "updated");
  assert.equal(commits.length, 0);
  assert.equal(persisted.length, 0);
}

async function testReportsMissingSubscriptionAndProviderErrors() {
  stubProvider(async () => null);
  assert.deepEqual(await syncFlowWebhookSubscription(webhookFlow(), OWNER), {
    status: "not_found",
  });

  stubProvider(async () => {
    throw new Error("Invalid API Key provided");
  });
  const failed = await syncFlowWebhookSubscription(webhookFlow(), OWNER);
  assert.equal(failed.status, "failed");
  assert.match((failed as { error: string }).error, /Invalid API Key provided/);

  stubProvider(async () => {
    throw new Error("must not be called");
  }, false);
  assert.equal(
    (await syncFlowWebhookSubscription(webhookFlow(), OWNER)).status,
    "skipped",
  );
}

/** A repo push (any writer) never creates a subscription; it may retarget. */
async function testRepoPushNeverProvisions() {
  const creates: UpdateCall[] = [];
  const { calls } = stubProvider(async () => null, true, {
    creates,
    create: async () => ({
      providerWebhookId: "we_new",
      endpointUrl: ENDPOINT,
      signingSecret: "whsec_new",
    }),
  });
  const result = await syncFlowWebhookSubscription(
    webhookFlow({
      webhookConfig: { endpoint: ENDPOINT, secret: "", enabled: true },
    }),
    { mayProvision: false },
  );
  assert.deepEqual(result, {
    status: "skipped",
    reason: PROVISION_NEEDS_ADMIN,
  });
  // A caller that passes no options gets the same fail-safe answer.
  const silent = await syncFlowWebhookSubscription(
    webhookFlow({
      webhookConfig: { endpoint: ENDPOINT, secret: "", enabled: true },
    }),
  );
  assert.deepEqual(silent, {
    status: "skipped",
    reason: PROVISION_NEEDS_ADMIN,
  });
  assert.equal(calls.length + creates.length, 0);
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
    workspaceId: String(WORKSPACE_ID),
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
  const result = await syncFlowWebhookSubscription(flow, OWNER, deps);

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

/** A scheduled flow with webhooks switched on is retargeted like a webhook flow. */
async function testScheduledFlowWithWebhooksOnIsSynced() {
  const { calls } = stubProvider(async () => ({
    providerWebhookId: "we_old",
    endpointUrl: ENDPOINT,
  }));
  const { deps } = stubCommit({ ok: true });
  const result = await syncFlowWebhookSubscription(
    webhookFlow({ type: "scheduled" }),
    OWNER,
    deps,
  );
  assert.equal(result.status, "updated");
  assert.equal(calls.length, 1);
}

function unprovisioned(overrides: Record<string, unknown> = {}) {
  return webhookFlow({
    type: "scheduled",
    webhookConfig: {
      endpoint: ENDPOINT,
      secret: "",
      enabled: true,
      totalReceived: 0,
    },
    ...overrides,
  });
}

/** On save: the subscription already on the URL is adopted, nothing created. */
async function testProvisioningAdoptsAnExistingSubscription() {
  const creates: UpdateCall[] = [];
  const { calls, persisted } = stubProvider(
    async () => ({
      providerWebhookId: "10:bal",
      endpointUrl: ENDPOINT,
      signingSecret: "production",
    }),
    true,
    { creates, create: async () => ({}) },
  );
  const { commits, deps } = stubCommit({ ok: true });
  const flow = unprovisioned();
  const result = await syncFlowWebhookSubscription(flow, OWNER, deps);

  assert.deepEqual(result, {
    status: "provisioned",
    providerWebhookId: "10:bal",
    adopted: true,
  });
  assert.equal(calls.length, 1, "looked up by URL first");
  assert.equal(creates.length, 0, "never re-created");
  assert.equal(commits[0].providerWebhookId, "10:bal");
  assert.equal(flow.webhookConfig.secret, "production");
  const last = persisted.at(-1) as unknown[];
  assert.deepEqual(last[1], {
    $set: {
      "webhookConfig.secret": "production",
      "webhookConfig.provisionError": null,
    },
  });
}

/** On save, with nothing on the URL yet: created once. */
async function testProvisioningCreatesWhenNoneExists() {
  const creates: UpdateCall[] = [];
  stubProvider(async () => null, true, {
    creates,
    create: async () => ({
      providerWebhookId: "we_new",
      endpointUrl: ENDPOINT,
      signingSecret: "whsec_new",
    }),
  });
  const { deps } = stubCommit({ ok: true });
  const result = await syncFlowWebhookSubscription(
    unprovisioned(),
    OWNER,
    deps,
  );
  assert.deepEqual(result, {
    status: "provisioned",
    providerWebhookId: "we_new",
    adopted: false,
  });
  assert.equal(creates.length, 1);
}

/** A refusal is stored on the flow; nothing else changes (polling carries on). */
async function testProvisioningRefusalIsStored() {
  const { persisted } = stubProvider(
    async () => {
      throw new Error("Wise refused: limited token");
    },
    true,
    { creates: [], create: async () => ({}) },
  );
  const result = await syncFlowWebhookSubscription(unprovisioned(), OWNER);
  assert.equal(result.status, "failed");
  assert.match((result as { error: string }).error, /limited token/);
  const set = ((persisted.at(-1) as unknown[])[1] as any).$set;
  assert.equal(
    set["webhookConfig.provisionError"].message,
    "Wise refused: limited token",
  );
  assert.ok(set["webhookConfig.provisionError"].at instanceof Date);
  assert.equal(Object.keys(set).length, 1, "only the error is written");
}

/** Close & co. cannot find a subscription by URL: never provisioned on save. */
async function testConnectorsWithoutLookupAreNeverProvisionedOnSave() {
  const creates: UpdateCall[] = [];
  const { calls } = stubProvider(
    async () => {
      throw new Error("must not be called");
    },
    false,
    { creates, create: async () => ({}) },
  );
  const result = await syncFlowWebhookSubscription(
    unprovisioned({ type: "webhook" }),
    OWNER,
  );
  assert.deepEqual(result, {
    status: "skipped",
    reason: "webhook not provisioned",
  });
  assert.equal(calls.length + creates.length, 0);
}

/**
 * A flow's connection is looked up in the flow's workspace only, on sync and
 * on teardown. A teardown target with no workspace is skipped, never looked
 * up unscoped.
 */
async function testConnectionLookupsAreScopedToTheWorkspace() {
  const lookups: unknown[][] = [];
  stubProvider(async () => ({ providerWebhookId: "we_old" }));
  (sourceConnectionManager as any).getSourceConnection = async (
    ...args: unknown[]
  ) => {
    lookups.push(args);
    return null;
  };
  const synced = await syncFlowWebhookSubscription(webhookFlow());
  assert.deepEqual(synced, {
    status: "skipped",
    reason: "connector not found",
  });
  assert.deepEqual(lookups, [[String(DATA_SOURCE_ID), String(WORKSPACE_ID)]]);

  lookups.length = 0;
  const removed = await removeFlowWebhookSubscription({
    flowId: String(FLOW_ID),
    workspaceId: String(WORKSPACE_ID),
    dataSourceId: String(DATA_SOURCE_ID),
    endpoint: ENDPOINT,
  });
  assert.equal(removed.status, "skipped");
  assert.deepEqual(lookups, [[String(DATA_SOURCE_ID), String(WORKSPACE_ID)]]);

  // Queued before targets carried a workspace: the flow row, if it still
  // exists, else the workspace in the subscription's own URL.
  const legacyEndpoint = `https://mako.example/api/webhooks/${WORKSPACE_ID}/${FLOW_ID}`;
  const rowWorkspace = new Types.ObjectId();
  (Flow as any).findById = () => ({
    select: () => ({ lean: async () => ({ workspaceId: rowWorkspace }) }),
  });
  lookups.length = 0;
  await removeFlowWebhookSubscription({
    flowId: String(FLOW_ID),
    dataSourceId: String(DATA_SOURCE_ID),
    endpoint: legacyEndpoint,
  });
  assert.deepEqual(lookups, [[String(DATA_SOURCE_ID), String(rowWorkspace)]]);

  (Flow as any).findById = () => ({
    select: () => ({ lean: async () => null }),
  });
  lookups.length = 0;
  await removeFlowWebhookSubscription({
    flowId: String(FLOW_ID),
    dataSourceId: String(DATA_SOURCE_ID),
    endpoint: legacyEndpoint,
  });
  assert.deepEqual(lookups, [[String(DATA_SOURCE_ID), String(WORKSPACE_ID)]]);

  // A URL naming another flow, or no ObjectIds at all: skipped, no lookup.
  lookups.length = 0;
  for (const endpoint of [
    `https://mako.example/api/webhooks/${WORKSPACE_ID}/${new Types.ObjectId()}`,
    "https://mako.example/api/webhooks/ws/flow",
  ]) {
    const skipped = await removeFlowWebhookSubscription({
      flowId: String(FLOW_ID),
      dataSourceId: String(DATA_SOURCE_ID),
      endpoint,
    });
    assert.deepEqual(skipped, {
      status: "skipped",
      reason: "no workspace on the target",
    });
  }
  assert.equal(lookups.length, 0);
}

/**
 * A flow whose trigger is off answers 403 to every delivery. A provider
 * that can be paused is paused, so it stops sending (Close would retry each
 * refused event for 72 hours); the subscription itself is kept.
 */
async function testTriggerOffPausesTheProviderSubscription() {
  const pause = { calls: [] as UpdateCall[] };
  const { calls } = stubProvider(
    async () => {
      throw new Error("must not be called");
    },
    true,
    undefined,
    pause,
  );
  const off = webhookFlow({
    webhookConfig: {
      endpoint: ENDPOINT,
      secret: "whsec_existing",
      providerWebhookId: "whsub_1",
      enabled: false,
    },
  });
  assert.deepEqual(await syncFlowWebhookSubscription(off), {
    status: "paused",
    count: 1,
  });
  assert.deepEqual(pause.calls, [
    { endpointUrl: ENDPOINT, providerWebhookId: "whsub_1", paused: true },
  ]);
  // Paused, not retargeted: the events are left as they were.
  assert.equal(calls.length, 0);

  // A provider error is reported, never thrown: the save already happened.
  stubProvider(async () => null, true, undefined, {
    calls: [],
    error: new Error("Close is down"),
  });
  assert.deepEqual(await syncFlowWebhookSubscription(off), {
    status: "failed",
    error: "Close is down",
  });
}

async function testTriggerOffIsLeftAloneWhenItCannotBePaused() {
  // No endpoint at all: never a webhook flow's subscription to touch.
  const pause = { calls: [] as UpdateCall[] };
  stubProvider(async () => null, true, undefined, pause);
  // `enabled` missing is not "switched off".
  assert.deepEqual(
    await syncFlowWebhookSubscription(
      webhookFlow({ webhookConfig: { endpoint: ENDPOINT, secret: "x" } }),
    ),
    { status: "skipped", reason: "webhook trigger off" },
  );
  assert.equal(pause.calls.length, 0);

  // A connector without pause (Stripe, Wise): skipped as before.
  stubProvider(async () => {
    throw new Error("must not be called");
  });
  assert.deepEqual(
    await syncFlowWebhookSubscription(
      webhookFlow({
        webhookConfig: { endpoint: ENDPOINT, secret: "x", enabled: false },
      }),
    ),
    { status: "skipped", reason: "webhook trigger off" },
  );
}

async function testTriggerOnResumesBeforeRetargeting() {
  const pause = { calls: [] as UpdateCall[] };
  const { calls } = stubProvider(
    async () => ({ providerWebhookId: "we_old", endpointUrl: ENDPOINT }),
    true,
    undefined,
    pause,
  );
  const result = await syncFlowWebhookSubscription(webhookFlow(), OWNER);
  assert.equal(result.status, "updated");
  assert.deepEqual(pause.calls, [
    { endpointUrl: ENDPOINT, providerWebhookId: "we_old", paused: false },
  ]);
  assert.equal(calls.length, 1);

  // Never provisioned (no secret): nothing of ours to resume.
  pause.calls.length = 0;
  await syncFlowWebhookSubscription(
    webhookFlow({
      webhookConfig: { endpoint: ENDPOINT, secret: "", enabled: true },
    }),
  );
  assert.equal(pause.calls.length, 0);
}

async function main() {
  testEntitySignatureIgnoresOrderAndDisabled();
  await testScheduledFlowWithWebhooksOnIsSynced();
  await testProvisioningAdoptsAnExistingSubscription();
  await testProvisioningCreatesWhenNoneExists();
  await testProvisioningRefusalIsStored();
  await testConnectorsWithoutLookupAreNeverProvisionedOnSave();
  await testSkipsFlowsThatWereNeverProvisioned();
  await testTriggerOffPausesTheProviderSubscription();
  await testTriggerOffIsLeftAloneWhenItCannotBePaused();
  await testTriggerOnResumesBeforeRetargeting();
  await testNewIdIsCommittedToTheFlowFileThenIndexed();
  await testFailedCommitLeavesIndexUntouched();
  await testUnchangedIdIsNotRewritten();
  await testReportsMissingSubscriptionAndProviderErrors();
  await testRepoPushNeverProvisions();
  await testRemoveDeletesThroughTheConnector();
  await testWiseFlowRetargetsThroughTheService();
  await testConnectionLookupsAreScopedToTheWorkspace();
}

main().catch((error: unknown) => {
  throw error;
});
