/**
 * dbt run tools against real Mongo.
 *
 * dbt_get_run: the queue explanation for a run waiting behind the project's
 * single execution slot, the bounded wait that returns the current status
 * instead of outliving the caller's timeout, and the per-run input fields.
 * dbt_list_runs: filters, paging, workspace scoping. dbt_run_job: the
 * vars / fullRefresh passthrough. dbt_model_cost, dbt_table_readers and
 * dbt_list_orphans: the unsupported-engine and partial-scope answers.
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

vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: { hasAccess: vi.fn(async () => true) },
}));
vi.mock("../../dbt/dbt-project.service", () => ({
  loadDbtDeferState: vi.fn(async () => undefined),
  runAdhocDbtCommand: vi.fn(),
}));
vi.mock("../../dbt/dbt-run.service", () => ({
  triggerDbtRun: vi.fn(),
  triggerDbtJobRun: vi.fn(),
  requestDbtRunCancel: vi.fn(),
  reconcileStaleQueuedRun: vi.fn(async (run: unknown) => run),
  reconcileStaleQueuedRuns: vi.fn(async (runs: unknown) => runs),
  applyJobScheduleChange: vi.fn(),
}));
// The job row is resolved from the repo's yml in production; these specs
// hand it the Mongo row directly.
vi.mock("../../dbt/dbt-config.service", async importOriginal => ({
  ...(await importOriginal<object>()),
  resolveLiveJobRow: vi.fn(),
}));
vi.mock("../../services/warehouse-job-history.service", () => ({
  modelCost: vi.fn(),
  tableReaders: vi.fn(),
}));
vi.mock("../../dbt/dbt-orphans.service", () => ({
  listDbtOrphans: vi.fn(),
}));
vi.mock("../../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));

import { createDbtServerTools } from "./dbt-tools";
import { DbtJob, DbtProject, DbtRun } from "../../database/workspace-schema";
import { MCP_MAX_RUN_WAIT_MS } from "../../mcp/mako-mcp-server";
import { triggerDbtJobRun } from "../../dbt/dbt-run.service";
import { resolveLiveJobRow } from "../../dbt/dbt-config.service";
import { DbtRunOverridesError } from "../../dbt/dbt-run-overrides";
import { DbtJobDefinitionMissingError } from "../../dbt/dbt-run-errors";
import {
  modelCost,
  tableReaders,
} from "../../services/warehouse-job-history.service";
import { listDbtOrphans } from "../../dbt/dbt-orphans.service";

type Mock = ReturnType<typeof vi.fn>;
const triggerJobMock = triggerDbtJobRun as unknown as Mock;
const resolveJobMock = resolveLiveJobRow as unknown as Mock;
const modelCostMock = modelCost as unknown as Mock;
const tableReadersMock = tableReaders as unknown as Mock;
const orphansMock = listDbtOrphans as unknown as Mock;

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtRun.deleteMany({}),
    DbtJob.deleteMany({}),
  ]);
  for (const mock of [
    triggerJobMock,
    resolveJobMock,
    modelCostMock,
    tableReadersMock,
    orphansMock,
  ]) {
    mock.mockReset();
  }
});

type SafeParse = {
  safeParse: (input: unknown) => { success: boolean };
};
/** Does the tool's input schema accept this input? */
const accepts = (tool: { inputSchema?: unknown }, input: unknown): boolean =>
  (tool.inputSchema as SafeParse).safeParse(input).success;

type Exec<I, O> = (i: I, ctx: { abortSignal?: AbortSignal }) => Promise<O>;
const run = <I, O>(
  tool: { execute?: unknown },
  input: I,
  ctx: { abortSignal?: AbortSignal } = {},
): Promise<O> => (tool.execute as Exec<I, O>)(input, ctx);

type RunResult = {
  success: boolean;
  status: string;
  stepsTotal: number;
  stepResults: unknown[];
  queue?: {
    runsAhead: number;
    blockedBy: { runId: string; jobName?: string } | null;
    queuedAheadCount: number;
    blockingTypicalDurationMs?: number;
    estimatedStartAt?: Date;
    reason: string;
  };
};

async function seed() {
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
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
  const job = await DbtJob.create({
    workspaceId: new Types.ObjectId(WS),
    projectId: project._id,
    name: "Daily prod validation + snapshots",
    environment: "prod",
    commands: ["build"],
    createdBy: "tester",
  });
  const base = {
    workspaceId: new Types.ObjectId(WS),
    projectId: project._id,
    environment: "prod",
    commands: ["build"],
    triggeredBy: "tester",
  };
  // Two finished runs give the job a typical duration of 20 minutes.
  await DbtRun.create([
    {
      ...base,
      jobId: job._id,
      trigger: "schedule",
      status: "success",
      durationMs: 18 * 60_000,
    },
    {
      ...base,
      jobId: job._id,
      trigger: "schedule",
      status: "success",
      durationMs: 22 * 60_000,
    },
  ]);
  const blocking = await DbtRun.create({
    ...base,
    jobId: job._id,
    trigger: "schedule",
    status: "running",
    startedAt: new Date(Date.now() - 5 * 60_000),
  });
  const queued = await DbtRun.create({
    ...base,
    trigger: "manual",
    status: "queued",
  });
  return { project, job, blocking, queued };
}

