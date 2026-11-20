/**
 * Deploy-on-push, on by default (APPS_DBT_BEFORE_DEPLOY=0 rolls back): a push that changes dbt models
 * holds the changed apps that read dbt models until one dbt run ends.
 *
 * The 18 Nov 2026 shape: one push changes fct_c14__closed_loop and an app
 * binding that reads its new column. Real Mongo (DbtProject, DbtRun) and the
 * real triggerDbtRun; git, the apps index and Inngest are stubbed.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const BEFORE = "a".repeat(40);
const AFTER = "b".repeat(40);
const READER = "6a9411eb4c8b33609a65e001"; // binding reads {{ dbt_schema }}
const PLAIN = "6a9411eb4c8b33609a65e002"; // binding reads a raw table
const OTHER = "6a9411eb4c8b33609a65e003"; // reads dim_deal; outside the push by default

const state = vi.hoisted(() => ({
  changed: [] as string[],
  changedApps: [] as string[],
  otherTables: [] as string[],
  projectYml: "name: acme\n" as string | null,
  sendError: null as Error | null,
  outcome: {
    kind: "gap",
    gap: {
      models: [],
      reasons: {},
      newColumns: {},
      unfixable: {},
      unknownReads: [],
    },
  } as import("./dbt-schema-gap").GapOutcome,
  gapError: null as Error | null,
  gapCalls: [] as unknown[],
  sent: [] as Array<{ name: string; data: unknown }>,
}));

vi.mock("../inngest/client", () => ({
  inngest: {
    send: vi.fn(async (event: { name: string; data: unknown }) => {
      if (state.sendError) throw state.sendError;
      state.sent.push(event);
    }),
  },
}));

vi.mock("./dbt-schema-gap", async importOriginal => ({
  ...(await importOriginal<typeof import("./dbt-schema-gap")>()),
  detectSchemaGap: vi.fn(async (input: unknown) => {
    state.gapCalls.push(input);
    if (state.gapError) throw state.gapError;
    return state.outcome;
  }),
}));

vi.mock("../inngest/functions/apps-deploy", () => ({
  requestAppDeploys: vi.fn(async () => undefined),
}));

vi.mock("./cloud-repo.service", () => ({
  ensureCommitLocally: vi.fn(async () => true),
}));

vi.mock("./git", () => ({
  isAncestorCommit: vi.fn(async () => false),
  commitIsAncestor: vi.fn(async () => false),
  runGit: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

vi.mock("./repository.service", () => ({
  DEFAULT_BRANCH: "main",
  // Main's head is the pushed commit: deployTargetForPush returns it.
  resolveCommit: vi.fn(async () => AFTER),
  diffNameStatus: vi.fn(async () =>
    state.changed.map(path => ({ path, status: "modified" })),
  ),
  readBlob: vi.fn(async () => {
    if (state.projectYml === null) throw new Error("no such path");
    return {
      contents: state.projectYml,
      isBinary: false,
      size: state.projectYml.length,
    };
  }),
}));

vi.mock("./worktree.service", () => ({
  repoForWorkspace: vi.fn(async () => "/repo"),
}));

vi.mock("./deploy-progress", () => ({
  markDeployQueued: vi.fn(async () => undefined),
  clearDeployProgress: vi.fn(async () => undefined),
  markDeployStage: vi.fn(async () => undefined),
}));

vi.mock("./app-index.service", () => ({
  // The apps in state.changedApps changed between the two commits.
  readIndexedAppsAt: vi.fn(async (_ws: string, _dir: string, sha: string) =>
    [
      { appId: READER, path: "apps/c14" },
      { appId: PLAIN, path: "apps/raw" },
      { appId: OTHER, path: "apps/other" },
    ].map(app => ({
      ...app,
      treeOid: state.changedApps.includes(app.appId)
        ? `${sha}-${app.appId}`
        : `same-${app.appId}`,
    })),
  ),
  loadAppsIndex: vi.fn(async () => ({
    sha: AFTER,
    folders: [],
    apps: [
      {
        appId: READER,
        path: "apps/c14",
        bindingTables: [
          {
            binding: "loop",
            tables: ["{{dbt_schema}}.fct_c14__closed_loop"],
          },
        ],
      },
      {
        appId: PLAIN,
        path: "apps/raw",
        bindingTables: [{ binding: "subs", tables: ["stripe.subscriptions"] }],
      },
      {
        appId: OTHER,
        path: "apps/other",
        bindingTables: [{ binding: "deals", tables: state.otherTables }],
      },
    ],
  })),
}));

vi.mock("../dbt/dbt-working-tree.service", async importOriginal => ({
  ...(await importOriginal<typeof import("../dbt/dbt-working-tree.service")>()),
  getCheckoutBranch: vi.fn(async () => "main"),
}));

import {
  DbtProject,
  DbtRun,
  type DbtRunStatus,
} from "../database/workspace-schema";
import { requestAppDeploys } from "../inngest/functions/apps-deploy";
import { markDeployQueued } from "./deploy-progress";
import { deployAppsForPush } from "./deploy-on-push";
import {
  changesDbtBuildFiles,
  dbtBeforeDeployEnabled,
  dbtBeforeDeployMode,
  dbtModelsReadBy,
  gapBuildCommand,
  modelsSelectedBy,
  APPS_DBT_HOLD_EVENT,
  planDbtBeforeDeploy,
  resolveDbtBeforeDeploy,
  settleDbtBeforeDeploy,
  type AppsDbtHoldEventData,
  preDeployBuildCommand,
  releaseDeploysAfterRun,
} from "./dbt-before-deploy";
import { parseDbtCommand } from "../dbt/commands";

let mongo: MongoMemoryServer;
const workspaceId = new Types.ObjectId();
const ws = workspaceId.toString();
let projectId: Types.ObjectId;

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
  state.changed = [
    "dbt/models/marts/fct_c14__closed_loop.sql",
    "apps/c14/bindings/loop.sql",
  ];
  state.changedApps = [READER, PLAIN];
  state.otherTables = ["`p.{{dbt_schema}}.dim_deal`"];
  state.projectYml = "name: acme\n";
  state.sendError = null;
  state.sent = [];
  state.outcome = {
    kind: "gap",
    gap: {
      models: [],
      reasons: {},
      newColumns: {},
      unfixable: {},
      unknownReads: [],
    },
  };
  state.gapError = null;
  state.gapCalls = [];
  // The default: unset means on. The suites below run `full` (today's
  // rollback mode) unless they say otherwise; "schema-gap" has its own suite.
  delete process.env.APPS_DBT_BEFORE_DEPLOY;
  process.env.APPS_DBT_BEFORE_DEPLOY_MODE = "full";
  await DbtRun.deleteMany({});
  await DbtProject.deleteMany({});
  projectId = new Types.ObjectId();
  await DbtProject.collection.insertOne({
    _id: projectId,
    workspaceId,
    name: "acme",
    environments: [
      { name: "dev", targetSchema: "dbt_dev" },
      {
        name: "prod",
        targetSchema: "dbt_prod",
        connectionId: new Types.ObjectId(),
      },
    ],
    defaultEnvironment: "dev",
    lastProdManifestKey: "dbt-artifacts/w/r/manifest.json",
  });
});

afterEach(() => {
  delete process.env.APPS_DBT_BEFORE_DEPLOY;
  delete process.env.APPS_DBT_BEFORE_DEPLOY_MODE;
});

const push = () =>
  deployAppsForPush({
    workspaceId: ws,
    repoDir: "/repo",
    before: BEFORE,
    after: AFTER,
  });

describe("deployAppsForPush without a dbt build", () => {
  it("deploys every changed app at once when no dbt model changed", async () => {
    state.changed = ["apps/c14/bindings/loop.sql", "dbt/macros/x.sql"];

    expect((await push()).sort()).toEqual([READER, PLAIN].sort());

    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(requestAppDeploys).toHaveBeenCalledWith(
      ws,
      [READER, PLAIN],
      AFTER,
      "push",
    );
    expect(await DbtRun.countDocuments()).toBe(0);
    expect(state.sent).toEqual([]);
  });

  it("deploys every changed app at once when rolled back with 0", async () => {
    process.env.APPS_DBT_BEFORE_DEPLOY = "0";

    await push();

    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(requestAppDeploys).toHaveBeenCalledWith(
      ws,
      [READER, PLAIN],
      AFTER,
      "push",
    );
    expect(await DbtRun.countDocuments()).toBe(0);
  });

  it("deploys every changed app at once when prod has no manifest yet", async () => {
    await DbtProject.updateOne(
      { _id: projectId },
      { $unset: { lastProdManifestKey: 1 } },
    );

    await push();

    expect(requestAppDeploys).toHaveBeenCalledWith(
      ws,
      [READER, PLAIN],
      AFTER,
      "push",
    );
    expect(await DbtRun.countDocuments()).toBe(0);
  });

  it("deploys every changed app at once on a push it cannot diff", async () => {
    await deployAppsForPush({
      workspaceId: ws,
      repoDir: "/repo",
      before: "0".repeat(40),
      after: AFTER,
    });

    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(await DbtRun.countDocuments()).toBe(0);
  });
});

describe("deployAppsForPush with a dbt change, mode full", () => {
  it("deploys the plain app now and holds the reader for one prod build", async () => {
    expect((await push()).sort()).toEqual([READER, PLAIN].sort());

    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [PLAIN], AFTER, "push");
    expect(markDeployQueued).toHaveBeenCalledWith(READER, AFTER);

    const runs = await DbtRun.find().lean();
    expect(runs).toHaveLength(1);
    const run = runs[0];
    // OTHER reads dim_deal but is not in the push: dim_deal stays out.
    expect(run.commands).toEqual([
      "build --select state:modified+,+fct_c14__closed_loop",
    ]);
    expect(run.environment).toBe("prod");
    expect(run.trigger).toBe("schedule");
    expect(run.deferToProduction).toBe(true);
    expect(run.sourceSha).toBe(AFTER);
    expect(run.gitBranch).toBeUndefined();
    expect(run.deploysAfterRun).toEqual({
      workspaceId: ws,
      appIds: [READER],
      sha: AFTER,
    });
    expect(state.sent).toEqual([
      expect.objectContaining({
        name: "dbt/run.requested",
        data: expect.objectContaining({ runId: run._id.toString() }),
      }),
    ]);
  });

  it("reads custom model-paths from dbt_project.yml", async () => {
    state.projectYml = 'name: acme\nmodel-paths: ["transform"]\n';
    state.changed = ["dbt/transform/fct_c14__closed_loop.sql"];

    await push();

    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [PLAIN], AFTER, "push");
    expect(await DbtRun.countDocuments()).toBe(1);
  });

  it("returns at once and leaves the held deploys to the run's end", async () => {
    // Event-driven: nothing waits on the runner. The run stays queued (the
    // executor is not here), and the reader is still not requested.
    await push();

    const run = await DbtRun.findOne().lean();
    expect(run?.status).toBe("queued");
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(requestAppDeploys).not.toHaveBeenCalledWith(
      ws,
      expect.arrayContaining([READER]),
      expect.anything(),
      expect.anything(),
    );
  });

  it("starts one build per pushed commit; a second delivery joins it", async () => {
    await push();
    await push();

    expect(await DbtRun.countDocuments()).toBe(1);
    expect(state.sent).toHaveLength(1);
    const run = await DbtRun.findOne().lean();
    expect(run?.deploysAfterRun?.appIds).toEqual([READER]);
    // Only the plain app was requested, once per delivery.
    expect(requestAppDeploys).toHaveBeenCalledTimes(2);
    expect(requestAppDeploys).toHaveBeenNthCalledWith(
      2,
      ws,
      [PLAIN],
      AFTER,
      "push",
    );
  });

  it("selects only the models the held apps read", async () => {
    const plan = async (appIds: string[]) => {
      const prep = await planDbtBeforeDeploy({
        workspaceId: ws,
        repoDir: "/repo",
        before: BEFORE,
        after: AFTER,
        appIds,
      });
      expect(prep).not.toBeNull();
      return resolveDbtBeforeDeploy(prep as NonNullable<typeof prep>, {
        workspaceId: ws,
        sha: AFTER,
      });
    };
    const first = await plan([READER, PLAIN]);
    expect(first?.held).toEqual([READER]);
    expect(first?.now).toEqual([PLAIN]);
    expect(first?.models).toEqual(["fct_c14__closed_loop"]);

    // OTHER in the push: its model joins, sorted and once each.
    state.otherTables = [
      "`p.{{dbt_schema}}.dim_deal`",
      "{{dbt_schema}}.fct_c14__closed_loop",
    ];
    const both = await plan([OTHER, READER]);
    expect(both?.held).toEqual([OTHER, READER]);
    expect(both?.models).toEqual(["dim_deal", "fct_c14__closed_loop"]);
  });

  it("joins a running build of this commit that already selects its models", async () => {
    state.otherTables = ["{{dbt_schema}}.fct_c14__closed_loop"];
    await push();
    state.changedApps = [READER, PLAIN, OTHER];

    await push();

    const runs = await DbtRun.find().lean();
    expect(runs).toHaveLength(1);
    expect(runs[0].deploysAfterRun?.appIds).toEqual([READER, OTHER]);
    expect(state.sent).toHaveLength(1);
  });

  it("starts a second build when a joiner reads a model the first one skips", async () => {
    await push();
    state.changedApps = [READER, PLAIN, OTHER];

    await push();

    const runs = await DbtRun.find().sort({ createdAt: 1 }).lean();
    expect(runs).toHaveLength(2);
    expect(runs[0].commands).toEqual([
      "build --select state:modified+,+fct_c14__closed_loop",
    ]);
    expect(runs[0].deploysAfterRun?.appIds).toEqual([READER]);
    expect(runs[1].commands).toEqual([
      "build --select state:modified+,+dim_deal state:modified+,+fct_c14__closed_loop",
    ]);
    expect(runs[1].deploysAfterRun?.appIds).toEqual([READER, OTHER]);
    expect(requestAppDeploys).not.toHaveBeenCalledWith(
      ws,
      expect.arrayContaining([OTHER]),
      expect.anything(),
      expect.anything(),
    );
  });

  it("deploys at once when this commit's build already finished", async () => {
    await push();
    await DbtRun.updateMany({}, { $set: { status: "success" } });
    const finished = await DbtRun.findOne().lean();
    if (!finished) throw new Error("no run");
    await releaseDeploysAfterRun(finished._id);
    vi.mocked(requestAppDeploys).mockClear();

    await push();

    expect(await DbtRun.countDocuments()).toBe(1);
    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [PLAIN], AFTER, "push");
    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [READER], AFTER, "push");
  });

  it("deploys the held apps at once when the run cannot be started", async () => {
    state.sendError = new Error("inngest unavailable");

    await push();

    expect(requestAppDeploys).toHaveBeenCalledTimes(2);
    expect(requestAppDeploys).toHaveBeenNthCalledWith(
      1,
      ws,
      [PLAIN],
      AFTER,
      "push",
    );
    expect(requestAppDeploys).toHaveBeenNthCalledWith(
      2,
      ws,
      [READER],
      AFTER,
      "push",
    );
    const run = await DbtRun.findOne().lean();
    expect(run?.status).toBe("error");
  });
});

describe("deployAppsForPush in schema-gap mode (the default)", () => {
  beforeEach(() => {
    delete process.env.APPS_DBT_BEFORE_DEPLOY_MODE;
  });

  const holdEvents = () =>
    state.sent.filter(e => e.name === APPS_DBT_HOLD_EVENT);
  /** What the Inngest function does with the event the push sent. */
  const settle = async () => {
    const event = holdEvents().at(-1);
    if (!event) throw new Error("no dbt-hold event was sent");
    return settleDbtBeforeDeploy(event.data as AppsDbtHoldEventData);
  };
  const gap = (...models: string[]) => {
    state.outcome = {
      kind: "gap",
      gap: {
        models,
        reasons: {},
        newColumns: {},
        unfixable: {},
        unknownReads: [],
      },
    };
  };

  it("requests the apps that read no dbt model before any check, and queues the readers", async () => {
    expect((await push()).sort()).toEqual([READER, PLAIN].sort());

    // Nothing compiled yet: the plain app is already on its way.
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [PLAIN], AFTER, "push");
    expect(markDeployQueued).toHaveBeenCalledWith(READER, AFTER);
    expect(state.gapCalls).toEqual([]);
    expect(await DbtRun.countDocuments()).toBe(0);
    expect(holdEvents()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: ws,
          sha: AFTER,
          after: AFTER,
          prep: expect.objectContaining({
            mode: "schema-gap",
            environment: "prod",
            readers: [READER],
            now: [PLAIN],
            readsByApp: { [READER]: ["fct_c14__closed_loop"] },
          }),
        }),
      }),
    ]);
  });

  it("runs no build and deploys the reader at once when no model has a gap", async () => {
    gap();
    await push();

    expect(await settle()).toEqual({ held: [] });

    expect(requestAppDeploys).toHaveBeenLastCalledWith(
      ws,
      [READER],
      AFTER,
      "push",
    );
    expect(await DbtRun.countDocuments()).toBe(0);
    expect(state.gapCalls).toEqual([
      expect.objectContaining({
        workspaceId: ws,
        environment: "prod",
        sha: AFTER,
        reads: ["fct_c14__closed_loop"],
        changedPaths: state.changed,
      }),
    ]);
  });

  it("builds exactly the gap models and holds only the apps that read one", async () => {
    gap("fct_c14__closed_loop");
    await push();
    await settle();

    const runs = await DbtRun.find().lean();
    expect(runs).toHaveLength(1);
    expect(runs[0].commands).toEqual(["build --select fct_c14__closed_loop"]);
    expect(runs[0].deploysAfterRun).toEqual({
      workspaceId: ws,
      appIds: [READER],
      sha: AFTER,
    });
    expect(parseDbtCommand(runs[0].commands[0]).subcommand).toBe("build");
    // Only the plain app was requested.
    expect(requestAppDeploys).toHaveBeenCalledTimes(1);
  });

  it("builds a gap parent with the model and still holds only the reader", async () => {
    gap("fct_c14__closed_loop", "int_c14__loop_base");
    await push();
    await settle();

    const runs = await DbtRun.find().lean();
    expect(runs[0].commands).toEqual([
      "build --select fct_c14__closed_loop int_c14__loop_base",
    ]);
    expect(runs[0].deploysAfterRun?.appIds).toEqual([READER]);
  });

  it("deploys a reader at once when its models have no gap but another app's do", async () => {
    state.changedApps = [READER, OTHER];
    state.otherTables = ["`p.{{dbt_schema}}.dim_deal`"];
    gap("fct_c14__closed_loop");
    await push();
    await settle();

    expect(requestAppDeploys).toHaveBeenCalledWith(ws, [OTHER], AFTER, "push");
    const runs = await DbtRun.find().lean();
    expect(runs[0].commands).toEqual(["build --select fct_c14__closed_loop"]);
    expect(runs[0].deploysAfterRun?.appIds).toEqual([READER]);
  });

  it("matches a gap model to a binding's table name without case", async () => {
    gap("Fct_C14__Closed_Loop");
    await push();
    await settle();

    const runs = await DbtRun.find().lean();
    expect(runs[0].commands).toEqual(["build --select Fct_C14__Closed_Loop"]);
    expect(runs[0].deploysAfterRun?.appIds).toEqual([READER]);
  });

  it("needs no prod manifest: the gap comes from the warehouse", async () => {
    await DbtProject.updateOne(
      { _id: projectId },
      { $unset: { lastProdManifestKey: 1 } },
    );
    gap("fct_c14__closed_loop");
    await push();
    await settle();

    expect(await DbtRun.countDocuments()).toBe(1);
  });

  it("deploys the readers at once when the pushed commit does not compile", async () => {
    state.gapError = Object.assign(new Error("dbt compile failed (exit 2)"), {
      name: "DbtCompileError",
    });
    await push();
    await settle();

    expect(requestAppDeploys).toHaveBeenLastCalledWith(
      ws,
      [READER],
      AFTER,
      "push",
    );
    expect(await DbtRun.countDocuments()).toBe(0);
  });

  it("builds the changed read models directly and holds when the warehouse side fails", async () => {
    state.outcome = {
      kind: "fallback",
      models: ["fct_c14__closed_loop"],
      error: "denied",
    };
    await push();
    await settle();

    const runs = await DbtRun.find().lean();
    expect(runs[0].commands).toEqual(["build --select fct_c14__closed_loop"]);
    expect(runs[0].deploysAfterRun?.appIds).toEqual([READER]);
  });

  it("deploys at once when the fallback finds no changed read model", async () => {
    state.outcome = { kind: "fallback", models: [], error: "denied" };
    await push();
    await settle();

    expect(await DbtRun.countDocuments()).toBe(0);
    expect(requestAppDeploys).toHaveBeenLastCalledWith(
      ws,
      [READER],
      AFTER,
      "push",
    );
  });

  it("keeps the full build for an environment without a BigQuery connection", async () => {
    state.outcome = { kind: "full" };
    await push();
    await settle();

    const runs = await DbtRun.find().lean();
    expect(runs[0].commands).toEqual([
      "build --select state:modified+,+fct_c14__closed_loop",
    ]);
  });

  it("deploys at once when the full fallback has no prod manifest", async () => {
    await DbtProject.updateOne(
      { _id: projectId },
      { $unset: { lastProdManifestKey: 1 } },
    );
    state.outcome = { kind: "full" };
    await push();
    await settle();

    expect(await DbtRun.countDocuments()).toBe(0);
    expect(requestAppDeploys).toHaveBeenLastCalledWith(
      ws,
      [READER],
      AFTER,
      "push",
    );
  });

  it("deploys the readers at once when the check cannot be queued", async () => {
    state.sendError = new Error("inngest down");
    await push();

    expect(requestAppDeploys).toHaveBeenLastCalledWith(
      ws,
      [READER],
      AFTER,
      "push",
    );
    expect(await DbtRun.countDocuments()).toBe(0);
  });

  it("skips the check when the push touches no dbt file", async () => {
    state.changed = ["apps/c14/bindings/loop.sql"];
    await push();

    expect(holdEvents()).toEqual([]);
    expect(state.gapCalls).toEqual([]);
    expect(requestAppDeploys).toHaveBeenCalledWith(
      ws,
      [READER, PLAIN],
      AFTER,
      "push",
    );
  });

  it("joins a running gap build that already names the joiner's gap models", async () => {
    state.otherTables = ["{{dbt_schema}}.fct_c14__closed_loop"];
    gap("fct_c14__closed_loop");
    await push();
    await settle();
    state.changedApps = [READER, PLAIN, OTHER];
    await push();
    await settle();

    const runs = await DbtRun.find().lean();
    expect(runs).toHaveLength(1);
    expect(runs[0].deploysAfterRun?.appIds).toEqual([READER, OTHER]);
  });

  it("starts a second build when a joiner needs a gap model the first run skips", async () => {
    gap("fct_c14__closed_loop");
    await push();
    await settle();
    state.changedApps = [READER, PLAIN, OTHER];
    gap("fct_c14__closed_loop", "dim_deal");
    await push();
    await settle();

    const runs = await DbtRun.find().sort({ createdAt: 1 }).lean();
    expect(runs).toHaveLength(2);
    expect(runs[1].commands).toEqual([
      "build --select dim_deal fct_c14__closed_loop",
    ]);
  });

  it("mode full still builds every changed model upstream of the held apps, with no check", async () => {
    process.env.APPS_DBT_BEFORE_DEPLOY_MODE = "full";

    await push();

    expect(holdEvents()).toEqual([]);
    expect(state.gapCalls).toEqual([]);
    const runs = await DbtRun.find().lean();
    expect(runs[0].commands).toEqual([
      "build --select state:modified+,+fct_c14__closed_loop",
    ]);
  });
});

