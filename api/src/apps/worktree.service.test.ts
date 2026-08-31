/**
 * Apps worktree service — integration tests.
 *
 * Real git, a real local sandbox, a real git server on a real port, and
 * mongodb-memory-server. The sandbox is an ordinary clone with an ordinary
 * remote, so these exercise the same path a developer's machine would: clone,
 * edit, commit, push, and read back from the server.
 *
 * The durability claim under test has changed shape. It used to be "flushed
 * work survives the sandbox dying", where flushing meant a shadow commit on a
 * private ref. It is now the ordinary one: COMMITTED-AND-PUSHED work survives,
 * uncommitted work lives in the working copy, and losing the machine loses the
 * latter — exactly as on a laptop.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  boxCtx,
  checkoutBranch,
  commitAgentTurn,
  commitWorktree,
  createProject,
  deleteProject,
  ensureWorktree,
  execInWorktree,
  listBranches,
  listFiles,
  mergeBranchToMain,
  projectHistory,
  readFile,
  worktreeStatus,
  writeFile,
} from "./worktree.service";
import { AppWorktree } from "../database/workspace-schema";
import { getSandboxProvider } from "./sandbox/provider";
import { repoDirFor, resolveCommit } from "./repository.service";
import { startTestGitServer, type TestGitServer } from "./test-git-server";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;

// The apps config reads env lazily (at call time), so setting these in
// beforeAll — after module import but before any service call — is safe.
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-wt-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  // The sandbox needs a remote to clone from and push to, so the git endpoint
  // runs for real on a real port. `SESSION_SECRET` signs the token it uses.
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
  // Hermetic: never let a configured cloud org make createProject create
  // real GitHub repos from tests (e.g. when the shell exports .env).

  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const USER = "user-1";

beforeEach(async () => {
  await mongoose.connection.collection("app_projects").deleteMany({});
  await mongoose.connection.collection("app_worktrees").deleteMany({});
  // §10: ONE repo per workspace — wipe the git/session roots so each test
  // starts from an empty workspace repo.
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await fs.rm(path.join(tmpRoot, "sessions"), { recursive: true, force: true });
});

/** Lose the machine. Not every provider can, and a test must not pretend. */
async function destroyBox(handle: Awaited<ReturnType<typeof ensureWorktree>>) {
  const provider = getSandboxProvider();
  if (!provider.destroySession) {
    throw new Error(`${provider.id} cannot destroy a session`);
  }
  await provider.destroySession(boxCtx(handle).sessionKey);
}

async function makeProject(title = "Test App") {
  return createProject({ workspaceId: WS, title, userId: USER });
}

describe("project lifecycle", () => {
  it("creates a project whose files read from git with no session", async () => {
    const project = await makeProject();
    const { entries } = await listFiles(project, USER);
    expect(entries.map(e => e.path)).toContain("src/App.tsx");

    const file = await readFile(project, "src/App.tsx", USER);
    expect(file.contents).toContain("Apps");

    const history = await projectHistory(project);
    expect(history).toHaveLength(1);
    expect(history[0].subject).toContain('Create app "Test App"');

    await deleteProject(project);
  });
});