describe("dbt_get_run", () => {
  it("explains a queued run: the blocking run, its job and a start estimate", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project, blocking, queued } = await seed();
    const result = await run<object, RunResult>(tools.dbt_get_run, {
      projectId: project._id.toString(),
      runId: queued._id.toString(),
    });
    expect(result.status).toBe("queued");
    expect(result.queue?.runsAhead).toBe(1);
    expect(result.queue?.blockedBy?.runId).toBe(blocking._id.toString());
    expect(result.queue?.blockedBy?.jobName).toBe(
      "Daily prod validation + snapshots",
    );
    expect(result.queue?.blockingTypicalDurationMs).toBe(20 * 60_000);
    const eta = new Date(result.queue?.estimatedStartAt ?? 0).getTime();
    expect(eta).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(result.queue?.reason).toContain(
      `Queued behind run ${blocking._id.toString()} of job "Daily prod validation + snapshots"`,
    );
  });

  it("returns the current status when the wait elapses, within the cap", async () => {
    const tools = createDbtServerTools(WS, "u1", { maxRunWaitMs: 3_000 });
    const { project, queued } = await seed();
    const started = Date.now();
    const result = await run<object, RunResult>(tools.dbt_get_run, {
      projectId: project._id.toString(),
      runId: queued._id.toString(),
      waitMs: 90_000,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.success).toBe(true);
    expect(result.status).toBe("queued");
    expect(result.queue?.blockedBy).not.toBeNull();
  });

  it("the MCP cap stays under a 60s client timeout", () => {
    expect(MCP_MAX_RUN_WAIT_MS).toBeLessThan(60_000);
  });

  it("has no queue field once the run has started", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project, blocking } = await seed();
    const result = await run<object, RunResult>(tools.dbt_get_run, {
      projectId: project._id.toString(),
      runId: blocking._id.toString(),
    });
    expect(result.status).toBe("running");
    expect(result.queue).toBeUndefined();
  });

  it("summarizes a run with many steps", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project, blocking } = await seed();
    await DbtRun.updateOne(
      { _id: blocking._id },
      {
        $set: {
          status: "error",
          stepResults: Array.from({ length: 300 }, (_, i) => ({
            uniqueId: `model.a.m${i}`,
            name: `m${i}`,
            resourceType: "model",
            status: i === 42 ? "error" : "success",
            executionTimeMs: 5,
            message: i === 42 ? "boom" : "OK",
          })),
        },
      },
    );
    const result = await run<object, RunResult>(tools.dbt_get_run, {
      projectId: project._id.toString(),
      runId: blocking._id.toString(),
    });
    expect(result.stepsTotal).toBe(300);
    expect(result.stepResults).toEqual([
      expect.objectContaining({
        name: "m42",
        status: "error",
        message: "boom",
      }),
    ]);
  });
});

describe("dbt_get_run per-run inputs", () => {
  it("echoes overrides, definition sha, lane and invocation ids when set", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project, job } = await seed();
    const sha = "b".repeat(40);
    const withInputs = await DbtRun.create({
      workspaceId: new Types.ObjectId(WS),
      projectId: project._id,
      jobId: job._id,
      environment: "prod",
      commands: ["build --full-refresh"],
      trigger: "agent",
      triggeredBy: "agent",
      status: "success",
      overrides: { vars: { start_date: "2026-01-01" }, fullRefresh: true },
      definitionSha: sha,
      lane: "job",
      invocationIds: ["inv-1", "inv-2"],
    });
    const result = await run<object, Record<string, unknown>>(
      tools.dbt_get_run,
      { projectId: project._id.toString(), runId: withInputs._id.toString() },
    );
    expect(result).toMatchObject({
      jobId: job._id.toString(),
      overrides: { vars: { start_date: "2026-01-01" }, fullRefresh: true },
      definitionSha: sha,
      lane: "job",
      invocationIds: ["inv-1", "inv-2"],
    });
  });

  it("adds none of them to a run that has none", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project, queued } = await seed();
    const result = await run<object, Record<string, unknown>>(
      tools.dbt_get_run,
      { projectId: project._id.toString(), runId: queued._id.toString() },
    );
    for (const key of ["overrides", "definitionSha", "lane", "invocationIds"]) {
      expect(result).not.toHaveProperty(key);
    }
  });
});

type ListResult = {
  success: boolean;
  error?: string;
  count: number;
  runs: Array<{
    runId: string;
    jobName?: string;
    status: string;
    trigger: string;
  }>;
  nextBefore: string | null;
  skipped?: { count: number; lastAt?: string };
};

/** Space the seeded runs one minute apart, so order and paging are exact. */
async function spreadCreatedAt(projectId: Types.ObjectId): Promise<string[]> {
  const rows = await DbtRun.find({ projectId }).sort({ _id: 1 }).lean();
  const base = Date.now() - 60 * 60_000;
  await Promise.all(
    rows.map((row, index) =>
      DbtRun.collection.updateOne(
        { _id: row._id },
        { $set: { createdAt: new Date(base + index * 60_000) } },
      ),
    ),
  );
  // Newest first, the order the tool returns.
  return rows.map(row => row._id.toString()).reverse();
}

