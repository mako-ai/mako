/**
 * listDbtRuns against real Mongo: filters, the createdAt cursor, the limit
 * clamp, the compact row shape and the per-job skipped-tick counters.
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

vi.mock("./dbt-run.service", () => ({
  reconcileStaleQueuedRuns: vi.fn(async (runs: unknown) => runs),
}));

import {
  clampDbtRunListLimit,
  DBT_RUN_LIST_MAX_LIMIT,
  listDbtRunRows,
  listDbtRuns,
} from "./dbt-run-history";
import { reconcileStaleQueuedRuns } from "./dbt-run.service";

const reconcileMock = vi.mocked(reconcileStaleQueuedRuns);

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const PROJECT = new Types.ObjectId();
const JOB = new Types.ObjectId();
const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);

const runs = () => mongoose.connection.collection("dbt_runs");
const jobs = () => mongoose.connection.collection("dbt_jobs");

/** Insert a run `minutesAgo` before BASE; returns its id. */
async function insertRun(
  minutesAgo: number,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const _id = new Types.ObjectId();
  await runs().insertOne({
    _id,
    workspaceId: WS,
    projectId: PROJECT,
    environment: "prod",
    commands: ["build"],
    status: "success",
    trigger: "schedule",
    triggeredBy: "scheduler",
    logs: [],
    stepResults: [],
    createdAt: new Date(BASE - minutesAgo * 60_000),
    ...fields,
  });
  return _id.toString();
}

const params = (extra: Record<string, unknown> = {}) => ({
  workspaceId: WS.toString(),
  projectId: PROJECT.toString(),
  ...extra,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([runs().deleteMany({}), jobs().deleteMany({})]);
  reconcileMock.mockClear();
});

describe("clampDbtRunListLimit", () => {
  it("clamps to 1..max and falls back on junk", () => {
    expect(clampDbtRunListLimit(undefined)).toBe(20);
    expect(clampDbtRunListLimit(Number.NaN)).toBe(20);
    expect(clampDbtRunListLimit(undefined, 50)).toBe(50);
    expect(clampDbtRunListLimit(0)).toBe(1);
    expect(clampDbtRunListLimit(-5)).toBe(1);
    expect(clampDbtRunListLimit(7.9)).toBe(7);
    expect(clampDbtRunListLimit(100_000)).toBe(DBT_RUN_LIST_MAX_LIMIT);
  });
});

