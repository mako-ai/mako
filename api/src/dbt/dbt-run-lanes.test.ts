/**
 * dbt run lanes: a project runs one dbt invocation at a time per lane.
 * Scheduled runs of a job whose median successful run is under 5 min (over
 * at least 5 of its last 20) use the "fast" lane. Everything else uses
 * "default". Real Mongoose models against mongodb-memory-server; only
 * Inngest is mocked.
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
import {
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";

vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })) },
}));

import { inngest } from "../inngest/client";
import {
  DbtJob,
  DbtProject,
  DbtRun,
  type DbtRunLane,
} from "../database/workspace-schema";
import {
  FAST_LANE_TTL_MS,
  chooseRunLane,
  dbtRunFallbackQueueKeys,
  dbtRunQueueKeys,
  describeQueuedRun,
  laneForDurations,
  resolveJobLane,
} from "./dbt-run-queue";
import {
  promotesProdManifest,
  reconcileStaleQueuedRun,
  triggerDbtJobRun,
  triggerDbtRun,
} from "./dbt-run.service";
import { dirFor } from "./workspace-dir.service";

const sendMock = inngest.send as unknown as ReturnType<typeof vi.fn>;
const MIN = 60_000;
const WS = new Types.ObjectId();

let mongo: MongoMemoryServer;
let pg: PgTestDb;

beforeAll(async () => {
  pg = await setupPgTestDb();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await pg?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    pg.reset(),
    DbtProject.deleteMany({}),
    DbtRun.deleteMany({}),
    DbtJob.deleteMany({}),
  ]);
  await ensureTestWorkspace(pg.db, { id: String(WS) });
});

async function seedProject() {
  return DbtProject.create({
    workspaceId: WS,
    name: `p-${new Types.ObjectId().toString()}`,
    environments: [
      {
        name: "prod",
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_prod",
        threads: 4,
      },
    ],
    defaultEnvironment: "prod",
    createdBy: "u1",
  });
}

async function seedJob(projectId: Types.ObjectId) {
  return DbtJob.create({
    workspaceId: WS,
    projectId,
    name: `job-${new Types.ObjectId().toString()}`,
    environment: "prod",
    commands: ["build --select staging"],
    createdBy: "u1",
  });
}

/** Successful past runs of a job, one per duration. */
async function seedHistory(
  job: { _id: Types.ObjectId; projectId: Types.ObjectId },
  durationsMs: number[],
) {
  await DbtRun.insertMany(
    durationsMs.map((durationMs, i) => ({
      workspaceId: WS,
      projectId: job.projectId,
      jobId: job._id,
      environment: "prod",
      commands: ["build"],
      status: "success",
      trigger: "schedule",
      triggeredBy: "scheduler",
      actor: { kind: "user" as const, userId: "u1" },
      durationMs,
      createdAt: new Date(Date.now() - (i + 1) * 3600e3),
    })),
  );
}

describe("laneForDurations", () => {
  it("is fast with 5 runs and a median under 5 min", () => {
    expect(laneForDurations([2, 2, 2, 2, 2].map(m => m * MIN))).toEqual({
      lane: "fast",
      medianMs: 2 * MIN,
    });
  });

  it("is default with a median at or over 5 min", () => {
    expect(laneForDurations([5, 5, 5, 5, 5].map(m => m * MIN)).lane).toBe(
      "default",
    );
    expect(laneForDurations([1, 1, 9, 9, 9].map(m => m * MIN)).lane).toBe(
      "default",
    );
  });

  it("is default with fewer than 5 runs", () => {
    expect(laneForDurations([1, 1, 1, 1].map(m => m * MIN)).lane).toBe(
      "default",
    );
    expect(laneForDurations([])).toEqual({ lane: "default" });
  });
});