describe("dbt_list_runs", () => {
  it("lists a project's runs newest first, without steps or logs", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project, queued } = await seed();
    const newestFirst = await spreadCreatedAt(project._id);
    const result = await run<object, ListResult>(tools.dbt_list_runs, {
      projectId: project._id.toString(),
    });
    expect(result.success).toBe(true);
    expect(result.count).toBe(4);
    expect(result.runs.map(row => row.runId)).toEqual(newestFirst);
    expect(result.runs[0].runId).toBe(queued._id.toString());
    expect(result.nextBefore).toBeNull();
    expect(result.skipped).toBeUndefined();
    for (const row of result.runs) {
      expect(row).not.toHaveProperty("stepResults");
      expect(row).not.toHaveProperty("logs");
    }
  });

  it("filters by job and status and returns the job's skipped ticks", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project, job } = await seed();
    await DbtJob.updateOne(
      { _id: job._id },
      {
        $set: {
          "scheduledRun.skippedCount": 3,
          "scheduledRun.runCount": 3,
          "scheduledRun.consecutiveFailures": 0,
        },
      },
    );
    const result = await run<object, ListResult>(tools.dbt_list_runs, {
      projectId: project._id.toString(),
      jobId: job._id.toString(),
      status: "success",
    });
    expect(result.count).toBe(2);
    expect(result.runs.every(row => row.status === "success")).toBe(true);
    expect(result.runs[0].jobName).toBe("Daily prod validation + snapshots");
    expect(result.skipped).toEqual({ count: 3 });

    const manual = await run<object, ListResult>(tools.dbt_list_runs, {
      projectId: project._id.toString(),
      trigger: "manual",
    });
    expect(manual.count).toBe(1);
  });

  it("pages with nextBefore", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    const newestFirst = await spreadCreatedAt(project._id);
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result: ListResult = await run<object, ListResult>(
        tools.dbt_list_runs,
        { projectId: project._id.toString(), limit: 3, before },
      );
      seen.push(...result.runs.map(row => row.runId));
      if (!result.nextBefore) break;
      before = result.nextBefore;
    }
    // 4 runs at 3 per page: 2 pages, every run once, in order.
    expect(seen).toEqual(newestFirst);
  });

  it("never lists another workspace's project", async () => {
    const { project } = await seed();
    const outsider = createDbtServerTools(
      new Types.ObjectId().toString(),
      "u2",
    );
    const result = await run<object, ListResult>(outsider.dbt_list_runs, {
      projectId: project._id.toString(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found or access denied/);
  });

  it("refuses a bad cursor and a bad job id with a clear error", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    const badCursor = await run<object, ListResult>(tools.dbt_list_runs, {
      projectId: project._id.toString(),
      before: "yesterday",
    });
    expect(badCursor.success).toBe(false);
    expect(badCursor.error).toMatch(/Invalid `before`/);
    const badJob = await run<object, ListResult>(tools.dbt_list_runs, {
      projectId: project._id.toString(),
      jobId: "nope",
    });
    expect(badJob).toEqual({ success: false, error: "Invalid job id" });
  });

  it("validates its input: status, trigger and the limit range", () => {
    const { dbt_list_runs: tool } = createDbtServerTools(WS, "u1");
    const projectId = new Types.ObjectId().toString();
    expect(accepts(tool, { projectId })).toBe(true);
    expect(accepts(tool, { projectId, status: "error", limit: 100 })).toBe(
      true,
    );
    expect(accepts(tool, { projectId, status: "failed" })).toBe(false);
    expect(accepts(tool, { projectId, trigger: "cron" })).toBe(false);
    expect(accepts(tool, { projectId, limit: 0 })).toBe(false);
    expect(accepts(tool, { projectId, limit: 101 })).toBe(false);
    expect(accepts(tool, { projectId, limit: 2.5 })).toBe(false);
    expect(accepts(tool, {})).toBe(false);
  });
});

type JobRunResult = {
  success: boolean;
  error?: string;
  runId?: string;
  commands?: string[];
  overrides?: { vars?: Record<string, unknown>; fullRefresh?: boolean };
};

