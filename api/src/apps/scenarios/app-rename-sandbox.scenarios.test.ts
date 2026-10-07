/**
 * Someone's uncommitted work in their sandbox when ANOTHER member renames
 * the app it is in. A real sandbox (the local provider: a real clone, a real
 * shell) cloned from Mako's real git endpoint on a real port; the rename is
 * rename_object by another member; the catch-up is the box's own pull
 * (boxPull, what ensureBox / catchUpLiveBox run). Mongo in memory.
 *
 *  - git's `merge --autostash`, measured here: it follows the rename, but a
 *    conflicting edit ends as conflict markers in the person's file, exit 0;
 *  - an edited file, a staged file, a new file, a new folder: follow the
 *    rename into the new folder;
 *  - a conflicting edit: the box ends caught up with main's version and no
 *    markers; the person's version is on a `mako-drafts/…` branch, and the
 *    message names it;
 *  - a new file whose new place is taken: kept at its old path;
 *  - work in another app: exactly as before (the plain merge).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { renameObject } from "../../rename/registry";
import { invalidateAppsIndexCache, loadAppsIndex } from "../app-index.service";
import {
  ensureBox,
  ensureWorktree,
  forgetBoxCaches,
  listFiles,
  resolveProjectRef,
  sessionKeyFor,
} from "../worktree.service";
import { boxPull, boxRoot } from "../box";
import { getBoxState } from "../box-state.service";
import { getSandboxProvider } from "../sandbox/provider";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  repoDirFor,
} from "../repository.service";
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
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
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
const other = { workspaceId: WS, userId: OTHER, role: "admin" };
const MAIN_TSX = "line 1\nline 2\nline 3\nline 4\nline 5\n";

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

/** My sandbox, cloned and on main. */
async function myBox() {
  const handle = await ensureWorktree((await resolveProjectRef(WS, "a"))!, ME);
  // A real box: cloned from the git endpoint, on main.
  const ctx = await ensureBox(handle);
  const root = boxRoot(ctx);
  const sh = async (command: string) => {
    const r = await getSandboxProvider().exec(ctx, command, {
      cwd: "",
      timeoutMs: 60_000,
    });
    if (r.exitCode !== 0) throw new Error(`${command}: ${r.stderr}`);
    return r.stdout;
  };
  const write = async (rel: string, contents: string) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), contents, "utf8");
  };
  const read = (rel: string) =>
    fs.readFile(path.join(root, rel), "utf8").catch(() => null);
  const status = async () =>
    (await sh(`git -C '${root}' status --porcelain=v1 --untracked-files=all`))
      .split("\n")
      .filter(Boolean)
      .sort();
  const head = async () => (await sh(`git -C '${root}' rev-parse HEAD`)).trim();
  const branches = async () =>
    (
      await sh(
        `git -C '${root}' branch --list 'mako-drafts/*' --format='%(refname:short)'`,
      )
    )
      .split("\n")
      .filter(Boolean);
  return { ctx, root, sh, write, read, status, head, branches };
}

async function noticeFor(): Promise<string | undefined> {
  return (await getBoxState(sessionKeyFor(WS, ME)))?.notice?.message;
}

/** Every regular file and symlink under `root`, outside .git. */
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
    const stat = await fs.lstat(path.join(root, rel));
    if (!stat.isFile()) continue;
    const text = await fs.readFile(path.join(root, rel), "utf8");
    if (/^(<<<<<<<|>>>>>>>) /m.test(text)) marked.push(rel);
  }
  expect(marked).toEqual([]);
}

