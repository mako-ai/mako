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
vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));

import { Flow } from "../database/workspace-schema";
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
  liveFlowToPlain,
  loadLiveFlowById,
  loadLiveFlows,
  syncFlowsFromRepo,
} from "./flow-sync.service";

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
  await Flow.deleteMany({});
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
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
