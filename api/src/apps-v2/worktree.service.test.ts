/**
 * Apps v2 worktree service — durability integration tests.
 *
 * Real git + real local sandbox provider + mongodb-memory-server. The core
 * scenario under test is the RFC's headline durability claim: kill the
 * session working tree ("sandbox death") and verify that reads, recovery, and
 * commits proceed from the private WIP ref with no loss of flushed work.
 */
import { execFile } from "node:child_process";
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
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  commitWorktree,
  createProject,
  deleteProject,
  discardWorktree,
  ensureWorktree,
  execInWorktree,
  flushWorktree,
  listFiles,
  projectHistory,
  readFile,
  worktreeStatus,
  writeFile,
} from "./worktree.service";
import { AppWorktreeV2 } from "../database/workspace-schema";
import {
  repoDirFor,
  resolveCommit,
  updateRefCas,
  commitTree,
  treeOfCommit,
} from "./repository.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;

// The apps-v2 config reads env lazily (at call time), so setting these in
// beforeAll — after module import but before any service call — is safe.
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-v2-wt-test-"));
  process.env.APPS_V2_ENABLED = "1";
  process.env.APPS_V2_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_V2_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_V2_SANDBOX_PROVIDER = "local";

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

beforeEach(async () => {
  await mongoose.connection.collection("app_projects_v2").deleteMany({});
  await mongoose.connection.collection("app_worktrees_v2").deleteMany({});
});

async function makeProject(title = "Test App") {
  return createProject({ workspaceId: WS, title, userId: USER });
}

describe("project lifecycle", () => {
  it("creates a project whose files read from git with no session", async () => {
    const project = await makeProject();
    const { entries } = await listFiles(project, USER);
    expect(entries.map(e => e.path)).toContain("src/App.tsx");

    const file = await readFile(project, "src/App.tsx", USER);
    expect(file.contents).toContain("Apps v2");

    const history = await projectHistory(project);
    expect(history).toHaveLength(1);
    expect(history[0].subject).toBe("Initial scaffold");

    await deleteProject(project);
  });
});

describe("worktree writes + durability", () => {
  it("write → flush → visible in reads; session death loses nothing flushed", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    await writeFile(handle, "src/note.ts", "export const n = 1;\n");

    // Uncommitted change is durable and visible through git-backed reads.
    const { entries } = await listFiles(project, USER);
    expect(entries.map(e => e.path)).toContain("src/note.ts");

    // --- sandbox death ---
    await fs.rm(handle.sessionDir, { recursive: true, force: true });

    // Reads are unaffected (they never touched the session).
    const file = await readFile(project, "src/note.ts", USER);
    expect(file.contents).toBe("export const n = 1;\n");

    // Recovery: re-materialize and confirm the working tree has the WIP
    // change restored as UNCOMMITTED state on top of base.
    const recovered = await ensureWorktree(project, USER);
    const onDisk = await fs.readFile(
      path.join(recovered.sessionDir, "src/note.ts"),
      "utf8",
    );
    expect(onDisk).toBe("export const n = 1;\n");

    const status = await worktreeStatus(project, USER);
    expect(status?.wipOid).toBeTruthy();
    expect(status?.changes.map(ch => ch.path)).toContain("src/note.ts");

    // Lease epoch advanced — a zombie session from before the death could
    // not CAS the ref forward anymore (its expected old oid still matches
    // here, but epoch bookkeeping marks the re-materialization).
    expect(recovered.doc.leaseEpoch).toBeGreaterThan(1);
  });

  it("shell commands mutate files and auto-flush", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    const result = await execInWorktree(
      handle,
      'echo "hello from bash" > hello.txt && ls',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello.txt");
    expect(result.flush.flushed).toBe(true);

    const file = await readFile(project, "hello.txt", USER);
    expect(file.contents).toBe("hello from bash\n");
  });

  it("sandbox env does not leak API process secrets", async () => {
    process.env.FAKE_SECRET_FOR_TEST = "leaky";
    try {
      const project = await makeProject();
      const handle = await ensureWorktree(project, USER);
      const result = await execInWorktree(handle, "env");
      expect(result.stdout).not.toContain("leaky");
      expect(result.stdout).toContain(`HOME=${handle.sessionDir}`);
    } finally {
      delete process.env.FAKE_SECRET_FOR_TEST;
    }
  });

  it("in-session git push cannot reach the bare repo", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    const result = await execInWorktree(
      handle,
      "git remote get-url origin && git push origin main 2>&1; true",
    );
    expect(result.stdout).toContain("mako.invalid");
    // The push must not have advanced anything in the bare repo.
    const history = await projectHistory(project);
    expect(history).toHaveLength(1);
  });

  it("no-op flush when tree is clean", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    const flush = await flushWorktree(handle);
    expect(flush.flushed).toBe(false);
    const status = await worktreeStatus(project, USER);
    expect(status?.wipOid).toBeUndefined();
  });
});

