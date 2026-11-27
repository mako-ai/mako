/**
 * Agent dbt job tools — in-process integration tests.
 *
 * Boots `createDbtServerTools` against a disposable PGlite database and
 * exercises the `dbt_delete_job` tool end-to-end through real Postgres
 * persistence. Heavy collaborators (runner, run scheduler, GitHub git, realtime
 * bus, entity versioning) are mocked so the test stays deterministic and
 * offline — it only verifies the tool's workspace scoping, validation, and
 * delete behavior.
 *
 * Personal-env auto-provision writes `dbt/environments.yml` through git
 * (`requireWorkspaceRepo`), so this file uses the same temp APPS_GIT_ROOT
 * + `initRepo` rig as `dbt-config.service.test.ts`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Types } from "mongoose";
import {
  ensureTestDatabaseConnection,
  ensureTestWorkspace,
  ensureTestUser,
  setupPgTestDb,
  type PgTestDb,
} from "../../test-support/pg-test";

// Heavy collaborators pulled in transitively by the tools module — stubbed so
// imports resolve and side-effects are inert.
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    isAdmin: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "admin" })),
    // Default: multi-user workspace; solo tests override per-call.
    getMembers: vi.fn(async () => [{ userId: "u1" }, { userId: "u2" }]),
  },
}));
vi.mock("../../services/entity-version.service", () => ({
  createVersion: vi.fn(async () => ({})),
  getLatestVersionNumber: vi.fn(async () => 0),
  getUserDisplayName: vi.fn(async () => "Tester"),
}));
vi.mock("../../dbt/dbt-project.service", () => ({
  runAdhocDbtCommand: vi.fn(),
}));
vi.mock("../../dbt/dbt-run.service", () => ({
  applyJobScheduleChange: vi.fn(async () => undefined),
  reconcileStaleQueuedRun: vi.fn(async (r: unknown) => r),
  triggerDbtJobRun: vi.fn(async () => ({ _id: new Types.ObjectId() })),
  triggerDbtRun: vi.fn(async () => ({ _id: new Types.ObjectId() })),
}));
vi.mock("../../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));

// Imported after the mocks are registered.
import { createDbtServerTools } from "./dbt-tools";
import { dbtRepo } from "../../repositories/dbt";
import { workspaceService } from "../../services/workspace.service";
import { triggerDbtJobRun, triggerDbtRun } from "../../dbt/dbt-run.service";
import {
  DEFAULT_BRANCH,
  initRepo,
  readBlob,
  repoDirFor,
} from "../../apps/repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../../apps/bind-test-workspace-repo";
import { DBT_ENVIRONMENTS_PATH } from "../../dbt/dbt-config-files";
import { commitDbtJobFile, reserveJobSlug } from "../../dbt/dbt-config.service";

let pgh: PgTestDb;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

type DeleteJobInput = { projectId: string; jobId: string };
type ToolResult = {
  success: boolean;
  error?: string;
  jobId?: string;
  name?: string;
  branch?: string;
  sha?: string;
};

const tools = createDbtServerTools(WS, "u1", { chatId: "chat1" });

function deleteJob(input: DeleteJobInput): Promise<ToolResult> {
  // The AI SDK tool() wraps execute; call it the way the SDK does at runtime.
  return (
    tools.dbt_delete_job.execute as (i: DeleteJobInput) => Promise<ToolResult>
  )(input);
}

async function seedProject(): Promise<string> {
  const project = await dbtRepo.createProject({
    workspaceId: WS,
    name: "Analytics",
    environments: [
      {
        name: "dev",
        connectionId: CONN,
        targetSchema: "analytics",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  return project._id.toString();
}

/**
 * A job is live only when `dbt/jobs/<slug>.yml` exists at main (the tools
 * resolve through the git overlay); seed the row AND commit its file.
 */
async function seedJob(projectId: string, opts?: { rowOnly?: boolean }) {
  const project = await dbtRepo.findProjectById(projectId);
  const job = await dbtRepo.createJob({
    workspaceId: WS,
    projectId,
    slug: await reserveJobSlug(projectId, "nightly"),
    name: "nightly",
    environment: "dev",
    commands: ["build"],
    enabled: true,
    deferToProduction: false,
    createdBy: "tester",
  });
  if (!opts?.rowOnly) await commitDbtJobFile(project!, job);
  return job._id.toString();
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-job-tools-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  pgh = await setupPgTestDb();
}, 120_000);

