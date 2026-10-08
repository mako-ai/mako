/**
 * `syncFlowsFromRepo` against a real repo and a real Mongoose model.
 *
 * The existing `flow-sync.test.ts` asserts on the module's SOURCE TEXT. That
 * is how a create path that had never once worked stayed green: `createdBy`
 * is required on `FlowSchema`, `new Flow({ workspaceId, slug })` never set
 * it, and `save()` threw a ValidationError that escaped the per-file loop —
 * so the first NEW `flows/<slug>.yml` anyone pushed created no row, skipped
 * every file after it, skipped the reconciler, and logged one WARN. Every
 * production verification had been of EXISTING flows, where the row already
 * carried a `createdBy` from the UI.
 *
 * So these cases drive the real function: a bare repo, a commit on main, a
 * memory Mongo, and assertions on what rows exist afterwards.
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

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
// A stand-in mirror: when `mirror.main` is set, only that commit verifies
// as the mirror's main (what `assertTreeAtMirrorMain` would learn from
// `ls-remote`); unset, the real function runs (no mirror → every tree
// verifies, the local repo being the store).
const mirror = vi.hoisted(() => ({ main: null as string | null }));
vi.mock("../apps/cloud-repo.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../apps/cloud-repo.service")>();
  return {
    ...actual,
    assertTreeAtMirrorMain: async (workspaceId: string, sha: string) => {
      if (mirror.main === null) {
        return actual.assertTreeAtMirrorMain(workspaceId, sha);
      }
      if (sha !== mirror.main) {
        throw new actual.TreeNotVerifiedError(
          `Refusing: read at ${sha.slice(0, 8)} but the mirror's main is ${mirror.main.slice(0, 8)}`,
        );
      }
    },
  };
});
const inngestSent = vi.hoisted(() => [] as Array<{ name: string }>);
// A hook right before the stream reconcile: lets a test land a rename in the
// window between the sync reading its tree/rows and acting on them.
const reconcileHook = vi.hoisted(() => ({
  fn: null as null | (() => Promise<void>),
}));
vi.mock("../sync-cdc/flow-reconcile", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../sync-cdc/flow-reconcile")>();
  return {
    ...actual,
    reconcileFlowsFromRepo: async (
      input: Parameters<typeof actual.reconcileFlowsFromRepo>[0],
    ) => {
      const fn = reconcileHook.fn;
      reconcileHook.fn = null;
      if (fn) await fn();
      return actual.reconcileFlowsFromRepo(input);
    },
  };
});
vi.mock("../inngest/client", () => ({
  inngest: {
    send: vi.fn(async (event: { name: string }) => {
      inngestSent.push(event);
    }),
  },
}));

import {
  CdcEntityState,
  Flow,
  FlowExecution,
  WebhookEvent,
} from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../apps/repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../apps/bind-test-workspace-repo";
import {
  derivedFlowId,
  ensureFlowDerivedCache,
  isFlowMarkedInvalid,
  liveFlowToPlain,
  loadLiveFlowById,
  loadLiveFlows,
  resetFreshenOnMissThrottle,
  resolveLiveFlowRow,
  syncFlowsFromRepo,
} from "./flow-sync.service";
import { flowFilePath, parseFlowFile } from "./flow-config-files";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS: string;

const CONNECTOR = new Types.ObjectId().toString();
const DEST = new Types.ObjectId().toString();

/** A complete, loadable CDC flow in the on-disk (snake_case) format. */
function flowYaml(name: string, extra = ""): string {
  return [
    `name: ${name}`,
    "type: webhook",
    "source:",
    "  type: connector",
    `  connector_id: ${CONNECTOR}`,
    "destination:",
    `  connection_id: ${DEST}`,
    "  table:",
    "    schema: raw_close",
    "    create_if_not_exists: true",
    "backfill_schedule:",
    "  cron: 0 3 * * *",
    "  timezone: UTC",
    "webhook:",
    "  enabled: true",
    "sync:",
    "  mode: incremental",
    "  write_mode: append_dedup",
    "  engine: cdc",
    "entities:",
    "  layouts:",
    "    - entity: leads",
    "      partitionField: _syncedAt",
    "      partitionGranularity: day",
    "      enabled: true",
    extra,
    "",
  ].join("\n");
}

async function push(writes: Record<string, string>): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes },
    { message: "laptop push" },
  );
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-sync-repo-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  inngestSent.length = 0;
  mirror.main = null;
  // Cases that want the connected tier set this themselves; it must not
  // leak between cases (with it set and no reachable mirror, nothing
  // verifies, and teardowns are silently deferred).
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  delete process.env.APPS_GITHUB_REMOTE_BASE;
  resetFreshenOnMissThrottle();
  await Promise.all([
    Flow.deleteMany({}),
    CdcEntityState.deleteMany({}),
    FlowExecution.deleteMany({}),
    WebhookEvent.deleteMany({}),
  ]);
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

/** A commit that moves (and optionally edits) a flow file, like a laptop `git mv`. */
async function move(from: string, to: string, contents: string): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes: { [flowFilePath(to)]: contents }, deletes: [flowFilePath(from)] },
    { message: `git mv ${from} ${to}` },
  );
}

/** Rows keyed by the flow id — the state a teardown would dispose. */
async function seedRuntime(flowId: Types.ObjectId): Promise<void> {
  const workspaceId = new Types.ObjectId(WS);
  await CdcEntityState.create({
    workspaceId,
    flowId,
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
  await FlowExecution.create({
    workspaceId,
    flowId,
    startedAt: new Date(),
    status: "completed",
    success: true,
  });
  await WebhookEvent.create({
    workspaceId,
    flowId,
    eventId: "evt_1",
    eventType: "lead.created",
    status: "completed",
    rawPayload: { id: 1 },
    applyStatus: "applied",
  });
}

async function runtimeCounts(flowId: Types.ObjectId): Promise<number[]> {
  return Promise.all([
    CdcEntityState.countDocuments({ flowId }),
    FlowExecution.countDocuments({ flowId }),
    WebhookEvent.countDocuments({ flowId }),
  ]);
}

describe("markers, reverts, and resolution", () => {
  it("an unset marker is not 'invalid': an unbound workspace's run is not refused", async () => {
    await push({ "flows/marker.yml": flowYaml("Marker") });
    await syncFlowsFromRepo(WS, "user-42");
    const row = await Flow.findOne({ workspaceId: WS, slug: "marker" });
    expect(row).not.toBeNull();
    // Mongoose materialises the unset nested path as `{}` on a hydrated
    // doc; `if (row.definitionInvalid)` used to read that as invalid.
    expect(isFlowMarkedInvalid(row!)).toBe(false);
    const plain = liveFlowToPlain(
      (await loadLiveFlows(WS)).find(item => item.def.slug === "marker")!,
      WS,
    );
    expect(plain.definitionInvalid).toBeUndefined();
    await unbindTestWorkspaceRepo(WS);
    expect(await ensureFlowDerivedCache(row!)).toBe("ok");
  });

  it("a broken file is marked once; reverting to identical content clears it in push-sync", async () => {
    const good = flowYaml("Revertable");
    await push({ "flows/revertable.yml": good });
    await syncFlowsFromRepo(WS, "user-42");
    await push({ "flows/revertable.yml": "name: [broken" });
    await loadLiveFlows(WS);
    const marked = await Flow.findOne({ workspaceId: WS, slug: "revertable" });
    expect(marked?.definitionInvalid?.reason).toBe("unparseable flow file");
    const at = marked?.definitionInvalid?.at;
    await loadLiveFlows(WS);
    expect(
      (await Flow.findOne({ workspaceId: WS, slug: "revertable" }))
        ?.definitionInvalid?.at,
    ).toEqual(at);
    await push({ "flows/revertable.yml": good });
    const result = await syncFlowsFromRepo(WS, "user-42");
    expect(result.invalid).toEqual([]);
    expect(
      (await Flow.findOne({ workspaceId: WS, slug: "revertable" }))
        ?.definitionInvalid?.reason,
    ).toBeUndefined();
  });

  it("resolves a git-only flow as 409, a synced one as ok, a deleted file as 404; the stub is whole", async () => {
    await push({ "flows/only-git.yml": flowYaml("Only git") });
    const live = await loadLiveFlows(WS);
    const id = live.find(item => item.def.slug === "only-git")!.id.toString();
    const gitOnly = await resolveLiveFlowRow(WS, id);
    expect(gitOnly.ok).toBe(false);
    if (!gitOnly.ok) expect(gitOnly.status).toBe(409);

    await syncFlowsFromRepo(WS, "user-42");
    const synced = await resolveLiveFlowRow(WS, id);
    expect(synced.ok).toBe(true);

    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { deletes: ["flows/only-git.yml"] },
      { message: "laptop delete" },
    );
    const gone = await resolveLiveFlowRow(WS, id);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.status).toBe(404);

    await push({ "flows/broken-stub.yml": "name: [broken" });
    const stub = liveFlowToPlain(
      (await loadLiveFlows(WS)).find(item => item.def.slug === "broken-stub")!,
      WS,
    );
    expect(stub).toMatchObject({
      name: "broken-stub",
      syncMode: "full",
      enabled: false,
    });
    expect(stub.createdAt).toBeInstanceOf(Date);
    expect(
      (stub.definitionInvalid as { reason?: string } | undefined)?.reason,
    ).toBe("unparseable flow file");
  });
});

describe("a NEW flow file creates a row", () => {
  it("through Mako's git endpoint, authored by whoever pushed", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });

    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.created).toBe(1);
    expect(result.invalid).toEqual([]);
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(row).not.toBeNull();
    expect(row!.createdBy).toBe("user-42");
    expect(row!.type).toBe("webhook");
    expect(row!._id.toString()).toBe(
      derivedFlowId(WS, "close-to-bigquery").toString(),
    );
    expect(row!.syncEngine).toBe("cdc");
    expect(row!.backfillSchedule?.enabled).toBe(true);
    expect(row!.backfillSchedule?.cron).toBe("0 3 * * *");
    // #939: a file-born webhook flow is addressable, and derives from the id.
    expect(row!.webhookConfig?.endpoint).toContain(`/${WS}/${row!._id}`);
    // …and never carries a secret from the file (that is a credential).
    expect(row!.webhookConfig?.secret).toBeFalsy();
  });

  it("from a push made directly on GitHub, with no actor to attribute", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });

    // routes/github.routes.ts calls syncRepoBackedResources(workspaceId) with
    // no userId — the webhook does not carry a Mako user.
    const result = await syncFlowsFromRepo(WS);

    expect(result.created).toBe(1);
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    // Same author the dbt job sync uses for the same situation.
    expect(row?.createdBy).toBe("sync");
  });

  it("is idempotent: the second sync of the same tree touches nothing", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    const again = await syncFlowsFromRepo(WS, "user-42");
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });
});