describe("releaseDeploysAfterRun", () => {
  const heldRun = async (status: DbtRunStatus) =>
    DbtRun.create({
      workspaceId,
      projectId,
      environment: "prod",
      commands: ["build --select state:modified+,+fct_c14__closed_loop"],
      status,
      trigger: "schedule",
      triggeredBy: "apps-deploy-on-push",
      deploysAfterRun: { workspaceId: ws, appIds: [READER], sha: AFTER },
    });

  for (const status of ["success", "error", "cancelled"] as const) {
    it(`requests the held deploys once after a run ends in ${status}`, async () => {
      const run = await heldRun(status);

      // Executor, cancel finalizer and sweeper may all get here.
      await releaseDeploysAfterRun(run._id);
      await releaseDeploysAfterRun(run._id.toString());
      await releaseDeploysAfterRun(run._id);

      expect(requestAppDeploys).toHaveBeenCalledTimes(1);
      expect(requestAppDeploys).toHaveBeenCalledWith(
        ws,
        [READER],
        AFTER,
        "push",
      );
      const stored = await DbtRun.findById(run._id).lean();
      expect(stored?.deploysAfterRun?.releasedAt).toBeInstanceOf(Date);
    });
  }

  it("holds the deploys while the run is still going", async () => {
    const run = await heldRun("running");

    expect(await releaseDeploysAfterRun(run._id)).toEqual([]);
    expect(requestAppDeploys).not.toHaveBeenCalled();
  });

  it("does nothing for a run that holds no deploys", async () => {
    const run = await DbtRun.create({
      workspaceId,
      projectId,
      environment: "prod",
      commands: ["build"],
      status: "success",
      trigger: "schedule",
      triggeredBy: "scheduler",
    });

    expect(await releaseDeploysAfterRun(run._id)).toEqual([]);
    expect(requestAppDeploys).not.toHaveBeenCalled();
  });

  it("unclaims the release when the deploy request fails", async () => {
    vi.mocked(requestAppDeploys).mockRejectedValueOnce(new Error("down"));
    const run = await heldRun("success");

    expect(await releaseDeploysAfterRun(run._id)).toEqual([]);
    const stored = await DbtRun.findById(run._id).lean();
    expect(stored?.deploysAfterRun?.releasedAt).toBeUndefined();

    expect(await releaseDeploysAfterRun(run._id)).toEqual([READER]);
    expect(requestAppDeploys).toHaveBeenCalledTimes(2);
  });
});

