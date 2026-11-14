/**
 * Someone's uncommitted work in their sandbox when ANOTHER member renames
 * the app it is in. A real sandbox (the local provider: a real clone, a real
 * shell) cloned from Mako's real git endpoint on a real port; the rename is
 * renameProject by another member; the catch-up is the box's own pull
 * (boxPull, what ensureBox / catchUpLiveBox run). Mongo in memory.
 *
 * Working copies are read with Node's fs (lstat, readlink, sha256) and git's
 * porcelain output only: nothing here depends on a BSD or GNU tool, or on
 * what git says in words.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
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
import { Types } from "mongoose";
import { loadAppsIndex } from "../app-index.service";
import {
  ensureBox,
  ensureWorktree,
  forgetBoxCaches,
  listFiles,
  moveProject,
  renameProject,
  resolveProjectRef,
  sessionKeyFor,
} from "../worktree.service";
import { boxPull, boxRoot } from "../box";
import { getBoxState } from "../box-state.service";
import { getSandboxProvider } from "../sandbox/provider";
import { startTestGitServer, type TestGitServer } from "../test-git-server";
import {
  externalCommit,
  fileAt,
  headOf,
  manifest,
  resetWorkspace,
  startScenarioEnv,
  type ScenarioEnv,
} from "./app-scenario-harness";

const run = promisify(execFile);

let env: ScenarioEnv;
let gitServer: TestGitServer;
beforeAll(async () => {
  env = await startScenarioEnv("app-rename-sandbox");
  process.env.SESSION_SECRET ||= "test-secret-for-git-tokens";
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
});
afterAll(async () => {
  await gitServer?.close();
  await env.stop();
});

const WS = new Types.ObjectId().toString();
const ME = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();
const MAIN_TSX = "line 1\nline 2\nline 3\nline 4\nline 5\n";
const MINE = MAIN_TSX.replace("line 2", "MINE");

beforeEach(async () => {
  await resetWorkspace(env, WS, {
    "apps/a/mako.json": manifest("A"),
    "apps/a/src/main.tsx": MAIN_TSX,
    "apps/a/src/other.ts": "export const other = 1;\n",
    "apps/x/mako.json": manifest("X"),
    "apps/x/src/main.tsx": "export const x = 1;\n",
  });
  forgetBoxCaches(sessionKeyFor(WS, ME));
});

const app = async (ref: string) => {
  const project = await resolveProjectRef(WS, ref);
  if (!project) throw new Error(`no app at ${ref}`);
  return project;
};

/** Another member renames the app (the rename service: one commit on main). */
const rename = async (ref: string, slug: string) =>
  renameProject(await app(ref), { slug }, { userId: OTHER });

/** My sandbox: a real clone from the git endpoint, on main. */
async function myBox() {
  const ctx = await ensureBox(await ensureWorktree(await app("a"), ME));
  const root = boxRoot(ctx);
  const sh = async (command: string) => {
    const r = await getSandboxProvider().exec(ctx, command, {
      cwd: "",
      timeoutMs: 60_000,
    });
    if (r.exitCode !== 0) throw new Error(`${command}: ${r.stderr}`);
    return r.stdout;
  };
  const git = (args: string) => sh(`git -C '${root}' ${args}`);
  const abs = (rel: string) => path.join(root, rel);
  const write = async (rel: string, contents: string, mode?: number) => {
    await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
    await fs.writeFile(abs(rel), contents, "utf8");
    if (mode) await fs.chmod(abs(rel), mode);
  };
  const read = (rel: string) => fs.readFile(abs(rel), "utf8").catch(() => null);
  const lstat = (rel: string) => fs.lstat(abs(rel)).catch(() => null);
  const status = async () =>
    (await git("status --porcelain=v1 --untracked-files=all"))
      .split("\n")
      .filter(Boolean)
      .sort();
  const head = async () => (await git("rev-parse HEAD")).trim();
  const branches = async () =>
    (await git("branch --list 'mako-drafts/*' --format='%(refname:short)'"))
      .split("\n")
      .filter(Boolean);
  return {
    ctx,
    root,
    sh,
    git,
    abs,
    write,
    read,
    lstat,
    status,
    head,
    branches,
  };
}
type MyBox = Awaited<ReturnType<typeof myBox>>;

const notice = async () => (await getBoxState(sessionKeyFor(WS, ME)))?.notice;

