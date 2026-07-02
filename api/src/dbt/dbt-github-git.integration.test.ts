/**
 * Per-user dbt working trees + git surface — integration tests.
 *
 * Real Mongoose persistence (mongodb-memory-server) and a REAL git remote: a
 * local bare repository stands in for GitHub (dbt-git-remote is mocked to
 * return its path), so fetch/push/branch operations run their actual git
 * transport code paths. Only the pull-request REST calls are faked.
 *
 * Verifies the collaboration model end-to-end:
 *  - drafts are per user (uncommitted edits invisible to other users)
 *  - syncs never touch drafts (overlays rebase onto the new head)
 *  - commits push drafts, advance the branch mirror, and clear drafts
 *  - protected branches refuse direct commits; commit-to-branch is the
 *    escape hatch
 *  - checkouts (branch pointers) are per user
 *  - PR merge updates the default branch and relocates stranded checkouts
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
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: vi.fn(async () => "token"),
}));

// The remote is a real local bare repo; its path is set in beforeAll.
const remotePath = vi.hoisted(() => ({ url: "" }));
vi.mock("./dbt-git-remote", () => ({
  resolveProjectRemote: vi.fn(async () => ({ url: remotePath.url })),
}));

// Fake pull-request REST surface backed by the real remote repo: "merging"
// applies the head branch's tree onto the base branch with a real commit.
const pulls = vi.hoisted(() => ({
  state: new Map<number, { headRef: string; baseRef: string; state: string }>(),
  reset() {
    this.state.clear();
  },
}));

vi.mock("../integrations/github/github-api", () => ({
  createPullRequest: vi.fn(
    async (_o: string, _r: string, params: { head: string; base: string }) => {
      const number = pulls.state.size + 1;
      pulls.state.set(number, {
        headRef: params.head,
        baseRef: params.base,
        state: "open",
      });
      return { number, htmlUrl: `https://github.com/pr/${number}` };
    },
  ),
  getPullRequest: vi.fn(async (_o: string, _r: string, prNumber: number) => {
    const pr = pulls.state.get(prNumber);
    if (!pr) throw new Error(`GitHub 404: no PR ${prNumber}`);
    return {
      number: prNumber,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      mergeable: true,
      state: pr.state,
    };
  }),
  listPullRequests: vi.fn(async () => []),
  updatePullRequest: vi.fn(),
  mergePullRequest: vi.fn(async (_o: string, _r: string, prNumber: number) => {
    const pr = pulls.state.get(prNumber);
    if (!pr) throw new Error(`GitHub 404: no PR ${prNumber}`);
    const sha = await remoteMergeBranches(pr.headRef, pr.baseRef);
    pr.state = "closed";
    return { sha };
  }),
}));

// Imported after the mocks are registered.
import {
  DbtCheckout,
  DbtProject,
  type IDbtProject,
} from "../database/workspace-schema";
import {
  commitTreeUpdate,
  ensureBareRepo,
  listTree,
  readBlobs,
  resolveCommit,
  branchRef,
  deleteRef,
} from "./dbt-git-store.service";
import { syncProjectBranchFromRepo } from "./dbt-github-sync.service";
import {
  commitAndPush,
  commitToNewBranch,
  createProjectBranch,
  deleteProjectBranch,
  getGitStatus,
  getProjectFileDiff,
  listProjectBranches,
  listRecoverableFiles,
  mergeProjectPullRequest,
  ProtectedBranchError,
  restoreDeletedFile,
  switchProjectBranch,
} from "./dbt-github-git.service";
import {
  getCheckoutBranch,
  listWorkingFiles,
  loadWorkingTreeContents,
  readWorkingFile,
  writeWorkingFile,
  deleteWorkingFile,
} from "./dbt-working-tree.service";

let mongo: MongoMemoryServer;
let gitScratch: string;
const WS = new Types.ObjectId();

const TEST_AUTHOR = { name: "tester", email: "tester@mako.dev" };

/** Commit `files` as the full tree of a remote branch (like a GitHub push). */
async function remoteSetBranch(
  branch: string,
  files: Record<string, string>,
): Promise<string> {
  const head = await resolveCommit(remotePath.url, branchRef(branch));
  const { sha } = await commitTreeUpdate(remotePath.url, {
    ref: branchRef(branch),
    parents: head ? [head] : [],
    writes: Object.entries(files).map(([p, content]) => ({
      path: p,
      content,
    })),
    // Full-tree semantics: drop files not in `files`.
    deletes: head
      ? (await listTree(remotePath.url, head))
          .map(e => e.path)
          .filter(p => !(p in files))
      : [],
    baseTree: head ?? undefined,
    message: `remote update ${branch}`,
    author: TEST_AUTHOR,
  });
  return sha;
}