describe("resolveJobLane and chooseRunLane", () => {
  it("puts a scheduled run of a short job in the fast lane and caches it", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    await seedHistory(job, [108_000, 95_000, 120_000, 100_000, 110_000]);

    expect(await chooseRunLane({ trigger: "schedule", jobId: job._id })).toBe(
      "fast",
    );
    const stored = await DbtJob.findById(job._id).lean();
    expect(stored?.lane).toBe("fast");
    expect(stored?.laneMedianMs).toBe(108_000);
    expect(stored?.laneEvaluatedAt).toBeInstanceOf(Date);
  });

  it("keeps a long job in the default lane", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    await seedHistory(
      job,
      [40, 38, 41, 39, 42].map(m => m * MIN),
    );
    expect(await chooseRunLane({ trigger: "schedule", jobId: job._id })).toBe(
      "default",
    );
  });

  it("keeps a job with 4 successful runs in the default lane", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    await seedHistory(
      job,
      [1, 1, 1, 1].map(m => m * MIN),
    );
    expect(await resolveJobLane(job._id)).toBe("default");
  });

  it("samples only the last 20 successful runs", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    // 20 newest are 1 min; 30 older ones are 40 min.
    await seedHistory(job, [
      ...Array(20).fill(1 * MIN),
      ...Array(30).fill(40 * MIN),
    ]);
    expect(await resolveJobLane(job._id)).toBe("fast");
  });

  it("keeps manual, agent and job-less scheduled runs in the default lane", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    await seedHistory(
      job,
      [1, 1, 1, 1, 1].map(m => m * MIN),
    );
    expect(await chooseRunLane({ trigger: "manual", jobId: job._id })).toBe(
      "default",
    );
    expect(await chooseRunLane({ trigger: "agent", jobId: job._id })).toBe(
      "default",
    );
    // Pre-deploy builds (apps/dbt-before-deploy.ts): "schedule", no job.
    expect(await chooseRunLane({ trigger: "schedule" })).toBe("default");
  });

  it("serves the cache for 24 h, then recomputes", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    await seedHistory(
      job,
      [1, 1, 1, 1, 1].map(m => m * MIN),
    );
    const t0 = new Date();
    expect(await resolveJobLane(job._id, t0)).toBe("fast");

    // The job got slow: 20 newer 30-minute runs.
    await DbtRun.insertMany(
      Array.from({ length: 20 }, () => ({
        workspaceId: WS,
        projectId: project._id,
        jobId: job._id,
        environment: "prod",
        commands: ["build"],
        status: "success",
        trigger: "schedule",
        triggeredBy: "scheduler",
        actor: { kind: "user" as const, userId: "u1" },
        durationMs: 30 * MIN,
        createdAt: new Date(t0.getTime() + 60_000),
      })),
    );

    const fresh = new Date(t0.getTime() + FAST_LANE_TTL_MS - 1);
    expect(await resolveJobLane(job._id, fresh)).toBe("fast");

    const stale = new Date(t0.getTime() + FAST_LANE_TTL_MS + 1);
    expect(await resolveJobLane(job._id, stale)).toBe("default");
    const stored = await DbtJob.findById(job._id).lean();
    expect(stored?.lane).toBe("default");
    expect(stored?.laneMedianMs).toBe(30 * MIN);
    expect(stored?.laneEvaluatedAt?.getTime()).toBe(stale.getTime());
  });
});

describe("dbt/run.requested payload", () => {
  it("a scheduled short job carries the fast lane key and its job key", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    await seedHistory(
      job,
      [1, 1, 1, 1, 1].map(m => m * MIN),
    );

    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "schedule",
      triggeredBy: "scheduler",
      actor: { kind: "user" as const, userId: "u1" },
    });

    expect(run.lane).toBe("fast");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({
      name: "dbt/run.requested",
      data: {
        laneKey: `${project._id.toString()}:fast`,
        jobKey: `job:${job._id.toString()}`,
      },
    });
  });

  it("a manual run of the same job carries the default lane key", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    await seedHistory(
      job,
      [1, 1, 1, 1, 1].map(m => m * MIN),
    );

    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "manual",
      triggeredBy: "u1",
      actor: { kind: "user" as const, userId: "u1" },
    });

    expect(run.lane).toBe("default");
    expect(sendMock.mock.calls[0][0].data).toMatchObject({
      laneKey: `${project._id.toString()}:default`,
      jobKey: `job:${job._id.toString()}`,
    });
  });

  it("a run without a job locks only itself", async () => {
    const project = await seedProject();
    const run = await triggerDbtRun({
      workspaceId: WS.toString(),
      projectId: project._id.toString(),
      environment: "prod",
      commands: ["build --select stg_orders"],
      trigger: "schedule",
      triggeredBy: "apps-deploy-on-push",
      actor: { kind: "user" as const, userId: "u1" },
    });

    expect(run.lane).toBe("default");
    expect(sendMock.mock.calls[0][0].data).toMatchObject({
      laneKey: `${project._id.toString()}:default`,
      jobKey: `run:${run._id.toString()}`,
    });
  });
});

describe("events sent before lanes", () => {
  it("fall back to the default lane", () => {
    expect(dbtRunFallbackQueueKeys({ projectId: "p1", runId: "r1" })).toEqual({
      laneKey: "p1:default",
      jobKey: "run:r1",
    });
    expect(
      dbtRunFallbackQueueKeys({ projectId: "p1", runId: "r1", jobId: "j1" }),
    ).toEqual({ laneKey: "p1:default", jobKey: "job:j1" });
  });

  it("leave an event with both keys alone", () => {
    expect(
      dbtRunFallbackQueueKeys({
        projectId: "p1",
        runId: "r1",
        ...dbtRunQueueKeys({ projectId: "p1", runId: "r1", lane: "fast" }),
      }),
    ).toBeNull();
  });
});

