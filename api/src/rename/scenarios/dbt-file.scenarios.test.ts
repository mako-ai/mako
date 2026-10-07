/**
 * SCENARIOS — renaming dbt project files (kind `dbt_file`).
 *
 * A dbt file's identity is its path; a model's file name is also its node
 * name. Every scenario checks the same things after the rename, whatever
 * the entry point (the dbt route the explorer uses, POST /objects, the MCP
 * `rename_object` tool, a laptop `git mv` pushed through the git endpoint):
 *
 *   - exactly one commit, on the actor's branch, holding the move and every
 *     ref/selector/properties/unit-test/dbt_project rewrite;
 *   - no file the rename did not mean to change is touched — byte for
 *     byte, mode for mode (executables, symlinks, binaries, CRLF, BOM);
 *   - everything it READ is pinned: a save landing in between refuses the
 *     rename (409) instead of being overwritten or left naming the old model;
 *   - old paths keep resolving (git's own rename detection), and an old
 *     path someone else took, or that was deleted, answers honestly.
 *
 * Real bare repos (APPS_GIT_ROOT in a temp dir) + mongodb-memory-server.
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
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const realtime = vi.hoisted(() => ({ publishRealtimeEvent: vi.fn() }));
vi.mock("../../services/realtime.service", () => realtime);

// Race hooks: `afterRead` fires once inside the rename after it has read
// every file it decides on (its warnings scan) and before it commits.
const race = vi.hoisted(() => ({
  afterRead: null as null | (() => Promise<void>),
}));
vi.mock("../../apps/repository.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/repository.service")>();
  return {
    ...actual,
    grepTree: async (...args: Parameters<typeof actual.grepTree>) => {
      const hook = race.afterRead;
      race.afterRead = null;
      if (hook) await hook();
      return actual.grepTree(...args);
    },
  };
});

const auth = vi.hoisted(() => ({
  authType: "session" as string,
  user: { id: "u1" } as { id: string } | undefined,
  role: "member" as string | null,
}));
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", auth.authType);
    if (auth.user) c.set("user", auth.user);
    await next();
  },
  isSessionAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "session",
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => (auth.role ? { role: auth.role } : null)),
    isAdmin: vi.fn(async () => auth.role === "admin" || auth.role === "owner"),
  },
}));
// The dbt route module's heavy collaborators (as in dbt.routes.integration).
vi.mock("../../dbt/dbt-project.service", () => ({
  loadDbtDeferState: vi.fn(async () => undefined),
  runAdhocDbtCommand: vi.fn(async () => ({ success: true })),
}));
vi.mock("../../dbt/dbt-run.service", () => ({
  triggerDbtJobRun: vi.fn(),
  triggerDbtRunRetry: vi.fn(),
  requestDbtRunCancel: vi.fn(),
  applyJobScheduleChange: vi.fn(async () => undefined),
  recordCompletedAdhocDbtRun: vi.fn(),
  reconcileStaleQueuedRun: vi.fn(async (r: unknown) => r),
  reconcileStaleQueuedRuns: vi.fn(async (r: unknown) => r),
}));
vi.mock("../../services/dashboard-artifact-store.service", () => ({
  getDashboardArtifactStore: vi.fn(() => ({})),
}));
vi.mock("../../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));

import { AppWorktree, DbtProject } from "../../database/workspace-schema";
import { seedDbtGitTree } from "../../dbt/test-support/git-tree";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  listTree,
  log as repoLog,
  readBlobsBatch,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import { runGit } from "../../apps/git";
import { dbtRoutes } from "../../routes/dbt.routes";
import { objectRoutes } from "../../routes/objects";
import { createRenameTools } from "../../agent-lib/tools/rename-tools";
import { renameObject, resolveObjectRef } from "../registry";
import { renameDbtFile } from "../dbt-file";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const member = () => ({ workspaceId: WS, userId: "u1", role: "member" });

const app = new Hono();
app.route("/api/workspaces/:workspaceId/dbt", dbtRoutes);
app.route("/api/workspaces/:workspaceId/objects", objectRoutes);

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-file-scenarios-"));
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

let PID = "";

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  realtime.publishRealtimeEvent.mockClear();
  race.afterRead = null;
  auth.authType = "session";
  auth.user = { id: "u1" };
  auth.role = "member";
  await Promise.all([DbtProject.deleteMany({}), AppWorktree.deleteMany({})]);
});

// ── Fixtures ────────────────────────────────────────────────────────

const PROJECT_YML = [
  "name: analytics",
  "models:",
  "  analytics:",
  "    orders:",
  "      +materialized: table",
  "    staging:",
  "      +schema: stg",
  "",
].join("\n");

/** A model the size of a real one, so git can tell a moved+edited copy. */
const ORDERS_SQL = [
  "with source as (",
  "  select * from raw.orders",
  "),",
  "renamed as (",
  "  select id as order_id, customer_id, status, amount_cents / 100.0 as amount",
  "  from source",
  ")",
  "select * from renamed",
  "",
].join("\n");