async function remoteFiles(branch: string): Promise<Map<string, string>> {
  const entries = await listTree(remotePath.url, branchRef(branch));
  const blobs = await readBlobs(
    remotePath.url,
    entries.map(e => e.blobSha),
  );
  return new Map(
    entries.map(e => [e.path, blobs.get(e.blobSha) ?? ""] as const),
  );
}

async function remoteBranchExists(branch: string): Promise<boolean> {
  return (await resolveCommit(remotePath.url, branchRef(branch))) !== null;
}

/** Squash-apply `head`'s tree onto `base` (the fake GitHub merge). */
async function remoteMergeBranches(
  head: string,
  base: string,
): Promise<string> {
  const files = await remoteFiles(head);
  return remoteSetBranch(base, Object.fromEntries(files));
}

async function seedProject(
  opts: { protectedBranches?: string[] } = {},
): Promise<IDbtProject> {
  const project = await DbtProject.create({
    workspaceId: WS,
    name: `Analytics-${new Types.ObjectId().toString()}`,
    environments: [
      {
        name: "dev",
        connectionId: new Types.ObjectId(),
        targetSchema: "analytics",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
    repo: {
      provider: "github",
      owner: "acme",
      repo: "analytics",
      branch: "main",
      installationId: 123,
    },
    protectedBranches: opts.protectedBranches,
  });
  await syncProjectBranchFromRepo(project, "main", "seed");
  return project;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  gitScratch = await mkdtemp(path.join(tmpdir(), "mako-dbt-git-test-"));
  process.env.DBT_GIT_ROOT = path.join(gitScratch, "store");
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await rm(gitScratch, { recursive: true, force: true });
  delete process.env.DBT_GIT_ROOT;
});

beforeEach(async () => {
  vi.clearAllMocks();
  pulls.reset();
  // Fresh remote + fresh local store for every test.
  await rm(path.join(gitScratch, "store"), { recursive: true, force: true });
  remotePath.url = path.join(
    gitScratch,
    `remote-${new Types.ObjectId().toString()}.git`,
  );
  await ensureBareRepo(remotePath.url);
  await remoteSetBranch("main", {
    "dbt_project.yml": "name: analytics",
    "models/a.sql": "select 1",
  });
  await Promise.all([
    mongoose.connection.collection("dbt_projects").deleteMany({}),
    mongoose.connection.collection("dbt_files").deleteMany({}),
    mongoose.connection.collection("dbt_file_drafts").deleteMany({}),
    mongoose.connection.collection("dbt_checkouts").deleteMany({}),
  ]);
});

describe("per-user draft isolation", () => {
  it("uncommitted edits are only visible to their author", async () => {
    const project = await seedProject();

    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");
    await writeWorkingFile(project, "alice", "models/new.sql", "select 3");

    const aliceRead = await readWorkingFile(project, "alice", "models/a.sql");
    const bobRead = await readWorkingFile(project, "bob", "models/a.sql");
    expect(aliceRead?.content).toBe("select 2");
    expect(bobRead?.content).toBe("select 1");

    const alicePaths = (await listWorkingFiles(project, "alice")).map(
      f => f.path,
    );
    const bobPaths = (await listWorkingFiles(project, "bob")).map(f => f.path);
    expect(alicePaths).toContain("models/new.sql");
    expect(bobPaths).not.toContain("models/new.sql");

    const aliceStatus = await getGitStatus(project, "alice");
    const bobStatus = await getGitStatus(project, "bob");
    expect(aliceStatus.hasChanges).toBe(true);
    expect(aliceStatus.modified).toBe(1);
    expect(aliceStatus.added).toBe(1);
    expect(bobStatus.hasChanges).toBe(false);
  });

  it("a draft deletion hides the file for its author only", async () => {
    const project = await seedProject();
    await deleteWorkingFile(project, "alice", "models/a.sql");

    expect(await readWorkingFile(project, "alice", "models/a.sql")).toBeNull();
    expect(
      (await readWorkingFile(project, "bob", "models/a.sql"))?.content,
    ).toBe("select 1");
    const status = await getGitStatus(project, "alice");
    expect(status.deleted).toBe(1);
  });

  it("reverting a draft to the committed content clears the pending change", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");
    await writeWorkingFile(project, "alice", "models/a.sql", "select 1");
    const status = await getGitStatus(project, "alice");
    expect(status.hasChanges).toBe(false);
  });

  it("diffs compare the caller's draft against the committed base", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");
    const diff = await getProjectFileDiff(project, "alice", "models/a.sql");
    expect(diff).toMatchObject({
      status: "modified",
      base: "select 1",
      working: "select 2",
    });
  });
});

