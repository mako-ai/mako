/**
 * The rescue commit against real git: a bare "origin" and a clone in a temp
 * directory stand in for the git endpoint and the box. No E2B.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  excludedBecause,
  rescueBranchName,
  rescueCommit,
  type BoxRun,
} from "./rescue-commit";

const exec = promisify(execFile);
const USER = "6846e6a01b05af0948070999";
const NOW = new Date("2026-11-16T12:00:00Z");
const BRANCH = `mako-presave/${USER}/2026-11-16`;

let tmp: string;
let origin: string;
let root: string;

const run: BoxRun = async command => {
  try {
    const { stdout, stderr } = await exec("bash", ["-c", command], {
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
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function write(rel: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

const rescue = () =>
  rescueCommit({
    run,
    root,
    userId: USER,
    now: NOW,
    author: { name: "ana", email: "ana@x.io" },
  });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rescue-"));
  origin = path.join(tmp, "origin.git");
  root = path.join(tmp, "box");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
  await exec("git", ["init", "-q", "-b", "main", root]);
  await git(root, "config", "user.name", "ana");
  await git(root, "config", "user.email", "ana@x.io");
  // A developer's global excludes (often `.env*`) must not shape the test.
  await git(root, "config", "core.excludesFile", "/dev/null");
  await git(root, "remote", "add", "origin", origin);
  await write("apps/sales/App.tsx", "export default 1;\n");
  await write(".gitignore", "*.log\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "init");
  await git(root, "push", "-q", "-u", "origin", "main");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("rescueCommit", () => {
  it("a session on main: work goes to a rescue branch, main and the checkout stay put", async () => {
    const mainBefore = await git(origin, "rev-parse", "main");
    const headBefore = await git(root, "rev-parse", "HEAD");
    await write("apps/sales/App.tsx", "export default 2;\n");
    await write("apps/sales/new.ts", "x\n");

    const result = await rescue();

    expect(result).toMatchObject({ status: "saved", branch: BRANCH, files: 2 });
    // Nothing on main, so nothing deploys.
    expect(await git(origin, "rev-parse", "main")).toBe(mainBefore);
    const saved = await git(origin, "rev-parse", BRANCH);
    expect(await git(origin, "rev-parse", `${saved}^`)).toBe(headBefore);
    expect(await git(origin, "show", `${saved}:apps/sales/App.tsx`)).toBe(
      "export default 2;",
    );
    // The box's checkout, index and working tree are untouched.
    expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await git(root, "status", "--porcelain")).toContain("App.tsx");
  });

  it("leaves build output out, reports it, and still saves", async () => {
    await write("apps/sales/dist/bundle.js", "x\n");
    await write("apps/sales/node_modules/x/index.js", "x\n");
    await write("apps/sales/keep.ts", "keep\n");

    const result = await rescue();

    expect(result.status).toBe("saved");
    const tree = await git(origin, "ls-tree", "-r", "--name-only", BRANCH);
    expect(tree).toContain("apps/sales/keep.ts");
    expect(tree).not.toContain("dist/");
    expect(tree).not.toContain("node_modules/");
    expect(result.excluded.join("\n")).toMatch(/dist\/bundle\.js/);
  });

  it("keeps the box when a secret or a big file is uncommitted, pushing nothing", async () => {
    for (const [file, content] of [
      [".env.local", "SECRET=1\n"],
      ["certs/server.PEM", "x\n"],
      ["big.bin", Buffer.alloc(11 * 1024 * 1024)],
    ] as const) {
      await write(file, content);
      await write("apps/sales/keep.ts", `${file}\n`);
      const result = await rescue();
      expect(result.status).toBe("manual");
      expect((result as { reason: string }).reason).toContain(file);
      await fs.rm(path.join(root, file));
    }
    expect(await git(origin, "branch", "--list", "mako-presave/*")).toBe("");
  });

  it("reports ignored files", async () => {
    await write("debug.log", "x\n");
    await write("apps/sales/keep.ts", "keep\n");
    const result = await rescue();
    expect(result.ignored).toContain("debug.log");
  });

  it("a clean box pushes nothing", async () => {
    expect((await rescue()).status).toBe("clean");
    expect(await git(origin, "branch", "--list", "mako-presave/*")).toBe("");
  });

  it("a conflict in progress is manual, and nothing is pushed", async () => {
    await git(root, "checkout", "-qb", "side");
    await write("apps/sales/App.tsx", "side\n");
    await git(root, "commit", "-qam", "side");
    await git(root, "push", "-q", "origin", "side");
    await git(root, "checkout", "-q", "main");
    await write("apps/sales/App.tsx", "main\n");
    await git(root, "commit", "-qam", "main");
    await git(root, "push", "-q", "origin", "main");
    await exec("git", ["-C", root, "merge", "side"]).catch(() => undefined);

    const result = await rescue();

    expect(result).toMatchObject({ status: "manual" });
    expect((result as { reason: string }).reason).toMatch(/merge_head/);
    expect(await git(origin, "branch", "--list", "mako-presave/*")).toBe("");
  });

  it("a stash is manual", async () => {
    await write("apps/sales/App.tsx", "stashed\n");
    await git(root, "stash", "-q");
    expect(await rescue()).toMatchObject({ status: "manual" });
  });

  it("another local branch with unpushed commits is manual", async () => {
    await git(root, "checkout", "-qb", "local-only");
    await write("apps/sales/x.ts", "x\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "local");
    await git(root, "checkout", "-q", "main");
    expect(await rescue()).toMatchObject({
      status: "manual",
      reason: expect.stringMatching(/local-only/),
    });
  });

  it("saves commits on a clean detached HEAD", async () => {
    await git(root, "checkout", "-q", "--detach");
    await write("apps/sales/x.ts", "x\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "detached");
    const head = await git(root, "rev-parse", "HEAD");
    const result = await rescue();
    expect(result).toMatchObject({
      status: "saved",
      commitOid: head,
      files: 0,
    });
    expect(await git(origin, "rev-parse", BRANCH)).toBe(head);
  });

  it("staged 1: a staged new file, untouched since, is saved", async () => {
    await write("apps/sales/staged.ts", "staged\n");
    await git(root, "add", "apps/sales/staged.ts");
    const result = await rescue();
    expect(result).toMatchObject({ status: "saved", files: 1 });
    expect(await git(origin, "show", `${BRANCH}:apps/sales/staged.ts`)).toBe(
      "staged",
    );
  });

  it("staged 2: a staged edit, untouched since, is saved", async () => {
    await write("apps/sales/App.tsx", "export default 9;\n");
    await git(root, "add", "apps/sales/App.tsx");
    const result = await rescue();
    expect(result).toMatchObject({ status: "saved", files: 1 });
    expect(await git(origin, "show", `${BRANCH}:apps/sales/App.tsx`)).toBe(
      "export default 9;",
    );
  });

  it("staged 3: a staged delete is saved", async () => {
    await git(root, "rm", "-q", "apps/sales/App.tsx");
    const result = await rescue();
    expect(result).toMatchObject({ status: "saved", files: 1 });
    expect(
      await git(origin, "ls-tree", "-r", "--name-only", BRANCH),
    ).not.toContain("apps/sales/App.tsx");
  });

  async function blobOnServer(sha: string): Promise<boolean> {
    return exec("git", ["-C", origin, "cat-file", "-e", sha]).then(
      () => true,
      () => false,
    );
  }

  it("leak 1: an unpushed commit on main holding .env blocks the push", async () => {
    await write(".env", "SECRET=1\n");
    await git(root, "add", "-f", ".env");
    await git(root, "commit", "-qm", "oops");
    const blob = await git(root, "rev-parse", "HEAD:.env");
    await write("apps/sales/App.tsx", "export default 3;\n");

    const result = await rescue();

    expect(result).toMatchObject({ status: "manual" });
    expect((result as { reason: string }).reason).toMatch(/\.env/);
    expect(await git(origin, "branch", "--list", "mako-presave/*")).toBe("");
    expect(await blobOnServer(blob)).toBe(false);
  });

  it("leak 2: a detached HEAD commit holding an 11 MB blob blocks the push", async () => {
    await git(root, "checkout", "-q", "--detach");
    await write("assets/huge.bin", Buffer.alloc(11 * 1024 * 1024, 1));
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "big");
    const blob = await git(root, "rev-parse", "HEAD:assets/huge.bin");

    const result = await rescue();

    expect(result).toMatchObject({ status: "manual" });
    expect((result as { reason: string }).reason).toMatch(/over 10 MB/);
    expect(await git(origin, "branch", "--list", "mako-presave/*")).toBe("");
    expect(await blobOnServer(blob)).toBe(false);
  });

  it("leak 3: a stash holding .env pushes nothing", async () => {
    await write(".env", "SECRET=1\n");
    await git(root, "add", "-f", ".env");
    await git(root, "stash", "-q");
    const blob = await git(root, "rev-parse", "stash@{0}:.env");

    const result = await rescue();

    expect(result).toMatchObject({ status: "manual" });
    expect(await git(origin, "branch", "--list", "mako-presave/*")).toBe("");
    expect(await blobOnServer(blob)).toBe(false);
  });

  it("never builds a rescue on a HEAD tree that already holds a secret", async () => {
    await write("config/prod.env", "SECRET=1\n");
    await git(root, "add", "-f", "config/prod.env");
    await git(root, "commit", "-qm", "pushed earlier");
    await git(root, "push", "-q", "origin", "main");
    await write("apps/sales/App.tsx", "export default 4;\n");

    const result = await rescue();

    expect(result).toMatchObject({ status: "manual" });
    expect((result as { reason: string }).reason).toMatch(/HEAD tree/);
    expect(await git(origin, "branch", "--list", "mako-presave/*")).toBe("");
  });

  it("a stale rescue tracking ref cannot hide an unpushed .env commit", async () => {
    // X adds .env, Y removes it: HEAD's tree is clean, the history is not.
    await write(".env", "SECRET=1\n");
    await git(root, "add", "-f", ".env");
    await git(root, "commit", "-qm", "oops");
    const x = await git(root, "rev-parse", "HEAD");
    const blob = await git(root, "rev-parse", "HEAD:.env");
    await git(root, "rm", "-q", "--cached", ".env");
    await fs.rm(path.join(root, ".env"));
    await git(root, "commit", "-qm", "remove it");
    // What an earlier rescue push leaves behind, for a branch the server no
    // longer has. Without the cleanup, --not --remotes skips X entirely.
    await git(
      root,
      "update-ref",
      `refs/remotes/origin/mako-presave/${USER}/2026-11-01`,
      x,
    );
    await write("apps/sales/App.tsx", "export default 5;\n");

    const result = await rescue();

    expect(result).toMatchObject({ status: "manual" });
    expect((result as { reason: string }).reason).toMatch(
      /unpushed history.*\.env/,
    );
    expect(await git(origin, "branch", "--list", "mako-presave/*")).toBe("");
    expect(await blobOnServer(blob)).toBe(false);
  });

  /** X adds .env, Y removes it: HEAD's tree is clean, the history is not. */
  async function envInHistoryOnly(): Promise<{ x: string; blob: string }> {
    await write(".env", "SECRET=1\n");
    await git(root, "add", "-f", ".env");
    await git(root, "commit", "-qm", "oops");
    const x = await git(root, "rev-parse", "HEAD");
    const blob = await git(root, "rev-parse", "HEAD:.env");
    await git(root, "rm", "-q", "--cached", ".env");
    await fs.rm(path.join(root, ".env"));
    await git(root, "commit", "-qm", "remove it");
    await write("apps/sales/App.tsx", "export default 5;\n");
    return { x, blob };
  }

  it("a foreign origin's tracking refs cannot hide an unpushed .env commit", async () => {
    const { x, blob } = await envInHistoryOnly();
    // The box once tracked another server that already had X.
    const foreign = path.join(tmp, "foreign.git");
    await exec("git", ["init", "-q", "--bare", foreign]);
    await git(root, "push", "-q", foreign, `${x}:refs/heads/main`);
    // Tracked under a name the real server does not have, so no fetch
    // from the real origin ever overwrites it.
    await git(
      root,
      "fetch",
      "-q",
      foreign,
      "+refs/heads/main:refs/remotes/origin/feature",
    );

    const result = await rescue();

    expect(result).toMatchObject({ status: "manual" });
    expect((result as { reason: string }).reason).toMatch(
      /unpushed history.*\.env/,
    );
    expect(await blobOnServer(blob)).toBe(false);
  });

  it("a second remote holding the commit cannot hide it either", async () => {
    const { x, blob } = await envInHistoryOnly();
    const github = path.join(tmp, "github.git");
    await exec("git", ["init", "-q", "--bare", github]);
    await git(root, "remote", "add", "github", github);
    await git(root, "push", "-q", "github", `${x}:refs/heads/main`);

    const result = await rescue();

    expect(result).toMatchObject({ status: "manual" });
    expect(await blobOnServer(blob)).toBe(false);
  });

  it("work that exists only on another remote is not clean", async () => {
    // A commit pushed to `github` but never to this server must be rescued,
    // not deleted as "clean".
    await write("apps/sales/only-on-github.ts", "x\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "github only");
    const github = path.join(tmp, "github.git");
    await exec("git", ["init", "-q", "--bare", github]);
    await git(root, "remote", "add", "github", github);
    await git(root, "push", "-q", "github", "HEAD:refs/heads/main");

    const result = await rescue();

    expect(result).toMatchObject({ status: "saved", files: 0 });
    expect(
      await git(origin, "show", `${BRANCH}:apps/sales/only-on-github.ts`),
    ).toBe("x");
  });

  it("refuses a box whose origin is not this workspace's endpoint, even when clean", async () => {
    for (const dirty of [false, true]) {
      if (dirty) await write("apps/sales/App.tsx", "export default 6;\n");
      const result = await rescueCommit({
        run,
        root,
        userId: USER,
        now: NOW,
        expectedOrigin: "https://mako.example/api/apps-git/other.git",
      });
      expect(result).toMatchObject({ status: "manual" });
      expect((result as { reason: string }).reason).toMatch(/origin/);
    }
    expect(await git(origin, "branch", "--list", "mako-presave/*")).toBe("");
  });

  it("saves when the origin is exactly the expected endpoint", async () => {
    await write("apps/sales/App.tsx", "export default 7;\n");
    const result = await rescueCommit({
      run,
      root,
      userId: USER,
      now: NOW,
      expectedOrigin: origin,
    });
    expect(result).toMatchObject({ status: "saved", branch: BRANCH });
  });

  it("a file staged and then deleted is reported index-only, and the rest is saved", async () => {
    await write("apps/sales/gone.ts", "x\n");
    await git(root, "add", "apps/sales/gone.ts");
    await fs.rm(path.join(root, "apps/sales/gone.ts"));
    await write("apps/sales/App.tsx", "export default 8;\n");

    const result = await rescue();

    expect(result).toMatchObject({ status: "saved", files: 1 });
    expect(result.excluded).toContain("apps/sales/gone.ts (index-only)");
  });

  it("build folders match regardless of case", async () => {
    await write("apps/sales/Node_Modules/x/index.js", "x\n");
    await write("apps/sales/DIST/bundle.js", "x\n");
    await write("apps/sales/Target/out.class", "x\n");
    await write("apps/sales/keep.ts", "keep\n");

    const result = await rescue();

    expect(result).toMatchObject({ status: "saved", files: 1 });
    const tree = await git(origin, "ls-tree", "-r", "--name-only", BRANCH);
    expect(tree).not.toMatch(/node_modules|dist|target/i);
  });

  it("never overwrites an existing rescue branch: a second run gets a suffix", async () => {
    await write("apps/sales/a.ts", "a\n");
    const first = await rescue();
    await write("apps/sales/b.ts", "b\n");
    const second = await rescue();
    expect(first).toMatchObject({ status: "saved", branch: BRANCH });
    expect(second.status).toBe("saved");
    const branch = (second as { branch: string }).branch;
    expect(branch).toMatch(new RegExp(`^${BRANCH}-[0-9a-f]{8}$`));
    // The first rescue is still where it was.
    expect(await git(origin, "rev-parse", BRANCH)).toBe(
      (first as { commitOid: string }).commitOid,
    );
  });
});