describe("fast lane isolation", () => {
  const scope = {
    workspaceId: "w",
    projectId: "p",
    environment: "prod",
    role: "run" as const,
  };

  it("builds in its own warm dir", () => {
    expect(dirFor(scope).endsWith("/prod__run")).toBe(true);
    expect(dirFor({ ...scope, lane: "default" })).toBe(dirFor(scope));
    expect(
      dirFor({ ...scope, lane: "fast" }).endsWith("/prod__run__fast"),
    ).toBe(true);
  });

  it("never promotes the prod manifest", () => {
    const committedMain = {
      gitBranch: undefined,
      workingTreeUserId: undefined,
      localOverlay: undefined,
    };
    expect(promotesProdManifest(committedMain, true)).toBe(true);
    expect(
      promotesProdManifest({ ...committedMain, lane: "default" }, true),
    ).toBe(true);
    expect(promotesProdManifest({ ...committedMain, lane: "fast" }, true)).toBe(
      false,
    );
  });
});

async function seedRun(
  projectId: Types.ObjectId,
  status: "queued" | "running",
  extra: {
    lane?: DbtRunLane;
    jobId?: Types.ObjectId;
    createdAt?: Date;
    startedAt?: Date;
  } = {},
) {
  return DbtRun.create({
    workspaceId: WS,
    projectId,
    environment: "prod",
    commands: ["build"],
    status,
    trigger: extra.jobId ? "schedule" : "manual",
    triggeredBy: "u1",
    actor: { kind: "user" as const, userId: "u1" },
    ...extra,
  });
}

describe("reconcileStaleQueuedRun counts only its own lane", () => {
  const stale = () => new Date(Date.now() - 60 * MIN);

  it("fails a stale ad-hoc run when only the fast lane is busy", async () => {
    const project = await seedProject();
    await seedRun(project._id, "running", {
      lane: "fast",
      startedAt: new Date(),
    });
    const queued = await seedRun(project._id, "queued", {
      createdAt: stale(),
    });

    const out = await reconcileStaleQueuedRun(queued.toObject(), {
      persist: false,
    });
    expect(out.status).toBe("error");
  });

  it("leaves it queued behind a default-lane run, old runs without a lane included", async () => {
    const project = await seedProject();
    // A run that predates lanes (no `lane`) ran in the default lane.
    await seedRun(project._id, "running", { startedAt: new Date() });
    const queued = await seedRun(project._id, "queued", {
      lane: "default",
      createdAt: stale(),
    });

    const out = await reconcileStaleQueuedRun(queued.toObject(), {
      persist: false,
    });
    expect(out.status).toBe("queued");
  });
});

describe("describeQueuedRun counts only its own lane", () => {
  it("a default-lane run ignores fast-lane runs", async () => {
    const project = await seedProject();
    const t = Date.now();
    await seedRun(project._id, "running", {
      lane: "fast",
      startedAt: new Date(t - 2 * MIN),
    });
    await seedRun(project._id, "queued", {
      lane: "fast",
      createdAt: new Date(t - 1 * MIN),
    });
    const queued = await seedRun(project._id, "queued", {
      lane: "default",
      createdAt: new Date(t),
    });

    const info = await describeQueuedRun(queued.toObject());
    expect(info?.lane).toBe("default");
    expect(info?.blockedBy).toBeNull();
    expect(info?.runsAhead).toBe(0);
    expect(info?.reason).toContain("default lane");
  });

  it("a fast-lane run waits only behind fast-lane runs", async () => {
    const project = await seedProject();
    const t = Date.now();
    // A 40-minute nightly build in the default lane.
    await seedRun(project._id, "running", {
      startedAt: new Date(t - 30 * MIN),
    });
    await seedRun(project._id, "queued", {
      createdAt: new Date(t - 5 * MIN),
    });
    const fastRunning = await seedRun(project._id, "running", {
      lane: "fast",
      startedAt: new Date(t - 1 * MIN),
    });
    const queued = await seedRun(project._id, "queued", {
      lane: "fast",
      createdAt: new Date(t),
    });

    const info = await describeQueuedRun(queued.toObject());
    expect(info?.lane).toBe("fast");
    expect(info?.blockedBy?.runId).toBe(fastRunning._id.toString());
    expect(info?.runsAhead).toBe(1);
    expect(info?.queuedAheadCount).toBe(0);
    expect(info?.reason).toContain("fast lane runs one dbt invocation");
  });

  it("a fast-lane job run waits behind its own job in the default lane", async () => {
    const project = await seedProject();
    const job = await seedJob(project._id);
    const manual = await seedRun(project._id, "running", {
      jobId: job._id,
      startedAt: new Date(Date.now() - MIN),
    });
    const queued = await seedRun(project._id, "queued", {
      lane: "fast",
      jobId: job._id,
      createdAt: new Date(),
    });

    const info = await describeQueuedRun(queued.toObject());
    expect(info?.blockedBy?.runId).toBe(manual._id.toString());
  });
});
