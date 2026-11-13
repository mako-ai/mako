/**
 * The dbt executor, scheduler and stale-run sweeper, driven through their
 * Inngest handlers with a fake `step`. Real models on mongodb-memory-server;
 * the dbt subprocess, the project snapshot, the artifact store and the
 * helpers of other packages (labels, notifications) are mocked.
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

vi.mock("./dbt-project.service", () => ({
  loadDbtProjectSnapshot: vi.fn(),
}));

vi.mock("./runner.service", async () => {
  const actual =
    await vi.importActual<typeof import("./runner.service")>(
      "./runner.service",
    );
  return { ...actual, runDbt: vi.fn() };
});

vi.mock("./dbt-cache.service", () => ({
  computePackagesHash: () => null,
  loadDbtCaches: async () => ({ packagesFresh: false }),
  saveParseCache: vi.fn(async () => undefined),
  savePackagesCache: vi.fn(async () => undefined),
}));

vi.mock("./workspace-dir.service", () => ({
  warmDirsEnabled: () => true,
  withProjectDir: vi.fn(
    async (_scope: unknown, fn: (dir: string) => Promise<unknown>) =>
      fn("/warm-dir"),
  ),
}));

const openReadStream = vi.fn(async (_key: string) => null);
vi.mock("../services/artifact-store.service", () => ({
  getArtifactStore: () => ({
    openReadStream,
    putBuffer: vi.fn(async () => undefined),
  }),
}));

vi.mock("./dbt-run-notify", () => ({
  emitDbtRunTerminalEvent: vi.fn(async () => undefined),
  emitDbtJobAutoDisabledEvent: vi.fn(async () => undefined),
}));

vi.mock("./dbt-run-labels", () => ({
  DBT_QUERY_COMMENT_MACRO: "",
  dbtRunLabelEnv: vi.fn(
    (input: { runId: string; trigger: string; jobSlug?: string }) => ({
      MAKO_DBT_RUN: input.runId,
      MAKO_TRIGGER: input.trigger,
      ...(input.jobSlug ? { MAKO_DBT_JOB: input.jobSlug } : {}),
    }),
  ),
}));

vi.mock("./dbt-run.service", async () => {
  const actual =
    await vi.importActual<typeof import("./dbt-run.service")>(
      "./dbt-run.service",
    );
  return { ...actual, triggerDbtJobRun: vi.fn(actual.triggerDbtJobRun) };
});

import { DbtJob, DbtProject, DbtRun } from "../database/workspace-schema";
import {
  dbtRunExecutorFunction,
  dbtRunSweeperFunction,
  dbtSchedulerFunction,
} from "../inngest/functions/dbt-run";
import { loadDbtProjectSnapshot } from "./dbt-project.service";
import { dbtRunLabelEnv } from "./dbt-run-labels";
import {
  emitDbtJobAutoDisabledEvent,
  emitDbtRunTerminalEvent,
} from "./dbt-run-notify";
import { dbtRunQueueKeys } from "./dbt-run-queue";
import {
  DbtJobDefinitionMissingError,
  DbtJobNotScheduledAtCommitError,
  triggerDbtJobRun,
} from "./dbt-run.service";
import { runDbt, type DbtRunRequest } from "./runner.service";
import { withProjectDir } from "./workspace-dir.service";

const runDbtMock = vi.mocked(runDbt);
const snapshotMock = vi.mocked(loadDbtProjectSnapshot);
const emitMock = vi.mocked(emitDbtRunTerminalEvent);
const emitDisabledMock = vi.mocked(emitDbtJobAutoDisabledEvent);
const labelEnvMock = vi.mocked(dbtRunLabelEnv);
const warmDirMock = vi.mocked(withProjectDir);
const triggerJobMock = vi.mocked(triggerDbtJobRun);

type Handler = (ctx: {
  event: { data: Record<string, unknown> };
  step: unknown;
}) => Promise<unknown>;

function handlerOf(fn: unknown): Handler {
  const handler = (fn as { fn: Handler }).fn;
  return handler.bind(fn);
}

/** Runs each step once, in order, and round-trips its result like Inngest. */
function fakeStep() {
  const ids: string[] = [];
  const sent: Array<{ id?: string; name: string; data: unknown }> = [];
  return {
    ids,
    sent,
    step: {
      sendEvent: async (
        id: string,
        event: { id?: string; name: string; data: unknown },
      ) => {
        ids.push(id);
        sent.push(event);
      },
      run: async (id: string, fn: () => unknown) => {
        ids.push(id);
        const result = await fn();
        return result === undefined
          ? undefined
          : JSON.parse(JSON.stringify(result));
      },
      sleep: async () => undefined,
    },
  };
}

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
let PROJECT: Types.ObjectId;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