describe("dbt_run_job inputs", () => {
  async function seedJob() {
    const { project, job } = await seed();
    resolveJobMock.mockResolvedValue({ ok: true, row: job });
    return { projectId: project._id.toString(), jobId: job._id.toString() };
  }

  it("a plain trigger passes no overrides", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const ids = await seedJob();
    triggerJobMock.mockResolvedValue({
      _id: new Types.ObjectId(),
      environment: "prod",
      commands: ["build"],
    });
    const result = await run<object, JobRunResult>(tools.dbt_run_job, ids);
    expect(result.success).toBe(true);
    expect(result.commands).toEqual(["build"]);
    expect(result).not.toHaveProperty("overrides");
    expect(triggerJobMock).toHaveBeenCalledTimes(1);
    expect(triggerJobMock.mock.calls[0][0]).not.toHaveProperty("overrides");
    expect(triggerJobMock.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      trigger: "agent",
      triggeredBy: "agent",
    });
  });

  it("passes vars and fullRefresh as overrides and echoes the run's own commands", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const ids = await seedJob();
    const overrides = { vars: { start_date: "2026-01-01" }, fullRefresh: true };
    triggerJobMock.mockResolvedValue({
      _id: new Types.ObjectId(),
      environment: "prod",
      commands: ["build --full-refresh"],
      overrides,
    });
    const result = await run<object, JobRunResult>(tools.dbt_run_job, {
      ...ids,
      ...overrides,
    });
    expect(triggerJobMock.mock.calls[0][0]).toMatchObject({ overrides });
    expect(result.success).toBe(true);
    expect(result.commands).toEqual(["build --full-refresh"]);
    expect(result.overrides).toEqual(overrides);
    // Per-run only: the saved job is untouched.
    const saved = await DbtJob.findById(ids.jobId).lean();
    expect(saved?.commands).toEqual(["build"]);
  });

  it("passes fullRefresh alone", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const ids = await seedJob();
    triggerJobMock.mockResolvedValue({ _id: new Types.ObjectId() });
    await run<object, JobRunResult>(tools.dbt_run_job, {
      ...ids,
      fullRefresh: false,
    });
    expect(triggerJobMock.mock.calls[0][0].overrides).toEqual({
      vars: undefined,
      fullRefresh: false,
    });
  });

  it("says the job was deleted when its file is gone at the run's commit", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const ids = await seedJob();
    triggerJobMock.mockRejectedValue(
      new DbtJobDefinitionMissingError(
        { _id: new Types.ObjectId(ids.jobId), slug: "nightly-build" },
        "0123456789abcdef0123456789abcdef01234567",
      ),
    );
    const result = await run<object, JobRunResult & { code?: string }>(
      tools.dbt_run_job,
      ids,
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("job_definition_missing");
    expect(result.error).toMatch(
      /^Job file dbt\/jobs\/nightly-build\.yml does not exist at commit 0123456 /,
    );
    expect(result.error).toMatch(/No run started\. Do not retry/);
  });

  it("surfaces a rejected override as a tool error", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const ids = await seedJob();
    triggerJobMock.mockRejectedValue(
      new DbtRunOverridesError(
        "vars cannot be set: a job command already declares --vars",
      ),
    );
    const result = await run<object, JobRunResult>(tools.dbt_run_job, {
      ...ids,
      vars: { a: 1 },
    });
    expect(result).toEqual({
      success: false,
      error: "vars cannot be set: a job command already declares --vars",
    });
  });

  it("validates its input: vars is an object, fullRefresh a boolean", () => {
    const { dbt_run_job: tool } = createDbtServerTools(WS, "u1");
    const ids = { projectId: "p", jobId: "j" };
    expect(accepts(tool, ids)).toBe(true);
    expect(accepts(tool, { ...ids, vars: { a: 1, b: "x", c: [1] } })).toBe(
      true,
    );
    expect(accepts(tool, { ...ids, fullRefresh: true })).toBe(true);
    expect(accepts(tool, { ...ids, vars: "a=1" })).toBe(false);
    expect(accepts(tool, { ...ids, vars: ["a"] })).toBe(false);
    expect(accepts(tool, { ...ids, fullRefresh: "yes" })).toBe(false);
  });

  it("keeps the confirm-first safety text", () => {
    const { dbt_run_job: tool } = createDbtServerTools(WS, "u1");
    expect(tool.description).toContain(
      "Only call after the user explicitly confirms which job to run",
    );
    expect(tool.description).toContain("never trigger prod jobs proactively");
  });
});

type IntrospectionResult = {
  success: boolean;
  supported?: boolean;
  error?: string;
  message?: string;
  scope?: string;
  warning?: string;
  rowCount?: number;
  rows?: unknown[];
  totals?: { jobs: number; bytesBilled: number; slotMs: number };
  totalRows?: number;
  region?: string;
  regionSource?: string;
  conclusive?: boolean;
  relation?: string;
  orphanCount?: number;
  orphanBytes?: number;
  truncated?: boolean;
  listed?: number;
  orphans?: Array<{ name: string; confidence?: string; reasons?: string[] }>;
  notes?: string[];
  model?: string;
  jobsByTextOnly?: number;
  stale?: boolean;
  warnings?: string[];
  manifestAgeHours?: number;
  schemasMissing?: string[];
  skipped?: { sources: number; testFailureTables: number };
  confidenceCounts?: { high: number; medium: number; low: number };
};

const GRANT_WARNING =
  "Missing bigquery.jobs.listAll: grant roles/bigquery.resourceViewer to " +
  "the connection's service account to see every reader.";