describe("sync safety", () => {
  it("a branch sync fast-forwards the mirror but never touches drafts", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");

    await remoteSetBranch("main", {
      "dbt_project.yml": "name: analytics",
      "models/a.sql": "select 10",
      "models/b.sql": "select 20",
    });
    const sync = await syncProjectBranchFromRepo(project, "main", "webhook");
    expect(sync.added).toBe(1);
    expect(sync.updated).toBe(1);

    // Bob (clean tree) sees the new committed state.
    expect(
      (await readWorkingFile(project, "bob", "models/a.sql"))?.content,
    ).toBe("select 10");
    expect(
      (await readWorkingFile(project, "bob", "models/b.sql"))?.content,
    ).toBe("select 20");
    // Alice keeps her draft overlay on top of the synced base.
    expect(
      (await readWorkingFile(project, "alice", "models/a.sql"))?.content,
    ).toBe("select 2");
    expect(
      (await readWorkingFile(project, "alice", "models/b.sql"))?.content,
    ).toBe("select 20");
  });
});

describe("commit & push (per-user)", () => {
  it("pushes the caller's drafts, advances the branch, and clears drafts", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");

    const result = await commitAndPush(project, {
      userId: "alice",
      message: "fix: bump a",
      updatedBy: "alice",
    });
    expect(result.committed).toBe(true);
    expect(result.branch).toBe("main");
    expect(result.pushed).toEqual({ added: 0, modified: 1, deleted: 0 });

    // Remote advanced.
    expect((await remoteFiles("main")).get("models/a.sql")).toBe("select 2");
    // Branch mirror advanced → every user now sees the committed content.
    expect(
      (await readWorkingFile(project, "bob", "models/a.sql"))?.content,
    ).toBe("select 2");
    // Drafts cleared → author's tree is clean.
    expect((await getGitStatus(project, "alice")).hasChanges).toBe(false);
  });

  it("commits only selected paths, leaving other drafts pending", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");
    await writeWorkingFile(project, "alice", "models/new.sql", "select 3");

    const result = await commitAndPush(project, {
      userId: "alice",
      message: "fix: only a",
      updatedBy: "alice",
      paths: ["models/a.sql"],
    });
    expect(result.pushed).toEqual({ added: 0, modified: 1, deleted: 0 });
    expect((await remoteFiles("main")).has("models/new.sql")).toBe(false);

    const status = await getGitStatus(project, "alice");
    expect(status.changes).toEqual([
      { path: "models/new.sql", status: "added" },
    ]);
    expect(
      (await readWorkingFile(project, "alice", "models/new.sql"))?.content,
    ).toBe("select 3");
  });

  it("commits a draft deletion by removing the file from the branch", async () => {
    const project = await seedProject();
    await deleteWorkingFile(project, "alice", "models/a.sql");
    const result = await commitAndPush(project, {
      userId: "alice",
      message: "chore: drop a",
      updatedBy: "alice",
    });
    expect(result.pushed.deleted).toBe(1);
    expect((await remoteFiles("main")).has("models/a.sql")).toBe(false);
    expect(await readWorkingFile(project, "bob", "models/a.sql")).toBeNull();
  });

  it("commits land on the fresh remote head when the remote advanced concurrently", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");

    // Someone pushed to the remote outside Mako after alice's last sync.
    await remoteSetBranch("main", {
      "dbt_project.yml": "name: analytics",
      "models/a.sql": "select 1",
      "models/upstream.sql": "select 99",
    });

    const result = await commitAndPush(project, {
      userId: "alice",
      message: "fix: bump a",
      updatedBy: "alice",
    });
    expect(result.committed).toBe(true);
    const files = await remoteFiles("main");
    expect(files.get("models/a.sql")).toBe("select 2");
    expect(files.get("models/upstream.sql")).toBe("select 99");
  });
});