async function seedProject(files: Record<string, string> = {}) {
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
      { name: "dev", connectionId: CONN, targetSchema: "dbt_dev", threads: 4 },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  PID = project._id.toString();
  await seedDbtGitTree(WS, {
    "dbt_project.yml": PROJECT_YML,
    "models/orders.sql": ORDERS_SQL,
    "models/customers.sql": "select 2 as id\n",
    "models/mart.sql": "select * from {{ ref('orders') }}\n",
    ...files,
  });
  return project;
}

async function fileAt(rel: string, ref = MAIN): Promise<string | null> {
  const buf = (await readBlobsBatch(repoDirFor(WS), ref, [`dbt/${rel}`])).get(
    `dbt/${rel}`,
  );
  return buf ? buf.toString("utf8") : null;
}

async function rawAt(rel: string, ref = MAIN): Promise<Buffer | null> {
  return (
    (await readBlobsBatch(repoDirFor(WS), ref, [`dbt/${rel}`])).get(
      `dbt/${rel}`,
    ) ?? null
  );
}

/** path → [mode, oid] for every dbt/ entry at a ref. */
async function treeAt(ref = MAIN): Promise<Record<string, [string, string]>> {
  const head = await resolveCommit(repoDirFor(WS), ref);
  return Object.fromEntries(
    (await listTree(repoDirFor(WS), head!))
      .filter(e => e.path.startsWith("dbt/"))
      .map(e => [e.path.slice(4), [e.mode, e.oid]]),
  );
}

async function commitsOn(ref = MAIN): Promise<number> {
  return (await repoLog(repoDirFor(WS), ref, 10_000)).length;
}

/** A laptop push: a commit straight onto main, as the git endpoint lands it. */
async function laptop(
  mutation: Parameters<typeof commitBlobsOnBranch>[2],
  message = "laptop push",
) {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    {
      ...mutation,
      writes: Object.fromEntries(
        Object.entries(mutation.writes ?? {}).map(([p, c]) => [`dbt/${p}`, c]),
      ),
      deletes: (mutation.deletes ?? []).map(p => `dbt/${p}`),
    },
    { message, author: { name: "Laptop", email: "laptop@example.com" } },
  );
}

/**
 * Exactly these paths changed between two trees (everything else is byte-
 * and mode-identical).
 */
function changedPaths(
  before: Record<string, [string, string]>,
  after: Record<string, [string, string]>,
): string[] {
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...all]
    .filter(p => JSON.stringify(before[p]) !== JSON.stringify(after[p]))
    .sort();
}

function req(method: string, url: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}${url}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
}

const mcpRename = (input: Record<string, unknown>, userId = "u1") =>
  (
    createRenameTools(WS, userId).rename_object.execute as (
      i: Record<string, unknown>,
      o: unknown,
    ) => Promise<{ success: boolean; error?: string; after?: { slug: string } }>
  )(input, { toolCallId: "t", messages: [] });

// ── Entry points ────────────────────────────────────────────────────

