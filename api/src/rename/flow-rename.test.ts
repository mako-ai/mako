/**
 * The flow rename service, through its handler (what the objects route and
 * `rename_object` call): old names resolve, the rename is ONE commit that
 * moves the file and writes the alias, and the row keeps its id.
 *
 * Same rig as flow-sync.repo.test.ts: a bare repo at APPS_GIT_ROOT, a
 * memory Mongo, a test binding so writes are allowed.
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
// A hook on the freshen that precedes every main commit: a test can land a
// competing change in the window between the rename service reading the
// file and committing its move — the race the compare-and-swap exists for.
const freshenHook = vi.hoisted(() => ({
  fn: null as null | (() => Promise<void>),
}));
vi.mock("../apps/cloud-repo.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../apps/cloud-repo.service")>();
  return {
    ...actual,
    freshenBeforeMainWrite: async (workspaceId: string) => {
      await actual.freshenBeforeMainWrite(workspaceId);
      const fn = freshenHook.fn;
      freshenHook.fn = null;
      if (fn) await fn();
    },
  };
});
vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));

import { CdcEntityState, Flow } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  log as gitLog,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../apps/repository.service";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import { syncFlowsFromRepo } from "../services/flow-sync.service";
import { parseFlowFile } from "../services/flow-config-files";
import { commitFlowFile } from "../services/flow-config.service";
import { flowRenameHandler } from "./handlers/flow";
import { pickFlowByRef } from "./flow-rename";
import { RenameError } from "./types";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS: string;

const CONNECTOR = new Types.ObjectId().toString();
const DEST = new Types.ObjectId().toString();

function flowYaml(name: string, extra = ""): string {
  return [
    `name: ${name}`,
    "type: webhook",
    "source:",
    "  type: connector",
    `  connector_id: ${CONNECTOR}`,
    "destination:",
    `  connection_id: ${DEST}`,
    "webhook:",
    "  enabled: true",
    "sync:",
    "  engine: cdc",
    extra,
    "",
  ].join("\n");
}

async function push(writes: Record<string, string>): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes },
    { message: "push" },
  );
}

async function fileAt(rel: string): Promise<string | null> {
  const head = await resolveCommit(
    repoDirFor(WS),
    `refs/heads/${DEFAULT_BRANCH}`,
  );
  try {
    return (await readBlob(repoDirFor(WS), head as string, rel)).contents;
  } catch {
    return null;
  }
}

async function commitCount(): Promise<number> {
  return (await gitLog(repoDirFor(WS), DEFAULT_BRANCH, 100)).length;
}

const ctx = () => ({ workspaceId: WS, userId: undefined, role: undefined });

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-rename-"));
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
  await Promise.all([Flow.deleteMany({}), CdcEntityState.deleteMany({})]);
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

describe("the lookup rule (pure)", () => {
  const a = {
    _id: new Types.ObjectId(),
    slug: "a",
    aliases: ["old"],
    name: "A",
  };
  const b = {
    _id: new Types.ObjectId(),
    slug: "b",
    aliases: ["old"],
    name: "B",
  };
  const c = { _id: new Types.ObjectId(), slug: "old", aliases: [], name: "C" };

  it("id beats slug beats alias; an alias two rows claim resolves to neither", () => {
    expect(pickFlowByRef([a, b, c], a._id.toString())?.row).toBe(a);
    expect(pickFlowByRef([a, b, c], "old")).toEqual({ row: c, via: "current" });
    expect(pickFlowByRef([a, b], "old")).toBeNull();
    expect(pickFlowByRef([a, c], "a")).toEqual({ row: a, via: "current" });
    expect(pickFlowByRef([a], "old")).toEqual({ row: a, via: "alias" });
    expect(pickFlowByRef([a], "nope")).toBeNull();
  });
});

describe("resolve", () => {
  it("finds a flow by id, by slug, by an old slug, and a git-only file by its derived id", async () => {
    await push({
      "flows/close-crm.yml": flowYaml("Close", "aliases: [legacy-close]"),
      "flows/git-only.yml": flowYaml("Git only"),
    });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-crm" });
    // Simulate a git-only file: drop its row.
    await Flow.deleteOne({ workspaceId: WS, slug: "git-only" });

    const byId = await flowRenameHandler.resolve(ctx(), row!._id.toString());
    expect(byId).toMatchObject({
      kind: "flow",
      id: row!._id.toString(),
      via: "current",
      current: {
        slug: "close-crm",
        url: `/f/${row!._id}`,
        path: "flows/close-crm.yml",
      },
    });
    expect((await flowRenameHandler.resolve(ctx(), "close-crm"))?.via).toBe(
      "current",
    );
    const byAlias = await flowRenameHandler.resolve(ctx(), "legacy-close");
    expect(byAlias?.via).toBe("alias");
    expect(byAlias?.id).toBe(row!._id.toString());
    expect(await flowRenameHandler.resolve(ctx(), "nothing-here")).toBeNull();

    const gitOnly = await flowRenameHandler.resolve(ctx(), "git-only");
    expect(gitOnly?.via).toBe("current");
    expect(gitOnly?.current.slug).toBe("git-only");
  });
});

describe("rename", () => {
  it("moves the file and writes the alias in ONE commit; the row keeps its id and runtime", async () => {
    await push({ "flows/close-crm.yml": flowYaml("Close CRM") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-crm" });
    const endpoint = row!.webhookConfig?.endpoint;
    await CdcEntityState.create({
      workspaceId: new Types.ObjectId(WS),
      flowId: row!._id,
      entity: "leads",
      mode: "steady",
      lastIngestSeq: 1,
      lastMaterializedSeq: 1,
      backlogCount: 0,
      lifetimeEventsProcessed: 0,
      lifetimeRowsApplied: 0,
      mergeIntervalSeconds: 30,
      consecutiveFailures: 0,
    });
    const commitsBefore = await commitCount();

    const result = await flowRenameHandler.rename(ctx(), {
      ref: "close-crm",
      title: "CRM sync",
      slug: "crm-sync",
    });
    expect(result).toMatchObject({
      kind: "flow",
      id: row!._id.toString(),
      before: { title: "Close CRM", slug: "close-crm" },
      after: { title: "CRM sync", slug: "crm-sync", url: `/f/${row!._id}` },
      aliasesAdded: ["close-crm"],
      warnings: [],
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitCount()).toBe(commitsBefore + 1);

    // One commit did both halves.
    expect(await fileAt("flows/close-crm.yml")).toBeNull();
    const moved = parseFlowFile((await fileAt("flows/crm-sync.yml")) ?? "");
    expect(moved?.name).toBe("CRM sync");
    expect(moved?.aliases).toEqual(["close-crm"]);

    const after = await Flow.findById(row!._id);
    expect(after?.slug).toBe("crm-sync");
    expect(after?.name).toBe("CRM sync");
    expect(after?.aliases).toEqual(["close-crm"]);
    expect(after?.webhookConfig?.endpoint).toBe(endpoint);
    expect(await CdcEntityState.countDocuments({ flowId: row!._id })).toBe(1);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(1);

    // Old and new names both resolve, and the row is level with the file
    // (the push-sync that follows the mirror push changes nothing).
    expect((await flowRenameHandler.resolve(ctx(), "close-crm"))?.id).toBe(
      row!._id.toString(),
    );
    const sync = await syncFlowsFromRepo(WS, "u1");
    expect(sync).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  it("a title-only rename rewrites name: and leaves the file where it is", async () => {
    await push({ "flows/stripe.yml": flowYaml("Stripe") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "stripe" });
    const result = await flowRenameHandler.rename(ctx(), {
      ref: row!._id.toString(),
      title: "Stripe → BigQuery",
    });
    expect(result.aliasesAdded).toEqual([]);
    expect(result.after.slug).toBe("stripe");
    expect(await fileAt("flows/stripe.yml")).toContain(
      "name: Stripe → BigQuery",
    );
    expect((await Flow.findById(row!._id))?.name).toBe("Stripe → BigQuery");
    // Nothing to change → no commit, says so.
    const again = await flowRenameHandler.rename(ctx(), {
      ref: "stripe",
      title: "Stripe → BigQuery",
    });
    expect(again.commit).toBeUndefined();
    expect(again.warnings[0]).toMatch(/Nothing changed/);
  });

  it("refuses a taken slug — current or an old name another flow still answers to — and an invalid one", async () => {
    await push({
      "flows/a.yml": flowYaml("A", "aliases: [a-old]"),
      "flows/b.yml": flowYaml("B"),
    });
    await syncFlowsFromRepo(WS, "u1");
    for (const [slug, status, pattern] of [
      ["a", 409, /already the file name/],
      ["a-old", 409, /old name of flow "A"/],
      ["Not Valid", 400, /not a valid file name/],
      ["double--dash", 400, /not a valid file name/],
    ] as const) {
      await expect(
        flowRenameHandler.rename(ctx(), { ref: "b", slug }),
      ).rejects.toMatchObject({
        status,
        message: expect.stringMatching(pattern),
      });
    }
    // A git-only file under the new slug is taken too.
    await push({ "flows/c.yml": flowYaml("C") });
    await expect(
      flowRenameHandler.rename(ctx(), { ref: "b", slug: "c" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await Flow.findOne({ workspaceId: WS, slug: "b" })).not.toBeNull();
  });

  it("refuses to touch a file it cannot parse, and reports unknown refs", async () => {
    await push({ "flows/ok.yml": flowYaml("Ok") });
    await syncFlowsFromRepo(WS, "u1");
    const broken = "name: [unclosed";
    await push({ "flows/ok.yml": broken });
    await expect(
      flowRenameHandler.rename(ctx(), { ref: "ok", slug: "renamed" }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof RenameError && e.status === 409,
    );
    // User content untouched.
    expect(await fileAt("flows/ok.yml")).toBe(broken);
    expect(await fileAt("flows/renamed.yml")).toBeNull();
    expect(await Flow.findOne({ workspaceId: WS, slug: "ok" })).not.toBeNull();

    await expect(
      flowRenameHandler.rename(ctx(), { ref: "ghost", title: "x" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("review findings: concurrency", () => {
  it("[3a] the rename commit is refused when the old file changed under it; nothing is written", async () => {
    await push({ "flows/race.yml": flowYaml("Race") });
    await syncFlowsFromRepo(WS, "u1");
    // The service reads flows/race.yml, then freshens before committing:
    // land a save on the old path in that window.
    let armed = 0;
    freshenHook.fn = async () => {
      // The first freshen is the service's read-side one; arm the second
      // (inside commitFlowConfig) to mutate.
      armed += 1;
      freshenHook.fn = async () => {
        await push({ "flows/race.yml": flowYaml("Race (edited meanwhile)") });
      };
    };
    await expect(
      flowRenameHandler.rename(ctx(), { ref: "race", slug: "raced" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/changed while renaming/),
    });
    expect(armed).toBe(1);
    expect(await fileAt("flows/raced.yml")).toBeNull();
    expect(await fileAt("flows/race.yml")).toContain("edited meanwhile");
    expect(
      await Flow.findOne({ workspaceId: WS, slug: "race" }),
    ).not.toBeNull();
    freshenHook.fn = null;
  });

  it("[3a] two renames of the same flow cannot both apply", async () => {
    await push({ "flows/dup.yml": flowYaml("Dup") });
    await syncFlowsFromRepo(WS, "u1");
    freshenHook.fn = async () => {
      freshenHook.fn = async () => {
        // The other rename lands first.
        await flowRenameHandler.rename(ctx(), { ref: "dup", slug: "dup-b" });
      };
    };
    await expect(
      flowRenameHandler.rename(ctx(), { ref: "dup", slug: "dup-a" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await fileAt("flows/dup-a.yml")).toBeNull();
    expect(await fileAt("flows/dup.yml")).toBeNull();
    expect(await fileAt("flows/dup-b.yml")).toContain("name: Dup");
    expect((await Flow.find({ workspaceId: WS })).map(r => r.slug)).toEqual([
      "dup-b",
    ]);
    freshenHook.fn = null;
  });

  it("[3b] a write-through holding a stale slug fails instead of resurrecting the old file", async () => {
    await push({ "flows/edit.yml": flowYaml("Edit") });
    await syncFlowsFromRepo(WS, "u1");
    const inFlight = await Flow.findOne({ workspaceId: WS, slug: "edit" });
    await flowRenameHandler.rename(ctx(), { ref: "edit", slug: "edited" });
    inFlight!.name = "Edit (from a stale form)";
    const result = await commitFlowFile(inFlight!, "u1");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/renamed to "edited"/);
    expect(await fileAt("flows/edit.yml")).toBeNull();
    expect(await fileAt("flows/edited.yml")).toContain("name: Edit\n");
  });

  it("[2] resolution: a live file at main beats an alias; renaming by that old name is refused", async () => {
    await push({ "flows/old.yml": flowYaml("Old") });
    await syncFlowsFromRepo(WS, "u1");
    const row = await Flow.findOne({ workspaceId: WS, slug: "old" });
    await flowRenameHandler.rename(ctx(), { ref: "old", slug: "new" });
    expect((await flowRenameHandler.resolve(ctx(), "old"))?.via).toBe("alias");
    await push({ "flows/old.yml": flowYaml("Old reborn") });
    const resolved = await flowRenameHandler.resolve(ctx(), "old");
    expect(resolved?.via).toBe("current");
    expect(resolved?.id).not.toBe(row!._id.toString());
    expect(resolved?.current.title).toBe("Old reborn");
    await expect(
      flowRenameHandler.rename(ctx(), { ref: "old", title: "x" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/flow of its own/),
    });
  });
});

describe("round 2: saves racing renames, files edited in place", () => {
  it("[r2-2] a save whose first freshen overlaps a rename fails on the slug re-read; one landing on the commit's freshen fails the CAS — never two files", async () => {
    const { runGit } = await import("../apps/git");
    const ls = async () =>
      (
        await runGit([
          "-C",
          repoDirFor(WS),
          "ls-tree",
          "--name-only",
          "-r",
          DEFAULT_BRANCH,
          "flows/",
        ])
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean);
    await push({ "flows/foo.yml": flowYaml("Foo") });
    await syncFlowsFromRepo(WS, "u1");

    // (i) the rename lands during the save's own freshen
    const inFlight = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    inFlight!.name = "Foo (edited in form)";
    freshenHook.fn = async () => {
      await flowRenameHandler.rename(ctx(), { ref: "foo", slug: "bar" });
    };
    const first = await commitFlowFile(inFlight!, "u1");
    expect(first.ok).toBe(false);
    expect(first.error).toMatch(/renamed to "bar"/);
    expect(await ls()).toEqual(["flows/bar.yml"]);

    // (ii) the rename lands during the freshen INSIDE the commit (after the
    // slug re-read passed): the compare-and-swap on the file refuses it.
    const again = await Flow.findOne({ workspaceId: WS, slug: "bar" });
    again!.name = "Bar (edited in form)";
    freshenHook.fn = async () => {
      freshenHook.fn = async () => {
        await flowRenameHandler.rename(ctx(), { ref: "bar", slug: "baz" });
      };
    };
    const second = await commitFlowFile(again!, "u1");
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/changed in the workspace repo/);
    expect(await ls()).toEqual(["flows/baz.yml"]);
    freshenHook.fn = null;

    // One flow, one stream, after the push sync.
    await syncFlowsFromRepo(WS, "u1");
    const rows = await Flow.find({ workspaceId: WS });
    expect(rows.map(r => r.slug)).toEqual(["baz"]);
    expect(rows[0]._id.toString()).toBe(inFlight!._id.toString());
  });

  it("[r2-4] a rename edits name:/aliases: in place — comments and unknown keys survive, title-only included", async () => {
    const annotated = [
      "# owned by growth team — do not change the schema",
      "name: Foo",
      "description: leads stream",
      "type: webhook",
      "source:",
      "  type: connector",
      `  connector_id: ${CONNECTOR}`,
      "destination:",
      `  connection_id: ${DEST}`,
      "  table:",
      "    schema: raw_a  # prod dataset",
      "    create_if_not_exists: true",
      "webhook:",
      "  enabled: true",
      "sync:",
      "  engine: cdc",
      "",
    ].join("\n");
    await push({ "flows/foo.yml": annotated });
    await syncFlowsFromRepo(WS, "u1");
    await flowRenameHandler.rename(ctx(), {
      ref: "foo",
      title: "Foo → Warehouse",
    });
    expect(await fileAt("flows/foo.yml")).toBe(
      annotated.replace("name: Foo", "name: Foo → Warehouse"),
    );
    await flowRenameHandler.rename(ctx(), { ref: "foo", slug: "foo-sync" });
    expect(await fileAt("flows/foo-sync.yml")).toBe(
      annotated.replace(
        "name: Foo\n",
        "name: Foo → Warehouse\naliases:\n  - foo\n",
      ),
    );
    // A file the editor cannot handle in place is refused, not rewritten.
    const blockName = annotated.replace("name: Foo\n", "name: |\n  Foo\n");
    await push({ "flows/odd.yml": blockName });
    await syncFlowsFromRepo(WS, "u1");
    await expect(
      flowRenameHandler.rename(ctx(), { ref: "odd", title: "Odd" }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/edited in place/),
    });
    expect(await fileAt("flows/odd.yml")).toBe(blockName);
  });
});