describe("the working copy", () => {
  it("a write is visible in reads, because reads come from the working copy", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    await writeFile(handle, "src/note.ts", "export const n = 1;\n");

    const { entries } = await listFiles(project, USER);
    expect(entries.map(e => e.path)).toContain("src/note.ts");
    // Sizes must be real. The size probe once used GNU stat flags only, so on
    // a Mac (BSD stat — i.e. every local dev machine) it silently reported
    // every file as 0 bytes.
    const note = entries.find(e => e.path === "src/note.ts");
    expect(note?.size).toBe(Buffer.byteLength("export const n = 1;\n"));

    const file = await readFile(project, "src/note.ts", USER);
    expect(file.contents).toBe("export const n = 1;\n");

    // Uncommitted, and reported as such — no shadow commit stands in for it.
    const status = await worktreeStatus(project, USER);
    expect(status?.offline).toBe(false);
    expect(status?.changes.map(ch => ch.path)).toContain("src/note.ts");
  });

  it("committing pushes, so the work outlives the sandbox", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "src/keep.ts", "export const keep = true;\n");
    const result = await commitWorktree(handle, "Keep this");
    expect(result.committed).toBe(true);

    // The push is the durability guarantee: the commit is in the bare repo,
    // reachable with no sandbox involved at all.
    expect(await resolveCommit(repoDirFor(WS), result.commitOid!)).toBe(
      result.commitOid,
    );

    // Destroy the machine. A commit that reached the server survives it.
    await destroyBox(handle);
    const file = await readFile(project, "src/keep.ts", USER);
    expect(file.contents).toBe("export const keep = true;\n");
  });

  it("uncommitted work does NOT outlive the sandbox, and says so", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "src/scratch.ts", "export const draft = 1;\n");

    // This is the deliberate trade for being a normal machine: a working copy
    // is a working copy. Asserting it keeps the promise honest rather than
    // letting anyone believe an uncommitted edit is backed up somewhere.
    await destroyBox(handle);

    const { entries } = await listFiles(project, USER);
    expect(entries.map(e => e.path)).not.toContain("src/scratch.ts");

    // And with no machine running, status says so rather than claiming clean.
    const status = await worktreeStatus(project, USER);
    expect(status?.offline).toBe(true);
  });

  it("shell commands mutate files the next read sees", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    const result = await execInWorktree(
      handle,
      'echo "hello from bash" > hello.txt && ls',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello.txt");

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
      // HOME is a shared cache dir outside the working copy (not the checkout
      // itself and not the API host's real home) — anything npm or pnpm
      // writes there must never end up in a commit.
      const expectedHome = path.join(os.tmpdir(), "mako-apps-cache", "home");
      expect(result.stdout).toContain(`HOME=${expectedHome}`);
      expect(result.stdout).not.toContain("MONGODB");
      expect(result.stdout).not.toContain(`HOME=${os.homedir()}`);
    } finally {
      delete process.env.FAKE_SECRET_FOR_TEST;
    }
  });

  it("in-session git push REACHES the bare repo — that is the point", async () => {
    // This case used to assert the opposite, and the assertion was the design:
    // the sandbox had no remote, so commits travelled as bundles and a whole
    // transfer-and-snapshot layer existed to move them. The sandbox is a
    // normal machine now, and this is the test that says so.
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    const result = await execInWorktree(
      handle,
      'git remote -v; echo "---"; ' +
        'echo "from the shell" > shell.txt && git add -A && ' +
        'git commit -qm "committed in the shell" && git push -q origin HEAD 2>&1; ' +
        'echo "push=$?"',
    );
    const [remotes, rest] = result.stdout.split("---");
    expect(remotes).toContain("apps-git");
    expect(rest).toContain("push=0");

    // The server has it, and no Mako-specific step was involved in getting it
    // there. Reading it back needs no sandbox.
    await destroyBox(handle);
    const file = await readFile(project, "shell.txt", USER);
    expect(file.contents).toBe("from the shell\n");
  });

  it("a credential never appears in the remote URL, and lives inside .git", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    const result = await execInWorktree(handle, "git remote -v");
    expect(result.stdout).not.toContain("mgt_");

    // Inside the clone's .git: per-clone by construction and part of the
    // pause snapshot. It has lived in $HOME (shared across local sandboxes —
    // cross-workspace credential clobbering) and in /tmp (tmpfs, wiped by
    // E2B pause/resume — "cat: No such file" at push time). Pin the location
    // so the third wrong home needs to argue with this test first.
    const where = await execInWorktree(
      handle,
      'test -s "$(git rev-parse --absolute-git-dir)/mako-git-token" && echo in-git',
    );
    expect(where.stdout).toContain("in-git");
  });

  it("a laptop clone ignores node_modules with no sandbox machinery at all", async () => {
    // The failure this guards: an app built WITHOUT the scaffold (an agent
    // with write_file + bash, or a person in a plain clone) has no per-app
    // .gitignore, and .git/info/exclude does not travel — so one `git add -A`
    // committed node_modules on the first preview deployment. The workspace
    // repo's ROOT .gitignore is the layer that is versioned and therefore
    // present in every clone; a bare file clone is the honest simulation.
    const project = await makeProject();
    const clone = await fs.mkdtemp(path.join(tmpRoot, "laptop-"));
    await new Promise<void>((resolve, reject) => {
      execFile(
        "bash",
        [
          "-lc",
          `git clone -q ${repoDirFor(WS)} ${clone} && cd ${clone} && ` +
            `mkdir -p apps/hand-made/node_modules/some-lib && ` +
            `echo x > apps/hand-made/node_modules/some-lib/index.js && ` +
            `echo secret > apps/hand-made/.env && ` +
            `echo '{}' > apps/hand-made/package.json`,
        ],
        err => (err ? reject(err) : resolve()),
      );
    });
    const status = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        // -uall: porcelain collapses an untracked directory to one line,
        // which would hide exactly the files the assertions are about.
        ["-C", clone, "status", "--porcelain", "-uall"],
        (err, out) => (err ? reject(err) : resolve(String(out))),
      );
    });
    expect(status).toContain("package.json");
    expect(status).not.toContain("node_modules");
    expect(status).not.toContain(".env");
    void project;
  }, 120_000);

  it("a running box catches up right after a server-side app creation", async () => {
    const { catchUpLiveBox } = await import("./worktree.service");
    const first = await makeProject();
    // A LIVE box for the actor, established on the current state.
    await execInWorktree(await ensureWorktree(first, USER), "true");

    // A second app is created server-side — no sandbox involved — exactly
    // what app_create_app does. Reads come from the running box, which has
    // not heard: without the catch-up the new app lists as empty ("files:
    // []"), and the agent rebuilds the scaffold by hand on top of it.
    const second = await createProject({
      workspaceId: WS,
      title: "Second App",
      userId: USER,
    });
    await catchUpLiveBox(second, USER);
    const listed = (await listFiles(second, USER)).entries.map(e => e.path);
    expect(listed).toContain("src/App.tsx");
    expect(listed).toContain("package.json");
  }, 180_000);
});

