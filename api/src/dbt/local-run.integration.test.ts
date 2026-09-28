/**
 * `mako dbt run` — the server half, integration.
 *
 * Real service + real Mongoose models against mongodb-memory-server; the
 * git repo, the artifact store and Inngest are stubbed. Pins the authority
 * model:
 *
 *  - `dbt:personal` builds the caller's OWN environment (created on first
 *    use) and nothing else;
 *  - shared environments need `warehouse:write` (or a browser session);
 *  - the prod-like environment refuses ad-hoc builds whatever the scope —
 *    the existing triggerDbtRun guard, reused, not re-implemented;
 *  - the run carries the uploaded overlay and never a branch to build.
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const stored = vi.hoisted(() => new Map<string, Buffer>());
const knownCommits = vi.hoisted(() => new Set<string>());

vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })) },
}));
vi.mock("../services/dashboard-artifact-store.service", () => ({
  getDashboardArtifactStore: () => ({
    exists: async (key: string) => stored.has(key),
    putBuffer: async (buffer: Buffer, key: string) => {
      stored.set(key, Buffer.from(buffer));
    },
    openReadStream: async (key: string) => {
      const { Readable } = await import("node:stream");
      const body = stored.get(key);
      return body ? Readable.from([body]) : null;
    },
  }),
}));
vi.mock("../apps/cloud-repo.service", () => ({
  ensureCommitLocally: vi.fn(async () => undefined),
}));
vi.mock("../apps/worktree.service", () => ({
  repoForWorkspace: vi.fn(async () => "/repo"),
}));
vi.mock("../apps/repository.service", () => ({
  DEFAULT_BRANCH: "main",
  resolveCommit: vi.fn(async (_dir: string, ref: string) =>
    knownCommits.has(ref) ? ref : null,
  ),
}));
// Provisioning a personal environment commits environments.yml to the
// workspace repo; the row is what this suite is about.
vi.mock("./dbt-config.service", () => ({
  commitDbtEnvironmentsFile: vi.fn(async () => undefined),
}));
vi.mock("../services/entity-version.service", () => ({
  getUserDisplayName: vi.fn(async () => "joan@example.com"),
}));
vi.mock("./dbt-working-tree.service", () => ({
  getCheckoutBranch: vi.fn(async () => "main"),
}));

import { inngest } from "../inngest/client";
import { DbtProject, DbtRun } from "../database/workspace-schema";
import { DbtProtectedEnvironmentError } from "./dbt-environments.service";
import {
  LocalRunError,
  findOwnLocalRun,
  startLocalDbtRun,
  type LocalRunAuthority,
  type StartLocalRunInput,
} from "./local-run.service";
import { loadLocalOverlay } from "./local-overlay";

const sendMock = inngest.send as unknown as ReturnType<typeof vi.fn>;

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId();
const JOAN = new Types.ObjectId().toString();
const ALEX = new Types.ObjectId().toString();
const BASE = "b".repeat(40);

const PERSONAL: LocalRunAuthority = {
  kind: "token",
  scopes: ["mcp", "query:read", "dbt:personal"],
};
const WAREHOUSE: LocalRunAuthority = {
  kind: "token",
  scopes: ["mcp", "query:read", "warehouse:write"],
};
const READ_ONLY: LocalRunAuthority = {
  kind: "token",
  scopes: ["mcp", "query:read"],
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  stored.clear();
  knownCommits.clear();
  knownCommits.add(BASE);
  await Promise.all([DbtProject.deleteMany({}), DbtRun.deleteMany({})]);
});

async function seedProject(options: { joanHasEnv?: boolean } = {}) {
  const connectionId = new Types.ObjectId();
  return DbtProject.create({
    workspaceId: WS,
    name: "warehouse",
    environments: [
      { name: "dev", connectionId, targetSchema: "dbt_dev", threads: 4 },
      { name: "prod", connectionId, targetSchema: "dbt_prod", threads: 4 },
      {
        name: "alex",
        connectionId,
        targetSchema: "dbt_alex",
        threads: 4,
        ownerUserId: ALEX,
      },
      ...(options.joanHasEnv
        ? [
            {
              name: "joan",
              connectionId,
              targetSchema: "dbt_joan",
              threads: 4,
              ownerUserId: JOAN,
            },
          ]
        : []),
    ],
    defaultEnvironment: "dev",
    createdBy: JOAN,
  });
}

function input(
  overrides: Partial<StartLocalRunInput> = {},
): StartLocalRunInput {
  return {
    workspaceId: WS.toString(),
    userId: JOAN,
    authority: PERSONAL,
    command: "build",
    select: "stg_orders+",
    sourceLabel: "feat/calls",
    overlay: {
      baseSha: BASE,
      files: { "models/stg_orders.sql": "select 1" },
      deletes: ["models/old.sql"],
    },
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeTruthy();
  return error as Error & { status?: number };
}

describe("startLocalDbtRun", () => {
  it("builds the caller's personal environment from the uploaded checkout", async () => {
    await seedProject({ joanHasEnv: true });
    const result = await startLocalDbtRun(input({ fullRefresh: true }));

    const run = await DbtRun.findById(result.run._id).lean();
    expect(run).toMatchObject({
      environment: "joan",
      commands: ["build --select stg_orders+ --full-refresh"],
      trigger: "manual",
      triggeredBy: JOAN,
      sourceBranch: "local checkout on feat/calls",
      localOverlay: { baseSha: BASE, files: 1, deletes: 1 },
    });
    // Never a branch or a working tree: the overlay is the source.
    expect(run?.gitBranch).toBeUndefined();
    expect(run?.workingTreeUserId).toBeUndefined();
    expect(await loadLocalOverlay(run?.localOverlay?.key ?? "")).toEqual(
      input().overlay,
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("creates the personal environment on first use when --env is omitted", async () => {
    await seedProject();
    const result = await startLocalDbtRun(input());
    expect(result.provisionedEnvironment).toEqual({
      name: "joan",
      targetSchema: "dbt_joan",
    });
    expect(result.run.environment).toBe("joan");
    const project = await DbtProject.findOne({ workspaceId: WS }).lean();
    expect(
      project?.environments.find(env => env.name === "joan")?.ownerUserId,
    ).toBe(JOAN);
  });

  it("refuses a shared environment to dbt:personal, pointing at --warehouse-write", async () => {
    await seedProject({ joanHasEnv: true });
    const error = await refusal(
      startLocalDbtRun(input({ environment: "dev" })),
    );
    expect(error).toBeInstanceOf(LocalRunError);
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/shared environment/);
    expect(error.message).toMatch(/mako login --warehouse-write/);
    expect(await DbtRun.countDocuments({})).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refuses someone else's personal environment even with warehouse:write", async () => {
    await seedProject({ joanHasEnv: true });
    const error = await refusal(
      startLocalDbtRun(input({ environment: "alex", authority: WAREHOUSE })),
    );
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/another person's personal environment/);
  });

  it("lets warehouse:write build a shared environment", async () => {
    await seedProject({ joanHasEnv: true });
    const result = await startLocalDbtRun(
      input({ environment: "dev", authority: WAREHOUSE }),
    );
    expect(result.run.environment).toBe("dev");
  });

  it("lets a browser session build a shared environment", async () => {
    await seedProject({ joanHasEnv: true });
    const result = await startLocalDbtRun(
      input({ environment: "dev", authority: { kind: "session" } }),
    );
    expect(result.run.environment).toBe("dev");
  });

  it("keeps prod out of reach of ad-hoc builds whatever the scope (the existing guard)", async () => {
    await seedProject({ joanHasEnv: true });
    await expect(
      startLocalDbtRun(input({ environment: "prod", authority: WAREHOUSE })),
    ).rejects.toThrow(DbtProtectedEnvironmentError);
    const error = await refusal(
      startLocalDbtRun(input({ environment: "prod" })),
    );
    expect(error.message).toMatch(/production environment/);
    expect(await DbtRun.countDocuments({})).toBe(0);
  });

  it("refuses a read-only login, even for the caller's own environment", async () => {
    await seedProject({ joanHasEnv: true });
    const error = await refusal(
      startLocalDbtRun(input({ authority: READ_ONLY })),
    );
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/mako login/);
  });

  it("does not provision anything for a login that could not use it", async () => {
    await seedProject();
    await refusal(startLocalDbtRun(input({ authority: READ_ONLY })));
    const project = await DbtProject.findOne({ workspaceId: WS }).lean();
    expect(project?.environments.some(env => env.ownerUserId === JOAN)).toBe(
      false,
    );
  });

  it("refuses a base commit the workspace repo does not have, before queueing", async () => {
    await seedProject({ joanHasEnv: true });
    const error = await refusal(
      startLocalDbtRun(
        input({
          overlay: { baseSha: "c".repeat(40), files: {}, deletes: [] },
        }),
      ),
    );
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/not in the workspace repo/);
    expect(await DbtRun.countDocuments({})).toBe(0);
  });

  it("rejects invalid selectors and --full-refresh on test", async () => {
    await seedProject({ joanHasEnv: true });
    expect(
      (await refusal(startLocalDbtRun(input({ select: "a; rm -rf /" }))))
        .status,
    ).toBe(400);
    expect(
      (
        await refusal(
          startLocalDbtRun(input({ command: "test", fullRefresh: true })),
        )
      ).status,
    ).toBe(400);
  });
});

describe("findOwnLocalRun", () => {
  it("finds the caller's laptop runs and nobody else's", async () => {
    await seedProject({ joanHasEnv: true });
    const { run } = await startLocalDbtRun(input());
    const runId = run._id.toString();
    expect(
      await findOwnLocalRun({
        workspaceId: WS.toString(),
        userId: JOAN,
        runId,
      }),
    ).toBeTruthy();
    expect(
      await findOwnLocalRun({
        workspaceId: WS.toString(),
        userId: ALEX,
        runId,
      }),
    ).toBeNull();
    expect(
      await findOwnLocalRun({
        workspaceId: new Types.ObjectId().toString(),
        userId: JOAN,
        runId,
      }),
    ).toBeNull();
  });
});