describe("git's own --autostash, measured", () => {
  it("follows the rename, but leaves conflict markers in the person's file on a conflicting edit — and exits 0", async () => {
    const dir = await fs.mkdtemp(path.join(env.tmpRoot, "autostash-"));
    const g = (...args: string[]) =>
      run("git", [
        "-C",
        dir,
        "-c",
        "user.email=a@a",
        "-c",
        "user.name=A",
        ...args,
      ]);
    await run("git", [
      "init",
      "-q",
      "--bare",
      "-b",
      "main",
      `${dir}/origin.git`,
    ]);
    await run("git", ["clone", "-q", `${dir}/origin.git`, `${dir}/up`]);
    await run("git", ["clone", "-q", `${dir}/origin.git`, `${dir}/box`]).catch(
      () => undefined,
    );
    const up = (...args: string[]) => g("-C", "up", ...args);
    const box = (...args: string[]) => g("-C", "box", ...args);
    await fs.mkdir(`${dir}/up/apps/a`, { recursive: true });
    await fs.writeFile(`${dir}/up/apps/a/main.tsx`, MAIN_TSX);
    await up("add", "-A");
    await up("commit", "-qm", "init");
    await up("push", "-q", "origin", "HEAD:main");
    await fs.rm(`${dir}/box`, { recursive: true, force: true });
    await run("git", ["clone", "-q", `${dir}/origin.git`, `${dir}/box`]);
    await fs.writeFile(
      `${dir}/box/apps/a/main.tsx`,
      MAIN_TSX.replace("line 2", "MINE"),
    );
    await up("mv", "apps/a", "apps/b");
    await fs.writeFile(
      `${dir}/up/apps/b/main.tsx`,
      MAIN_TSX.replace("line 2", "THEIRS"),
    );
    await up("commit", "-qam", "rename and edit");
    await up("push", "-q", "origin", "HEAD:main");
    await box("fetch", "-q");
    // Behaviour, not git's wording (which differs between versions): the
    // command SUCCEEDS (execFile rejects on a non-zero exit)…
    await box("merge", "--autostash", "--no-edit", "@{u}");
    // …the person's file, at the NEW path, now holds conflict markers…
    const file = await fs.readFile(`${dir}/box/apps/b/main.tsx`, "utf8");
    expect(file).toMatch(/^<<<<<<< /m);
    expect(file).toMatch(/^>>>>>>> /m);
    expect(file).toContain("MINE");
    expect(file).toContain("THEIRS");
    // …it is left unmerged in the index (porcelain v1: "UU")…
    const status = await box("status", "--porcelain=v1");
    expect(status.stdout).toMatch(/^UU apps\/b\/main\.tsx$/m);
    // …and the stash entry is kept.
    const stashes = await box("stash", "list");
    expect(stashes.stdout.trim().split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("my drafts when another member renames the app", () => {
  it("an edited file, a staged edit, a new file and a new folder follow the rename; I am told", async () => {
    const box = await myBox();
    await box.write("apps/a/src/main.tsx", MAIN_TSX.replace("line 2", "MINE"));
    await box.write("apps/a/src/other.ts", "export const other = 2;\n");
    await box.sh(`git -C '${box.root}' add apps/a/src/other.ts`);
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await box.write("apps/a/lib/util/deep.ts", "export const deep = 1;\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });
    const main = await headOf(WS);

    const outcome = await boxPull(box.ctx);
    expect(outcome?.plain).toBe(false);
    // Caught up: on main exactly, the old folder gone.
    expect(await box.head()).toBe(main);
    expect(await box.read("apps/a/mako.json")).toBeNull();
    // Every draft in the renamed app, unstaged, nothing committed.
    expect(await box.read("apps/acq/src/main.tsx")).toBe(
      MAIN_TSX.replace("line 2", "MINE"),
    );
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
    ]);
    expect(await box.read("apps/a/src/new.ts")).toBeNull();
    await expectNoMarkers(box.root);
    // Everything carried: no drafts branch left behind.
    expect(await box.branches()).toEqual([]);
    expect(await noticeFor()).toMatch(
      /Main renamed apps\/a → apps\/acq; your 4 uncommitted changes followed it\./,
    );
  });

  it("a conflicting edit: caught up with main's version, no markers, mine saved on a branch the message names", async () => {
    const box = await myBox();
    await box.write("apps/a/src/main.tsx", MAIN_TSX.replace("line 2", "MINE"));
    await box.write("apps/a/src/other.ts", "export const other = 2;\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });
    await externalCommit(WS, {
      "apps/acq/src/main.tsx": MAIN_TSX.replace("line 2", "THEIRS"),
    });
    const main = await headOf(WS);

    const outcome = await boxPull(box.ctx);
    expect(await box.head()).toBe(main);
    expect(await box.read("apps/acq/src/main.tsx")).toBe(
      MAIN_TSX.replace("line 2", "THEIRS"),
    );
    await expectNoMarkers(box.root);
    // The edit that did not conflict still followed the rename.
    expect(await box.read("apps/acq/src/other.ts")).toBe(
      "export const other = 2;\n",
    );
    expect(await box.status()).toEqual([" M apps/acq/src/other.ts"]);
    expect(outcome?.conflicted).toEqual(["apps/a/src/main.tsx"]);
    const [branch] = await box.branches();
    expect(branch).toMatch(/^mako-drafts\//);
    // Recoverable: my version, on the branch, at the path I wrote it.
    expect(
      await box.sh(`git -C '${box.root}' show '${branch}:apps/a/src/main.tsx'`),
    ).toBe(MAIN_TSX.replace("line 2", "MINE"));
    const notice = await noticeFor();
    expect(notice).toContain("apps/a/src/main.tsx");
    expect(notice).toContain(branch);
    expect(notice).toMatch(/git checkout mako-drafts\//);
  });

  it("a new file whose place in the renamed folder is taken stays where it was — both kept", async () => {
    const box = await myBox();
    await box.write("apps/a/src/dup.ts", "export const mine = true;\n");
    await box.write("apps/a/src/solo.ts", "export const solo = true;\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });
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
    expect(await noticeFor()).toMatch(
      /apps\/a\/src\/dup\.ts stayed where it was/,
    );
  });

  it("work in ANOTHER app takes the plain catch-up, exactly as before", async () => {
    const box = await myBox();
    await box.write("apps/x/src/main.tsx", "export const x = 2;\n");
    await box.write("apps/x/src/new.ts", "export const n = 1;\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });

    const outcome = await boxPull(box.ctx);
    expect(outcome?.plain).toBe(true);
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/acq/src/main.tsx")).toBe(MAIN_TSX);
    expect(await box.status()).toEqual([
      " M apps/x/src/main.tsx",
      "?? apps/x/src/new.ts",
    ]);
    expect(await box.branches()).toEqual([]);
    expect(await noticeFor()).toBeUndefined();
  });

  it("…including when the plain merge refuses (main changed the very file I edited, no rename): as before, nothing touched", async () => {
    const box = await myBox();
    await box.write("apps/x/src/main.tsx", "export const x = 'mine';\n");
    const before = await box.head();
    await externalCommit(WS, {
      "apps/x/src/main.tsx": "export const x = 'theirs';\n",
    });

    const outcome = await boxPull(box.ctx);
    expect(outcome).toMatchObject({ plain: true });
    // git refused; what it said is reported, never parsed.
    expect(outcome?.failed).toBeTruthy();
    expect(await box.head()).toBe(before);
    expect(await box.read("apps/x/src/main.tsx")).toBe(
      "export const x = 'mine';\n",
    );
    expect(await noticeFor()).toBeUndefined();
  });

  it("a member renames twice while I am dirty (a → b → c): my drafts land in c", async () => {
    const box = await myBox();
    await box.write("apps/a/src/main.tsx", MAIN_TSX.replace("line 4", "MINE"));
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await renameObject(other, "app", { ref: "a", slug: "b" });
    await renameObject(other, "app", { ref: "b", slug: "c" });
    await boxPull(box.ctx);
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/c/src/main.tsx")).toBe(
      MAIN_TSX.replace("line 4", "MINE"),
    );
    expect(await box.read("apps/c/src/new.ts")).toBe(
      "export const fresh = true;\n",
    );
    expect(await fileAt(WS, "apps/c/src/new.ts")).toBeNull();
  });
});

/**
 * Everything about a working copy a person could notice: HEAD, the index
 * entry by entry (staged or not, modes, conflict stages), status, and every
 * file's bytes and mode outside .git — ignored files included.
 */
async function snapshotOf(box: Awaited<ReturnType<typeof myBox>>) {
  const r = box.root;
  return {
    head: await box.head(),
    index: await box.sh(`git -C '${r}' ls-files -s`),
    status: await box.status(),
    staged: await box.sh(`git -C '${r}' diff --cached`),
    unstaged: await box.sh(`git -C '${r}' diff`),
    // Node's fs, not shell tools: `stat -f` means file mode on BSD and
    // FILESYSTEM status on GNU (whose free-block count moves on its own).
    files: await Promise.all(
      (await walk(r)).map(async rel => {
        const abs = path.join(r, rel);
        const stat = await fs.lstat(abs);
        if (stat.isSymbolicLink()) {
          return `${rel} link -> ${await fs.readlink(abs)}`;
        }
        const hash = createHash("sha256")
          .update(await fs.readFile(abs))
          .digest("hex");
        return `${rel} ${(stat.mode & 0o777).toString(8)} ${stat.size} ${hash}`;
      }),
    ),
  };
}

describe("the paths a catch-up rarely takes", () => {
  it("(a) the catch-up's own merge of main fails (my local commits conflict): my tree is restored byte for byte — tracked, staged, untracked — and I am told", async () => {
    const box = await myBox();
    // A local commit, never pushed, that main will contradict.
    await box.write(
      "apps/x/src/main.tsx",
      "export const x = 'local commit';\n",
    );
    await box.sh(`git -C '${box.root}' commit -q -am "local work"`);
    await externalCommit(WS, {
      "apps/x/src/main.tsx": "export const x = 'main';\n",
    });
    await renameObject(other, "app", { ref: "a", slug: "acq" });
    // Drafts of every kind, in the renamed app and outside it.
    await box.write("apps/a/src/main.tsx", MAIN_TSX.replace("line 2", "MINE"));
    await box.write("apps/a/src/other.ts", "export const other = 'staged';\n");
    await box.write("apps/a/src/staged-new.ts", "export const sn = 1;\n");
    await box.sh(
      `git -C '${box.root}' add apps/a/src/other.ts apps/a/src/staged-new.ts`,
    );
    // Staged, then edited again: index and work tree differ.
    await box.write(
      "apps/a/src/other.ts",
      "export const other = 'after staging';\n",
    );
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await box.write("apps/a/run.sh", "#!/bin/sh\necho hi\n");
    await box.sh(`chmod +x '${box.root}/apps/a/run.sh'`);
    await box.write("apps/x/notes.md", "outside the renamed app\n");
    await box.write(
      "apps/a/node_modules/pkg/index.js",
      "module.exports = 1;\n",
    );
    const before = await snapshotOf(box);

    const outcome = await boxPull(box.ctx);
    expect(outcome?.failed).toBeTruthy();
    expect(await snapshotOf(box)).toEqual(before);
    await expectNoMarkers(box.root);
    // …and also saved on a branch, which the message names.
    expect(outcome?.draftsBranch).toMatch(/^mako-drafts\//);
    expect(await box.branches()).toEqual([outcome?.draftsBranch]);
    const notice = await noticeFor();
    expect(notice).toMatch(
      /could not catch up with main \(apps\/a → apps\/acq\)/,
    );
    expect(notice).toMatch(/untouched/);
    expect(notice).toContain(outcome?.draftsBranch);
  });

  it("(b) a detached HEAD: never caught up, never touched (as before); told once when main renamed a folder my drafts are in; switching back to the branch brings them along", async () => {
    const box = await myBox();
    await box.sh(`git -C '${box.root}' checkout -q --detach HEAD`);
    await box.write("apps/a/src/main.tsx", MAIN_TSX.replace("line 2", "MINE"));
    await box.write("apps/a/src/new.ts", "export const fresh = true;\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });
    const before = await snapshotOf(box);

    const outcome = await boxPull(box.ctx);
    expect(outcome).toMatchObject({ plain: true, failed: "detached HEAD" });
    expect(await snapshotOf(box)).toEqual(before);
    const notice = await getBoxState(sessionKeyFor(WS, ME));
    expect(notice?.notice?.message).toMatch(
      /detached commit, not a branch, so it was not caught up with main — which renamed apps\/a → apps\/acq\. Your 2 uncommitted changes there are untouched/,
    );
    expect(notice?.notice?.message).toContain("git checkout main");
    // The next pull says nothing new.
    const at = notice?.notice?.at;
    await boxPull(box.ctx);
    expect((await getBoxState(sessionKeyFor(WS, ME)))?.notice?.at).toBe(at);
    // The advice works: back on main, the next catch-up carries them.
    await box.sh(`git -C '${box.root}' checkout -q main`);
    const carried = await boxPull(box.ctx);
    expect(carried?.plain).toBe(false);
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/acq/src/main.tsx")).toBe(
      MAIN_TSX.replace("line 2", "MINE"),
    );
    expect(await box.read("apps/acq/src/new.ts")).toBe(
      "export const fresh = true;\n",
    );
  });

  it("(b) a detached HEAD with nothing in a renamed folder: as before, silently", async () => {
    const box = await myBox();
    await box.sh(`git -C '${box.root}' checkout -q --detach HEAD`);
    await box.write("apps/x/src/main.tsx", "export const x = 2;\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });
    const before = await snapshotOf(box);
    expect(await boxPull(box.ctx)).toBeNull();
    expect(await snapshotOf(box)).toEqual(before);
    expect(await noticeFor()).toBeUndefined();
  });
});

describe("ignored files (node_modules, dist) in a renamed app", () => {
  it("follow a rename — with drafts or without — so no husk of the old app is left and the dev server needs no reinstall", async () => {
    for (const dirty of [false, true]) {
      await resetWorkspace(env, WS, {
        "apps/a/mako.json": manifest("A"),
        "apps/a/src/main.tsx": MAIN_TSX,
      });
      forgetBoxCaches(sessionKeyFor(WS, ME));
      const box = await myBox();
      await box.write("apps/a/node_modules/vite/index.js", "export {};\n");
      await box.write("apps/a/dist/index.html", "<html></html>\n");
      if (dirty) {
        await box.write(
          "apps/a/src/main.tsx",
          MAIN_TSX.replace("line 2", "MINE"),
        );
      }
      await renameObject(other, "app", { ref: "a", slug: "acq" });
      const outcome = await boxPull(box.ctx);
      expect(outcome?.plain, `dirty=${dirty}`).toBe(!dirty);
      expect(await box.read("apps/acq/node_modules/vite/index.js")).toBe(
        "export {};\n",
      );
      expect(await box.read("apps/acq/dist/index.html")).toBe(
        "<html></html>\n",
      );
      await expect(fs.stat(path.join(box.root, "apps/a"))).rejects.toThrow();
      expect(await box.status()).toEqual(
        dirty ? [" M apps/acq/src/main.tsx"] : [],
      );
    }
  });

  it("left behind after a move to another depth, they confuse nothing: no phantom app in the index or the list, the app's files are its own", async () => {
    const box = await myBox();
    await box.write("apps/a/node_modules/vite/index.js", "export {};\n");
    const project = (await resolveProjectRef(WS, "a"))!;
    const { moveProject } = await import("../worktree.service");
    await moveProject(
      project,
      { scope: "workspace", folderSegments: ["Team"] },
      { userId: OTHER, role: "admin" },
    );
    await boxPull(box.ctx);
    // The ignored-only husk stays (relative links would not survive the
    // depth change; nothing is ever deleted)…
    expect(await box.read("apps/a/node_modules/vite/index.js")).toBe(
      "export {};\n",
    );
    expect(await box.status()).toEqual([]);
    // …and is invisible: git sees nothing there, so neither does Mako.
    const snapshot = await loadAppsIndex(WS);
    expect(snapshot.apps.map(a => a.path).sort()).toEqual([
      "apps/Team/a",
      "apps/x",
    ]);
    expect(snapshot.folders).toEqual(["apps/Team"]);
    const moved = (await resolveProjectRef(WS, "apps/Team/a"))!;
    const { entries } = await listFiles(moved, ME);
    expect(entries.map(e => e.path).sort()).toEqual([
      "mako.json",
      "src/main.tsx",
      "src/other.ts",
    ]);
  });
});

describe("each draft comes back as what it was (Joan's review: a symlink came back as a file)", () => {
  const lstatOf = (root: string, rel: string) =>
    fs.lstat(path.join(root, rel)).catch(() => null);

  it("an untracked symlink — to a file, to a folder, dangling — is recreated as a symlink with the same target; an executable keeps its bit", async () => {
    const box = await myBox();
    const a = (rel: string) => path.join(box.root, "apps/a", rel);
    await fs.symlink("src/main.tsx", a("link"));
    await fs.symlink("src", a("srclink"));
    await fs.symlink("does-not-exist.ts", a("dangling"));
    await box.write("apps/a/run.sh", "#!/bin/sh\necho hi\n");
    await fs.chmod(a("run.sh"), 0o755);
    await renameObject(other, "app", { ref: "a", slug: "acq" });

    const outcome = await boxPull(box.ctx);
    expect(outcome?.stranded).toEqual([]);
    for (const [rel, target] of [
      ["link", "src/main.tsx"],
      ["srclink", "src"],
      ["dangling", "does-not-exist.ts"],
    ]) {
      const st = await lstatOf(box.root, `apps/acq/${rel}`);
      expect(st?.isSymbolicLink(), rel).toBe(true);
      expect(await fs.readlink(path.join(box.root, "apps/acq", rel))).toBe(
        target,
      );
    }
    // The links resolve as before: to a file, to a folder, to nothing.
    expect((await fs.stat(path.join(box.root, "apps/acq/link"))).isFile()).toBe(
      true,
    );
    expect(
      (await fs.stat(path.join(box.root, "apps/acq/srclink"))).isDirectory(),
    ).toBe(true);
    await expect(
      fs.stat(path.join(box.root, "apps/acq/dangling")),
    ).rejects.toThrow();
    const run = await lstatOf(box.root, "apps/acq/run.sh");
    expect(run?.isFile()).toBe(true);
    expect((run?.mode ?? 0) & 0o111).not.toBe(0);
    expect(await lstatOf(box.root, "apps/a")).toBeNull();
    // Faithful, so nothing kept back: no recovery branch.
    expect(await box.branches()).toEqual([]);
  });

  it("a tracked symlink retargeted, and a tracked executable edited, are carried as a symlink and an executable", async () => {
    const box = await myBox();
    const a = (rel: string) => path.join(box.root, "apps/a", rel);
    await fs.symlink("src/main.tsx", a("cfg"));
    await box.write("apps/a/build.sh", "#!/bin/sh\necho one\n");
    await fs.chmod(a("build.sh"), 0o755);
    await box.sh(
      `git -C '${box.root}' add apps/a/cfg apps/a/build.sh && git -C '${box.root}' commit -q -m "link and script" && git -C '${box.root}' push -q origin HEAD`,
    );
    // Drafts: retarget the link, edit the script.
    await fs.unlink(a("cfg"));
    await fs.symlink("src/other.ts", a("cfg"));
    await box.write("apps/a/build.sh", "#!/bin/sh\necho two\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });

    await boxPull(box.ctx);
    expect(await box.head()).toBe(await headOf(WS));
    const cfg = await lstatOf(box.root, "apps/acq/cfg");
    expect(cfg?.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(box.root, "apps/acq/cfg"))).toBe(
      "src/other.ts",
    );
    const build = await lstatOf(box.root, "apps/acq/build.sh");
    expect((build?.mode ?? 0) & 0o111).not.toBe(0);
    expect(
      await fs.readFile(path.join(box.root, "apps/acq/build.sh"), "utf8"),
    ).toBe("#!/bin/sh\necho two\n");
    expect(await box.status()).toEqual([
      " M apps/acq/build.sh",
      " M apps/acq/cfg",
    ]);
  });

  it("an absolute or escaping symlink is never recreated nor followed: kept on the recovery branch, and the notice names it", async () => {
    const box = await myBox();
    const a = (rel: string) => path.join(box.root, "apps/a", rel);
    const outside = path.join(env.tmpRoot, "outside-the-box");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, a("abs"));
    await fs.symlink("../../../escape", a("up"));
    await fs.symlink("../../.git/config", a("intogit"));
    await box.write("apps/a/src/fine.ts", "export {};\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });

    const outcome = await boxPull(box.ctx);
    expect(outcome?.stranded.sort()).toEqual([
      "apps/a/abs",
      "apps/a/intogit",
      "apps/a/up",
    ]);
    for (const rel of ["abs", "up", "intogit"]) {
      expect(await lstatOf(box.root, `apps/acq/${rel}`), rel).toBeNull();
      expect(outcome?.strandedWhy?.[`apps/a/${rel}`]).toBe("escaping-link");
    }
    // Nothing was written outside, and the draft that was fine followed.
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await box.read("apps/acq/src/fine.ts")).toBe("export {};\n");
    // The recovery branch keeps them, as links.
    const [branch] = await box.branches();
    expect(branch).toMatch(/^mako-drafts\//);
    expect(
      (
        await box.sh(`git -C '${box.root}' ls-tree '${branch}' -- apps/a/abs`)
      ).split(/\s+/)[0],
    ).toBe("120000");
    const notice = await noticeFor();
    expect(notice).toContain(
      "apps/a/abs (a symbolic link pointing outside the repository, not recreated)",
    );
    expect(notice).toContain(branch);
  });

  it("a nested repository (git keeps only a pointer to it) is left where it was, untouched, and named", async () => {
    const box = await myBox();
    const vendor = path.join(box.root, "apps/a/vendor");
    await fs.mkdir(vendor, { recursive: true });
    await run("git", ["init", "-q", vendor]);
    await fs.writeFile(path.join(vendor, "lib.js"), "module.exports = 1;\n");
    // One with history (a cloned dependency)…
    const v = ["-C", vendor, "-c", "user.email=v@v", "-c", "user.name=V"];
    await run("git", [...v, "add", "-A"]);
    await run("git", [...v, "commit", "-qm", "vendored"]);
    // …and one without a commit yet, which git cannot even snapshot.
    const empty = path.join(box.root, "apps/a/scratch-repo");
    await fs.mkdir(empty, { recursive: true });
    await run("git", ["init", "-q", empty]);
    await fs.writeFile(path.join(empty, "notes.md"), "wip\n");
    await box.write("apps/a/src/fine.ts", "export {};\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });

    const outcome = await boxPull(box.ctx);
    expect(outcome?.strandedWhy?.["apps/a/vendor"]).toBe("unsupported");
    expect(outcome?.strandedWhy?.["apps/a/scratch-repo"]).toBe("unsupported");
    expect(await fs.readFile(path.join(vendor, "lib.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );
    expect(await fs.readFile(path.join(empty, "notes.md"), "utf8")).toBe(
      "wip\n",
    );
    expect(await box.head()).toBe(await headOf(WS));
    expect(await box.read("apps/acq/src/fine.ts")).toBe("export {};\n");
    expect(await box.branches()).toHaveLength(1);
    expect(await noticeFor()).toContain(
      "apps/a/vendor (a nested repository or special entry, left where it was)",
    );
  });

  it("never writes a draft THROUGH a folder that main made a symbolic link", async () => {
    const box = await myBox();
    await box.write("apps/a/data/x.txt", "draft\n");
    await renameObject(other, "app", { ref: "a", slug: "acq" });
    // Main then makes apps/acq/data a link out of the repository.
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: { "apps/acq/data": "../../../outside" },
        modes: { "apps/acq/data": "120000" },
      },
      { message: "data is a link now" },
    );
    invalidateAppsIndexCache(WS);
    const outcome = await boxPull(box.ctx);
    expect(outcome?.strandedWhy?.["apps/a/data/x.txt"]).toBe("linked-folder");
    expect((await lstatOf(box.root, "apps/acq/data"))?.isSymbolicLink()).toBe(
      true,
    );
    await expect(
      fs.readFile(path.join(box.root, "..", "outside", "x.txt")),
    ).rejects.toThrow();
    expect(await box.branches()).toHaveLength(1);
  });
});
