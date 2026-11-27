/**
 * triggerDbtRun protected-environment guard — integration.
 *
 * Real service and Postgres repository against PGlite; only
 * Inngest is mocked. Verifies the ad-hoc/job asymmetry end-to-end:
 *
 *  - ad-hoc (agent/manual, no jobId) warehouse writes into the prod-like
 *    environment of a repo-connected project are refused BEFORE a run doc is
 *    created or an event is sent (uncommitted drafts can never deploy prod);
 *  - job runs, read-only ad-hoc commands, non-prod targets, and blank
 *    (repo-less) projects keep working.
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
import { Types } from "mongoose";
import {
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";

vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })) },
}));

import { inngest } from "../inngest/client";
import {
  recordCompletedAdhocDbtRun,
  triggerDbtRun,
  triggerDbtJobRun,
} from "./dbt-run.service";
import {
  DbtProtectedEnvironmentError,
  resolveDevEnvironmentForUser,
  setUserDevEnvPreference,
} from "./dbt-environments.service";
import { dbtRepo } from "../repositories/dbt";

import { appsMetadataRepo } from "../repositories/apps-metadata";

const sendMock = inngest.send as unknown as ReturnType<typeof vi.fn>;

let pg: PgTestDb;
const WS = new Types.ObjectId();

beforeAll(async () => {
  pg = await setupPgTestDb();
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pg.reset();
  await ensureTestWorkspace(pg.db, { id: String(WS), ownerUserId: "u1" });
});

function envs() {
  return [
    {
      name: "dev",
      connectionId: String(new Types.ObjectId()),
      targetSchema: "dbt_dev",
      threads: 4,
    },
    {
      name: "prod",
      connectionId: String(new Types.ObjectId()),
      targetSchema: "dbt_prod",
      threads: 4,
    },
  ];
}

async function seedProject() {
  return dbtRepo.createProject({
    workspaceId: String(WS),
    name: `p-${new Types.ObjectId().toString()}`,
    environments: envs(),
    defaultEnvironment: "dev",
    createdBy: "u1",
  });
}

function adhocParams(projectId: string, environment: string) {
  return {
    workspaceId: WS.toString(),
    projectId,
    environment,
    commands: ["build --select stg_orders --full-refresh"],
    trigger: "agent" as const,
    triggeredBy: "agent",
    actor: { kind: "user" as const, userId: "u1" },
    workingTreeUserId: "u1",
  };
}

describe("triggerDbtRun protected-environment guard", () => {
  it("refuses an ad-hoc warehouse write into prod on a repo project", async () => {
    const project = await seedProject();
    await expect(
      triggerDbtRun(adhocParams(project._id.toString(), "prod")),
    ).rejects.toThrow(DbtProtectedEnvironmentError);
    // Nothing persisted, nothing enqueued.
    expect(await dbtRepo.runExists({ workspaceId: String(WS) })).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("allows the same ad-hoc build against a non-prod environment", async () => {
    const project = await seedProject();
    const run = await triggerDbtRun(adhocParams(project._id.toString(), "dev"));
    expect(run.status).toBe("queued");
    expect(run.commands).toEqual(["build --select stg_orders --full-refresh"]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("allows read-only ad-hoc commands against prod", async () => {
    const project = await seedProject();
    const run = await triggerDbtRun({
      ...adhocParams(project._id.toString(), "prod"),
      commands: ["compile --select stg_orders"],
    });
    expect(run.status).toBe("queued");
  });

  it("allows prod runs through a saved job (the sanctioned deploy path)", async () => {
    const project = await seedProject();
    const job = await dbtRepo.createJob({
      workspaceId: String(WS),
      projectId: project._id,
      name: "Deploy prod",
      environment: "prod",
      commands: ["build --full-refresh"],
      enabled: true,
      createdBy: "u1",
    });
    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "manual",
      triggeredBy: "u1",
      actor: { kind: "user" as const, userId: "u1" },
    });
    expect(run.status).toBe("queued");
    expect(run.jobId?.toString()).toBe(job._id.toString());
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("applies to every project — the guard is universal now (apps.md §20)", async () => {
    const project = await seedProject();
    await expect(
      triggerDbtRun({
        ...adhocParams(project._id.toString(), "prod"),
        workingTreeUserId: undefined,
      }),
    ).rejects.toBeInstanceOf(DbtProtectedEnvironmentError);
  });
});

describe("sourceBranch provenance stamping", () => {
  it("working-tree runs record the caller's checkout branch", async () => {
    const project = await seedProject();
    // Implicit session (no row) → default branch.
    const tracked = await triggerDbtRun(
      adhocParams(project._id.toString(), "dev"),
    );
    expect(tracked.sourceBranch).toBe("main");
    expect(tracked.workingTreeUserId).toBe("u1");

    // Explicit session branch → that branch.
    await appsMetadataRepo.ensureWorktreeRow(
      String(WS),
      "u1",
      "feat/leads-rollup",
    );
    const feature = await triggerDbtRun(
      adhocParams(project._id.toString(), "dev"),
    );
    expect(feature.sourceBranch).toBe("feat/leads-rollup");
  });

  it("job runs record the default branch (no working tree)", async () => {
    const project = await seedProject();
    const job = await dbtRepo.createJob({
      workspaceId: String(WS),
      projectId: project._id,
      name: "Nightly",
      environment: "prod",
      commands: ["build"],
      enabled: true,
      createdBy: "u1",
    });
    const run = await triggerDbtJobRun({
      workspaceId: WS.toString(),
      job,
      trigger: "manual",
      triggeredBy: "u1",
      actor: { kind: "user" as const, userId: "u1" },
    });
    expect(run.sourceBranch).toBe("main");
    expect(run.workingTreeUserId).toBeUndefined();
  });

  it("an explicit gitBranch wins over the session branch", async () => {
    const repoProject = await seedProject();
    const explicit = await triggerDbtRun({
      workspaceId: WS.toString(),
      projectId: repoProject._id.toString(),
      environment: "dev",
      commands: ["build"],
      trigger: "agent",
      triggeredBy: "agent",
      actor: { kind: "user" as const, userId: "u1" },
      gitBranch: "pr-head-branch",
    });
    expect(explicit.sourceBranch).toBe("pr-head-branch");
  });
});

describe("resolveDevEnvironmentForUser — per-user dev environment", () => {
  it("resolves explicit > saved choice > personal env > project default", async () => {
    const project = await seedProject();

    // No choice, no personal env → the project default (single-player: dev
    // IS the personal target).
    expect(await resolveDevEnvironmentForUser(project, "u1")).toBe("dev");

    // Personal env provisioned → it wins over the default.
    project.environments.push({
      name: "alice",
      connectionId: String(new Types.ObjectId()),
      targetSchema: "dbt_alice",
      threads: 4,
      ownerUserId: "u1",
    });
    await dbtRepo.updateProject(project._id, {
      environments: project.environments,
    });
    expect(await resolveDevEnvironmentForUser(project, "u1")).toBe("alice");

    // A saved per-user choice beats the personal env.
    await setUserDevEnvPreference({
      workspaceId: String(WS),
      projectId: project._id,
      userId: "u1",
      environment: "dev",
    });
    expect(await resolveDevEnvironmentForUser(project, "u1")).toBe("dev");

    // Explicit request always wins.
    expect(await resolveDevEnvironmentForUser(project, "u1", "prod")).toBe(
      "prod",
    );

    // Clearing the choice falls back to the personal env.
    await setUserDevEnvPreference({
      workspaceId: String(WS),
      projectId: project._id,
      userId: "u1",
      environment: null,
    });
    expect(await resolveDevEnvironmentForUser(project, "u1")).toBe("alice");
  });

  it("ignores a stale saved choice pointing at a removed environment", async () => {
    const project = await seedProject();
    await dbtRepo.upsertEnvPreference({
      workspaceId: String(WS),
      projectId: project._id,
      userId: "u1",
      environment: "gone",
    });
    expect(await resolveDevEnvironmentForUser(project, "u1")).toBe("dev");
  });

  it("is scoped per user", async () => {
    await ensureTestUser(pg.db, { id: "u2" });
    const project = await seedProject();
    await setUserDevEnvPreference({
      workspaceId: String(WS),
      projectId: project._id,
      userId: "u1",
      environment: "prod",
    });
    expect(await resolveDevEnvironmentForUser(project, "u1")).toBe("prod");
    expect(await resolveDevEnvironmentForUser(project, "u2")).toBe("dev");
  });
});

describe("recordCompletedAdhocDbtRun", () => {
  it("persists a terminal run doc with logs, steps, and provenance", async () => {
    const project = await seedProject();
    const startedAt = new Date(Date.now() - 1500);
    const recorded = await recordCompletedAdhocDbtRun({
      workspaceId: WS.toString(),
      projectId: project._id.toString(),
      environment: "dev",
      command: "build --select stg_orders --full-refresh",
      triggeredBy: "u1",
      actor: { kind: "user" as const, userId: "u1" },
      workingTreeUserId: "u1",
      sourceBranch: "main",
      startedAt,
      result: {
        success: true,
        exitCode: 0,
        logs: [
          { ts: new Date(), level: "info", line: "Done. PASS=1" },
          // dbt emits blank spacer lines — must not fail `create` validation.
          { ts: new Date(), level: "info", line: "" },
        ],
        stepResults: [
          {
            uniqueId: "model.p.stg_orders",
            name: "stg_orders",
            resourceType: "model",
            status: "success",
            executionTimeMs: 42,
          },
        ],
      },
    });

    expect(recorded).not.toBeNull();
    if (!recorded) throw new Error("Expected the run to be recorded");
    const doc = await dbtRepo.findRunWithLogs(recorded._id);
    expect(doc?.status).toBe("success");
    expect(doc?.trigger).toBe("manual");
    expect(doc?.commands).toEqual(["build --select stg_orders --full-refresh"]);
    expect(doc?.sourceBranch).toBe("main");
    expect(doc?.workingTreeUserId).toBe("u1");
    expect(doc?.durationMs).toBeGreaterThanOrEqual(1500);
    expect(doc?.logs).toHaveLength(2);
    expect(doc?.stepResults?.[0]?.name).toBe("stg_orders");
    expect(doc?.completedAt).toBeDefined();
  });

  it("marks failed commands as error with the exit code", async () => {
    const project = await seedProject();
    const recorded = await recordCompletedAdhocDbtRun({
      workspaceId: WS.toString(),
      projectId: project._id.toString(),
      environment: "dev",
      command: "build",
      triggeredBy: "u1",
      actor: { kind: "user" as const, userId: "u1" },
      startedAt: new Date(),
      result: { success: false, exitCode: 2, logs: [], stepResults: [] },
    });
    expect(recorded?.status).toBe("error");
    expect(recorded?.error).toMatch(/exited with code 2/);
  });
});
