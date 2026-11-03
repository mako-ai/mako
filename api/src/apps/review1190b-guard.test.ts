/**
 * Second review of PR #1190: fail-closed blocking, on real git.
 * Everything except git and the guard is mocked.
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
  fetchFrom: null as string | null,
  mainHead: null as string | null,
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
  // What the real one does: fetch main from the mirror, swallow a failure.
  ensureCommitLocally: vi.fn(async () => {
    if (!state.fetchFrom) return;
    const { execFileSync: run } = await import("node:child_process");
    run("git", ["-C", state.repoDir, "fetch", "-q", state.fetchFrom, "main"]);
  }),
}));
vi.mock("./repository.service", () => ({
  DEFAULT_BRANCH: "main",
  resolveCommit: vi.fn(async () => state.mainHead),
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
  buildApp: vi.fn(async () => ({ ok: true, output: "" })),
  clearPublishedSha: vi.fn(),
  deployBuild: vi.fn(async () => ({ repointed: true })),
  deploymentExists: vi.fn(async () => true),
  ensureDeploymentBindings: vi.fn(async () => ({ refreshing: [] })),
  recordDeployFailure: vi.fn(),
  setPublishedSha: vi.fn(async () => true),
}));
vi.mock("./deploy-progress", () => ({
  markDeployStage: vi.fn(async () => undefined),
  clearDeployProgress: vi.fn(async () => undefined),
}));

import { deployOneApp } from "./deploy-on-push";
import { setPublishedSha } from "./deployment.service";
import { ensureCommitLocally } from "./cloud-repo.service";

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

let root: string, mirror: string, instance: string;
let base: string, kept: string, rewrittenAway: string;

async function commit(dir: string, name: string): Promise<string> {
  await fs.mkdir(path.join(dir, "apps/sales"), { recursive: true });
  await fs.writeFile(path.join(dir, "apps/sales", name), name);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "review1190b-"));
  mirror = path.join(root, "mirror");
  await fs.mkdir(mirror);
  git(mirror, "init", "-q", "-b", "main");
  base = await commit(mirror, "a");
  // Published, then force-pushed away: reachable from no ref on the mirror.
  rewrittenAway = await commit(mirror, "b");
  git(mirror, "reset", "-q", "--hard", base);
  kept = await commit(mirror, "c");
  git(mirror, "reflog", "expire", "--expire=now", "--all");
  git(mirror, "gc", "-q", "--prune=now");
  // A fresh instance: restored from the mirror after the force-push.
  instance = path.join(root, "instance");
  execFileSync("git", ["clone", "-q", mirror, instance]);
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  state.repoDir = instance;
  state.fetchFrom = mirror;
  state.mainHead = kept;
  state.project.publishedSha = base;
});

describe("fail-closed: an older commit stays refused", () => {
  it("an older sha with an unplaceable live commit throws, so nothing goes live", async () => {
    state.project.publishedSha = "d".repeat(40);
    await expect(deployOneApp("w", "sales", base)).rejects.toThrow();
    expect(setPublishedSha).not.toHaveBeenCalled();
  });

  it("main's head with a failed fetch throws: head proves nothing on a stale instance", async () => {
    state.project.publishedSha = "d".repeat(40);
    vi.mocked(ensureCommitLocally)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce(false as never);
    await expect(deployOneApp("w", "sales", kept)).rejects.toThrow();
    expect(setPublishedSha).not.toHaveBeenCalled();
  });
});

describe("fail-closed: a healthy app must keep deploying", () => {
  it("SETUP: the rewritten commit really is gone from the fresh instance", () => {
    expect(() =>
      git(instance, "cat-file", "-e", `${rewrittenAway}^{commit}`),
    ).toThrow();
    expect(() =>
      git(mirror, "cat-file", "-e", `${rewrittenAway}^{commit}`),
    ).toThrow();
  });

  it("DEFECT: a push of main's head deploys after publishedSha was force-pushed away", async () => {
    state.project.publishedSha = rewrittenAway;
    const result = await deployOneApp("w", "sales", kept);
    expect(result.outcome).toBe("already-built");
    expect(setPublishedSha).toHaveBeenCalled();
  });

  it("DEFECT: a publishedSha from a previous repo (rebound workspace) does not block forever", async () => {
    state.project.publishedSha = "d".repeat(40);
    // Three pushes, three attempts each is the same answer every time.
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(deployOneApp("w", "sales", kept)).resolves.toMatchObject({
        sha: kept,
      });
    }
  });

  it("HELD: a live commit on a diverged line, still present here, does not block", async () => {
    const line = path.join(root, `line-${Date.now()}`);
    execFileSync("git", ["clone", "-q", mirror, line]);
    git(line, "reset", "-q", "--hard", base);
    const sibling = await commit(line, "sibling");
    git(instance, "fetch", "-q", line, "main");
    state.project.publishedSha = sibling;
    const result = await deployOneApp("w", "sales", kept);
    expect(result.outcome).toBe("already-built");
    expect(setPublishedSha).toHaveBeenCalledWith(
      state.project,
      kept,
      expect.objectContaining({ expected: sibling }),
    );
  });

  it("HELD: a commit missing here but on the mirror is fetched, then judged", async () => {
    const stale = path.join(root, `stale-${Date.now()}`);
    await fs.mkdir(stale);
    git(stale, "init", "-q", "-b", "main");
    git(stale, "fetch", "-q", mirror, base);
    git(stale, "update-ref", "refs/heads/main", base);
    state.repoDir = stale;
    state.project.publishedSha = kept; // newer, on the mirror, not here
    const result = await deployOneApp("w", "sales", base);
    expect(result.outcome).toBe("superseded");
    expect(setPublishedSha).not.toHaveBeenCalled();
  });
});