describe("commits", () => {
  it("commits land on the branch you are on — main by default", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "src/feature.ts", "export {};\n");

    const result = await commitWorktree(handle, "Add feature module");
    expect(result.committed).toBe(true);

    // A fresh actor starts on main, like a fresh clone — the commit is on
    // main's history. Publish deploys a PINNED sha, so main moving ships
    // nothing by itself.
    expect((await projectHistory(project)).map(c => c.subject)).toEqual([
      "Add feature module",
      'Create app "Test App" (apps/test-app)',
    ]);

    const status = await worktreeStatus(project, USER);
    expect(status?.changes).toEqual([]);
    expect(status?.baseSha).toBe(result.commitOid);
    // Committed AND pushed: nothing is waiting to reach the server.
    expect(status?.ahead).toBe(0);

    // Post-commit the working copy is clean, so another commit is a no-op.
    const again = await commitWorktree(handle, "empty");
    expect(again.committed).toBe(false);

    // On an explicitly created branch, work stays off main until merged —
    // branching is a choice now, not an identity.
    await checkoutBranch(handle, "feature", { create: true });
    await writeFile(handle, "src/extra.ts", "export {};\n");
    const onBranch = await commitWorktree(
      await ensureWorktree(project, USER),
      "On a branch",
    );
    expect(onBranch.committed).toBe(true);
    expect((await projectHistory(project)).map(c => c.subject)[0]).toBe(
      "Add feature module",
    );
    const branch = (await listBranches(project)).find(
      b => b.name === "feature",
    );
    expect(branch?.aheadOfMain).toBe(1);
    expect(branch?.lastCommit?.subject).toBe("On a branch");
  });

  it("a commit racing someone else's does not lose either", async () => {
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "mine.txt", "mine\n");

    // Someone else pushes to the same branch — another device, another tab.
    // I expected this to be REFUSED as a non-fast-forward, and wrote the test
    // that way. It is not: the sandbox pulls before it commits, so the two
    // commits merge and both survive. That is the better outcome and it is
    // ordinary git, so the assertion follows the behaviour rather than my
    // guess about it.
    const repoDir = repoDirFor(WS);
    const scratch = await fs.mkdtemp(path.join(tmpRoot, "other-"));
    await new Promise<void>((resolve, reject) => {
      execFile(
        "bash",
        [
          "-lc",
          `git clone -q --branch main ${repoDir} ${scratch} && ` +
            `cd ${scratch} && git config user.email o@x && git config user.name O && ` +
            // Into the APP's folder: listFiles is app-scoped, so a file at
            // the repo root would be invisible to it and prove nothing.
            `echo theirs > apps/test-app/theirs.txt && git add -A && ` +
            `git commit -qm "other actor" && ` +
            `git push -q origin HEAD:refs/heads/main`,
        ],
        err => (err ? reject(err) : resolve()),
      );
    });

    const result = await commitWorktree(handle, "mine");
    expect(result.committed).toBe(true);

    // Both are on the branch, and the branch on the SERVER has both — which is
    // the only version of "not lost" that means anything.
    const listed = (await listFiles(project, USER)).entries.map(e => e.path);
    expect(listed).toContain("mine.txt");
    expect(listed).toContain("theirs.txt");
  });
});