/** dbt exits 0 on every command, with invocation ids inv-1, inv-2, ... */
function dbtSucceeds() {
  let call = 0;
  runDbtMock.mockImplementation(async () => {
    call += 1;
    return {
      success: true,
      projectChanged: false,
      artifacts: {},
      commandResults: [
        { exitCode: 0, logLines: [], invocationId: `inv-${call}` },
      ],
    };
  });
}

function dbtFails() {
  runDbtMock.mockImplementation(async () => ({
    success: false,
    projectChanged: false,
    artifacts: {},
    commandResults: [{ exitCode: 1, logLines: [] }],
  }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtJob.deleteMany({}),
    DbtRun.deleteMany({}),
  ]);
  const project = await DbtProject.create({
    workspaceId: WS,
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
    lastProdManifestKey: "dbt-artifacts/prod/manifest.json",
    createdBy: "u1",
  });
  PROJECT = project._id;
  snapshotMock.mockResolvedValue({
    project: { dbtVersion: "1.9" },
    environment: { vars: { region: "eu", row_limit: 100 } },
    files: [],
    profile: {
      profilesYml: "",
      secretEnv: {},
      adapterPackage: "dbt-postgres",
      keyfiles: [],
    },
  } as unknown as Awaited<ReturnType<typeof loadDbtProjectSnapshot>>);
  dbtSucceeds();
});

async function seedJob(fields: Record<string, unknown> = {}) {
  return DbtJob.create({
    workspaceId: WS,
    projectId: PROJECT,
    slug: "nightly",
    name: "Nightly build",
    environment: "prod",
    commands: ["build"],
    schedule: { cron: "0 6 * * *", timezone: "UTC" },
    enabled: true,
    createdBy: "u1",
    ...fields,
  });
}

async function seedQueuedRun(fields: Record<string, unknown> = {}) {
  return DbtRun.create({
    workspaceId: WS,
    projectId: PROJECT,
    environment: "prod",
    commands: ["build"],
    status: "queued",
    trigger: "manual",
    triggeredBy: "u1",
    ...fields,
  });
}

async function execute(
  run: { _id: Types.ObjectId; jobId?: Types.ObjectId },
  // false = an event sent by a build that predates lanes: no queue keys.
  options: { withQueueKeys?: boolean } = {},
) {
  const { step, ids, sent } = fakeStep();
  const base = {
    workspaceId: WS.toString(),
    projectId: PROJECT.toString(),
    runId: run._id.toString(),
    jobId: run.jobId?.toString(),
  };
  const result = await handlerOf(dbtRunExecutorFunction)({
    event: {
      data:
        options.withQueueKeys === false
          ? base
          : {
              ...base,
              ...dbtRunQueueKeys({
                projectId: base.projectId,
                runId: base.runId,
                jobId: base.jobId,
                lane: "job",
              }),
            },
    },
    step,
  });
  return { result, ids, sent };
}

function dbtRequests(): DbtRunRequest[] {
  return runDbtMock.mock.calls.map(call => call[0]);
}

describe("executor concurrency (#1239)", () => {
  it("holds a lane slot and a per-job lock, with explicit keys and retries", () => {
    const opts = (
      dbtRunExecutorFunction as unknown as {
        opts: { concurrency: unknown; retries: unknown };
      }
    ).opts;
    expect(opts.concurrency).toEqual([
      // Default: 1 run per project and lane.
      { key: "event.data.laneKey", limit: 1 },
      { key: "event.data.lockKey", limit: 1 },
    ]);
    expect(opts.retries).toBe(0);
  });
});