describe("commit + conflicts", () => {
  it("commits WIP onto the branch and clears the WIP ref", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "src/feature.ts", "export {};\n");

    const result = await commitWorktree(handle, "Add feature module");
    expect(result.committed).toBe(true);

    const history = await projectHistory(project);
    expect(history.map(c => c.subject)).toEqual([
      "Add feature module",
      "Initial scaffold",
    ]);

    const status = await worktreeStatus(project, USER);
    expect(status?.wipOid).toBeUndefined();
    expect(status?.baseSha).toBe(result.commitOid);
    expect(status?.behindBranch).toBe(false);

    // Post-commit the session is clean: another commit is a no-op.
    const again = await commitWorktree(handle, "empty");
    expect(again.committed).toBe(false);
  });

  it("stale WIP CAS loses and preserves a conflict ref", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "one.txt", "1\n");

    // Simulate a concurrent writer advancing the WIP ref behind our back:
    // build a different snapshot and move the ref to it with the CORRECT
    // expected old value, then make the doc stale again.
    const repoDir = repoDirFor(WS, project._id.toString());
    const wipRef = `refs/mako/worktrees/${handle.doc._id.toString()}`;
    const currentWip = await resolveCommit(repoDir, wipRef);
    if (!currentWip) throw new Error("expected a WIP ref after writeFile");

    const foreignTree = await treeOfCommit(repoDir, handle.doc.baseSha);
    const foreign = await commitTree(repoDir, {
      treeOid: foreignTree,
      parents: [handle.doc.baseSha],
      message: "foreign snapshot",
    });
    expect(await updateRefCas(repoDir, wipRef, foreign, currentWip)).toBe(
      true,
    );
    // Make the in-memory doc stale (still believes currentWip).
    handle.doc.wipOid = currentWip;

    await fs.writeFile(path.join(handle.sessionDir, "one.txt"), "2\n");
    await expect(flushWorktree(handle)).rejects.toThrow(/advanced concurrently/);

    // The losing snapshot was preserved for recovery.
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["-C", repoDir, "for-each-ref", "refs/mako/conflicts/"],
        (err, out) => (err ? reject(err) : resolve(String(out))),
      );
    });
    expect(stdout.trim()).not.toBe("");
  });

  it("commit refuses when the branch moved under the worktree", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "mine.txt", "mine\n");

    // Another actor commits directly to main.
    const repoDir = repoDirFor(WS, project._id.toString());
    const head = await resolveCommit(repoDir, "refs/heads/main");
    if (!head) throw new Error("expected a branch head");
    const tree = await treeOfCommit(repoDir, head);
    const other = await commitTree(repoDir, {
      treeOid: tree,
      parents: [head],
      message: "other actor",
    });
    expect(await updateRefCas(repoDir, "refs/heads/main", other, head)).toBe(
      true,
    );

    await expect(commitWorktree(handle, "mine")).rejects.toThrow(/moved/);

    // Discard re-bases on the new head and drops WIP.
    const discarded = await discardWorktree(handle);
    expect(discarded.baseSha).toBe(other);
    const status = await worktreeStatus(project, USER);
    expect(status?.wipOid).toBeUndefined();
    expect(status?.baseSha).toBe(other);
  });
});

describe("multi-actor isolation", () => {
  it("two users have independent WIP states over one repo", async () => {
    const project = await makeProject();
    const h1 = await ensureWorktree(project, "alice");
    const h2 = await ensureWorktree(project, "bob");

    await writeFile(h1, "alice.txt", "a\n");
    await writeFile(h2, "bob.txt", "b\n");

    const aliceFiles = (await listFiles(project, "alice")).entries.map(
      e => e.path,
    );
    const bobFiles = (await listFiles(project, "bob")).entries.map(
      e => e.path,
    );
    expect(aliceFiles).toContain("alice.txt");
    expect(aliceFiles).not.toContain("bob.txt");
    expect(bobFiles).toContain("bob.txt");
    expect(bobFiles).not.toContain("alice.txt");

    // A viewer with no worktree sees only the branch.
    const viewerFiles = (await listFiles(project, "carol")).entries.map(
      e => e.path,
    );
    expect(viewerFiles).not.toContain("alice.txt");
    expect(viewerFiles).not.toContain("bob.txt");

    const worktrees = await AppWorktreeV2.find({ projectId: project._id });
    expect(worktrees).toHaveLength(2);
  });
});