describe("branches are explicit", () => {
  // Branching is git-native now: everyone starts on main, and a branch
  // exists because someone made one. These exercise two PEOPLE with explicit
  // branches, which is also the case that actually produces conflicts.
  const ALICE = "alice";
  const BOB = "bob";

  it("a turn commit lands on the current branch; merge brings a branch to main", async () => {
    const project = await makeProject();

    const handle = await ensureWorktree(project, ALICE);
    expect(handle.doc.branch).toBe("main");
    await checkoutBranch(handle, "alice-feature", { create: true });

    await writeFile(handle, "src/feature.ts", "export const f = 1;\n");

    // End-of-turn commit (no session/sandbox required).
    const results = await commitAgentTurn(WS, ALICE, "add feature module");
    expect(results).toHaveLength(1);
    expect(results[0].commitOid).toBeTruthy();

    // The commit is on the branch Alice created, NOT on main.
    const branches = await listBranches(project);
    const branch = branches.find(b => b.name === "alice-feature");
    expect(branch?.aheadOfMain).toBe(1);
    expect(branch?.lastCommit?.subject).toContain("add feature module");
    const mainFiles = (await listFiles(project)).entries.map(e => e.path);
    expect(mainFiles).not.toContain("src/feature.ts");

    // A second turn commits again on the same branch.
    const handle2 = await ensureWorktree(project, ALICE);
    expect(handle2.doc.branch).toBe("alice-feature");
    await writeFile(handle2, "src/feature2.ts", "export const g = 2;\n");
    await commitAgentTurn(WS, ALICE, "second turn");
    expect(
      (await listBranches(project)).find(b => b.name === "alice-feature")
        ?.aheadOfMain,
    ).toBe(2);

    // Merge to main (fast-forward — main did not move).
    const merge = await mergeBranchToMain(project, "alice-feature");
    expect(merge.merged).toBe(true);
    expect(merge.fastForward).toBe(true);
    const mainAfter = (await listFiles(project)).entries.map(e => e.path);
    expect(mainAfter).toContain("src/feature.ts");
    expect(mainAfter).toContain("src/feature2.ts");
  });

  it("a chat and its user share one checkout, so each sees the other's work", async () => {
    // The regression this replaces: the agent worked on `chat/<id>` while the
    // user's tree and terminal showed another branch, so the user opened the
    // folder the agent had just filled and found it empty.
    const project = await makeProject();

    const agentTurn = await ensureWorktree(project, ALICE);
    await writeFile(agentTurn, "bindings/users.sql", "SELECT 1;\n");
    await commitAgentTurn(WS, ALICE, "add a binding");

    // Whatever the user looks at next resolves the SAME branch.
    const asUser = await listFiles(project, ALICE);
    expect(asUser.entries.map(e => e.path)).toContain("bindings/users.sql");
    expect((await ensureWorktree(project, ALICE)).doc.branch).toBe("main");
  });

  it("a checkout on main picks up what someone else merged to main", async () => {
    const project = await makeProject();

    // A checkout on main, clean.
    const userHandle = await ensureWorktree(project, USER);
    await execInWorktree(userHandle, "true");

    // Someone else commits on a branch and merges it to main.
    const h = await ensureWorktree(project, BOB);
    await checkoutBranch(h, "bob-work", { create: true });
    await writeFile(h, "merged.txt", "hello\n");
    await commitAgentTurn(WS, BOB);
    await mergeBranchToMain(project, "bob-work");

    // The sandbox pulls on next touch — ordinary `git pull` on main.
    const resumed = await ensureWorktree(project, USER);
    await execInWorktree(resumed, "true");
    const merged = await readFile(project, "merged.txt", USER);
    expect(merged.contents).toBe("hello\n");
  });

  it("merge builds a merge commit when main moved, and refuses conflicts", async () => {
    const project = await makeProject();

    // Bob edits file A on his own branch.
    const h = await ensureWorktree(project, BOB);
    await checkoutBranch(h, "bob-a", { create: true });
    await writeFile(h, "a.txt", "from bob\n");
    await commitAgentTurn(WS, BOB);

    // Meanwhile main gets an unrelated commit (file B) directly — the user
    // is ON main, so committing IS moving main — and Bob's branch is no
    // longer a straight-line descendant: the merge cannot fast-forward.
    const userHandle = await ensureWorktree(project, USER);
    await writeFile(userHandle, "b.txt", "from user\n");
    await commitWorktree(userHandle, "user change");

    const merge = await mergeBranchToMain(project, "bob-a");
    expect(merge.merged).toBe(true);
    expect(merge.fastForward).toBe(false);
    const files = (await listFiles(project)).entries.map(e => e.path);
    expect(files).toContain("a.txt");
    expect(files).toContain("b.txt");

    // Conflict: Alice branches, edits a.txt; the user edits the same line of
    // a.txt directly on main; Alice's merge must be refused as a conflict.
    const hb = await ensureWorktree(project, ALICE);
    await checkoutBranch(hb, "alice-a", { create: true });
    await writeFile(hb, "a.txt", "conflicting alice edit\n");
    await commitAgentTurn(WS, ALICE);
    const user2 = await ensureWorktree(project, USER);
    await writeFile(user2, "a.txt", "conflicting user edit\n");
    await commitWorktree(user2, "user conflicting change");

    await expect(mergeBranchToMain(project, "alice-a")).rejects.toThrow(
      /conflict/i,
    );
  });
});

describe("multi-actor isolation", () => {
  it("two people have independent working copies over one repo", async () => {
    const project = await makeProject();
    const h1 = await ensureWorktree(project, "alice");
    const h2 = await ensureWorktree(project, "bob");

    await writeFile(h1, "alice.txt", "a\n");
    await writeFile(h2, "bob.txt", "b\n");

    const aliceFiles = (await listFiles(project, "alice")).entries.map(
      e => e.path,
    );
    const bobFiles = (await listFiles(project, "bob")).entries.map(e => e.path);
    expect(aliceFiles).toContain("alice.txt");
    expect(aliceFiles).not.toContain("bob.txt");
    expect(bobFiles).toContain("bob.txt");
    expect(bobFiles).not.toContain("alice.txt");

    // A viewer with no checkout of their own sees the committed state.
    const viewerFiles = (await listFiles(project, "carol")).entries.map(
      e => e.path,
    );
    expect(viewerFiles).not.toContain("alice.txt");
    expect(viewerFiles).not.toContain("bob.txt");

    const worktrees = await AppWorktree.find({
      workspaceId: project.workspaceId,
    });
    expect(worktrees).toHaveLength(2);
  });
});