/** Every file and symlink under `root`, outside .git. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (rel: string) => {
    for (const entry of await fs.readdir(path.join(root, rel), {
      withFileTypes: true,
    })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (child === ".git") continue;
      if (entry.isDirectory()) await visit(child);
      else out.push(child);
    }
  };
  await visit("");
  return out.sort();
}

/** No conflict markers anywhere in the working copy (tracked or not). */
async function expectNoMarkers(root: string) {
  const marked: string[] = [];
  for (const rel of await walk(root)) {
    if (!(await fs.lstat(path.join(root, rel))).isFile()) continue;
    const text = await fs.readFile(path.join(root, rel), "utf8");
    if (/^(<<<<<<<|>>>>>>>) /m.test(text)) marked.push(rel);
  }
  expect(marked).toEqual([]);
}

/**
 * Everything about a working copy a person could notice: HEAD, the index
 * entry by entry (staged or not, modes), status, and every file's bytes and
 * mode outside .git — ignored files included. Node's fs, not shell tools:
 * `stat -f` is a file's mode on BSD and the FILESYSTEM's on GNU.
 */
async function snapshotOf(box: MyBox) {
  return {
    head: await box.head(),
    index: await box.git("ls-files -s"),
    status: await box.status(),
    staged: await box.git("diff --cached"),
    unstaged: await box.git("diff"),
    files: await Promise.all(
      (await walk(box.root)).map(async rel => {
        const stat = await fs.lstat(box.abs(rel));
        if (stat.isSymbolicLink()) {
          return `${rel} link -> ${await fs.readlink(box.abs(rel))}`;
        }
        const hash = createHash("sha256")
          .update(await fs.readFile(box.abs(rel)))
          .digest("hex");
        return `${rel} ${(stat.mode & 0o777).toString(8)} ${stat.size} ${hash}`;
      }),
    ),
  };
}