describe("executor: events sent before lanes carry no queue keys", () => {
  it("re-sends a keyless event with the keys of its own project and job, and runs nothing", async () => {
    const job = await seedJob();
    const run = await seedQueuedRun({ jobId: job._id, trigger: "schedule" });

    const { result, ids, sent } = await execute(run, { withQueueKeys: false });

    expect(result).toEqual({ runId: run._id.toString(), status: "requeued" });
    expect(ids).toEqual(["derive-queue-keys", "requeue-with-queue-keys"]);
    expect(sent).toEqual([
      {
        id: `dbt-run-requeue:${run._id.toString()}`,
        name: "dbt/run.requested",
        data: {
          workspaceId: WS.toString(),
          projectId: PROJECT.toString(),
          runId: run._id.toString(),
          jobId: job._id.toString(),
          laneKey: `${PROJECT.toString()}:job`,
          lockKey: `job:${job._id.toString()}`,
        },
      },
    ]);
    // The run waits for its copy: still queued, dbt never started.
    expect((await DbtRun.findById(run._id).lean())?.status).toBe("queued");
    expect(runDbtMock).not.toHaveBeenCalled();
  });

  it("gives two keyless runs of two projects different keys", async () => {
    const other = new Types.ObjectId();
    const first = await seedQueuedRun();
    const second = await seedQueuedRun({ projectId: other });

    const a = await execute(first, { withQueueKeys: false });
    const { step, sent } = fakeStep();
    await handlerOf(dbtRunExecutorFunction)({
      event: {
        data: {
          workspaceId: WS.toString(),
          projectId: other.toString(),
          runId: second._id.toString(),
        },
      },
      step,
    });

    const keysOf = (event: { data: unknown }) =>
      event.data as { laneKey: string; lockKey: string };
    const [x, y] = [keysOf(a.sent[0]), keysOf(sent[0])];
    expect(x.laneKey).toBe(`${PROJECT.toString()}:job`);
    expect(y.laneKey).toBe(`${other.toString()}:job`);
    expect(x.lockKey).toBe(`run:${first._id.toString()}`);
    expect(y.lockKey).toBe(`run:${second._id.toString()}`);
  });

  it("keeps the lane of an interactive run", async () => {
    const run = await seedQueuedRun({
      commands: ["parse"],
      lane: "interactive",
    });
    const { sent } = await execute(run, { withQueueKeys: false });
    expect(sent[0].data).toMatchObject({
      laneKey: `${PROJECT.toString()}:interactive`,
      lockKey: `run:${run._id.toString()}`,
    });
  });

  it("sends nothing for a run that is no longer queued", async () => {
    const run = await seedQueuedRun({ status: "cancelled" });
    const { result, ids, sent } = await execute(run, { withQueueKeys: false });
    expect(result).toEqual({ runId: run._id.toString(), status: "skipped" });
    expect(ids).toEqual(["derive-queue-keys"]);
    expect(sent).toEqual([]);
  });

  it("runs the copy: an event with keys goes straight to the run", async () => {
    const run = await seedQueuedRun();
    const { result, ids } = await execute(run);
    expect(result).toMatchObject({ status: "success" });
    expect(ids[0]).toBe("mark-running");
    expect(ids).not.toContain("requeue-with-queue-keys");
  });
});

describe("executor: run inputs reach dbt", () => {
  it("merges run vars over the environment's, labels the child, and stores invocation ids in command order", async () => {
    const job = await seedJob();
    const run = await seedQueuedRun({
      jobId: job._id,
      commands: ["build --full-refresh", "test"],
      trigger: "agent",
      lane: "job",
      overrides: {
        vars: { row_limit: 5, run_date: "2026-01-01" },
        fullRefresh: true,
      },
    });

    const { result } = await execute(run);

    expect(result).toMatchObject({ status: "success" });
    const requests = dbtRequests();
    expect(requests.map(request => request.commands[0].argv)).toEqual([
      ["build", "--full-refresh"],
      ["test"],
    ]);
    for (const request of requests) {
      // The override wins; the environment's other vars stay.
      expect(request.vars).toEqual({
        region: "eu",
        row_limit: 5,
        run_date: "2026-01-01",
      });
      expect(request.extraEnv).toEqual({
        MAKO_DBT_RUN: run._id.toString(),
        MAKO_TRIGGER: "agent",
        MAKO_DBT_JOB: "nightly",
      });
    }
    expect(labelEnvMock).toHaveBeenCalledWith({
      runId: run._id.toString(),
      trigger: "agent",
      jobId: job._id.toString(),
      jobSlug: "nightly",
    });

    const stored = await DbtRun.findById(run._id).lean();
    expect(stored?.status).toBe("success");
    expect(stored?.invocationIds).toEqual(["inv-1", "inv-2"]);
    // The overrides stay on the run. The job row is untouched.
    expect((await DbtJob.findById(job._id).lean())?.commands).toEqual([
      "build",
    ]);
  });

  it("passes the environment's vars as they are when the run has no overrides", async () => {
    const run = await seedQueuedRun({ workingTreeUserId: "u1" });
    await execute(run);
    expect(dbtRequests()[0].vars).toEqual({ region: "eu", row_limit: 100 });
    expect(labelEnvMock).toHaveBeenCalledWith({
      runId: run._id.toString(),
      trigger: "manual",
      jobId: undefined,
      jobSlug: undefined,
    });
  });

  it("stores no invocation ids when dbt reports none", async () => {
    runDbtMock.mockImplementation(async () => ({
      success: true,
      projectChanged: false,
      artifacts: {},
      commandResults: [{ exitCode: 0, logLines: [] }],
    }));
    const run = await seedQueuedRun();
    await execute(run);
    expect(
      (await DbtRun.findById(run._id).lean())?.invocationIds,
    ).toBeUndefined();
  });
});

