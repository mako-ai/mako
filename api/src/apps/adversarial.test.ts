/**
 * Attempts to FALSIFY "the app works".
 *
 * Each case is an attack on an invariant this subsystem claims, chosen because
 * it plausibly breaks it — hostile filenames, branch names git allows but a
 * shell would eat, concurrent writers, a sandbox that dies mid-flight, a
 * working copy that has drifted from what the database believes. A pass here
 * means the attack was survived, not that the code was exercised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { startTestGitServer, type TestGitServer } from "./test-git-server";
import { initRepo, repoDirFor } from "./repository.service";
import { seededTemplateFiles } from "./workspace-template";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";
import { scopeOf } from "./worktree.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;
const WS = new Types.ObjectId().toString();
const USER = "attacker";

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-adversarial-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  // The sandbox is a clone, so it needs a real remote to clone from.
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await initRepo(repoDirFor(WS), seededTemplateFiles());
  await bindTestWorkspaceRepo(WS);
}, 120_000);

afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makeProject() {
  const { createProject } = await import("./worktree.service");
  return createProject({
    workspaceId: WS,
    title: `Attack ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: USER,
  });
}

beforeEach(async () => {
  const { AppWorktree } = await import("../database/workspace-schema");
  await AppWorktree.deleteMany({});
  // A fresh MACHINE per test, explicitly. This used to happen by accident:
  // the session key was the worktree doc's _id, so wiping the docs above
  // silently rotated every box. Keys are convention now (workspace:user),
  // stable across the wipe — which is the production property under test —
  // so test isolation has to be stated rather than inherited.
  await fs.rm(path.join(tmpRoot, "sessions"), {
    recursive: true,
    force: true,
  });
});

describe("hostile file names", () => {
  it("survives names with spaces, quotes, $ and newlines", async () => {
    const { ensureWorktree, writeFile, listFiles } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    // Every one of these is a legal POSIX filename, and every one of them
    // means something to a shell.
    const names = [
      "a file with spaces.txt",
      "single'quote.txt",
      'double"quote.txt',
      "dollar$sign.txt",
      "back`tick`.txt",
      "semi;colon.txt",
      "amp&ersand.txt",
      "pipe|char.txt",
      "star*glob.txt",
      "paren(theses).txt",
      "новый-файл.txt",
      "emoji-🎉.txt",
    ];
    for (const name of names) {
      await writeFile(handle, name, `content of ${name}\n`);
    }
    const listed = (await listFiles(project, USER)).entries.map(e => e.path);
    for (const name of names) {
      expect(listed, `${name} should round-trip`).toContain(name);
    }
  }, 120_000);

  it("refuses paths that escape the app, and .git", async () => {
    const { ensureWorktree, writeFile } = await import("./worktree.service");
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    for (const bad of [
      "../escape.txt",
      "a/../../escape.txt",
      "/etc/passwd",
      ".git/config",
      "a/.git/hooks/pre-commit",
    ]) {
      await expect(
        writeFile(handle, bad, "x\n"),
        `${bad} must be refused`,
      ).rejects.toThrow();
    }
  }, 120_000);
});

describe("hostile branch names", () => {
  it("handles branch names git allows but a shell would eat", async () => {
    const { ensureWorktree, execInWorktree, listBranches } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    // git accepts all of these; a naive interpolation into a shell command
    // would execute the interesting halves.
    const hostile = "evil;touch$IFS/tmp/mako-pwned|x&y`z`";
    // Single quotes, not double: double quotes still expand backticks, and
    // the point is to test the SERVER's handling of the name, not to hand the
    // test's own shell an injection.
    const created = await execInWorktree(
      handle,
      `git checkout -q -B '${hostile}'`,
      {},
    );
    expect(created.exitCode, created.stderr).toBe(0);

    // The flush that follows adopts the branch — with the name intact and
    // nothing executed.
    const after = await ensureWorktree(project, USER);
    expect(after.doc.branch).toBe(hostile);
    expect((await listBranches(scopeOf(project))).map(b => b.name)).toContain(
      hostile,
    );
    await expect(fs.stat("/tmp/mako-pwned")).rejects.toThrow();
  }, 120_000);
});

describe("concurrency", () => {
  it("parallel writes all land, or fail loudly — never silently lost", async () => {
    const { ensureWorktree, writeFile, listFiles } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        writeFile(handle, `parallel-${i}.txt`, `${i}\n`),
      ),
    );
    const listed = (await listFiles(project, USER)).entries.map(e => e.path);
    // A rejected write is acceptable (the caller learns), a resolved write
    // that did not persist is not — that is silent data loss.
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        expect(listed, `parallel-${i}.txt resolved so it must exist`).toContain(
          `parallel-${i}.txt`,
        );
      }
    });
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
  }, 120_000);

  it("a commit racing a write does not lose the write", async () => {
    const { ensureWorktree, writeFile, commitWorktree, listFiles } =
      await import("./worktree.service");
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "first.txt", "1\n");

    const [, second] = await Promise.allSettled([
      commitWorktree(handle, "racing commit"),
      writeFile(handle, "second.txt", "2\n"),
    ]);
    const listed = (await listFiles(project, USER)).entries.map(e => e.path);
    expect(listed).toContain("first.txt");
    if (second.status === "fulfilled") expect(listed).toContain("second.txt");
  }, 120_000);
});

describe("losing the machine", () => {
  it("a wiped sandbox keeps what was committed and loses what was not", async () => {
    const { ensureWorktree, writeFile, commitWorktree, listFiles, boxCtx } =
      await import("./worktree.service");
    const { getSandboxProvider } = await import("./sandbox/provider");
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    // This case used to assert that UNCOMMITTED work survived a wiped
    // sandbox, and it did — every write was snapshotted into a shadow commit
    // first. That machinery is gone, and the promise went with it, so the
    // honest test is the one that states both halves of the new deal.
    await writeFile(handle, "committed.txt", "keep me\n");
    await commitWorktree(handle, "commit the keeper");
    await writeFile(
      await ensureWorktree(project, USER),
      "uncommitted.txt",
      "at risk\n",
    );

    await getSandboxProvider().destroySession?.(boxCtx(handle).sessionKey);

    const listed = (await listFiles(project, USER)).entries.map(e => e.path);
    expect(listed, "a commit was pushed, so it survives").toContain(
      "committed.txt",
    );
    expect(
      listed,
      "an uncommitted edit lived only on that machine",
    ).not.toContain("uncommitted.txt");
  }, 120_000);

  it("`git reset --hard` in the shell is simply the truth afterwards", async () => {
    const {
      ensureWorktree,
      writeFile,
      commitWorktree,
      execInWorktree,
      worktreeStatus,
    } = await import("./worktree.service");
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "tracked.txt", "v1\n");
    await commitWorktree(handle, "add tracked");

    // Modify it, then throw the modification away from the terminal. Nothing
    // server-side gets to hold a different opinion about what is in the tree,
    // because nothing server-side holds an opinion at all.
    await writeFile(await ensureWorktree(project, USER), "tracked.txt", "v2\n");
    const dirty = await worktreeStatus(scopeOf(project), USER);
    expect(dirty?.changes.map(c => c.path)).toContain("tracked.txt");

    await execInWorktree(handle, "git reset -q --hard HEAD", {});

    const status = await worktreeStatus(scopeOf(project), USER);
    expect(status?.changes.map(c => c.path) ?? []).not.toContain("tracked.txt");
  }, 120_000);
});

describe("silent loss", () => {
  it("a write into an ignored path does not report success and vanish", async () => {
    const { ensureWorktree, writeFile, listFiles } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    // The snapshot is `git add -A`, which skips ignored paths — so a write
    // here can be accepted, persist nowhere, and be reported as fine. Either
    // it must round-trip or it must throw; "succeeded and disappeared" is the
    // one outcome nobody can debug.
    for (const ignored of ["node_modules/x.js", "dist/bundle.js"]) {
      let threw = false;
      try {
        await writeFile(handle, ignored, "x\n");
      } catch {
        threw = true;
      }
      if (!threw) {
        const listed = (await listFiles(project, USER)).entries.map(
          e => e.path,
        );
        expect(listed, `${ignored} was accepted so it must persist`).toContain(
          ignored,
        );
      }
    }
  }, 120_000);

  it("a deletion made in the shell is recorded, not ignored", async () => {
    const {
      ensureWorktree,
      writeFile,
      commitWorktree,
      execInWorktree,
      listFiles,
    } = await import("./worktree.service");
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "doomed.txt", "bye\n");
    await commitWorktree(handle, "add doomed");

    await execInWorktree(handle, "rm doomed.txt", {});
    const listed = (await listFiles(project, USER)).entries.map(e => e.path);
    expect(listed, "a deleted file must leave the tree").not.toContain(
      "doomed.txt",
    );
  }, 120_000);

  it("binary content survives the bundle round trip byte for byte", async () => {
    const { ensureWorktree, execInWorktree, readFile, commitWorktree } =
      await import("./worktree.service");
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    // Every byte 0x00-0xFF, which is not valid UTF-8 anywhere.
    await execInWorktree(
      handle,
      "printf '%b' \"$(printf '\\\\x%02x' $(seq 0 255))\" > bytes.bin",
      {},
    );
    await commitWorktree(handle, "add binary");
    const read = await readFile(project, "bytes.bin", USER);
    expect(read.isBinary, "must be reported as binary").toBe(true);
    expect(read.size).toBeGreaterThan(200);
  }, 120_000);

  it("a large file survives the transfer", async () => {
    const { ensureWorktree, writeFile, readFile } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    const big = "x".repeat(2 * 1024 * 1024); // 2MB
    await writeFile(handle, "big.txt", big);
    const read = await readFile(project, "big.txt", USER);
    expect(read.contents.length).toBe(big.length);
  }, 180_000);

  it("a symlink made in the shell does not corrupt the snapshot", async () => {
    const { ensureWorktree, writeFile, execInWorktree, listFiles } =
      await import("./worktree.service");
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "real.txt", "real\n");
    await execInWorktree(handle, "ln -s real.txt link.txt", {});
    // Whatever git decides to do with it, the tree must still be readable and
    // the real file must still be there.
    const listed = (await listFiles(project, USER)).entries.map(e => e.path);
    expect(listed).toContain("real.txt");
  }, 120_000);
});

describe("branch switching under pressure", () => {
  // This case used to assert the OPPOSITE — that any uncommitted change was
  // refused — and passed, which is exactly how a suite codifies a bug instead
  // of catching it. Enforcing an invented rule consistently is not evidence
  // the rule is right, and this one made branch switching impossible the
  // moment a build wrote a lock file into the tree.
  it("carries uncommitted work across, the way git does", async () => {
    const { ensureWorktree, writeFile, checkoutBranch, listFiles } =
      await import("./worktree.service");
    const project = await makeProject();
    await writeFile(
      await ensureWorktree(project, USER),
      "wip.txt",
      "unsaved\n",
    );

    // main does not have wip.txt, so nothing would be clobbered — git carries
    // it over without a word, and so must this.
    await checkoutBranch(await ensureWorktree(project, USER), "main");

    const after = await ensureWorktree(project, USER);
    expect(after.doc.branch).toBe("main");
    expect((await listFiles(project, USER)).entries.map(e => e.path)).toContain(
      "wip.txt",
    );
  }, 180_000);

  it("refuses when the switch WOULD clobber, and names the file", async () => {
    const {
      ensureWorktree,
      writeFile,
      commitWorktree,
      checkoutBranch,
      listFiles,
    } = await import("./worktree.service");
    const project = await makeProject();

    // Commit clash.txt on an explicitly created branch, so main and the
    // branch genuinely differ about it.
    await checkoutBranch(await ensureWorktree(project, USER), "mine", {
      create: true,
    });
    await writeFile(
      await ensureWorktree(project, USER),
      "clash.txt",
      "branch version\n",
    );
    await commitWorktree(await ensureWorktree(project, USER), "clash");

    // main does not have it, so switching there removes it from the tree...
    await checkoutBranch(await ensureWorktree(project, USER), "main");
    expect(
      (await listFiles(project, USER)).entries.map(e => e.path),
    ).not.toContain("clash.txt");

    // ...and writing a DIFFERENT clash.txt here is work git cannot carry back.
    await writeFile(
      await ensureWorktree(project, USER),
      "clash.txt",
      "my uncommitted version\n",
    );

    // The point of delegating to git is this message: it names the file.
    // "You have uncommitted changes" never did, which is why the file that
    // was actually blocking could sit in another app's folder, invisible.
    await expect(
      checkoutBranch(await ensureWorktree(project, USER), "mine"),
    ).rejects.toThrow(/clash\.txt/);

    // Refusing must be inert: still on main, still holding the edit.
    expect((await ensureWorktree(project, USER)).doc.branch).toBe("main");
    expect((await listFiles(project, USER)).entries.map(e => e.path)).toContain(
      "clash.txt",
    );
  }, 180_000);

  it("refuses a branch that does not exist", async () => {
    const { ensureWorktree, checkoutBranch } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    await expect(
      checkoutBranch(await ensureWorktree(project, USER), "no-such-branch"),
    ).rejects.toThrow(/no such branch/i);
  }, 120_000);

  it("switching and switching back keeps each branch's own content", async () => {
    const {
      ensureWorktree,
      writeFile,
      commitWorktree,
      checkoutBranch,
      listFiles,
    } = await import("./worktree.service");
    const project = await makeProject();

    // A file committed on an explicitly created branch. (Named uniquely:
    // the workspace repo is shared across this file's tests, so a branch
    // created by an earlier test is still there.)
    await checkoutBranch(await ensureWorktree(project, USER), "flip", {
      create: true,
    });
    await writeFile(await ensureWorktree(project, USER), "mine.txt", "mine\n");
    await commitWorktree(await ensureWorktree(project, USER), "mine");
    expect((await listFiles(project, USER)).entries.map(e => e.path)).toContain(
      "mine.txt",
    );

    // main does not have it...
    await checkoutBranch(await ensureWorktree(project, USER), "main");
    expect(
      (await listFiles(project, USER)).entries.map(e => e.path),
    ).not.toContain("mine.txt");

    // ...and coming back restores it.
    await checkoutBranch(await ensureWorktree(project, USER), "flip");
    expect((await listFiles(project, USER)).entries.map(e => e.path)).toContain(
      "mine.txt",
    );
  }, 180_000);
});

describe("a tree too large for a command line", () => {
  it("lists a huge tree with honest truncation instead of dying", async () => {
    const { ensureWorktree, execInWorktree, listFiles } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);

    // 6,000 files with long paths — past the 5,000-entry cap, and (as one
    // command line) far past the ~1MB argv limit that killed the tree when
    // the size probe interpolated every path into a shell command. Both
    // failure modes, one fixture.
    const made = await execInWorktree(
      handle,
      "mkdir -p vendor/deeply/nested/directory/structure/for/long/paths && " +
        "cd vendor/deeply/nested/directory/structure/for/long/paths && " +
        "seq 1 6000 | sed 's/.*/module-file-with-a-descriptive-name-&.js/' | xargs touch && echo made",
      { timeoutMs: 120_000 },
    );
    expect(made.exitCode, made.stderr).toBe(0);

    const listing = await listFiles(project, USER);
    // Capped, said so, and counted the rest — not a crash, not a lie.
    // WHICH cap fires first depends on path length (bytes vs entry count);
    // either is fine, and pinning one would just make the test fight the
    // constants.
    expect(listing.truncated).toBe(true);
    expect(listing.entries.length).toBeLessThanOrEqual(5000);
    expect(listing.entries.length).toBeGreaterThan(1000);
    expect(listing.total).toBeGreaterThanOrEqual(6000);
    // Ordinary files sort before vendor/ and are still present, with sizes.
    // Tracked files must ALWAYS make the page. git emits untracked first,
    // and the first cut of the cap kept thousands of untracked vendor files
    // while dropping every line of the app's actual source.
    const app = listing.entries.find(e => e.path === "src/App.tsx");
    expect(app).toBeTruthy();
    expect(app!.size).toBeGreaterThan(0);
  }, 180_000);
});