describe("git's own --autostash, measured (why it is not used)", () => {
  it("follows the rename, but on a conflicting edit leaves conflict markers in the person's file — and exits 0", async () => {
    const dir = await fs.mkdtemp(path.join(env.tmpRoot, "autostash-"));
    const git = (cwd: string, ...args: string[]) =>
      run("git", [
        ...["-C", `${dir}/${cwd}`],
        ...["-c", "user.email=a@a", "-c", "user.name=A"],
        ...args,
      ]);
    await run("git", ["init", "-q", "--bare", "-b", "main", `${dir}/origin`]);
    await run("git", ["clone", "-q", `${dir}/origin`, `${dir}/up`]);
    await fs.mkdir(`${dir}/up/apps/a`, { recursive: true });
    await fs.writeFile(`${dir}/up/apps/a/main.tsx`, MAIN_TSX);
    await git("up", "add", "-A");
    await git("up", "commit", "-qm", "init");
    await git("up", "push", "-q", "origin", "HEAD:main");
    await run("git", ["clone", "-q", `${dir}/origin`, `${dir}/box`]);
    await fs.writeFile(`${dir}/box/apps/a/main.tsx`, MINE);
    await git("up", "mv", "apps/a", "apps/b");
    await fs.writeFile(
      `${dir}/up/apps/b/main.tsx`,
      MAIN_TSX.replace("line 2", "THEIRS"),
    );
    await git("up", "commit", "-qam", "rename and edit");
    await git("up", "push", "-q", "origin", "HEAD:main");
    await git("box", "fetch", "-q");
    // The command SUCCEEDS (execFile rejects on a non-zero exit)…
    await git("box", "merge", "--autostash", "--no-edit", "@{u}");
    // …the person's file, at the NEW path, now holds conflict markers…
    const file = await fs.readFile(`${dir}/box/apps/b/main.tsx`, "utf8");
    expect(file).toMatch(/^<<<<<<< /m);
    expect(file).toMatch(/^>>>>>>> /m);
    expect(file).toContain("MINE");
    expect(file).toContain("THEIRS");
    // …it is left unmerged in the index (porcelain v1: "UU")…
    const status = await git("box", "status", "--porcelain=v1");
    expect(status.stdout).toMatch(/^UU apps\/b\/main\.tsx$/m);
    // …and the stash entry is kept.
    const stashes = await git("box", "stash", "list");
    expect(stashes.stdout.trim().split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("my drafts when another member renames the app", () => {
  it("an edited file, a staged edit, a staged new file, a new file and a new folder follow the rename; I am told", async () => {
    const box = await myBox();
    await box.write("apps/a/src/main.tsx", MINE);
    await box.write("apps/a/src/other.ts", "export const other = 2;\n");
    await box.write("apps/a/src/staged.ts", "export const staged = 1;\n");
    await box.git("add apps/a/src/other.ts apps/a/src/staged.ts");
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await box.write("apps/a/lib/util/deep.ts", "export const deep = 1;\n");
    await rename("a", "acq");

    const outcome = await boxPull(box.ctx);
    expect(outcome?.plain).toBe(false);
    // Caught up: on main exactly, the old folder gone.
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.lstat("apps/a")).toBeNull();
    // Every draft in the renamed app, unstaged, nothing committed.
    expect(await box.read("apps/acq/src/main.tsx")).toBe(MINE);
    expect(await box.read("apps/acq/src/other.ts")).toBe(
      "export const other = 2;\n",
    );
    expect(await box.read("apps/acq/src/new.ts")).toBe(
      "export const fresh = true;\n",
    );
    expect(await box.read("apps/acq/lib/util/deep.ts")).toBe(
      "export const deep = 1;\n",
    );
    expect(await box.status()).toEqual([
      " M apps/acq/src/main.tsx",
      " M apps/acq/src/other.ts",
      "?? apps/acq/lib/util/deep.ts",
      "?? apps/acq/src/new.ts",
      "?? apps/acq/src/staged.ts",
    ]);
    await expectNoMarkers(box.root);
    // Everything carried: no drafts branch left behind.
    expect(await box.branches()).toEqual([]);
    expect((await notice())?.message).toBe(
      "Main renamed apps/a → apps/acq; your 5 uncommitted changes followed it.",
    );
  });

  it("a conflicting edit: caught up with main's version, no markers, mine saved on a branch the notice names", async () => {
    const box = await myBox();
    await box.write("apps/a/src/main.tsx", MINE);
    await box.write("apps/a/src/other.ts", "export const other = 2;\n");
    await rename("a", "acq");
    await externalCommit(WS, {
      "apps/acq/src/main.tsx": MAIN_TSX.replace("line 2", "THEIRS"),
    });

    const outcome = await boxPull(box.ctx);
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/acq/src/main.tsx")).toBe(
      MAIN_TSX.replace("line 2", "THEIRS"),
    );
    await expectNoMarkers(box.root);
    // The edit that did not conflict still followed the rename.
    expect(await box.status()).toEqual([" M apps/acq/src/other.ts"]);
    expect(outcome?.conflicted).toEqual(["apps/a/src/main.tsx"]);
    const [branch] = await box.branches();
    expect(branch).toMatch(/^mako-drafts\//);
    // Recoverable: my version, on the branch, at the path I wrote it.
    expect(await box.git(`show '${branch}:apps/a/src/main.tsx'`)).toBe(MINE);
    const said = await notice();
    expect(said?.draftsBranch).toBe(branch);
    expect(said?.message).toContain(
      "apps/a/src/main.tsx (main changed it too)",
    );
    expect(said?.message).toContain(`git checkout ${branch} -- <path>`);
  });

  it("a new file whose place in the renamed folder is taken stays where it was — both kept", async () => {
    const box = await myBox();
    await box.write("apps/a/src/dup.ts", "export const mine = true;\n");
    await box.write("apps/a/src/solo.ts", "export const solo = true;\n");
    await rename("a", "acq");
    await externalCommit(WS, {
      "apps/acq/src/dup.ts": "export const theirs = true;\n",
    });

    const outcome = await boxPull(box.ctx);
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/acq/src/dup.ts")).toBe(
      "export const theirs = true;\n",
    );
    expect(await box.read("apps/a/src/dup.ts")).toBe(
      "export const mine = true;\n",
    );
    expect(await box.read("apps/acq/src/solo.ts")).toBe(
      "export const solo = true;\n",
    );
    expect(outcome?.keptInPlace).toEqual(["apps/a/src/dup.ts"]);
    expect(await box.branches()).toEqual([]);
    expect((await notice())?.message).toContain(
      "apps/a/src/dup.ts stayed where it was",
    );
  });

  it("work in ANOTHER app takes the plain catch-up, exactly as before", async () => {
    const box = await myBox();
    await box.write("apps/x/src/main.tsx", "export const x = 2;\n");
    await box.write("apps/x/src/new.ts", "export const n = 1;\n");
    await rename("a", "acq");

    const outcome = await boxPull(box.ctx);
    expect(outcome?.plain).toBe(true);
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/acq/src/main.tsx")).toBe(MAIN_TSX);
    expect(await box.status()).toEqual([
      " M apps/x/src/main.tsx",
      "?? apps/x/src/new.ts",
    ]);
    expect(await box.branches()).toEqual([]);
    expect(await notice()).toBeUndefined();
  });

  it("…including when the plain merge refuses (main changed the very file I edited): nothing touched, nothing said", async () => {
    for (const renamed of [false, true]) {
      const box = await myBox();
      await box.write("apps/x/src/main.tsx", "export const x = 'mine';\n");
      await externalCommit(WS, {
        "apps/x/src/main.tsx": `export const x = 'theirs ${renamed}';\n`,
      });
      if (renamed) await rename("a", "acq");
      const before = await snapshotOf(box);

      const outcome = await boxPull(box.ctx);
      // With no rename on main the pull is the one command it always was.
      expect(outcome).toEqual(
        renamed
          ? expect.objectContaining({ plain: true, failed: "merge" })
          : null,
      );
      expect(await snapshotOf(box)).toEqual(before);
      expect(await box.branches()).toEqual([]);
      expect(await notice()).toBeUndefined();
    }
  });

  it("a member renames twice while I am dirty (a → b → c): my drafts land in c", async () => {
    const box = await myBox();
    await box.write("apps/a/src/main.tsx", MINE);
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await rename("a", "b");
    await rename("b", "c");
    await boxPull(box.ctx);
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/c/src/main.tsx")).toBe(MINE);
    expect(await box.read("apps/c/src/new.ts")).toBe(
      "export const fresh = true;\n",
    );
    expect(await fileAt(WS, "apps/c/src/new.ts")).toBeNull();
  });

  it("an app MOVED into a folder (another depth): my drafts follow; ignored leftovers stay, and confuse nothing", async () => {
    const box = await myBox();
    await box.write("apps/a/src/main.tsx", MINE);
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await box.write("apps/a/node_modules/vite/index.js", "export {};\n");
    await moveProject(
      await app("a"),
      { scope: "workspace", folderSegments: ["Team"] },
      { userId: OTHER, role: "admin" },
    );

    const outcome = await boxPull(box.ctx);
    expect(outcome?.renames).toEqual([{ from: "apps/a", to: "apps/Team/a" }]);
    expect(await box.status()).toEqual([
      " M apps/Team/a/src/main.tsx",
      "?? apps/Team/a/src/new.ts",
    ]);
    expect(await box.read("apps/Team/a/src/main.tsx")).toBe(MINE);
    // The ignored-only husk stays (relative links would not survive the
    // depth change; nothing is ever deleted)…
    expect(await box.read("apps/a/node_modules/vite/index.js")).toBe(
      "export {};\n",
    );
    // …and is invisible: git sees nothing there, so neither does Mako.
    const index = await loadAppsIndex(WS);
    expect(index.apps.map(a => a.path).sort()).toEqual([
      "apps/Team/a",
      "apps/x",
    ]);
    const { entries } = await listFiles(await app("apps/Team/a"), ME);
    expect(entries.map(e => e.path).sort()).toEqual([
      "mako.json",
      "src/main.tsx",
      "src/new.ts",
      "src/other.ts",
    ]);
  });
});

describe("the paths a catch-up rarely takes", () => {
  it("the catch-up's own merge of main fails (my local commits conflict): my tree and index are restored exactly — tracked, staged, untracked — and I am told, once", async () => {
    const box = await myBox();
    // A local commit, never pushed, that main will contradict.
    await box.write("apps/x/src/main.tsx", "export const x = 'local';\n");
    await box.git(`commit -q -am "local work"`);
    await externalCommit(WS, {
      "apps/x/src/main.tsx": "export const x = 'main';\n",
    });
    await rename("a", "acq");
    // Drafts of every kind, in the renamed app and outside it.
    await box.write("apps/a/src/main.tsx", MINE);
    await box.write("apps/a/src/other.ts", "export const other = 'staged';\n");
    await box.write("apps/a/src/staged-new.ts", "export const sn = 1;\n");
    await box.git("add apps/a/src/other.ts apps/a/src/staged-new.ts");
    // Staged, then edited again: index and work tree differ.
    await box.write("apps/a/src/other.ts", "export const other = 'again';\n");
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await box.write("apps/a/run.sh", "#!/bin/sh\necho hi\n", 0o755);
    await fs.symlink("src/main.tsx", box.abs("apps/a/link"));
    await box.write("apps/x/notes.md", "outside the renamed app\n");
    await box.write(
      "apps/a/node_modules/pkg/index.js",
      "module.exports = 1;\n",
    );
    const before = await snapshotOf(box);

    const outcome = await boxPull(box.ctx);
    expect(outcome?.failed).toBe("merge");
    expect(await snapshotOf(box)).toEqual(before);
    // …and also saved on a branch, which the notice names.
    expect(outcome?.draftsBranch).toMatch(/^mako-drafts\//);
    expect(await box.branches()).toEqual([outcome?.draftsBranch]);
    const said = await notice();
    expect(said?.message).toContain(
      "could not catch up with main, which renamed apps/a → apps/acq: commits made in the sandbox conflict with main in apps/x/src/main.tsx",
    );
    expect(said?.message).toContain(outcome?.draftsBranch);

    // The next pulls find the same refusal: no new branch, no new notice,
    // and still nothing touched.
    await boxPull(box.ctx);
    expect(await snapshotOf(box)).toEqual(before);
    expect(await box.branches()).toEqual([outcome?.draftsBranch]);
    expect((await notice())?.at).toBe(said?.at);
  });

  it("a merge of my own under way (unresolved): left to git, as before", async () => {
    const box = await myBox();
    await box.write("apps/x/src/main.tsx", "export const x = 'local';\n");
    await box.git(`commit -q -am "local work"`);
    await externalCommit(WS, {
      "apps/x/src/main.tsx": "export const x = 'main';\n",
    });
    await box.git("fetch -q origin");
    await box.sh(`git -C '${box.root}' merge --no-edit origin/main || true`);
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await rename("a", "acq");
    const before = await snapshotOf(box);

    expect(await boxPull(box.ctx)).toMatchObject({ plain: true });
    expect(await snapshotOf(box)).toEqual(before);
    expect(await box.lstat(".git/MERGE_HEAD")).not.toBeNull();
    expect(await box.branches()).toEqual([]);
  });

  it("one catch-up per sandbox at a time (two tabs, two API instances): while one is under way a second stands back; one that died mid-way is taken over, and I am told where it left my work", async () => {
    const box = await myBox();
    await box.write("apps/a/src/main.tsx", MINE);
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await rename("a", "acq");
    // Another catch-up of this box holds the lock.
    const lock = box.abs(".git/mako-catch-up.lock");
    await fs.mkdir(lock);
    const before = await snapshotOf(box);
    expect(await boxPull(box.ctx)).toBeNull();
    expect(await snapshotOf(box)).toEqual(before);

    // It died a quarter of an hour ago (an API restart), after saving the
    // drafts it had found on its branch.
    const orphan = "mako-drafts/20260101T000000";
    await box.git(`branch ${orphan}`);
    await fs.writeFile(box.abs(".git/mako-drafts-index.saved"), "");
    const then = new Date(Date.now() - 15 * 60_000);
    await fs.utimes(lock, then, then);
    expect((await boxPull(box.ctx))?.plain).toBe(false);
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.status()).toEqual([
      " M apps/acq/src/main.tsx",
      "?? apps/acq/src/new.ts",
    ]);
    const said = (await notice())?.message;
    expect(said).toContain(
      `An earlier catch-up of your sandbox was interrupted. The uncommitted changes you had then are saved on the branch ${orphan}`,
    );
    expect(said).toContain("your 2 uncommitted changes followed it.");
    // Its branch stays; nothing else of either catch-up is left.
    expect(await box.branches()).toEqual([orphan]);
    for (const left of [
      "catch-up.lock",
      "drafts-index",
      "drafts-index.saved",
    ]) {
      expect(await box.lstat(`.git/mako-${left}`), left).toBeNull();
    }
  });

  it("a step of the catch-up itself fails: before anything is touched, the plain merge as before; after, everything is on the branch and I am told", async () => {
    const provider = getSandboxProvider();
    const exec = provider.exec.bind(provider);
    /** The next command holding `step` fails, as a full disk or a timeout would. */
    const failing = (step: string) =>
      vi.spyOn(provider, "exec").mockImplementation((ctx, command, options) =>
        command.includes(step)
          ? Promise.resolve({
              ...{ exitCode: 128, stdout: "", stderr: "injected" },
              ...{ timedOut: false, durationMs: 1, truncated: false },
            })
          : exec(ctx, command, options),
      );
    const box = await myBox();
    await box.write("apps/a/src/main.tsx", MINE);
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await rename("a", "acq");
    const before = await snapshotOf(box);

    // Taking the snapshot fails: git's own refusal, nothing touched or said.
    let spy = failing("git add -u");
    expect(await boxPull(box.ctx)).toMatchObject({ plain: true });
    spy.mockRestore();
    expect(await snapshotOf(box)).toEqual(before);
    expect(await box.branches()).toEqual([]);
    expect(await notice()).toBeUndefined();

    // Carrying the drafts over fails after main was merged.
    spy = failing("cherry-pick --no-commit");
    const outcome = await boxPull(box.ctx);
    spy.mockRestore();
    expect(outcome?.failed).toBe("interrupted");
    expect(await box.head()).toBe(await headOf(WS));
    await expectNoMarkers(box.root);
    const [branch] = await box.branches();
    expect(await box.git(`show '${branch}:apps/a/src/main.tsx'`)).toBe(MINE);
    expect(await box.git(`show '${branch}:apps/a/src/new.ts'`)).toBe(
      "export const fresh = true;\n",
    );
    expect((await notice())?.message).toContain(
      `All of them are saved on the branch ${branch}`,
    );
    expect(await box.lstat(".git/mako-catch-up.lock")).toBeNull();
  });

  it("a detached HEAD: never caught up, never touched (as before); told once when main renamed a folder my drafts are in; back on the branch they come along", async () => {
    const box = await myBox();
    await box.git("checkout -q --detach HEAD");
    await box.write("apps/a/src/main.tsx", MINE);
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await rename("a", "acq");
    const before = await snapshotOf(box);

    const outcome = await boxPull(box.ctx);
    expect(outcome).toMatchObject({ plain: true, failed: "detached" });
    expect(await snapshotOf(box)).toEqual(before);
    const said = await notice();
    expect(said?.message).toContain(
      "not caught up with main — which renamed apps/a → apps/acq. Your 2 uncommitted changes there are untouched",
    );
    expect(said?.message).toContain("git checkout main");
    // The next pull says nothing new.
    await boxPull(box.ctx);
    expect((await notice())?.at).toBe(said?.at);
    // The advice works: back on main, the next catch-up carries them.
    await box.git("checkout -q main");
    expect((await boxPull(box.ctx))?.plain).toBe(false);
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/acq/src/main.tsx")).toBe(MINE);
    expect(await box.read("apps/acq/src/new.ts")).toBe(
      "export const fresh = true;\n",
    );
  });

  it("a detached HEAD with nothing in a renamed folder: as before, silently", async () => {
    const box = await myBox();
    await box.git("checkout -q --detach HEAD");
    await box.write("apps/x/src/main.tsx", "export const x = 2;\n");
    await rename("a", "acq");
    const before = await snapshotOf(box);
    expect(await boxPull(box.ctx)).toBeNull();
    expect(await snapshotOf(box)).toEqual(before);
    expect(await notice()).toBeUndefined();
  });
});

describe("ignored files (node_modules, dist) in a renamed app", () => {
  it("follow the rename — with drafts or without — so no husk of the old app is left and the dev server needs no reinstall", async () => {
    for (const dirty of [false, true]) {
      await resetWorkspace(env, WS, {
        "apps/a/mako.json": manifest("A"),
        "apps/a/src/main.tsx": MAIN_TSX,
      });
      forgetBoxCaches(sessionKeyFor(WS, ME));
      const box = await myBox();
      await box.write("apps/a/node_modules/vite/index.js", "export {};\n");
      await box.write("apps/a/node_modules/.bin/vite", "#!/bin/sh\n", 0o755);
      await box.write("apps/a/dist/index.html", "<html></html>\n");
      await box.write("apps/a/.vite/deps/x.js", "export {};\n");
      if (dirty) await box.write("apps/a/src/main.tsx", MINE);
      await rename("a", "acq");

      const outcome = await boxPull(box.ctx);
      expect(outcome?.plain, `dirty=${dirty}`).toBe(!dirty);
      expect(outcome?.ignoredMoved.map(m => m.to).sort()).toEqual([
        "apps/acq/.vite",
        "apps/acq/dist",
        "apps/acq/node_modules",
      ]);
      expect(await box.read("apps/acq/node_modules/vite/index.js")).toBe(
        "export {};\n",
      );
      const bin = await box.lstat("apps/acq/node_modules/.bin/vite");
      expect((bin?.mode ?? 0) & 0o111).not.toBe(0);
      expect(await box.read("apps/acq/dist/index.html")).toBe(
        "<html></html>\n",
      );
      expect(await box.lstat("apps/a")).toBeNull();
      expect(await box.status()).toEqual(
        dirty ? [" M apps/acq/src/main.tsx"] : [],
      );
    }
  });

  it("never replace what the renamed folder already has", async () => {
    const box = await myBox();
    await box.write("apps/a/node_modules/old/index.js", "old\n");
    await box.write("apps/a/dist/index.html", "old build\n");
    await rename("a", "acq");
    // Before the box catches up, the new folder got its own node_modules…
    await box.write("apps/acq/node_modules/new/index.js", "new\n");
    await boxPull(box.ctx);
    expect(await box.read("apps/acq/node_modules/new/index.js")).toBe("new\n");
    expect(await box.read("apps/acq/node_modules/old/index.js")).toBeNull();
    // …so the old one stays where it was; what had no namesake moved.
    expect(await box.read("apps/a/node_modules/old/index.js")).toBe("old\n");
    expect(await box.read("apps/acq/dist/index.html")).toBe("old build\n");
  });
});

describe("each draft comes back as what it was", () => {
  it("an untracked symlink — to a file, to a folder, dangling — is recreated as a symlink with the same target; an executable keeps its bit", async () => {
    const box = await myBox();
    await fs.symlink("src/main.tsx", box.abs("apps/a/link"));
    await fs.symlink("src", box.abs("apps/a/srclink"));
    await fs.symlink("does-not-exist.ts", box.abs("apps/a/dangling"));
    await box.write("apps/a/run.sh", "#!/bin/sh\necho hi\n", 0o755);
    await box.write("apps/a/it's here/a b.txt", "quoted\n");
    await rename("a", "acq");

    const outcome = await boxPull(box.ctx);
    expect(outcome?.stranded).toEqual([]);
    for (const [rel, target] of [
      ["link", "src/main.tsx"],
      ["srclink", "src"],
      ["dangling", "does-not-exist.ts"],
    ]) {
      expect((await box.lstat(`apps/acq/${rel}`))?.isSymbolicLink(), rel).toBe(
        true,
      );
      expect(await fs.readlink(box.abs(`apps/acq/${rel}`))).toBe(target);
    }
    // The links resolve as before: to a file, to a folder, to nothing.
    expect((await fs.stat(box.abs("apps/acq/link"))).isFile()).toBe(true);
    expect((await fs.stat(box.abs("apps/acq/srclink"))).isDirectory()).toBe(
      true,
    );
    await expect(fs.stat(box.abs("apps/acq/dangling"))).rejects.toThrow();
    const script = await box.lstat("apps/acq/run.sh");
    expect(script?.isFile()).toBe(true);
    expect((script?.mode ?? 0) & 0o111).not.toBe(0);
    expect(await box.read("apps/acq/it's here/a b.txt")).toBe("quoted\n");
    expect(await box.lstat("apps/a")).toBeNull();
    // Faithful, so nothing kept back: no recovery branch.
    expect(await box.branches()).toEqual([]);
  });

  it("a tracked symlink retargeted, and a tracked executable edited, are carried as a symlink and an executable", async () => {
    const box = await myBox();
    await fs.symlink("src/main.tsx", box.abs("apps/a/cfg"));
    await box.write("apps/a/build.sh", "#!/bin/sh\necho one\n", 0o755);
    await box.git("add apps/a/cfg apps/a/build.sh");
    await box.git(`commit -q -m "link and script"`);
    await box.git("push -q origin HEAD");
    // Drafts: retarget the link, edit the script.
    await fs.unlink(box.abs("apps/a/cfg"));
    await fs.symlink("src/other.ts", box.abs("apps/a/cfg"));
    await box.write("apps/a/build.sh", "#!/bin/sh\necho two\n");
    await rename("a", "acq");

    await boxPull(box.ctx);
    expect(await box.head()).toBe(await headOf(WS));
    expect((await box.lstat("apps/acq/cfg"))?.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(box.abs("apps/acq/cfg"))).toBe("src/other.ts");
    expect(
      ((await box.lstat("apps/acq/build.sh"))?.mode ?? 0) & 0o111,
    ).not.toBe(0);
    expect(await box.read("apps/acq/build.sh")).toBe("#!/bin/sh\necho two\n");
    expect(await box.status()).toEqual([
      " M apps/acq/build.sh",
      " M apps/acq/cfg",
    ]);
  });

  it("a symlink that is absolute, climbs out of the repository or points into .git is never recreated nor followed: kept on the branch, and the notice names it", async () => {
    const box = await myBox();
    const outside = path.join(env.tmpRoot, "outside-the-box");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, box.abs("apps/a/abs"));
    await fs.symlink("../../../escape", box.abs("apps/a/up"));
    await fs.symlink("../../.git/config", box.abs("apps/a/intogit"));
    await box.write("apps/a/src/fine.ts", "export {};\n");
    await rename("a", "acq");

    const outcome = await boxPull(box.ctx);
    expect(outcome?.strandedWhy).toEqual({
      "apps/a/abs": "escaping-link",
      "apps/a/intogit": "escaping-link",
      "apps/a/up": "escaping-link",
    });
    for (const rel of ["abs", "up", "intogit"]) {
      expect(await box.lstat(`apps/acq/${rel}`), rel).toBeNull();
    }
    // Nothing was written outside, and the draft that was fine followed.
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await box.read("apps/acq/src/fine.ts")).toBe("export {};\n");
    // The branch keeps them, as links.
    const [branch] = await box.branches();
    expect(branch).toMatch(/^mako-drafts\//);
    expect(
      (await box.git(`ls-tree '${branch}' -- apps/a/abs`)).split(/\s+/)[0],
    ).toBe("120000");
    const said = await notice();
    expect(said?.message).toContain(
      "apps/a/abs (a symbolic link pointing outside the repository, not recreated)",
    );
    expect(said?.message).toContain(branch);
  });

  it("a nested repository — with a commit, or with none (which git cannot even snapshot) — is left where it was, untouched, and named", async () => {
    const box = await myBox();
    const vendor = box.abs("apps/a/vendor");
    await fs.mkdir(vendor, { recursive: true });
    await run("git", ["init", "-q", vendor]);
    await fs.writeFile(path.join(vendor, "lib.js"), "module.exports = 1;\n");
    const v = ["-C", vendor, "-c", "user.email=v@v", "-c", "user.name=V"];
    await run("git", [...v, "add", "-A"]);
    await run("git", [...v, "commit", "-qm", "vendored"]);
    const empty = box.abs("apps/a/scratch-repo");
    await fs.mkdir(empty, { recursive: true });
    await run("git", ["init", "-q", empty]);
    await fs.writeFile(path.join(empty, "notes.md"), "wip\n");
    await box.write("apps/a/src/fine.ts", "export {};\n");
    await rename("a", "acq");

    const outcome = await boxPull(box.ctx);
    expect(outcome?.strandedWhy).toEqual({
      "apps/a/vendor": "unsupported",
      "apps/a/scratch-repo": "unsupported",
    });
    expect(await box.read("apps/a/vendor/lib.js")).toBe(
      "module.exports = 1;\n",
    );
    expect(await box.read("apps/a/scratch-repo/notes.md")).toBe("wip\n");
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/acq/src/fine.ts")).toBe("export {};\n");
    expect(await box.branches()).toHaveLength(1);
    expect((await notice())?.message).toContain(
      "apps/a/vendor (a nested repository, left where it was)",
    );
  });

  it("never writes a draft THROUGH a folder that main made a symbolic link", async () => {
    const box = await myBox();
    await box.write("apps/a/data/x.txt", "draft\n");
    await rename("a", "acq");
    // Main then makes apps/acq/data a link out of the repository.
    await externalCommit(
      WS,
      { "apps/acq/data": "../../../outside" },
      { "apps/acq/data": "120000" },
    );

    const outcome = await boxPull(box.ctx);
    expect(outcome?.strandedWhy).toEqual({
      "apps/a/data/x.txt": "linked-folder",
    });
    expect((await box.lstat("apps/acq/data"))?.isSymbolicLink()).toBe(true);
    await expect(
      fs.readFile(path.join(box.root, "..", "outside", "x.txt")),
    ).rejects.toThrow();
    const [branch] = await box.branches();
    expect(await box.git(`show '${branch}:apps/a/data/x.txt'`)).toBe("draft\n");
  });
});
