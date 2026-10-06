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

import { AppWorktree, DbtProject } from "../database/workspace-schema";
import { seedDbtGitTree } from "./test-support/git-tree";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  log as repoLog,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import {
  parseDbtFileRef,
  renameDbtFile,
  resolveDbtFile,
} from "../rename/dbt-file";
import { dbtFileRenameHandler } from "../rename/handlers/dbt-file";
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
  "    marts:",
  "      orders:",
  "        +materialized: table",
  "",
].join("\n");
const SELECTORS =
  "selectors:\n  - name: nightly\n    definition:\n      method: fqn\n      value: orders+\n";
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
    "models/schema.yml": "version: 2\nmodels:\n  - name: orders\n",
    "jobs/daily.yml": JOB,
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
    // dbt_project.yml model config key follows too.
    expect(await fileAt("dbt_project.yml")).toContain("      fct_orders:\n");
    expect(await fileAt("selectors.yml")).toBe(SELECTORS);
    expect(result.warnings.join("\n")).toMatch(
      /selectors.yml still mentions 'orders'/,
    );
    // The model's own schema.yml entry follows, so its tests stay attached.
    expect(await fileAt("models/schema.yml")).toContain("name: fct_orders\n");

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