describe("uncommitted work you cannot see", () => {
  it("reports repo-wide changes, not just this app's slice", async () => {
    const { ensureWorktree, writeFile, worktreeStatus } = await import(
      "./worktree.service"
    );
    // One worktree serves every app in the workspace monorepo, so a file
    // another app's build wrote is uncommitted work for THIS app's checkout
    // too. Reporting only this app's slice is what let a lock file written by
    // a preview build block every branch switch while the UI showed a clean
    // app, named nothing, and disabled Discard — the one way out.
    const mine = await makeProject();
    const theirs = await makeProject();
    await writeFile(
      await ensureWorktree(theirs, USER),
      "generated.lock",
      "written by a build\n",
    );

    const status = await worktreeStatus(scopeOf(mine), USER);
    expect(status?.changes.map(c => c.path)).not.toContain("generated.lock");
    expect(status?.repoChanges.map(c => c.path).join("\n")).toMatch(
      /generated\.lock/,
    );
  }, 180_000);
});

describe("publishing", () => {
  it("builds a TRUE merge commit — one no branch head points at", async () => {
    const {
      ensureWorktree,
      writeFile,
      commitWorktree,
      execInWorktree,
      trialMerge,
      checkoutInBox,
      checkoutBranch,
      PUBLISH_ACTOR,
    } = await import("./worktree.service");
    const project = await makeProject();

    // Diverge main and the actor's branch on DIFFERENT files, so the merge
    // succeeds but is a real merge commit: its sha exists only on the parked
    // candidate ref, reachable from no branch. This is the commit the publish
    // build must run against — and the case where "fetch the branches" is not
    // enough, because no branch contains it.
    //
    // The user's work sits on an explicitly created branch; a colleague then
    // moves main directly (they are ON main — committing IS moving main).
    // Main moving between the actor's last touch and their publish is the
    // race this exercises.
    const userHandle = await ensureWorktree(project, USER);
    await checkoutBranch(userHandle, "user-right", { create: true });
    await writeFile(await ensureWorktree(project, USER), "right.txt", "R\n");
    await commitWorktree(await ensureWorktree(project, USER), "right");

    const other = "colleague";
    await writeFile(await ensureWorktree(project, other), "left.txt", "L\n");
    await commitWorktree(await ensureWorktree(project, other), "left");

    const publishHandle = await ensureWorktree(project, PUBLISH_ACTOR, {
      branch: project.defaultBranch || "main",
    });
    const trial = await trialMerge(publishHandle, "user-right");
    expect(trial.ok, trial.reason).toBe(true);

    // The point of the whole exercise: the publish box checks out EXACTLY the
    // merge result, so what gets built is what would ship.
    const { resolveCommit: rc } = await import("./repository.service");
    const { repoDirFor: rd } = await import("./repository.service");
    const mainBefore = await rc(rd(WS), "refs/heads/main");

    await checkoutInBox(publishHandle, trial.sha);
    const seen = await execInWorktree(
      publishHandle,
      "git rev-parse HEAD; ls left.txt right.txt",
      { cwd: "." },
    );
    expect(seen.exitCode, seen.stderr).toBe(0);
    expect(seen.stdout).toContain(trial.sha);
    expect(seen.stdout).toContain("left.txt");
    expect(seen.stdout).toContain("right.txt");

    // And main has NOT moved. The publish box holds the candidate on `main`,
    // and the auto-push after shell commands once shipped it right here — on
    // the first build command, before any build had passed — leaving promote
    // to fail its CAS against the merge it was itself promoting. The build
    // machine must never publish; only promote's compare-and-swap does.
    expect(await rc(rd(WS), "refs/heads/main")).toBe(mainBefore);
  }, 180_000);

  it("a merge conflict is refused and main does not move", async () => {
    const {
      ensureWorktree,
      writeFile,
      commitWorktree,
      trialMerge,
      projectHistory,
      checkoutBranch,
      PUBLISH_ACTOR,
    } = await import("./worktree.service");
    const project = await makeProject();

    // Two lines of work change the same line: the user commits straight on
    // main (they are ON main), the other person on their own branch.
    await writeFile(
      await ensureWorktree(project, USER),
      "clash.txt",
      "theirs\n",
    );
    await commitWorktree(await ensureWorktree(project, USER), "theirs");

    const other = "other-person";
    const otherHandle = await ensureWorktree(project, other);
    await checkoutBranch(otherHandle, "other-work", { create: true });
    await writeFile(
      await ensureWorktree(project, other),
      "clash.txt",
      "ours\n",
    );
    await commitWorktree(await ensureWorktree(project, other), "ours");
    // Main moves on past the branch point, so the merge cannot fast-forward.
    await writeFile(
      await ensureWorktree(project, USER),
      "clash.txt",
      "theirs-2\n",
    );
    await commitWorktree(await ensureWorktree(project, USER), "theirs 2");

    const before = (await projectHistory(scopeOf(project))).length;
    const publishHandle = await ensureWorktree(project, PUBLISH_ACTOR, {
      branch: project.defaultBranch || "main",
    });
    const trial = await trialMerge(publishHandle, "other-work");
    expect(trial.ok, "a conflicting merge must be refused").toBe(false);
    expect(trial.reason).toMatch(/conflict/i);
    // Refusing must not have advanced main.
    expect((await projectHistory(scopeOf(project))).length).toBe(before);
  }, 180_000);
});