describe("every entry point: one commit, the same service, old paths resolve", () => {
  it("the explorer's dbt route, POST /objects, rename_object and a laptop git mv", async () => {
    await seedProject();
    let before = await treeAt();
    let commits = await commitsOn();

    // 1. The explorer: POST /dbt/projects/:id/files/rename.
    const route = await req("POST", `/dbt/projects/${PID}/files/rename`, {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
      clientId: "tab-1",
    });
    expect(route.status, await route.clone().text()).toBe(200);
    expect(await commitsOn()).toBe(commits + 1);
    const after = await treeAt();
    expect(changedPaths(before, after)).toEqual([
      "dbt_project.yml",
      "models/fct_orders.sql",
      "models/mart.sql",
      "models/orders.sql",
    ]);
    expect(after["models/fct_orders.sql"]).toEqual(before["models/orders.sql"]);
    // git sees ONE rename (history follows the file).
    const { stdout } = await runGit([
      "-C",
      repoDirFor(WS),
      "log",
      "-1",
      "-M",
      "--name-status",
      "--format=",
      MAIN,
    ]);
    expect(stdout).toMatch(
      /^R100\tdbt\/models\/orders\.sql\tdbt\/models\/fct_orders\.sql$/m,
    );

    // 2. POST /objects/dbt_file/rename (title = new file name).
    before = after;
    commits = await commitsOn();
    const objects = await req("POST", "/objects/dbt_file/rename", {
      ref: `/x/${PID}/file/models/fct_orders.sql`,
      title: "orders_v2.sql",
    });
    expect(objects.status, await objects.clone().text()).toBe(200);
    expect(await commitsOn()).toBe(commits + 1);

    // 3. rename_object (MCP / agent): a move to another folder.
    const tool = await mcpRename({
      kind: "dbt_file",
      ref: "models/orders_v2.sql",
      slug: "models/marts/orders_v2.sql",
    });
    expect(tool.success, tool.error).toBe(true);

    // 4. A laptop: git mv + edit in one commit.
    await laptop({
      writes: {
        "models/marts/orders_final.sql": `${ORDERS_SQL}-- edited on a laptop\n`,
      },
      deletes: ["models/marts/orders_v2.sql"],
    });

    // Every old path and URL resolves to where the file is now.
    for (const old of [
      "models/orders.sql",
      `/x/${PID}/file/models/fct_orders.sql`,
      `dbt/models/orders_v2.sql`,
      `${PID}/models/marts/orders_v2.sql`,
    ]) {
      expect(
        (await resolveObjectRef(member(), "dbt_file", old))?.current.slug,
        old,
      ).toBe("models/marts/orders_final.sql");
    }
    const resolved = await req(
      "GET",
      `/objects/resolve?${new URLSearchParams({ kind: "dbt_file", ref: "models/orders.sql" })}`,
    );
    expect(resolved.status).toBe(200);
  }, 60_000);
});

// ── The operations matrix ───────────────────────────────────────────

