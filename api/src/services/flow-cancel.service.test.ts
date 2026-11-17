/**
 * flow_cancel and POST /flows/:id/cancel share one step, cancelFlowRuns.
 * Its promises, each pinned here against real Mongo:
 *
 *   ALL RUNNING — no executionId cancels every running execution of the
 *                 flow, one `flow.cancel` event each, and says which.
 *   ONE         — an executionId cancels that execution only, never the
 *                 backfill, and only when it is a running run of this flow.
 *   BACKFILL    — a CDC flow whose backfill is running or paused also gets
 *                 the backfill cancel, even with no execution row running.
 *   NOTHING     — nothing running is a 404, and no event is sent.
 *   TENANCY     — another workspace's execution is "not a run of this flow".
 *   ROLE        — the MCP tool refuses a member; an admin may.
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

const state = vi.hoisted(() => ({
  sent: [] as Array<{ name: string; data: Record<string, unknown> }>,
  backfillCancels: [] as Array<[string, string]>,
  roles: {} as Record<string, string>,
}));

vi.mock("../inngest/client", () => ({
  inngest: {
    send: vi.fn(
      async (event: { name: string; data: Record<string, unknown> }) => {
        state.sent.push(event);
        return { ids: [`ev_${state.sent.length}`] };
      },
    ),
  },
}));

vi.mock("../sync-cdc/backfill", () => ({
  cdcBackfillService: {
    cancelBackfill: vi.fn(async (workspaceId: string, flowId: string) => {
      state.backfillCancels.push([workspaceId, flowId]);
      return { cancelled: true, cancelledExecutionId: null };
    }),
  },
}));

vi.mock("./workspace.service", () => ({
  workspaceService: {
    hasRole: vi.fn(async (_ws: string, userId: string, roles: string[]) =>
      roles.includes(state.roles[userId] ?? ""),
    ),
  },
}));

import { Flow, FlowExecution } from "../database/workspace-schema";
import { createFlowSyncTools } from "../agent-lib/tools/flow-sync-tools";
import { cancelFlowRuns, FlowCancelError } from "./flow-cancel.service";

const WS = new Types.ObjectId();
const WS_THEIRS = new Types.ObjectId();

let mongo: MongoMemoryServer;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Flow.collection.deleteMany({});
  await FlowExecution.collection.deleteMany({});
  state.sent.length = 0;
  state.backfillCancels.length = 0;
  state.roles = {};
});

async function makeFlow(
  overrides: Record<string, unknown> = {},
  workspaceId = WS,
) {
  const _id = new Types.ObjectId();
  await Flow.collection.insertOne({
    _id,
    workspaceId,
    name: "fr_close → bigquery",
    slug: "fr-close-bigquery",
    syncEngine: "cdc",
    backfillState: { status: "idle" },
    ...overrides,
  });
  return (await Flow.findById(_id))!;
}

async function makeRun(
  flowId: Types.ObjectId,
  status: string,
  workspaceId = WS,
  startedAt = new Date(),
) {
  const _id = new Types.ObjectId();
  await FlowExecution.collection.insertOne({
    _id,
    flowId,
    workspaceId,
    status,
    startedAt,
    success: false,
  });
  return _id.toString();
}

describe("cancelFlowRuns", () => {
  it("cancels every running execution when no executionId is given", async () => {
    const flow = await makeFlow();
    const older = await makeRun(flow._id, "running", WS, new Date(1_000));
    const newer = await makeRun(flow._id, "running", WS, new Date(2_000));
    await makeRun(flow._id, "completed");

    const result = await cancelFlowRuns(WS.toString(), flow);

    expect(result.executions.map(e => e.executionId)).toEqual([newer, older]);
    expect(result.executions[0].eventId).toBe("ev_1");
    expect(result.backfill).toBeNull();
    expect(state.sent).toEqual([
      {
        name: "flow.cancel",
        data: { flowId: flow._id.toString(), executionId: newer },
      },
      {
        name: "flow.cancel",
        data: { flowId: flow._id.toString(), executionId: older },
      },
    ]);
    expect(state.backfillCancels).toEqual([]);
  });

  it("cancels only the named execution, never the backfill", async () => {
    const flow = await makeFlow({ backfillState: { status: "running" } });
    const one = await makeRun(flow._id, "running");
    await makeRun(flow._id, "running");

    const result = await cancelFlowRuns(WS.toString(), flow, one);

    expect(result.executions.map(e => e.executionId)).toEqual([one]);
    expect(result.backfill).toBeNull();
    expect(state.sent).toHaveLength(1);
    expect(state.backfillCancels).toEqual([]);
  });

  it("cancels a running or paused CDC backfill with the flow", async () => {
    for (const status of ["running", "paused"]) {
      state.backfillCancels.length = 0;
      const flow = await makeFlow({
        backfillState: { status, runId: `run_${status}` },
      });
      const result = await cancelFlowRuns(WS.toString(), flow);
      expect(result.executions).toEqual([]);
      expect(result.backfill).toEqual({
        runId: `run_${status}`,
        previousStatus: status,
      });
      expect(state.backfillCancels).toEqual([
        [WS.toString(), flow._id.toString()],
      ]);
    }
  });

  it("is a 404 when nothing runs, and sends nothing", async () => {
    const flow = await makeFlow({ backfillState: { status: "completed" } });
    await makeRun(flow._id, "completed");
    await expect(cancelFlowRuns(WS.toString(), flow)).rejects.toMatchObject({
      name: "FlowCancelError",
      status: 404,
      message: "No running execution found",
    });
    expect(state.sent).toEqual([]);
    expect(state.backfillCancels).toEqual([]);
  });

  it("refuses an execution that is finished, foreign or malformed", async () => {
    const flow = await makeFlow();
    const done = await makeRun(flow._id, "completed");
    const theirs = await makeRun(flow._id, "running", WS_THEIRS);
    const other = await makeFlow({ slug: "other" });
    const otherRun = await makeRun(other._id, "running");

    for (const id of [done, theirs, otherRun]) {
      await expect(
        cancelFlowRuns(WS.toString(), flow, id),
      ).rejects.toBeInstanceOf(FlowCancelError);
    }
    await expect(
      cancelFlowRuns(WS.toString(), flow, "nope"),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.sent).toEqual([]);
  });
});

describe("flow_cancel (MCP tool)", () => {
  type Exec = (input: unknown, options: unknown) => Promise<unknown>;
  const call = async (userId: string, input: Record<string, unknown>) => {
    const tools = createFlowSyncTools({ workspaceId: WS.toString(), userId });
    const execute = (tools.flow_cancel as { execute: Exec }).execute;
    return (await execute(input, {
      toolCallId: "t",
      messages: [],
    })) as Record<string, unknown>;
  };

  it("needs an owner or admin", async () => {
    await makeFlow();
    state.roles = { member: "member" };
    const out = await call("member", { flow: "fr_close" });
    expect(out).toEqual({
      success: false,
      error: "Owner/admin role required",
    });
    expect(state.sent).toEqual([]);
  });

  it("finds the flow by short name and returns what it cancelled", async () => {
    const flow = await makeFlow({
      backfillState: { status: "running", runId: "run_1" },
    });
    const run = await makeRun(flow._id, "running");
    state.roles = { admin: "admin" };

    const out = await call("admin", { flow: "fr_close" });

    expect(out).toMatchObject({
      success: true,
      id: flow._id.toString(),
      cancelled: [{ executionId: run, eventId: "ev_1" }],
      backfill: { runId: "run_1", previousStatus: "running" },
    });
  });

  it("says so when nothing runs", async () => {
    await makeFlow();
    state.roles = { admin: "admin" };
    expect(await call("admin", { flow: "fr_close" })).toEqual({
      success: false,
      error: "No running execution found",
    });
  });

  it("never reaches another workspace's flow", async () => {
    const theirs = await makeFlow({}, WS_THEIRS);
    await makeRun(theirs._id, "running", WS_THEIRS);
    state.roles = { admin: "admin" };
    const out = await call("admin", { flow: theirs._id.toString() });
    expect(out.success).toBe(false);
    expect(state.sent).toEqual([]);
  });
});