describe("dbt_model_cost", () => {
  it("answers an unsupported engine with its reason, not an error", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    modelCostMock.mockResolvedValue({
      supported: false,
      reason: "postgresql has no job history.",
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_model_cost,
      {
        projectId: project._id.toString(),
      },
    );
    expect(result).toEqual({
      success: true,
      supported: false,
      message: "Model cost is not available: postgresql has no job history.",
    });
  });

  it("returns rows with totals on the project scope", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project, job } = await seed();
    modelCostMock.mockResolvedValue({
      supported: true,
      scope: "project",
      days: 7,
      rows: [
        {
          day: "2026-01-14",
          nodeId: "model.analytics.fct_orders",
          jobs: 2,
          bytesBilled: 1000,
          slotMs: 40,
        },
        {
          day: "2026-01-14",
          nodeId: "model.analytics.dim_users",
          jobs: 1,
          bytesBilled: 500,
          slotMs: 10,
        },
      ],
      totalRows: 2,
      totals: { jobs: 3, bytesBilled: 1500, slotMs: 50 },
      truncated: false,
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_model_cost,
      {
        projectId: project._id.toString(),
        jobId: job._id.toString(),
        days: 7,
      },
    );
    expect(modelCostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        projectId: project._id.toString(),
        jobId: job._id.toString(),
        days: 7,
      }),
    );
    expect(result.supported).toBe(true);
    expect(result.scope).toBe("project");
    expect(result.rowCount).toBe(2);
    expect(result.totals).toEqual({ jobs: 3, bytesBilled: 1500, slotMs: 50 });
    expect(result.totalRows).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.message).toMatch(/every job of the warehouse project/);
    expect(result.message).not.toMatch(/PARTIAL/);
    expect(result).not.toHaveProperty("warning");
  });

  // Review B2. The tool summed `rows`, which the SQL LIMIT had already cut.
  it("reports the window totals and flags a cut list, never a sum of the rows", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    modelCostMock.mockResolvedValue({
      supported: true,
      scope: "project",
      days: 7,
      region: "eu",
      regionSource: "dataset",
      // 1 of 240 model-days listed.
      rows: [
        {
          day: "2026-01-14",
          nodeId: "model.analytics.fct_orders",
          jobs: 2,
          bytesBilled: 1000,
          slotMs: 40,
        },
      ],
      totalRows: 240,
      totals: { jobs: 900, bytesBilled: 5_000_000, slotMs: 70_000 },
      truncated: true,
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_model_cost,
      { projectId: project._id.toString(), limit: 1 },
    );
    expect(result.rowCount).toBe(1);
    expect(result.totalRows).toBe(240);
    expect(result.truncated).toBe(true);
    expect(result.totals).toEqual({
      jobs: 900,
      bytesBilled: 5_000_000,
      slotMs: 70_000,
    });
    expect(result.message).toMatch(/Listing 1 of 240 model-days/);
    expect(result.region).toBe("eu");
    expect(result.regionSource).toBe("dataset");
    expect(tools.dbt_model_cost.description).toMatch(
      /most expensive first \(bytes billed, then slot milliseconds\)/,
    );
    expect(tools.dbt_model_cost.description).toMatch(
      /`totals` and `totalRows` cover the WHOLE window/,
    );
  });

  // Review B10.
  it("hands the turn's abort signal to the service", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    modelCostMock.mockResolvedValue({
      supported: true,
      scope: "project",
      days: 7,
      rows: [],
      totalRows: 0,
      totals: { jobs: 0, bytesBilled: 0, slotMs: 0 },
      truncated: false,
    });
    const controller = new AbortController();
    await run<object, IntrospectionResult>(
      tools.dbt_model_cost,
      { projectId: project._id.toString() },
      { abortSignal: controller.signal },
    );
    expect(modelCostMock.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it("says the answer is partial on the fallback scope and quotes the grant", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    modelCostMock.mockResolvedValue({
      supported: true,
      scope: "user",
      days: 30,
      warning: GRANT_WARNING,
      rows: [],
      totalRows: 0,
      totals: { jobs: 0, bytesBilled: 0, slotMs: 0 },
      truncated: false,
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_model_cost,
      {
        projectId: project._id.toString(),
      },
    );
    expect(result.scope).toBe("user");
    expect(result.warning).toBe(GRANT_WARNING);
    expect(result.message).toMatch(
      /^PARTIAL: covers only jobs run by this connection's own account/,
    );
    expect(result.message).toContain(GRANT_WARNING);
    expect(result.message).toMatch(/No warehouse job matched/);
  });

  it("narrows to one model and returns notes, invocations and avgDurationMs", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    const row = {
      day: "2026-01-14",
      nodeId: "model.analytics.fct_orders",
      jobs: 4,
      bytesBilled: 2048,
      slotMs: 80,
      invocations: 2,
      avgDurationMs: 1500,
    };
    modelCostMock.mockResolvedValue({
      supported: true,
      scope: "project",
      days: 7,
      notes: ["Only the 1000 most recent runs of the window are matched."],
      rows: [row],
      totalRows: 1,
      totals: { jobs: 4, bytesBilled: 2048, slotMs: 80 },
      truncated: false,
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_model_cost,
      { projectId: project._id.toString(), model: "fct_orders" },
    );
    expect(modelCostMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "fct_orders" }),
    );
    expect(result.model).toBe("fct_orders");
    expect(result.notes).toEqual([
      "Only the 1000 most recent runs of the window are matched.",
    ]);
    expect(result.rows).toEqual([row]);
  });

  it("accepts a unique_id or a bare name as `model`, nothing that breaks out of a literal", () => {
    const { dbt_model_cost: tool } = createDbtServerTools(WS, "u1");
    expect(
      accepts(tool, { projectId: "p", model: "model.analytics.fct_orders" }),
    ).toBe(true);
    expect(accepts(tool, { projectId: "p", model: "fct_orders" })).toBe(true);
    expect(accepts(tool, { projectId: "p", model: "fct_orders' or 1=1" })).toBe(
      false,
    );
    expect(accepts(tool, { projectId: "p", model: "" })).toBe(false);
  });

  it("maps a failed warehouse query to a tool error", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    modelCostMock.mockRejectedValue(new Error("Access Denied: 403"));
    const result = await run<object, IntrospectionResult>(
      tools.dbt_model_cost,
      {
        projectId: project._id.toString(),
      },
    );
    expect(result).toEqual({ success: false, error: "Access Denied: 403" });
  });

  it("refuses malformed ids before touching the warehouse", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    const result = await run<object, IntrospectionResult>(
      tools.dbt_model_cost,
      {
        projectId: project._id.toString(),
        runId: "nope",
      },
    );
    expect(result).toEqual({ success: false, error: "Invalid run id" });
    expect(modelCostMock).not.toHaveBeenCalled();
  });

  it("validates its input: days 1..30, limit 1..500", () => {
    const { dbt_model_cost: tool } = createDbtServerTools(WS, "u1");
    expect(accepts(tool, { projectId: "p" })).toBe(true);
    expect(accepts(tool, { projectId: "p", days: 30, limit: 500 })).toBe(true);
    expect(accepts(tool, { projectId: "p", days: 31 })).toBe(false);
    expect(accepts(tool, { projectId: "p", days: 0 })).toBe(false);
    expect(accepts(tool, { projectId: "p", limit: 501 })).toBe(false);
  });
});

