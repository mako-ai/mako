/**
 * The reconciler is allowed to delete things, so the tests are mostly about
 * when it must NOT.
 *
 * Every case here pairs with its converse deliberately. "A stale tree does not
 * tear down" passes trivially in a reconciler that never tears anything down,
 * so it is worthless without "a verified tree does". The same discipline the
 * dbt stale-tip fix needed (#921), for a teardown that costs more: dropping a
 * flow or an entity disposes `CdcEntityState`, which holds `lastIngestSeq` and
 * `backfillCursor` — re-adding the file brings the flow back but re-backfills
 * from scratch, so this is the one path here that loses data rather than
 * churning rows.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  binding: null as null | { owner: string; repo: string },
  sent: [] as Array<{ name: string; data: unknown }>,
}));

vi.mock("../services/workspace-repos.service", () => ({
  getWorkspaceRepo: vi.fn(async () => state.binding),
  findWorkspaceIdByRepoBinding: vi.fn(async () => null),
}));
vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
// The teardown fires flow.cancel; observe it instead of reaching a real
// Inngest server.
vi.mock("../inngest/client", () => ({
  inngest: {
    send: vi.fn(async (event: { name: string; data: unknown }) => {
      state.sent.push(event);
    }),
  },
}));

import {
  CdcChangeEvent,
  CdcEntityState,
  Flow,
} from "../database/workspace-schema";
import { runGit } from "../apps/git";
import { DEFAULT_BRANCH, initRepo } from "../apps/repository.service";
import type { FlowFile } from "../services/flow-config-files";
import {
  dryRunFlowReconcile,
  reconcileFlowsFromRepo,
  type DesiredFlow,
} from "./flow-reconcile";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let remotesRoot: string;
let WS: Types.ObjectId;
let remoteDir: string;
let mirrorMain: string;
let repoSeq = 0;

const FILE: FlowFile = {
  name: "Close CRM",
  type: "scheduled",
  source: { type: "connector", connectorId: "close" },
  destination: { connectionId: new Types.ObjectId().toString() },
  sync: {},
};

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-reconcile-"));
  remotesRoot = path.join(tmpRoot, "remotes");
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotesRoot}`;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  WS = new Types.ObjectId();
  state.sent = [];
  state.binding = null;
  process.env.APPS_CONNECTED_REPO_PUSH = "allow";
  await Promise.all([
    Flow.deleteMany({}),
    CdcEntityState.deleteMany({}),
    CdcChangeEvent.deleteMany({}),
  ]);
  // A mirror whose main is a known sha, so a test can hand the reconciler
  // either that (current) or something else (stale).
  repoSeq += 1;
  remoteDir = path.join(remotesRoot, "acme", `flows${repoSeq}.git`);
  await fs.mkdir(path.dirname(remoteDir), { recursive: true });
  await initRepo(remoteDir, { "README.md": "x\n" });
  mirrorMain = (
    await runGit(["-C", remoteDir, "rev-parse", `refs/heads/${DEFAULT_BRANCH}`])
  ).stdout.trim();
  state.binding = { owner: "acme", repo: `flows${repoSeq}` };
});

async function seedFlow(slug: string, entityFilter?: string[]) {
  return Flow.create({
    workspaceId: WS,
    name: slug,
    slug,
    type: "scheduled",
    syncEngine: "cdc",
    streamState: "active",
    entityFilter,
    createdBy: "u1",
    // Required by the schema; irrelevant to what these cases assert.
    dataSourceId: new Types.ObjectId(),
    destinationDatabaseId: new Types.ObjectId(),
    schedule: { cron: "0 6 * * *", timezone: "Europe/Zurich" },
  });
}

function desiredOf(flow: { _id: Types.ObjectId; slug?: string }): DesiredFlow {
  return { slug: flow.slug!, file: FILE, flowId: flow._id.toString() };
}

describe("removal", () => {
  it("tears down a flow whose file is gone — at a verified tree", async () => {
    const kept = await seedFlow("kept");
    const gone = await seedFlow("gone");
    await CdcEntityState.create({
      workspaceId: WS,
      flowId: gone._id,
      entity: "leads",
      mode: "steady",
      lastIngestSeq: 42,
      lastMaterializedSeq: 42,
      backlogCount: 0,
      lifetimeEventsProcessed: 1,
      lifetimeRowsApplied: 1,
      mergeIntervalSeconds: 30,
      consecutiveFailures: 0,
    });

    const result = await reconcileFlowsFromRepo({
      workspaceId: WS.toString(),
      desired: [desiredOf(kept)],
      treeSha: mirrorMain,
    });

    expect(result.removed).toEqual(["gone"]);
    expect(result.deferred).toBeNull();
    expect(await Flow.findById(gone._id)).toBeNull();
    expect(await Flow.findById(kept._id)).not.toBeNull();
    // The cascade ran: state disposed, and the running work cancelled.
    expect(await CdcEntityState.countDocuments({ flowId: gone._id })).toBe(0);
    expect(state.sent.map(e => e.name)).toContain("flow.cancel");
  });

  it("does NOT tear down when the tree cannot be verified", async () => {
    const kept = await seedFlow("kept");
    const gone = await seedFlow("gone");
    await CdcEntityState.create({
      workspaceId: WS,
      flowId: gone._id,
      entity: "leads",
      mode: "steady",
      lastIngestSeq: 42,
      lastMaterializedSeq: 42,
      backlogCount: 0,
      lifetimeEventsProcessed: 1,
      lifetimeRowsApplied: 1,
      mergeIntervalSeconds: 30,
      consecutiveFailures: 0,
    });

    // A tree read at some other commit — what a stale or partial read looks
    // like from here.
    const result = await reconcileFlowsFromRepo({
      workspaceId: WS.toString(),
      desired: [desiredOf(kept)],
      treeSha: "0".repeat(40),
    });

    expect(result.removed).toEqual([]);
    expect(result.deferred?.removals).toEqual(["gone"]);
    expect(result.deferred?.reason).toMatch(/mirror/i);
    // The flow, its checkpoint, and its stream are all still there.
    expect(await Flow.findById(gone._id)).not.toBeNull();
    const survived = await CdcEntityState.findOne({ flowId: gone._id });
    expect(survived?.lastIngestSeq).toBe(42);
    expect(state.sent).toEqual([]);
  });

  it("treats an empty tree as 'nothing to say', never as 'delete everything'", async () => {
    const flow = await seedFlow("still-here");
    const result = await reconcileFlowsFromRepo({
      workspaceId: WS.toString(),
      desired: [],
      treeSha: mirrorMain,
    });
    expect(result.removed).toEqual([]);
    expect(await Flow.findById(flow._id)).not.toBeNull();
    expect(state.sent).toEqual([]);
  });
});

describe("entity selection", () => {
  it("drops an entity removed from the selection, and keeps the rest", async () => {
    const flow = await seedFlow("crm", ["leads"]);
    for (const entity of ["leads", "dropped"]) {
      await CdcEntityState.create({
        workspaceId: WS,
        flowId: flow._id,
        entity,
        mode: "steady",
        lastIngestSeq: 7,
        lastMaterializedSeq: 7,
        backlogCount: 0,
        lifetimeEventsProcessed: 1,
        lifetimeRowsApplied: 1,
        mergeIntervalSeconds: 30,
        consecutiveFailures: 0,
      });
    }

    const result = await reconcileFlowsFromRepo({
      workspaceId: WS.toString(),
      desired: [desiredOf(flow)],
      treeSha: mirrorMain,
    });

    expect(result.entitiesDropped).toEqual([
      { slug: "crm", entities: ["dropped"] },
    ]);
    const left = await CdcEntityState.find({ flowId: flow._id });
    expect(left.map(s => s.entity)).toEqual(["leads"]);
    // Paused to reconfigure, then put back the way it was found.
    const after = await Flow.findById(flow._id);
    expect(after?.streamState).toBe("active");
  });

  it("does NOT drop an entity when the tree cannot be verified", async () => {
    const flow = await seedFlow("crm", ["leads"]);
    await CdcEntityState.create({
      workspaceId: WS,
      flowId: flow._id,
      entity: "dropped",
      mode: "steady",
      lastIngestSeq: 7,
      lastMaterializedSeq: 7,
      backlogCount: 0,
      lifetimeEventsProcessed: 1,
      lifetimeRowsApplied: 1,
      mergeIntervalSeconds: 30,
      consecutiveFailures: 0,
    });

    const result = await reconcileFlowsFromRepo({
      workspaceId: WS.toString(),
      desired: [desiredOf(flow)],
      treeSha: "0".repeat(40),
    });

    expect(result.entitiesDropped).toEqual([]);
    expect(await CdcEntityState.countDocuments({ flowId: flow._id })).toBe(1);
  });

  it("leaves a flow with no explicit selection entirely alone", async () => {
    const flow = await seedFlow("everything"); // no entityFilter
    await CdcEntityState.create({
      workspaceId: WS,
      flowId: flow._id,
      entity: "anything",
      mode: "steady",
      lastIngestSeq: 1,
      lastMaterializedSeq: 1,
      backlogCount: 0,
      lifetimeEventsProcessed: 1,
      lifetimeRowsApplied: 1,
      mergeIntervalSeconds: 30,
      consecutiveFailures: 0,
    });
    const result = await reconcileFlowsFromRepo({
      workspaceId: WS.toString(),
      desired: [desiredOf(flow)],
      treeSha: mirrorMain,
    });
    expect(result.entitiesDropped).toEqual([]);
    expect(await CdcEntityState.countDocuments({ flowId: flow._id })).toBe(1);
  });
});

describe("pause ownership", () => {
  it("never resumes a pause somebody else took", async () => {
    const flow = await seedFlow("crm", ["leads"]);
    // A repartition holds this stream paused for its own reasons.
    flow.streamState = "paused";
    flow.syncStateMeta = { lastEvent: "REPARTITION_PAUSE" };
    await flow.save();
    await CdcEntityState.create({
      workspaceId: WS,
      flowId: flow._id,
      entity: "dropped",
      mode: "steady",
      lastIngestSeq: 3,
      lastMaterializedSeq: 3,
      backlogCount: 0,
      lifetimeEventsProcessed: 1,
      lifetimeRowsApplied: 1,
      mergeIntervalSeconds: 30,
      consecutiveFailures: 0,
    });

    await reconcileFlowsFromRepo({
      workspaceId: WS.toString(),
      desired: [desiredOf(flow)],
      treeSha: mirrorMain,
    });

    // The reconcile did its work but left the stream paused: resuming here
    // would restart a stream the repartition still needs stopped.
    const after = await Flow.findById(flow._id);
    expect(after?.streamState).toBe("paused");
  });
});

describe("dry run", () => {
  it("predicts exactly what the reconcile then does", async () => {
    // The property that makes a dry-run worth having: run it, run the real
    // thing, and they agree. Asserted against the SAME fixture rather than
    // two hand-written expectations, so the two cannot drift apart in a way
    // the test still accepts.
    const kept = await seedFlow("kept", ["leads"]);
    const gone = await seedFlow("gone");
    for (const [flow, entity] of [
      [kept, "leads"],
      [kept, "dropped"],
      [gone, "whatever"],
    ] as const) {
      await CdcEntityState.create({
        workspaceId: WS,
        flowId: flow._id,
        entity,
        mode: "steady",
        lastIngestSeq: 5,
        lastMaterializedSeq: 5,
        backlogCount: 0,
        lifetimeEventsProcessed: 1,
        lifetimeRowsApplied: 1,
        mergeIntervalSeconds: 30,
        consecutiveFailures: 0,
      });
    }
    const desired = [desiredOf(kept)];

    const plan = await dryRunFlowReconcile({
      workspaceId: WS.toString(),
      desired,
      treeSha: mirrorMain,
    });
    expect(plan.wouldTeardown).toEqual(["gone"]);
    expect(plan.wouldReconfigure).toEqual([
      { slug: "kept", entities: ["dropped"] },
    ]);
    expect(plan.guard).toEqual({ required: true, verdict: "verified" });

    const actual = await reconcileFlowsFromRepo({
      workspaceId: WS.toString(),
      desired,
      treeSha: mirrorMain,
    });
    expect(actual.removed).toEqual(plan.wouldTeardown);
    expect(actual.entitiesDropped).toEqual(plan.wouldReconfigure);
  });

  it("changes nothing at all", async () => {
    const kept = await seedFlow("kept", ["leads"]);
    const gone = await seedFlow("gone");
    await CdcEntityState.create({
      workspaceId: WS,
      flowId: kept._id,
      entity: "dropped",
      mode: "steady",
      lastIngestSeq: 9,
      lastMaterializedSeq: 9,
      backlogCount: 0,
      lifetimeEventsProcessed: 1,
      lifetimeRowsApplied: 1,
      mergeIntervalSeconds: 30,
      consecutiveFailures: 0,
    });

    await dryRunFlowReconcile({
      workspaceId: WS.toString(),
      desired: [desiredOf(kept)],
      treeSha: mirrorMain,
    });

    // Everything it said it WOULD do is still undone.
    expect(await Flow.findById(gone._id)).not.toBeNull();
    expect(await CdcEntityState.countDocuments({ flowId: kept._id })).toBe(1);
    expect((await Flow.findById(kept._id))?.streamState).toBe("active");
    expect(state.sent).toEqual([]);
  });

  it("answers before any row exists — the moment worth asking", async () => {
    // An agent about to push has files and no rows. Matching removals on the
    // row id alone would call every existing flow a teardown here.
    const existing = await seedFlow("already-there");
    const plan = await dryRunFlowReconcile({
      workspaceId: WS.toString(),
      desired: [
        { slug: "already-there", file: FILE },
        { slug: "brand-new", file: FILE },
      ],
      treeSha: mirrorMain,
    });
    expect(plan.wouldCreate).toEqual(["brand-new"]);
    expect(plan.wouldTeardown).toEqual([]);
    expect(await Flow.findById(existing._id)).not.toBeNull();
  });

  it("names the flow an omitted file would destroy", async () => {
    // The agent failure this exists for: not a typo — a typo fails to parse —
    // but a confidently incomplete tree that pushes and verifies fine.
    await seedFlow("stripe");
    await seedFlow("close");
    const plan = await dryRunFlowReconcile({
      workspaceId: WS.toString(),
      desired: [{ slug: "stripe", file: FILE }], // close/ left out
      treeSha: mirrorMain,
    });
    expect(plan.wouldTeardown).toEqual(["close"]);
  });

  it("reports the guard's refusal as an answer, not an error", async () => {
    await seedFlow("kept");
    await seedFlow("gone");
    const plan = await dryRunFlowReconcile({
      workspaceId: WS.toString(),
      desired: [{ slug: "kept", file: FILE }],
      treeSha: "0".repeat(40),
    });
    expect(plan.wouldTeardown).toEqual(["gone"]);
    expect(plan.guard.verdict).toBe("would-defer");
    expect(plan.guard.reason).toMatch(/mirror/i);
  });

  it("a settled workspace plans to do nothing", async () => {
    // The shape of the real first production run: every file present, most
    // with an explicit selection, nothing at risk.
    const flows = await Promise.all([
      seedFlow("a", ["x"]),
      seedFlow("b", ["y"]),
      seedFlow("c"),
    ]);
    for (const [flow, entity] of [
      [flows[0], "x"],
      [flows[1], "y"],
    ] as const) {
      await CdcEntityState.create({
        workspaceId: WS,
        flowId: flow._id,
        entity,
        mode: "steady",
        lastIngestSeq: 1,
        lastMaterializedSeq: 1,
        backlogCount: 0,
        lifetimeEventsProcessed: 1,
        lifetimeRowsApplied: 1,
        mergeIntervalSeconds: 30,
        consecutiveFailures: 0,
      });
    }
    const plan = await dryRunFlowReconcile({
      workspaceId: WS.toString(),
      desired: flows.map(desiredOf),
      treeSha: mirrorMain,
    });
    expect(plan).toEqual({
      wouldCreate: [],
      wouldReconfigure: [],
      wouldTeardown: [],
      guard: { required: false, verdict: "not-needed" },
    });
  });
});
