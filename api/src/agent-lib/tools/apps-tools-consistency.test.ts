import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  project: {
    _id: { toString: () => "6a9411eb4c8b33609a65e665" },
    workspaceId: { toString: () => "6a9411eb4c8b33609a65e666" },
    slug: "sales",
    title: "Sales",
    defaultBranch: "main",
  },
}));

vi.mock("../../database/workspace-schema", () => ({
  AppProject: {
    find: vi.fn(async () => []),
    findOne: vi.fn(async () => null),
  },
}));

vi.mock("../../services/workspace.service", () => ({
  workspaceService: { getMember: vi.fn(async () => null) },
}));

vi.mock("../../utils/resource-acl", () => ({
  canReadResource: vi.fn(() => true),
  canWriteResource: vi.fn(() => true),
}));

vi.mock("../../apps/cloud-repo.service", () => ({
  freshenForServe: vi.fn(async () => state.events.push("freshen")),
}));

vi.mock("../../apps/worktree.service", () => ({
  WorktreeConflictError: class WorktreeConflictError extends Error {},
  PUBLISH_ACTOR: "publish",
  appRootFor: vi.fn(() => "apps/sales"),
  boxCtx: vi.fn(() => ({ sessionKey: "box" })),
  catchUpLiveBox: vi.fn(async () => state.events.push("catch-up")),
  commitWorktree: vi.fn(),
  createProject: vi.fn(),
  ensureWorktree: vi.fn(async () => {
    state.events.push("worktree");
    return {
      project: state.project,
      appRoot: "apps/sales",
      doc: { branch: "main" },
    };
  }),
  execInWorktree: vi.fn(),
  globFiles: vi.fn(),
  grepFiles: vi.fn(),
  listAppFolders: vi.fn(async () => {
    state.events.push("list");
    return [{ slug: "sales", title: "Sales" }];
  }),
  listBranches: vi.fn(),
  listFiles: vi.fn(),
  mergeBranchToMain: vi.fn(),
  readFile: vi.fn(),
  readSessionFile: vi.fn(),
  scopeOf: vi.fn(),
  synthesizeProjectFromFolder: vi.fn(async () => {
    state.events.push("synthesize");
    return state.project;
  }),
  worktreeStatus: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../apps/bindings.service", () => ({
  materializeAppBinding: vi.fn(async () => {
    state.events.push("materialize");
    return { rowCount: 1, byteSize: 10, materializedAt: new Date() };
  }),
}));

vi.mock("../../apps/repository.service", () => ({
  DEFAULT_BRANCH: "main",
  repoDirFor: vi.fn(() => "/repo"),
  resolveCommit: vi.fn(),
}));

vi.mock("../../apps/git", () => ({ runGit: vi.fn() }));
vi.mock("../../apps/deployment.service", () => ({
  buildLogPath: vi.fn(() => "/tmp/build.log"),
}));
vi.mock("../../apps/sandbox/provider", () => ({
  getSandboxProvider: vi.fn(() => ({ hasSession: vi.fn(async () => false) })),
}));
vi.mock("../../apps/dev-server.service", () => ({
  devConsolePath: vi.fn(),
  devLogPath: vi.fn(),
  ensureDevServer: vi.fn(),
}));
vi.mock("../../services/dashboard-artifact-store.service", () => ({
  getDashboardArtifactStore: vi.fn(),
}));
vi.mock("../../apps/eyes.service", () => ({
  browseApp: vi.fn(),
  eyesShotKey: vi.fn(),
}));
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));

import { createAppsTools } from "./apps-tools";

type Executable = {
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const tools = () =>
  createAppsTools({
    workspaceId: "6a9411eb4c8b33609a65e666",
  }) as unknown as Record<string, Executable>;

beforeEach(() => {
  state.events = [];
  vi.clearAllMocks();
});

describe("app tool repository consistency", () => {
  it("freshens the cloud mirror before listing app folders", async () => {
    const result = await tools().app_list_apps.execute({});

    expect(result.success).toBe(true);
    expect(state.events).toEqual(["freshen", "list"]);
  });

  it("freshens before resolving a folder-only app and catches up before opening", async () => {
    const result = await tools().app_open_app.execute({
      appId: "sales",
      dev: false,
    });

    expect(result.success).toBe(true);
    expect(state.events).toEqual([
      "freshen",
      "synthesize",
      "catch-up",
      "worktree",
    ]);
  });

  it("catches up a live checkout before resolving a binding", async () => {
    const result = await tools().app_materialize.execute({
      appId: "sales",
      name: "sales_data",
    });

    expect(result.success).toBe(true);
    expect(state.events).toEqual([
      "freshen",
      "synthesize",
      "catch-up",
      "materialize",
    ]);
  });
});
