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
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { renameObject } from "../../rename/registry";
import { loadAppsIndex } from "../app-index.service";
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

/** No conflict markers anywhere in the working copy (tracked or not). */
async function expectNoMarkers(root: string) {
  const { stdout } = await run("grep", [
    "-rl",
    "--exclude-dir=.git",
    "^<<<<<<<",
    root,
  ]).catch(() => ({ stdout: "" }));
  expect(stdout.trim()).toBe("");
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
    const merged = await box("merge", "--autostash", "--no-edit", "@{u}");
    // Exit 0 …
    expect(merged.stderr + merged.stdout).toMatch(
      /Applying autostash resulted in conflicts/,
    );
    // … and the person's file now holds conflict markers, at the NEW path.
    const file = await fs.readFile(`${dir}/box/apps/b/main.tsx`, "utf8");
    expect(file).toContain("<<<<<<<");
    expect(file).toContain("MINE");
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
    expect(outcome?.failed).toMatch(/would be overwritten/);
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
    files: await box.sh(
      `cd '${r}' && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | while read -r f; do printf '%s %s ' "$f" "$(stat -f %Lp "$f" 2>/dev/null || stat -c %a "$f")"; shasum -a 256 < "$f"; done`,
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
    expect(outcome?.failed).toMatch(/conflict/i);
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
    expect(notice?.notice?.message).toContain("git switch main");
    // The next pull says nothing new.
    const at = notice?.notice?.at;
    await boxPull(box.ctx);
    expect((await getBoxState(sessionKeyFor(WS, ME)))?.notice?.at).toBe(at);
    // The advice works: back on main, the next catch-up carries them.
    await box.sh(`git -C '${box.root}' switch -q main`);
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
