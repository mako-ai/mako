/**
 * `mako dbt run` — the server half, integration.
 *
 * Real service + real Mongoose models against mongodb-memory-server; the
 * git repo, the artifact store and Inngest are stubbed. Pins the authority
 * model:
 *
 *  - any local run needs `warehouse:write` (or a browser session): the
 *    uploaded code runs with the environment's credentials, so no narrower
 *    scope is offered (a `dbt:personal`-style scope is refused);
 *  - the default target is the caller's OWN environment (created on first
 *    use); another person's is refused;
 *  - the prod-like environment is refused for every command, and the
 *    existing triggerDbtRun guard stays underneath as the backstop;
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
import { promotesProdManifest, triggerDbtRunRetry } from "./dbt-run.service";
import {
  LocalRunError,
  findOwnLocalRun,
  sliceRunLogs,
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
    authority: WAREHOUSE,
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

  // Review finding (#1013, HIGH): no scope narrower than warehouse:write
  // may run uploaded dbt code — not even against the caller's own schema.
  it("refuses a login without warehouse:write, explaining why", async () => {
    await seedProject({ joanHasEnv: true });
    const error = await refusal(
      startLocalDbtRun(input({ authority: READ_ONLY })),
    );
    expect(error).toBeInstanceOf(LocalRunError);
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/mako login --warehouse-write/);
    expect(error.message).toMatch(/warehouse credentials/);
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

  it("keeps a checkout away from prod for every command, whatever the scope", async () => {
    await seedProject({ joanHasEnv: true });
    for (const command of ["build", "run", "test"]) {
      for (const authority of [WAREHOUSE, { kind: "session" } as const]) {
        const error = await refusal(
          startLocalDbtRun(input({ environment: "prod", command, authority })),
        );
        expect(error.status).toBe(403);
        expect(error.message).toMatch(/production environment/);
      }
    }
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

// Review finding (#1013): the executor keeps the last 5000 lines; the cursor
// is an absolute line number so following survives the cap.
describe("sliceRunLogs", () => {
  const retained = ["l7000", "l7001", "l7002"]; // lines 7000..7002 of 7003

  it("returns only lines after the cursor, inside the retained window", () => {
    expect(sliceRunLogs(retained, 7003, 7001)).toEqual({
      logs: ["l7001", "l7002"],
      logCursor: 7003,
      logsSkipped: 0,
    });
    expect(sliceRunLogs(retained, 7003, 7003).logs).toEqual([]);
  });

  it("reports the gap when the cursor fell out of the window", () => {
    expect(sliceRunLogs(retained, 7003, 5000)).toEqual({
      logs: retained,
      logCursor: 7003,
      logsSkipped: 2000,
    });
  });

  it("treats runs without a counter as uncapped", () => {
    expect(sliceRunLogs(["a", "b"], undefined, 1)).toEqual({
      logs: ["b"],
      logCursor: 2,
      logsSkipped: 0,
    });
  });
});

// Review finding (#1013): a retry must rebuild the SAME uploaded tree.
describe("triggerDbtRunRetry of a laptop run", () => {
  it("carries the overlay and its label over", async () => {
    await seedProject({ joanHasEnv: true });
    const { run } = await startLocalDbtRun(input());
    await DbtRun.updateOne(
      { _id: run._id },
      {
        $set: {
          status: "error",
          "artifactKeys.runResults": "k/run_results.json",
          "artifactKeys.manifest": "k/manifest.json",
        },
      },
    );
    const retry = await triggerDbtRunRetry({
      workspaceId: WS.toString(),
      runId: run._id.toString(),
      triggeredBy: JOAN,
    });
    const stored = await DbtRun.findById(retry?._id).lean();
    expect(stored?.localOverlay).toEqual(
      (await DbtRun.findById(run._id).lean())?.localOverlay,
    );
    expect(stored?.sourceBranch).toBe("local checkout on feat/calls");
    expect(stored?.gitBranch).toBeUndefined();
  });
});

// Review finding (#1013): only committed main may become prod state.
describe("promotesProdManifest", () => {
  it("promotes a prod-environment build of main (jobs)", () => {
    expect(promotesProdManifest({}, true)).toBe(true);
    expect(promotesProdManifest({ gitBranch: "main" }, true)).toBe(true);
  });

  it("never promotes a laptop overlay, a working tree or a PR head", () => {
    expect(
      promotesProdManifest(
        { localOverlay: { key: "k", files: 1, deletes: 0 } },
        true,
      ),
    ).toBe(false);
    expect(promotesProdManifest({ workingTreeUserId: JOAN }, true)).toBe(false);
    expect(promotesProdManifest({ gitBranch: "feat/x" }, true)).toBe(false);
  });

  it("never promotes outside the prod-like environment", () => {
    expect(promotesProdManifest({}, false)).toBe(false);
  });
});
