/**
 * SCENARIOS: renaming files of the dbt project (kind `dbt_file`).
 *
 * A dbt file's identity is its path; a model's file name is also its node
 * name. Whatever the entry point (the dbt route the explorer calls,
 * POST /objects, the `rename_object` tool, a laptop `git mv`), a rename is:
 *
 *   - exactly one commit on the caller's branch, holding the move and every
 *     ref, selector, properties, unit-test and dbt_project.yml rewrite;
 *   - nothing else touched, byte for byte and mode for mode;
 *   - refused (409) when anything in dbt/ changed after it was read;
 *   - followed by old paths, through git's own rename history.
 *
 * Real bare repos (APPS_GIT_ROOT in a temp dir) and mongodb-memory-server.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
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

// `afterRead` runs once inside a rename, after it has read every file it
// decides from (its last read is the warnings search) and before it commits.
const race = vi.hoisted(() => ({
  afterRead: null as null | (() => Promise<unknown>),
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

// `unquoted` swaps in the properties rewrite as it was before names were
// quoted, to prove the read-back check is what refuses its output.
const rewrite = vi.hoisted(() => ({ unquoted: false }));
vi.mock("../../dbt/dbt-ref-rewrite", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../dbt/dbt-ref-rewrite")>();
  return {
    ...actual,
    rewriteNodeProperties: (text: string, oldName: string, newName: string) =>
      rewrite.unquoted
        ? {
            text: text.replace(`- name: ${oldName}`, `- name: ${newName}`),
            count: 1,
          }
        : actual.rewriteNodeProperties(text, oldName, newName),
  };
});

const auth = vi.hoisted(() => ({ role: "admin" as string | null }));
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: "u1" });
    await next();
  },
  isSessionAuth: () => true,
  isMcpOAuthAuth: () => false,
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => (auth.role ? { role: auth.role } : null)),
  },
}));
// The dbt route module's heavy collaborators (as dbt.routes.integration).
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
vi.mock("../../services/artifact-store.service", () => ({
  getArtifactStore: vi.fn(() => ({})),
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
  writeBlobs,
  type IndexMode,
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
let PID = "";
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const as = (role: string | undefined, userId = "u1") => ({
  workspaceId: WS,
  userId,
  role,
});
const admin = () => as("admin");
/** Rename as an admin; `from`/`to` are project paths. */
const rename = (from: string, to: string, updateRefs?: boolean) =>
  renameDbtFile(admin(), { from, to, updateRefs });
const resolved = async (ref: string, ctx = admin()) =>
  (await resolveObjectRef(ctx, "dbt_file", ref))?.current.slug ?? null;

