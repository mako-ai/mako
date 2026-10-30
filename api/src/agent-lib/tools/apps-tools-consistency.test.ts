import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  role: null as string | null,
  canWrite: true,
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
  workspaceService: {
    getMember: vi.fn(async () => (state.role ? { role: state.role } : null)),
  },
}));

vi.mock("../../utils/resource-acl", () => ({
  canReadResource: vi.fn(() => true),
  canWriteResource: vi.fn(() => state.canWrite),
}));

vi.mock("../../inngest/functions/apps-deploy", () => ({
  requestAppDeploys: vi.fn(async (_ws: string, ids: string[], sha: string) => {
    state.events.push(`deploy:${ids.join(",")}@${sha}`);
  }),
}));

vi.mock("../../apps/cloud-repo.service", () => ({
  freshenForServe: vi.fn(async () => state.events.push("freshen")),
  ensureCommitLocally: vi.fn(),
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
    return [
      {
        id: "6a9411eb4c8b33609a65e665",
        slug: "sales",
        path: "apps/sales",
        scope: "workspace",
        title: "Sales",
      },
    ];
  }),
  listAppFolderPaths: vi.fn(async () => []),
  folderTargetFromPath: vi.fn(),
  moveProject: vi.fn(),
  listBranches: vi.fn(),
  listFiles: vi.fn(),
  mergeBranchToMain: vi.fn(),
  readFile: vi.fn(),
  readSessionFile: vi.fn(),
  scopeOf: vi.fn(),
  resolveProjectRef: vi.fn(
    async (_ws: string, _ref: string, options?: { fetchOnMiss?: boolean }) => {
      state.events.push(
        options?.fetchOnMiss ? "synthesize(fetch-on-miss)" : "synthesize",
      );
      return state.project;
    },
  ),
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
  resolveCommit: vi.fn(async () => "c".repeat(40)),
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
vi.mock("../../services/artifact-store.service", () => ({
  getArtifactStore: vi.fn(),
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
  state.role = null;
  state.canWrite = true;
  vi.clearAllMocks();
});

describe("app tool repository consistency", () => {
  it("lists from the repo primitive, which freshens the mirror itself (throttled)", async () => {
    const result = await tools().app_list_apps.execute({});

    expect(result.success).toBe(true);
    // No per-call force fetch here: listAppFolders owns the throttled
    // freshen so every reader (routes, tools, connectors) shares one.
    expect(state.events).toEqual(["list"]);
  });

  it("resolves a folder-only app with fetch-on-miss and catches up before opening", async () => {
    const result = await tools().app_open_app.execute({
      appId: "sales",
      dev: false,
    });

    expect(result.success).toBe(true);
    expect(state.events).toEqual([
      "synthesize(fetch-on-miss)",
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
      "synthesize(fetch-on-miss)",
      "catch-up",
      "materialize",
    ]);
  });
});

// 2026-10-30: app_publish answered "App … not found" for an app that
// app_list_apps listed and app_publish_status read. The caller (a workspace
// member) could see the workspace app but its general access was view-only,
// and the write check reported that as "not found".
describe("app tool access", () => {
  const asMember = () =>
    createAppsTools({
      workspaceId: "6a9411eb4c8b33609a65e666",
      userId: "u2",
    }) as unknown as Record<string, Executable>;

  it("lets an editing member deploy a view-only workspace app", async () => {
    state.role = "member";
    state.canWrite = false;
    const result = await asMember().app_publish.execute({
      appId: "6a9411eb4c8b33609a65e665",
    });
    expect(result.success).toBe(true);
    expect(state.events).toContain(
      `deploy:6a9411eb4c8b33609a65e665@${"c".repeat(40)}`,
    );
  });

  it("says view-only instead of not found when a viewer tries to deploy", async () => {
    state.role = "viewer";
    state.canWrite = false;
    const result = await asMember().app_publish.execute({
      appId: "6a9411eb4c8b33609a65e665",
    });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("You can view app");
    expect(String(result.error)).not.toContain("not found");
  });
});