describe("branch protection", () => {
  it("refuses a direct commit to a protected branch", async () => {
    const project = await seedProject({ protectedBranches: ["main"] });
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");

    await expect(
      commitAndPush(project, {
        userId: "alice",
        message: "fix: direct to main",
        updatedBy: "alice",
      }),
    ).rejects.toThrow(ProtectedBranchError);
    // Nothing moved: remote untouched, draft still pending.
    expect((await remoteFiles("main")).get("models/a.sql")).toBe("select 1");
    expect((await getGitStatus(project, "alice")).hasChanges).toBe(true);
  });

  it("commit-to-branch is the escape hatch: promotes drafts to a feature branch", async () => {
    const project = await seedProject({ protectedBranches: ["main"] });
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");

    const result = await commitToNewBranch(project, {
      userId: "alice",
      branchName: "feat/a",
      message: "feat: change a",
      updatedBy: "alice",
    });
    expect(result.committed).toBe(true);
    expect(result.fromBranch).toBe("main");
    expect(result.branch).toBe("feat/a");

    // main untouched; feature branch carries the change.
    expect((await remoteFiles("main")).get("models/a.sql")).toBe("select 1");
    expect((await remoteFiles("feat/a")).get("models/a.sql")).toBe("select 2");

    // Only alice's checkout moved.
    expect(await getCheckoutBranch(project, "alice")).toBe("feat/a");
    expect(await getCheckoutBranch(project, "bob")).toBe("main");

    // Alice's working tree on feat/a shows her committed content, clean.
    expect(
      (await readWorkingFile(project, "alice", "models/a.sql"))?.content,
    ).toBe("select 2");
    expect((await getGitStatus(project, "alice")).hasChanges).toBe(false);
    // Bob still sees main.
    expect(
      (await readWorkingFile(project, "bob", "models/a.sql"))?.content,
    ).toBe("select 1");
  });
});

describe("per-user checkouts", () => {
  it("switching branches moves only the caller's checkout and carries drafts", async () => {
    const project = await seedProject();
    await remoteSetBranch("feature/x", {
      "dbt_project.yml": "name: analytics",
      "models/a.sql": "select 100",
    });

    await writeWorkingFile(project, "alice", "models/wip.sql", "select 42");
    const result = await switchProjectBranch(
      project,
      "alice",
      "feature/x",
      "alice",
    );
    expect(result.branch).toBe("feature/x");
    expect(result.carriedChanges).toBe(1);

    // Alice sees feature/x base + her carried draft.
    expect(
      (await readWorkingFile(project, "alice", "models/a.sql"))?.content,
    ).toBe("select 100");
    expect(
      (await readWorkingFile(project, "alice", "models/wip.sql"))?.content,
    ).toBe("select 42");
    // Bob is untouched on main.
    expect(await getCheckoutBranch(project, "bob")).toBe("main");
    expect(
      (await readWorkingFile(project, "bob", "models/a.sql"))?.content,
    ).toBe("select 1");
  });

  it("discardLocalChanges drops the caller's drafts on switch", async () => {
    const project = await seedProject();
    await remoteSetBranch("feature/x", {
      "dbt_project.yml": "name: analytics",
    });
    await writeWorkingFile(project, "alice", "models/wip.sql", "select 42");

    const result = await switchProjectBranch(
      project,
      "alice",
      "feature/x",
      "alice",
      { discardLocalChanges: true },
    );
    expect(result.discarded?.changes).toEqual([
      { path: "models/wip.sql", status: "added" },
    ]);
    expect(
      await readWorkingFile(project, "alice", "models/wip.sql"),
    ).toBeNull();
  });

  it("create branch pushes the fork to the remote and checks it out for the caller", async () => {
    const project = await seedProject();
    const result = await createProjectBranch(project, "alice", "feat/clone");
    expect(result).toEqual({ branch: "feat/clone", fromBranch: "main" });
    expect(await getCheckoutBranch(project, "alice")).toBe("feat/clone");
    expect(await remoteBranchExists("feat/clone")).toBe(true);
    expect(await listProjectBranches(project)).toContain("feat/clone");
    // Working tree contents come from the forked branch.
    const files = await loadWorkingTreeContents(project, { userId: "alice" });
    expect(files.map(f => f.path)).toEqual([
      "dbt_project.yml",
      "models/a.sql",
    ]);
  });

  it("refuses to delete a branch that any user has checked out", async () => {
    const project = await seedProject();
    await remoteSetBranch("feature/x", {
      "dbt_project.yml": "name: analytics",
    });
    await switchProjectBranch(project, "alice", "feature/x", "alice");

    await expect(
      deleteProjectBranch(project, "alice", "feature/x"),
    ).rejects.toThrow(/your currently checked-out branch/);
    await expect(
      deleteProjectBranch(project, "bob", "feature/x"),
    ).rejects.toThrow(/another user has it checked out/);
    // Alice is on feature/x, so deleting main hits the default-branch guard.
    await expect(deleteProjectBranch(project, "alice", "main")).rejects.toThrow(
      /default branch/,
    );
  });

  it("deletes an unclaimed branch on the remote and locally", async () => {
    const project = await seedProject();
    await remoteSetBranch("feature/dead", {
      "dbt_project.yml": "name: analytics",
    });
    await syncProjectBranchFromRepo(project, "feature/dead", "seed");
    const result = await deleteProjectBranch(project, "bob", "feature/dead");
    expect(result.deleted).toBe("feature/dead");
    expect(await remoteBranchExists("feature/dead")).toBe(false);
  });
});

