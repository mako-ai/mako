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
  reconcileStaleQueuedRun: vi.fn(async (r: unknown) => r),
  reconcileStaleQueuedRuns: vi.fn(async (r: unknown) => r),
}));
vi.mock("../integrations/github/app-auth", () => ({
  getInstallationToken: vi.fn(),
  resolveRepoToken: vi.fn(),
}));
vi.mock("../integrations/github/config", () => ({
  getGitHubAppSlug: vi.fn(() => null),
  isGitHubAppConfigured: vi.fn(() => false),
  getGitHubDevToken: vi.fn(() => null),
}));
vi.mock("../integrations/github/github-api", () => ({
  fileExistsAtRef: vi.fn(),
  getRepoInfo: vi.fn(),
  listBranches: vi.fn(),
  listDbtProjectSubdirectories: vi.fn(),
  listInstallationRepos: vi.fn(),
}));
vi.mock("../dbt/dbt-github-sync.service", () => ({
  fetchRepoDbtFiles: vi.fn(),
  repoFilesToInserts: vi.fn(),
  syncProjectBranchFromRepo: vi.fn(),
}));
vi.mock("../dbt/dbt-github-git.service", () => ({
  commitAndPush: vi.fn(),
  commitToNewBranch: vi.fn(),
  createProjectBranch: vi.fn(),
  deleteProjectBranch: vi.fn(),
  getGitStatus: vi.fn(),
  getProjectFileDiff: vi.fn(),
  listProjectBranches: vi.fn(),
  mergeProjectPullRequest: vi.fn(),
  openProjectPullRequest: vi.fn(),
  ProtectedBranchError: class ProtectedBranchError extends Error {},
  switchProjectBranch: vi.fn(),
}));
vi.mock("../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../services/dashboard-artifact-store.service", () => ({
  getDashboardArtifactStore: vi.fn(() => ({})),
}));
vi.mock("../services/entity-version.service", () => ({
  createVersion: vi.fn(async () => ({})),
  getLatestVersionNumber: vi.fn(async () => 0),
  getUserDisplayName: vi.fn(async () => "Tester"),
}));
vi.mock("../services/scheduled-query-schedule.service", () => ({
  validateScheduledConsoleSchedule: vi.fn(() => null),
}));

// Imported after the mocks are registered.
import { dbtRoutes } from "./dbt.routes";
import { DatabaseConnection } from "../database/workspace-schema";
import { runAdhocDbtCommand } from "../dbt/dbt-project.service";
import {
  requestDbtRunCancel,
  triggerDbtRunRetry,
} from "../dbt/dbt-run.service";
import { publishRealtimeEvent } from "../services/realtime.service";

const publishMock = publishRealtimeEvent as unknown as ReturnType<typeof vi.fn>;
const adhocMock = runAdhocDbtCommand as unknown as ReturnType<typeof vi.fn>;
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

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  ctx.role = "owner";
  vi.clearAllMocks();
  // Reset data and (re)seed a dbt-compatible connection for environments.
  await Promise.all([
    mongoose.connection.collection("dbt_projects").deleteMany({}),
    mongoose.connection.collection("dbt_files").deleteMany({}),
    mongoose.connection.collection("dbt_file_drafts").deleteMany({}),
    mongoose.connection.collection("dbt_checkouts").deleteMany({}),
    mongoose.connection.collection("dbt_jobs").deleteMany({}),
    mongoose.connection.collection("dbt_runs").deleteMany({}),
    mongoose.connection.collection("databaseconnections").deleteMany({}),
  ]);
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

    // The starter scaffold is materialized on create.
    const fileCount = await mongoose.connection
      .collection("dbt_files")
      .countDocuments({ projectId: new Types.ObjectId(projectId) });
    expect(fileCount).toBeGreaterThan(0);

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

  it("run-select requires a select and returns step results", async () => {
    const projectId = await createProjectAsOwner();
    expect(
      (await req("POST", `/projects/${projectId}/run-select`, {})).status,
    ).toBe(400);

    const res = await req("POST", `/projects/${projectId}/run-select`, {
      select: "customers+",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).run.stepResults).toHaveLength(1);
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

  it("lineage returns an empty DAG when no manifest exists yet", async () => {
    const projectId = await createProjectAsOwner();
    const res = await req("GET", `/projects/${projectId}/lineage`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lineage.nodes).toEqual([]);
    expect(json.lineage.edges).toEqual([]);
  });
});