describe("dbt_table_readers", () => {
  const relation = { schema: "dbt_prod", name: "fct_orders" };

  it("answers an unsupported engine with its reason", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    tableReadersMock.mockResolvedValue({
      supported: false,
      reason: "clickhouse has no job history.",
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_table_readers,
      { projectId: project._id.toString(), relation },
    );
    expect(result).toEqual({
      success: true,
      supported: false,
      message:
        "Table readers are not available: clickhouse has no job history.",
    });
  });

  it("warns that an empty fallback answer does not prove the table is unused", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    tableReadersMock.mockResolvedValue({
      supported: true,
      scope: "user",
      days: 7,
      warning: GRANT_WARNING,
      rows: [],
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_table_readers,
      {
        projectId: project._id.toString(),
        relation: { database: "analytics-prod", ...relation },
      },
    );
    expect(tableReadersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        relation: { database: "analytics-prod", ...relation },
      }),
    );
    expect(result.relation).toBe("analytics-prod.dbt_prod.fct_orders");
    expect(result.scope).toBe("user");
    expect(result.message).toMatch(/^PARTIAL/);
    expect(result.message).toMatch(/NOT included/);
    expect(result.message).toContain(GRANT_WARNING);
    expect(result.rowCount).toBe(0);
  });

  it("returns reader groups on the project scope", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    tableReadersMock.mockResolvedValue({
      supported: true,
      scope: "project",
      days: 7,
      rows: [
        {
          makoSource: "binding",
          makoApp: "sales-dashboard",
          userEmail: "runner@example.iam.gserviceaccount.com",
          jobs: 12,
          bytesBilled: 4096,
          lastReadAt: "2026-01-14T08:00:00.000Z",
        },
      ],
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_table_readers,
      { projectId: project._id.toString(), relation },
    );
    expect(result.rowCount).toBe(1);
    expect(result.message).not.toMatch(/PARTIAL/);
  });

  // Review B1. With no location on the connection the tool read region-us,
  // found 0 rows for a table in the EU and answered "No job in that scope
  // read X" on the project scope: the answer a user trusts before a drop.
  it("never presents an empty answer from a guessed region as a finding", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    const guessWarning =
      "The region of the job history is a guess (us): the location of " +
      "dbt_prod could not be read and the connection sets no location.";
    tableReadersMock.mockResolvedValue({
      supported: true,
      scope: "project",
      days: 7,
      region: "us",
      regionSource: "default",
      warning: guessWarning,
      rows: [],
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_table_readers,
      { projectId: project._id.toString(), relation },
    );
    expect(result.scope).toBe("project");
    expect(result.region).toBe("us");
    expect(result.regionSource).toBe("default");
    expect(result.conclusive).toBe(false);
    expect(result.warning).toBe(guessWarning);
    expect(result.message).not.toMatch(/No job in that scope read/);
    expect(result.message).toMatch(/UNVERIFIED REGION/);
    expect(result.message).toMatch(/NOT evidence that nothing ran/);

    // The region read from the dataset: the same empty answer is a finding.
    tableReadersMock.mockResolvedValue({
      supported: true,
      scope: "project",
      days: 7,
      region: "eu",
      regionSource: "dataset",
      rows: [],
    });
    const known = await run<object, IntrospectionResult>(
      tools.dbt_table_readers,
      { projectId: project._id.toString(), relation },
    );
    expect(known.conclusive).toBe(true);
    expect(known.message).toBe(
      "Covers every job of the warehouse project in region eu over the " +
        "last 7 days. No job in that scope read dbt_prod.fct_orders.",
    );

    // One account only: never conclusive, whatever the region.
    tableReadersMock.mockResolvedValue({
      supported: true,
      scope: "user",
      days: 7,
      region: "eu",
      regionSource: "dataset",
      warning: GRANT_WARNING,
      rows: [],
    });
    const partial = await run<object, IntrospectionResult>(
      tools.dbt_table_readers,
      { projectId: project._id.toString(), relation },
    );
    expect(partial.conclusive).toBe(false);
    expect(tools.dbt_table_readers.description).toMatch(
      /Never tell the user a table is unused when `conclusive` is false/,
    );
  });

  // Review B10.
  it("hands the turn's abort signal to the service", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    tableReadersMock.mockResolvedValue({
      supported: true,
      scope: "project",
      days: 7,
      rows: [],
    });
    const controller = new AbortController();
    await run<object, IntrospectionResult>(
      tools.dbt_table_readers,
      { projectId: project._id.toString(), relation },
      { abortSignal: controller.signal },
    );
    expect(tableReadersMock.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it("returns notes, the warning and the text-only match count", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    const notes = [
      "If this relation is a view, a read through another view is invisible.",
    ];
    tableReadersMock.mockResolvedValue({
      supported: true,
      scope: "user",
      days: 7,
      warning: GRANT_WARNING,
      notes,
      rows: [
        {
          makoSource: "dbt",
          userEmail: "runner@example.iam.gserviceaccount.com",
          jobs: 5,
          bytesBilled: 100,
          lastReadAt: "2026-01-14T08:00:00.000Z",
          jobsByTextOnly: 3,
        },
        {
          userEmail: "analyst@example.com",
          jobs: 2,
          bytesBilled: 50,
          lastReadAt: "2026-01-13T08:00:00.000Z",
        },
      ],
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_table_readers,
      { projectId: project._id.toString(), relation },
    );
    expect(result.scope).toBe("user");
    expect(result.warning).toBe(GRANT_WARNING);
    expect(result.notes).toEqual(notes);
    expect(result.jobsByTextOnly).toBe(3);
    expect(result.rows).toHaveLength(2);
  });

  it("says in its description that reads through a downstream view are invisible", () => {
    const { dbt_table_readers: tool } = createDbtServerTools(WS, "u1");
    expect(tool.description).toMatch(
      /read THROUGH a downstream view is invisible/,
    );
  });

  it("validates its input: a relation with safe identifier parts", () => {
    const { dbt_table_readers: tool } = createDbtServerTools(WS, "u1");
    expect(accepts(tool, { projectId: "p", relation })).toBe(true);
    expect(
      accepts(tool, {
        projectId: "p",
        relation: { database: "my-project", ...relation },
      }),
    ).toBe(true);
    expect(accepts(tool, { projectId: "p" })).toBe(false);
    expect(accepts(tool, { projectId: "p", relation: { name: "t" } })).toBe(
      false,
    );
    expect(
      accepts(tool, {
        projectId: "p",
        relation: { schema: "dbt_prod", name: "t`; drop table x" },
      }),
    ).toBe(false);
    expect(
      accepts(tool, {
        projectId: "p",
        relation: { schema: "a b", name: "t" },
      }),
    ).toBe(false);
    expect(accepts(tool, { projectId: "p", relation, days: 90 })).toBe(false);
    // Review A6: legal BigQuery names. A domain-scoped project; table names
    // with a hyphen, a space and Unicode letters.
    for (const name of ["daily-orders", "order lines 2026", "commandes_été"]) {
      expect(
        accepts(tool, {
          projectId: "p",
          relation: {
            database: "example.com:my-project",
            schema: "dbt_prod",
            name,
          },
        }),
      ).toBe(true);
    }
    for (const name of ["t\\", "t'", 't"', "t\n", "t\u0000", ""]) {
      expect(
        accepts(tool, {
          projectId: "p",
          relation: { schema: "dbt_prod", name },
        }),
      ).toBe(false);
    }
  });
});