describe("recoverable files (git history)", () => {
  it("lists committed deletions and restores them as pending adds", async () => {
    const project = await seedProject();
    await deleteWorkingFile(project, "alice", "models/a.sql");
    await commitAndPush(project, {
      userId: "alice",
      message: "chore: drop a",
      updatedBy: "alice",
    });

    const recoverable = await listRecoverableFiles(project);
    expect(recoverable.map(f => f.path)).toContain("models/a.sql");
    expect(
      recoverable.find(f => f.path === "models/a.sql")?.content,
    ).toBe("select 1");

    const restored = await restoreDeletedFile(project, "bob", "models/a.sql");
    expect(restored.content).toBe("select 1");
    const status = await getGitStatus(project, "bob");
    expect(status.changes).toEqual([
      { path: "models/a.sql", status: "added" },
    ]);
  });
});

describe("pull request merge", () => {
  it("merges, syncs the default branch, and relocates checkouts off the deleted head", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");
    await commitToNewBranch(project, {
      userId: "alice",
      branchName: "feat/a",
      message: "feat: change a",
      updatedBy: "alice",
    });
    pulls.state.set(7, { headRef: "feat/a", baseRef: "main", state: "open" });

    const result = await mergeProjectPullRequest(project, {
      userId: "alice",
      prNumber: 7,
      updatedBy: "alice",
    });
    expect(result.sha).toBeTruthy();
    expect(result.branch).toBe("main");
    expect(result.branchDeleted).toBe(true);
    expect(result.workingTreeClean).toBe(true);

    // main now carries the merged change for everyone.
    expect((await remoteFiles("main")).get("models/a.sql")).toBe("select 2");
    expect(
      (await readWorkingFile(project, "bob", "models/a.sql"))?.content,
    ).toBe("select 2");

    // Alice is back on main; the head branch is gone everywhere.
    expect(await getCheckoutBranch(project, "alice")).toBe("main");
    expect(await remoteBranchExists("feat/a")).toBe(false);
    expect(
      await DbtCheckout.countDocuments({
        projectId: project._id,
        branch: "feat/a",
      }),
    ).toBe(0);
  });

  it("rejects closed pull requests", async () => {
    const project = await seedProject();
    pulls.state.set(5, {
      headRef: "feat/done",
      baseRef: "main",
      state: "closed",
    });
    await expect(
      mergeProjectPullRequest(project, {
        userId: "alice",
        prNumber: 5,
        updatedBy: "alice",
      }),
    ).rejects.toThrow("Pull request #5 is closed");
  });
});

