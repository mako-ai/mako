/**
 * Graceful rename of dbt files (api/src/rename/dbt-file.ts): one commit
 * carrying the move and the `ref()` / job-selector rewrites, old paths
 * resolving through git's rename detection, and the dbt RBAC honoured.
 * Real bare repo under a temp APPS_GIT_ROOT + mongodb-memory-server — the
 * same rig as dbt-file-tools.test.ts.
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

const realtime = vi.hoisted(() => ({ publishRealtimeEvent: vi.fn() }));
vi.mock("../services/realtime.service", () => realtime);

// A one-shot hook run inside the rename, after it has read the files it
// rewrites and before it commits (grepTree is its warnings scan) — where a
// save from another window can land.
const race = vi.hoisted(() => ({
  hook: null as null | (() => Promise<void>),
  beforeBlobRead: null as null | (() => Promise<void>),
}));
vi.mock("../apps/repository.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../apps/repository.service")>();
  return {
    ...actual,
    readBlobsBatch: async (
      ...args: Parameters<typeof actual.readBlobsBatch>
    ) => {
      const hook = race.beforeBlobRead;
      race.beforeBlobRead = null;
      if (hook) await hook();
      return actual.readBlobsBatch(...args);
    },
    grepTree: async (...args: Parameters<typeof actual.grepTree>) => {
      const hook = race.hook;
      race.hook = null;
      if (hook) await hook();
      return actual.grepTree(...args);
    },
  };
});

import { AppWorktree, DbtProject } from "../database/workspace-schema";
import { seedDbtGitTree } from "./test-support/git-tree";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  listTree,
  log as repoLog,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../apps/repository.service";
import { runGit } from "../apps/git";
import {
  parseDbtFileRef,
  renameDbtFile,
  resolveDbtFile,
} from "../rename/dbt-file";
import { dbtFileRenameHandler } from "../rename/handlers/dbt-file";
import { serializeJobFile } from "./dbt-config-files";
import { RenameError } from "../rename/types";

let mongo: MongoMemoryServer;
let tmpRoot: string;
const WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId();
const USER = "u1";
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const member = { workspaceId: WS, userId: USER, role: "member" };

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-rename-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  realtime.publishRealtimeEvent.mockClear();
  await Promise.all([DbtProject.deleteMany({}), AppWorktree.deleteMany({})]);
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
});

const MART = [
  "select o.*, c.name",
  "from {{ ref('orders') }} o",
  'join {{ ref("customers") }} c on c.id = o.customer_id',
  "left join {{ ref('analytics', 'orders') }} again on 1=1",
  "-- see {{ ref('orders_archive') }}",
  "",
].join("\n");

const JOB = [
  "# nightly  (a comment the author wrote)",
  "name: Daily",
  "description: unknown to the parser, must survive",
  "environment: dev",
  "commands:",
  "  - dbt run --select orders+ tag:daily",
  "  - dbt test -s customers,orders",
  "  - dbt run --select marts.orders",
  "enabled: true",
  "",
].join("\n");

const PROJECT_YML = [
  "name: analytics",
  "models:",
  "  analytics:",
  "    orders:",
  "      +materialized: table",
  "    marts:",
  "      orders: # a different model, models/marts/orders.sql, not this one",
  "        +enabled: false",
  "",
].join("\n");
const SELECTORS =
  "selectors:\n  - name: nightly\n    definition:\n      method: fqn\n      value: orders+\n";
const LONG_COMMAND =
  "dbt build --select orders+ stg_customers stg_payments stg_products stg_suppliers dim_dates fct_events --exclude tag:x";
const SNAPSHOT =
  "{% snapshot orders_snapshot %}\nselect * from {{ ref('orders') }}\n{% endsnapshot %}\n";

async function seedProject(extra: Record<string, string> = {}) {
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
      { name: "dev", connectionId: CONN, targetSchema: "dbt_dev", threads: 4 },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  await seedDbtGitTree(WS, {
    "dbt_project.yml": PROJECT_YML,
    "selectors.yml": SELECTORS,
    "snapshots/orders.sql": SNAPSHOT,
    "models/orders.sql": "select 1 as id, 1 as customer_id\n",
    "models/customers.sql": "select 1 as id, 'x' as name\n",
    "models/orders_archive.sql": "select * from {{ ref('orders') }}\n",
    "models/mart.sql": MART,
    "models/schema.yml":
      "version: 2\nmodels:\n  - name: orders\nunit_tests:\n  - name: t_orders\n    model: orders\n    given:\n      - input: ref('customers')\n        rows: []\n",
    "jobs/daily.yml": JOB,
    "jobs/long.yml": serializeJobFile({
      name: "Long",
      environment: "dev",
      commands: [LONG_COMMAND],
      schedule: null,
      enabled: true,
      deferToProduction: false,
    }),
    ...extra,
  });
  return project;
}

async function fileAt(rel: string, ref = MAIN): Promise<string | null> {
  try {
    const blob = await readBlob(repoDirFor(WS), ref, `dbt/${rel}`);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

describe("parseDbtFileRef", () => {
  it("accepts the URL, projectId/path, dbt/path and bare path forms", () => {
    const pid = new Types.ObjectId().toString();
    expect(parseDbtFileRef(`/x/${pid}/file/models/a%20b.sql`)).toEqual({
      projectId: pid,
      path: "models/a b.sql",
    });
    expect(parseDbtFileRef(`${pid}/models/a.sql`)).toEqual({
      projectId: pid,
      path: "models/a.sql",
    });
    expect(parseDbtFileRef("dbt/models/a.sql")).toEqual({
      path: "models/a.sql",
    });
    expect(parseDbtFileRef("models/a.sql")).toEqual({ path: "models/a.sql" });
    expect(parseDbtFileRef("  ")).toBeNull();
  });
});

describe("renameDbtFile", () => {
  it("moves a model and rewrites refs + job selectors in ONE commit on main", async () => {
    const project = await seedProject();
    const before = await repoLog(repoDirFor(WS), MAIN, 50);

    const result = await renameDbtFile(member, {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });

    const after = await repoLog(repoDirFor(WS), MAIN, 50);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].oid).toBe(result.commit);
    expect(after[0].subject).toContain(
      "models/orders.sql -> models/fct_orders.sql",
    );

    expect(await fileAt("models/orders.sql")).toBeNull();
    expect(await fileAt("models/fct_orders.sql")).toBe(
      "select 1 as id, 1 as customer_id\n",
    );
    expect(await fileAt("models/mart.sql")).toBe(
      [
        "select o.*, c.name",
        "from {{ ref('fct_orders') }} o",
        'join {{ ref("customers") }} c on c.id = o.customer_id',
        "left join {{ ref('analytics', 'fct_orders') }} again on 1=1",
        "-- see {{ ref('orders_archive') }}",
        "",
      ].join("\n"),
    );
    expect(await fileAt("models/orders_archive.sql")).toBe(
      "select * from {{ ref('fct_orders') }}\n",
    );
    // Job selectors are rewritten on the command lines; every other byte
    // of the author's file (comment, unknown key) survives.
    expect(await fileAt("jobs/daily.yml")).toBe(
      JOB.replace("--select orders+", "--select fct_orders+").replace(
        "customers,orders",
        "customers,fct_orders",
      ),
    );
    expect(result.warnings.join("\n")).toMatch(
      /jobs\/daily.yml: selector "marts.orders" still names 'orders'/,
    );
    // A Mako-written job with a folded long command is rewritten too.
    expect(await fileAt("jobs/long.yml")).toContain(
      `  - ${JSON.stringify(LONG_COMMAND.replace("orders+", "fct_orders+"))}\n`,
    );
    // The UI guards its own dirty buffers; an MCP/agent rename (no
    // clientId) is told about editors it cannot see.
    expect(result.warnings.join("\n")).toMatch(
      /Open editors with unsaved changes/,
    );
    // dbt_project.yml: the key at the model's PATH follows; the same name
    // under another folder is another model — kept, and warned about.
    expect(await fileAt("dbt_project.yml")).toBe(
      PROJECT_YML.replace("    orders:\n", "    fct_orders:\n"),
    );
    // Every file still naming the old model as a whole word is listed.
    expect(result.warnings.join("\n")).toMatch(
      /3 files still mention 'orders' as a whole word after the rewrite — check dbt_project.yml, jobs\/daily.yml, selectors.yml\./,
    );
    expect(await fileAt("selectors.yml")).toBe(SELECTORS);
    expect(result.warnings.join("\n")).not.toMatch(/models\/mart.sql/);
    // The model's own schema.yml entry and its unit test follow.
    expect(await fileAt("models/schema.yml")).toBe(
      "version: 2\nmodels:\n  - name: fct_orders\nunit_tests:\n  - name: t_orders\n    model: fct_orders\n    given:\n      - input: ref('customers')\n        rows: []\n",
    );

    expect(result.kind).toBe("dbt_file");
    expect(result.id).toBe(`${project._id}/models/fct_orders.sql`);
    expect(result.before.url).toBe(`/x/${project._id}/file/models/orders.sql`);
    expect(result.after.url).toBe(
      `/x/${project._id}/file/models/fct_orders.sql`,
    );
    expect(result.warnings.join("\n")).toMatch(
      /relation for 'orders' still exists/,
    );
    // Main is where it landed: no branch warning.
    expect(result.warnings.join("\n")).not.toMatch(/Committed on your branch/);

    // Open windows: the old tab retargets, the rewritten files refresh.
    const events = realtime.publishRealtimeEvent.mock.calls.map(c => c[1]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "dbt.file.updated",
        path: "models/orders.sql",
        deleted: true,
        renamedTo: "models/fct_orders.sql",
        // On main the change is everyone's: workspace-wide poke.
        forUserId: undefined,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "dbt.file.updated",
        path: "models/mart.sql",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "dbt.job.updated" }),
    );
  });

  it("updateRefs: false moves the file only and says what it left broken", async () => {
    await seedProject();
    const result = await renameDbtFile(member, {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
      updateRefs: false,
    });
    expect(await fileAt("models/mart.sql")).toBe(MART);
    expect(await fileAt("jobs/daily.yml")).toBe(JOB);
    expect(result.warnings.join("\n")).toMatch(/NOT rewritten/);
  });

  it("a non-model file is just moved: no rewrite, no relation warning", async () => {
    await seedProject();
    const result = await renameDbtFile(member, {
      from: "models/schema.yml",
      to: "models/_orders.yml",
    });
    expect(await fileAt("models/_orders.yml")).toContain("version: 2");
    expect(await fileAt("models/mart.sql")).toBe(MART);
    expect(result.warnings).toEqual([]);
  });

  it("lands on the actor's SESSION branch and says so", async () => {
    await seedProject();
    await AppWorktree.create({
      workspaceId: new Types.ObjectId(WS),
      userId: USER,
      branch: "feature/renames",
    });
    const result = await renameDbtFile(member, {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });
    expect(await fileAt("models/orders.sql")).not.toBeNull(); // main untouched
    expect(
      await fileAt("models/fct_orders.sql", "refs/heads/feature/renames"),
    ).not.toBeNull();
    expect(result.warnings.join("\n")).toMatch(/branch 'feature\/renames'/);
    // A branch-local change pokes only the actor's windows: a teammate on
    // another branch has no such path and must not lose the file.
    const events = realtime.publishRealtimeEvent.mock.calls
      .map(c => c[1])
      .filter(e => e.type === "dbt.file.updated");
    expect(events).not.toHaveLength(0);
    for (const e of events) expect(e.forUserId).toBe(USER);
  });

  it("renaming a snapshot file does not touch the model of the same name", async () => {
    await seedProject();
    const result = await renameDbtFile(member, {
      from: "snapshots/orders.sql",
      to: "snapshots/orders_v2.sql",
    });
    expect(await fileAt("models/mart.sql")).toBe(MART);
    expect(await fileAt("snapshots/orders_v2.sql")).toBe(SNAPSHOT);
    expect(result.warnings).toEqual([]);
  });

  it("moving a model out of models/ warns that its refs were left behind", async () => {
    await seedProject();
    const result = await renameDbtFile(member, {
      from: "models/orders.sql",
      to: "analyses/orders.sql",
    });
    expect(await fileAt("models/mart.sql")).toBe(MART);
    expect(result.warnings.join("\n")).toMatch(/is not a model path/);
  });

  it("refuses (409) when a file it rewrites is saved mid-rename, and overwrites nothing", async () => {
    await seedProject();
    const saved = MART.replace("select o.*", "select o.id");
    race.hook = async () => {
      await commitBlobsOnBranch(
        repoDirFor(WS),
        DEFAULT_BRANCH,
        { writes: { "dbt/models/mart.sql": saved } },
        { message: "a save from another window" },
      );
    };
    await expect(
      renameDbtFile(member, {
        from: "models/orders.sql",
        to: "models/orders_v2.sql",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(race.hook).toBeNull(); // the race really ran
    expect(await fileAt("models/mart.sql")).toBe(saved);
    expect(await fileAt("models/orders.sql")).not.toBeNull();
    expect(await fileAt("models/orders_v2.sql")).toBeNull();
  });

  it("moves the content its precondition pins: a save landing before the byte read is kept", async () => {
    await seedProject();
    const saved = "select 2 as id, 1 as customer_id -- saved mid-rename\n";
    race.beforeBlobRead = async () => {
      await commitBlobsOnBranch(
        repoDirFor(WS),
        DEFAULT_BRANCH,
        { writes: { "dbt/models/orders.sql": saved } },
        { message: "an autosave" },
      );
    };
    await renameDbtFile(member, {
      from: "models/orders.sql",
      to: "models/orders_v2.sql",
      updateRefs: false,
    });
    expect(race.beforeBlobRead).toBeNull(); // the race really ran
    expect(await fileAt("models/orders_v2.sql")).toBe(saved);
    expect(await fileAt("models/orders.sql")).toBeNull();
  });

  it("renames UTF-8 text with non-ASCII characters (the read blob matches)", async () => {
    await seedProject({ "models/café.sql": "-- café ☕\nselect 1 as id\n" });
    await renameDbtFile(member, {
      from: "models/café.sql",
      to: "models/cafe.sql",
    });
    expect(await fileAt("models/cafe.sql")).toBe(
      "-- café ☕\nselect 1 as id\n",
    );
    expect(await fileAt("models/café.sql")).toBeNull();
  });

  it("refuses to move a file that is not UTF-8, leaving its bytes untouched", async () => {
    await seedProject();
    const latin1 = Buffer.from("-- caf\xe9\nselect 1 as id\n", "latin1");
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { writes: { "dbt/models/legacy.sql": latin1 } },
      { message: "a latin-1 file from a laptop" },
    );
    await expect(
      renameDbtFile(member, {
        from: "models/legacy.sql",
        to: "models/legacy_v2.sql",
      }),
    ).rejects.toMatchObject({ status: 400 });
    const raw = await readBlob(repoDirFor(WS), MAIN, "dbt/models/legacy.sql");
    expect(raw.isBinary ? null : raw.contents).not.toBeNull();
    expect(await fileAt("models/legacy_v2.sql")).toBeNull();
  });

  it("refuses viewers, missing sources and occupied targets", async () => {
    await seedProject();
    await expect(
      renameDbtFile(
        { ...member, role: "viewer" },
        { from: "models/orders.sql", to: "models/x.sql" },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      renameDbtFile(member, { from: "models/nope.sql", to: "models/x.sql" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      renameDbtFile(member, {
        from: "models/orders.sql",
        to: "models/customers.sql",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      renameDbtFile(member, { from: "models/orders.sql", to: "../x.sql" }),
    ).rejects.toBeInstanceOf(RenameError);
    // Nothing moved.
    expect(await fileAt("models/orders.sql")).not.toBeNull();
  });
});

describe("modes, path conflicts and node-name clashes", () => {
  it("an executable keeps 100755, a symlinked model moves by oid as a symlink, a rewritten executable keeps its mode", async () => {
    const project = await seedProject();
    const repoDir = repoDirFor(WS);
    const hash = async (text: string) =>
      (
        await runGit(["-C", repoDir, "hash-object", "-w", "--stdin"], {
          stdin: text,
        })
      ).stdout.trim();
    const exe = await hash("#!/bin/sh\necho hi\n");
    const py = await hash("def model(dbt, s):\n    return dbt.ref('orders')\n");
    const link = await hash("orders.sql");
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      {
        entries: [
          { path: "dbt/scripts/run.sh", oid: exe, mode: "100755" },
          { path: "dbt/models/py_model.py", oid: py, mode: "100755" },
          { path: "dbt/models/orders_link.sql", oid: link, mode: "120000" },
        ],
      },
      { message: "seed modes" },
    );
    const modesAt = async () =>
      Object.fromEntries(
        (await listTree(repoDir, (await resolveCommit(repoDir, MAIN))!))
          .filter(e => e.path.startsWith("dbt/"))
          .map(e => [e.path.slice(4), [e.mode, e.oid]]),
      );
    const before = await modesAt();

    await renameDbtFile(member, {
      from: "scripts/run.sh",
      to: "scripts/go.sh",
    });
    const link2 = await renameDbtFile(member, {
      from: "models/orders_link.sql",
      to: "models/orders_link2.sql",
    });
    expect(link2.warnings.join("\n")).toMatch(
      /is a symlink; it was moved as-is/,
    );
    await renameDbtFile(member, {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });
    const after = await modesAt();
    expect(after["scripts/go.sh"]).toEqual(before["scripts/run.sh"]); // mode + oid
    expect(after["models/orders_link2.sql"]).toEqual(
      before["models/orders_link.sql"],
    ); // still a symlink
    expect(after["models/py_model.py"][0]).toBe("100755"); // rewritten, mode kept
    expect(await fileAt("models/py_model.py")).toContain(
      "dbt.ref('fct_orders')",
    );
    expect(project).toBeTruthy();
  });

  it("a same-relative-path symlink OUTSIDE dbt/ lends the move neither its mode nor its oid", async () => {
    await seedProject();
    const repoDir = repoDirFor(WS);
    const link = (
      await runGit(["-C", repoDir, "hash-object", "-w", "--stdin"], {
        stdin: "../../somewhere/else.sql",
      })
    ).stdout.trim();
    // `src/` is 4 chars like `dbt/`: minus their top-level dir, these paths
    // are the dbt project's models/orders.sql and models/mart.sql.
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      {
        entries: [
          { path: "src/models/orders.sql", oid: link, mode: "120000" },
          { path: "src/models/mart.sql", oid: link, mode: "120000" },
        ],
      },
      { message: "unrelated symlinks" },
    );
    await renameDbtFile(member, {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });
    const tree = await listTree(repoDir, (await resolveCommit(repoDir, MAIN))!);
    const moved = tree.find(e => e.path === "dbt/models/fct_orders.sql");
    expect(moved?.mode).toBe("100644");
    expect(moved?.oid).not.toBe(link);
    expect(await fileAt("models/fct_orders.sql")).toBe(
      "select 1 as id, 1 as customer_id\n",
    );
    // The dbt file sharing a relative path with the other symlink is still
    // text to rewrite, not a link to skip.
    expect(await fileAt("models/mart.sql")).toContain("ref('fct_orders')");
    // And the unrelated symlinks are untouched.
    for (const p of ["src/models/orders.sql", "src/models/mart.sql"]) {
      expect(tree.find(e => e.path === p)).toMatchObject({
        mode: "120000",
        oid: link,
      });
    }
  });

  it("a move UNDER an existing file is refused (409) and that file survives", async () => {
    await seedProject();
    await expect(
      renameDbtFile(member, {
        from: "models/customers.sql",
        to: "models/orders_archive.sql/customers.sql",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("is an existing file"),
    });
    expect(await fileAt("models/orders_archive.sql")).toContain(
      "ref('orders')",
    );
    expect(await fileAt("models/customers.sql")).not.toBeNull();
    // The guard lives in commitBlobsOnBranch, so a plain write hits it too.
    await expect(
      commitBlobsOnBranch(
        repoDirFor(WS),
        DEFAULT_BRANCH,
        { writes: { "dbt/models/orders_archive.sql/x.sql": "select 1\n" } },
        { message: "file-as-dir" },
      ),
    ).rejects.toMatchObject({ name: "PathConflictError" });
    await expect(
      commitBlobsOnBranch(
        repoDirFor(WS),
        DEFAULT_BRANCH,
        { writes: { "dbt/models": "select 1\n" } },
        { message: "dir-as-file" },
      ),
    ).rejects.toMatchObject({ name: "PathConflictError", kind: "directory" });
    // …unless the mutation itself removes what is in the way.
    const ok = await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: { "dbt/models/orders_archive.sql/x.sql": "select 1\n" },
        deletes: ["dbt/models/orders_archive.sql"],
      },
      { message: "replace file with folder" },
    );
    expect(ok.unchanged).toBe(false);
  });

  it("renaming onto a node name that already exists is refused (409): model, seed and snapshot", async () => {
    await seedProject({ "seeds/countries.csv": "code\nCH\n" });
    await expect(
      renameDbtFile(member, {
        from: "models/orders.sql",
        to: "models/staging/customers.sql",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        "'customers' already exists (models/customers.sql)",
      ),
    });
    await expect(
      renameDbtFile(member, {
        from: "models/orders.sql",
        to: "models/countries.sql",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("seeds/countries.csv"),
    });
    await expect(
      renameDbtFile(member, {
        from: "models/orders.sql",
        to: "models/orders_snapshot.sql",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("snapshot in snapshots/orders.sql"),
    });
    expect(await fileAt("models/mart.sql")).toBe(MART);
    // Same name, other folder: the file moves, refs untouched.
    const moved = await renameDbtFile(member, {
      from: "models/orders.sql",
      to: "models/marts/orders.sql",
    });
    expect(moved.after.slug).toBe("models/marts/orders.sql");
    expect(await fileAt("models/mart.sql")).toBe(MART);
  });

  it("refuses a path that differs from another file's, or a folder's, only in case — a file may change the case of its own name", async () => {
    await seedProject();
    // Git keeps the two apart; a checkout on macOS or Windows cannot.
    await expect(
      renameDbtFile(member, {
        from: "models/orders.sql",
        to: "models/Customers.sql",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        '"models/customers.sql" already exists, and "models/Customers.sql" differs from it only in upper/lower case',
      ),
    });
    await expect(
      renameDbtFile(member, {
        from: "models/orders.sql",
        to: "Models/orders_v2.sql",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('"models" already exists'),
    });
    expect(await fileAt("models/orders.sql")).not.toBeNull();
    // Its own name in another case: a plain git mv.
    const own = await renameDbtFile(member, {
      from: "models/mart.sql",
      to: "models/Mart.sql",
    });
    expect(own.after.slug).toBe("models/Mart.sql");
    expect(await fileAt("models/Mart.sql")).toBe(MART);
    expect(await fileAt("models/mart.sql")).toBeNull();
  });

  it("the handler accepts an OLD path the file moved away from", async () => {
    const project = await seedProject();
    await renameDbtFile(member, {
      from: "models/customers.sql",
      to: "models/dim_customers.sql",
    });
    const r = await dbtFileRenameHandler.rename(member, {
      ref: `/x/${project._id}/file/models/customers.sql`,
      title: "customers_v2.sql",
    });
    expect(r.before.slug).toBe("models/dim_customers.sql");
    expect(r.after.slug).toBe("models/customers_v2.sql");
  });
});

describe("resolveDbtFile", () => {
  it("resolves current paths, follows renames (UI or bare git mv), and reports dead links", async () => {
    const project = await seedProject();
    const pid = project._id.toString();

    const current = await resolveDbtFile(
      member,
      `/x/${pid}/file/models/orders.sql`,
    );
    expect(current).toMatchObject({
      via: "current",
      current: { url: `/x/${pid}/file/models/orders.sql` },
    });

    // UI rename, then the old link.
    await renameDbtFile(member, {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });
    const moved = await resolveDbtFile(member, "models/orders.sql");
    expect(moved).toMatchObject({
      via: "alias",
      current: {
        slug: "models/fct_orders.sql",
        path: "dbt/models/fct_orders.sql",
        url: `/x/${pid}/file/models/fct_orders.sql`,
      },
    });

    // A laptop `git mv` pushed to main: delete + add, identical content.
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "dbt/models/dim_customers.sql": "select 1 as id, 'x' as name\n",
        },
        deletes: ["dbt/models/customers.sql"],
      },
      { message: "laptop rename" },
    );
    expect(await resolveDbtFile(member, "models/customers.sql")).toMatchObject({
      via: "alias",
      current: { slug: "models/dim_customers.sql" },
    });
    // Chains follow: orders → fct_orders → fct_orders_v2.
    await renameDbtFile(member, {
      from: "models/fct_orders.sql",
      to: "models/marts/fct_orders_v2.sql",
    });
    expect(await resolveDbtFile(member, "models/orders.sql")).toMatchObject({
      via: "alias",
      current: { slug: "models/marts/fct_orders_v2.sql" },
    });

    expect(await resolveDbtFile(member, "models/never.sql")).toBeNull();
    expect(await resolveDbtFile(member, "../etc/passwd")).toBeNull();
  });
});

describe("dbtFileRenameHandler", () => {
  it("title renames in place, slug moves, options.updateRefs is honoured", async () => {
    const project = await seedProject();
    const pid = project._id.toString();
    const renamed = await dbtFileRenameHandler.rename(member, {
      ref: `/x/${pid}/file/models/orders.sql`,
      title: "fct_orders.sql",
    });
    expect(renamed.after.slug).toBe("models/fct_orders.sql");
    expect(await fileAt("models/mart.sql")).toContain("ref('fct_orders')");
    // A UI rename (clientId) already refused dirty buffers: no reload warning.
    const ui = await renameDbtFile(member, {
      from: "models/customers.sql",
      to: "models/dim_customers.sql",
      clientId: "tab-1",
    });
    expect(ui.warnings.join("\n")).not.toMatch(/Open editors/);

    const movedOut = await dbtFileRenameHandler.rename(member, {
      ref: "models/fct_orders.sql",
      slug: "models/marts/orders.sql",
      options: { updateRefs: false },
    });
    expect(movedOut.after.url).toBe(`/x/${pid}/file/models/marts/orders.sql`);
    expect(await fileAt("models/mart.sql")).toContain("ref('fct_orders')");

    await expect(
      dbtFileRenameHandler.rename(member, {
        ref: "models/marts/orders.sql",
        title: "other/orders.sql",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