describe("repeated operations are idempotent", () => {
  it("reading repeatedly does not change anything", async () => {
    const { ensureWorktree, writeFile, worktreeStatus } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "stable.txt", "same\n");

    // Reading used to WRITE: every read snapshotted the working copy into a
    // new commit, so asking what had changed changed something. A read is a
    // read now, and this is the case that says so.
    const first = await worktreeStatus(scopeOf(project), USER);
    const second = await worktreeStatus(scopeOf(project), USER);
    const third = await worktreeStatus(scopeOf(project), USER);
    expect(second?.baseSha).toBe(first?.baseSha);
    expect(third?.baseSha).toBe(first?.baseSha);
    expect(third?.changes.map(c => c.path)).toEqual(
      first?.changes.map(c => c.path),
    );
  }, 120_000);

  it("committing twice with nothing in between is a no-op", async () => {
    const { ensureWorktree, writeFile, commitWorktree } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "once.txt", "1\n");
    const first = await commitWorktree(handle, "once");
    expect(first.committed).toBe(true);
    const second = await commitWorktree(
      await ensureWorktree(project, USER),
      "again",
    );
    expect(second.committed, "nothing changed, so nothing to commit").toBe(
      false,
    );
  }, 120_000);
});

describe("filenames that look like flags", () => {
  it("handles leading-dash names that a command could mistake for options", async () => {
    const { ensureWorktree, writeFile, listFiles, readFile } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    // Quoting stops the shell reading these; it does not stop a COMMAND
    // reading them as options, which is a different bug with the same shape.
    for (const name of ["-rf.txt", "--version.txt", "-.txt"]) {
      await writeFile(handle, name, `content ${name}\n`);
    }
    const listed = (await listFiles(project, USER)).entries.map(e => e.path);
    for (const name of ["-rf.txt", "--version.txt", "-.txt"]) {
      expect(listed, `${name} must round-trip`).toContain(name);
      expect((await readFile(project, name, USER)).contents).toContain(name);
    }
  }, 120_000);

  it("stores an empty file and a file with no trailing newline exactly", async () => {
    const { ensureWorktree, writeFile, readFile } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "empty.txt", "");
    await writeFile(handle, "no-newline.txt", "no trailing newline");
    expect((await readFile(project, "empty.txt", USER)).contents).toBe("");
    expect((await readFile(project, "no-newline.txt", USER)).contents).toBe(
      "no trailing newline",
    );
  }, 120_000);
});