describe("operations", () => {
  it("title-only, slug-only, both (agreeing, or refused when they disagree), and no-ops in every spelling", async () => {
    await seedProject();
    const via = (input: Record<string, unknown>) =>
      renameObject(member(), "dbt_file", input as never);
    // title only: same folder
    expect(
      (await via({ ref: "models/customers.sql", title: "dim_customers.sql" }))
        .after.slug,
    ).toBe("models/dim_customers.sql");
    // slug only: another folder
    expect(
      (
        await via({
          ref: "models/dim_customers.sql",
          slug: "models/marts/dim_customers.sql",
        })
      ).after.slug,
    ).toBe("models/marts/dim_customers.sql");
    // both, agreeing
    expect(
      (
        await via({
          ref: "models/marts/dim_customers.sql",
          slug: "models/marts/customers.sql",
          title: "customers.sql",
        })
      ).after.slug,
    ).toBe("models/marts/customers.sql");
    // both, disagreeing: refused, nothing moves
    const commits = await commitsOn();
    await expect(
      via({
        ref: "models/marts/customers.sql",
        slug: "models/marts/a.sql",
        title: "b.sql",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await commitsOn()).toBe(commits);
    // no-ops: its own path in every spelling succeeds with nothing to do
    for (const same of [
      { slug: "models/marts/customers.sql" },
      { slug: "dbt/models/marts/customers.sql" },
      { slug: "/models/marts/customers.sql" },
      { slug: "  models/marts/customers.sql  " },
      { title: "customers.sql" },
    ]) {
      const r = await via({ ref: "models/marts/customers.sql", ...same });
      expect([JSON.stringify(same), r.warnings.join(" ")]).toEqual([
        JSON.stringify(same),
        expect.stringMatching(/Nothing to change/),
      ]);
    }
    expect(await commitsOn()).toBe(commits);
  });

  it("rename back, a→b→c quickly, onto a live name (409), onto another file's OLD path, onto case twins, own case change", async () => {
    await seedProject();
    await renameDbtFile(member(), {
      from: "models/orders.sql",
      to: "models/b.sql",
    });
    await renameDbtFile(member(), { from: "models/b.sql", to: "models/c.sql" });
    await renameDbtFile(member(), {
      from: "models/c.sql",
      to: "models/orders.sql",
    });
    expect(await fileAt("models/orders.sql")).toBe(ORDERS_SQL);
    expect(await fileAt("models/mart.sql")).toBe(
      "select * from {{ ref('orders') }}\n",
    );
    expect(await fileAt("dbt_project.yml")).toBe(PROJECT_YML);
    // (a) a live name: 409, nothing moved
    await expect(
      renameDbtFile(member(), {
        from: "models/orders.sql",
        to: "models/customers.sql",
      }),
    ).rejects.toMatchObject({ status: 409 });
    // (b) another file's OLD path: allowed — the old path now names the
    // newcomer (a live name beats an old one).
    await renameDbtFile(member(), {
      from: "models/customers.sql",
      to: "models/dim_customers.sql",
    });
    await renameDbtFile(member(), {
      from: "models/mart.sql",
      to: "models/customers_report.sql",
    });
    await renameDbtFile(member(), {
      from: "models/customers_report.sql",
      to: "models/customers.sql",
    });
    expect(
      (await resolveObjectRef(member(), "dbt_file", "models/customers.sql"))
        ?.via,
    ).toBe("current");
    expect(await fileAt("models/customers.sql")).toContain("ref('orders')");
    // (d) a case-only variant of another file: 409
    await expect(
      renameDbtFile(member(), {
        from: "models/orders.sql",
        to: "models/Customers.sql",
      }),
    ).rejects.toMatchObject({ status: 409 });
    // (e) its own name in another case: a plain git mv
    expect(
      (
        await renameDbtFile(member(), {
          from: "models/orders.sql",
          to: "models/Orders.sql",
        })
      ).after.slug,
    ).toBe("models/Orders.sql");
  });

  it("delete then recreate at the old path; a copy; a path taken again then deleted is a dead link, not a wrong one", async () => {
    await seedProject();
    await renameDbtFile(member(), {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });
    // A NEW models/orders.sql (a laptop push): the old path is its now.
    await laptop({ writes: { "models/orders.sql": "select 99 as id\n" } });
    expect(
      await resolveObjectRef(member(), "dbt_file", "models/orders.sql"),
    ).toMatchObject({ via: "current", current: { slug: "models/orders.sql" } });
    // …and once that newcomer is deleted, the old path is a dead link: it
    // never leads back to the file that gave the name up.
    await laptop({ deletes: ["models/orders.sql"] });
    expect(
      await resolveObjectRef(member(), "dbt_file", "models/orders.sql"),
    ).toBeNull();
    // A copy: both answer to their own paths; the copy inherits nothing.
    await laptop({ writes: { "models/fct_orders_copy.sql": ORDERS_SQL } });
    expect(
      (await resolveObjectRef(member(), "dbt_file", "models/fct_orders.sql"))
        ?.current.slug,
    ).toBe("models/fct_orders.sql");
    // Moving the original keeps the copy where it is.
    await renameDbtFile(member(), {
      from: "models/fct_orders.sql",
      to: "models/marts/fct_orders.sql",
      updateRefs: false,
    });
    expect(await fileAt("models/fct_orders_copy.sql")).toBe(ORDERS_SQL);
    expect(
      (await resolveObjectRef(member(), "dbt_file", "models/fct_orders.sql"))
        ?.current.slug,
    ).toBe("models/marts/fct_orders.sql");
  });
});

// ── Roles, branches, links ──────────────────────────────────────────

describe("roles, branches and links", () => {
  it("viewer is refused on every entry point; member/admin/owner rename; an API key with no user acts on main", async () => {
    await seedProject();
    for (const role of ["viewer"]) {
      auth.role = role;
      const r1 = await req("POST", `/dbt/projects/${PID}/files/rename`, {
        from: "models/orders.sql",
        to: "models/x.sql",
      });
      expect(r1.status).toBe(403);
      const r2 = await req("POST", "/objects/dbt_file/rename", {
        ref: "models/orders.sql",
        slug: "models/x.sql",
      });
      expect(r2.status).toBe(403);
      await expect(
        renameObject({ workspaceId: WS, userId: "u1", role }, "dbt_file", {
          ref: "models/orders.sql",
          slug: "models/x.sql",
        }),
      ).rejects.toMatchObject({ status: 403 });
      // …but may still RESOLVE (a viewer can read the project).
      expect(
        (
          await resolveObjectRef(
            { workspaceId: WS, userId: "u1", role },
            "dbt_file",
            "models/orders.sql",
          )
        )?.via,
      ).toBe("current");
    }
    let n = 0;
    for (const role of ["member", "admin", "owner"]) {
      auth.role = role;
      const from = n === 0 ? "models/orders.sql" : `models/o${n}.sql`;
      const res = await req("POST", `/dbt/projects/${PID}/files/rename`, {
        from,
        to: `models/o${++n}.sql`,
      });
      expect([role, res.status]).toEqual([role, 200]);
    }
    // A workspace API key with no user behind it: the "agent" actor,
    // whose branch is the default branch.
    const keyed = await renameObject({ workspaceId: WS }, "dbt_file", {
      ref: "models/o3.sql",
      slug: "models/o4.sql",
    });
    expect(keyed.warnings.join(" ")).not.toMatch(/Committed on your branch/);
    expect(await fileAt("models/o4.sql")).toBe(ORDERS_SQL);
  });

  it("a rename on a session branch is invisible on main and to teammates; old links resolve per branch", async () => {
    await seedProject();
    await AppWorktree.create({
      workspaceId: new Types.ObjectId(WS),
      userId: "u1",
      branch: "feature/u1",
    });
    const mainBefore = await treeAt();
    const r = await renameDbtFile(member(), {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });
    expect(r.warnings.join(" ")).toMatch(/branch 'feature\/u1'/);
    expect(await treeAt()).toEqual(mainBefore); // main untouched
    // u1 (on the branch) is redirected; u2 (on main) still has the file.
    expect(
      (await resolveObjectRef(member(), "dbt_file", "models/orders.sql"))
        ?.current.slug,
    ).toBe("models/fct_orders.sql");
    expect(
      (
        await resolveObjectRef(
          { workspaceId: WS, userId: "u2", role: "member" },
          "dbt_file",
          "models/orders.sql",
        )
      )?.via,
    ).toBe("current");
    // Only u1's windows are poked.
    for (const call of realtime.publishRealtimeEvent.mock.calls) {
      expect(call[1].forUserId).toBe("u1");
    }
  });

  it("a link into ANOTHER workspace's project never resolves, and cannot be renamed", async () => {
    await seedProject();
    const otherPid = PID;
    const ws1 = WS;
    WS = new Types.ObjectId().toString();
    await seedProject();
    const link = `/x/${otherPid}/file/models/orders.sql`;
    expect(await resolveObjectRef(member(), "dbt_file", link)).toBeNull();
    await expect(
      renameObject(member(), "dbt_file", { ref: link, title: "stolen.sql" }),
    ).rejects.toMatchObject({ status: 404 });
    WS = ws1;
    expect(await fileAt("models/orders.sql")).toBe(ORDERS_SQL);
  });
});

// ── Rewrites never corrupt content or modes ─────────────────────────

describe("ref / selector / properties / unit_tests / dbt_project rewrites", () => {
  const TRICKY_SQL = [
    "-- ref('orders') in a comment is rewritten; ref('orders_v2') is not",
    "select *",
    "from {{ref('orders')}} a",
    'join {{ ref( "orders" ) }} b using (id)',
    "join {{ ref('orders', v=2) }} c using (id)",
    "join {{ ref('orders', version=2) }} d using (id)",
    "join {{ ref('analytics', 'orders') }} e using (id)",
    "join {{ ref('other_pkg', 'orders') }} f using (id)",
    "join {{ source('raw', 'orders') }} g using (id)",
    "join {{ ref('orders_v2') }} h using (id)",
    "where note = 'orders'",
    "{# ref('orders') #}",
    "",
  ].join("\n");
  const SCHEMA_YML = [
    "version: 2",
    "models:",
    "  - name: orders # the model",
    "    columns:",
    "      - name: orders",
    "        tests:",
    "          - relationships:",
    "              to: ref('orders')",
    "              field: id",
    '  - name: "customers"',
    "sources:",
    "  - name: raw",
    "    tables:",
    "      - name: orders",
    "snapshots:",
    "  - name: orders",
    "unit_tests:",
    "  - name: t_orders",
    "    model: orders",
    "    given:",
    "      - input: ref('orders')",
    "        rows: []",
    "exposures:",
    "  - name: dash",
    "    depends_on:",
    "      - ref('orders')",
    "semantic_models:",
    "  - name: sm",
    "    model: ref('orders')",
    "",
  ].join("\n");

  it("rewrites exactly the references to the renamed node, keeps every other byte, mode and file", async () => {
    await seedProject({
      "models/tricky.sql": TRICKY_SQL,
      "models/schema.yml": SCHEMA_YML,
      "models/crlf.yml":
        "version: 2\r\nmodels:\r\n  - name: orders\r\n    description: crlf\r\n",
      "models/bom.sql": "﻿select * from {{ ref('orders') }}\n",
      "models/py_model.py":
        'def model(dbt, session):\n    return dbt.ref("orders")\n',
      "seeds/notes.csv": "id,text\n1,ref('orders')\n",
      "analyses/scratch.md": "See {{ ref('orders') }}.\n",
      "jobs/daily.yml":
        'name: Daily\nenvironment: dev\ncommands:\n  - dbt build --select orders+ --exclude tag:x\n  - "dbt test -s orders" # quoted\nenabled: true\n',
    });
    const repoDir = repoDirFor(WS);
    const hash = async (text: string | Buffer) =>
      (
        await runGit(["-C", repoDir, "hash-object", "-w", "--stdin"], {
          stdin: text,
        })
      ).stdout.trim();
    const binary = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x72, 0x65,
    ]);
    const latin1 = Buffer.from(
      "-- caf\xe9 ref('orders')\nselect 1\n",
      "latin1",
    );
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      {
        entries: [
          {
            path: "dbt/models/exe.sql",
            oid: await hash("select * from {{ ref('orders') }}\n"),
            mode: "100755",
          },
          {
            path: "dbt/models/link.sql",
            oid: await hash("orders.sql"),
            mode: "120000",
          },
          {
            path: "dbt/assets/logo.png",
            oid: await hash(binary),
            mode: "100644",
          },
          {
            path: "dbt/models/legacy.sql",
            oid: await hash(latin1),
            mode: "100644",
          },
        ],
      },
      { message: "modes and odd bytes" },
    );
    const before = await treeAt();

    const r = await renameDbtFile(member(), {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });

    const after = await treeAt();
    expect(changedPaths(before, after)).toEqual(
      [
        "dbt_project.yml",
        "jobs/daily.yml",
        "models/bom.sql",
        "models/crlf.yml",
        "models/exe.sql",
        "models/fct_orders.sql",
        "models/mart.sql",
        "models/orders.sql",
        "models/py_model.py",
        "models/schema.yml",
        "models/tricky.sql",
        "analyses/scratch.md",
      ].sort(),
    );
    expect(await fileAt("models/tricky.sql")).toBe(
      TRICKY_SQL.replace("-- ref('orders')", "-- ref('fct_orders')")
        .replace("{{ref('orders')}}", "{{ref('fct_orders')}}")
        .replace('ref( "orders" )', 'ref( "fct_orders" )')
        .replace("ref('orders', v=2)", "ref('fct_orders', v=2)")
        .replace("ref('orders', version=2)", "ref('fct_orders', version=2)")
        .replace("ref('analytics', 'orders')", "ref('analytics', 'fct_orders')")
        .replace("{# ref('orders') #}", "{# ref('fct_orders') #}"),
    );
    expect(await fileAt("models/schema.yml")).toBe(
      SCHEMA_YML.replace(
        "  - name: orders # the model",
        "  - name: fct_orders # the model",
      )
        .replace("to: ref('orders')", "to: ref('fct_orders')")
        .replace("    model: orders", "    model: fct_orders")
        .replace("- input: ref('orders')", "- input: ref('fct_orders')")
        .replace("      - ref('orders')", "      - ref('fct_orders')")
        .replace("model: ref('orders')", "model: ref('fct_orders')"),
    );
    expect(await fileAt("models/crlf.yml")).toBe(
      "version: 2\r\nmodels:\r\n  - name: fct_orders\r\n    description: crlf\r\n",
    );
    expect(await fileAt("models/bom.sql")).toBe(
      "﻿select * from {{ ref('fct_orders') }}\n",
    );
    expect(await fileAt("models/py_model.py")).toContain(
      'dbt.ref("fct_orders")',
    );
    expect(await fileAt("jobs/daily.yml")).toBe(
      'name: Daily\nenvironment: dev\ncommands:\n  - dbt build --select fct_orders+ --exclude tag:x\n  - "dbt test -s fct_orders" # quoted\nenabled: true\n',
    );
    // Modes: the rewritten executable stays 100755; the symlink, the
    // binary and the non-UTF-8 file are untouched (and the last is named).
    expect(after["models/exe.sql"][0]).toBe("100755");
    for (const p of [
      "models/link.sql",
      "assets/logo.png",
      "models/legacy.sql",
    ]) {
      expect(after[p]).toEqual(before[p]);
    }
    expect((await rawAt("assets/logo.png"))?.equals(binary)).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/models\/legacy.sql is not UTF-8/);
    // Data is data: a seed's CSV text is never rewritten.
    expect(await fileAt("seeds/notes.csv")).toBe("id,text\n1,ref('orders')\n");
  });

  it("CRLF job and dbt_project files are rewritten keeping CRLF; a seed rename leaves the CSV's bytes alone", async () => {
    await seedProject({
      "jobs/win.yml":
        "name: Win\r\nenvironment: dev\r\ncommands:\r\n  - dbt run --select orders+\r\nenabled: true\r\n",
      "seeds/countries.csv": "code,label\nCH,ref('countries')\n",
      "models/uses_seed.sql": "select * from {{ ref('countries') }}\n",
    });
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "dbt/dbt_project.yml": PROJECT_YML.replace(/\n/g, "\r\n"),
        },
      },
      { message: "windows checkout" },
    );
    await renameDbtFile(member(), {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });
    expect(await fileAt("jobs/win.yml")).toBe(
      "name: Win\r\nenvironment: dev\r\ncommands:\r\n  - dbt run --select fct_orders+\r\nenabled: true\r\n",
    );
    expect(await fileAt("dbt_project.yml")).toBe(
      PROJECT_YML.replace("    orders:\n", "    fct_orders:\n").replace(
        /\n/g,
        "\r\n",
      ),
    );
    await renameDbtFile(member(), {
      from: "seeds/countries.csv",
      to: "seeds/country_codes.csv",
    });
    expect(await fileAt("seeds/country_codes.csv")).toBe(
      "code,label\nCH,ref('countries')\n",
    );
    expect(await fileAt("models/uses_seed.sql")).toBe(
      "select * from {{ ref('country_codes') }}\n",
    );
  });

  it("moving a model to another folder says which dbt_project.yml configs stop applying", async () => {
    await seedProject({ "models/staging/stg_orders.sql": "select 1\n" });
    const moved = await renameDbtFile(member(), {
      from: "models/orders.sql",
      to: "models/marts/orders.sql",
    });
    expect(moved.warnings.join("\n")).toMatch(
      /dbt_project\.yml.*models\/orders\.sql/,
    );
    const stg = await renameDbtFile(member(), {
      from: "models/staging/stg_orders.sql",
      to: "models/stg_orders.sql",
    });
    expect(stg.warnings.join("\n")).toMatch(/dbt_project\.yml.*staging/);
    // A move within the same configured folder warns about nothing.
    await seedDbtGitTree(WS, { "models/staging/stg_a.sql": "select 1\n" });
    const same = await renameDbtFile(member(), {
      from: "models/staging/stg_a.sql",
      to: "models/staging/stg_b.sql",
    });
    expect(same.warnings.join("\n")).not.toMatch(/dbt_project\.yml/);
  });
});

