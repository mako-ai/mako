/**
 * dbt_get_run against real Mongo: the queue explanation for a run waiting
 * behind the project's single execution slot, and the bounded wait that
 * returns the current status instead of outliving the caller's timeout.
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
  applyJobScheduleChange: vi.fn(),
}));
vi.mock("../../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));

import { createDbtServerTools } from "./dbt-tools";
import { DbtJob, DbtProject, DbtRun } from "../../database/workspace-schema";
import { MCP_MAX_RUN_WAIT_MS } from "../../mcp/mako-mcp-server";

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
});

type Exec<I, O> = (i: I, ctx: { abortSignal?: AbortSignal }) => Promise<O>;
const run = <I, O>(tool: { execute?: unknown }, input: I): Promise<O> =>
  (tool.execute as Exec<I, O>)(input, {});

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