describe("one bad file is that file's problem", () => {
  it("a file that parses but cannot be saved does not stop the others", async () => {
    await push({
      // Sorted first by the tree walk, so it fails BEFORE the good one.
      "flows/a-bad-one.yml": flowYaml("Bad").replace(
        "write_mode: append_dedup",
        "write_mode: not_a_real_mode", // outside the schema enum → save() throws
      ),
      "flows/z-good-one.yml": flowYaml("Good"),
    });

    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["a-bad-one"]);
    expect(result.created).toBe(1);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(1);
    expect(
      await Flow.findOne({ workspaceId: WS, slug: "z-good-one" }),
    ).not.toBeNull();
  });

  it("a connector NAME where an id belongs is refused, not thrown", async () => {
    await push({
      "flows/a-by-name.yml": flowYaml("By name").replace(
        `connector_id: ${CONNECTOR}`,
        "connector_id: close", // not an ObjectId → new ObjectId() throws
      ),
      "flows/z-good-one.yml": flowYaml("Good"),
    });

    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["a-by-name"]);
    expect(result.created).toBe(1);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(1);
  });

  it("a YAML typo in an EXISTING flow's file is a no-op, not a teardown", async () => {
    // The definition half always "kept the current row" for an unparseable
    // file. The stream half did not: the row was left out of the desired set,
    // the reconciler read that absence as a removal, and — guard permitting —
    // tore the flow down and disposed its checkpoints. So `deferred` is the
    // tell here: a reconciler that WANTS the removal but cannot verify the
    // tree reports it there; one that never wanted it reports nothing.
    await push({
      "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery"),
      "flows/other.yml": flowYaml("Other"),
    });
    await syncFlowsFromRepo(WS, "user-42");
    const before = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });

    await push({ "flows/close-to-bigquery.yml": "name: [broken\n" });
    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["close-to-bigquery"]);
    expect(result.deferred).toEqual([]);
    const after = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(after).not.toBeNull();
    expect(after!.name).toBe(before!.name);
    expect(after!.sourceBlobSha).toBe(before!.sourceBlobSha);
    expect(after!.definitionInvalid?.reason).toMatch(/unparseable/i);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(2);
  });

  it("a failed save on an EXISTING row keeps that row as it was", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    const before = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });

    await push({
      "flows/close-to-bigquery.yml": flowYaml("Renamed").replace(
        "write_mode: append_dedup",
        "write_mode: not_a_real_mode",
      ),
    });
    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["close-to-bigquery"]);
    const after = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(after!.name).toBe(before!.name);
    expect(after!.writeMode).toBe(before!.writeMode);
    expect(after!.sourceBlobSha).toBe(before!.sourceBlobSha);
    // …and says why, as GET's resync does, recording the blob it saw so a
    // UI save may fix exactly that version.
    expect(isFlowMarkedInvalid(after!)).toBe(true);
    expect(after!.lastSeenBlobSha).not.toBe(before!.sourceBlobSha);
  });
});

describe("GET/list from git", () => {
  it("serves the file at main when the Mongo row has no definition body", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(row).not.toBeNull();
    await Flow.updateOne(
      { _id: row!._id },
      { $set: { name: "", queries: [] } },
    );
    const stale = await Flow.findById(row!._id);
    expect(stale?.name).toBe("");

    const listed = await loadLiveFlows(WS);
    expect(listed).toHaveLength(1);
    const plain = liveFlowToPlain(listed[0], WS);
    expect(plain.name).toBe("Close → BigQuery");
    expect(plain.syncEngine).toBe("cdc");

    const got = await loadLiveFlowById(WS, row!._id.toString());
    expect(got).not.toBeNull();
    expect(liveFlowToPlain(got!, WS).name).toBe("Close → BigQuery");
  });

  it("resyncs a stale sourceBlobSha from the blob at main", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    await Flow.updateOne(
      { workspaceId: WS, slug: "close-to-bigquery" },
      { $set: { name: "stale-mongo", sourceBlobSha: "deadbeef" } },
    );

    const listed = await loadLiveFlows(WS);
    expect(liveFlowToPlain(listed[0], WS).name).toBe("Close → BigQuery");
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(row?.name).toBe("Close → BigQuery");
    expect(row?.sourceBlobSha).not.toBe("deadbeef");
  });

  it("lists a git file that has no Mongo row", async () => {
    await push({ "flows/from-laptop.yml": flowYaml("From laptop") });
    const listed = await loadLiveFlows(WS);
    expect(listed.map(item => item.def.slug)).toEqual(["from-laptop"]);
    expect(listed[0].row).toBeNull();
    expect(listed[0].id.toString()).toBe(
      derivedFlowId(WS, "from-laptop").toString(),
    );
    expect(liveFlowToPlain(listed[0], WS).name).toBe("From laptop");
    const got = await loadLiveFlowById(WS, listed[0].id.toString());
    expect(got?.def.slug).toBe("from-laptop");
  });

  it("does not list a Mongo row that has no git file", async () => {
    await Flow.create({
      workspaceId: WS,
      slug: "mongo-only",
      name: "should-not-appear",
      type: "webhook",
      sourceType: "connector",
      dataSourceId: CONNECTOR,
      destinationDatabaseId: DEST,
      syncEngine: "cdc",
      createdBy: "user-42",
    });
    const listed = await loadLiveFlows(WS);
    expect(listed.map(item => item.def.slug)).not.toContain("mongo-only");
    const row = await Flow.findOne({ workspaceId: WS, slug: "mongo-only" });
    expect(row).not.toBeNull();
    expect(await loadLiveFlowById(WS, row!._id.toString())).toBeNull();
  });

  it("does not throw when a file at main parses but fails schema save", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    await push({
      "flows/close-to-bigquery.yml": flowYaml("Renamed").replace(
        "write_mode: append_dedup",
        "write_mode: not_a_real_mode",
      ),
    });

    // GET/list must not 500 the explorer because one file is unsavable.
    // syncFlowsFromRepo already swallows this; ensureFlowDerivedCache did not.
    await expect(loadLiveFlows(WS)).resolves.toHaveLength(1);
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(row?.name).toBe("Close → BigQuery");
    expect(row?.writeMode).toBe("append_dedup");
    expect(row?.definitionInvalid?.reason).toMatch(
      /writeMode|write_mode|enum/i,
    );
  });

  it("does not serve a schema-invalid file as a live definition", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    await push({
      "flows/close-to-bigquery.yml": flowYaml("Renamed").replace(
        "write_mode: append_dedup",
        "write_mode: not_a_real_mode",
      ),
    });

    const listed = await loadLiveFlows(WS);
    const plain = liveFlowToPlain(listed[0], WS);
    // Git is the store, but a file the reactor cannot save must not be
    // applied over the last-good row or look valid in GET/list.
    expect(plain.definitionInvalid).toBeTruthy();
    expect(plain.name).toBe("Close → BigQuery");
    expect(plain.writeMode).toBe("append_dedup");
  });

  it("does not 500 GET/list when one file's connector_id is not an ObjectId", async () => {
    await push({
      "flows/a-by-name.yml": flowYaml("By name").replace(
        `connector_id: ${CONNECTOR}`,
        "connector_id: close",
      ),
      "flows/z-good-one.yml": flowYaml("Good"),
    });

    await expect(loadLiveFlows(WS)).resolves.toHaveLength(2);
    const plains = (await loadLiveFlows(WS)).map(item =>
      liveFlowToPlain(item, WS),
    );
    const bad = plains.find(item => item.slug === "a-by-name");
    const good = plains.find(item => item.slug === "z-good-one");
    expect(bad?.definitionInvalid).toBeTruthy();
    expect(good?.name).toBe("Good");
    expect(good?.definitionInvalid).toBeUndefined();
  });

  it("does not list leftover local git or Mongo when no GitHub repo is bound", async () => {
    await push({ "flows/leftover.yml": flowYaml("Leftover") });
    await syncFlowsFromRepo(WS, "user-42");
    expect((await loadLiveFlows(WS)).map(item => item.def.slug)).toEqual([
      "leftover",
    ]);
    const row = await Flow.findOne({ workspaceId: WS, slug: "leftover" });
    expect(row).not.toBeNull();

    await unbindTestWorkspaceRepo(WS);
    expect(await loadLiveFlows(WS)).toEqual([]);
    expect(await loadLiveFlowById(WS, row!._id.toString())).toBeNull();
    expect(await Flow.findById(row!._id)).not.toBeNull();
    const leftoverHead = await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    );
    expect(leftoverHead).toBeTruthy();
    const leftoverFile = await readBlob(
      repoDirFor(WS),
      leftoverHead as string,
      "flows/leftover.yml",
    );
    expect(leftoverFile.contents).toContain("name: Leftover");
    expect(row!.sourceBlobSha).toBe(blobOid(leftoverFile.contents));
  });
});

