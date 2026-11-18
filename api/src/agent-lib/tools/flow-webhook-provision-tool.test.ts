/**
 * flow_webhook_provision runs the "Create in …" route's own step
 * (provisionFlowWebhook) for an MCP caller. Pinned against real Mongo:
 *
 *   CREATE    — a sync with no signing secret gets its subscription: the
 *               result names vendor, endpoint and subscription id, never the
 *               secret; the flow file is committed and the row saved.
 *   IDEMPOTENT — a second call reports the existing subscription and never
 *               calls the provider again.
 *   NO SECRET — a provider that returns no signing secret is a failure
 *               naming the subscription it did create.
 *   ROLE      — a member is refused before anything runs.
 *   TENANCY   — another workspace's sync is not found.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const SECRET = "whsec_never_returned_123";

const state = vi.hoisted(() => ({
  provisions: [] as Array<{ workspaceId: string; url: string }>,
  commits: 0,
  returnSecret: true,
  roles: {} as Record<string, string>,
}));

vi.mock("../../services/flow-webhook-provision.service", () => ({
  provisionFlowWebhook: vi.fn(
    async (params: {
      workspaceId: string;
      flow: { _id: unknown; webhookConfig?: Record<string, unknown> };
      request: { req: { url: string } };
    }) => {
      state.provisions.push({
        workspaceId: params.workspaceId,
        url: params.request.req.url,
      });
      const endpoint = `https://app.mako.ai/api/webhooks/${params.workspaceId}/${String(params.flow._id)}`;
      const signingSecret = state.returnSecret ? SECRET : undefined;
      const webhookConfig = {
        ...(params.flow.webhookConfig ?? {}),
        endpoint,
        enabled: true,
        secret: signingSecret ?? "",
        providerWebhookId: "sub_42",
      };
      params.flow.webhookConfig = webhookConfig;
      return {
        endpoint,
        created: { providerWebhookId: "sub_42", signingSecret },
        webhookConfig,
        connectorType: "ws:pandadoc",
      };
    },
  ),
}));

vi.mock("../../services/flow-config.service", () => ({
  commitFlowFile: vi.fn(async () => {
    state.commits++;
    return { ok: true, sourceBlobSha: "blob1" };
  }),
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

import { Flow } from "../../database/workspace-schema";
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
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Flow.collection.deleteMany({});
  state.provisions.length = 0;
  state.commits = 0;
  state.returnSecret = true;
  state.roles = { [ADMIN]: "admin", [MEMBER]: "member" };
});

async function makeFlow(workspaceId = WS) {
  const _id = new Types.ObjectId();
  await Flow.collection.insertOne({
    _id,
    workspaceId,
    name: "ch_pandadoc → bigquery",
    slug: "ch-pandadoc-bigquery",
    sourceType: "connector",
    dataSourceId: new Types.ObjectId(),
    destinationDatabaseId: new Types.ObjectId(),
    syncEngine: "cdc",
    createdBy: "creator",
  });
  return _id.toString();
}

async function provision(userId: string, flow: string) {
  const tools = createFlowSyncTools({ workspaceId: WS.toString(), userId });
  const execute = (
    tools.flow_webhook_provision as unknown as {
      execute: (input: unknown, options: unknown) => Promise<any>;
    }
  ).execute;
  return execute({ flow }, { toolCallId: "t", messages: [] });
}

describe("flow_webhook_provision", () => {
  it("creates the subscription and never returns the secret", async () => {
    const id = await makeFlow();
    const out = await provision(ADMIN, id);

    expect(out).toEqual({
      success: true,
      id,
      status: "created",
      vendor: "ws:pandadoc",
      endpoint: `https://app.mako.ai/api/webhooks/${WS}/${id}`,
      providerWebhookId: "sub_42",
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(state.provisions).toHaveLength(1);
    expect(state.commits).toBe(1);
    const row = await Flow.findById(id).lean();
    expect(row?.webhookConfig?.secret).toBe(SECRET);
    expect(row?.webhookConfig?.providerWebhookId).toBe("sub_42");
    expect(row?.sourceBlobSha).toBe("blob1");
  });

  it("reports an existing subscription instead of making a second", async () => {
    const id = await makeFlow();
    await provision(ADMIN, id);
    const again = await provision(ADMIN, id);

    expect(again).toEqual({
      success: true,
      id,
      status: "existing",
      endpoint: `https://app.mako.ai/api/webhooks/${WS}/${id}`,
      providerWebhookId: "sub_42",
    });
    expect(JSON.stringify(again)).not.toContain(SECRET);
    expect(state.provisions).toHaveLength(1);
    expect(state.commits).toBe(1);
  });

  it("fails, naming the subscription, when the provider returns no secret", async () => {
    state.returnSecret = false;
    const id = await makeFlow();
    const out = await provision(ADMIN, id);

    expect(out.success).toBe(false);
    expect(out.error).toContain("sub_42");
    expect(out.error).toContain("did not return a signing secret");
  });

  it("refuses a member before calling the provider", async () => {
    const id = await makeFlow();
    const out = await provision(MEMBER, id);

    expect(out).toEqual({ success: false, error: "Owner/admin role required" });
    expect(state.provisions).toHaveLength(0);
  });

  it("does not find another workspace's sync", async () => {
    const theirs = await makeFlow(WS_THEIRS);
    const out = await provision(ADMIN, theirs);

    expect(out.success).toBe(false);
    expect(state.provisions).toHaveLength(0);
  });
});