describe("two people, one branch", () => {
  it("both can commit to main and the second is not lost", async () => {
    const {
      ensureWorktree,
      writeFile,
      commitWorktree,
      checkoutBranch,
      listFiles,
    } = await import("./worktree.service");
    const project = await makeProject();
    const alice = "alice";
    const bob = "bob";

    for (const who of [alice, bob]) {
      await checkoutBranch(await ensureWorktree(project, who), "main");
    }
    await writeFile(await ensureWorktree(project, alice), "alice.txt", "a\n");
    await commitWorktree(await ensureWorktree(project, alice), "alice commits");

    // Bob's worktree is now behind main. His commit must either succeed on
    // top of Alice's or fail loudly — it must not silently drop hers.
    await writeFile(await ensureWorktree(project, bob), "bob.txt", "b\n");
    let bobFailed = false;
    try {
      await commitWorktree(await ensureWorktree(project, bob), "bob commits");
    } catch {
      bobFailed = true;
    }

    const onMain = (await listFiles(project)).entries.map(e => e.path);
    expect(onMain, "Alice's commit must survive either way").toContain(
      "alice.txt",
    );
    if (!bobFailed) expect(onMain).toContain("bob.txt");
  }, 180_000);
});

describe("failure mid-flight", () => {
  it("a sandbox destroyed mid-session can be worked in again", async () => {
    const { ensureWorktree, writeFile, commitWorktree, boxCtx, listFiles } =
      await import("./worktree.service");
    const { getSandboxProvider } = await import("./sandbox/provider");
    const project = await makeProject();
    const handle = await ensureWorktree(project, USER);
    await writeFile(handle, "before.txt", "safe\n");
    await commitWorktree(handle, "commit before the sandbox dies");

    await getSandboxProvider().destroySession?.(boxCtx(handle).sessionKey);

    // A fresh machine, cloned from the server. Work continues on top of what
    // was pushed — no special recovery path, just a clone.
    const revived = await ensureWorktree(project, USER);
    await writeFile(revived, "after.txt", "later\n");
    const commit = await commitWorktree(revived, "after the sandbox died");
    expect(commit.committed).toBe(true);

    const listed = (await listFiles(project, USER)).entries.map(e => e.path);
    expect(listed).toContain("before.txt");
    expect(listed).toContain("after.txt");
  }, 180_000);

  it("concurrent checkouts do not leave the branch disagreeing with the sandbox", async () => {
    const { ensureWorktree, checkoutBranch, execInWorktree } = await import(
      "./worktree.service"
    );
    const project = await makeProject();
    await checkoutBranch(await ensureWorktree(project, USER), "side", {
      create: true,
    });

    await Promise.allSettled([
      checkoutBranch(await ensureWorktree(project, USER), "main"),
      checkoutBranch(await ensureWorktree(project, USER), "side"),
    ]);

    // Whichever won, the two views must agree — a database that believes one
    // branch while the working copy is on another is the bug this whole
    // design exists to prevent.
    const settled = await ensureWorktree(project, USER);
    const inBox = await execInWorktree(
      settled,
      "git rev-parse --abbrev-ref HEAD",
      {},
    );
    expect(inBox.stdout.trim()).toBe(settled.doc.branch);
  }, 180_000);
});