describe("listDbtRuns", () => {
  it("returns newest first, scoped to the workspace and project", async () => {
    const newest = await insertRun(1);
    const older = await insertRun(2);
    await insertRun(0, { projectId: new Types.ObjectId() });
    await insertRun(0, { workspaceId: new Types.ObjectId() });

    const page = await listDbtRuns(params());
    expect(page.runs.map(run => run.runId)).toEqual([newest, older]);
    expect(page.nextBefore).toBeNull();
    expect(page.skipped).toBeUndefined();
  });

  it("filters by job, status and trigger", async () => {
    await insertRun(1, { jobId: JOB, status: "error" });
    await insertRun(2, { jobId: JOB, status: "success" });
    await insertRun(3, { status: "error", trigger: "manual" });
    await insertRun(4, { status: "cancelled", trigger: "agent" });

    expect(
      (await listDbtRuns(params({ jobId: JOB.toString() }))).runs,
    ).toHaveLength(2);
    expect((await listDbtRuns(params({ status: "error" }))).runs).toHaveLength(
      2,
    );
    expect((await listDbtRuns(params({ trigger: "agent" }))).runs).toHaveLength(
      1,
    );
    const both = await listDbtRuns(
      params({ jobId: JOB.toString(), status: "error", trigger: "schedule" }),
    );
    expect(both.runs).toHaveLength(1);
    expect(both.runs[0].status).toBe("error");
  });

  it("pages with the before cursor until nextBefore is null", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertRun(i));

    const first = await listDbtRuns(params({ limit: 2 }));
    expect(first.runs.map(run => run.runId)).toEqual(ids.slice(0, 2));
    expect(first.nextBefore).toBe(new Date(BASE - 60_000).toISOString());

    const second = await listDbtRuns(
      params({ limit: 2, before: new Date(first.nextBefore as string) }),
    );
    expect(second.runs.map(run => run.runId)).toEqual(ids.slice(2, 4));

    const last = await listDbtRuns(
      params({ limit: 2, before: new Date(second.nextBefore as string) }),
    );
    expect(last.runs.map(run => run.runId)).toEqual(ids.slice(4));
    expect(last.nextBefore).toBeNull();
  });

  it("returns null nextBefore when the page is exactly the remainder", async () => {
    await insertRun(1);
    await insertRun(2);
    const page = await listDbtRuns(params({ limit: 2 }));
    expect(page.runs).toHaveLength(2);
    expect(page.nextBefore).toBeNull();
  });

  it("defaults to 20 rows and clamps the limit to 100", async () => {
    await runs().insertMany(
      Array.from({ length: 105 }, (_, i) => ({
        workspaceId: WS,
        projectId: PROJECT,
        environment: "prod",
        commands: ["build"],
        status: "success",
        trigger: "schedule",
        triggeredBy: "scheduler",
        createdAt: new Date(BASE - i * 1000),
      })),
    );
    expect((await listDbtRuns(params())).runs).toHaveLength(20);
    const clamped = await listDbtRuns(params({ limit: 5000 }));
    expect(clamped.runs).toHaveLength(100);
    expect(clamped.nextBefore).not.toBeNull();
    expect((await listDbtRuns(params({ limit: 0 }))).runs).toHaveLength(1);
  });

  it("summarizes a run: counts, timings, a short error, no step bodies", async () => {
    await jobs().insertOne({
      _id: JOB,
      workspaceId: WS,
      projectId: PROJECT,
      name: "Nightly build",
      environment: "prod",
      commands: ["build"],
    });
    const runId = await insertRun(10, {
      jobId: JOB,
      status: "error",
      trigger: "manual",
      commands: ["build --full-refresh"],
      overrides: { vars: { start_date: "2026-01-01" }, fullRefresh: true },
      sourceSha: "a".repeat(40),
      definitionSha: "a".repeat(40),
      lane: "job",
      invocationIds: ["inv-1"],
      startedAt: new Date(BASE - 10 * 60_000 + 4_000),
      completedAt: new Date(BASE - 9 * 60_000),
      durationMs: 56_000,
      error: "x".repeat(900),
      logs: [{ ts: new Date(), level: "error", line: "boom" }],
      stepResults: [
        ...Array.from({ length: 40 }, (_, i) => ({
          uniqueId: `model.a.m${i}`,
          name: `m${i}`,
          resourceType: "model",
          status: "success",
          executionTimeMs: 5,
          message: "OK",
        })),
        {
          uniqueId: "model.a.bad",
          name: "bad",
          resourceType: "model",
          status: "error",
          executionTimeMs: 5,
          message: "boom",
        },
      ],
    });

    const { runs: rows } = await listDbtRuns(params());
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toEqual({
      runId,
      jobId: JOB.toString(),
      jobName: "Nightly build",
      status: "error",
      trigger: "manual",
      environment: "prod",
      commands: ["build --full-refresh"],
      overrides: { vars: { start_date: "2026-01-01" }, fullRefresh: true },
      sourceSha: "a".repeat(40),
      definitionSha: "a".repeat(40),
      lane: "job",
      createdAt: new Date(BASE - 10 * 60_000).toISOString(),
      startedAt: new Date(BASE - 10 * 60_000 + 4_000).toISOString(),
      completedAt: new Date(BASE - 9 * 60_000).toISOString(),
      durationMs: 56_000,
      queuedMs: 4_000,
      error: "x".repeat(300),
      stepCounts: { success: 40, error: 1 },
    });
    expect(row).not.toHaveProperty("stepResults");
    expect(row).not.toHaveProperty("logs");
  });

  it("omits unset optional fields on a plain run", async () => {
    await insertRun(1, { status: "queued" });
    const [row] = (await listDbtRuns(params())).runs;
    expect(Object.keys(row).sort()).toEqual(
      [
        "commands",
        "createdAt",
        "environment",
        "runId",
        "status",
        "stepCounts",
        "trigger",
      ].sort(),
    );
    expect(row.stepCounts).toEqual({});
  });

  it("returns the job's skipped-tick counters when a job is given", async () => {
    const lastSkippedAt = new Date(BASE - 30 * 60_000);
    await jobs().insertOne({
      _id: JOB,
      workspaceId: WS,
      projectId: PROJECT,
      name: "Every 5 minutes",
      environment: "prod",
      commands: ["build"],
      scheduledRun: {
        runCount: 87,
        consecutiveFailures: 0,
        skippedCount: 69,
        lastSkippedAt,
      },
    });
    const page = await listDbtRuns(params({ jobId: JOB.toString() }));
    expect(page.skipped).toEqual({
      count: 69,
      lastAt: lastSkippedAt.toISOString(),
    });
  });

  it("returns why the last tick was skipped, when the job recorded it", async () => {
    const lastSkippedAt = new Date(BASE - 30 * 60_000);
    await jobs().insertOne({
      _id: JOB,
      workspaceId: WS,
      projectId: PROJECT,
      name: "Nightly",
      environment: "prod",
      commands: ["build"],
      scheduledRun: {
        runCount: 3,
        consecutiveFailures: 0,
        skippedCount: 1,
        lastSkippedAt,
        lastSkippedReason: "disabled_in_file",
      },
    });
    const page = await listDbtRuns(params({ jobId: JOB.toString() }));
    expect(page.skipped).toEqual({
      count: 1,
      lastAt: lastSkippedAt.toISOString(),
      lastReason: "disabled_in_file",
    });
  });

  it("names a job only inside the caller's workspace", async () => {
    // A job row with the same id filed under another workspace.
    await jobs().insertOne({
      _id: JOB,
      workspaceId: new Types.ObjectId(),
      projectId: PROJECT,
      name: "Another workspace's job",
      environment: "prod",
      commands: ["build"],
    });
    await insertRun(5, { jobId: JOB });
    const page = await listDbtRuns(params());
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0].jobId).toBe(JOB.toString());
    expect(page.runs[0]).not.toHaveProperty("jobName");
  });

  it("reports zero skipped ticks for a job that never skipped, or is gone", async () => {
    await jobs().insertOne({
      _id: JOB,
      workspaceId: WS,
      projectId: PROJECT,
      name: "Nightly",
      environment: "prod",
      commands: ["build"],
    });
    expect(
      (await listDbtRuns(params({ jobId: JOB.toString() }))).skipped,
    ).toEqual({ count: 0 });
    const gone = new Types.ObjectId().toString();
    expect((await listDbtRuns(params({ jobId: gone }))).skipped).toEqual({
      count: 0,
    });
  });

  it("never reads another workspace's job counters", async () => {
    await jobs().insertOne({
      _id: JOB,
      workspaceId: new Types.ObjectId(),
      projectId: PROJECT,
      name: "Foreign",
      environment: "prod",
      commands: ["build"],
      scheduledRun: { runCount: 1, consecutiveFailures: 0, skippedCount: 9 },
    });
    expect(
      (await listDbtRuns(params({ jobId: JOB.toString() }))).skipped,
    ).toEqual({ count: 0 });
  });

  it("shows a stale queued run the way the run detail does", async () => {
    const runId = await insertRun(1, { status: "queued" });
    reconcileMock.mockImplementationOnce(rows =>
      Promise.resolve(
        rows.map(row => ({
          ...row,
          status: "error",
          error: "Run timed out in queued",
        })),
      ),
    );
    const [row] = (await listDbtRuns(params())).runs;
    expect(row.runId).toBe(runId);
    expect(row.status).toBe("error");
    expect(row.error).toBe("Run timed out in queued");
    expect(reconcileMock).toHaveBeenCalledWith(expect.any(Array), {
      persist: false,
    });
  });

  it("rejects malformed ids and cursors", async () => {
    await expect(listDbtRuns(params({ projectId: "nope" }))).rejects.toThrow(
      "Invalid dbt project id",
    );
    await expect(listDbtRuns(params({ jobId: "nope" }))).rejects.toThrow(
      "Invalid job id",
    );
    await expect(
      listDbtRuns(params({ before: new Date("not a date") })),
    ).rejects.toThrow("Invalid before cursor");
  });
});

describe("listDbtRunRows", () => {
  it("returns whole rows without logs, with the same cursor", async () => {
    const newest = await insertRun(1, {
      logs: [{ ts: new Date(), level: "info", line: "a" }],
      stepResults: [
        {
          uniqueId: "model.a.m",
          name: "m",
          resourceType: "model",
          status: "success",
          executionTimeMs: 5,
        },
      ],
    });
    await insertRun(2);
    const page = await listDbtRunRows(params({ limit: 1 }));
    const [row] = page.runs as Array<Record<string, unknown>>;
    expect(String(row._id)).toBe(newest);
    expect(row.logs).toBeUndefined();
    expect((row.stepResults as Array<{ name: string }>)[0].name).toBe("m");
    expect(page.nextBefore).toBe(new Date(BASE - 60_000).toISOString());
  });

  it("uses the caller's default page size", async () => {
    for (let i = 0; i < 4; i++) await insertRun(i);
    expect(
      (await listDbtRunRows(params(), { defaultLimit: 3 })).runs,
    ).toHaveLength(3);
  });
});