describe("a moved file is the same flow (graceful rename)", () => {
  it("an added file whose aliases name the removed slug re-keys the row in place: id, checkpoints, executions, webhook URL survive", async () => {
    await push({ "flows/close-crm.yml": flowYaml("Close CRM") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-crm" });
    expect(row).not.toBeNull();
    const endpoint = row!.webhookConfig?.endpoint;
    expect(endpoint).toContain(`/api/webhooks/${WS}/${row!._id.toString()}`);
    await seedRuntime(row!._id);

    await move(
      "close-crm",
      "crm-sync",
      flowYaml("Close CRM (renamed)", "aliases: [close-crm]"),
    );
    const result = await syncFlowsFromRepo(WS, "u1");
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);

    const after = await Flow.findById(row!._id);
    expect(after).not.toBeNull();
    expect(after!.slug).toBe("crm-sync");
    expect(after!.name).toBe("Close CRM (renamed)");
    expect(after!.aliases).toEqual(["close-crm"]);
    expect(after!.webhookConfig?.endpoint).toBe(endpoint);
    expect(await runtimeCounts(row!._id)).toEqual([1, 1, 1]);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(1);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");

    // The id GET/list handed out for the new file before the push synced
    // still opens this flow, and so does the row's own id.
    const derived = derivedFlowId(WS, "crm-sync").toString();
    expect((await loadLiveFlowById(WS, derived))?.id.toString()).toBe(
      row!._id.toString(),
    );
    expect((await loadLiveFlowById(WS, row!._id.toString()))?.def.slug).toBe(
      "crm-sync",
    );
  });

  it("git rename detection pairs a file that was moved AND edited in one commit", async () => {
    await push({ "flows/stripe.yml": flowYaml("Stripe") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "stripe" });
    await seedRuntime(row!._id);

    // No aliases, and the cron changed, so neither rule 1 nor rule 3 fits.
    await move(
      "stripe",
      "stripe-warehouse",
      flowYaml("Stripe").replace("cron: 0 3 * * *", "cron: 0 9 * * *"),
    );
    await syncFlowsFromRepo(WS, "u1");
    const after = await Flow.findById(row!._id);
    expect(after?.slug).toBe("stripe-warehouse");
    expect(after?.aliases).toEqual(["stripe"]);
    expect(after?.backfillSchedule?.cron).toBe("0 9 * * *");
    expect(await runtimeCounts(row!._id)).toEqual([1, 1, 1]);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(1);
  });

  it("identical content under a new file name is a rename, and the alias then rides in the write-through", async () => {
    await push({ "flows/hubspot.yml": flowYaml("HubSpot") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "hubspot" });
    await move("hubspot", "hubspot-v2", flowYaml("HubSpot v2"));
    await syncFlowsFromRepo(WS, "u1");
    const after = await Flow.findById(row!._id);
    expect(after?.slug).toBe("hubspot-v2");
    expect(after?.aliases).toEqual(["hubspot"]);
    // The projection the write-through commits carries the alias, so a
    // later product edit never drops it from the file.
    const { flowToFile, serializeFlowFile } = await import(
      "./flow-config-files"
    );
    expect(serializeFlowFile(flowToFile(after!))).toContain(
      "aliases:\n  - hubspot",
    );
  });

  it("two candidates are never guessed: the old flow is torn down as before", async () => {
    await push({ "flows/pipedrive.yml": flowYaml("Pipedrive") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "pipedrive" });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "flows/pd-a.yml": flowYaml("A", "aliases: [pipedrive]"),
          "flows/pd-b.yml": flowYaml("B", "aliases: [pipedrive]"),
        },
        deletes: ["flows/pipedrive.yml"],
      },
      { message: "ambiguous" },
    );
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const result = await syncFlowsFromRepo(WS, "u1");
    expect(result.created).toBe(2);
    // Torn down (or deferred behind the mirror guard) — never re-keyed.
    const old = await Flow.findById(row!._id);
    expect(old === null || old.slug === "pipedrive").toBe(true);
    expect(
      await Flow.countDocuments({
        workspaceId: WS,
        slug: { $in: ["pd-a", "pd-b"] },
      }),
    ).toBe(2);
    const holders: string[] = [];
    for (const slug of ["pd-a", "pd-b"]) {
      const created = await Flow.findOne({ workspaceId: WS, slug });
      expect(created!._id.toString()).not.toBe(row!._id.toString());
      if (created!.aliases?.includes("pipedrive")) holders.push(slug);
    }
    // An alias is never claimed twice — and here `pipedrive` is still the
    // doomed row's CURRENT slug when the two newcomers are created, so
    // neither may take it (current always wins). Nothing guesses: the old
    // name resolves to no flow at all rather than to the wrong one.
    expect(holders).toHaveLength(0);
    const { resolveFlowRef } = await import("../rename/flow-rename");
    const doomed = await Flow.findById(row!._id);
    if (doomed === null) {
      expect(await resolveFlowRef({ workspaceId: WS }, "pipedrive")).toBeNull();
    }
  });

  it("[review 1] a deleted flow and an added DIFFERENT flow are never paired, however alike their YAML", async () => {
    const CH = new Types.ObjectId().toString();
    const FR = new Types.ObjectId().toString();
    const yaml = (name: string, conn: string, schema: string) =>
      flowYaml(name)
        .replace(`connector_id: ${CONNECTOR}`, `connector_id: ${conn}`)
        .replace("schema: raw_close", `schema: ${schema}`);
    await push({ "flows/close-ch.yml": yaml("Close CH", CH, "raw_close_ch") });
    await syncFlowsFromRepo(WS, "u1");
    const ch = await Flow.findOne({ workspaceId: WS, slug: "close-ch" });
    await seedRuntime(ch!._id);

    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    await move("close-ch", "close-fr", yaml("Close FR", FR, "raw_close_fr"));
    const result = await syncFlowsFromRepo(WS, "u1");
    expect(result.created).toBe(1);
    const fr = await Flow.findOne({ workspaceId: WS, slug: "close-fr" });
    expect(fr).not.toBeNull();
    expect(fr!._id.toString()).not.toBe(ch!._id.toString());
    expect(fr!.aliases ?? []).toEqual([]);
    expect(String(fr!.dataSourceId)).toBe(FR);
    // FR starts from nothing (it will backfill). CH was NOT re-keyed: it is
    // torn down as before — or, in this rig without a mirror to verify
    // against, deferred by the fail-closed guard — never handed to FR.
    expect(await runtimeCounts(fr!._id)).toEqual([0, 0, 0]);
    const chAfter = await Flow.findById(ch!._id);
    if (chAfter === null) {
      expect(inngestSent.map(e => e.name)).toContain("flow.cancel");
    } else {
      expect(chAfter.slug).toBe("close-ch");
      expect(result.deferred).toEqual(["close-ch"]);
      expect(await runtimeCounts(ch!._id)).toEqual([1, 1, 1]);
    }
  });

  it("[review 2] a new file at a renamed git-born flow's OLD slug is a new flow with its own id; current wins over the alias", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const { resolveFlowRef } = await import("../rename/flow-rename");
    await push({ "flows/foo.yml": flowYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");
    const foo = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    expect(foo!._id.toString()).toBe(derivedFlowId(WS, "foo").toString());
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "foo", slug: "bar" },
    );

    // Before the new file syncs: a live file at main beats an alias.
    await push({ "flows/foo.yml": flowYaml("Foo again") });
    const gitOnly = await resolveFlowRef({ workspaceId: WS }, "foo");
    expect(gitOnly?.via).toBe("current");
    expect(gitOnly?.id).not.toBe(foo!._id.toString());
    const listedBefore = await loadLiveFlows(WS);
    expect(new Set(listedBefore.map(l => l.id.toString())).size).toBe(2);
    expect(listedBefore.find(l => l.def.slug === "foo")?.id.toString()).toBe(
      gitOnly?.id,
    );

    const result = await syncFlowsFromRepo(WS, "u1");
    expect(result.created).toBe(1);
    expect(result.invalid).toEqual([]);
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows).toHaveLength(2);
    const bar = rows.find(r => r.slug === "bar");
    const fooAgain = rows.find(r => r.slug === "foo");
    expect(bar!._id.toString()).toBe(foo!._id.toString());
    expect(fooAgain!._id.toString()).not.toBe(foo!._id.toString());
    // The id GET handed out before the push is the one the row got.
    expect(fooAgain!._id.toString()).toBe(gitOnly?.id);
    // Current always wins: bar no longer answers to "foo".
    expect(bar!.aliases ?? []).toEqual([]);
    expect(fooAgain!.name).toBe("Foo again");
    const listed = await loadLiveFlows(WS);
    expect(new Set(listed.map(l => l.id.toString())).size).toBe(2);
    expect(
      (await loadLiveFlowById(WS, fooAgain!._id.toString()))?.def.slug,
    ).toBe("foo");
    const resolved = await resolveFlowRef({ workspaceId: WS }, "foo");
    expect(resolved?.id).toBe(fooAgain!._id.toString());
    expect(resolved?.via).toBe("current");
    expect((await resolveFlowRef({ workspaceId: WS }, "bar"))?.id).toBe(
      foo!._id.toString(),
    );
  });

  it("[review 3c] a tree read before a rename commit neither recreates the old slug nor renames back", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const { runGit } = await import("../apps/git");
    await push({ "flows/x.yml": flowYaml("X") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "x" });
    await seedRuntime(row!._id);
    const before = await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    );
    const renamed = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "x", slug: "y" },
    );
    expect((await Flow.findById(row!._id))?.lastRenameCommit).toBe(
      renamed.commit,
    );

    // The race: files as they were before the rename commit, rows after
    // the row was re-keyed. Reproduced by winding main back.
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      before as string,
    ]);
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const stale = await syncFlowsFromRepo(WS, "u1");
    expect(stale.created).toBe(0);
    expect(stale.deferred).toEqual([]);
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("y");
    expect(rows[0]._id.toString()).toBe(row!._id.toString());
    expect(await runtimeCounts(row!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");

    // Once the tree contains the rename, everything is level.
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      renamed.commit as string,
    ]);
    const level = await syncFlowsFromRepo(WS, "u1");
    expect(level).toMatchObject({ created: 0, unchanged: 1 });
    expect((await Flow.find({ workspaceId: WS })).map(r => r.slug)).toEqual([
      "y",
    ]);
  });

  it("[review 4] a copied file does not copy the alias: one claimant keeps it, old links keep working", async () => {
    const { validateFlowFile } = await import("./flow-validate.service");
    const { resolveFlowRef } = await import("../rename/flow-rename");
    await push({ "flows/orig.yml": flowYaml("Orig", "aliases: [legacy]") });
    await syncFlowsFromRepo(WS, "u1");
    const orig = await Flow.findOne({ workspaceId: WS, slug: "orig" });
    expect(orig!.aliases).toEqual(["legacy"]);

    // Validation warns before the push…
    const copyYaml = flowYaml("Copy", "aliases: [legacy]");
    const validation = await validateFlowFile({
      workspaceId: WS,
      path: "flows/copy.yml",
      contents: copyYaml,
    });
    // (`ok` is false here only because this rig seeds no connection rows for
    // the referential layer; the alias note is what this case is about.)
    expect(
      validation.problems.some(p =>
        p.reason.startsWith("note: alias `legacy` already belongs"),
      ),
    ).toBe(true);

    // …and the sync keeps the alias where it was.
    await push({ "flows/copy.yml": copyYaml });
    await syncFlowsFromRepo(WS, "u1");
    const copy = await Flow.findOne({ workspaceId: WS, slug: "copy" });
    expect(copy!.aliases ?? []).toEqual([]);
    expect((await Flow.findById(orig!._id))?.aliases).toEqual(["legacy"]);
    const resolved = await resolveFlowRef({ workspaceId: WS }, "legacy");
    expect(resolved).toMatchObject({ id: orig!._id.toString(), via: "alias" });

    // A NEW file at a name some flow holds as an alias is flagged too.
    const taking = await validateFlowFile({
      workspaceId: WS,
      path: "flows/legacy.yml",
      contents: flowYaml("Legacy reborn"),
    });
    expect(
      taking.problems.some(p =>
        p.reason.startsWith("note: `legacy` is an old name of flow"),
      ),
    ).toBe(true);
  });

  it("renaming back to an old name keeps the current slug out of the aliases", async () => {
    await push({ "flows/one.yml": flowYaml("One") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "one" });
    await move("one", "two", flowYaml("One", "aliases: [one]"));
    await syncFlowsFromRepo(WS, "u1");
    await move("two", "one", flowYaml("One", "aliases: [two, one]"));
    await syncFlowsFromRepo(WS, "u1");
    const after = await Flow.findById(row!._id);
    expect(after?.slug).toBe("one");
    expect(after?.aliases).toEqual(["two"]);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(1);
  });
});