describe("pieces", () => {
  it("is on by default; only 0 or false rolls it back", () => {
    expect(dbtBeforeDeployEnabled({})).toBe(true);
    expect(dbtBeforeDeployEnabled({ APPS_DBT_BEFORE_DEPLOY: "" })).toBe(true);
    expect(dbtBeforeDeployEnabled({ APPS_DBT_BEFORE_DEPLOY: "1" })).toBe(true);
    expect(dbtBeforeDeployEnabled({ APPS_DBT_BEFORE_DEPLOY: "yes" })).toBe(
      true,
    );
    expect(dbtBeforeDeployEnabled({ APPS_DBT_BEFORE_DEPLOY: "0" })).toBe(false);
    expect(dbtBeforeDeployEnabled({ APPS_DBT_BEFORE_DEPLOY: "false" })).toBe(
      false,
    );
    expect(dbtBeforeDeployEnabled({ APPS_DBT_BEFORE_DEPLOY: " FALSE " })).toBe(
      false,
    );
  });

  it("defaults to schema-gap; only full is the rollback mode", () => {
    expect(dbtBeforeDeployMode({})).toBe("schema-gap");
    expect(dbtBeforeDeployMode({ APPS_DBT_BEFORE_DEPLOY_MODE: "" })).toBe(
      "schema-gap",
    );
    expect(dbtBeforeDeployMode({ APPS_DBT_BEFORE_DEPLOY_MODE: "bogus" })).toBe(
      "schema-gap",
    );
    expect(dbtBeforeDeployMode({ APPS_DBT_BEFORE_DEPLOY_MODE: " FULL " })).toBe(
      "full",
    );
  });

  it("writes a gap command with no `+` and no state:modified", () => {
    const command = gapBuildCommand(["fct_b", "fct_a", "fct_b"]);
    expect(command).toBe("build --select fct_a fct_b");
    expect(command).not.toMatch(/[+]|state:/);
    expect(parseDbtCommand(command).argv).toEqual([
      "build",
      "--select",
      "fct_a",
      "fct_b",
    ]);
    expect([...modelsSelectedBy(command)]).toEqual(["fct_a", "fct_b"]);
  });

  it("counts models, seeds and snapshots, never macros or tests", () => {
    const yml = "name: a\n";
    expect(changesDbtBuildFiles(["dbt/seeds/x.csv"], yml)).toBe(true);
    expect(changesDbtBuildFiles(["dbt/snapshots/s.sql"], yml)).toBe(true);
    expect(changesDbtBuildFiles(["dbt/macros/m.sql"], yml)).toBe(false);
    expect(changesDbtBuildFiles(["dbt/tests/t.sql"], yml)).toBe(false);
    expect(changesDbtBuildFiles(["models/x.sql"], yml)).toBe(false);
  });

  it("lists the dbt models an app's bindings read, once each", () => {
    expect(
      dbtModelsReadBy({
        bindingTables: [
          { binding: "a", tables: ["{{dbt_schema}}.fct_x", "raw.t"] },
          { binding: "b", tables: ["`p.{{dbt_schema}}.fct_x`"] },
        ],
      }),
    ).toEqual(["fct_x"]);
    expect(dbtModelsReadBy({})).toEqual([]);
  });

  it("writes a command the dbt command parser accepts", () => {
    const command = preDeployBuildCommand(["fct_b", "fct_a", "fct_b"]);
    expect(command).toBe(
      "build --select state:modified+,+fct_a state:modified+,+fct_b",
    );
    expect(parseDbtCommand(command).subcommand).toBe("build");
    expect([...modelsSelectedBy(command)]).toEqual(["fct_a", "fct_b"]);
    expect(modelsSelectedBy(undefined).size).toBe(0);
  });
});