describe("executor: warm directory per run", () => {
  const ownerOf = () =>
    (warmDirMock.mock.calls[0]?.[0] as { userId?: string; role: string })
      .userId;

  it("a job run keeps the shared deploy directory at the default of 1 slot", async () => {
    const job = await seedJob();
    await execute(await seedQueuedRun({ jobId: job._id, lane: "job" }));
    expect(ownerOf()).toBeUndefined();
  });

  it("an interactive run gets a directory of its own", async () => {
    await execute(
      await seedQueuedRun({
        commands: ["parse"],
        lane: "interactive",
        trigger: "agent",
        workingTreeUserId: "u1",
      }),
    );
    expect(ownerOf()).toBe("interactive:u1");
  });

  it("a working-tree build keeps its per-user directory", async () => {
    await execute(
      await seedQueuedRun({ lane: "job", workingTreeUserId: "u1" }),
    );
    expect(ownerOf()).toBe("u1");
  });
});

describe("executor: defer follows the run, not the job row (#1237)", () => {
  const deferRequested = () =>
    openReadStream.mock.calls.some(
      call => call[0] === "dbt-artifacts/prod/manifest.json",
    );

  it("defers when the run says so, even if the row does not", async () => {
    const job = await seedJob({ deferToProduction: false });
    await execute(
      await seedQueuedRun({ jobId: job._id, deferToProduction: true }),
    );
    expect(deferRequested()).toBe(true);
  });

  it("does not defer when the run says no, even if the row says yes", async () => {
    const job = await seedJob({ deferToProduction: true });
    await execute(
      await seedQueuedRun({ jobId: job._id, deferToProduction: false }),
    );
    expect(deferRequested()).toBe(false);
  });

  it("a job run queued before the flag was stored falls back to the row", async () => {
    const job = await seedJob({ deferToProduction: true });
    await execute(await seedQueuedRun({ jobId: job._id }));
    expect(deferRequested()).toBe(true);
  });
});