describe("round 2: lost and racing renames", () => {
  it("[r2-1] a rename landing while a push sync runs is not undone and not torn down (flows: the reconciler honours ids)", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    await push({ "flows/nightly.yml": flowYaml("Nightly") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "nightly" });
    await seedRuntime(row!._id);
    // A laptop push edits the file; the UI rename lands while that push is
    // being synced (after the rows were read, before the reconcile).
    await push({ "flows/nightly.yml": flowYaml("Nightly v2") });
    reconcileHook.fn = async () => {
      await flowRenameHandler.rename(
        { workspaceId: WS },
        { ref: "nightly", slug: "nightly-2" },
      );
    };
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const result = await syncFlowsFromRepo(WS, "u1");
    expect(result.deferred).toEqual([]);
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(rows[0]._id.toString()).toBe(row!._id.toString());
    expect(rows[0].slug).toBe("nightly-2");
    expect(await runtimeCounts(row!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
    // The next sync (tree now contains the rename) changes nothing.
    const next = await syncFlowsFromRepo(WS, "u1");
    expect(next).toMatchObject({ created: 0, unchanged: 1 });
    expect((await Flow.find({ workspaceId: WS })).map(r => r.slug)).toEqual([
      "nightly-2",
    ]);
  });

  it("[r2-3] a rename commit that never reaches main is honoured for a while, then the tree wins: re-keyed back, edits applied, same id", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const { resolveFlowRef } = await import("../rename/flow-rename");
    const { runGit } = await import("../apps/git");
    await push({ "flows/foo.yml": flowYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    await seedRuntime(row!._id);
    const pre = await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    );
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "foo", slug: "bar" },
    );
    // The mirror never got the rename commit; a divergence reset parks it.
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre as string,
    ]);
    // The laptop edit changes the name and the cron — NOT the source or the
    // destination: a file under the old name pointing somewhere else is a
    // different stream and would not be re-keyed onto this row (cycle 2 #5).
    await push({
      "flows/foo.yml": flowYaml("Foo edited on laptop").replace(
        "cron: 0 3 * * *",
        "cron: 0 9 * * *",
      ),
    });

    // Within the window: the row is kept as renamed, nothing created.
    // (No mirror here, so the tree verifies as current — the case where
    // the expired guard is resolved by the tree rather than kept.)
    const early = await syncFlowsFromRepo(WS, "u1");
    expect(early.created).toBe(0);
    expect((await Flow.find({ workspaceId: WS })).map(r => r.slug)).toEqual([
      "bar",
    ]);

    // After the window: the commit is still not on main → it never landed.
    await Flow.updateOne(
      { _id: row!._id },
      { $set: { lastRenameAt: new Date(Date.now() - 11 * 60_000) } },
    );
    const late = await syncFlowsFromRepo(WS, "u1");
    expect(late.created).toBe(0);
    expect(late.updated).toBe(1);
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(rows[0]._id.toString()).toBe(row!._id.toString());
    expect(rows[0].slug).toBe("foo");
    expect(rows[0].name).toBe("Foo edited on laptop");
    expect(rows[0].backfillSchedule?.cron).toBe("0 9 * * *");
    expect(rows[0].lastRenameCommit).toBeUndefined();
    // "bar" never existed on main: nothing linked to it, so it is not an
    // alias now (and "foo" is the current slug, so not one either).
    expect(rows[0].aliases ?? []).toEqual([]);
    expect(await runtimeCounts(row!._id)).toEqual([1, 1, 1]);
    const live = await loadLiveFlows(WS);
    expect(live.map(l => [l.def.slug, l.row?._id.toString()])).toEqual([
      ["foo", row!._id.toString()],
    ]);
    expect(await resolveFlowRef({ workspaceId: WS }, "foo")).toMatchObject({
      id: row!._id.toString(),
      via: "current",
    });
    // Idempotent afterwards.
    expect(await syncFlowsFromRepo(WS, "u1")).toMatchObject({
      created: 0,
      unchanged: 1,
    });
  });

  it("[r2-3] after a history rewrite that kept the tree, a laptop rename of a renamed flow is still a rename", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const { runGit } = await import("../apps/git");
    await push({ "flows/foo.yml": flowYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    await seedRuntime(row!._id);
    const pre = await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    );
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "foo", slug: "bar" },
    );
    // Squash: same tree, a new commit on top of `pre`.
    const dir = repoDirFor(WS);
    const tree = (
      await runGit(["-C", dir, "rev-parse", `${DEFAULT_BRANCH}^{tree}`])
    ).stdout.trim();
    const squashed = (
      await runGit([
        "-C",
        dir,
        "-c",
        "user.name=x",
        "-c",
        "user.email=x@x",
        "commit-tree",
        tree,
        "-p",
        pre as string,
        "-m",
        "squashed",
      ])
    ).stdout.trim();
    await runGit([
      "-C",
      dir,
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      squashed,
    ]);
    await syncFlowsFromRepo(WS, "u1");
    expect((await Flow.findById(row!._id))?.lastRenameCommit).toBeUndefined();

    const head = await resolveCommit(dir, `refs/heads/${DEFAULT_BRANCH}`);
    const contents = (await readBlob(dir, head as string, "flows/bar.yml"))
      .contents;
    await move("bar", "baz", contents);
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const result = await syncFlowsFromRepo(WS, "u1");
    expect(result.created).toBe(0);
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows).toHaveLength(1);
    expect(rows[0]._id.toString()).toBe(row!._id.toString());
    expect(rows[0].slug).toBe("baz");
    expect(await runtimeCounts(row!._id)).toEqual([1, 1, 1]);
  });

  it("[r2-5] a row with aliases but no recorded rename gets no stale-tree benefit of the doubt", async () => {
    await push({ "flows/bar.yml": flowYaml("Bar", "aliases: [foo]") });
    await syncFlowsFromRepo(WS, "u1");
    const bar = await Flow.findOne({ workspaceId: WS, slug: "bar" });
    expect(bar!.aliases).toEqual(["foo"]);
    expect(bar!.lastRenameCommit).toBeUndefined();
    // Delete bar.yml, add an unrelated foo.yml (different target).
    const OTHER = new Types.ObjectId().toString();
    await move(
      "bar",
      "foo",
      flowYaml("Foo").replace(
        `connector_id: ${CONNECTOR}`,
        `connector_id: ${OTHER}`,
      ),
    );
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const result = await syncFlowsFromRepo(WS, "u1");
    expect(result.created).toBe(1);
    const foo = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    expect(foo).not.toBeNull();
    expect(foo!._id.toString()).not.toBe(bar!._id.toString());
    const barAfter = await Flow.findById(bar!._id);
    // Torn down, or deferred by the mirror guard in this rig — and in
    // either case no longer answering to "foo".
    if (barAfter) {
      expect(result.deferred).toEqual(["bar"]);
      expect(barAfter.aliases ?? []).toEqual([]);
    }
  });
});

describe("round 3: fixing a broken file from the UI", () => {
  it("[r3-1] a broken laptop push is marked with the blob seen; a UI save then overwrites exactly that and clears the marker", async () => {
    const { commitFlowFile } = await import("./flow-config.service");
    await push({ "flows/x.yml": flowYaml("X") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "x" });
    const good = row!.sourceBlobSha;

    // Laptop pushes a broken version: the row keeps its last valid
    // definition but records the blob it SAW.
    const broken = "name: [unclosed";
    await push({ "flows/x.yml": broken });
    const sync = await syncFlowsFromRepo(WS, "u1");
    expect(sync.invalid).toEqual(["x"]);
    let marked = await Flow.findById(row!._id);
    expect(isFlowMarkedInvalid(marked!)).toBe(true);
    expect(marked!.sourceBlobSha).toBe(good);
    expect(marked!.lastSeenBlobSha).toBe(blobOid(broken));

    // A second broken version with the SAME reason is a different blob and
    // must be recorded too (the marker's idempotency is per blob).
    const broken2 = "name: [still unclosed";
    await push({ "flows/x.yml": broken2 });
    await syncFlowsFromRepo(WS, "u1");
    marked = await Flow.findById(row!._id);
    expect(marked!.lastSeenBlobSha).toBe(blobOid(broken2));
    // GET/list's own resync agrees.
    await ensureFlowDerivedCache(marked!);
    expect((await Flow.findById(row!._id))!.lastSeenBlobSha).toBe(
      blobOid(broken2),
    );

    // The user fixes it in the UI: the save must go through (this is the
    // recovery path), not be refused as "the file changed".
    marked!.name = "X fixed in the UI";
    const saved = await commitFlowFile(marked!, "u1");
    expect(saved).toMatchObject({ ok: true, changed: true });
    expect(saved.conflict).toBeUndefined();
    expect(
      await readBlob(
        repoDirFor(WS),
        (await resolveCommit(
          repoDirFor(WS),
          `refs/heads/${DEFAULT_BRANCH}`,
        )) as string,
        "flows/x.yml",
      ).then(b => b.contents),
    ).toContain("name: X fixed in the UI");
    // The route then stamps the shas, unsets the marker and saves the doc
    // (commitFlowFileOrFail + flow.save()); the next sync sees a valid file
    // level with the row.
    marked!.sourceBlobSha = saved.sourceBlobSha;
    marked!.lastSeenBlobSha = saved.sourceBlobSha;
    await Flow.updateOne(
      { _id: row!._id },
      { $unset: { definitionInvalid: 1 } },
    );
    await marked!.save();
    const after = await syncFlowsFromRepo(WS, "u1");
    expect(after).toMatchObject({ invalid: [], unchanged: 1 });
    const fixed = await Flow.findById(row!._id);
    expect(isFlowMarkedInvalid(fixed!)).toBe(false);
    expect(fixed!.name).toBe("X fixed in the UI");

    // …while an edit nobody has seen is still refused, as a conflict.
    await push({ "flows/x.yml": flowYaml("X edited on a laptop meanwhile") });
    fixed!.name = "X from a stale form";
    const refused = await commitFlowFile(fixed!, "u1");
    expect(refused).toMatchObject({ ok: false, conflict: true });
    expect(refused.error).toMatch(/changed in the workspace repo/);
  });
});