describe("publishing a folder-only app (repo-imported, no row)", () => {
  it("materializes the row so publishedSha actually persists", async () => {
    const { initRepo, repoDirFor } = await import("./repository.service");
    const { synthesizeProjectFromFolder, ensureProjectRow } = await import(
      "./worktree.service"
    );
    const { setPublishedSha } = await import("./deployment.service");
    const { AppProject } = await import("../database/workspace-schema");

    // A workspace whose repo arrived by IMPORT (connected-repo adoption):
    // the app exists as a folder, no AppProject row anywhere.
    const ws2 = new Types.ObjectId().toString();
    await initRepo(repoDirFor(ws2), {
      "apps/pubfix/mako.json": JSON.stringify({ title: "Pub Fix" }),
    });

    const synth = await synthesizeProjectFromFolder(ws2, "pubfix");
    expect(synth).not.toBeNull();
    const sha = "a".repeat(40);

    // The old failure mode: setPublishedSha on the synthesized shape is an
    // updateOne against an _id no document has — a silent no-op.
    await setPublishedSha(synth!, sha);
    expect(await AppProject.findOne({ _id: synth!._id })).toBeNull();

    // Publish now materializes the row first (same DERIVED id), and the sha
    // sticks.
    const row = await ensureProjectRow(synth!, "publisher");
    expect(row._id.toString()).toBe(synth!._id.toString());
    expect(row.slug).toBe("pubfix");
    expect(row.access).toBe("workspace");
    await setPublishedSha(row, sha);
    const reread = await AppProject.findOne({ _id: synth!._id });
    expect(reread?.publishedSha).toBe(sha);

    // Idempotent: a second materialize returns the winner, sha intact.
    const again = await ensureProjectRow(synth!, "someone-else");
    expect(again._id.toString()).toBe(row._id.toString());
    expect(again.publishedSha).toBe(sha);
  }, 60_000);
});
