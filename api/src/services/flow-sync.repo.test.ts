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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// No connected GitHub repo: the mirror helpers become no-ops and the
// reconciler has nothing destructive to verify against (no removals here).
vi.mock("./workspace-repos.service", () => ({
  getWorkspaceRepo: vi.fn(async () => null),
  findWorkspaceIdByRepoBinding: vi.fn(async () => null),
}));
vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));

import { Flow } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
} from "../apps/repository.service";
import { syncFlowsFromRepo } from "./flow-sync.service";

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
});

describe("a NEW flow file creates a row", () => {
  it("through Mako's git endpoint, authored by whoever pushed", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });

    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.created).toBe(1);
    expect(result.invalid).toEqual([]);
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-to-bigquery" });
    expect(row).not.toBeNull();
    expect(row!.createdBy).toBe("user-42");
    expect(row!.type).toBe("webhook");
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
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-to-bigquery" });
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
    expect(await Flow.findOne({ workspaceId: WS, slug: "z-good-one" })).not.toBeNull();
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

  it("a failed save on an EXISTING row keeps that row as it was", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    const before = await Flow.findOne({ workspaceId: WS, slug: "close-to-bigquery" });

    await push({
      "flows/close-to-bigquery.yml": flowYaml("Renamed").replace(
        "write_mode: append_dedup",
        "write_mode: not_a_real_mode",
      ),
    });
    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["close-to-bigquery"]);
    const after = await Flow.findOne({ workspaceId: WS, slug: "close-to-bigquery" });
    expect(after!.name).toBe(before!.name);
    expect(after!.writeMode).toBe(before!.writeMode);
    expect(after!.sourceBlobSha).toBe(before!.sourceBlobSha);
  });
});
