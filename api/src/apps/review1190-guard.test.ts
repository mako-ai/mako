/**
 * Review of PR #1190: the repoint-past-newer guard, on REAL git.
 * Every collaborator except git is mocked.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({
  repoDir: "",
  deploymentExists: true,
  onBindings: null as null | (() => void),
  onBuild: null as null | (() => void),
  project: {
    _id: { toString: () => "6a9411eb4c8b33609a65e665" },
    workspaceId: { toString: () => "6a9411eb4c8b33609a65e666" },
    slug: "sales",
    defaultBranch: "main",
    publishedSha: "" as string,
  },
}));

vi.mock("../database/workspace-schema", () => ({ AppProject: {} }));
vi.mock("./cloud-repo.service", () => ({
  ensureCommitLocally: vi.fn(async () => undefined),
}));
vi.mock("./repository.service", () => ({
  DEFAULT_BRANCH: "main",
  resolveCommit: vi.fn(async () => null),
}));
vi.mock("./worktree.service", () => ({
  PUBLISH_ACTOR: "publish",
  appRootFor: vi.fn(() => "apps/sales"),
  checkoutInBox: vi.fn(async () => undefined),
  ensureProjectRow: vi.fn(async (p: unknown) => p),
  ensureWorktree: vi.fn(async () => ({ project: state.project })),
  execInWorktree: vi.fn(),
  repoForWorkspace: vi.fn(async () => state.repoDir),
  resolveProjectRef: vi.fn(async () => state.project),
}));
vi.mock("./app-index.service", () => ({
  loadAppsIndex: vi.fn(async () => ({ apps: [] })),
  readIndexedAppsAt: vi.fn(async () => [
    { appId: "6a9411eb4c8b33609a65e665", path: "apps/sales", treeOid: "t" },
  ]),
}));
vi.mock("./deployment.service", () => ({
  buildApp: vi.fn(async () => {
    state.onBuild?.();
    return { ok: true, output: "" };
  }),
  clearPublishedSha: vi.fn(),
  deployBuild: vi.fn(async () => undefined),
  deploymentExists: vi.fn(async () => state.deploymentExists),
  ensureDeploymentBindings: vi.fn(async () => {
    state.onBindings?.();
  }),
  recordDeployFailure: vi.fn(),
  setPublishedSha: vi.fn(async () => undefined),
}));
vi.mock("./deploy-progress", () => ({
  markDeployStage: vi.fn(async () => undefined),
  clearDeployProgress: vi.fn(async () => undefined),
}));

import { deployOneApp } from "./deploy-on-push";
import { deployBuild, setPublishedSha } from "./deployment.service";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();

let root: string;
/** The instance that has seen sha0 and sha1 only. */
let staleInstance: string;
/** The instance that has also seen sha2. */
let freshInstance: string;
let sha0: string, sha1: string, sha2: string;

async function commit(dir: string, name: string): Promise<string> {
  await fs.mkdir(path.join(dir, "apps/sales"), { recursive: true });
  await fs.writeFile(path.join(dir, "apps/sales", name), name);
  git(dir, "add", ".");
  git(dir, "commit", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "review1190-"));
  staleInstance = path.join(root, "stale");
  freshInstance = path.join(root, "fresh");
  await fs.mkdir(staleInstance);
  git(staleInstance, "init", "-q", "-b", "main");
  sha0 = await commit(staleInstance, "a");
  sha1 = await commit(staleInstance, "b");
  execFileSync("git", ["clone", "-q", staleInstance, freshInstance]);
  sha2 = await commit(freshInstance, "c");
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  state.deploymentExists = true;
  state.onBindings = null;
  state.onBuild = null;
  state.project.publishedSha = sha0;
});

describe("zombie deploy of sha1; sha2 goes live during its binding walk", () => {
  it("CONTROL: instance that has sha2 refuses to repoint", async () => {
    state.repoDir = freshInstance;
    state.onBindings = () => {
      state.project.publishedSha = sha2;
    };
    const result = await deployOneApp("w", "sales", sha1);
    expect(result.outcome).toBe("superseded");
    expect(setPublishedSha).not.toHaveBeenCalled();
  });

  it("DEFECT 1: instance that has NOT fetched sha2 must also refuse", async () => {
    state.repoDir = staleInstance;
    state.onBindings = () => {
      state.project.publishedSha = sha2;
    };
    const result = await deployOneApp("w", "sales", sha1);
    expect(result.outcome).toBe("superseded");
    expect(setPublishedSha).not.toHaveBeenCalled();
  });
});

describe("zombie deploy of sha1; sha2 goes live during its vite build", () => {
  it("DEFECT 2: the guard must hold after the build too", async () => {
    state.repoDir = freshInstance;
    state.deploymentExists = false;
    state.onBuild = () => {
      state.project.publishedSha = sha2;
    };
    const result = await deployOneApp("w", "sales", sha1);
    expect(deployBuild).not.toHaveBeenCalled();
    expect(result.outcome).toBe("superseded");
  });
});

describe("rollback during a walk", () => {
  it("DEFECT 3: a rollback to sha0 during the walk of sha2 must survive", async () => {
    state.repoDir = freshInstance;
    state.project.publishedSha = sha1;
    state.onBindings = () => {
      state.project.publishedSha = sha0; // POST /rollback landed
    };
    await deployOneApp("w", "sales", sha2);
    expect(setPublishedSha).not.toHaveBeenCalled();
  });
});
