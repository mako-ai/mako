/**
 * The pre-save's own rescues (other branches, stashes) and its use of the
 * shared helper, run for real: bash + git against a temp clone whose origin
 * is a local bare repo. No sandbox, no network.
 *
 * What box/rescue-commit.test.ts already pins for the worktree (staged
 * files, leaks through HEAD's history, origin checks, case rules) is not
 * repeated here. These pin what the E2B move adds on top:
 * - another local branch and each stash reach the server on sibling refs;
 * - a branch, detached HEAD or stash built on a blocked commit pushes nothing;
 * - a re-run reports `unchanged` and creates no new ref;
 * - the checkout is never touched.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoxRun } from "./box/rescue-commit";
import { dryRunInspect, rescueBox } from "./box-presave";

const exec = promisify(execFile);
const USER = "6846e6a01b05af0948070999";
const NOW = new Date("2026-11-16T12:00:00Z");
const BASE = `mako-presave/${USER}/2026-11-16`;
const AUTHOR = { name: "ada", email: "ada@example.com" };
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  // No user-level gitignore (~/.config/git/ignore) leaking into the repo.
  XDG_CONFIG_HOME: "/nonexistent",
};

let tmp: string;
let origin: string;
let work: string;

const run: BoxRun = async command => {
  try {
    const { stdout, stderr } = await exec("bash", ["-c", command], {
      env: ENV,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { env: ENV });
  return stdout.trim();
}

async function write(rel: string, content: string | Buffer): Promise<void> {
  const file = path.join(work, rel);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content);
}

async function commitFile(rel: string, content: string, msg: string) {
  await write(rel, content);
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", msg);
}

async function serverRefs(): Promise<string[]> {
  return (await git(origin, "for-each-ref", "--format=%(refname)"))
    .split("\n")
    .filter(Boolean)
    .sort();
}

async function snapshot() {
  return {
    head: await git(work, "rev-parse", "HEAD"),
    symbolic: await git(work, "symbolic-ref", "-q", "HEAD").catch(
      () => "(detached)",
    ),
    status: await git(
      work,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
    branches: await git(
      work,
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
    ),
    stashes: await git(work, "stash", "list"),
  };
}

const rescue = (expected = origin) =>
  rescueBox(run, {
    root: work,
    userId: USER,
    now: NOW,
    author: AUTHOR,
    expectedOrigin: expected,
  });

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mako-presave-"));
  origin = path.join(tmp, "origin.git");
  work = path.join(tmp, "app");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin], {
    env: ENV,
  });
  await exec("git", ["init", "-q", "-b", "main", work], { env: ENV });
  await git(work, "remote", "add", "origin", origin);
  await commitFile("apps/a/index.ts", "one\n", "init");
  await git(work, "push", "-q", "-u", "origin", "main");
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("rescueBox", () => {
  it("pushes other branches and stashes to sibling refs, then the worktree", async () => {
    await git(work, "checkout", "-q", "-b", "spike");
    await commitFile("apps/a/spike.ts", "s\n", "spike");
    await git(work, "checkout", "-q", "main");
    await write("apps/a/index.ts", "stashed\n");
    await write("apps/a/untracked.ts", "u\n");
    await git(work, "stash", "push", "-q", "-u");
    const stash = await git(work, "rev-parse", "stash@{0}");
    await write("apps/a/index.ts", "two\n");
    const before = await snapshot();

    const { worktree, refs } = await rescue();

    expect(refs).toEqual([
      {
        ref: `${BASE}-branch/spike`,
        status: "pushed",
        commitOid: await git(work, "rev-parse", "spike"),
      },
      {
        ref: `${BASE}-stash-${stash.slice(0, 7)}`,
        status: "pushed",
        commitOid: stash,
      },
    ]);
    expect(worktree).toMatchObject({ status: "saved", branch: BASE });
    expect(await git(origin, "show", `${BASE}:apps/a/index.ts`)).toBe("two");
    expect(await serverRefs()).toEqual(
      [
        "refs/heads/main",
        `refs/heads/${BASE}`,
        `refs/heads/${BASE}-branch/spike`,
        `refs/heads/${BASE}-stash-${stash.slice(0, 7)}`,
      ].sort(),
    );
    expect(await git(origin, "rev-parse", "main")).toBe(before.head);
    expect(await snapshot()).toEqual(before);
  });

  it("a re-run reports unchanged and creates no new ref", async () => {
    await git(work, "checkout", "-q", "-b", "spike");
    await commitFile("apps/a/spike.ts", "s\n", "spike");
    await git(work, "checkout", "-q", "main");
    await write("apps/a/index.ts", "two\n");
    await git(work, "stash", "push", "-q");
    await write("apps/a/index.ts", "three\n");
    await rescue();
    const refsAfterFirst = await serverRefs();

    const again = await rescue();

    // spike reached the server on the first run, so it is no longer box-only
    // work; the stash ref is found where the first run left it.
    expect(again.refs.map(r => r.status)).toEqual(["unchanged"]);
    expect(again.worktree).toMatchObject({
      status: "saved",
      unchanged: true,
      branch: BASE,
    });
    expect(await serverRefs()).toEqual(refsAfterFirst);
  });

  it("new work on a re-run still gets saved, on a suffixed branch", async () => {
    await write("apps/a/index.ts", "two\n");
    await rescue();
    await write("apps/a/index.ts", "three\n");
    const again = await rescue();
    expect(again.worktree.status).toBe("saved");
    expect(
      (again.worktree as { unchanged?: boolean }).unchanged,
    ).toBeUndefined();
    expect((again.worktree as { branch: string }).branch).toMatch(
      new RegExp(`^${BASE}-[0-9a-f]{8}$`),
    );
  });

  it("a branch holding a secret is blocked, and then the worktree is manual", async () => {
    await git(work, "checkout", "-q", "-b", "leaky");
    await commitFile("apps/a/.env.production", "K=1\n", "leak");
    await git(work, "checkout", "-q", "main");
    await write("apps/a/index.ts", "two\n");

    const { worktree, refs } = await rescue();

    expect(refs).toEqual([
      expect.objectContaining({
        ref: `${BASE}-branch/leaky`,
        status: "blocked",
      }),
    ]);
    expect(worktree.status).toBe("manual");
    expect(await serverRefs()).toEqual(["refs/heads/main"]);
  });

  it("(b) a detached HEAD on top of a blocked branch pushes nothing", async () => {
    await git(work, "checkout", "-q", "-b", "leaky");
    await commitFile("apps/a/.env.production", "K=1\n", "leak");
    await git(work, "checkout", "-q", "--detach");
    await commitFile("apps/a/detached.ts", "d\n", "detached work");

    const { worktree, refs } = await rescue();

    expect(refs.map(r => r.status)).toEqual(["blocked"]);
    expect(worktree.status).toBe("manual");
    expect(await serverRefs()).toEqual(["refs/heads/main"]);
  });

  it("(c) a stash made on a blocked branch pushes nothing", async () => {
    await git(work, "checkout", "-q", "-b", "leaky");
    await commitFile("apps/a/.env.production", "K=1\n", "leak");
    await write("apps/a/index.ts", "stashed\n");
    await git(work, "stash", "push", "-q");
    await git(work, "checkout", "-q", "main");
    await git(work, "branch", "-q", "-D", "leaky");
    const stash = await git(work, "rev-parse", "stash@{0}");

    const { worktree, refs } = await rescue();

    expect(refs).toEqual([
      expect.objectContaining({
        ref: `${BASE}-stash-${stash.slice(0, 7)}`,
        status: "blocked",
      }),
    ]);
    // An unpushed stash keeps the worktree rescue manual too.
    expect(worktree.status).toBe("manual");
    expect(await serverRefs()).toEqual(["refs/heads/main"]);
  });

  it("a foreign origin pushes nothing and keeps its origin", async () => {
    await git(work, "checkout", "-q", "-b", "spike");
    await commitFile("apps/a/spike.ts", "s\n", "spike");
    const { worktree, refs } = await rescue(
      "https://app.mako.ai/api/apps-git/x.git",
    );
    expect(refs).toEqual([]);
    expect(worktree.status).toBe("manual");
    expect(await serverRefs()).toEqual(["refs/heads/main"]);
    expect(await git(work, "remote", "get-url", "origin")).toBe(origin);
  });
});

describe("dryRunInspect", () => {
  it("lists origin, paths with sizes and exclusion reasons, and box-only refs", async () => {
    await git(work, "checkout", "-q", "-b", "spike");
    await git(work, "commit", "-q", "--allow-empty", "-m", "s");
    await git(work, "checkout", "-q", "main");
    await write("apps/a/index.ts", "stashed\n");
    await git(work, "stash", "push", "-q");
    await write("apps/a/index.ts", "three\n");
    await write(".env.local", "X=1\n");

    const seen = await dryRunInspect(run, work);

    expect(seen).toMatchObject({
      hasRepo: true,
      origin,
      branch: "main",
      stashes: 1,
      unpushed: ["spike"],
      headUnpushed: 0,
      pathsTotal: 2,
    });
    expect(seen.paths).toEqual([
      { path: ".env.local", size: 4, excluded: "secret-shaped name" },
      { path: "apps/a/index.ts", size: 6, excluded: null },
    ]);
  });

  it("a folder with no repo says so", async () => {
    expect((await dryRunInspect(run, tmp)).hasRepo).toBe(false);
  });
});
