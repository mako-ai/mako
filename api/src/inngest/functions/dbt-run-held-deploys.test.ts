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

  it("releases the deploys of a run still going after 60 minutes", async () => {
    const run = await heldRun("running");
    const event = { data: { runId: run._id.toString(), holdsDeploys: true } };

    await handlerOf(dbtRunHeldDeploysCapFunction)({ event, step });

    expect(step.sleep).toHaveBeenCalledWith("hold-cap", "60m");
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [APP], SHA, "push");

    // The run ends later: its finalize finds the release already claimed.
    await DbtRun.updateOne({ _id: run._id }, { $set: { status: "success" } });
    await handlerOf(dbtRunCancelFunction)({
      event: { data: { runId: run._id.toString() } },
      step,
    });
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the run already released them", async () => {
    const run = await heldRun("success", {
      deploysAfterRun: {
        workspaceId: ws,
        appIds: [APP],
        sha: SHA,
        releasedAt: new Date(),
      },
    });

    await handlerOf(dbtRunHeldDeploysCapFunction)({
      event: { data: { runId: run._id.toString(), holdsDeploys: true } },
      step,
    });

    expect(requestAppDeploys).not.toHaveBeenCalled();
  });
});
