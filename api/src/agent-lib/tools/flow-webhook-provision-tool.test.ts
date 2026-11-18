/**
 * flow_webhook_provision runs the "Create in …" route's own step
 * (provisionFlowWebhook, real) against a fake provider. Pinned on real Mongo:
 *
 *   ENDPOINT   — the subscription always points at the server's URL
 *                (WEBHOOK_PUBLIC_BASE_URL), never at a stored endpoint a
 *                save could have moved; a member's save retargets an
 *                existing subscription to the server's URL only; a save
 *                never clears the signing secret.
 *   CREATE     — vendor, endpoint and subscription id come back, the secret
 *                never does.
 *   IDEMPOTENT — a sync with a subscription id (even without a secret) is
 *                reported; two concurrent calls create one subscription;
 *                a subscription already on the URL is adopted.
 *   PERSIST    — the id and secret reach the row before the git commit, so
 *                a failed commit orphans nothing.
 *   TRIGGER    — a sync whose webhook trigger is off is refused.
 *   ROLE / TENANCY — a member is refused; another workspace's sync is not
 *                found.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const BASE = "https://hooks.mako.test";
const EVIL = "https://attacker.example";

const state = vi.hoisted(() => ({
  subs: new Map<string, string>(),
  creates: 0,
  canUpdate: false,
  commitOk: true,
  roles: {} as Record<string, string>,
}));

vi.mock("../../sync/database-data-source-manager", () => ({
  sourceConnectionManager: {
    getSourceConnection: vi.fn(async (id: string) => ({
      id,
      type: "ws:pandadoc",
    })),
  },
}));

vi.mock("../../sync/connector-registry", () => ({
  syncConnectorRegistry: {
    getConnectorFor: vi.fn(async () => ({
      supportsWebhooks: () => true,
      supportsWebhookProvisioning: () => true,
      supportsWebhookSubscriptionUpdate: () => state.canUpdate,
      createWebhookSubscription: async ({
        endpointUrl,
      }: {
        endpointUrl: string;
      }) => {
        state.creates++;
        // A slow provider, so concurrent calls overlap.
        await new Promise(resolve => setTimeout(resolve, 50));
        const id = `sub_${state.creates}`;
        state.subs.set(id, endpointUrl);
        return { providerWebhookId: id, signingSecret: `whsec_${id}` };
      },
      updateWebhookSubscription: async (args: {
        endpointUrl: string;
        providerWebhookId?: string;
      }) => {
        const id =
          (args.providerWebhookId && state.subs.has(args.providerWebhookId)
            ? args.providerWebhookId
            : undefined) ??
          [...state.subs].find(([, url]) => url === args.endpointUrl)?.[0];
        if (!id) return null;
        state.subs.set(id, args.endpointUrl);
        return { providerWebhookId: id };
      },
    })),
  },
}));

vi.mock("../../services/flow-config.service", () => ({
  commitFlowFile: vi.fn(async () =>
    state.commitOk
      ? { ok: true, sourceBlobSha: "blob1" }
      : { ok: false, error: "push rejected" },
  ),
}));

vi.mock("../../apps/workspace-repo-required", () => ({
  requireWorkspaceRepo: vi.fn(async () => undefined),
}));

vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasRole: vi.fn(async (_ws: string, userId: string, roles: string[]) =>
      roles.includes(state.roles[userId] ?? ""),
    ),
  },
}));

import { Flow, SourceConnection } from "../../database/workspace-schema";
import {
  applyFlowUpdate,
  secretChange,
} from "../../services/flow-mutation.service";
import {
  PROVISION_CLAIM_MS,
  claimWebhookProvision,
} from "../../services/flow-webhook-provision.service";
import { syncFlowWebhookSubscription } from "../../services/flow-webhook-subscription.service";
import { createFlowSyncTools } from "./flow-sync-tools";

const WS = new Types.ObjectId();
const WS_THEIRS = new Types.ObjectId();
const ADMIN = "admin-user";
const MEMBER = "member-user";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  process.env.WEBHOOK_PUBLIC_BASE_URL = BASE;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  delete process.env.WEBHOOK_PUBLIC_BASE_URL;
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Flow.collection.deleteMany({});
  await SourceConnection.collection.deleteMany({});
  state.subs.clear();
  state.creates = 0;
  state.canUpdate = false;
  state.commitOk = true;
  state.roles = { [ADMIN]: "admin", [MEMBER]: "member" };
});

const serverUrl = (workspaceId: Types.ObjectId, id: string) =>
  `${BASE}/api/webhooks/${workspaceId}/${id}`;

async function makeFlow(
  webhookConfig: Record<string, unknown> = {},
  workspaceId = WS,
) {
  const _id = new Types.ObjectId();
  const dataSourceId = new Types.ObjectId();
  await SourceConnection.collection.insertOne({
    _id: dataSourceId,
    workspaceId,
    name: "ch_pandadoc",
    type: "ws:pandadoc",
    config: {},
  });
  await Flow.collection.insertOne({
    _id,
    workspaceId,
    name: "ch_pandadoc → bigquery",
    slug: "ch-pandadoc-bigquery",
    sourceType: "connector",
    dataSourceId,
    destinationDatabaseId: new Types.ObjectId(),
    syncEngine: "cdc",
    createdBy: "creator",
    webhookConfig: {
      enabled: true,
      // Moved by an earlier save from a forged X-Forwarded-Host.
      endpoint: `${EVIL}/api/webhooks/${workspaceId}/${_id}`,
      secret: "",
      totalReceived: 0,
      ...webhookConfig,
    },
  });
  return _id.toString();
}

async function provision(flow: string, userId = ADMIN) {
  const tools = createFlowSyncTools({ workspaceId: WS.toString(), userId });
  const execute = (
    tools.flow_webhook_provision as unknown as {
      execute: (input: unknown, options: unknown) => Promise<any>;
    }
  ).execute;
  return execute({ flow }, { toolCallId: "t", messages: [] });
}

describe("flow_webhook_provision", () => {
  it("points the subscription at the server's URL, never the stored one", async () => {
    const id = await makeFlow();
    const out = await provision(id);

    expect(out).toEqual({
      success: true,
      id,
      status: "created",
      vendor: "ws:pandadoc",
      endpoint: serverUrl(WS, id),
      providerWebhookId: "sub_1",
    });
    expect([...state.subs.values()]).toEqual([serverUrl(WS, id)]);
    expect(JSON.stringify(out)).not.toContain("whsec_");
    const row = await Flow.findById(id).lean();
    expect(row?.webhookConfig?.endpoint).toBe(serverUrl(WS, id));
    expect(row?.webhookConfig?.secret).toBe("whsec_sub_1");
    expect(row?.webhookConfig?.provisioningAt ?? null).toBeNull();
  });

  it("reports a subscription id without a secret as existing", async () => {
    const id = await makeFlow({ providerWebhookId: "sub_old", secret: "" });
    const out = await provision(id);

    expect(out).toMatchObject({ success: true, status: "existing" });
    expect(out.providerWebhookId).toBe("sub_old");
    expect(state.creates).toBe(0);
  });

  it("creates one subscription for two concurrent calls", async () => {
    const id = await makeFlow();
    const [a, b] = await Promise.all([provision(id), provision(id)]);

    expect(state.creates).toBe(1);
    expect([a, b].filter(r => r.status === "created")).toHaveLength(1);
    const again = await provision(id);
    expect(again).toMatchObject({
      status: "existing",
      providerWebhookId: "sub_1",
    });
    expect(state.creates).toBe(1);
  });

  it("adopts a subscription already on the URL instead of creating one", async () => {
    state.canUpdate = true;
    const id = await makeFlow();
    state.subs.set("we_stripe", serverUrl(WS, id));
    const out = await provision(id);

    expect(state.creates).toBe(0);
    // An adopted endpoint never shows its secret again: say so.
    expect(out.success).toBe(false);
    expect(out.error).toContain("we_stripe");
    const row = await Flow.findById(id).lean();
    expect(row?.webhookConfig?.providerWebhookId).toBe("we_stripe");
    expect(await provision(id)).toMatchObject({ status: "existing" });
  });

  it("saves the id and secret before the git commit", async () => {
    state.commitOk = false;
    const id = await makeFlow();
    const out = await provision(id);

    expect(out.success).toBe(false);
    expect(out.error).toContain("push rejected");
    const row = await Flow.findById(id).lean();
    expect(row?.webhookConfig?.providerWebhookId).toBe("sub_1");
    expect(row?.webhookConfig?.secret).toBe("whsec_sub_1");
    expect(row?.webhookConfig?.provisioningAt ?? null).toBeNull();
    expect(await provision(id)).toMatchObject({ status: "existing" });
    expect(state.creates).toBe(1);
  });

  it("refuses a sync whose webhook trigger is off", async () => {
    const id = await makeFlow({ enabled: false });
    const out = await provision(id);

    expect(out.success).toBe(false);
    expect(out.error).toContain("webhook trigger is off");
    expect(state.creates).toBe(0);
    const row = await Flow.findById(id).lean();
    expect(row?.webhookConfig?.enabled).toBe(false);
  });

  it("refuses a member and never finds another workspace's sync", async () => {
    const id = await makeFlow();
    expect(await provision(id, MEMBER)).toEqual({
      success: false,
      error: "Owner/admin role required",
    });
    const theirs = await makeFlow({}, WS_THEIRS);
    expect((await provision(theirs)).success).toBe(false);
    expect(state.creates).toBe(0);
  });
});

describe("a save never moves or empties the webhook", () => {
  it("keeps the secret and mints the endpoint from the server", async () => {
    const id = await makeFlow({ secret: "whsec_keep", providerWebhookId: "s" });
    const flow = (await Flow.findById(id))!;
    await applyFlowUpdate({
      workspaceId: WS.toString(),
      flow,
      body: { webhookSecret: "" },
    });
    expect(flow.webhookConfig?.secret).toBe("whsec_keep");
    expect(flow.webhookConfig?.endpoint).toBe(serverUrl(WS, id));
  });

  it("retargets an existing subscription to the server's URL only", async () => {
    state.canUpdate = true;
    const id = await makeFlow({ secret: "whsec_s", providerWebhookId: "we_1" });
    state.subs.set("we_1", serverUrl(WS, id));
    // A member's save: no provisioning, but the subscription is re-synced
    // from a flow whose stored endpoint names the attacker's host.
    const flow = (await Flow.findById(id))!;
    const result = await syncFlowWebhookSubscription(flow, {
      mayProvision: false,
    });
    expect(result).toMatchObject({ status: "updated" });
    expect(state.subs.get("we_1")).toBe(serverUrl(WS, id));
  });
});

describe('the provisioning claim (tool and "Create in …" route)', () => {
  it("lets one of two concurrent claims through", async () => {
    const id = await makeFlow();
    const claims = await Promise.all(
      [1, 2, 3].map(() =>
        claimWebhookProvision({
          flowId: id,
          workspaceId: WS.toString(),
          unprovisionedOnly: false,
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("lets the route re-provision a provisioned flow, not the tool", async () => {
    const id = await makeFlow({ secret: "whsec_x", providerWebhookId: "s1" });
    const args = { flowId: id, workspaceId: WS.toString() };
    expect(
      await claimWebhookProvision({ ...args, unprovisionedOnly: true }),
    ).toBeNull();
    expect(
      await claimWebhookProvision({ ...args, unprovisionedOnly: false }),
    ).not.toBeNull();
  });

  it("retakes a stale claim, never another workspace's flow", async () => {
    const id = await makeFlow({
      provisioningAt: new Date(Date.now() - PROVISION_CLAIM_MS - 1000),
    });
    expect(
      await claimWebhookProvision({
        flowId: id,
        workspaceId: WS_THEIRS.toString(),
        unprovisionedOnly: false,
      }),
    ).toBeNull();
    expect(
      await claimWebhookProvision({
        flowId: id,
        workspaceId: WS.toString(),
        unprovisionedOnly: false,
      }),
    ).not.toBeNull();
  });
});

describe("only an owner or admin changes the signing secret", () => {
  it("counts a new secret as a change, a re-sent or empty one not", () => {
    expect(secretChange({ webhookSecret: "whsec_new" }, "whsec_old")).toBe(
      true,
    );
    expect(secretChange({ webhookSecret: "whsec_new" }, undefined)).toBe(true);
    expect(secretChange({ webhookSecret: " whsec_old " }, "whsec_old")).toBe(
      false,
    );
    expect(secretChange({ webhookSecret: "" }, "whsec_old")).toBe(false);
    expect(secretChange({}, "whsec_old")).toBe(false);
  });

  it("gates both the create and the update route on it", () => {
    const crud = readFileSync(
      join(__dirname, "../../routes/flows/crud.ts"),
      "utf8",
    );
    // POST / and PUT /{flowId}: each refuses a non-admin secret change.
    expect(crud.match(/secretChange\(/g)).toHaveLength(2);
    expect(crud.match(/fail\(c, 403, SECRET_NEEDS_ADMIN\)/g)).toHaveLength(2);
  });
});
