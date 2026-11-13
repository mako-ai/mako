/**
 * The dbt run queue: slots per project, the two lanes, the per-job lock, the
 * warm directory each run uses, and the explanation of a queued run.
 * `describeQueuedRun` runs against mongodb-memory-server.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { DbtJob, DbtRun } from "../database/workspace-schema";
import {
  DEFAULT_DBT_PROJECT_RUN_CONCURRENCY,
  dbtProjectRunConcurrency,
  dbtRunFallbackQueueKeys,
  dbtRunLane,
  dbtRunLaneFilter,
  dbtRunQueueKeys,
  dbtRunWarmDirOwner,
  describeQueuedRun,
} from "./dbt-run-queue";

describe("dbtProjectRunConcurrency", () => {
  it("defaults to 1: parallel jobs are opt-in", () => {
    expect(DEFAULT_DBT_PROJECT_RUN_CONCURRENCY).toBe(1);
    expect(dbtProjectRunConcurrency(undefined)).toBe(1);
    expect(dbtProjectRunConcurrency("")).toBe(1);
  });

  it("takes a whole number of at least 1", () => {
    expect(dbtProjectRunConcurrency("1")).toBe(1);
    expect(dbtProjectRunConcurrency("3")).toBe(3);
  });

  it("falls back to 1 on anything else, and caps a runaway value", () => {
    for (const bad of ["0", "-2", "1.5", "two", "NaN", "Infinity"]) {
      expect(dbtProjectRunConcurrency(bad)).toBe(1);
    }
    expect(dbtProjectRunConcurrency("500")).toBe(16);
  });
});

describe("dbtRunLane", () => {
  it("is interactive for parse, compile and show from a person or an agent", () => {
    for (const trigger of ["manual", "agent"] as const) {
      for (const subcommands of [
        ["parse"],
        ["compile"],
        ["show"],
        ["compile", "show"],
      ]) {
        expect(dbtRunLane({ trigger, subcommands })).toBe("interactive");
      }
    }
  });

  it("is the job lane as soon as one command builds, tests or lists", () => {
    for (const subcommands of [
      ["build"],
      ["run"],
      ["test"],
      ["seed"],
      ["ls"],
      ["retry"],
      ["compile", "build"],
      [],
    ]) {
      expect(dbtRunLane({ trigger: "agent", subcommands })).toBe("job");
    }
  });

  it("is the job lane for a saved job, a scheduled run and CI, whatever they run", () => {
    expect(
      dbtRunLane({
        jobId: new Types.ObjectId(),
        trigger: "manual",
        subcommands: ["compile"],
      }),
    ).toBe("job");
    expect(dbtRunLane({ trigger: "schedule", subcommands: ["parse"] })).toBe(
      "job",
    );
    expect(dbtRunLane({ trigger: "ci", subcommands: ["compile"] })).toBe("job");
  });
});

describe("dbtRunQueueKeys", () => {
  it("keys the lane on the project and the lock on the job", () => {
    expect(
      dbtRunQueueKeys({
        projectId: "p1",
        runId: "r1",
        jobId: "j1",
        lane: "job",
      }),
    ).toEqual({ laneKey: "p1:job", lockKey: "job:j1" });
  });

  it("gives a run without a job a lock of its own, so it blocks nothing", () => {
    expect(
      dbtRunQueueKeys({ projectId: "p1", runId: "r1", lane: "interactive" }),
    ).toEqual({ laneKey: "p1:interactive", lockKey: "run:r1" });
    expect(
      dbtRunQueueKeys({
        projectId: "p1",
        runId: "r2",
        jobId: null,
        lane: "job",
      }),
    ).toEqual({ laneKey: "p1:job", lockKey: "run:r2" });
  });

  it("two jobs of one project share a lane and never a lock", () => {
    const a = dbtRunQueueKeys({
      projectId: "p1",
      runId: "r1",
      jobId: "j1",
      lane: "job",
    });
    const b = dbtRunQueueKeys({
      projectId: "p1",
      runId: "r2",
      jobId: "j2",
      lane: "job",
    });
    expect(a.laneKey).toBe(b.laneKey);
    expect(a.lockKey).not.toBe(b.lockKey);
  });
});

describe("dbtRunFallbackQueueKeys", () => {
  const event = { projectId: "p1", runId: "r1" };

  it("returns null for an event that carries both keys", () => {
    expect(
      dbtRunFallbackQueueKeys({
        ...event,
        laneKey: "p1:job",
        lockKey: "run:r1",
      }),
    ).toBeNull();
  });

  it("gives a keyless event the keys of its own project and run", () => {
    expect(dbtRunFallbackQueueKeys(event)).toEqual({
      laneKey: "p1:job",
      lockKey: "run:r1",
    });
  });

  it("never gives two projects or two runs the same key", () => {
    const a = dbtRunFallbackQueueKeys({ projectId: "p1", runId: "r1" });
    const b = dbtRunFallbackQueueKeys({ projectId: "p2", runId: "r2" });
    expect(a?.laneKey).not.toBe(b?.laneKey);
    expect(a?.lockKey).not.toBe(b?.lockKey);
  });

  it("locks a job run on its job, from the event or from the run row", () => {
    expect(dbtRunFallbackQueueKeys({ ...event, jobId: "j1" })?.lockKey).toBe(
      "job:j1",
    );
    const jobId = new Types.ObjectId();
    expect(dbtRunFallbackQueueKeys(event, { jobId })?.lockKey).toBe(
      `job:${jobId.toString()}`,
    );
  });

  it("uses the run's lane when it has one, the job lane otherwise", () => {
    expect(
      dbtRunFallbackQueueKeys(event, { lane: "interactive" })?.laneKey,
    ).toBe("p1:interactive");
    expect(dbtRunFallbackQueueKeys(event, {})?.laneKey).toBe("p1:job");
  });

  it("keeps a key the event does carry", () => {
    expect(
      dbtRunFallbackQueueKeys({ ...event, laneKey: "p1:interactive" }),
    ).toEqual({ laneKey: "p1:interactive", lockKey: "run:r1" });
  });

  it("treats an empty key as absent", () => {
    expect(
      dbtRunFallbackQueueKeys({ ...event, laneKey: "", lockKey: "" }),
    ).toEqual({ laneKey: "p1:job", lockKey: "run:r1" });
  });
});

describe("dbtRunLaneFilter", () => {
  it("counts runs from before lanes existed as the job lane", () => {
    expect(dbtRunLaneFilter("interactive")).toEqual({ lane: "interactive" });
    expect(dbtRunLaneFilter("job")).toEqual({ lane: { $ne: "interactive" } });
  });
});

describe("dbtRunWarmDirOwner", () => {
  const jobRun = {
    runId: "r1",
    lane: "job" as const,
    jobId: "j1",
    triggeredBy: "scheduler",
  };

  it("at 1 slot, job runs keep the shared deploy directory (unchanged)", () => {
    expect(dbtRunWarmDirOwner(jobRun, 1)).toBeUndefined();
    expect(
      dbtRunWarmDirOwner({ runId: "r1", lane: "job", triggeredBy: "u1" }, 1),
    ).toBeUndefined();
  });

  it("at 1 slot, working-tree and laptop builds keep their per-user directory", () => {
    expect(
      dbtRunWarmDirOwner(
        {
          runId: "r1",
          lane: "job",
          workingTreeUserId: "u1",
          triggeredBy: "agent",
        },
        1,
      ),
    ).toBe("u1");
    expect(
      dbtRunWarmDirOwner(
        {
          runId: "r1",
          lane: "job",
          localOverlayKey: "overlay/k",
          triggeredBy: "u2",
        },
        1,
      ),
    ).toBe("local:u2");
  });

  it("at 1 slot, an interactive run has its own warm directory, apart from any build", () => {
    expect(
      dbtRunWarmDirOwner(
        {
          runId: "r1",
          lane: "interactive",
          workingTreeUserId: "u1",
          triggeredBy: "agent",
        },
        1,
      ),
    ).toBe("interactive:u1");
    expect(
      dbtRunWarmDirOwner(
        { runId: "r1", lane: "interactive", triggeredBy: "u1" },
        1,
      ),
    ).toBe("interactive");
  });

  it("above 1 slot, each job gets its own directory", () => {
    expect(dbtRunWarmDirOwner(jobRun, 2)).toBe("job:j1");
    expect(dbtRunWarmDirOwner({ ...jobRun, jobId: "j2" }, 2)).toBe("job:j2");
    // Two runs of one job never overlap (the job lock): one warm dir.
    expect(dbtRunWarmDirOwner({ ...jobRun, runId: "r2" }, 2)).toBe("job:j1");
  });

  // Review A3. With 2 slots these pairs can execute at once. Each pair got
  // one directory, so the second run waited on its mutex inside a step.
  describe("above 1 slot, two runs that can execute at once never share a directory", () => {
    const pairs: Array<
      [string, Omit<Parameters<typeof dbtRunWarmDirOwner>[0], "runId">]
    > = [
      [
        "two agent validation runs with no working tree",
        { lane: "interactive", triggeredBy: "agent" },
      ],
      [
        "two validation runs of one user's working tree",
        { lane: "interactive", workingTreeUserId: "u1", triggeredBy: "agent" },
      ],
      [
        "a CI run and an ad-hoc build, neither with a job",
        { lane: "job", triggeredBy: "u1" },
      ],
      [
        "two working-tree builds of one user",
        { lane: "job", workingTreeUserId: "u1", triggeredBy: "agent" },
      ],
      [
        "two laptop builds of one user",
        { lane: "job", localOverlayKey: "overlay/k", triggeredBy: "u2" },
      ],
    ];
    for (const [name, run] of pairs) {
      it(name, () => {
        for (const slots of [2, 16]) {
          const first = dbtRunWarmDirOwner({ ...run, runId: "run-a" }, slots);
          const second = dbtRunWarmDirOwner({ ...run, runId: "run-b" }, slots);
          expect(first).toBeDefined();
          expect(second).toBeDefined();
          expect(first).not.toBe(second);
          // Never the committed-deploy directory, and never a job's.
          expect(first).toContain("run:run-a");
          expect(second).toContain("run:run-b");
        }
      });
    }

    it("keeps an interactive run apart from a build of the same run id space", () => {
      expect(
        dbtRunWarmDirOwner(
          { runId: "r1", lane: "interactive", triggeredBy: "agent" },
          2,
        ),
      ).toBe("interactive:run:r1");
      expect(
        dbtRunWarmDirOwner({ runId: "r1", lane: "job", triggeredBy: "u1" }, 2),
      ).toBe("run:r1");
    });

    it("a job run with a tree owner gets a directory per owner and job, never the job's committed one", () => {
      expect(
        dbtRunWarmDirOwner({ ...jobRun, workingTreeUserId: "u1" }, 2),
      ).toBe("u1:job:j1");
      expect(
        dbtRunWarmDirOwner(
          { ...jobRun, jobId: "j2", workingTreeUserId: "u1" },
          2,
        ),
      ).toBe("u1:job:j2");
    });
  });
});

describe("describeQueuedRun", () => {
  let mongo: MongoMemoryServer;
  const WS = new Types.ObjectId();
  const PROJECT = new Types.ObjectId();
  const now = new Date("2026-01-01T12:00:00Z");
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    delete process.env.DBT_PROJECT_RUN_CONCURRENCY;
    await Promise.all([DbtRun.deleteMany({}), DbtJob.deleteMany({})]);
  });

  afterEach(() => {
    delete process.env.DBT_PROJECT_RUN_CONCURRENCY;
  });

  async function seedJob(name: string) {
    return DbtJob.create({
      workspaceId: WS,
      projectId: PROJECT,
      name,
      environment: "prod",
      commands: ["build"],
      createdBy: "u1",
    });
  }

  async function seedRun(fields: Record<string, unknown>) {
    const run = await DbtRun.create({
      workspaceId: WS,
      projectId: PROJECT,
      environment: "prod",
      commands: ["build"],
      trigger: "manual",
      triggeredBy: "u1",
      ...fields,
    });
    // `createdAt` is a timestamp field: set it after the insert.
    if (fields.createdAt) {
      await DbtRun.collection.updateOne(
        { _id: run._id },
        { $set: { createdAt: fields.createdAt } },
      );
    }
    const stored = await DbtRun.findById(run._id).lean();
    if (!stored) throw new Error("run not stored");
    return stored;
  }

  it("returns null for a run that is not queued", async () => {
    const running = await seedRun({ status: "running" });
    expect(await describeQueuedRun(running, now)).toBeNull();
  });

  // Every lookup stays inside the queued run's workspace: a run or a job of
  // another workspace is never named as what holds it back.
  it("never reports a run or a job of another workspace", async () => {
    const otherWorkspace = new Types.ObjectId();
    const foreignJob = await DbtJob.create({
      workspaceId: otherWorkspace,
      projectId: PROJECT,
      name: "Another workspace's job",
      environment: "prod",
      commands: ["build"],
      createdBy: "u2",
    });
    await seedRun({
      workspaceId: otherWorkspace,
      jobId: foreignJob._id,
      status: "running",
      lane: "job",
      startedAt: minutesAgo(5),
    });
    await seedRun({
      workspaceId: otherWorkspace,
      status: "queued",
      lane: "job",
      createdAt: minutesAgo(9),
    });
    const queued = await seedRun({
      status: "queued",
      lane: "job",
      createdAt: minutesAgo(1),
    });

    const info = await describeQueuedRun(queued, now);

    expect(info?.blockedBy).toBeNull();
    expect(info?.runningCount).toBe(0);
    expect(info?.queuedAheadCount).toBe(0);
    expect(info?.reason).not.toContain("Another workspace");
  });

  it("1 slot: a queued build waits behind the running job, with an estimate", async () => {
    const job = await seedJob("Nightly build");
    for (const durationMs of [18 * 60_000, 22 * 60_000]) {
      await seedRun({ jobId: job._id, status: "success", durationMs });
    }
    const blocking = await seedRun({
      jobId: job._id,
      status: "running",
      trigger: "schedule",
      lane: "job",
      startedAt: minutesAgo(5),
    });
    const earlier = await seedRun({
      status: "queued",
      lane: "job",
      createdAt: minutesAgo(3),
    });
    const queued = await seedRun({
      status: "queued",
      lane: "job",
      createdAt: minutesAgo(1),
    });

    const info = await describeQueuedRun(queued, now);

    expect(info).toMatchObject({
      lane: "job",
      slots: 1,
      runningCount: 1,
      runsAhead: 2,
      queuedAheadCount: 1,
      blockingTypicalDurationMs: 20 * 60_000,
    });
    expect(info?.blockedBy?.runId).toBe(blocking._id.toString());
    expect(info?.blockedBy?.jobName).toBe("Nightly build");
    expect(info?.queuedAhead.map(ref => ref.runId)).toEqual([
      earlier._id.toString(),
    ]);
    expect(info?.estimatedStartAt?.getTime()).toBe(
      minutesAgo(5).getTime() + 20 * 60_000,
    );
    expect(info?.reason).toBe(
      `Queued behind run ${blocking._id.toString()} of job "Nightly build", running for 5 min and 1 other queued run. ` +
        "The project runs one job or build at a time; validation runs (parse, compile, show) do not wait here. " +
        "It usually takes 20 min.",
    );
  });

  it("an interactive run does not wait behind a running job", async () => {
    const job = await seedJob("Nightly build");
    await seedRun({
      jobId: job._id,
      status: "running",
      lane: "job",
      startedAt: minutesAgo(30),
    });
    await seedRun({ status: "queued", lane: "job", createdAt: minutesAgo(9) });
    const parse = await seedRun({
      status: "queued",
      lane: "interactive",
      commands: ["parse"],
      createdAt: minutesAgo(1),
    });

    const info = await describeQueuedRun(parse, now);

    expect(info).toMatchObject({
      lane: "interactive",
      runningCount: 0,
      runsAhead: 0,
      blockedBy: null,
      queuedAheadCount: 0,
    });
    expect(info?.reason).toMatch(/^Nothing is ahead of this run/);
  });

  it("a running interactive run does not hold a queued job back", async () => {
    const job = await seedJob("Nightly build");
    await seedRun({
      status: "running",
      lane: "interactive",
      commands: ["show --select stg_orders"],
      startedAt: minutesAgo(1),
    });
    const queued = await seedRun({
      jobId: job._id,
      status: "queued",
      lane: "job",
      trigger: "schedule",
      createdAt: minutesAgo(1),
    });

    const info = await describeQueuedRun(queued, now);
    expect(info?.blockedBy).toBeNull();
    expect(info?.runsAhead).toBe(0);
  });

  it("one interactive run waits behind another when the lane has 1 slot", async () => {
    const running = await seedRun({
      status: "running",
      lane: "interactive",
      trigger: "agent",
      commands: ["compile"],
      startedAt: minutesAgo(2),
    });
    const queued = await seedRun({
      status: "queued",
      lane: "interactive",
      commands: ["parse"],
      createdAt: minutesAgo(1),
    });

    const info = await describeQueuedRun(queued, now);
    expect(info?.blockedBy?.runId).toBe(running._id.toString());
    expect(info?.reason).toBe(
      `Queued behind run ${running._id.toString()} of a agent run, running for 2 min. ` +
        "Validation runs (parse, compile, show) run one at a time per project, apart from jobs.",
    );
  });

  it("2 slots: a second job is not blocked while one slot is free", async () => {
    process.env.DBT_PROJECT_RUN_CONCURRENCY = "2";
    const nightly = await seedJob("Nightly build");
    const hourly = await seedJob("Hourly marts");
    await seedRun({
      jobId: nightly._id,
      status: "running",
      lane: "job",
      startedAt: minutesAgo(10),
    });
    const queued = await seedRun({
      jobId: hourly._id,
      status: "queued",
      lane: "job",
      trigger: "schedule",
      createdAt: minutesAgo(1),
    });

    const info = await describeQueuedRun(queued, now);

    expect(info).toMatchObject({
      slots: 2,
      runningCount: 1,
      runsAhead: 0,
      blockedBy: null,
    });
    expect(info?.reason).toBe(
      "A slot is free (1 of 2 in use), so the dbt worker should start it within seconds. " +
        "If it stays queued, the worker is not receiving run events.",
    );
  });

  it("2 slots: a run waits once both are taken, behind the longest-running one", async () => {
    process.env.DBT_PROJECT_RUN_CONCURRENCY = "2";
    const nightly = await seedJob("Nightly build");
    const hourly = await seedJob("Hourly marts");
    const oldest = await seedRun({
      jobId: nightly._id,
      status: "running",
      lane: "job",
      startedAt: minutesAgo(30),
    });
    await seedRun({
      jobId: hourly._id,
      status: "running",
      lane: "job",
      startedAt: minutesAgo(4),
    });
    const queued = await seedRun({
      status: "queued",
      lane: "job",
      createdAt: minutesAgo(1),
    });

    const info = await describeQueuedRun(queued, now);

    expect(info).toMatchObject({ slots: 2, runningCount: 2, runsAhead: 1 });
    expect(info?.blockedBy?.runId).toBe(oldest._id.toString());
    expect(info?.reason).toContain(
      "All 2 run slots of the project are in use.",
    );
  });

  it("2 slots: a run of a job that is already running waits for that run, with a free slot", async () => {
    process.env.DBT_PROJECT_RUN_CONCURRENCY = "2";
    const nightly = await seedJob("Nightly build");
    const sameJob = await seedRun({
      jobId: nightly._id,
      status: "running",
      lane: "job",
      startedAt: minutesAgo(7),
    });
    const queued = await seedRun({
      jobId: nightly._id,
      status: "queued",
      lane: "job",
      createdAt: minutesAgo(1),
    });

    const info = await describeQueuedRun(queued, now);

    expect(info?.runningCount).toBe(1);
    expect(info?.runsAhead).toBe(1);
    expect(info?.blockedBy?.runId).toBe(sameJob._id.toString());
    expect(info?.reason).toBe(
      `Queued behind run ${sameJob._id.toString()} of job "Nightly build", running for 7 min. ` +
        "A job runs one run at a time.",
    );
  });

  it("a run from before lanes existed is explained as the job lane", async () => {
    const running = await seedRun({
      status: "running",
      startedAt: minutesAgo(3),
    });
    const queued = await seedRun({
      status: "queued",
      createdAt: minutesAgo(1),
    });
    const info = await describeQueuedRun(queued, now);
    expect(info?.lane).toBe("job");
    expect(info?.blockedBy?.runId).toBe(running._id.toString());
  });
});