describe("round 4: non-UTF-8 files, invalid rows saving their last valid definition, legacy invalid rows", () => {
  /**
   * Commit raw bytes at a path on main — `commitBlobsOnBranch` takes JS
   * strings (UTF-8 on the way into git), so a Latin-1 file needs the
   * plumbing directly.
   */
  async function pushRaw(relPath: string, bytes: Buffer): Promise<string> {
    const { execFileSync } = await import("node:child_process");
    const { runGit } = await import("../apps/git");
    const dir = repoDirFor(WS);
    const oid = execFileSync(
      "git",
      ["-C", dir, "hash-object", "-w", "--stdin"],
      { input: bytes },
    )
      .toString()
      .trim();
    const head = (await resolveCommit(
      dir,
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    const index = path.join(
      tmpRoot,
      `idx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const env = { GIT_DIR: dir, GIT_INDEX_FILE: index };
    await runGit(["read-tree", head], { env, cwd: dir });
    await runGit(["update-index", "--index-info"], {
      env,
      cwd: dir,
      stdin: `100644 ${oid}\t${relPath}\n`,
    });
    const tree = (
      await runGit(["write-tree"], { env, cwd: dir })
    ).stdout.trim();
    const commit = (
      await runGit([
        "-C",
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit-tree",
        tree,
        "-p",
        head,
        "-m",
        "raw",
      ])
    ).stdout.trim();
    await runGit([
      "-C",
      dir,
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      commit,
    ]);
    await fs.rm(index, { force: true });
    return oid;
  }

  it("[r4-1] a Latin-1 file is stored under git's own oid, so the UI can still save it (valid and broken)", async () => {
    const { commitFlowFile } = await import("./flow-config.service");
    const { blobOidAt } = await import("../apps/repository.service");
    const latin1 = Buffer.from(flowYaml("Café"), "latin1");
    expect(latin1.toString("utf8")).not.toBe(flowYaml("Café")); // really not UTF-8
    const gitOid = await pushRaw("flows/cafe.yml", latin1);
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "cafe" });
    expect(row).not.toBeNull();
    expect(row!.sourceBlobSha).toBe(gitOid);
    expect(row!.lastSeenBlobSha).toBe(gitOid);
    expect(blobOid(latin1.toString("utf8"))).not.toBe(gitOid); // the old, wrong value
    // GET/list agrees (its own resync and def.oid use the raw bytes too).
    const head = (await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    expect(await blobOidAt(repoDirFor(WS), head, "flows/cafe.yml")).toBe(
      gitOid,
    );
    expect((await loadLiveFlowById(WS, row!._id.toString()))?.def.oid).toBe(
      gitOid,
    );
    await ensureFlowDerivedCache(row!);
    expect((await Flow.findById(row!._id))!.lastSeenBlobSha).toBe(gitOid);

    // The UI edits it: the compare-and-swap must pass.
    row!.name = "Café (renamed in the UI)";
    const saved = await commitFlowFile(row!, "u1");
    expect(saved).toMatchObject({ ok: true, changed: true });

    // A BROKEN Latin-1 file: the blob seen is git's oid too, so the fix
    // from the UI goes through as well.
    const brokenLatin1 = Buffer.from("name: [Café unclosed", "latin1");
    const brokenOid = await pushRaw("flows/cafe.yml", brokenLatin1);
    await syncFlowsFromRepo(WS, "u1");
    const marked = await Flow.findById(row!._id);
    expect(isFlowMarkedInvalid(marked!)).toBe(true);
    expect(marked!.lastSeenBlobSha).toBe(brokenOid);
    marked!.name = "Café fixed";
    expect((await commitFlowFile(marked!, "u1")).ok).toBe(true);
  });

  it("[r4-2] an invalid row saving its last VALID definition unchanged still commits — main gets fixed, not just the marker cleared", async () => {
    const { commitFlowFile } = await import("./flow-config.service");
    await push({ "flows/y.yml": flowYaml("Y") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "y" });
    const broken = "name: [unclosed";
    await push({ "flows/y.yml": broken });
    await syncFlowsFromRepo(WS, "u1");
    const marked = await Flow.findById(row!._id);
    expect(isFlowMarkedInvalid(marked!)).toBe(true);
    // What the UI shows is the last valid definition; the user saves it
    // as is (no field changed).
    const saved = await commitFlowFile(marked!, "u1");
    expect(saved).toMatchObject({ ok: true, changed: true });
    const head = (await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    const onMain = (await readBlob(repoDirFor(WS), head, "flows/y.yml"))
      .contents;
    expect(onMain).not.toBe(broken);
    expect(parseFlowFile(onMain)).not.toBeNull();
    // The route's follow-up (stamp + unset + save) leaves the row level and
    // healthy, and the next GET does not re-mark it.
    marked!.sourceBlobSha = saved.sourceBlobSha;
    marked!.lastSeenBlobSha = saved.sourceBlobSha;
    await Flow.updateOne(
      { _id: row!._id },
      { $unset: { definitionInvalid: 1 } },
    );
    await marked!.save();
    expect(await ensureFlowDerivedCache((await Flow.findById(row!._id))!)).toBe(
      "ok",
    );
    expect(isFlowMarkedInvalid((await Flow.findById(row!._id))!)).toBe(false);
    // A healthy row level with the repo is still a no-op save.
    const again = await commitFlowFile((await Flow.findById(row!._id))!, "u1");
    expect(again).toMatchObject({ ok: true, changed: false });
  });

  it("[r4-3] a legacy invalid row (no lastSeenBlobSha) must reload first: it cannot overwrite a fix pushed meanwhile", async () => {
    const { commitFlowFile } = await import("./flow-config.service");
    await push({ "flows/z.yml": flowYaml("Z") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "z" });
    await push({ "flows/z.yml": "name: [unclosed" });
    await syncFlowsFromRepo(WS, "u1");
    // A row marked before the field existed.
    await Flow.updateOne({ _id: row!._id }, { $unset: { lastSeenBlobSha: 1 } });
    const legacy = await Flow.findById(row!._id);
    expect(isFlowMarkedInvalid(legacy!)).toBe(true);
    expect(legacy!.lastSeenBlobSha).toBeUndefined();
    // Someone fixes the file from a laptop; the push has not synced yet.
    const laptopFix = flowYaml("Z fixed on a laptop");
    await push({ "flows/z.yml": laptopFix });

    legacy!.name = "Z from a stale form";
    const refused = await commitFlowFile(legacy!, "u1");
    expect(refused).toMatchObject({ ok: false, conflict: true });
    expect(refused.error).toMatch(/reload/);
    const head = (await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    expect((await readBlob(repoDirFor(WS), head, "flows/z.yml")).contents).toBe(
      laptopFix,
    );

    // The reload (GET's resync) records what is on main — here the laptop
    // fix applies and heals the row — after which saves work again.
    expect(await ensureFlowDerivedCache((await Flow.findById(row!._id))!)).toBe(
      "resynced",
    );
    const reloaded = await Flow.findById(row!._id);
    expect(reloaded!.name).toBe("Z fixed on a laptop");
    expect(reloaded!.lastSeenBlobSha).toBe(blobOid(laptopFix));
    reloaded!.name = "Z edited after the reload";
    expect((await commitFlowFile(reloaded!, "u1")).ok).toBe(true);
  });
});

describe("final: a rename whose commit is not on the mirror yet, seen from another instance", () => {
  /** The realadvisor files' shape: parse→serialize does NOT round-trip it. */
  function authoredYaml(name: string): string {
    return [
      `name: ${name}`,
      "type: webhook",
      "source:",
      "  type: connector",
      `  connection_id: ${CONNECTOR}`,
      "destination:",
      `  connection_id: ${DEST}`,
      "  table:",
      `    connection_id: ${DEST}`,
      "    schema: raw_a",
      "    create_if_not_exists: true",
      "backfill_schedule:",
      "  # nightly users re-pull",
      "  cron: 0 3 * * *",
      "  timezone: UTC",
      "webhook:",
      "  enabled: true",
      "sync:",
      "  mode: incremental",
      "  write_mode: append_dedup",
      "  engine: cdc",
      "  batch_size: 2000",
      "entities:",
      "  layouts:",
      "    - entity: leads",
      "      label: Leads",
      "      partitionField: _syncedAt",
      "      partitionGranularity: day",
      "      enabled: true",
      "      _id: 69c781737eb58b93e5ac3386",
      "",
    ].join("\n");
  }

  /** Instance B: main at `commit`, and the objects it never fetched gone. */
  async function becomeStaleInstance(commit: string): Promise<void> {
    const { runGit } = await import("../apps/git");
    const dir = repoDirFor(WS);
    await runGit([
      "-C",
      dir,
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      commit,
    ]);
    await runGit(["-C", dir, "reflog", "expire", "--expire=now", "--all"]);
    await runGit(["-C", dir, "gc", "--prune=now", "-q"]);
  }

  it("[final-1a] the renaming instance does not retire the guard while its commit is only on its own main", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    await push({ "flows/foo.yml": authoredYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    const pre = (await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    const renamed = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "foo", slug: "bar" },
    );
    // The mirror still has `pre`: a push notification handled on this
    // instance (local main ahead, as fetchFromCloud keeps it).
    mirror.main = pre;
    await syncFlowsFromRepo(WS, "u1");
    expect((await Flow.findById(row!._id))?.lastRenameCommit).toBe(
      renamed.commit,
    );
    // Once the mirror has the commit, the guard retires.
    mirror.main = renamed.commit as string;
    await syncFlowsFromRepo(WS, "u1");
    expect((await Flow.findById(row!._id))?.lastRenameCommit).toBeUndefined();
    expect((await Flow.find({ workspaceId: WS })).map(r => r.slug)).toEqual([
      "bar",
    ]);
  });

  it("[final-1b] a stale instance keeps the renamed row while the guard holds, and never tears it down even without one", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const { runGit } = await import("../apps/git");
    await push({ "flows/foo.yml": authoredYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");
    const orig = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    await seedRuntime(orig!._id);
    const dir = repoDirFor(WS);
    const pre = (await resolveCommit(
      dir,
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    const renamed = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "foo", slug: "bar" },
    );
    const renamedTree = (
      await runGit(["-C", dir, "rev-parse", `${renamed.commit}^{tree}`])
    ).stdout.trim();
    void renamedTree;

    // Instance B: its main is the mirror's (`pre`), the commit's objects
    // never fetched. The guard is still on (1a): the row is kept.
    await becomeStaleInstance(pre);
    mirror.main = pre;
    const guardedSync = await syncFlowsFromRepo(WS, "u2");
    expect(guardedSync.created).toBe(0);
    expect(
      (await Flow.find({ workspaceId: WS })).map(r => [
        r._id.toString(),
        r.slug,
      ]),
    ).toEqual([[orig!._id.toString(), "bar"]]);
    expect(await runtimeCounts(orig!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");

    // The reviewer's case: the guard is GONE (retired early, expired, or
    // never recorded). Git pairing is impossible here (the blob was never
    // fetched) and the authored file does not round-trip, so no rule pairs
    // them — and the file at the old name is still the same stream (same
    // source + destination). On the mirror's main that is a rename back:
    // the row follows its file. Same id, same checkpoints, no create.
    await Flow.updateOne(
      { _id: orig!._id },
      { $unset: { lastRenameCommit: 1, lastRenameAt: 1 } },
    );
    const unguardedSync = await syncFlowsFromRepo(WS, "u2");
    expect(unguardedSync.created).toBe(0);
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
      [orig!._id.toString(), "foo"],
    ]);
    expect(rows[0].aliases).toEqual(["bar"]);
    expect(await runtimeCounts(orig!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");

    // When the rename commit finally lands on the mirror (bar.yml with
    // `aliases: [foo]`), the row follows it forward — still the same id.
    await Flow.updateOne(
      { _id: orig!._id },
      { $unset: { lastRenameCommit: 1, lastRenameAt: 1 } },
    );
    const landed = editAliases(authoredYaml("Foo"), ["foo"]);
    await move("foo", "bar", landed);
    mirror.main = (await resolveCommit(
      dir,
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    await syncFlowsFromRepo(WS, "u2");
    const after = await Flow.find({ workspaceId: WS });
    expect(after.map(r => [r._id.toString(), r.slug])).toEqual([
      [orig!._id.toString(), "bar"],
    ]);
    expect(await runtimeCounts(orig!._id)).toEqual([1, 1, 1]);
  });

  it("[final-1c] on a tree that cannot be verified, the same-stream file at the old name keeps the row as it is (no flip, no create, no teardown)", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    await push({ "flows/foo.yml": authoredYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");
    const orig = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    await seedRuntime(orig!._id);
    const pre = (await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    const renamed = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "foo", slug: "bar" },
    );
    await becomeStaleInstance(pre);
    await Flow.updateOne(
      { _id: orig!._id },
      { $unset: { lastRenameCommit: 1, lastRenameAt: 1 } },
    );
    // Nothing verifies this tree (the mirror reports some other main).
    mirror.main = renamed.commit as string;
    const result = await syncFlowsFromRepo(WS, "u2");
    expect(result.created).toBe(0);
    expect(
      (await Flow.find({ workspaceId: WS })).map(r => [
        r._id.toString(),
        r.slug,
      ]),
    ).toEqual([[orig!._id.toString(), "bar"]]);
    expect(await runtimeCounts(orig!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
    // …and an UNRELATED file reusing the old name (different target) is a
    // new flow regardless (round-2 #5 holds).
    const OTHER = new Types.ObjectId().toString();
    await push({
      "flows/foo.yml": authoredYaml("Other foo").replace(
        `connection_id: ${CONNECTOR}`,
        `connection_id: ${OTHER}`,
      ),
    });
    const other = await syncFlowsFromRepo(WS, "u2");
    expect(other.created).toBe(1);
    expect(
      (await Flow.findOne({ workspaceId: WS, slug: "foo" }))?._id.toString(),
    ).not.toBe(orig!._id.toString());
  });

  it("[final-2] a run on an instance whose cache predates the rename refuses the run but keeps the schedules on", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const { runGit } = await import("../apps/git");
    await push({
      "flows/foo.yml": flowYaml("Foo").replace(
        "webhook:\n",
        "schedule:\n  cron: 0 * * * *\n  timezone: UTC\nwebhook:\n",
      ),
    });
    await syncFlowsFromRepo(WS, "u1");
    const before = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    expect(before!.schedule?.enabled).toBe(true);
    expect(before!.backfillSchedule?.enabled).toBe(true);
    const dir = repoDirFor(WS);
    const pre = (await resolveCommit(
      dir,
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    const renamed = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "foo", slug: "bar" },
    );
    // Instance B's cache: main still at `pre` (what the consumer / the
    // inngest flow function read through).
    await runGit([
      "-C",
      dir,
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    const loaded = await Flow.findById(before!._id).lean();
    const freshness = await ensureFlowDerivedCache(loaded!);
    expect(freshness).toBe("missing"); // this run is refused…
    const after = await Flow.findById(before!._id);
    expect(after!.schedule?.enabled).toBe(true); // …but nothing is switched off
    expect(after!.backfillSchedule?.enabled).toBe(true);
    expect(isFlowMarkedInvalid(after!)).toBe(false);
    // The cache catches up: the next run is fine without anyone opening it.
    await runGit([
      "-C",
      dir,
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      renamed.commit as string,
    ]);
    expect(
      await ensureFlowDerivedCache((await Flow.findById(before!._id))!),
    ).toBe("ok");
  });
});

/** `aliases:` inserted after `name:` the way the rename service writes it. */
function editAliases(contents: string, aliases: string[]): string {
  return contents.replace(
    /^(name: .*\n)/,
    `$1aliases:\n${aliases.map(a => `  - ${a}\n`).join("")}`,
  );
}

describe("cycle 2: wedges after a lost rename, stale instances, a failed sync save", () => {
  async function loseRename(slug: string, to: string) {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const pre = (await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    const renamed = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: slug, slug: to },
    );
    const { runGit } = await import("../apps/git");
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    return renamed;
  }
  const expireGuard = (id: Types.ObjectId) =>
    Flow.updateOne(
      { _id: id },
      { $set: { lastRenameAt: new Date(Date.now() - 60 * 60_000) } },
    );

  it("[c2-1] a lost rename with no push afterwards settles on the read paths: runs resume, the list and GET find the row", async () => {
    await push({ "flows/foo.yml": flowYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    await seedRuntime(row!._id);
    await loseRename("foo", "bar");
    await expireGuard(row!._id);
    // The run / consumer freshness check (no push ran the sync's settle).
    const freshness = await ensureFlowDerivedCache(
      (await Flow.findById(row!._id).lean())!,
    );
    expect(freshness).not.toBe("missing");
    const settled = await Flow.findById(row!._id);
    expect(settled!.slug).toBe("foo");
    expect(settled!.lastRenameCommit).toBeUndefined();
    expect(settled!.aliases ?? []).toEqual([]);
    expect(await runtimeCounts(row!._id)).toEqual([1, 1, 1]);
    // GET and the list see the row under its file again.
    expect(
      (await loadLiveFlowById(WS, row!._id.toString()))?.row?._id.toString(),
    ).toBe(row!._id.toString());
    expect(
      (await loadLiveFlows(WS)).map(l => [l.def.slug, l.row?._id.toString()]),
    ).toEqual([["foo", row!._id.toString()]]);
    expect((await resolveLiveFlowRow(WS, row!._id.toString())).ok).toBe(true);
  });

  it("[c2-1] the list path alone settles it too (nobody ran a sync or a run)", async () => {
    await push({ "flows/foo.yml": flowYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    await loseRename("foo", "bar");
    await expireGuard(row!._id);
    const live = await loadLiveFlows(WS);
    expect(live.map(l => [l.def.slug, l.row?._id.toString()])).toEqual([
      ["foo", row!._id.toString()],
    ]);
  });

  it("[c2-2] an instance whose cache predates a rename fetches once on a miss and finds the renamed flow", async () => {
    const { runGit } = await import("../apps/git");
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    await push({ "flows/foo.yml": flowYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    const pre = (await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "foo", slug: "bar" },
    );
    // The mirror has the rename; THIS instance's cache does not.
    const remotes = path.join(tmpRoot, `remotes-${WS}`);
    await fs.mkdir(path.join(remotes, "test-owner"), { recursive: true });
    await runGit([
      "clone",
      "--bare",
      "-q",
      repoDirFor(WS),
      path.join(remotes, "test-owner", "test-repo.git"),
    ]);
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotes}`;
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const live = await loadLiveFlowById(WS, row!._id.toString());
    expect(live?.def.slug).toBe("bar");
    expect(live?.row?._id.toString()).toBe(row!._id.toString());
    expect((await loadLiveFlows(WS)).map(l => l.def.slug)).toEqual(["bar"]);
    // The second miss within 30 s does not fetch again (throttled), and a
    // row truly without a file is still "missing".
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    // The second miss within 30 s does not fetch again (throttled; the
    // rename commit is already local, so nothing is fetched FOR either):
    // the stale view serves the row under its old-name file.
    const stale = await loadLiveFlowById(WS, row!._id.toString());
    expect(stale?.def.slug).toBe("foo");
    expect(stale?.row?._id.toString()).toBe(row!._id.toString());
  });

  it("[c2-4] a push-sync save that failed once does not wedge later UI saves after the file reverts", async () => {
    const { commitFlowFile } = await import("./flow-config.service");
    const good = flowYaml("Foo");
    await push({ "flows/foo.yml": good });
    await syncFlowsFromRepo(WS, "u1");
    await push({ "flows/foo.yml": flowYaml("Foo edited") });
    const spy = vi
      .spyOn(Flow.prototype, "save")
      .mockImplementationOnce(async () => {
        throw new Error("transient: VersionError");
      });
    await syncFlowsFromRepo(WS, "u1");
    spy.mockRestore();
    // The failed save left the row invalid with the blob it saw…
    const marked = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    expect(isFlowMarkedInvalid(marked!)).toBe(true);
    expect(marked!.lastSeenBlobSha).toBe(blobOid(flowYaml("Foo edited")));
    // …the file reverts before anyone lists; the next sync must re-stamp
    // both shas (sourceBlobSha alone looks level).
    await push({ "flows/foo.yml": good });
    await syncFlowsFromRepo(WS, "u1");
    const level = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    expect(level!.sourceBlobSha).toBe(blobOid(good));
    expect(level!.lastSeenBlobSha).toBe(blobOid(good));
    expect(isFlowMarkedInvalid(level!)).toBe(false);
    // "Reload" + UI save: allowed.
    await loadLiveFlowById(WS, level!._id.toString());
    const row = await Flow.findById(level!._id);
    row!.name = "UI edit";
    expect(await commitFlowFile(row!, "u1")).toMatchObject({
      ok: true,
      changed: true,
    });
  });

  it("[c2-5] an expired guard re-keys to the most recent old name whose file is the SAME stream; an unrelated file under an older name is a new flow", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    await push({ "flows/x.yml": flowYaml("X") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "x" });
    await seedRuntime(row!._id);
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "x", slug: "a" },
    );
    await syncFlowsFromRepo(WS, "u1"); // lands, guard cleared
    await loseRename("a", "b");
    await expireGuard(row!._id);
    expect((await Flow.findById(row!._id))!.aliases).toEqual(["x", "a"]);
    // Someone reuses the oldest name for an unrelated stream.
    const OTHER = new Types.ObjectId().toString();
    await push({
      "flows/x.yml": flowYaml("Unrelated X").replace(
        `connector_id: ${CONNECTOR}`,
        `connector_id: ${OTHER}`,
      ),
    });
    const result = await syncFlowsFromRepo(WS, "u1");
    expect(result.created).toBe(1);
    const orig = await Flow.findById(row!._id);
    expect(orig!.slug).toBe("a");
    expect(String(orig!.dataSourceId)).toBe(CONNECTOR);
    expect(await runtimeCounts(row!._id)).toEqual([1, 1, 1]);
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows.map(r => r.slug).sort()).toEqual(["a", "x"]);
    expect(rows.find(r => r.slug === "x")!._id.toString()).not.toBe(
      row!._id.toString(),
    );

    // And when the only old-name file in the tree is a different stream,
    // the guard is simply cleared: no re-key, nothing inherited.
    await Flow.deleteMany({ workspaceId: WS });
    await CdcEntityState.deleteMany({});
    await push({ "flows/y.yml": flowYaml("Y") });
    await syncFlowsFromRepo(WS, "u1");
    const y = await Flow.findOne({ workspaceId: WS, slug: "y" });
    await loseRename("y", "z");
    await expireGuard(y!._id);
    await push({
      "flows/y.yml": flowYaml("Other Y").replace(
        `connector_id: ${CONNECTOR}`,
        `connector_id: ${OTHER}`,
      ),
    });
    await syncFlowsFromRepo(WS, "u1");
    const yAfter = await Flow.findById(y!._id);
    expect(yAfter === null || yAfter.slug === "z").toBe(true);
    if (yAfter) expect(yAfter.lastRenameCommit).toBeUndefined();
    expect(
      (await Flow.findOne({ workspaceId: WS, slug: "y" }))!._id.toString(),
    ).not.toBe(y!._id.toString());
  });
});