describe("legacy Mongo lazy migration", () => {
  it("materializes dbt_files base trees + per-user drafts into git on first touch", async () => {
    // Seed a legacy-shaped project directly in Mongo (no git repo yet).
    const project = await DbtProject.create({
      workspaceId: WS,
      name: `Legacy-${new Types.ObjectId().toString()}`,
      environments: [
        {
          name: "dev",
          connectionId: new Types.ObjectId(),
          targetSchema: "analytics",
          threads: 4,
        },
      ],
      defaultEnvironment: "dev",
      createdBy: "tester",
    });
    await mongoose.connection.collection("dbt_files").insertMany([
      {
        workspaceId: WS,
        projectId: project._id,
        path: "dbt_project.yml",
        content: "name: legacy",
        updatedBy: "u1",
        is_deleted: false,
      },
      {
        workspaceId: WS,
        projectId: project._id,
        path: "models/x.sql",
        content: "select 1",
        updatedBy: "u1",
        is_deleted: false,
      },
      {
        workspaceId: WS,
        projectId: project._id,
        path: "models/gone.sql",
        content: "select 0",
        updatedBy: "u1",
        is_deleted: true,
      },
    ]);

    const files = await loadWorkingTreeContents(project, { userId: "u1" });
    expect(files).toEqual([
      { path: "dbt_project.yml", content: "name: legacy" },
      { path: "models/x.sql", content: "select 1" },
    ]);

    // Soft-deleted legacy content survives in git history: it was committed
    // then deleted, so the blob is reachable from the import commits.
    const state = await readWorkingFile(project, "u1", "models/gone.sql");
    expect(state).toBeNull();
  });

  it("imports repo-project drafts as per-user overlays", async () => {
    // Remote + legacy Mongo mirror + one pending draft for alice.
    const project = await DbtProject.create({
      workspaceId: WS,
      name: `LegacyRepo-${new Types.ObjectId().toString()}`,
      environments: [
        {
          name: "dev",
          connectionId: new Types.ObjectId(),
          targetSchema: "analytics",
          threads: 4,
        },
      ],
      defaultEnvironment: "dev",
      createdBy: "tester",
      repo: {
        provider: "github",
        owner: "acme",
        repo: "analytics",
        branch: "main",
        installationId: 123,
      },
    });
    await mongoose.connection.collection("dbt_files").insertMany([
      {
        workspaceId: WS,
        projectId: project._id,
        branch: "main",
        path: "dbt_project.yml",
        content: "name: analytics",
        updatedBy: "u1",
        is_deleted: false,
      },
      {
        workspaceId: WS,
        projectId: project._id,
        branch: "main",
        path: "models/a.sql",
        content: "select 1",
        updatedBy: "u1",
        is_deleted: false,
      },
    ]);
    await mongoose.connection.collection("dbt_file_drafts").insertOne({
      workspaceId: WS,
      projectId: project._id,
      userId: "alice",
      path: "models/a.sql",
      content: "select 2",
      is_deleted: false,
    });

    expect(
      (await readWorkingFile(project, "alice", "models/a.sql"))?.content,
    ).toBe("select 2");
    expect(
      (await readWorkingFile(project, "bob", "models/a.sql"))?.content,
    ).toBe("select 1");
    const status = await getGitStatus(project, "alice");
    expect(status.changes).toEqual([
      { path: "models/a.sql", status: "modified" },
    ]);
  });
});

describe("draft ref hygiene", () => {
  it("an overlay that becomes redundant after a sync is dropped", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");
    // The same change lands upstream.
    await remoteSetBranch("main", {
      "dbt_project.yml": "name: analytics",
      "models/a.sql": "select 2",
    });
    await syncProjectBranchFromRepo(project, "main", "webhook");
    const status = await getGitStatus(project, "alice");
    expect(status.hasChanges).toBe(false);
  });

  it("cleans up when a draft ref survives without its base", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");
    // Simulate a lost base ref (crash between ref updates).
    const { repoDirFor, draftRefsFor } = await import(
      "./dbt-git-store.service"
    );
    const repoDir = repoDirFor(
      project.workspaceId.toString(),
      project._id.toString(),
    );
    await deleteRef(repoDir, draftRefsFor("alice").base);
    // Base defaults to the current head → overlay stays intact.
    expect(
      (await readWorkingFile(project, "alice", "models/a.sql"))?.content,
    ).toBe("select 2");
  });
});
