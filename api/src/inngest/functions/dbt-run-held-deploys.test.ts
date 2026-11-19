/**
 * Every way a pre-deploy dbt run can end releases the app deploys it held,
 * once: the cancel finalizer, the abandoned-run sweeper ("Swept abandoned dbt
 * run", 06:35 on 19 Nov 2026), the executor finding a run cancelled while
 * queued, and the 60-minute cap. Real Mongo and the real release helper;
 * Inngest steps run inline and only the deploy request is stubbed.
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

type Handler = (ctx: unknown) => Promise<unknown>;

vi.mock("../client", () => ({
  inngest: {
    createFunction: vi.fn((options: unknown, handler: Handler) => ({
      options,
      handler,
    })),
    send: vi.fn(async () => ({})),
  },
}));

vi.mock("./apps-deploy", () => ({
  requestAppDeploys: vi.fn(async () => undefined),
}));

// No repo here: the release keeps the held sha (deployTargetForPush skipped).
vi.mock("../../apps/worktree.service", () => ({
  repoForWorkspace: vi.fn(async () => {
    throw new Error("no repo in this test");
  }),
}));

import { DbtRun, type DbtRunStatus } from "../../database/workspace-schema";
import { requestAppDeploys } from "./apps-deploy";
import { releaseHeldDeploys } from "../../dbt/dbt-run.service";
import {
  HELD_DEPLOYS_CAP,
  dbtRunCancelFunction,
  dbtRunExecutorFunction,
  dbtRunHeldDeploysCapFunction,
  dbtRunSweeperFunction,
} from "./dbt-run";

const SHA = "c".repeat(40);
const APP = "6a9411eb4c8b33609a65e001";
const workspaceId = new Types.ObjectId();
const ws = workspaceId.toString();

const step = {
  run: async (_id: string, fn: () => unknown) => fn(),
  sleep: vi.fn(async () => undefined),
  sendEvent: vi.fn(async () => undefined),
};

const handlerOf = (fn: unknown) => (fn as { handler: Handler }).handler;
const optionsOf = (fn: unknown) =>
  (fn as { options: { triggers: { event: string; if?: string } } }).options;

const heldRun = (status: DbtRunStatus, extra: Record<string, unknown> = {}) =>
  DbtRun.create({
    workspaceId,
    projectId: new Types.ObjectId(),
    environment: "prod",
    commands: ["build --select state:modified+,+fct_c14__closed_loop"],
    status,
    trigger: "schedule",
    triggeredBy: "apps-deploy-on-push",
    deploysAfterRun: { workspaceId: ws, appIds: [APP], sha: SHA },
    ...extra,
  });

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
  await DbtRun.deleteMany({});
});

describe("held app deploys outside the executor's finalize", () => {
  it("the cancel finalizer releases them once", async () => {
    const run = await heldRun("running");
    const event = { data: { runId: run._id.toString(), cancelledBy: "joan" } };

    await handlerOf(dbtRunCancelFunction)({ event, step });
    await handlerOf(dbtRunCancelFunction)({ event, step });

    expect((await DbtRun.findById(run._id).lean())?.status).toBe("cancelled");
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [APP], SHA, "push");
  });

  it("the abandoned-run sweeper releases them once", async () => {
    // Started two hours ago, no log line since: past the 1h stall window.
    await heldRun("running", { startedAt: new Date(Date.now() - 2 * 3600e3) });

    await handlerOf(dbtRunSweeperFunction)({ step });
    await handlerOf(dbtRunSweeperFunction)({ step });

    expect((await DbtRun.findOne().lean())?.status).toBe("error");
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [APP], SHA, "push");
  });

  it("the executor releases them for a run cancelled while queued", async () => {
    const run = await heldRun("cancelled");

    const out = await handlerOf(dbtRunExecutorFunction)({
      event: {
        data: {
          workspaceId: ws,
          projectId: run.projectId.toString(),
          runId: run._id.toString(),
        },
      },
      step,
    });

    expect(out).toEqual({ skipped: true });
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
  });
});

describe("the 60-minute cap", () => {
  it("sleeps on the run's own event, never a cron", () => {
    expect(HELD_DEPLOYS_CAP).toBe("60m");
    expect(optionsOf(dbtRunHeldDeploysCapFunction).triggers).toEqual({
      event: "dbt/run.requested",
      if: "event.data.holdsDeploys == true",
    });
  });

  const capEvent = (runId: Types.ObjectId) => ({
    event: { data: { runId: runId.toString(), holdsDeploys: true } },
    step,
  });

  it("releases the deploys of a run still going after 60 minutes", async () => {
    const run = await heldRun("running");

    await handlerOf(dbtRunHeldDeploysCapFunction)(capEvent(run._id));

    expect(step.sleep).toHaveBeenCalledWith("hold-cap", "60m");
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [APP], SHA, "push");
    const stored = await DbtRun.findById(run._id).lean();
    expect(stored?.deploysAfterRun?.releasedEarly).toBe(true);
  });

  it("cap first, then success: 2 requests, the second against rebuilt prod", async () => {
    const run = await heldRun("running");
    await handlerOf(dbtRunHeldDeploysCapFunction)(capEvent(run._id));

    // The run finishes later; executor finalize, then a late sweep/cancel.
    await DbtRun.updateOne({ _id: run._id }, { $set: { status: "success" } });
    await releaseHeldDeploys(run._id);
    await releaseHeldDeploys(run._id);
    await handlerOf(dbtRunCancelFunction)({
      event: { data: { runId: run._id.toString() } },
      step,
    });

    expect(requestAppDeploys).toHaveBeenCalledTimes(2);
    expect(requestAppDeploys).toHaveBeenNthCalledWith(
      2,
      ws,
      [APP],
      SHA,
      "push",
    );
    const stored = await DbtRun.findById(run._id).lean();
    expect(stored?.deploysAfterRun?.rereleasedAt).toBeInstanceOf(Date);
  });

  it("cap first, then error: 1 request, prod did not change", async () => {
    const run = await heldRun("running", {
      startedAt: new Date(Date.now() - 2 * 3600e3),
    });
    await handlerOf(dbtRunHeldDeploysCapFunction)(capEvent(run._id));

    // The run dies; the sweeper finalizes it as error.
    await handlerOf(dbtRunSweeperFunction)({ step });
    await releaseHeldDeploys(run._id);

    expect((await DbtRun.findById(run._id).lean())?.status).toBe("error");
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
  });

  it("cap first, then cancel: 1 request", async () => {
    const run = await heldRun("running");
    await handlerOf(dbtRunHeldDeploysCapFunction)(capEvent(run._id));

    await handlerOf(dbtRunCancelFunction)({
      event: { data: { runId: run._id.toString() } },
      step,
    });

    expect((await DbtRun.findById(run._id).lean())?.status).toBe("cancelled");
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
  });

  it("success first, then the cap: 1 request", async () => {
    const run = await heldRun("success");
    await releaseHeldDeploys(run._id);

    await handlerOf(dbtRunHeldDeploysCapFunction)(capEvent(run._id));
    await releaseHeldDeploys(run._id);

    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    const stored = await DbtRun.findById(run._id).lean();
    expect(stored?.deploysAfterRun?.releasedEarly).toBeUndefined();
    expect(stored?.deploysAfterRun?.rereleasedAt).toBeUndefined();
  });
});

describe("executor lanes", () => {
  it("locks one run per project lane and one run per job", () => {
    const opts = (
      dbtRunExecutorFunction as unknown as { options: { concurrency: unknown } }
    ).options;
    expect(opts.concurrency).toEqual([
      { key: "event.data.laneKey", limit: 1 },
      { key: "event.data.jobKey", limit: 1 },
    ]);
  });

  it("requeues an event sent before lanes into the default lane", async () => {
    const run = await heldRun("queued");
    const runId = run._id.toString();
    const projectId = run.projectId.toString();

    const out = await handlerOf(dbtRunExecutorFunction)({
      event: {
        data: { workspaceId: ws, projectId, runId, holdsDeploys: true },
      },
      step,
    });

    expect(out).toEqual({
      requeued: true,
      laneKey: `${projectId}:default`,
      jobKey: `run:${runId}`,
    });
    expect(step.sendEvent).toHaveBeenCalledTimes(1);
    expect(step.sendEvent).toHaveBeenCalledWith("requeue-with-lane-keys", {
      id: `dbt-run-requeue:${runId}`,
      name: "dbt/run.requested",
      // holdsDeploys stays off the copy: the original started the cap.
      data: {
        workspaceId: ws,
        projectId,
        runId,
        laneKey: `${projectId}:default`,
        jobKey: `run:${runId}`,
      },
    });
    // The original did not claim the run: the copy will.
    expect((await DbtRun.findById(run._id).lean())?.status).toBe("queued");
    expect(requestAppDeploys).not.toHaveBeenCalled();
  });

  it("an old job-run event keeps its job lock", async () => {
    const jobId = new Types.ObjectId().toString();
    const run = await heldRun("queued", { jobId });
    const projectId = run.projectId.toString();

    const out = await handlerOf(dbtRunExecutorFunction)({
      event: {
        data: { workspaceId: ws, projectId, runId: run._id.toString(), jobId },
      },
      step,
    });

    expect(out).toMatchObject({
      laneKey: `${projectId}:default`,
      jobKey: `job:${jobId}`,
    });
  });
});