describe("cross-cutting: an old name found only in a file's aliases", () => {
  it("resolves to the row that holds the file, and the row re-acquires the alias once the newcomer is gone", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const { resolveFlowRef } = await import("../rename/flow-rename");
    await push({
      "flows/a.yml": flowYaml("A"),
      "flows/keep.yml": flowYaml("Keep"),
    });
    await syncFlowsFromRepo(WS, "u1");
    const R = await Flow.findOne({ workspaceId: WS, slug: "a" });
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "a", slug: "b" },
    );
    expect((await Flow.findById(R!._id))!.aliases).toEqual(["a"]);

    // A teammate pushes an unrelated NEW flow at the old name: current wins,
    // the renamed row drops the alias — its FILE still lists it.
    const OTHER = new Types.ObjectId().toString();
    await push({
      "flows/a.yml": flowYaml("Newcomer").replace(
        `connector_id: ${CONNECTOR}`,
        `connector_id: ${OTHER}`,
      ),
    });
    await syncFlowsFromRepo(WS, "u2");
    const newcomer = await Flow.findOne({ workspaceId: WS, slug: "a" });
    expect(newcomer!._id.toString()).not.toBe(R!._id.toString());
    expect((await Flow.findById(R!._id))!.aliases ?? []).toEqual([]);
    expect((await resolveFlowRef({ workspaceId: WS }, "a"))?.id).toBe(
      newcomer!._id.toString(),
    );

    // …and later deletes it. The old name answers to the old flow again:
    // `resolve` (which reads the files) names the ROW, never an id nothing
    // holds, and the row has the alias back in the same sync.
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { deletes: ["flows/a.yml"] },
      { message: "laptop delete" },
    );
    await syncFlowsFromRepo(WS, "u2");
    expect(await Flow.countDocuments({ workspaceId: WS, slug: "a" })).toBe(0);
    const resolved = await resolveFlowRef({ workspaceId: WS }, "a");
    expect(resolved).toMatchObject({
      id: R!._id.toString(),
      via: "alias",
      current: { slug: "b" },
    });
    expect(await Flow.exists({ _id: resolved!.id })).not.toBeNull();
    expect((await Flow.findById(R!._id))!.aliases).toEqual(["a"]);
    const renamed = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "a", title: "A again" },
    );
    expect(renamed.id).toBe(R!._id.toString());
    // And while the newcomer's file is at main (not yet synced), the name is
    // the newcomer's — never silently the old row's.
    await push({
      "flows/a.yml": flowYaml("Newcomer 2").replace(
        `connector_id: ${CONNECTOR}`,
        `connector_id: ${OTHER}`,
      ),
    });
    const beforeSync = await resolveFlowRef({ workspaceId: WS }, "a");
    expect(beforeSync?.via).toBe("current");
    expect(beforeSync?.id).not.toBe(R!._id.toString());
  });
});

