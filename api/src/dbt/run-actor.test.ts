/**
 * dbt_runs.actor: who started a run, set on every creation path.
 *
 * The pure helpers first, then the service paths against real Mongoose models
 * (mongodb-memory-server; only Inngest is mocked): trigger, scheduled job
 * tick, ad-hoc record and retry. The agent, MCP and deploy-on-push paths are
 * covered next to their code (dbt-job-tools.test.ts, dbt-before-deploy.test.ts,
 * local-run.integration.test.ts); the REST routes read their actor through
 * `runActorOf`, tested here.
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

vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })) },
}));

import { DbtJob, DbtProject, DbtRun } from "../database/workspace-schema";
import { McpOAuthClient } from "../database/mcp-oauth-schema";
import { User } from "../database/schema";
import {
  recordCompletedAdhocDbtRun,
  triggerDbtJobRun,
  triggerDbtRun,
  triggerDbtRunRetry,
} from "./dbt-run.service";
import {
  actorFromRequest,
  prNumberFromSubject,
  pushInfoFromCommit,
  redactRunActor,
  retryActor,
  scheduledRunActor,
  withActorNames,
} from "./run-actor";
import { runActorOf } from "../routes/dbt/context";
import type { AuthenticatedContext } from "../middleware/workspace.middleware";

const WS = new Types.ObjectId();
let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtRun.deleteMany({}),
    DbtJob.deleteMany({}),
    User.deleteMany({}),
    McpOAuthClient.deleteMany({}),
  ]);
});

async function seedProject() {
  return DbtProject.create({
    workspaceId: WS,
    name: `p-${new Types.ObjectId().toString()}`,
    environments: [
      {
        name: "dev",
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_dev",
        threads: 4,
      },
      {
        name: "prod",
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_prod",
        threads: 4,
      },
    ],
    defaultEnvironment: "prod",
    createdBy: "tester",
  });
}

async function seedJob(projectId: Types.ObjectId) {
  return DbtJob.create({
    workspaceId: WS,
    projectId,
    name: "nightly",
    environment: "prod",
    commands: ["build"],
    enabled: true,
    createdBy: "tester",
  });
}

describe("actorFromRequest", () => {
  it("a signed-in person is kind user", () => {
    expect(
      actorFromRequest({
        authType: "session",
        user: { id: "u1", email: "joan@example.com" },
      }),
    ).toEqual({ kind: "user", userId: "u1", userName: "joan@example.com" });
  });

  it("a workspace API key is kind api_key, by id and label, never the key", () => {
    const keyId = new Types.ObjectId();
    const actor = actorFromRequest({
      authType: "apiKey",
      user: { id: "u1", email: "joan@example.com" },
      apiKey: {
        _id: keyId,
        name: "ci key",
        // @ts-expect-error a secret on the request must not reach the actor
        keyHash: "secret-hash",
      },
    });
    expect(actor).toMatchObject({
      kind: "api_key",
      userId: "u1",
      apiKeyId: keyId.toString(),
      apiKeyName: "ci key",
    });
    expect(JSON.stringify(actor)).not.toContain("secret-hash");
  });

  it("an OAuth MCP token is kind mcp with its client and session", () => {
    expect(
      actorFromRequest({
        authType: "mcpOAuth",
        user: { id: "u1" },
        mcpOAuthClientId: "client-1",
        mcpAgentSessionId: "sess-1",
      }),
    ).toMatchObject({
      kind: "mcp",
      userId: "u1",
      oauthClientId: "client-1",
      agentSessionId: "sess-1",
    });
  });
});

describe("runActorOf (the REST routes' actor)", () => {
  const ctx = (vars: Record<string, unknown>) =>
    ({ get: (key: string) => vars[key] }) as unknown as AuthenticatedContext;

  it("reads a session, an API key and an MCP token off the request", () => {
    expect(
      runActorOf(
        ctx({ authType: "session", user: { id: "u1", email: "a@b.c" } }),
      ).kind,
    ).toBe("user");
    expect(
      runActorOf(
        ctx({
          authType: "apiKey",
          user: { id: "u1" },
          apiKey: { _id: new Types.ObjectId(), name: "k" },
        }),
      ),
    ).toMatchObject({ kind: "api_key", apiKeyName: "k" });
    expect(
      runActorOf(
        ctx({
          authType: "mcpOAuth",
          user: { id: "u1" },
          mcpOAuthClientId: "c1",
        }),
      ),
    ).toMatchObject({ kind: "mcp", oauthClientId: "c1" });
  });
});

describe("push info", () => {
  it("reads the PR number from a squash-merge subject", () => {
    expect(prNumberFromSubject("fix(dbt): rebuild (#1459)")).toBe(1459);
    expect(prNumberFromSubject("Merge pull request #77 from a/b")).toBe(77);
    expect(prNumberFromSubject("fix: mentions #12 in the middle")).toBe(
      undefined,
    );
  });

  it("keeps only the sha when the commit cannot be read", () => {
    expect(pushInfoFromCommit("abc")).toEqual({ sha: "abc" });
  });
});

describe("redactRunActor", () => {
  it("drops the email and keeps ids and labels", () => {
    expect(
      redactRunActor({
        kind: "api_key",
        userId: "u1",
        userName: "joan@example.com",
        apiKeyId: "k1",
        apiKeyName: "ci key",
      }),
    ).toEqual({
      kind: "api_key",
      userId: "u1",
      apiKeyId: "k1",
      apiKeyName: "ci key",
    });
    expect(redactRunActor(undefined)).toBeUndefined();
  });
});

describe("withActorNames", () => {
  it("fills the user's email and the OAuth client's name from their ids", async () => {
    await User.collection.insertOne({
      _id: "u1" as never,
      email: "joan@example.com",
    });
    await McpOAuthClient.create({
      clientId: "client-1",
      clientName: "Claude Code",
      redirectUris: ["http://localhost:1/cb"],
    });
    const actor = await withActorNames({
      kind: "mcp",
      userId: "u1",
      oauthClientId: "client-1",
    });
    expect(actor).toMatchObject({
      userName: "joan@example.com",
      oauthClientName: "Claude Code",
    });
  });
});

describe("every run creation path stores an actor", () => {
  it("triggerDbtRun stores the actor it is given, with names filled", async () => {
    await User.collection.insertOne({
      _id: "u1" as never,
      email: "joan@example.com",
    });
    const project = await seedProject();
    const run = await triggerDbtRun({
      workspaceId: WS.toString(),
      projectId: project._id.toString(),
      environment: "dev",
      commands: ["build --select stg_orders"],
      trigger: "manual",
      triggeredBy: "u1",
      actor: { kind: "user", userId: "u1" },
    });
    const stored = await DbtRun.findById(run._id).lean();
    expect(stored?.actor).toEqual({
      kind: "user",
      userId: "u1",
      userName: "joan@example.com",
    });
    // The compatibility fields stay as they were.
    expect(stored?.trigger).toBe("manual");
    expect(stored?.triggeredBy).toBe("u1");
  });

  it("a scheduler tick stores kind schedule with the job id", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
      actor: scheduledRunActor(job._id.toString()),
    });
    const stored = await DbtRun.findById(run._id).lean();
    expect(stored?.actor).toEqual({
      kind: "schedule",
      jobScheduleId: job._id.toString(),
    });
    expect(stored?.triggeredBy).toBe("scheduler");
  });

  it("an ad-hoc command recorded after the fact stores its actor", async () => {
    const project = await seedProject();
    const run = await recordCompletedAdhocDbtRun({
      workspaceId: WS.toString(),
      projectId: project._id.toString(),
      environment: "prod",
      command: "run --select stg_orders",
      triggeredBy: "u1",
      actor: { kind: "api_key", userId: "u1", apiKeyId: "k1" },
      startedAt: new Date(),
      result: { success: true, exitCode: 0, logs: [], stepResults: [] },
    });
    expect(run?.actor).toMatchObject({
      kind: "api_key",
      userId: "u1",
      apiKeyId: "k1",
    });
  });

  it("a retry stores kind retry, the source run and who asked", async () => {
    const project = await seedProject();
    const source = await DbtRun.create({
      workspaceId: WS,
      projectId: project._id,
      environment: "prod",
      commands: ["build"],
      status: "error",
      trigger: "schedule",
      triggeredBy: "scheduler",
      artifactKeys: { runResults: "k/run_results.json" },
    });
    const retry = await triggerDbtRunRetry({
      workspaceId: WS.toString(),
      runId: source._id.toString(),
      triggeredBy: "u1",
      actor: { kind: "user", userId: "u1" },
    });
    const stored = await DbtRun.findById(retry?._id).lean();
    expect(stored?.actor).toEqual({
      kind: "retry",
      userId: "u1",
      retryOf: source._id.toString(),
    });
    expect(retryActor({ kind: "user" }, "r1")).toEqual({
      kind: "retry",
      retryOf: "r1",
    });
  });
});
