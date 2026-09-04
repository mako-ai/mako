import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  deploymentExists: true,
  readinessError: null as Error | null,
  events: [] as string[],
  project: {
    _id: { toString: () => "6a9411eb4c8b33609a65e665" },
    workspaceId: { toString: () => "6a9411eb4c8b33609a65e666" },
    slug: "sales",
    defaultBranch: "main",
  },
}));

vi.mock("../database/workspace-schema", () => ({
  AppProject: { findOne: vi.fn(async () => state.project) },
}));

vi.mock("./cloud-repo.service", () => ({
  freshenForServe: vi.fn(async () => state.events.push("freshen")),
}));

vi.mock("./worktree.service", () => ({
  PUBLISH_ACTOR: "publish",
  checkoutInBox: vi.fn(async () => state.events.push("checkout")),
  ensureProjectRow: vi.fn(async project => project),
  ensureWorktree: vi.fn(async () => ({
    project: state.project,
    appRoot: "apps/sales",
  })),
  execInWorktree: vi.fn(async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  })),
  listAppFolders: vi.fn(async () => []),
  repoForWorkspace: vi.fn(async () => "/repo"),
  synthesizeProjectFromFolder: vi.fn(async () => null),
}));

vi.mock("./deployment.service", () => ({
  buildApp: vi.fn(async () => {
    state.events.push("build");
    return { ok: true, output: "" };
  }),
  buildLogPath: vi.fn(() => "/tmp/build.log"),
  deployBuild: vi.fn(async () => {
    state.events.push("deploy");
  }),
  deploymentExists: vi.fn(async () => state.deploymentExists),
  ensureDeploymentBindings: vi.fn(async () => {
    state.events.push("bindings");
    if (state.readinessError) throw state.readinessError;
  }),
  setPublishedSha: vi.fn(async () => state.events.push("publish")),
}));

import { deployOneApp } from "./deploy-on-push";
import { deployBuild, setPublishedSha } from "./deployment.service";

const workspaceId = "6a9411eb4c8b33609a65e666";
const sha = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";

beforeEach(() => {
  state.deploymentExists = true;
  state.readinessError = null;
  state.events = [];
  vi.clearAllMocks();
});

describe("atomic app deployment", () => {
  it("does not repoint an existing code deployment when binding readiness fails", async () => {
    state.readinessError = new Error("binding query failed");

    await expect(deployOneApp(workspaceId, "sales", sha)).rejects.toThrow(
      "binding query failed",
    );

    expect(setPublishedSha).not.toHaveBeenCalled();
    expect(state.events).toEqual(["freshen", "bindings"]);
  });

  it("checks bindings before repointing an existing code deployment", async () => {
    await expect(
      deployOneApp(workspaceId, "sales", sha),
    ).resolves.toMatchObject({ outcome: "already-built" });

    expect(state.events).toEqual(["freshen", "bindings", "publish"]);
  });

  it("checks bindings after a successful build and before upload/repoint", async () => {
    state.deploymentExists = false;

    await expect(
      deployOneApp(workspaceId, "sales", sha),
    ).resolves.toMatchObject({ outcome: "built" });

    expect(state.events).toEqual([
      "freshen",
      "checkout",
      "build",
      "bindings",
      "deploy",
    ]);
    expect(deployBuild).toHaveBeenCalledOnce();
  });
});
