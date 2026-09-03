/**
 * The workspace-scoped repo surface (RepoScope + ensureWorkspaceWorktree +
 * branch-policy): the repo reachable with NO app handle. Real bare repos
 * under a temp APPS_GIT_ROOT and mongodb-memory-server — the same rig the
 * consoles suite uses; nothing here needs a sandbox (status is exercised on
 * its offline path).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AppWorktree } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
  resolveCommit,
  updateRefCas,
} from "./repository.service";
import { ZERO_OID } from "./git";
import {
  commitBranchFor,
  defaultBranchForActor,
  sessionBranchFor,
} from "./branch-policy";
import {
  commitChanges,
  commitFileVersions,
  ensureWorkspaceWorktree,
  listBranches,
  mergeBranchToMain,
  projectHistory,
  worktreeStatus,
  workspaceScope,
} from "./worktree.service";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-repo-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const USER = "user-1";
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

async function seedRepo(): Promise<string> {
  const repoDir = repoDirFor(WS);
  await initRepo(repoDir, { "README.md": "workspace\n" });
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    {
      writes: {
        "apps/dash/mako.json": "{}\n",
        "consoles/revenue.sql": "-- connection: c1\n\nselect 1\n",
      },
    },
    { message: "seed content" },
  );
  return repoDir;
}

beforeEach(async () => {
  await AppWorktree.deleteMany({});
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await bindTestWorkspaceRepo(WS);
});

describe("ensureWorkspaceWorktree", () => {
  it("creates the per-(workspace, actor) session on the default branch, no app lens", async () => {
    await seedRepo();
    const handle = await ensureWorkspaceWorktree(WS, USER);
    expect(handle.project).toBeUndefined();
    expect(handle.appRoot).toBe("");
    expect(handle.doc.branch).toBe(DEFAULT_BRANCH);
    // Same session doc an app-scoped handle would use: keyed by workspace.
    const doc = await AppWorktree.findOne({
      workspaceId: new Types.ObjectId(WS),
      userId: USER,
    });
    expect(doc?._id.toString()).toBe(handle.doc._id.toString());
  });
});

describe("workspace-scoped reads", () => {
  it("status works offline with no app at all", async () => {
    const repoDir = await seedRepo();
    await ensureWorkspaceWorktree(WS, USER);
    const status = await worktreeStatus(workspaceScope(WS), USER);
    expect(status).not.toBeNull();
    expect(status?.branch).toBe(DEFAULT_BRANCH);
    expect(status?.offline).toBe(true);
    expect(status?.branchHead).toBe(await resolveCommit(repoDir, MAIN));
    // Repo scope: changes === repoChanges (no prefix narrowing).
    expect(status?.changes).toEqual(status?.repoChanges);
  });

  it("history at repo scope sees commits from every content kind", async () => {
    const repoDir = await seedRepo();
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: { "consoles/churn.sql": "select 2\n" } },
      { message: "add churn console" },
    );
    const commits = await projectHistory(
      workspaceScope(WS),
      20,
      undefined,
      "repo",
    );
    expect(commits.map(c => c.subject)).toContain("add churn console");
    expect(commits.map(c => c.subject)).toContain("seed content");
  });

  it("commitChanges and commitFileVersions read repo-relative paths", async () => {
    const repoDir = await seedRepo();
    const { commitOid } = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: { "consoles/revenue.sql": "select 42\n" } },
      { message: "tweak revenue" },
    );
    const changes = await commitChanges(workspaceScope(WS), commitOid!, "repo");
    expect(changes.files.map(f => f.path)).toEqual(["consoles/revenue.sql"]);
    const versions = await commitFileVersions(
      workspaceScope(WS),
      commitOid!,
      "consoles/revenue.sql",
    );
    expect(versions.after).toBe("select 42\n");
    expect(versions.before).toContain("select 1");
  });

  it("branches and merge work through the workspace scope", async () => {
    const repoDir = await seedRepo();
    const mainHead = await resolveCommit(repoDir, MAIN);
    await updateRefCas(repoDir, "refs/heads/feature", mainHead!, ZERO_OID);
    await commitBlobsOnBranch(
      repoDir,
      "feature",
      { writes: { "apps/dash/index.html": "<html/>\n" } },
      { message: "feature work" },
    );
    const branches = await listBranches(workspaceScope(WS));
    const feature = branches.find(b => b.name === "feature");
    expect(feature?.aheadOfMain).toBe(1);
    expect(branches.find(b => b.isDefault)?.name).toBe(DEFAULT_BRANCH);

    const result = await mergeBranchToMain(workspaceScope(WS), "feature");
    expect(result.merged).toBe(true);
    expect(result.fastForward).toBe(true);
    expect(await resolveCommit(repoDir, MAIN)).toBe(result.commitOid);
  });
});

describe("branch policy", () => {
  it("an actor with no session is on the default branch", async () => {
    expect(defaultBranchForActor(USER)).toBe(DEFAULT_BRANCH);
    expect(await sessionBranchFor(WS, USER)).toBe(DEFAULT_BRANCH);
  });

  it("apps follow the session branch; indexed kinds pin to the default branch", async () => {
    await AppWorktree.create({
      workspaceId: new Types.ObjectId(WS),
      userId: USER,
      branch: "feature/reports",
    });
    expect(await sessionBranchFor(WS, USER)).toBe("feature/reports");
    expect(await commitBranchFor("app", WS, USER)).toBe("feature/reports");
    // Consoles/skills are derived-index kinds: their Mongo rows mirror main,
    // so a save must not land on a branch the index never reads.
    expect(await commitBranchFor("console", WS, USER)).toBe(DEFAULT_BRANCH);
    expect(await commitBranchFor("skill", WS, USER)).toBe(DEFAULT_BRANCH);
  });
});
