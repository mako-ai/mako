/**
 * Agent dbt job tools — in-process integration tests.
 *
 * Boots `createDbtServerTools` against an ephemeral mongodb-memory-server and
 * exercises the `dbt_delete_job` tool end-to-end through real Mongoose
 * persistence. Heavy collaborators (runner, run scheduler, GitHub git, realtime
 * bus, entity versioning) are mocked so the test stays deterministic and
 * offline — it only verifies the tool's workspace scoping, validation, and
 * delete behavior.
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

// Heavy collaborators pulled in transitively by the tools module — stubbed so
// imports resolve and side-effects are inert.
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    isAdmin: vi.fn(async () => true),
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
import {
  DbtEnvPreference,
  DbtJob,
  DbtProject,
} from "../../database/workspace-schema";
import { workspaceService } from "../../services/workspace.service";
import { triggerDbtRun } from "../../dbt/dbt-run.service";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId().toString();

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
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
      {
        name: "dev",
        connectionId: new Types.ObjectId(CONN),
        targetSchema: "analytics",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  return project._id.toString();
}

async function seedJob(projectId: string): Promise<string> {
  const job = await DbtJob.create({
    workspaceId: new Types.ObjectId(WS),
    projectId: new Types.ObjectId(projectId),
    name: "nightly",
    environment: "dev",
    commands: ["build"],
    enabled: true,
    deferToProduction: false,
    createdBy: "tester",
  });
  return job._id.toString();
}

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
  // vi.clearAllMocks wipes mock implementations' return queues but keeps the
  // factory defaults; re-assert the multi-user default explicitly.
  vi.mocked(workspaceService.getMembers).mockResolvedValue([
    { userId: "u1" },
    { userId: "u2" },
  ] as never);
  await Promise.all([
    mongoose.connection.collection("dbt_projects").deleteMany({}),
    mongoose.connection.collection("dbt_jobs").deleteMany({}),
    mongoose.connection.collection("dbt_env_preferences").deleteMany({}),
  ]);
});

describe("dbt_delete_job", () => {
  it("deletes an existing job and removes it from the collection", async () => {
    const projectId = await seedProject();
    const jobId = await seedJob(projectId);

    const result = await deleteJob({ projectId, jobId });

    expect(result.success).toBe(true);
    expect(result.jobId).toBe(jobId);
    expect(result.name).toBe("nightly");
    expect(await DbtJob.countDocuments({})).toBe(0);
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
    const otherWs = new Types.ObjectId();
    const project = await DbtProject.create({
      workspaceId: otherWs,
      name: "Other",
      environments: [
        {
          name: "dev",
          connectionId: new Types.ObjectId(CONN),
          targetSchema: "analytics",
          threads: 4,
        },
      ],
      defaultEnvironment: "dev",
      createdBy: "tester",
    });
    const job = await DbtJob.create({
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
    expect(await DbtJob.countDocuments({ _id: job._id })).toBe(1);
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
    const project = await DbtProject.findById(projectId).lean();
    const personal = project?.environments.find(e => e.ownerUserId === "u1");
    expect(personal?.name).toBe("tester");
    expect(personal?.targetSchema).toBe("dbt_tester");

    // The queued run targets it, not the shared default.
    expect(vi.mocked(triggerDbtRun)).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "tester" }),
    );

    // Idempotent: a second build reuses it without adding another env.
    await runModel({ projectId, model: "stg_orders" });
    const after = await DbtProject.findById(projectId).lean();
    expect(
      after?.environments.filter(e => e.ownerUserId === "u1"),
    ).toHaveLength(1);
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
    const project = await DbtProject.findById(projectId).lean();
    expect(project?.environments.some(e => e.ownerUserId === "u1")).toBe(false);
  });

  it("a saved per-user dev environment wins and suppresses auto-provisioning", async () => {
    const projectId = await seedProject();
    await DbtEnvPreference.create({
      workspaceId: new Types.ObjectId(WS),
      projectId: new Types.ObjectId(projectId),
      userId: "u1",
      environment: "dev",
    });

    const result = await runModel({ projectId, model: "stg_orders" });
    expect(result.success).toBe(true);
    expect(vi.mocked(triggerDbtRun)).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "dev" }),
    );
    // Even in a multi-user workspace the explicit choice stops provisioning.
    const project = await DbtProject.findById(projectId).lean();
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
    const project = await DbtProject.findById(projectId).lean();
    expect(project?.environments.some(e => e.ownerUserId === "u1")).toBe(false);
  });
});
