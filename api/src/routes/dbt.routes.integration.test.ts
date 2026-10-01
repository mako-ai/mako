/**
 * dbt routes — in-process integration tests.
 *
 * Boots the real `dbtRoutes` Hono app against an ephemeral mongodb-memory-server
 * and drives it via `app.request()`. Auth + workspace-role resolution and the
 * heavy collaborators (runner, Inngest, GitHub, artifact store, entity
 * versioning) are mocked so the tests exercise routing, RBAC, validation, and
 * Mongoose persistence deterministically — no subprocess, no network.
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
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Mutable caller role for the RBAC matrix (hoisted so the mock factory sees it).
const ctx = vi.hoisted(() => ({ role: "owner" as string | null }));

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));

vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    getMember: vi.fn(async () => (ctx.role ? { role: ctx.role } : null)),
  },
}));

// Heavy collaborators — stubbed so imports resolve and side-effects are inert.
vi.mock("../dbt/dbt-project.service", () => ({
  // No prod manifest in the fixture: routes fall back to running without
  // --defer, which is the behavior these specs exercise.
  loadDbtDeferState: vi.fn(async () => undefined),
  // Mirrors the real runAdhocDbtCommand result shape (routes read `.success`).
  runAdhocDbtCommand: vi.fn(async () => ({
    success: true,
    exitCode: 0,
    logs: [] as Array<{ ts: Date; level: string; line: string }>,
    stepResults: [
      {
        uniqueId: "model.analytics.m",
        name: "m",
        resourceType: "model",
        status: "success",
        executionTimeMs: 10,
      },
    ],
    compiledSql: "select 1",
  })),
}));
vi.mock("../dbt/dbt-run.service", () => ({
  triggerDbtJobRun: vi.fn(async () => ({ _id: new Types.ObjectId() })),
  triggerDbtRunRetry: vi.fn(async () => ({ _id: new Types.ObjectId() })),
  requestDbtRunCancel: vi.fn(async () => ({ status: "cancelled" })),
  applyJobScheduleChange: vi.fn(async () => undefined),
  recordCompletedAdhocDbtRun: vi.fn(async () => ({
    _id: new Types.ObjectId(),
  })),
  reconcileStaleQueuedRun: vi.fn(async (r: unknown) => r),
  reconcileStaleQueuedRuns: vi.fn(async (r: unknown) => r),
}));
vi.mock("../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../services/dashboard-artifact-store.service", () => ({
  getDashboardArtifactStore: vi.fn(() => ({})),
}));
vi.mock("../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));

// Imported after the mocks are registered.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dbtRoutes } from "./dbt.routes";
import { seedDbtGitTree } from "../dbt/test-support/git-tree";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import { DatabaseConnection } from "../database/workspace-schema";
import { runAdhocDbtCommand } from "../dbt/dbt-project.service";
import {
  recordCompletedAdhocDbtRun,
  requestDbtRunCancel,
  triggerDbtRunRetry,
} from "../dbt/dbt-run.service";
import { publishRealtimeEvent } from "../services/realtime.service";

const publishMock = publishRealtimeEvent as unknown as ReturnType<typeof vi.fn>;
const adhocMock = runAdhocDbtCommand as unknown as ReturnType<typeof vi.fn>;
const recordAdhocMock = recordCompletedAdhocDbtRun as unknown as ReturnType<
  typeof vi.fn
>;
const cancelMock = requestDbtRunCancel as unknown as ReturnType<typeof vi.fn>;
const retryMock = triggerDbtRunRetry as unknown as ReturnType<typeof vi.fn>;

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId().toString();

function makeApp() {
  const app = new Hono();
  app.route("/api/workspaces/:workspaceId/dbt", dbtRoutes);
  return app;
}

const app = makeApp();

function req(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api/workspaces/${WS}/dbt${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ENV = {
  name: "dev",
  connectionId: CONN,
  targetSchema: "analytics",
  threads: 4,
};
const NEW_PROJECT = {
  name: "Analytics",
  environments: [ENV],
  defaultEnvironment: "dev",
};

async function createProjectAsOwner(): Promise<string> {
  ctx.role = "owner";
  const res = await req("POST", "/projects", NEW_PROJECT);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { project: { _id: string } };
  return json.project._id;
}

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-routes-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  ctx.role = "owner";
  vi.clearAllMocks();
  // Reset data and (re)seed a dbt-compatible connection for environments.
  await Promise.all([
    mongoose.connection.collection("dbt_projects").deleteMany({}),
    mongoose.connection.collection("dbt_jobs").deleteMany({}),
    mongoose.connection.collection("dbt_runs").deleteMany({}),
    mongoose.connection.collection("app_worktrees").deleteMany({}),
    mongoose.connection.collection("databaseconnections").deleteMany({}),
  ]);
  // Fresh bare workspace repo per test: file writes are commits now.
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await bindTestWorkspaceRepo(WS);
  await seedDbtGitTree(WS, { "dbt_project.yml": "name: analytics\n" });
  await DatabaseConnection.collection.insertOne({
    _id: new Types.ObjectId(CONN),
    workspaceId: new Types.ObjectId(WS),
    name: "pg",
    type: "postgresql",
    connection: { host: "localhost", port: 5432 },
  });
});

describe("RBAC matrix (through real middleware)", () => {
  it("viewers can read but not write", async () => {
    ctx.role = "viewer";
    expect((await req("GET", "/projects")).status).toBe(200);
    const write = await req("POST", "/projects", NEW_PROJECT);
    expect(write.status).toBe(403);
    expect((await write.json()).error).toMatch(/read-only/i);
  });

  it("preview is member+ — viewers and non-members are refused", async () => {
    // Preview runs a bounded SELECT against the warehouse, so it sits with the
    // other ad-hoc runner routes (member+) rather than with plain GET reads.
    ctx.role = "owner";
    const projectId = await createProjectAsOwner();
    const body = { select: "customers" };

    ctx.role = "viewer";
    const viewer = await req("POST", `/projects/${projectId}/preview`, body);
    expect(viewer.status).toBe(403);
    expect((await viewer.json()).error).toMatch(/read-only/i);

    ctx.role = null;
    expect(
      (await req("POST", `/projects/${projectId}/preview`, body)).status,
    ).toBe(403);

    ctx.role = "member";
    expect(
      (await req("POST", `/projects/${projectId}/preview`, body)).status,
    ).toBe(200);
  });

  it("members are blocked from admin-only project creation", async () => {
    ctx.role = "member";
    const res = await req("POST", "/projects", NEW_PROJECT);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/admin or owner/i);
  });

  it("members CAN write files (member+ route)", async () => {
    const projectId = await createProjectAsOwner();
    ctx.role = "member";
    const res = await req("PUT", `/projects/${projectId}/files/models/m.sql`, {
      content: "select 1",
    });
    expect(res.status).toBe(200);
  });

  it("admins CAN create projects", async () => {
    ctx.role = "admin";
    const res = await req("POST", "/projects", NEW_PROJECT);
    expect(res.status).toBe(200);
  });

  it("rejects callers with no workspace membership", async () => {
    ctx.role = null;
    const res = await req("GET", "/projects");
    expect(res.status).toBe(403);
  });
});

describe("project CRUD", () => {
  it("creates, lists, gets, patches, and deletes a project", async () => {
    const projectId = await createProjectAsOwner();

    // The working tree is the workspace repo's dbt/ folder (seeded in
    // beforeEach; a fresh workspace would get the starter scaffold committed).
    const filesRes = (await (
      await req("GET", `/projects/${projectId}/files`)
    ).json()) as { files: Array<{ path: string }> };
    expect(filesRes.files.map(f => f.path)).toContain("dbt_project.yml");

    const list = await (await req("GET", "/projects")).json();
    expect(list.projects).toHaveLength(1);

    const got = await (await req("GET", `/projects/${projectId}`)).json();
    expect(got.project.name).toBe("Analytics");

    const patched = await req("PATCH", `/projects/${projectId}`, {
      name: "Renamed",
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).project.name).toBe("Renamed");

    const del = await req("DELETE", `/projects/${projectId}`);
    expect(del.status).toBe(200);
    expect(
      (await (await req("GET", "/projects")).json()).projects,
    ).toHaveLength(0);
  });

  it("saves, validates, clears, and surfaces the caller's dev environment", async () => {
    const projectId = await createProjectAsOwner();

    // Unknown env → 400.
    const bad = await req("PUT", `/projects/${projectId}/my-environment`, {
      environment: "nope",
    });
    expect(bad.status).toBe(400);

    // Save a valid choice → surfaced on the project list for this caller.
    const set = await req("PUT", `/projects/${projectId}/my-environment`, {
      environment: "dev",
    });
    expect(set.status).toBe(200);
    expect((await set.json()).myDevEnvironment).toBe("dev");

    const list = await req("GET", "/projects");
    const listed = (
      (await list.json()).projects as Array<{
        _id: string;
        myDevEnvironment?: string;
      }>
    ).find(p => p._id === projectId);
    expect(listed?.myDevEnvironment).toBe("dev");

    // "" clears back to Auto.
    const cleared = await req("PUT", `/projects/${projectId}/my-environment`, {
      environment: "",
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).myDevEnvironment).toBeUndefined();

    const list2 = await req("GET", "/projects");
    const listed2 = (
      (await list2.json()).projects as Array<{
        _id: string;
        myDevEnvironment?: string;
      }>
    ).find(p => p._id === projectId);
    expect(listed2?.myDevEnvironment).toBeUndefined();
  });

  it("sets, validates, and clears the production (defer) environment", async () => {
    const projectId = await createProjectAsOwner();

    // Unknown env name → 400.
    const bad = await req("PATCH", `/projects/${projectId}`, {
      prodEnvironment: "release",
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/not in environments/);

    // Valid env → persisted.
    const set = await req("PATCH", `/projects/${projectId}`, {
      prodEnvironment: "dev",
    });
    expect(set.status).toBe(200);
    expect((await set.json()).project.prodEnvironment).toBe("dev");

    // Empty string clears the override back to Auto.
    const cleared = await req("PATCH", `/projects/${projectId}`, {
      prodEnvironment: "",
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).project.prodEnvironment).toBeUndefined();
  });

  it("rejects an environment bound to a non-dbt-compatible connection", async () => {
    await mongoose.connection
      .collection("databaseconnections")
      .updateOne(
        { _id: new Types.ObjectId(CONN) },
        { $set: { type: "mongodb" } },
      );
    ctx.role = "owner";
    const res = await req("POST", "/projects", NEW_PROJECT);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not dbt-compatible/i);
  });

  it("rejects a defaultEnvironment not present in environments", async () => {
    const res = await req("POST", "/projects", {
      ...NEW_PROJECT,
      defaultEnvironment: "prod",
    });
    expect(res.status).toBe(400);
  });
});

describe("file CRUD", () => {
  it("PUTs, reads, lists, and deletes a file", async () => {
    const projectId = await createProjectAsOwner();
    const path = "models/staging/stg_orders.sql";

    const put = await req("PUT", `/projects/${projectId}/files/${path}`, {
      content: "select * from orders",
    });
    expect(put.status).toBe(200);

    const read = await (
      await req("GET", `/projects/${projectId}/files/${path}`)
    ).json();
    expect(read.file.content).toBe("select * from orders");

    const list = await (
      await req("GET", `/projects/${projectId}/files`)
    ).json();
    expect(list.files.some((f: { path: string }) => f.path === path)).toBe(
      true,
    );

    const del = await req("DELETE", `/projects/${projectId}/files/${path}`);
    expect(del.status).toBe(200);
  });

  it("rejects oversized file content", async () => {
    const projectId = await createProjectAsOwner();
    const res = await req(
      "PUT",
      `/projects/${projectId}/files/models/big.sql`,
      { content: "x".repeat(1_000_001) },
    );
    expect(res.status).toBe(400);
  });

  it("rename pokes both paths over the realtime channel", async () => {
    const projectId = await createProjectAsOwner();
    await req("PUT", `/projects/${projectId}/files/models/old.sql`, {
      content: "select 1",
    });
    publishMock.mockClear();

    const res = await req("POST", `/projects/${projectId}/files/rename`, {
      from: "models/old.sql",
      to: "models/new.sql",
      clientId: "tab-1",
    });
    expect(res.status).toBe(200);

    // Other windows express the rename as delete(from) + add(to).
    const events = publishMock.mock.calls.map(call => call[1]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "dbt.file.updated",
        path: "models/old.sql",
        deleted: true,
        clientId: "tab-1",
        origin: "save",
      }),
      expect.objectContaining({
        type: "dbt.file.updated",
        path: "models/new.sql",
        clientId: "tab-1",
        origin: "save",
      }),
    ]);
  });
});

describe("jobs CRUD", () => {
  it("creates, lists, and deletes a job", async () => {
    const projectId = await createProjectAsOwner();

    const create = await req("POST", `/projects/${projectId}/jobs`, {
      name: "nightly",
      environment: "dev",
      commands: ["build"],
    });
    expect(create.status).toBe(200);
    const jobId = (await create.json()).job._id;

    const list = await (await req("GET", `/projects/${projectId}/jobs`)).json();
    expect(list.jobs).toHaveLength(1);

    const del = await req("DELETE", `/projects/${projectId}/jobs/${jobId}`);
    expect(del.status).toBe(200);
  });
});

describe("not-found handling", () => {
  it("404s for an unknown project id", async () => {
    const res = await req(
      "GET",
      `/projects/${new Types.ObjectId().toString()}`,
    );
    expect(res.status).toBe(404);
  });
});

async function insertRun(
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const _id = new Types.ObjectId();
  await mongoose.connection.collection("dbt_runs").insertOne({
    _id,
    workspaceId: new Types.ObjectId(WS),
    projectId: new Types.ObjectId(projectId),
    environment: "dev",
    commands: ["build"],
    status: "success",
    trigger: "manual",
    logs: [],
    createdAt: new Date(),
    ...overrides,
  });
  return _id.toString();
}

describe("runs lifecycle", () => {
  it("lists runs and filters by jobId", async () => {
    const projectId = await createProjectAsOwner();
    const jobId = new Types.ObjectId();
    await insertRun(projectId);
    await insertRun(projectId, { jobId });

    const all = await (await req("GET", `/projects/${projectId}/runs`)).json();
    expect(all.runs).toHaveLength(2);

    const filtered = await (
      await req("GET", `/projects/${projectId}/runs?jobId=${jobId}`)
    ).json();
    expect(filtered.runs).toHaveLength(1);
  });

  it("returns run detail with logs sliced by the cursor", async () => {
    const projectId = await createProjectAsOwner();
    const runId = await insertRun(projectId, {
      logs: [
        { ts: new Date(), level: "info", line: "a" },
        { ts: new Date(), level: "info", line: "b" },
        { ts: new Date(), level: "info", line: "c" },
      ],
    });
    const res = await (
      await req("GET", `/projects/${projectId}/runs/${runId}?logsSince=1`)
    ).json();
    expect(res.run.logs).toHaveLength(2);
    expect(res.run.logCursor).toBe(3);
  });

  it("cancel returns 200 with status, 404 when the run is unknown", async () => {
    const projectId = await createProjectAsOwner();
    const runId = await insertRun(projectId, { status: "running" });

    const cancelledAt = new Date();
    cancelMock.mockResolvedValueOnce({
      status: "cancelled",
      cancelledAt,
      cancelledBy: "user-1",
    });
    const ok = await req("POST", `/projects/${projectId}/runs/${runId}/cancel`);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.status).toBe("cancelled");
    expect(body.cancelledBy).toBe("user-1");

    // Idempotent: an already-terminal run echoes its status with a 200.
    cancelMock.mockResolvedValueOnce({ status: "success" });
    const idempotent = await req(
      "POST",
      `/projects/${projectId}/runs/${runId}/cancel`,
    );
    expect(idempotent.status).toBe(200);
    expect((await idempotent.json()).status).toBe("success");

    // Unknown run → null → 404.
    cancelMock.mockResolvedValueOnce(null);
    expect(
      (await req("POST", `/projects/${projectId}/runs/${runId}/cancel`)).status,
    ).toBe(404);
  });

  it("retry returns the new runId when retriable, 400 otherwise", async () => {
    const projectId = await createProjectAsOwner();
    const runId = await insertRun(projectId, { status: "error" });

    const newId = new Types.ObjectId();
    retryMock.mockResolvedValueOnce({ _id: newId });
    const ok = await req("POST", `/projects/${projectId}/runs/${runId}/retry`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).runId).toBe(newId.toString());

    retryMock.mockResolvedValueOnce(null);
    expect(
      (await req("POST", `/projects/${projectId}/runs/${runId}/retry`)).status,
    ).toBe(400);
  });
});

describe("ad-hoc runner routes", () => {
  it("compile builds a `compile --select` command and returns compiled SQL", async () => {
    const projectId = await createProjectAsOwner();
    const res = await req("POST", `/projects/${projectId}/compile`, {
      select: "customers",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.compile.ok).toBe(true);
    expect(json.compile.compiledSql).toBe("select 1");
    expect(adhocMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "compile --select customers" }),
    );
  });

  it("compile with no select falls back to `parse`", async () => {
    const projectId = await createProjectAsOwner();
    await req("POST", `/projects/${projectId}/compile`, {});
    expect(adhocMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "parse" }),
    );
  });

  it("rejects an unsafe --select value", async () => {
    const projectId = await createProjectAsOwner();
    const res = await req("POST", `/projects/${projectId}/compile`, {
      select: "bad; rm -rf /",
    });
    expect(res.status).toBe(400);
  });

  it("command validates against the allowlist (strips leading `dbt`)", async () => {
    const projectId = await createProjectAsOwner();
    const ok = await req("POST", `/projects/${projectId}/command`, {
      command: "dbt build --select customers",
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).result.subcommand).toBe("build");
    expect(adhocMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "build --select customers" }),
    );

    const bad = await req("POST", `/projects/${projectId}/command`, {
      command: "clean",
    });
    expect(bad.status).toBe(400);
  });

  it("records warehouse-writing commands into run history, not read-only ones", async () => {
    const projectId = await createProjectAsOwner();

    await req("POST", `/projects/${projectId}/command`, {
      command: "build --select customers --full-refresh",
    });
    expect(recordAdhocMock).toHaveBeenCalledTimes(1);
    expect(recordAdhocMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "build --select customers --full-refresh",
        environment: "dev",
        triggeredBy: "u1",
      }),
    );

    recordAdhocMock.mockClear();
    await req("POST", `/projects/${projectId}/command`, {
      command: "compile --select customers",
    });
    expect(recordAdhocMock).not.toHaveBeenCalled();
  });

  it("preview runs a bounded `show --output json` and returns parsed rows", async () => {
    const projectId = await createProjectAsOwner();
    adhocMock.mockResolvedValueOnce({
      success: true,
      exitCode: 0,
      logs: [
        { ts: new Date(), level: "info", line: "Running with dbt=1.9.4" },
        {
          ts: new Date(),
          level: "info",
          line: JSON.stringify({
            node: "customers",
            show: [{ id: 1, name: "acme" }],
          }),
        },
      ],
      stepResults: [],
    });

    const res = await req("POST", `/projects/${projectId}/preview`, {
      select: "customers",
    });
    expect(res.status).toBe(200);
    const { preview } = await res.json();
    expect(preview.ok).toBe(true);
    expect(preview.columns).toEqual(["id", "name"]);
    expect(preview.rows).toEqual([{ id: 1, name: "acme" }]);
    expect(adhocMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "show --select customers --limit 500 --output json",
      }),
    );
  });

  it("preview never writes to run history and rejects unsafe selectors", async () => {
    const projectId = await createProjectAsOwner();

    await req("POST", `/projects/${projectId}/preview`, {
      select: "+customers",
    });
    expect(recordAdhocMock).not.toHaveBeenCalled();

    const bad = await req("POST", `/projects/${projectId}/preview`, {
      select: "bad; rm -rf /",
    });
    expect(bad.status).toBe(400);

    const tooMany = await req("POST", `/projects/${projectId}/preview`, {
      select: "customers",
      limit: 1_000_000,
    });
    expect(tooMany.status).toBe(400);
  });

  it("preview reports not-ok when dbt produced no rows payload", async () => {
    const projectId = await createProjectAsOwner();
    adhocMock.mockResolvedValueOnce({
      success: false,
      exitCode: 1,
      logs: [
        { ts: new Date(), level: "error", line: "Compilation Error in model" },
      ],
      stepResults: [],
    });

    const res = await req("POST", `/projects/${projectId}/preview`, {
      select: "customers",
    });
    const { preview } = await res.json();
    expect(preview.ok).toBe(false);
    expect(preview.rows).toEqual([]);
    expect(preview.logs[0].line).toContain("Compilation Error");
  });

  it("lineage returns an empty DAG when no manifest exists yet", async () => {
    const projectId = await createProjectAsOwner();
    const res = await req("GET", `/projects/${projectId}/lineage`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lineage.nodes).toEqual([]);
    expect(json.lineage.edges).toEqual([]);
  });
});
