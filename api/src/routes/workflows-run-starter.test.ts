/**
 * Who a run is started by, and what its writes do, as the run and its key
 * record it: a run from the app, an MCP login or the agent's own tool
 * writes; one started with an API key only reads through connections (a
 * sandbox run's key says `agentRun`; a deployed run's Hatchet metadata says
 * trigger "api"). A dry run records its writes (`recordWrites` on the key,
 * `dryRun` in the metadata).
 *
 * Real routes and the real sandbox start (its key in in-memory Mongo); the
 * box, Hatchet and auth are stand-ins.
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
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const who = vi.hoisted(() => ({
  authType: "session" as string,
  workspaceId: "",
}));
const started = vi.hoisted(
  () => [] as Array<{ name: string; run: Record<string, unknown> }>,
);

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "member1" });
    c.set("authType", who.authType);
    await next();
  },
}));

vi.mock("../middleware/workspace.middleware", async importOriginal => ({
  ...(await importOriginal<object>()),
  requireWorkspace: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("workspace", { _id: new Types.ObjectId(who.workspaceId) });
    c.set("memberRole", "member");
    await next();
  },
}));

vi.mock("../services/workspace.service", async importOriginal => {
  const real = await importOriginal<{ workspaceService: object }>();
  return {
    ...real,
    workspaceService: {
      ...real.workspaceService,
      hasRole: vi.fn(async () => true),
    },
  };
});

vi.mock("../workflows/hatchet", async importOriginal => ({
  ...(await importOriginal<object>()),
  requireTenant: vi.fn(async () => ({
    tenantId: "t",
    apiUrl: "https://hatchet.test",
    token: "x",
  })),
  startRun: vi.fn(
    async (_tenant: unknown, name: string, run: Record<string, unknown>) => {
      started.push({ name, run });
      return "22222222-2222-2222-2222-222222222222";
    },
  ),
}));

// No box: the sandbox start runs, its commands go nowhere.
vi.mock("../apps/sandbox/provider", () => ({
  getSandboxProvider: () => ({
    scratch: () => "/scratch",
    root: () => "/root",
    keepAlive: async () => undefined,
    execDetached: async () => undefined,
  }),
}));
vi.mock("../apps/worktree.service", async importOriginal => ({
  ...(await importOriginal<object>()),
  ensureWorkspaceWorktree: vi.fn(async () => ({})),
  boxCtx: vi.fn(() => ({})),
  execInWorktree: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));

import { workflowRoutes } from "./workflows";
import { createWorkflowTools } from "../agent-lib/tools/workflow-tools";
import { Workspace } from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
who.workspaceId = String(WS);

const app = new Hono();
app.route("/api/workspaces/:workspaceId/workflows", workflowRoutes);

const run = (body: object) =>
  app.request(`/api/workspaces/${WS}/workflows/daily-digest/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** The sandbox run keys in the workspace, newest last. */
async function runKeys() {
  const workspace = await Workspace.findById(WS).lean();
  return (workspace?.apiKeys ?? []).filter(k =>
    k.name.startsWith("Workflows sandbox member1 sandbox-"),
  ) as Array<{ name: string; agentRun?: boolean; recordWrites?: boolean }>;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Workspace.collection.insertOne({
    _id: WS,
    name: "t",
    slug: `t-${WS}`,
    createdBy: "member1",
    apiKeys: [],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  started.length = 0;
  await Workspace.updateOne({ _id: WS }, { $set: { apiKeys: [] } });
});

describe("POST /{name}/run", () => {
  it("a sandbox run from the app or an MCP login gets a key that writes", async () => {
    for (const authType of ["session", "mcpOAuth"] as const) {
      who.authType = authType;
      await Workspace.updateOne({ _id: WS }, { $set: { apiKeys: [] } });
      expect((await run({ sandbox: true })).status).toBe(200);
      const keys = await runKeys();
      expect(
        keys.map(k => [k.agentRun, k.recordWrites]),
        authType,
      ).toEqual([[undefined, undefined]]);
    }
  });

  it("a sandbox run with an API key gets agentRun: its writes are refused", async () => {
    who.authType = "apiKey";
    expect((await run({ sandbox: true })).status).toBe(200);
    expect((await runKeys()).map(k => [k.agentRun, k.recordWrites])).toEqual([
      [true, undefined],
    ]);
  });

  it("a sandbox dry run gets recordWrites, whoever starts it", async () => {
    for (const authType of ["session", "apiKey", "mcpOAuth"] as const) {
      who.authType = authType;
      await Workspace.updateOne({ _id: WS }, { $set: { apiKeys: [] } });
      expect((await run({ sandbox: true, dryRun: true })).status).toBe(200);
      expect(
        (await runKeys()).map(k => [k.agentRun, k.recordWrites]),
        authType,
      ).toEqual([[undefined, true]]);
    }
  });

  it("a deployed run records who started it, and a dry run", async () => {
    who.authType = "session";
    await run({ input: { a: 1 } });
    who.authType = "apiKey";
    await run({});
    who.authType = "mcpOAuth";
    await run({});
    await run({ dryRun: true });
    expect(
      started.map(s => [s.run.trigger, s.run.startedBy, s.run.dryRun]),
    ).toEqual([
      ["ui", "person", undefined],
      ["api", "agent", undefined],
      ["mcp", "agent", undefined],
      ["mcp", "agent", true],
    ]);
  });
});

describe("the agent's workflows_run tool", () => {
  const execute = (input: object) =>
    (
      createWorkflowTools({
        workspaceId: String(WS),
        userId: "member1",
      }).workflows_run as unknown as {
        execute: (i: object, o: object) => Promise<Record<string, unknown>>;
      }
    ).execute(input, { toolCallId: "t", messages: [] });

  it("starts a sandbox run whose key writes as the person", async () => {
    const result = await execute({ workflowId: "daily-digest", sandbox: true });
    expect(result.success).toBe(true);
    expect((await runKeys()).map(k => [k.agentRun, k.recordWrites])).toEqual([
      [undefined, undefined],
    ]);
  });

  it("starts a sandbox dry run whose key records writes", async () => {
    await execute({ workflowId: "daily-digest", sandbox: true, dryRun: true });
    expect((await runKeys()).map(k => [k.agentRun, k.recordWrites])).toEqual([
      [undefined, true],
    ]);
  });

  it("starts a deployed run as the agent's, a dry run when asked", async () => {
    await execute({ workflowId: "daily-digest" });
    await execute({ workflowId: "daily-digest", dryRun: true });
    expect(started.map(s => [s.run.startedBy, s.run.dryRun])).toEqual([
      ["agent", undefined],
      ["agent", true],
    ]);
  });
});