describe("dbt_list_orphans", () => {
  const relationOf = (name: string, sizeBytes: number) => ({
    schema: "dbt_prod",
    name,
    type: "table" as const,
    sizeBytes,
  });

  it("answers a project with no manifest with the reason", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    orphansMock.mockResolvedValue({
      supported: false,
      reason: "No successful run has produced a manifest for prod yet.",
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_list_orphans,
      { projectId: project._id.toString() },
    );
    expect(result).toEqual({
      success: true,
      supported: false,
      message:
        "Orphan listing is not available: No successful run has produced a " +
        "manifest for prod yet.",
    });
  });

  // Review B7. The tool counted and summed the list the service had cut to
  // 1,000 and re-sorted it by size. The service now counts everything and
  // cuts in its own order; the tool reports both as given.
  it("reports the service's true totals and its listed subset, unchanged", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    orphansMock.mockResolvedValue({
      supported: true,
      environment: "prod",
      manifestRunId: "run-1",
      manifestGeneratedAt: "2026-01-14T02:00:00.000Z",
      schemasScanned: ["dbt_prod"],
      expectedCount: 120,
      // 1,500 orphans exist; the service listed 2 of them.
      orphanCount: 1500,
      orphanBytes: 9_000_000,
      confidenceCounts: { high: 700, medium: 300, low: 500 },
      truncated: true,
      orphans: [
        { ...relationOf("small_sure", 10), confidence: "high", reasons: [] },
        {
          ...relationOf("big_unsure", 3000),
          confidence: "low",
          reasons: ["written_after_manifest"],
        },
      ],
    });
    const controller = new AbortController();
    const result = await run<object, IntrospectionResult>(
      tools.dbt_list_orphans,
      { projectId: project._id.toString(), environment: "prod", limit: 2 },
      { abortSignal: controller.signal },
    );
    // The limit and the abort signal (review B10) reach the service.
    expect(orphansMock).toHaveBeenCalledWith({
      workspaceId: WS,
      projectId: project._id.toString(),
      environment: "prod",
      limit: 2,
      signal: controller.signal,
    });
    expect(result.orphanCount).toBe(1500);
    expect(result.orphanBytes).toBe(9_000_000);
    expect(result.confidenceCounts).toEqual({
      high: 700,
      medium: 300,
      low: 500,
    });
    // The service's order stands: confidence first, not size.
    expect(result.orphans?.map(orphan => orphan.name)).toEqual([
      "small_sure",
      "big_unsure",
    ]);
    expect(result.truncated).toBe(true);
    expect(result.listed).toBe(2);
    expect(result.message).toMatch(/^1500 relation\(s\)/);
    expect(result.message).toMatch(/Nothing was dropped/);
    expect(tools.dbt_list_orphans.description).toMatch(
      /ordered by confidence \(high first\), then size/,
    );
  });

  it("asks the service for the default number of orphans", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    orphansMock.mockResolvedValue({
      supported: true,
      environment: "prod",
      schemasScanned: ["dbt_prod"],
      expectedCount: 1,
      orphanCount: 0,
      orphanBytes: 0,
      confidenceCounts: { high: 0, medium: 0, low: 0 },
      truncated: false,
      orphans: [],
    });
    await run<object, IntrospectionResult>(tools.dbt_list_orphans, {
      projectId: project._id.toString(),
    });
    expect(orphansMock.mock.calls[0][0].limit).toBe(200);
  });

  it("returns confidence, reasons and the manifest's age and limits", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    orphansMock.mockResolvedValue({
      supported: true,
      environment: "prod",
      manifestRunId: "run-1",
      manifestGeneratedAt: "2026-01-01T02:00:00.000Z",
      manifestAgeHours: 320,
      stale: true,
      warnings: ["The manifest is 320 hours old."],
      schemasScanned: ["dbt_prod"],
      schemasMissing: ["dbt_prod_staging"],
      expectedCount: 40,
      relationsScanned: 44,
      skipped: { sources: 2, testFailureTables: 1 },
      orphanCount: 2,
      orphanBytes: 950,
      confidenceCounts: { high: 1, medium: 0, low: 1 },
      truncated: false,
      orphans: [
        { ...relationOf("old_orders", 900), confidence: "high", reasons: [] },
        {
          ...relationOf("fct_orders__dbt_tmp", 50),
          confidence: "low",
          reasons: ["dbt_temporary_relation", "stale_manifest"],
        },
      ],
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_list_orphans,
      { projectId: project._id.toString() },
    );
    expect(result.manifestAgeHours).toBe(320);
    expect(result.stale).toBe(true);
    expect(result.warnings).toEqual(["The manifest is 320 hours old."]);
    expect(result.schemasMissing).toEqual(["dbt_prod_staging"]);
    expect(result.skipped).toEqual({ sources: 2, testFailureTables: 1 });
    expect(result.confidenceCounts).toEqual({ high: 1, medium: 0, low: 1 });
    expect(result.orphans).toEqual([
      expect.objectContaining({
        name: "old_orders",
        confidence: "high",
        reasons: [],
      }),
      expect.objectContaining({
        name: "fct_orders__dbt_tmp",
        confidence: "low",
        reasons: ["dbt_temporary_relation", "stale_manifest"],
      }),
    ]);
    expect(result.message).toMatch(/Nothing was dropped/);
    expect(result.message).toMatch(/manifest is stale/);
  });

  it("says in its description that it drops nothing and skips schemas with no remaining model", () => {
    const { dbt_list_orphans: tool } = createDbtServerTools(WS, "u1");
    expect(tool.description).toMatch(/drops nothing/);
    expect(tool.description).toMatch(
      /schema with no remaining model is skipped/,
    );
  });

  it("says so when nothing is orphaned", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    orphansMock.mockResolvedValue({
      supported: true,
      environment: "prod",
      schemasScanned: ["dbt_prod"],
      expectedCount: 12,
      orphanCount: 0,
      orphanBytes: 0,
      confidenceCounts: { high: 0, medium: 0, low: 0 },
      truncated: false,
      orphans: [],
    });
    const result = await run<object, IntrospectionResult>(
      tools.dbt_list_orphans,
      { projectId: project._id.toString() },
    );
    expect(result.orphanCount).toBe(0);
    expect(result.message).toBe("No orphan relation in the scanned schemas.");
    expect(result).not.toHaveProperty("truncated");
  });

  it("maps a failed warehouse listing to a tool error", async () => {
    const tools = createDbtServerTools(WS, "u1");
    const { project } = await seed();
    orphansMock.mockRejectedValue(new Error("Dataset not found"));
    const result = await run<object, IntrospectionResult>(
      tools.dbt_list_orphans,
      { projectId: project._id.toString() },
    );
    expect(result).toEqual({ success: false, error: "Dataset not found" });
  });
});