describe("executor: terminal event", () => {
  it("emits once, in its own step, after the terminal status is stored", async () => {
    const job = await seedJob();
    const run = await seedQueuedRun({ jobId: job._id });
    let statusAtEmit: string | undefined;
    emitMock.mockImplementationOnce(async runId => {
      statusAtEmit = (await DbtRun.findById(runId).lean())?.status;
    });

    const { ids } = await execute(run);

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(run._id.toString());
    expect(statusAtEmit).toBe("success");
    expect(ids).toEqual([
      "mark-running",
      "exec-cmd-0",
      "finalize-run",
      "emit-terminal-event",
    ]);
  });

  it("emits once for a failed run, with the job stats already written", async () => {
    dbtFails();
    const job = await seedJob();
    const run = await seedQueuedRun({ jobId: job._id });

    const { result } = await execute(run);

    expect(result).toMatchObject({ status: "error" });
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect((await DbtRun.findById(run._id).lean())?.status).toBe("error");
    const stats = (await DbtJob.findById(job._id).lean())?.scheduledRun;
    expect(stats?.consecutiveFailures).toBe(1);
    expect(stats?.runCount).toBe(1);
  });

  it("does not emit, or count the run again, when the sweeper already finalized it", async () => {
    const job = await seedJob();
    const run = await seedQueuedRun({ jobId: job._id });
    // The sweeper writes the terminal status while dbt is still running.
    runDbtMock.mockImplementation(async () => {
      await DbtRun.updateOne(
        { _id: run._id },
        { $set: { status: "error", completedAt: new Date() } },
      );
      return {
        success: true,
        projectChanged: false,
        artifacts: {},
        commandResults: [{ exitCode: 0, logLines: [] }],
      };
    });

    const { ids } = await execute(run);

    expect(emitMock).not.toHaveBeenCalled();
    expect(ids).not.toContain("emit-terminal-event");
    expect((await DbtRun.findById(run._id).lean())?.status).toBe("error");
    expect(
      (await DbtJob.findById(job._id).lean())?.scheduledRun?.runCount,
    ).toBe(0);
  });

  it("does not emit for a cancelled run", async () => {
    const job = await seedJob();
    const run = await seedQueuedRun({ jobId: job._id });
    runDbtMock.mockImplementation(async () => {
      await DbtRun.updateOne(
        { _id: run._id },
        { $set: { cancelledAt: new Date(), cancelledBy: "u1" } },
      );
      return {
        success: false,
        projectChanged: false,
        artifacts: {},
        commandResults: [{ exitCode: 143, logLines: [] }],
      };
    });

    await execute(run);

    expect((await DbtRun.findById(run._id).lean())?.status).toBe("cancelled");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("skips a duplicate delivery without emitting", async () => {
    const run = await seedQueuedRun({ status: "success" });
    const { result, ids } = await execute(run);
    expect(result).toEqual({ skipped: true });
    expect(ids).toEqual(["mark-running"]);
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe("executor: auto-disable after repeated failures", () => {
  it("disables the job on the failure that reaches the threshold, even though the yml commit fails", async () => {
    dbtFails();
    // No repo is bound in this suite, so the yml write-through throws.
    const job = await seedJob({
      scheduledRun: {
        nextAt: new Date(Date.now() + 60_000),
        runCount: 9,
        consecutiveFailures: 9,
      },
    });
    const run = await seedQueuedRun({ jobId: job._id, trigger: "schedule" });

    await execute(run);

    const fresh = await DbtJob.findById(job._id).lean();
    expect(fresh?.scheduledRun?.consecutiveFailures).toBe(10);
    expect(fresh?.enabled).toBe(false);
    expect(fresh?.scheduledRun?.nextAt).toBeUndefined();
    expect(fresh?.scheduledRun?.lastError).toMatch(
      /^Auto-disabled after 10 consecutive failures\. Last error: dbt command "build" exited with code 1$/,
    );
    // The run still finalizes and notifies.
    expect((await DbtRun.findById(run._id).lean())?.status).toBe("error");
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it("announces the auto-disable once, in its own step, after the run's own event", async () => {
    dbtFails();
    const job = await seedJob({
      scheduledRun: { runCount: 9, consecutiveFailures: 9 },
    });
    const run = await seedQueuedRun({ jobId: job._id, trigger: "schedule" });

    const { ids } = await execute(run);

    expect(emitDisabledMock).toHaveBeenCalledTimes(1);
    expect(emitDisabledMock).toHaveBeenCalledWith(run._id.toString(), 10);
    expect(ids.slice(-2)).toEqual([
      "emit-terminal-event",
      "emit-job-auto-disabled-event",
    ]);
  });

  it("announces nothing for a failure below the threshold, a success, or a job with no schedule", async () => {
    dbtFails();
    const below = await seedJob({
      scheduledRun: { runCount: 3, consecutiveFailures: 3 },
    });
    await execute(await seedQueuedRun({ jobId: below._id }));

    // Manual-only jobs are never auto-disabled: nothing re-runs them.
    const manualOnly = await seedJob({
      slug: "backfill",
      schedule: undefined,
      scheduledRun: { runCount: 9, consecutiveFailures: 9 },
    });
    await execute(await seedQueuedRun({ jobId: manualOnly._id }));

    dbtSucceeds();
    const healthy = await seedJob({
      slug: "hourly",
      scheduledRun: { runCount: 9, consecutiveFailures: 9 },
    });
    await execute(await seedQueuedRun({ jobId: healthy._id }));

    expect(emitDisabledMock).not.toHaveBeenCalled();
  });

  it("leaves the job enabled below the threshold", async () => {
    dbtFails();
    const job = await seedJob({
      scheduledRun: { runCount: 3, consecutiveFailures: 3 },
    });
    await execute(await seedQueuedRun({ jobId: job._id }));
    expect((await DbtJob.findById(job._id).lean())?.enabled).toBe(true);
  });
});

describe("stale-run sweeper", () => {
  it("emits the terminal event once for each run it finalizes, and for no other", async () => {
    const job = await seedJob();
    const hoursAgo = (hours: number) =>
      new Date(Date.now() - hours * 60 * 60_000);
    const dead = await seedQueuedRun({
      jobId: job._id,
      status: "running",
      startedAt: hoursAgo(2),
    });
    const alive = await seedQueuedRun({
      status: "running",
      startedAt: new Date(),
    });
    const done = await seedQueuedRun({
      status: "success",
      completedAt: new Date(),
    });

    const { step, ids } = fakeStep();
    const result = await handlerOf(dbtRunSweeperFunction)({
      event: { data: {} },
      step,
    });

    expect(result).toMatchObject({ swept: 1 });
    expect((await DbtRun.findById(dead._id).lean())?.status).toBe("error");
    expect((await DbtRun.findById(alive._id).lean())?.status).toBe("running");
    expect((await DbtRun.findById(done._id).lean())?.status).toBe("success");
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(dead._id.toString());
    expect(ids).toContain(`emit-terminal-event-${dead._id.toString()}`);
    // The sweep mirrors the job stats before it notifies.
    expect(
      (await DbtJob.findById(job._id).lean())?.scheduledRun
        ?.consecutiveFailures,
    ).toBe(1);
  });

  it("emits nothing when there is nothing to sweep", async () => {
    const { step } = fakeStep();
    const result = await handlerOf(dbtRunSweeperFunction)({
      event: { data: {} },
      step,
    });
    expect(result).toMatchObject({ swept: 0 });
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe("scheduler", () => {
  async function seedDueJob() {
    return seedJob({
      scheduledRun: {
        nextAt: new Date(Date.now() - 60_000),
        runCount: 0,
        consecutiveFailures: 0,
      },
    });
  }

  it("treats a job whose file is gone as a skipped tick, not a failure to retry", async () => {
    const job = await seedDueJob();
    triggerJobMock.mockRejectedValueOnce(
      new DbtJobDefinitionMissingError(job, "a".repeat(40)),
    );

    const { step } = fakeStep();
    const result = await handlerOf(dbtSchedulerFunction)({
      event: { data: {} },
      step,
    });

    expect(result).toEqual({ checked: 1, triggered: 0 });
    expect(triggerJobMock).toHaveBeenCalledTimes(1);
  });

  // Review B3: the file at the run's commit turned the schedule off.
  it("treats a job its file disabled or unscheduled as a skipped tick, not a failure to retry", async () => {
    const job = await seedDueJob();
    for (const reason of ["disabled_in_file", "unscheduled_in_file"] as const) {
      await DbtJob.updateOne(
        { _id: job._id },
        { $set: { "scheduledRun.nextAt": new Date(Date.now() - 60_000) } },
      );
      triggerJobMock.mockClear();
      triggerJobMock.mockRejectedValueOnce(
        new DbtJobNotScheduledAtCommitError(job, "a".repeat(40), reason),
      );
      const { step } = fakeStep();
      const result = await handlerOf(dbtSchedulerFunction)({
        event: { data: {} },
        step,
      });
      expect(result).toEqual({ checked: 1, triggered: 0 });
      expect(triggerJobMock).toHaveBeenCalledTimes(1);
    }
  });

  it("still fails the step on any other trigger error", async () => {
    await seedDueJob();
    triggerJobMock.mockRejectedValueOnce(new Error("mongo unavailable"));
    const { step } = fakeStep();
    await expect(
      handlerOf(dbtSchedulerFunction)({ event: { data: {} }, step }),
    ).rejects.toThrow("mongo unavailable");
  });

  it("triggers a due job as a scheduled run", async () => {
    const job = await seedDueJob();
    triggerJobMock.mockResolvedValueOnce({
      _id: new Types.ObjectId(),
    } as Awaited<ReturnType<typeof triggerDbtJobRun>>);

    const { step } = fakeStep();
    const result = await handlerOf(dbtSchedulerFunction)({
      event: { data: {} },
      step,
    });

    expect(result).toEqual({ checked: 1, triggered: 1 });
    expect(triggerJobMock.mock.calls[0][0]).toMatchObject({
      workspaceId: WS.toString(),
      trigger: "schedule",
      triggeredBy: "scheduler",
    });
    expect(triggerJobMock.mock.calls[0][0].job._id.toString()).toBe(
      job._id.toString(),
    );
  });
});