afterAll(async () => {
  await pgh.close();
  await fs.rm(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

beforeEach(async () => {
  await pgh.reset();
  await ensureTestUser(pgh.db, { id: "u1" });
  await ensureTestDatabaseConnection(pgh.db, {
    workspaceId: WS,
    id: CONN,
  });
  vi.clearAllMocks();
  // vi.clearAllMocks wipes mock implementations' return queues but keeps the
  // factory defaults; re-assert the multi-user default explicitly.
  vi.mocked(workspaceService.getMembers).mockResolvedValue([
    { userId: "u1" },
    { userId: "u2" },
  ] as never);
  await fs.rm(path.join(tmpRoot, "repos"), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

describe("dbt_delete_job", () => {
  it("deletes an existing job and removes it from the collection", async () => {
    const projectId = await seedProject();
    const jobId = await seedJob(projectId);

    const result = await deleteJob({ projectId, jobId });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe(jobId);
    expect(result.name).toBe("nightly");
    expect(await dbtRepo.listJobsByProject(projectId)).toHaveLength(0);
  });

  it("refuses a row whose file is not at main (not a live definition)", async () => {
    const projectId = await seedProject();
    const jobId = await seedJob(projectId, { rowOnly: true });
    const result = await deleteJob({ projectId, jobId });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(await dbtRepo.listJobsByProject(projectId)).toHaveLength(1);
  });

  it("returns an error for an unknown job id", async () => {
    const projectId = await seedProject();
    const result = await deleteJob({
      projectId,
      jobId: new Types.ObjectId().toString(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("rejects a malformed job id", async () => {
    const projectId = await seedProject();
    const result = await deleteJob({ projectId, jobId: "not-an-objectid" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid job id/i);
  });

  it("does not delete a job that belongs to another workspace's project", async () => {
    // Project + job exist, but under a different workspace than the tool's WS.
    const otherWs = new Types.ObjectId().toString();
    await ensureTestWorkspace(pgh.db, { id: otherWs });
    const project = await dbtRepo.createProject({
      workspaceId: otherWs,
      name: "Other",
      environments: [
        {
          name: "dev",
          connectionId: CONN,
          targetSchema: "analytics",
          threads: 4,
        },
      ],
      defaultEnvironment: "dev",
      createdBy: "tester",
    });
    const job = await dbtRepo.createJob({
      workspaceId: otherWs,
      projectId: project._id,
      name: "foreign",
      environment: "dev",
      commands: ["build"],
      enabled: true,
      deferToProduction: false,
      createdBy: "tester",
    });

    const result = await deleteJob({
      projectId: project._id.toString(),
      jobId: job._id.toString(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found|access denied/i);
    expect(await dbtRepo.findJobById(job._id)).toBeTruthy();
  });
});

describe("dbt_run_model — per-user environment resolution", () => {
  function runModel(input: {
    projectId: string;
    model: string;
    environment?: string;
  }): Promise<ToolResult & { environment?: string }> {
    return (
      tools.dbt_run_model.execute as (
        i: typeof input,
      ) => Promise<ToolResult & { environment?: string }>
    )(input);
  }

  it("multi-user workspace: provisions the caller's personal environment on the first build", async () => {
    const projectId = await seedProject();

    const result = await runModel({ projectId, model: "stg_orders" });
    expect(result.success).toBe(true);

    // Personal env exists now (slug from the mocked display name "Tester").
    const project = await dbtRepo.findProjectById(projectId);
    const personal = project?.environments.find(e => e.ownerUserId === "u1");
    expect(personal?.name).toBe("tester");
    expect(personal?.targetSchema).toBe("dbt_tester");
    const envFile = await readBlob(repoDirFor(WS), MAIN, DBT_ENVIRONMENTS_PATH);
    expect(envFile.contents).toContain("name: tester");
    expect(envFile.contents).toContain("dbt_tester");

    // The queued run targets it, not the shared default.
    expect(vi.mocked(triggerDbtRun)).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "tester" }),
    );

    // Idempotent: a second build reuses it without adding another env.
    await runModel({ projectId, model: "stg_orders" });
    const after = await dbtRepo.findProjectById(projectId);
    expect(
      after?.environments.filter(e => e.ownerUserId === "u1"),
    ).toHaveLength(1);
  });

  it("multi-user workspace: a missing GitHub binding does not fall back to shared dev", async () => {
    await unbindTestWorkspaceRepo(WS);
    const projectId = await seedProject();

    const result = await runModel({ projectId, model: "stg_orders" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Connect a GitHub repository/i);
    expect(vi.mocked(triggerDbtRun)).not.toHaveBeenCalled();
    const project = await dbtRepo.findProjectById(projectId);
    expect(project?.environments.some(e => e.ownerUserId === "u1")).toBe(false);
  });

  it("single-user workspace: dev IS the personal target — no auto-provisioning", async () => {
    vi.mocked(workspaceService.getMembers).mockResolvedValue([
      { userId: "u1" },
    ] as never);
    const projectId = await seedProject();

    const result = await runModel({ projectId, model: "stg_orders" });
    expect(result.success).toBe(true);
    expect(vi.mocked(triggerDbtRun)).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "dev" }),
    );
    const project = await dbtRepo.findProjectById(projectId);
    expect(project?.environments.some(e => e.ownerUserId === "u1")).toBe(false);
  });

  it("a saved per-user dev environment wins and suppresses auto-provisioning", async () => {
    const projectId = await seedProject();
    await dbtRepo.upsertEnvPreference({
      workspaceId: WS,
      projectId,
      userId: "u1",
      environment: "dev",
    });

    const result = await runModel({ projectId, model: "stg_orders" });
    expect(result.success).toBe(true);
    expect(vi.mocked(triggerDbtRun)).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "dev" }),
    );
    // Even in a multi-user workspace the explicit choice stops provisioning.
    const project = await dbtRepo.findProjectById(projectId);
    expect(project?.environments.some(e => e.ownerUserId === "u1")).toBe(false);
  });

  it("an explicit environment always wins (no auto-provisioning)", async () => {
    const projectId = await seedProject();

    const result = await runModel({
      projectId,
      model: "stg_orders",
      environment: "dev",
    });
    expect(result.success).toBe(true);
    expect(vi.mocked(triggerDbtRun)).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "dev" }),
    );
    const project = await dbtRepo.findProjectById(projectId);
    expect(project?.environments.some(e => e.ownerUserId === "u1")).toBe(false);
  });
});

describe("dbt runs record who started them (actor)", () => {
  type Exec = (i: unknown, o: unknown) => Promise<Record<string, unknown>>;
  const exec = (set: ReturnType<typeof createDbtServerTools>, name: string) =>
    (set[name as keyof typeof set].execute as unknown as Exec).bind(null);

  const agentActor = { kind: "agent", userId: "u1", chatId: "chat1" };

  it("dbt_run_model by the in-app agent: kind agent, user and chat", async () => {
    const projectId = await seedProject();
    await exec(tools, "dbt_run_model")(
      { projectId, model: "stg_orders", environment: "dev" },
      {},
    );
    expect(vi.mocked(triggerDbtRun)).toHaveBeenCalledWith(
      expect.objectContaining({ actor: agentActor }),
    );
  });

  it("dbt_show (the shared queue helper) records the same agent actor", async () => {
    const projectId = await seedProject();
    const result = await exec(tools, "dbt_show")(
      { projectId, model: "stg_orders", limit: 5, environment: "dev" },
      {},
    );
    expect(result).toMatchObject({ success: true });
    expect(vi.mocked(triggerDbtRun)).toHaveBeenCalledWith(
      expect.objectContaining({ actor: agentActor }),
    );
  });

  it("dbt_run_job by the in-app agent: kind agent, user and chat", async () => {
    const projectId = await seedProject();
    const jobId = await seedJob(projectId);
    const result = await exec(tools, "dbt_run_job")({ projectId, jobId }, {});
    expect(result.success).toBe(true);
    expect(vi.mocked(triggerDbtJobRun)).toHaveBeenCalledWith(
      expect.objectContaining({ actor: agentActor }),
    );
  });

  it("over MCP the tools pass the server's credential, not a chat", async () => {
    const mcpActor = {
      kind: "mcp" as const,
      userId: "u1",
      oauthClientId: "mako-client-abc",
    };
    const mcpTools = createDbtServerTools(WS, "u1", {
      chatId: "mcp-xyz",
      actor: mcpActor,
    });
    const projectId = await seedProject();
    const jobId = await seedJob(projectId);
    await exec(mcpTools, "dbt_run_model")(
      { projectId, model: "stg_orders", environment: "dev" },
      {},
    );
    await exec(mcpTools, "dbt_run_job")({ projectId, jobId }, {});
    expect(vi.mocked(triggerDbtRun)).toHaveBeenCalledWith(
      expect.objectContaining({ actor: mcpActor }),
    );
    expect(vi.mocked(triggerDbtJobRun)).toHaveBeenCalledWith(
      expect.objectContaining({ actor: mcpActor }),
    );
  });

  it("dbt_get_run shows the actor without the user's email", async () => {
    const projectId = await seedProject();
    const run = await dbtRepo.createRun({
      workspaceId: WS,
      projectId,
      environment: "dev",
      commands: ["build"],
      status: "success",
      trigger: "agent",
      triggeredBy: "agent",
      actor: {
        kind: "mcp",
        userId: "u1",
        userName: "joan@example.com",
        oauthClientId: "mako-client-abc",
        oauthClientName: "Claude Code",
      },
    });
    const result = await exec(tools, "dbt_get_run")(
      { projectId, runId: run._id.toString() },
      {},
    );
    expect(result.actor).toEqual({
      kind: "mcp",
      userId: "u1",
      oauthClientId: "mako-client-abc",
      oauthClientName: "Claude Code",
    });
  });
});