describe("cycle 3: renames that lose a race, the miss window, aliases the file keeps", () => {
  const runGit = async (args: string[]) =>
    (await import("../apps/git")).runGit(args);
  const headOf = async () =>
    (await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;

  it("[c3-1a] a UI rename whose mirror push lost to a laptop `git mv` is re-keyed in place, not torn down", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const R = await Flow.findOne({ workspaceId: WS, slug: "a" });
    await seedRuntime(R!._id);
    const pre = await headOf();
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "a", slug: "b" },
    );
    // The mirror got the laptop's move first; main here is reset to it.
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    await move("a", "x", flowYaml("A"));
    const result = await syncFlowsFromRepo(WS, "u2");
    expect(result.created).toBe(0);
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
      [R!._id.toString(), "x"],
    ]);
    expect(await runtimeCounts(R!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
  });

  it("[c3-1b] two renames of one flow on two instances: the loser's row follows the winner's file, same id", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const R = await Flow.findOne({ workspaceId: WS, slug: "a" });
    await seedRuntime(R!._id);
    const pre = await headOf();
    const toB = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "a", slug: "b" },
    );
    // Instance B, on the mirror's `pre`, renamed a→c and wrote the row last;
    // its push was rejected and parked: main = mirror = the a→b commit.
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    await Flow.updateOne(
      { _id: R!._id },
      {
        $set: { slug: "a" },
        $unset: { aliases: 1, lastRenameCommit: 1, lastRenameAt: 1 },
      },
    );
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: R!._id.toString(), slug: "c" },
    );
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      toB.commit as string,
    ]);
    const result = await syncFlowsFromRepo(WS, "u2");
    expect(result.created).toBe(0);
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
      [R!._id.toString(), "b"],
    ]);
    expect(await runtimeCounts(R!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
  });

  it("[c3-2] a miss on a renamed row fetches its commit even inside the throttle window, and the rename waits for its mirror push", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const R = await Flow.findOne({ workspaceId: WS, slug: "a" });
    const pre = await headOf();
    // A mirror at `pre`, wired up BEFORE the rename so the rename pushes to it.
    const remotes = path.join(tmpRoot, `remotes-c3-${WS}`);
    const remote = path.join(remotes, "test-owner", "test-repo.git");
    await fs.mkdir(path.dirname(remote), { recursive: true });
    await runGit(["clone", "--bare", "-q", repoDirFor(WS), remote]);
    process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotes}`;
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const renamed = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "a", slug: "b" },
    );
    // The rename returned only once the mirror had the commit.
    expect(
      (
        await runGit(["-C", remote, "rev-parse", "refs/heads/main"])
      ).stdout.trim(),
    ).toBe(renamed.commit);

    // Instance B: cache at `pre`, the commit's objects never fetched, and
    // its throttle already burnt by a miss BEFORE the push landed.
    await runGit(["-C", remote, "update-ref", "refs/heads/main", pre]);
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    await runGit([
      "-C",
      repoDirFor(WS),
      "reflog",
      "expire",
      "--expire=now",
      "--all",
    ]);
    await runGit(["-C", repoDirFor(WS), "gc", "--prune=now", "-q"]);
    // t0: nothing to fetch yet — the stale view serves the row under its
    // old-name file (never a 404, never a git-only stand-in).
    const t0 = await loadLiveFlowById(WS, R!._id.toString());
    expect(t0?.def.slug).toBe("a");
    expect(t0?.row?._id.toString()).toBe(R!._id.toString());
    // t2: the push lands on the mirror (objects were in the clone).
    await runGit([
      "-C",
      remote,
      "update-ref",
      "refs/heads/main",
      renamed.commit as string,
    ]);
    resetFreshenOnMissThrottle(); // emulates the 5 s per-sha backoff elapsing
    // The 30 s miss throttle is NOT reset — the row's commit is fetched for
    // by itself.
    const { FRESHEN_ON_MISS_MS } = await import("./flow-sync.service");
    expect(FRESHEN_ON_MISS_MS).toBeGreaterThan(5_000);
    const live = await loadLiveFlowById(WS, R!._id.toString());
    expect(live?.def.slug).toBe("b");
    expect(live?.row?._id.toString()).toBe(R!._id.toString());
  });

  it("[c3-2] on a stale instance the old-name file is listed AS the row, never as a git-only stand-in", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const R = await Flow.findOne({ workspaceId: WS, slug: "a" });
    const pre = await headOf();
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "a", slug: "b" },
    );
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    const live = await loadLiveFlows(WS);
    expect(
      live.map(l => [l.def.slug, l.row?._id.toString(), l.id.toString()]),
    ).toEqual([["a", R!._id.toString(), R!._id.toString()]]);
    const plain = liveFlowToPlain(live[0], WS);
    expect(plain.gitOnly).toBeUndefined();
    expect(
      (await loadLiveFlowById(WS, R!._id.toString()))?.row?._id.toString(),
    ).toBe(R!._id.toString());
  });

  it("[c3-3] a UI save while a newcomer holds the old name keeps that name in the file; the file is the record", async () => {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const { resolveFlowRef } = await import("../rename/flow-rename");
    const { commitFlowFile } = await import("./flow-config.service");
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const R = await Flow.findOne({ workspaceId: WS, slug: "a" });
    await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "a", slug: "b" },
    );
    const OTHER = new Types.ObjectId().toString();
    await push({
      "flows/a.yml": flowYaml("Newcomer").replace(
        `connector_id: ${CONNECTOR}`,
        `connector_id: ${OTHER}`,
      ),
    });
    await syncFlowsFromRepo(WS, "u2");
    expect((await Flow.findById(R!._id))!.aliases ?? []).toEqual([]);
    // A UI save of the renamed flow (PUT → commitFlowFile on the row).
    const row = (await Flow.findById(R!._id))!;
    row.name = "B edited in the UI";
    expect((await commitFlowFile(row, "u1")).ok).toBe(true);
    const saved = (
      await readBlob(repoDirFor(WS), await headOf(), "flows/b.yml")
    ).contents;
    expect(parseFlowFile(saved)?.aliases).toEqual(["a"]);
    // The newcomer goes: the old name answers to the old flow again.
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { deletes: ["flows/a.yml"] },
      { message: "laptop delete" },
    );
    await syncFlowsFromRepo(WS, "u2");
    expect((await resolveFlowRef({ workspaceId: WS }, "a"))?.id).toBe(
      R!._id.toString(),
    );
    expect((await Flow.findById(R!._id))!.aliases).toEqual(["a"]);
  });
});

describe("cycle 4: a lost rename judged on ANOTHER instance; another file at the new name", () => {
  const runGit = async (args: string[]) =>
    (await import("../apps/git")).runGit(args);
  const headOf = async () =>
    (await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    )) as string;
  /**
   * A UI rename a→b whose mirror push lost: main is reset to the tree
   * before it. With `otherInstance`, the objects only the renaming instance
   * had (the rename commit, the renamed file's blob) are gone too — what an
   * instance that never fetched them sees.
   */
  async function loseRenameTo(
    to: string,
    opts: { otherInstance: boolean },
  ): Promise<void> {
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const pre = await headOf();
    await flowRenameHandler.rename({ workspaceId: WS }, { ref: "a", slug: to });
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    if (opts.otherInstance) {
      await runGit([
        "-C",
        repoDirFor(WS),
        "reflog",
        "expire",
        "--expire=now",
        "--all",
      ]);
      await runGit(["-C", repoDirFor(WS), "gc", "--prune=now", "-q"]);
    }
  }
  const expireGuard = (id: Types.ObjectId) =>
    Flow.updateOne(
      { _id: id },
      { $set: { lastRenameAt: new Date(Date.now() - 60 * 60_000) } },
    );
  const otherStream = (name: string) => {
    const src = new Types.ObjectId().toString();
    const dst = new Types.ObjectId().toString();
    return flowYaml(name)
      .replace(`connector_id: ${CONNECTOR}`, `connector_id: ${src}`)
      .replace(`connection_id: ${DEST}`, `connection_id: ${dst}`);
  };

  it("[c4-1] the rename records the blob it started from", async () => {
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const R = await Flow.findOne({ workspaceId: WS, slug: "a" });
    const before = R!.sourceBlobSha;
    await loseRenameTo("b", { otherInstance: false });
    const after = await Flow.findById(R!._id);
    expect(after!.renameFromBlobSha).toBe(before);
    expect(after!.sourceBlobSha).not.toBe(before);
  });

  for (const variant of ["pure move", "move + edit"] as const) {
    it(`[c4-1] another instance: a UI rename lost to a laptop \`git mv\` a→x (${variant}) re-keys the row in place, never a new flow`, async () => {
      await push({ "flows/a.yml": flowYaml("A") });
      await syncFlowsFromRepo(WS, "u1");
      const R = await Flow.findOne({ workspaceId: WS, slug: "a" });
      await seedRuntime(R!._id);
      const endpoint = R!.webhookConfig?.endpoint;
      await loseRenameTo("b", { otherInstance: true });
      const body =
        variant === "pure move"
          ? flowYaml("A")
          : flowYaml("A").replace("cron: 0 3 * * *", "cron: 0 4 * * *");
      await move("a", "x", body);
      const result = await syncFlowsFromRepo(WS, "u2");
      expect(result.created).toBe(0);
      let rows = await Flow.find({ workspaceId: WS });
      expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
        [R!._id.toString(), "x"],
      ]);
      expect(rows[0].webhookConfig?.endpoint).toBe(endpoint);
      if (variant === "move + edit") {
        expect(rows[0].backfillSchedule?.cron).toBe("0 4 * * *");
      }
      // …and still one flow, the same one, once the guard has expired.
      await expireGuard(R!._id);
      await push({ "README.md": "y\n" });
      await syncFlowsFromRepo(WS, "u2");
      rows = await Flow.find({ workspaceId: WS });
      expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
        [R!._id.toString(), "x"],
      ]);
      expect(await runtimeCounts(R!._id)).toEqual([1, 1, 1]);
      expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
    });
  }

  it("[c4-2] a UI rename a→b that lost to an UNRELATED flows/b.yml: the row goes back to a, the newcomer is a flow of its own", async () => {
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const F = await Flow.findOne({ workspaceId: WS, slug: "a" });
    await seedRuntime(F!._id);
    const endpoint = F!.webhookConfig?.endpoint;
    await loseRenameTo("b", { otherInstance: true });
    await push({ "flows/b.yml": otherStream("Newcomer") });
    const result = await syncFlowsFromRepo(WS, "u2");
    expect(result.created).toBe(1);
    const back = await Flow.findById(F!._id);
    expect(back!.slug).toBe("a");
    expect(back!.name).toBe("A");
    expect(String(back!.dataSourceId)).toBe(CONNECTOR);
    expect(back!.webhookConfig?.endpoint).toBe(endpoint);
    expect(back!.lastRenameCommit).toBeUndefined();
    expect(back!.renameFromBlobSha).toBeUndefined();
    expect(back!.aliases ?? []).toEqual([]);
    const newcomer = await Flow.findOne({ workspaceId: WS, slug: "b" });
    expect(newcomer!._id.toString()).not.toBe(F!._id.toString());
    expect(newcomer!.name).toBe("Newcomer");
    expect(String(newcomer!.dataSourceId)).not.toBe(CONNECTOR);
    expect(newcomer!.webhookConfig?.endpoint).toContain(
      `/${WS}/${newcomer!._id.toString()}`,
    );
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(2);
    expect(await runtimeCounts(F!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
  });

  it("[c4-2] on a tree that cannot be verified the other file is never applied to the row; the verified tree then settles it", async () => {
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const F = await Flow.findOne({ workspaceId: WS, slug: "a" });
    await seedRuntime(F!._id);
    await loseRenameTo("b", { otherInstance: true });
    await push({ "flows/b.yml": otherStream("Newcomer") });
    const head = await headOf();
    mirror.main = "0".repeat(40);
    // Neither the push-sync nor a read applies it.
    const result = await syncFlowsFromRepo(WS, "u2");
    expect(result.created).toBe(0);
    expect(await ensureFlowDerivedCache((await Flow.findById(F!._id))!)).toBe(
      "missing",
    );
    let rows = await Flow.find({ workspaceId: WS });
    expect(rows.map(r => [r._id.toString(), r.slug, r.name])).toEqual([
      [F!._id.toString(), "b", "A"],
    ]);
    expect(String(rows[0].dataSourceId)).toBe(CONNECTOR);
    // GET and the list show the row under the file it still has (a); the
    // newcomer is git-only until a verified sync creates it.
    const live = await loadLiveFlows(WS);
    expect(
      live.map(l => [l.def.slug, l.row?._id.toString() ?? "git-only"]),
    ).toEqual([
      ["a", F!._id.toString()],
      ["b", "git-only"],
    ]);
    expect((await loadLiveFlowById(WS, F!._id.toString()))?.def.slug).toBe("a");
    // The mirror's main after all: settled, the newcomer created.
    mirror.main = head;
    await syncFlowsFromRepo(WS, "u2");
    rows = await Flow.find({ workspaceId: WS }).sort({ slug: 1 });
    expect(rows.map(r => [r.slug, r.name])).toEqual([
      ["a", "A"],
      ["b", "Newcomer"],
    ]);
    expect(rows[0]._id.toString()).toBe(F!._id.toString());
    expect(await runtimeCounts(F!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
  });

  it("[c4-2] the read paths settle it too: the list never hands the row the newcomer's definition", async () => {
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const F = await Flow.findOne({ workspaceId: WS, slug: "a" });
    await loseRenameTo("b", { otherInstance: true });
    await push({ "flows/b.yml": otherStream("Newcomer") });
    const live = await loadLiveFlows(WS);
    expect(
      live.map(l => [l.def.slug, l.row?._id.toString() ?? "git-only"]),
    ).toEqual([
      ["a", F!._id.toString()],
      ["b", "git-only"],
    ]);
    const row = await Flow.findById(F!._id);
    expect(row!.slug).toBe("a");
    expect(row!.name).toBe("A");
    expect(String(row!.dataSourceId)).toBe(CONNECTOR);
  });

  it("[c4-2] the newcomer at b AND a laptop `git mv` a→x: the row follows x (paired by the blob it started from), the newcomer is new", async () => {
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const F = await Flow.findOne({ workspaceId: WS, slug: "a" });
    await seedRuntime(F!._id);
    await loseRenameTo("b", { otherInstance: true });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "flows/x.yml": flowYaml("A").replace(
            "cron: 0 3 * * *",
            "cron: 0 5 * * *",
          ),
          "flows/b.yml": otherStream("Newcomer"),
        },
        deletes: ["flows/a.yml"],
      },
      { message: "laptop: git mv a x, new flow b" },
    );
    const result = await syncFlowsFromRepo(WS, "u2");
    expect(result.created).toBe(1);
    const rows = await Flow.find({ workspaceId: WS }).sort({ slug: 1 });
    expect(rows.map(r => [r.slug, r.name])).toEqual([
      ["b", "Newcomer"],
      ["x", "A"],
    ]);
    expect(rows[1]._id.toString()).toBe(F!._id.toString());
    expect(rows[1].backfillSchedule?.cron).toBe("0 5 * * *");
    expect(await runtimeCounts(F!._id)).toEqual([1, 1, 1]);
    expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
  });

  it("[c4-2] the rename's own file under another commit (a history rewrite) still counts as landed", async () => {
    await push({ "flows/a.yml": flowYaml("A") });
    await syncFlowsFromRepo(WS, "u1");
    const F = await Flow.findOne({ workspaceId: WS, slug: "a" });
    const pre = await headOf();
    const { flowRenameHandler } = await import("../rename/handlers/flow");
    const renamed = await flowRenameHandler.rename(
      { workspaceId: WS },
      { ref: "a", slug: "b" },
    );
    const renamedFile = (
      await readBlob(repoDirFor(WS), renamed.commit as string, "flows/b.yml")
    ).contents;
    await runGit([
      "-C",
      repoDirFor(WS),
      "update-ref",
      `refs/heads/${DEFAULT_BRANCH}`,
      pre,
    ]);
    // The same move, re-made as another commit (a rebase on the mirror).
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "flows/b.yml": renamedFile }, deletes: ["flows/a.yml"] },
      { message: "rebased rename" },
    );
    await syncFlowsFromRepo(WS, "u2");
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows.map(r => [r._id.toString(), r.slug])).toEqual([
      [F!._id.toString(), "b"],
    ]);
    expect(rows[0].lastRenameCommit).toBeUndefined();
    expect(rows[0].renameFromBlobSha).toBeUndefined();
  });
});
