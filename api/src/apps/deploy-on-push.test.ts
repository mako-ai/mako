import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  deploymentExists: true,
  readinessError: null as Error | null,
  buildOk: true,
  commitPresent: true,
  folderPresent: true,
  events: [] as string[],
  project: {
    _id: { toString: () => "6a9411eb4c8b33609a65e665" },
    workspaceId: { toString: () => "6a9411eb4c8b33609a65e666" },
    slug: "sales",
    defaultBranch: "main",
    publishedSha: "1111111111111111111111111111111111111111",
  },
}));

vi.mock("../database/workspace-schema", () => ({
  AppProject: { findOne: vi.fn(async () => state.project) },
}));

vi.mock("./cloud-repo.service", () => ({
  ensureCommitLocally: vi.fn(async () => state.events.push("ensure-commit")),
}));

vi.mock("./git", () => ({
  runGit: vi.fn(async (args: string[]) => {
    const spec = args[args.length - 1];
    if (spec.endsWith("^{commit}")) {
      if (!state.commitPresent) throw new Error("fatal: Not a valid object");
      return { stdout: "", stderr: "" };
    }
    if (spec.includes(":apps/")) {
      if (!state.folderPresent) throw new Error("fatal: path does not exist");
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }),
}));

vi.mock("./worktree.service", () => ({
  PUBLISH_ACTOR: "publish",
  checkoutInBox: vi.fn(async () => state.events.push("checkout")),
  ensureProjectRow: vi.fn(async project => project),
  ensureWorktree: vi.fn(async () => {
    state.events.push("worktree");
    return { project: state.project, appRoot: "apps/sales" };
  }),
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
    return state.buildOk
      ? { ok: true, output: "" }
      : { ok: false, output: "vite: boom" };
  }),
  clearPublishedSha: vi.fn(async () => state.events.push("unpublish")),
  deployBuild: vi.fn(async () => {
    state.events.push("deploy");
  }),
  deploymentExists: vi.fn(async () => state.deploymentExists),
  ensureDeploymentBindings: vi.fn(async () => {
    state.events.push("bindings");
    if (state.readinessError) throw state.readinessError;
  }),
  recordDeployFailure: vi.fn(async (_p, _sha, stage: string) =>
    state.events.push(`record:${stage}`),
  ),
  setPublishedSha: vi.fn(async () => state.events.push("publish")),
}));

import { deployOneApp } from "./deploy-on-push";
import {
  clearPublishedSha,
  deployBuild,
  recordDeployFailure,
  setPublishedSha,
} from "./deployment.service";
import { ensureWorktree } from "./worktree.service";

const workspaceId = "6a9411eb4c8b33609a65e666";
const sha = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";

beforeEach(() => {
  state.deploymentExists = true;
  state.readinessError = null;
  state.buildOk = true;
  state.commitPresent = true;
  state.folderPresent = true;
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
    expect(state.events).toEqual([
      "ensure-commit",
      "bindings",
      "record:bindings",
    ]);
  });

  it("records a binding failure without booting a sandbox", async () => {
    state.readinessError = new Error("connection deleted");

    await expect(deployOneApp(workspaceId, "sales", sha)).rejects.toThrow();

    // The gate reads the bare repo at `sha`; a failure must not resume the
    // publish box just to write a log line (2026-09-01 retry-storm shape).
    expect(ensureWorktree).not.toHaveBeenCalled();
    expect(recordDeployFailure).toHaveBeenCalledWith(
      state.project,
      sha,
      "bindings",
      expect.any(Error),
    );
  });

  it("checks bindings before repointing an existing code deployment", async () => {
    await expect(
      deployOneApp(workspaceId, "sales", sha),
    ).resolves.toMatchObject({ outcome: "already-built" });

    expect(state.events).toEqual(["ensure-commit", "bindings", "publish"]);
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it("gates on bindings before the build, then uploads and repoints", async () => {
    state.deploymentExists = false;

    await expect(
      deployOneApp(workspaceId, "sales", sha),
    ).resolves.toMatchObject({ outcome: "built" });

    expect(state.events).toEqual([
      "ensure-commit",
      "bindings",
      "worktree",
      "checkout",
      "build",
      "deploy",
    ]);
    expect(deployBuild).toHaveBeenCalledOnce();
  });

  it("records a failed build where app_publish_status can read it", async () => {
    state.deploymentExists = false;
    state.buildOk = false;

    await expect(deployOneApp(workspaceId, "sales", sha)).rejects.toThrow(
      "vite: boom",
    );

    expect(recordDeployFailure).toHaveBeenCalledWith(
      state.project,
      sha,
      "build",
      "vite: boom",
    );
    expect(deployBuild).not.toHaveBeenCalled();
  });
});

describe("an app whose folder left main", () => {
  it("unpublishes instead of building, so the reconcile stops re-enqueuing it", async () => {
    state.folderPresent = false;

    await expect(
      deployOneApp(workspaceId, "sales", sha),
    ).resolves.toMatchObject({ outcome: "gone" });

    expect(clearPublishedSha).toHaveBeenCalledWith(state.project);
    expect(state.events).toEqual(["ensure-commit", "unpublish"]);
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it("never mistakes a commit the mirror has not fetched for a deleted app", async () => {
    state.commitPresent = false;
    state.folderPresent = false;

    await expect(deployOneApp(workspaceId, "sales", sha)).rejects.toThrow(
      /Not a valid object/,
    );

    expect(clearPublishedSha).not.toHaveBeenCalled();
    expect(setPublishedSha).not.toHaveBeenCalled();
  });
});
