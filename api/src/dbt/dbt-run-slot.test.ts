/**
 * A dbt run starts only when no other run holds its project lane or its job.
 *
 * 19 Nov 2026, 15:49 UTC: the deploy of #1424 changed the executor's Inngest
 * concurrency keys. 8 runs of project 6a379d6014cf36380f79d5fe queued before
 * it were resent with the new keys and all started within 17 s. Inngest did
 * not hold them to one per lane. These tests run the real executor handler
 * against real Mongo with Inngest steps inline, so nothing here depends on
 * Inngest's locks.
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

vi.mock("../inngest/client", () => ({
  inngest: {
    createFunction: vi.fn((options: unknown, handler: Handler) => ({
      options,
      handler,
    })),
    send: vi.fn(async () => ({ ids: [] })),
  },
}));

vi.mock("../inngest/functions/apps-deploy", () => ({
  requestAppDeploys: vi.fn(async () => undefined),
}));

// The first thing a dbt command does is load the project snapshot. A call
// here means the executor started dbt work.
vi.mock("./dbt-project.service", async importOriginal => ({
  ...(await importOriginal<typeof import("./dbt-project.service")>()),
  loadDbtProjectSnapshot: vi.fn(async () => {
    throw new Error("dbt command started");
  }),
}));

import { DbtRun, type DbtRunLane } from "../database/workspace-schema";
import { loadDbtProjectSnapshot } from "./dbt-project.service";
import { claimDbtRunSlot, dbtRunQueueKeys } from "./dbt-run-queue";
import {
  DBT_RUN_SLOT_MAX_CLAIMS,
  DBT_RUN_SLOT_WAIT,
  dbtRunExecutorFunction,
} from "../inngest/functions/dbt-run";

const started = loadDbtProjectSnapshot as unknown as ReturnType<typeof vi.fn>;
const WS = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

const step = {
  run: async (_id: string, fn: () => unknown) => fn(),
  sleep: vi.fn(async (_id: string, _duration: string): Promise<void> => {}),
  sendEvent: vi.fn(async () => undefined),
};

const execute = (fn: unknown, data: Record<string, unknown>) =>
  (fn as { handler: Handler }).handler({ event: { data }, step });

const makeRun = (
  status: "queued" | "running",
  extra: { lane?: DbtRunLane; jobId?: Types.ObjectId } = {},
) =>
  DbtRun.create({
    workspaceId: WS,
    projectId: PROJECT,
    environment: "prod",
    commands: ["build"],
    status,
    trigger: "schedule",
    triggeredBy: "scheduler",
    ...(status === "running" ? { startedAt: new Date() } : {}),
    ...extra,
  });

/** The event as the fallback resends it: the default lane's keys. */
const resentEvent = (run: { _id: Types.ObjectId; jobId?: Types.ObjectId }) => ({
  workspaceId: WS.toString(),
  projectId: PROJECT.toString(),
  runId: run._id.toString(),
  jobId: run.jobId?.toString(),
  ...dbtRunQueueKeys({
    projectId: PROJECT.toString(),
    runId: run._id.toString(),
    jobId: run.jobId?.toString(),
    lane: "default",
  }),
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

describe("an event queued before lanes", () => {
  it("is resent with the default lane's keys and starts nothing", async () => {
    await makeRun("running");
    const queued = await makeRun("queued", { jobId: new Types.ObjectId() });

    const out = await execute(dbtRunExecutorFunction, {
      workspaceId: WS.toString(),
      projectId: PROJECT.toString(),
      runId: queued._id.toString(),
      jobId: queued.jobId?.toString(),
    });

    expect(out).toMatchObject({ requeued: true });
    expect(step.sendEvent).toHaveBeenCalledTimes(1);
    expect(started).not.toHaveBeenCalled();
    expect((await DbtRun.findById(queued._id).lean())?.status).toBe("queued");
  });

  it("its resent copy waits while another default-lane run is running", async () => {
    // 15:49:37-54: the copies started at once. Each must wait instead.
    await makeRun("running");
    const copies = await Promise.all(
      [0, 1, 2].map(() => makeRun("queued", { jobId: new Types.ObjectId() })),
    );

    const outs = await Promise.all(
      copies.map(run => execute(dbtRunExecutorFunction, resentEvent(run))),
    );

    expect(outs).toEqual([
      { skipped: true },
      { skipped: true },
      { skipped: true },
    ]);
    expect(started).not.toHaveBeenCalled();
    expect(step.sleep).toHaveBeenCalledWith(
      "wait-for-lane-1",
      DBT_RUN_SLOT_WAIT,
    );
    expect(step.sleep).toHaveBeenCalledTimes(3 * (DBT_RUN_SLOT_MAX_CLAIMS - 1));
    const statuses = await DbtRun.find({ _id: { $in: copies.map(r => r._id) } })
      .select("status startedAt")
      .lean();
    for (const run of statuses) {
      expect(run.status).toBe("queued");
      expect(run.startedAt).toBeUndefined();
    }
  });

  it("its resent copy starts once the running run ends", async () => {
    const holder = await makeRun("running");
    const queued = await makeRun("queued");
    // The holder finishes during the second wait.
    step.sleep.mockImplementation(async (id: string) => {
      if (id === "wait-for-lane-2") {
        await DbtRun.updateOne(
          { _id: holder._id },
          { $set: { status: "success" } },
        );
      }
    });

    // The stubbed snapshot load throws once dbt work starts.
    await expect(
      execute(dbtRunExecutorFunction, resentEvent(queued)),
    ).rejects.toThrow("dbt command started");
    const waits = step.sleep.mock.calls.map(call => call[0]);
    step.sleep.mockReset();

    expect(waits).toEqual(["wait-for-lane-1", "wait-for-lane-2"]);
    expect(started).toHaveBeenCalledTimes(1);
  });
});

describe("claimDbtRunSlot", () => {
  it("gives one of 5 racing default-lane runs the slot, never 2", async () => {
    for (let round = 0; round < 10; round++) {
      await DbtRun.deleteMany({});
      const runs = await Promise.all(
        [0, 1, 2, 3, 4].map(() => makeRun("queued")),
      );

      const claims = await Promise.all(runs.map(r => claimDbtRunSlot(r._id)));

      expect(
        claims.filter(c => c.state === "claimed").length,
      ).toBeLessThanOrEqual(1);
      expect(await DbtRun.countDocuments({ status: "running" })).toBe(
        claims.filter(c => c.state === "claimed").length,
      );
    }
  });

  it("keeps the fast lane free of the default lane", async () => {
    await makeRun("running");
    const fast = await makeRun("queued", { lane: "fast" });

    expect((await claimDbtRunSlot(fast._id)).state).toBe("claimed");
  });

  it("holds a job to one run across both lanes", async () => {
    const jobId = new Types.ObjectId();
    await makeRun("running", { jobId });
    const fast = await makeRun("queued", { lane: "fast", jobId });

    expect(await claimDbtRunSlot(fast._id)).toMatchObject({ state: "busy" });
  });

  it("counts a running run that predates lanes as the default lane", async () => {
    await makeRun("running");
    const queued = await makeRun("queued", { lane: "default" });

    expect(await claimDbtRunSlot(queued._id)).toMatchObject({ state: "busy" });
  });

  it("reports a cancelled run as gone", async () => {
    const run = await makeRun("queued");
    await DbtRun.updateOne({ _id: run._id }, { $set: { status: "cancelled" } });

    expect(await claimDbtRunSlot(run._id)).toEqual({ state: "gone" });
  });
});