const app = new Hono();
app.route("/api/workspaces/:workspaceId/dbt", dbtRoutes);
app.route("/api/workspaces/:workspaceId/objects", objectRoutes);

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-file-scenarios-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  // No mirror to fetch from: the freshen before each write fails at once,
  // on this machine, instead of asking github.com for a repo of this name.
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${tmpRoot}/no-mirror`;
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
  WS = new Types.ObjectId().toString();
  realtime.publishRealtimeEvent.mockClear();
  race.afterRead = null;
  auth.role = "admin";
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

/** A model the size of a real one, so git pairs a moved and edited copy. */
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
const MART_SQL = "select * from {{ ref('orders') }}\n";

async function seedProject(files: Record<string, string> = {}) {
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name: "Analytics",
    environments: [
      {
        name: "dev",
        connectionId: new Types.ObjectId(),
        targetSchema: "dbt_dev",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
  });
  PID = project._id.toString();
  await seedDbtGitTree(WS, {
    "dbt_project.yml": PROJECT_YML,
    "models/orders.sql": ORDERS_SQL,
    "models/customers.sql": "select 2 as id\n",
    "models/mart.sql": MART_SQL,
    ...files,
  });
}

async function rawAt(rel: string, ref = MAIN): Promise<Buffer | null> {
  const blobs = await readBlobsBatch(repoDirFor(WS), ref, [`dbt/${rel}`]);
  return blobs.get(`dbt/${rel}`) ?? null;
}
const fileAt = async (rel: string, ref = MAIN) =>
  (await rawAt(rel, ref))?.toString("utf8") ?? null;

/** path → [mode, blob] for every dbt/ entry at a ref. */
async function treeAt(ref = MAIN): Promise<Record<string, [string, string]>> {
  const head = (await resolveCommit(repoDirFor(WS), ref)) ?? "";
  return Object.fromEntries(
    (await listTree(repoDirFor(WS), head))
      .filter(e => e.path.startsWith("dbt/"))
      .map(e => [e.path.slice(4), [e.mode, e.oid]]),
  );
}
const commitsOn = async (ref = MAIN) =>
  (await repoLog(repoDirFor(WS), ref, 10_000)).length;

/** A commit straight onto main, as a laptop push or another window's save lands. */
async function push(writes: Record<string, string>, deletes: string[] = []) {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    {
      writes: Object.fromEntries(
        Object.entries(writes).map(([p, c]) => [`dbt/${p}`, c]),
      ),
      deletes: deletes.map(p => `dbt/${p}`),
    },
    { message: "a push", author: { name: "L", email: "l@example.com" } },
  );
}

/** Files placed with a mode, by bytes: an executable, a symlink, a binary. */
async function place(
  files: Array<[string, string | Buffer, IndexMode]>,
  root = "dbt/",
) {
  const oids = await writeBlobs(
    repoDirFor(WS),
    files.map(([, content]) => content),
  );
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    {
      entries: files.map(([p, , mode], i) => ({
        path: `${root}${p}`,
        oid: oids[i],
        mode,
      })),
    },
    { message: "modes and odd bytes" },
  );
}

/** The paths whose mode or blob differ between two trees. */
function changedPaths(
  before: Record<string, [string, string]>,
  after: Record<string, [string, string]>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
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
const routeRename = (from: string, to: string, extra: object = {}) =>
  req("POST", `/dbt/projects/${PID}/files/rename`, { from, to, ...extra });

const toolRename = (input: Record<string, unknown>) =>
  (
    createRenameTools(WS, "u1").rename_object.execute as (
      i: Record<string, unknown>,
      o: unknown,
    ) => Promise<{ success: boolean; error?: string }>
  )({ kind: "dbt_file", ...input }, { toolCallId: "t", messages: [] });

// ── Entry points ────────────────────────────────────────────────────

describe("every entry point: one commit, the same service, old paths resolve", () => {
  it("the explorer's route, POST /objects, rename_object and a laptop git mv", async () => {
    await seedProject();
    const before = await treeAt();
    let commits = await commitsOn();

    // 1. The explorer: POST /dbt/projects/:id/files/rename.
    const route = await routeRename(
      "models/orders.sql",
      "models/fct_orders.sql",
      {
        clientId: "tab-1",
      },
    );
    expect(route.status, await route.clone().text()).toBe(200);
    expect(await commitsOn()).toBe(++commits);
    const after = await treeAt();
    expect(changedPaths(before, after)).toEqual([
      "dbt_project.yml",
      "models/fct_orders.sql",
      "models/mart.sql",
      "models/orders.sql",
    ]);
    // The same blob and mode at the new path: git records one rename.
    expect(after["models/fct_orders.sql"]).toEqual(before["models/orders.sql"]);
    expect(await fileAt("models/mart.sql")).toBe(
      "select * from {{ ref('fct_orders') }}\n",
    );
    // Open windows: the old tab follows the file; rewritten files reload,
    // in the window that asked too (it skips only its own two pokes).
    expect(
      realtime.publishRealtimeEvent.mock.calls.map(([, e]) => [
        e.path,
        e.renamedTo,
        e.clientId,
        e.forUserId,
      ]),
    ).toEqual([
      ["models/orders.sql", "models/fct_orders.sql", "tab-1", undefined],
      ["models/fct_orders.sql", undefined, "tab-1", undefined],
      ["dbt_project.yml", undefined, undefined, undefined],
      ["models/mart.sql", undefined, undefined, undefined],
    ]);

    // 2. POST /objects/dbt_file/rename (title = a new name in the folder).
    const objects = await req("POST", "/objects/dbt_file/rename", {
      ref: `/x/${PID}/file/models/fct_orders.sql`,
      title: "orders_v2.sql",
    });
    expect(objects.status, await objects.clone().text()).toBe(200);
    expect(await commitsOn()).toBe(++commits);

    // 3. rename_object (the agent, MCP): a move to another folder.
    const tool = await toolRename({
      ref: "models/orders_v2.sql",
      slug: "models/marts/orders_v2.sql",
    });
    expect(tool.success, tool.error).toBe(true);
    expect(await commitsOn()).toBe(commits + 1);

    // 4. A laptop: git mv and an edit in one commit.
    await push(
      {
        "models/marts/orders_final.sql": `${ORDERS_SQL}-- edited on a laptop\n`,
      },
      ["models/marts/orders_v2.sql"],
    );

    // Every old path and link leads to where the file is now.
    for (const old of [
      "models/orders.sql",
      `/x/${PID}/file/models/fct_orders.sql`,
      "dbt/models/orders_v2.sql",
      `${PID}/models/marts/orders_v2.sql`,
    ]) {
      expect([old, await resolved(old)]).toEqual([
        old,
        "models/marts/orders_final.sql",
      ]);
    }
    const viaRoute = await req(
      "GET",
      `/objects/resolve?${new URLSearchParams({ kind: "dbt_file", ref: "models/orders.sql" })}`,
    );
    expect(await viaRoute.json()).toMatchObject({
      resolved: {
        via: "alias",
        current: { url: `/x/${PID}/file/models/marts/orders_final.sql` },
      },
    });
    // An old path can be renamed through, too.
    const through = await renameObject(admin(), "dbt_file", {
      ref: "models/orders.sql",
      title: "orders.sql",
    });
    expect(through.after.slug).toBe("models/marts/orders.sql");
  }, 60_000);

  it("title, slug, both; a contradicting title is a 400; its own path is a no-op in every spelling", async () => {
    await seedProject();
    const via = (input: { ref: string; title?: string; slug?: string }) =>
      renameObject(admin(), "dbt_file", input);
    expect(
      (await via({ ref: "models/customers.sql", title: "dim.sql" })).after.slug,
    ).toBe("models/dim.sql");
    expect(
      (await via({ ref: "models/dim.sql", slug: "/dbt/models/marts/dim.sql" }))
        .after.slug,
    ).toBe("models/marts/dim.sql");
    const both = await via({
      ref: "models/marts/dim.sql",
      slug: "models/marts/customers.sql",
      title: "customers.sql",
    });
    expect(both.after.slug).toBe("models/marts/customers.sql");

    const commits = await commitsOn();
    for (const bad of [
      { slug: "models/marts/a.sql", title: "b.sql" },
      { title: "staging/customers.sql" },
    ]) {
      await expect(
        via({ ref: "models/marts/customers.sql", ...bad }),
      ).rejects.toMatchObject({ status: 400 });
    }
    for (const same of [
      { slug: "models/marts/customers.sql" },
      { slug: "dbt/models/marts/customers.sql" },
      { slug: "/models/marts/customers.sql" },
      { slug: "  models/marts/./customers.sql  " },
      { slug: "models/marts/x/../customers.sql" },
      { title: "customers.sql" },
    ]) {
      const r = await via({ ref: "models/marts/customers.sql", ...same });
      expect([same, r.warnings]).toEqual([
        same,
        ["Nothing to change: it already has that name."],
      ]);
    }
    const route = await routeRename("models/mart.sql", "/dbt/models/mart.sql");
    expect(route.status).toBe(200);
    expect(await commitsOn()).toBe(commits);
  });

  it("back and forth, onto another file's old path, delete and recreate, a copy", async () => {
    await seedProject();
    await rename("models/orders.sql", "models/b.sql");
    await rename("models/b.sql", "models/c.sql");
    await rename("models/c.sql", "models/orders.sql");
    expect(await fileAt("models/orders.sql")).toBe(ORDERS_SQL);
    expect(await fileAt("models/mart.sql")).toBe(MART_SQL);
    expect(await fileAt("dbt_project.yml")).toBe(PROJECT_YML);

    // Another file's OLD path may be taken: the path then names the newcomer.
    await rename("models/customers.sql", "models/dim_customers.sql");
    await rename("models/mart.sql", "models/customers.sql");
    expect(
      await resolveObjectRef(admin(), "dbt_file", "models/customers.sql"),
    ).toMatchObject({ via: "current" });
    expect(await fileAt("models/customers.sql")).toBe(MART_SQL);

    // A new file at an old path owns it; once it is deleted the old path is
    // a dead link, never a way back to the file that gave the name up.
    await rename("models/orders.sql", "models/fct_orders.sql");
    await push({ "models/orders.sql": "select 99 as id\n" });
    expect(await resolved("models/orders.sql")).toBe("models/orders.sql");
    await push({}, ["models/orders.sql"]);
    expect(await resolved("models/orders.sql")).toBeNull();
    // A copy answers to its own path only, and stays when the original moves.
    await push({ "models/fct_orders_copy.sql": ORDERS_SQL });
    await rename("models/fct_orders.sql", "models/marts/fct_orders.sql", false);
    expect(await fileAt("models/fct_orders_copy.sql")).toBe(ORDERS_SQL);
    expect(await resolved("models/fct_orders.sql")).toBe(
      "models/marts/fct_orders.sql",
    );
  });
});

// ── Who, which branch, which workspace ──────────────────────────────

describe("roles, branches and other workspaces", () => {
  it("changing a dbt file is admin: a viewer and a member are refused everywhere and may still resolve", async () => {
    await seedProject();
    const commits = await commitsOn();
    for (const role of ["viewer", "member"]) {
      auth.role = role;
      const route = await routeRename("models/orders.sql", "models/x.sql");
      const objects = await req("POST", "/objects/dbt_file/rename", {
        ref: "models/orders.sql",
        slug: "models/x.sql",
      });
      const tool = await toolRename({
        ref: "models/orders.sql",
        slug: "models/x.sql",
      });
      expect([role, route.status, objects.status, tool.success]).toEqual([
        role,
        403,
        403,
        false,
      ]);
      expect(tool.error).toMatch(/admin or owner|read-only/);
      expect(await resolved("models/orders.sql", as(role))).toBe(
        "models/orders.sql",
      );
    }
    // No role at all (a credential with no person behind it): refused.
    await expect(
      renameObject({ workspaceId: WS }, "dbt_file", {
        ref: "models/orders.sql",
        slug: "models/x.sql",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await commitsOn()).toBe(commits);

    let from = "models/orders.sql";
    for (const role of ["admin", "owner"]) {
      auth.role = role;
      const to = `models/by_${role}.sql`;
      expect([role, (await routeRename(from, to)).status]).toEqual([role, 200]);
      from = to;
    }
  });

  it("lands on the caller's session branch: main and teammates are untouched, and it says so", async () => {
    await seedProject();
    await AppWorktree.create({
      workspaceId: new Types.ObjectId(WS),
      userId: "u1",
      branch: "feature/u1",
    });
    const mainBefore = await treeAt();
    const r = await rename("models/orders.sql", "models/fct_orders.sql");
    expect(r.warnings.join(" ")).toMatch(/your branch 'feature\/u1'/);
    expect(await treeAt()).toEqual(mainBefore);
    expect(await fileAt("models/mart.sql", "refs/heads/feature/u1")).toBe(
      "select * from {{ ref('fct_orders') }}\n",
    );
    // u1, on the branch, is redirected; u2, on main, still has the file.
    expect(await resolved("models/orders.sql")).toBe("models/fct_orders.sql");
    expect(await resolved("models/orders.sql", as("admin", "u2"))).toBe(
      "models/orders.sql",
    );
    // Only u1's windows are poked.
    for (const [, event] of realtime.publishRealtimeEvent.mock.calls) {
      expect(event.forUserId).toBe("u1");
    }
  });

  it("a link into another workspace's project never resolves and cannot be renamed", async () => {
    await seedProject();
    const [otherWs, link] = [WS, `/x/${PID}/file/models/orders.sql`];
    WS = new Types.ObjectId().toString();
    await seedProject();
    expect(await resolved(link)).toBeNull();
    await expect(
      renameObject(admin(), "dbt_file", { ref: link, title: "stolen.sql" }),
    ).rejects.toMatchObject({ status: 404 });
    WS = otherWs;
    expect(await fileAt("models/orders.sql")).toBe(ORDERS_SQL);
  });
});

// ── What a model rename rewrites, and what it leaves ────────────────

describe("a model rename rewrites what names it, and only that", () => {
  const TRICKY_SQL = [
    "-- ref('orders') in a comment is rewritten; ref('orders_v2') is not",
    "select *",
    "from {{ref('orders')}} a",
    'join {{ ref( "orders" ) }} b using (id)',
    "join {{ ref('orders', v=2) }} c using (id)",
    "join {{ ref('analytics', 'orders') }} e using (id)",
    "join {{ ref('other_pkg', 'orders') }} f using (id)",
    "join {{ source('raw', 'orders') }} g using (id)",
    "join {{ ref('orders_v2') }} h using (id)",
    "where note = 'orders'",
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
    "exposures:",
    "  - name: dash",
    "    depends_on:",
    "      - ref('orders')",
    "",
  ].join("\n");
  const JOB_YML =
    'name: Daily\nenvironment: dev\ncommands:\n  - dbt build --select stg_a orders+ +orders --exclude tag:x\n  - "dbt test -s orders" # quoted\n  - dbt run --select marts.orders\nenabled: true\n';

  it("refs, YAML strings, selectors, the properties entry, unit tests and the dbt_project.yml key, in one commit", async () => {
    await seedProject({
      "models/tricky.sql": TRICKY_SQL,
      "models/schema.yml": SCHEMA_YML,
      "models/crlf.yml": "version: 2\r\nmodels:\r\n  - name: orders\r\n",
      "models/bom.sql": "﻿select * from {{ ref('orders') }}\n",
      "models/py_model.py":
        'def model(dbt, s):\n    return dbt.ref("orders")\n',
      "seeds/notes.csv": "id,text\n1,ref('orders')\n",
      "analyses/scratch.md": "See {{ ref('orders') }}.\n",
      "jobs/daily.yml": JOB_YML,
      "jobs/win.yml":
        "name: Win\r\ncommands:\r\n  - dbt run --select orders+\r\n",
      "selectors.yml":
        "selectors:\n  - name: nightly\n    definition: orders+\n",
    });
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x72]);
    const latin1 = Buffer.from(
      "-- caf\xe9 ref('orders')\nselect 1\n",
      "latin1",
    );
    await place([
      ["models/exe.sql", MART_SQL, "100755"],
      ["models/link.sql", "orders.sql", "120000"],
      ["assets/logo.png", binary, "100644"],
      ["models/legacy.sql", latin1, "100644"],
    ]);
    // Shared consoles and app bindings that query the relation by name.
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "consoles/revenue.sql": "select * from analytics.orders\n",
          "apps/sales/bindings/top.sql": "select * from orders limit 5\n",
          "apps/sales/bindings/other.sql": "select * from orders_archive\n",
        },
      },
      { message: "consoles and apps" },
    );
    const before = await treeAt();
    const commits = await commitsOn();

    const r = await rename("models/orders.sql", "models/fct_orders.sql");

    expect(await commitsOn()).toBe(commits + 1);
    const after = await treeAt();
    expect(changedPaths(before, after)).toEqual(
      [
        "analyses/scratch.md",
        "dbt_project.yml",
        "jobs/daily.yml",
        "jobs/win.yml",
        "models/bom.sql",
        "models/crlf.yml",
        "models/exe.sql",
        "models/fct_orders.sql",
        "models/mart.sql",
        "models/orders.sql",
        "models/py_model.py",
        "models/schema.yml",
        "models/tricky.sql",
      ].sort(),
    );
    const named = (text: string, lines: string[]) =>
      lines.reduce(
        (out, line) => out.replace(line, line.replace("orders", "fct_orders")),
        text,
      );
    expect(await fileAt("models/tricky.sql")).toBe(
      named(TRICKY_SQL, [
        "-- ref('orders')",
        "{{ref('orders')}}",
        'ref( "orders" )',
        "ref('orders', v=2)",
        "'analytics', 'orders')",
      ]),
    );
    expect(await fileAt("models/schema.yml")).toBe(
      named(SCHEMA_YML, [
        "  - name: orders # the model",
        "to: ref('orders')",
        "    model: orders",
        "- input: ref('orders')",
        "      - ref('orders')",
      ]),
    );
    expect(await fileAt("dbt_project.yml")).toBe(
      PROJECT_YML.replace("    orders:\n", "    fct_orders:\n"),
    );
    expect(await fileAt("models/crlf.yml")).toBe(
      "version: 2\r\nmodels:\r\n  - name: fct_orders\r\n",
    );
    expect(await fileAt("models/bom.sql")).toBe(
      "﻿select * from {{ ref('fct_orders') }}\n",
    );
    expect(await fileAt("models/py_model.py")).toContain('ref("fct_orders")');
    // Several selectors after one --select; a CRLF file keeps its endings.
    expect(await fileAt("jobs/daily.yml")).toBe(
      JOB_YML.replace("orders+ +orders", "fct_orders+ +fct_orders").replace(
        "-s orders",
        "-s fct_orders",
      ),
    );
    expect(await fileAt("jobs/win.yml")).toBe(
      "name: Win\r\ncommands:\r\n  - dbt run --select fct_orders+\r\n",
    );
    // Modes: the rewritten executable stays one. The symlink, the binary,
    // the non-UTF-8 file and the seed's DATA are not touched.
    expect(after["models/exe.sql"][0]).toBe("100755");
    expect((await rawAt("assets/logo.png"))?.equals(binary)).toBe(true);
    expect((await rawAt("models/legacy.sql"))?.equals(latin1)).toBe(true);
    expect(await fileAt("seeds/notes.csv")).toBe("id,text\n1,ref('orders')\n");

    // What it could not fix is said, not hidden.
    const said = r.warnings.join("\n");
    expect(said).toContain(
      "The warehouse relation for 'orders' still exists until it is dropped.",
    );
    expect(said).toContain("selectors.yml still names 'orders'.");
    expect(said).toContain(
      "1 console still mentions the old relation name: consoles/revenue.sql",
    );
    expect(said).toContain(
      "1 app binding still mentions the old relation name: apps/sales/bindings/top.sql",
    );
    expect(said).toContain("models/legacy.sql is not UTF-8 text");
    expect(said).toContain(
      "the selector \"marts.orders\" still names 'orders'",
    );
    expect(said).toMatch(/still mention 'orders' as a whole word.*tricky\.sql/);
    expect(said).not.toMatch(/your branch/);
  });

  it("a seed rename rewrites refs and never the CSV; updateRefs off moves the file only and says what is left", async () => {
    await seedProject({
      "seeds/countries.csv": "code,label\nCH,ref('countries')\n",
      "models/uses_seed.sql": "select * from {{ ref('countries') }}\n",
    });
    await rename("seeds/countries.csv", "seeds/country_codes.csv");
    expect(await fileAt("seeds/country_codes.csv")).toBe(
      "code,label\nCH,ref('countries')\n",
    );
    expect(await fileAt("models/uses_seed.sql")).toBe(
      "select * from {{ ref('country_codes') }}\n",
    );

    const before = await treeAt();
    const off = await rename("models/orders.sql", "models/fct.sql", false);
    expect(changedPaths(before, await treeAt())).toEqual([
      "models/fct.sql",
      "models/orders.sql",
    ]);
    expect(off.warnings.join("\n")).toMatch(/were NOT rewritten/);
    // A file that is no model is only moved: no rewrite, nothing to warn of.
    const plain = await rename("dbt_project.yml", "old_project.yml");
    expect(plain.warnings).toEqual([]);
    // A snapshot is named by its block: the model `fct` is not touched.
    await push({
      "snapshots/mart.sql": "{% snapshot s %}x{% endsnapshot %}\n",
    });
    const snap = await rename("snapshots/mart.sql", "snapshots/renamed.sql");
    expect(snap.warnings).toEqual([]);
    expect(await fileAt("models/mart.sql")).toBe(MART_SQL);
  });

  it("moving a model to another folder says which dbt_project.yml config stops applying", async () => {
    await seedProject({
      "models/staging/stg_orders.sql": "select 1\n",
      "models/staging/stg_a.sql": "select 1\n",
    });
    const up = await rename(
      "models/staging/stg_orders.sql",
      "models/stg_orders.sql",
    );
    // One plain sentence (what to do), then the exact key as detail.
    expect(
      up.warnings.find(w => w.startsWith("dbt_project.yml"))?.split("\n"),
    ).toEqual([
      "dbt_project.yml config for models/staging (materialization, schema, tags…) no longer applies at its new place, models/stg_orders.sql. Move that config or check the model.",
      "Detail: models.analytics.staging applied to models/staging/stg_orders.sql; it is now models/stg_orders.sql.",
    ]);
    const down = await rename("models/orders.sql", "models/marts/orders.sql");
    expect(down.warnings.join("\n")).toContain(
      "Detail: models.analytics.orders applied to models/orders.sql; it is now models/marts/orders.sql.",
    );
    // A rename inside the configured folder loses nothing.
    const same = await rename(
      "models/staging/stg_a.sql",
      "models/staging/stg_b.sql",
    );
    expect(same.warnings.join("\n")).not.toMatch(/dbt_project\.yml/);
  });
});

// ── Names YAML would not read as text ───────────────────────────────

describe("a new name YAML would read as a boolean, a number, a date or null", () => {
  const NAMES = [
    "true",
    "false",
    "null",
    "yes",
    "no",
    "on",
    "off",
    "~",
    "123",
    "1e3",
    "0x1F",
    "2026-10-06",
    ".5",
  ];
  /** What each rename wrote, for the second parser below. */
  const emitted: Array<Record<"name" | "schema" | "project" | "job", string>> =
    [];

  it.each(NAMES)(
    "renamed to %s.sql: the entry, the unit test, the dbt_project.yml key and the selectors read back as that string",
    async name => {
      await seedProject({
        "models/schema.yml":
          "version: 2\nmodels:\n  - name: orders\n    description: d\nunit_tests:\n  - name: t\n    model: orders\n    given: []\n",
        "jobs/daily.yml":
          "name: Daily\nenvironment: dev\ncommands:\n  - dbt run --select orders+\nenabled: true\n",
      });
      await rename("models/orders.sql", `models/${name}.sql`);
      const [schema, project, job] = await Promise.all(
        ["models/schema.yml", "dbt_project.yml", "jobs/daily.yml"].map(
          async file => (await fileAt(file)) ?? "",
        ),
      );
      emitted.push({ name, schema, project, job });
      const doc = yaml.load(schema) as {
        models: Array<{ name: unknown }>;
        unit_tests: Array<{ model: unknown }>;
      };
      expect(doc.models[0].name).toBe(name);
      expect(doc.unit_tests[0].model).toBe(name);
      // A key is a string to js-yaml either way: it must be WRITTEN quoted.
      expect(project).toMatch(/\n {4}(['"]).+\1:\n {6}\+materialized: table\n/);
      const keys = yaml.load(project) as { models: { analytics: object } };
      expect(Object.keys(keys.models.analytics)).toEqual([name, "staging"]);
      expect((yaml.load(job) as { commands: unknown[] }).commands).toEqual([
        `dbt run --select ${name}+`,
      ]);
      expect(await fileAt("models/mart.sql")).toBe(
        `select * from {{ ref('${name}') }}\n`,
      );
    },
  );

  const hasPyYaml = (() => {
    try {
      execFileSync("python3", ["-I", "-c", "import yaml"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  // PyYAML is what dbt parses with (YAML 1.1: yes/no/on/off are booleans).
  it.skipIf(!hasPyYaml)(
    "PyYAML reads the same files back as strings too",
    async () => {
      expect(emitted.map(e => e.name)).toEqual(NAMES);
      const file = path.join(tmpRoot, "emitted.json");
      await fs.writeFile(file, JSON.stringify(emitted));
      const script = [
        "import json, sys, yaml",
        "for e in json.load(open(sys.argv[1])):",
        "    n = e['name']",
        "    s = yaml.safe_load(e['schema'])",
        "    assert s['models'][0]['name'] == n, (n, s['models'][0]['name'])",
        "    assert s['unit_tests'][0]['model'] == n, (n, s['unit_tests'])",
        "    keys = list(yaml.safe_load(e['project'])['models']['analytics'])",
        "    assert keys == [n, 'staging'], (n, keys)",
        "    cmds = yaml.safe_load(e['job'])['commands']",
        "    assert cmds == ['dbt run --select ' + n + '+'], (n, cmds)",
        "print('ok', len(json.load(open(sys.argv[1]))))",
      ].join("\n");
      const out = execFileSync("python3", ["-I", "-c", script, file], {
        encoding: "utf8",
      });
      expect(out.trim()).toBe(`ok ${NAMES.length}`);
    },
  );

  it("a rewrite that would not read back as text is refused (409) and nothing is committed", async () => {
    await seedProject({
      "models/schema.yml": "version: 2\nmodels:\n  - name: orders\n",
    });
    const before = await treeAt();
    rewrite.unquoted = true;
    try {
      await expect(
        rename("models/orders.sql", "models/true.sql"),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("YAML does not read as plain text"),
      });
    } finally {
      rewrite.unquoted = false;
    }
    expect(await treeAt()).toEqual(before);
  });
});

// ── Everything read is pinned ───────────────────────────────────────

describe("concurrency: whatever lands in dbt/ during a rename refuses it", () => {
  it.each<[string, () => Promise<unknown>]>([
    [
      "a file read as not mentioning the model gains ref('orders')",
      () => push({ "models/customers.sql": MART_SQL }),
    ],
    [
      "a new file referencing the model is added",
      () => push({ "models/late.sql": MART_SQL }),
    ],
    [
      "a case twin of the target appears",
      () => push({ "models/Fct_orders.sql": "select 3\n" }),
    ],
    [
      "a seed taking the new model name appears",
      () => push({ "seeds/fct_orders.csv": "id\n1\n" }),
    ],
    [
      "the moved file is edited",
      () => push({ "models/orders.sql": `${ORDERS_SQL}-- hotfix\n` }),
    ],
    ["the moved file is deleted", () => push({}, ["models/orders.sql"])],
  ])("%s: 409, the save kept, nothing half-moved", async (_label, land) => {
    await seedProject();
    race.afterRead = land;
    const commits = await commitsOn();
    await expect(
      rename("models/orders.sql", "models/fct_orders.sql"),
    ).rejects.toMatchObject({ status: 409 });
    expect(race.afterRead).toBeNull(); // the race really ran
    expect(await commitsOn()).toBe(commits + 1); // the save, and only it
    expect(await fileAt("models/fct_orders.sql")).toBeNull();
    expect(await fileAt("models/mart.sql")).toBe(MART_SQL);
  });

  it("a save outside dbt/ does not; of two renames at once exactly one lands", async () => {
    await seedProject();
    race.afterRead = () =>
      commitBlobsOnBranch(
        repoDirFor(WS),
        DEFAULT_BRANCH,
        { writes: { "consoles/x.sql": "select 1\n" } },
        { message: "a console save" },
      );
    const r = await rename("models/orders.sql", "models/fct_orders.sql");
    expect(r.after.slug).toBe("models/fct_orders.sql");

    const outcomes = await Promise.allSettled([
      rename("models/fct_orders.sql", "models/a.sql"),
      rename("models/fct_orders.sql", "models/b.sql"),
    ]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    const tree = await treeAt();
    const landed = ["a", "b"].filter(n => tree[`models/${n}.sql`]);
    expect(landed).toHaveLength(1);
    expect(tree["models/fct_orders.sql"]).toBeUndefined();
    expect(await fileAt("models/mart.sql")).toBe(
      `select * from {{ ref('${landed[0]}') }}\n`,
    );
  });
});

// ── Bytes, modes, and what may not be overwritten ───────────────────

describe("modes and bytes travel with the move; nothing existing is overwritten", () => {
  it("an executable, a symlink, a binary and a non-UTF-8 file keep their mode and bytes", async () => {
    await seedProject();
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    const latin1 = Buffer.from("-- caf\xe9\nselect 1\n", "latin1");
    const selfRef = Buffer.from("-- \xe9 {{ ref('odd') }}\n", "latin1");
    await place([
      ["models/run.sql", "select 1\n", "100755"],
      ["models/link.sql", "orders.sql", "120000"],
      ["assets/logo.png", binary, "100644"],
      ["models/legacy.sql", latin1, "100644"],
      ["models/odd.sql", selfRef, "100644"],
    ]);
    // A same-named file under another 3-letter folder lends the move nothing.
    await place([["models/run.sql", "elsewhere\n", "120000"]], "src/");
    const before = await treeAt();
    for (const [from, to] of [
      ["models/run.sql", "models/run_all.sql"],
      ["models/link.sql", "models/alias.sql"],
      ["assets/logo.png", "assets/brand/logo.png"],
      ["models/legacy.sql", "models/old_style.sql"],
    ]) {
      await rename(from, to);
      expect([to, (await treeAt())[to]]).toEqual([to, before[from]]);
    }
    expect((await rawAt("assets/brand/logo.png"))?.equals(binary)).toBe(true);
    expect((await rawAt("models/old_style.sql"))?.equals(latin1)).toBe(true);

    // A non-UTF-8 file that would itself need rewriting is refused…
    await expect(
      rename("models/odd.sql", "models/even.sql"),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("is not UTF-8 text"),
    });
    expect((await rawAt("models/odd.sql"))?.equals(selfRef)).toBe(true);
    // …and moves untouched when references are left alone.
    await rename("models/odd.sql", "models/even.sql", false);
    expect((await rawAt("models/even.sql"))?.equals(selfRef)).toBe(true);
  });

  it("refuses a taken path, a taken model name anywhere in the project, a file as a folder, and a case twin", async () => {
    await seedProject({
      "models/marts/revenue.sql": "select 1\n",
      "seeds/countries.csv": "code\nCH\n",
      "snapshots/snap.sql":
        "{% snapshot orders_snapshot %}select 1{% endsnapshot %}\n",
    });
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    for (const [from, to, said] of [
      [
        "models/orders.sql",
        "models/customers.sql",
        "A file already exists there.",
      ],
      ["models/orders.sql", "models/marts", "A folder already exists there."],
      [
        "models/orders.sql",
        "models/customers.sql/orders.sql",
        "models/customers.sql is a file, not a folder.",
      ],
      // A model's name is taken wherever in the project its file is.
      ["models/orders.sql", "models/staging/revenue.sql", "named 'revenue'"],
      ["models/orders.sql", "models/countries.sql", "named 'countries'"],
      ["models/orders.sql", "models/orders_snapshot.sql", "snapshots/snap.sql"],
      ["dbt_project.yml", "models/customers.py", "named 'customers'"],
      ["models/orders.sql", "models/Customers.sql", "upper/lower case"],
      ["models/orders.sql", "Models/orders.sql", "upper/lower case"],
      ["models/missing.sql", "models/x.sql", "File not found"],
    ]) {
      const error = await rename(from, to).catch((e: Error) => e);
      expect([to, error]).toEqual([
        to,
        expect.objectContaining({
          status: said === "File not found" ? 404 : 409,
          message: expect.stringContaining(said),
        }),
      ]);
    }
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
    // Its own name in another case is a plain move.
    const own = await rename("models/orders.sql", "models/Orders.sql");
    expect(own.after.slug).toBe("models/Orders.sql");
  });
});

// ── Paths ───────────────────────────────────────────────────────────

describe("paths: a plain refusal or a safe path, never outside the project", () => {
  it("refuses what a checkout cannot hold or tell apart, in plain words", async () => {
    await seedProject({ "models/café.sql": "select 1\n" });
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    const refused: Array<[string, string]> = [
      [" ", "Give a new title"],
      ["../x.sql", "The path must stay inside the dbt project."],
      ["models/../../x.sql", "The path must stay inside the dbt project."],
      ["/dbt/../x.sql", "The path must stay inside the dbt project."],
      ["models\\x.sql", "Use / to separate folders, not \\."],
      ["models/", "End the path with a file name, not a folder."],
      [".git/config", "The path can't go inside .git."],
      ["models/.git/x.sql", "The path can't go inside .git."],
      ["models/a\u0000b.sql", "control characters"],
      ["models/a\nb.sql", "control characters"],
      ["models/a\u007fb.sql", "control characters"],
      ["models/x​.sql", "invisible or text-direction character"],
      ["models/‮x.sql", "invisible or text-direction character"],
      ["models/a:b.sql", "not allowed in a file name"],
      ['models/a"b.sql', "not allowed in a file name"],
      ["models/a*b?.sql", "not allowed in a file name"],
      ["models/x.sql.", "ends with a dot"],
      ["models /x.sql", "starts or ends with a space"],
      ["models/CON.sql", '"CON.sql" is a reserved name on Windows.'],
      ["LPT9/x.sql", "reserved name on Windows"],
      [`models/${"a".repeat(252)}.sql`, "longer than the 255 bytes"],
      [`models/${"é".repeat(126)}.sql`, "longer than the 255 bytes"],
      [`models/${"a/".repeat(600)}x.sql`, "The path is too long."],
    ];
    for (const [slug, said] of refused) {
      const error = await renameObject(admin(), "dbt_file", {
        ref: "models/orders.sql",
        slug,
      }).catch((e: Error) => e);
      expect([slug.slice(0, 30), error]).toEqual([
        slug.slice(0, 30),
        expect.objectContaining({
          name: "RenameError",
          status: 400,
          message: expect.stringContaining(said),
        }),
      ]);
    }
    // The route answers with the same sentence (never a 500).
    const res = await routeRename("models/orders.sql", "../staging/x.sql");
    expect([res.status, await res.json()]).toEqual([
      400,
      { success: false, error: "The path must stay inside the dbt project." },
    ]);
    // NFD of a name that exists in NFC: one file on a Mac.
    await expect(
      rename("models/orders.sql", "models/café.sql"),
    ).rejects.toMatchObject({ status: 409 });
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
  });

  it("accepts the merely unusual, resolves . and .. inside the project, and never leaves dbt/", async () => {
    await seedProject();
    let from = "models/orders.sql";
    for (const [slug, landed] of [
      ["models/😀.sql", "models/😀.sql"],
      ["models/שלום.sql", "models/שלום.sql"],
      [
        "models/507f1f77bcf86cd799439011.sql",
        "models/507f1f77bcf86cd799439011.sql",
      ],
      ["apps/orders.sql", "apps/orders.sql"],
      ["/models//staging/./orders.sql", "models/staging/orders.sql"],
      ["dbt/models/staging/../orders.sql", "models/orders.sql"],
    ]) {
      const r = await renameObject(admin(), "dbt_file", {
        ref: from,
        slug,
        options: { updateRefs: false },
      });
      expect(r.after.slug).toBe(landed);
      from = landed;
    }
    const outside = (await listTree(repoDirFor(WS), MAIN))
      .map(e => e.path)
      .filter(p => !p.startsWith("dbt/") && p !== "README.md");
    expect(outside).toEqual([]);
    // git records each of those as a rename of one file.
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
    expect(stdout.trim().split("\t")).toEqual([
      "R100",
      "dbt/models/staging/orders.sql",
      "dbt/models/orders.sql",
    ]);
  });
});