// ── Everything read is pinned: races refuse, never corrupt ──────────

describe("concurrency: a rename and anything landing in between", () => {
  const save = (writes: Record<string, string>, deletes: string[] = []) =>
    laptop({ writes, deletes }, "a save from another window");

  it.each([
    [
      "a file it read as not mentioning the model gains ref('orders')",
      () =>
        save({ "models/customers.sql": "select * from {{ ref('orders') }}\n" }),
    ],
    [
      "a NEW file referencing the model is added",
      () => save({ "models/late.sql": "select * from {{ ref('orders') }}\n" }),
    ],
    [
      "a case twin of the target appears",
      () => save({ "models/Fct_orders.sql": "select 3\n" }),
    ],
    [
      "a seed taking the new node name appears",
      () => save({ "seeds/fct_orders.csv": "id\n1\n" }),
    ],
    [
      "the moved file is edited",
      () => save({ "models/orders.sql": `${ORDERS_SQL}-- hotfix\n` }),
    ],
    ["the moved file is deleted", () => save({}, ["models/orders.sql"])],
  ])(
    "%s: refused (409), the save kept, nothing half-moved",
    async (_label, land) => {
      await seedProject({ "models/customers.sql": "select 2 as id\n" });
      race.afterRead = land;
      const commits = await commitsOn();
      await expect(
        renameDbtFile(member(), {
          from: "models/orders.sql",
          to: "models/fct_orders.sql",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(race.afterRead).toBeNull(); // the race really ran
      expect(await commitsOn()).toBe(commits + 1); // only the save
      expect(await fileAt("models/fct_orders.sql")).toBeNull();
      expect(await fileAt("models/mart.sql")).toBe(
        "select * from {{ ref('orders') }}\n",
      );
    },
  );

  it("a save to a file OUTSIDE dbt/ does not refuse the rename", async () => {
    await seedProject();
    race.afterRead = () =>
      commitBlobsOnBranch(
        repoDirFor(WS),
        DEFAULT_BRANCH,
        { writes: { "consoles/x.sql": "select 1\n" } },
        { message: "a console save" },
      ).then(() => undefined);
    const r = await renameDbtFile(member(), {
      from: "models/orders.sql",
      to: "models/fct_orders.sql",
    });
    expect(r.after.slug).toBe("models/fct_orders.sql");
  });

  it("two renames of the same file at once: one lands, the other is refused", async () => {
    await seedProject();
    const outcomes = await Promise.allSettled([
      renameDbtFile(member(), {
        from: "models/orders.sql",
        to: "models/a.sql",
      }),
      renameDbtFile(member(), {
        from: "models/orders.sql",
        to: "models/b.sql",
      }),
    ]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    const tree = await treeAt();
    expect(["models/a.sql", "models/b.sql"].filter(p => tree[p])).toHaveLength(
      1,
    );
    expect(tree["models/orders.sql"]).toBeUndefined();
    const mart = await fileAt("models/mart.sql");
    expect(
      mart === "select * from {{ ref('a') }}\n" ||
        mart === "select * from {{ ref('b') }}\n",
    ).toBe(true);
  });

  it("a binary file is moved by oid — its bytes and mode never pass through text", async () => {
    await seedProject();
    const repoDir = repoDirFor(WS);
    const binary = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x00,
    ]);
    const oid = (
      await runGit(["-C", repoDir, "hash-object", "-w", "--stdin"], {
        stdin: binary,
      })
    ).stdout.trim();
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { entries: [{ path: "dbt/assets/logo.png", oid, mode: "100644" }] },
      { message: "an image" },
    );
    const r = await renameObject(member(), "dbt_file", {
      ref: "assets/logo.png",
      slug: "assets/brand/logo.png",
    });
    expect(r.after.slug).toBe("assets/brand/logo.png");
    expect((await treeAt())["assets/brand/logo.png"]).toEqual(["100644", oid]);
    expect((await rawAt("assets/brand/logo.png"))?.equals(binary)).toBe(true);
  });
});

// ── Hostile names ───────────────────────────────────────────────────

describe("hostile names: a clear 400 (or a safe normalization), never a 500, never outside dbt/", () => {
  it("refuses what a checkout cannot hold or tell apart; accepts the merely unusual", async () => {
    await seedProject({ "models/café.sql": "select 1\n" });
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    const refused = [
      "",
      " ",
      "./x.sql",
      "models/./x.sql",
      "../x.sql",
      "models/../../x.sql",
      "models//x.sql",
      "models\\x.sql",
      ".git/config",
      "models/.git/x.sql",
      "models/a\u0000b.sql",
      "models/a\nb.sql",
      "models/a\tb.sql",
      "models/a\u007fb.sql",
      "models/x​.sql",
      "models/‮x.sql",
      "models/a:b.sql",
      "models/a*b.sql",
      "models/a?.sql",
      'models/a"b.sql',
      "models/a<b.sql",
      "models/a>b.sql",
      "models/a|b.sql",
      "models/x.sql.",
      "models /x.sql",
      "models/ x.sql",
      "models/CON.sql",
      "models/aux.sql",
      "models/nul.sql",
      "models/com1.sql",
      "LPT9/x.sql",
      `models/${"a".repeat(252)}.sql`,
      `models/${"a".repeat(10_000)}.sql`,
    ];
    for (const slug of refused) {
      const outcome = await renameObject(member(), "dbt_file", {
        ref: "models/orders.sql",
        slug,
      }).then(
        r => `accepted ${r.after.slug}`,
        (e: { status?: number; name?: string }) =>
          e.name === "RenameError" ? e.status : `crash ${String(e)}`,
      );
      expect([JSON.stringify(slug).slice(0, 40), outcome]).toEqual([
        JSON.stringify(slug).slice(0, 40),
        400,
      ]);
    }
    // NFD of an existing NFC name: two files a Mac shows as one.
    await expect(
      renameObject(member(), "dbt_file", {
        ref: "models/orders.sql",
        slug: "models/café.sql",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);

    // The unusual but harmless: emoji, RTL letters, a 24-hex name, a
    // folder named like another kind's root, a leading slash (normalized).
    let from = "models/orders.sql";
    for (const [slug, landed] of [
      ["models/😀.sql", "models/😀.sql"],
      ["models/שלום.sql", "models/שלום.sql"],
      [
        "models/507f1f77bcf86cd799439011.sql",
        "models/507f1f77bcf86cd799439011.sql",
      ],
      ["apps/orders.sql", "apps/orders.sql"],
      ["/models/orders.sql", "models/orders.sql"],
    ] as const) {
      const r = await renameObject(member(), "dbt_file", {
        ref: from,
        slug,
        options: { updateRefs: false },
      });
      expect(r.after.slug).toBe(landed);
      from = landed;
    }
    // Nothing ever left dbt/.
    const head2 = await resolveCommit(repoDirFor(WS), MAIN);
    const outside = (await listTree(repoDirFor(WS), head2!))
      .map(e => e.path)
      .filter(p => !p.startsWith("dbt/") && p !== "README.md");
    expect(outside).toEqual([]);
  });

  it("the dbt route refuses the same names (400), never 500", async () => {
    await seedProject();
    for (const to of [
      "./x.sql",
      "models/a\u0000b.sql",
      "models/a:b.sql",
      "models/CON.sql",
    ]) {
      const res = await req("POST", `/dbt/projects/${PID}/files/rename`, {
        from: "models/orders.sql",
        to,
      });
      expect([JSON.stringify(to), res.status]).toEqual([
        JSON.stringify(to),
        400,
      ]);
    }
  });
});
