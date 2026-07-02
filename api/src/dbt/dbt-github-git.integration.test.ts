/**
 * Per-user dbt working trees + git surface — integration tests.
 *
 * Real Mongoose persistence (mongodb-memory-server) with a fake in-memory
 * GitHub remote (mocked github-api module), so commit/sync/branch/merge run
 * their actual code paths. Verifies the collaboration model end-to-end:
 *
 *  - drafts are per user (uncommitted edits invisible to other users)
 *  - syncs never touch drafts
 *  - commits push drafts, advance the branch base tree, and clear drafts
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
import { gitBlobSha } from "../integrations/github/git-blob";

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: vi.fn(async () => "token"),
}));

// ---------------------------------------------------------------------------
// Fake GitHub remote: branches are maps of path → content; head SHAs advance
// on every commit. Implements exactly the github-api surface the services use.
// ---------------------------------------------------------------------------
const remote = vi.hoisted(() => {
  const state = {
    branches: new Map<string, { head: string; files: Map<string, string> }>(),
    pulls: new Map<
      number,
      { headRef: string; baseRef: string; state: string }
    >(),
    commitCounter: 0,
    defaultBranch: "main",
  };
  return {
    state,
    reset() {
      state.branches.clear();
      state.pulls.clear();
      state.commitCounter = 0;
    },
    setBranch(name: string, files: Record<string, string>) {
      state.commitCounter += 1;
      state.branches.set(name, {
        head: `commit-${state.commitCounter}`,
        files: new Map(Object.entries(files)),
      });
    },
    branch(name: string) {
      const b = state.branches.get(name);
      if (!b) throw new Error(`GitHub 404: no branch ${name}`);
      return b;
    },
    branchByHead(sha: string) {
      for (const [name, b] of state.branches) {
        if (b.head === sha) return { name, ...b };
      }
      throw new Error(`GitHub 404: no ref ${sha}`);
    },
  };
});

vi.mock("../integrations/github/github-api", () => ({
  getBranchHeadSha: vi.fn(async (_o: string, _r: string, branch: string) => {
    return remote.branch(branch).head;
  }),
  getRepoTree: vi.fn(async (_o: string, _r: string, sha: string) => {
    const branchName = sha.startsWith("tree:")
      ? sha.slice("tree:".length)
      : remote.branchByHead(sha).name;
    const b = remote.branch(branchName);
    return {
      sha,
      truncated: false,
      entries: [...b.files.entries()].map(([path, content]) => ({
        path,
        type: "blob" as const,
        sha: gitBlobSha(content),
        size: content.length,
      })),
    };
  }),
  getBlobContent: vi.fn(async (_o: string, _r: string, blobSha: string) => {
    for (const b of remote.state.branches.values()) {
      for (const content of b.files.values()) {
        if (gitBlobSha(content) === blobSha) return content;
      }
    }
    throw new Error(`GitHub 404: no blob ${blobSha}`);
  }),
  getRefCommit: vi.fn(async (_o: string, _r: string, branch: string) => {
    const b = remote.branch(branch);
    return { commitSha: b.head, treeSha: `tree:${branch}` };
  }),
  commitChanges: vi.fn(
    async (
      _o: string,
      _r: string,
      params: {
        branch: string;
        changes: Array<{ path: string; content: string | null }>;
      },
    ) => {
      const b = remote.branch(params.branch);
      for (const change of params.changes) {
        if (change.content === null) b.files.delete(change.path);
        else b.files.set(change.path, change.content);
      }
      remote.state.commitCounter += 1;
      b.head = `commit-${remote.state.commitCounter}`;
      return b.head;
    },
  ),
  listBranches: vi.fn(async () => [...remote.state.branches.keys()]),
  createBranch: vi.fn(
    async (_o: string, _r: string, name: string, fromSha: string) => {
      const source = remote.branchByHead(fromSha);
      remote.state.branches.set(name, {
        head: source.head,
        files: new Map(source.files),
      });
    },
  ),
  deleteBranch: vi.fn(async (_o: string, _r: string, name: string) => {
    remote.state.branches.delete(name);
  }),
  tryDeleteBranch: vi.fn(async (_o: string, _r: string, name: string) => {
    remote.state.branches.delete(name);
    return { deleted: true };
  }),
  getRepoInfo: vi.fn(async () => ({
    fullName: "acme/analytics",
    owner: "acme",
    name: "analytics",
    defaultBranch: remote.state.defaultBranch,
    private: false,
  })),
  createPullRequest: vi.fn(
    async (
      _o: string,
      _r: string,
      params: { head: string; base: string },
    ) => {
      const number = remote.state.pulls.size + 1;
      remote.state.pulls.set(number, {
        headRef: params.head,
        baseRef: params.base,
        state: "open",
      });
      return { number, htmlUrl: `https://github.com/pr/${number}` };
    },
  ),
  getPullRequest: vi.fn(async (_o: string, _r: string, prNumber: number) => {
    const pr = remote.state.pulls.get(prNumber);
    if (!pr) throw new Error(`GitHub 404: no PR ${prNumber}`);
    return {
      number: prNumber,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      mergeable: true,
      state: pr.state,
    };
  }),
  mergePullRequest: vi.fn(async (_o: string, _r: string, prNumber: number) => {
    const pr = remote.state.pulls.get(prNumber);
    if (!pr) throw new Error(`GitHub 404: no PR ${prNumber}`);
    const head = remote.branch(pr.headRef);
    const base = remote.branch(pr.baseRef);
    for (const [path, content] of head.files) base.files.set(path, content);
    remote.state.commitCounter += 1;
    base.head = `commit-${remote.state.commitCounter}`;
    pr.state = "closed";
    return { sha: base.head };
  }),
}));

// Imported after the mocks are registered.
import {
  DbtCheckout,
  DbtFile,
  DbtFileDraft,
  DbtProject,
  type IDbtProject,
} from "../database/workspace-schema";
import { syncProjectBranchFromRepo } from "./dbt-github-sync.service";
import {
  commitAndPush,
  commitToNewBranch,
  createProjectBranch,
  deleteProjectBranch,
  getGitStatus,
  getProjectFileDiff,
  mergeProjectPullRequest,
  ProtectedBranchError,
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
const WS = new Types.ObjectId();

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
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  remote.reset();
  remote.setBranch("main", {
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
    expect(
      await DbtFileDraft.countDocuments({ projectId: project._id }),
    ).toBe(0);
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
  it("a branch sync fast-forwards the base tree but never touches drafts", async () => {
    const project = await seedProject();
    await writeWorkingFile(project, "alice", "models/a.sql", "select 2");

    remote.setBranch("main", {
      "dbt_project.yml": "name: analytics",
      "models/a.sql": "select 10",
      "models/b.sql": "select 20",
    });
    await syncProjectBranchFromRepo(project, "main", "webhook");

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
  });
});

describe("commit & push (per-user)", () => {
  it("pushes the caller's drafts, updates the base tree, and clears drafts", async () => {
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
    expect(remote.branch("main").files.get("models/a.sql")).toBe("select 2");
    // Base tree advanced → every user now sees the committed content.
    expect(
      (await readWorkingFile(project, "bob", "models/a.sql"))?.content,
    ).toBe("select 2");
    // Drafts cleared → author's tree is clean.
    expect((await getGitStatus(project, "alice")).hasChanges).toBe(false);
    expect(
      await DbtFileDraft.countDocuments({ projectId: project._id }),
    ).toBe(0);
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
    expect(remote.branch("main").files.has("models/new.sql")).toBe(false);

    const status = await getGitStatus(project, "alice");
    expect(status.changes).toEqual([
      { path: "models/new.sql", status: "added" },
    ]);
  });

  it("commits a draft deletion by removing the file from branch and base", async () => {
    const project = await seedProject();
    await deleteWorkingFile(project, "alice", "models/a.sql");
    const result = await commitAndPush(project, {
      userId: "alice",
      message: "chore: drop a",
      updatedBy: "alice",
    });
    expect(result.pushed.deleted).toBe(1);
    expect(remote.branch("main").files.has("models/a.sql")).toBe(false);
    expect(await readWorkingFile(project, "bob", "models/a.sql")).toBeNull();
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
    // Nothing moved: remote and base tree untouched, draft still pending.
    expect(remote.branch("main").files.get("models/a.sql")).toBe("select 1");
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
    expect(remote.branch("main").files.get("models/a.sql")).toBe("select 1");
    expect(remote.branch("feat/a").files.get("models/a.sql")).toBe("select 2");

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
    remote.setBranch("feature/x", {
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
    remote.setBranch("feature/x", { "dbt_project.yml": "name: analytics" });
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

  it("create branch clones the base tree locally and checks it out for the caller", async () => {
    const project = await seedProject();
    const result = await createProjectBranch(project, "alice", "feat/clone");
    expect(result).toEqual({ branch: "feat/clone", fromBranch: "main" });
    expect(await getCheckoutBranch(project, "alice")).toBe("feat/clone");
    expect(
      await DbtFile.countDocuments({
        projectId: project._id,
        branch: "feat/clone",
        is_deleted: { $ne: true },
      }),
    ).toBe(2);
    // Working tree contents come from the cloned branch.
    const files = await loadWorkingTreeContents(project, { userId: "alice" });
    expect(files.map(f => f.path)).toEqual([
      "dbt_project.yml",
      "models/a.sql",
    ]);
  });

  it("refuses to delete a branch that any user has checked out", async () => {
    const project = await seedProject();
    remote.setBranch("feature/x", { "dbt_project.yml": "name: analytics" });
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
    remote.state.pulls.set(7, {
      headRef: "feat/a",
      baseRef: "main",
      state: "open",
    });

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
    expect(remote.branch("main").files.get("models/a.sql")).toBe("select 2");
    expect(
      (await readWorkingFile(project, "bob", "models/a.sql"))?.content,
    ).toBe("select 2");

    // Alice is back on main; the deleted branch's base tree is gone.
    expect(await getCheckoutBranch(project, "alice")).toBe("main");
    expect(
      await DbtFile.countDocuments({
        projectId: project._id,
        branch: "feat/a",
      }),
    ).toBe(0);
    expect(
      await DbtCheckout.countDocuments({
        projectId: project._id,
        branch: "feat/a",
      }),
    ).toBe(0);
  });

  it("rejects closed pull requests", async () => {
    const project = await seedProject();
    remote.state.pulls.set(5, {
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