describe("helpers", () => {
  it("names the branch per person and day", () => {
    expect(rescueBranchName(USER, NOW)).toBe(BRANCH);
  });

  it("matches the exclusion list", () => {
    expect(excludedBecause(".env", 1)).toBeTruthy();
    expect(excludedBecause("a/id_rsa.pub", 1)).toBeTruthy();
    expect(excludedBecause("credentials-prod.json", 1)).toBeTruthy();
    expect(excludedBecause("svc/target/x.class", 1)).toBeTruthy();
    expect(excludedBecause("a.p12", 1)).toBeTruthy();
    expect(excludedBecause("api.key", 1)).toBeTruthy();
    for (const name of [
      ".ENV",
      "config/prod.env",
      "a.P8",
      "store.pfx",
      "keys.jks",
      "id_ed25519",
      ".npmrc",
      ".netrc",
      ".pgpass",
      "home/.aws/credentials",
      "gcp-service-account-prod.json",
      "stripe-key.json",
      "api_key.json",
      "my_service_account.json",
      "client_secret_123.json",
      "secrets.yaml",
      "SECRETS.YML",
      "token.txt",
      "token-prod.txt",
      "acme-prod-1a2b3c4d5e6f.json",
    ]) {
      expect(excludedBecause(name, 1)).toBe("secret-shaped name");
    }
    expect(excludedBecause("apps/sales/App.tsx", 1)).toBeNull();
    expect(excludedBecause("package.json", 1)).toBeNull();
    expect(excludedBecause("apps/sales/app.json", 1)).toBeNull();
    expect(excludedBecause("apps/sales/App.tsx", 11 * 1024 * 1024)).toBe(
      "over 10 MB",
    );
  });
});
