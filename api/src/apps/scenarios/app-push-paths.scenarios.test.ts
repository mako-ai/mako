/**
 * App folders a push brings in, judged at Mako's git endpoint — the real
 * route on a real port, a real `git push`, the real pre-receive hook
 * (routes/apps-git.ts → apps/push-path-check.ts).
 *
 * A push that INTRODUCES an app folder a checkout cannot hold is refused,
 * naming the path and how to fix it:
 *  (a) a name equal to another app folder's (existing or introduced) once
 *      upper/lower case or Unicode form are set aside;
 *  (b) a Windows device name, a trailing dot or space, `: * ? " < > |`;
 *  (c) a name not in Unicode NFC.
 * A folder already on main — or on the branch being pushed — is history
 * and never blocks a push; an ordinary push sails through.
 *
 * Commits are built with git's plumbing (index-info over stdin), so names
 * a macOS disk would merge or recompose reach the push exactly as written.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The push reaction and the mirror are not under test here.
vi.mock("../worktree.service", () => ({ notifyRepoPushed: vi.fn() }));
vi.mock("../../services/workspace-repos.service", () => ({
  getWorkspaceRepo: vi.fn(async () => null),
  findWorkspaceIdByRepoBinding: vi.fn(async () => null),
  findWorkspaceIdsByRepoBinding: vi.fn(async () => []),
}));

import { mintGitToken } from "../git-token.service";
import { startTestGitServer, type TestGitServer } from "../test-git-server";

const run = promisify(execFile);
const WS = "6846e6a01b05af0948070777";
const EMAIL = "dev@mako.ai";

let tmpRoot: string;
let server: TestGitServer;
let repoDir: string;

function gitEnv(): NodeJS.ProcessEnv {
  const token = mintGitToken({ workspaceId: WS, userId: "dev", email: EMAIL });
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: path.join(tmpRoot, "home"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: `!f() { printf 'username=mako\\npassword=%s\\n' '${token}'; }; f`,
  };
}

/** `git` with stdin, so paths are never recomposed by macOS argv handling. */
function gitStdin(dir: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", dir, ...args]);
    let out = "";
    let err = "";
    child.stdout.on("data", d => (out += String(d)));
    child.stderr.on("data", d => (err += String(d)));
    child.on("close", code =>
      code === 0 ? resolve(out) : reject(new Error(err || `git ${args[0]}`)),
    );
    child.stdin.end(stdin);
  });
}

/** One commit on `dir`'s HEAD: these files written, those removed. */
async function commit(
  dir: string,
  files: Record<string, string>,
  deletes: string[] = [],
  message = "change",
): Promise<void> {
  const lines: string[] = [];
  for (const [rel, contents] of Object.entries(files)) {
    const oid = (
      await gitStdin(dir, ["hash-object", "-w", "--stdin"], contents)
    ).trim();
    lines.push(`100644 ${oid}\t${rel}`);
  }
  for (const rel of deletes) lines.push(`0 ${"0".repeat(40)}\t${rel}`);
  await gitStdin(
    dir,
    ["update-index", "--index-info"],
    `${lines.join("\n")}\n`,
  );
  await run("git", [
    "-C",
    dir,
    "-c",
    `user.email=${EMAIL}`,
    "-c",
    "user.name=Dev",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    message,
  ]);
}

async function clone(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "clone-"));
  await run(
    "git",
    ["clone", "-q", `${server.url}/api/apps-git/${WS}.git`, dir],
    {
      env: gitEnv(),
    },
  );
  return dir;
}

/** Push HEAD to `ref` through the endpoint: "ok", or git's stderr. */
async function push(dir: string, ref = "main"): Promise<string> {
  try {
    await run(
      "git",
      ["-C", dir, "push", "-q", "origin", `HEAD:refs/heads/${ref}`],
      {
        env: gitEnv(),
      },
    );
    return "ok";
  } catch (error) {
    return (error as { stderr?: string }).stderr ?? String(error);
  }
}

const manifest = (title: string) => `${JSON.stringify({ title })}\n`;
const app = (folder: string, title = "App") => ({
  [`${folder}/mako.json`]: manifest(title),
  [`${folder}/src/main.tsx`]: "export {};\n",
});

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-push-paths-"));
  await fs.mkdir(path.join(tmpRoot, "home"), { recursive: true });
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
  repoDir = path.join(tmpRoot, "repos", `${WS}.git`);
  await fs.mkdir(repoDir, { recursive: true });
  await run("git", ["init", "-q", "--bare", "-b", "main", repoDir]);
  // History that predates the rule, pushed straight into the bare repo (no
  // endpoint, no hook): a device-named app, a case-twin pair, an NFD name.
  const seed = await fs.mkdtemp(path.join(tmpRoot, "seed-"));
  await run("git", ["init", "-q", "-b", "main", seed]);
  await commit(seed, {
    ...app("apps/report"),
    ...app("apps/café"),
    ...app("apps/Sales/x"),
    ...app("apps/CON"),
    ...app("apps/Dup"),
    ...app("apps/dup"),
    ...app("apps/old-café"),
  });
  await run("git", ["-C", seed, "push", "-q", repoDir, "HEAD:refs/heads/main"]);
  server = await startTestGitServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("a push that brings in an app folder a checkout cannot hold", () => {
  it("an ordinary push sails through: a new app, a nested one, edits to old ones", async () => {
    const dir = await clone();
    await commit(dir, {
      ...app("apps/revenue"),
      ...app("apps/Sales/CH/daily"),
      "apps/report/src/main.tsx": "export const v = 2;\n",
      "consoles/CON.sql": "select 1\n",
    });
    expect(await push(dir)).toBe("ok");
  });

  it("history is never in the way: editing or keeping the old device-named, twin and NFD folders still pushes", async () => {
    const dir = await clone();
    await commit(dir, {
      "apps/CON/src/main.tsx": "export const v = 3;\n",
      "apps/Dup/src/main.tsx": "export const v = 3;\n",
      "apps/old-café/src/main.tsx": "export const v = 3;\n",
    });
    expect(await push(dir)).toBe("ok");
    // …and a branch carrying them (they are on main) pushes too.
    const branch = await clone();
    await commit(branch, { "apps/report/notes.md": "x\n" });
    expect(await push(branch, "feature")).toBe("ok");
  });

  it("an app renamed by case only (apps/Revenue2 → apps/REVENUE2) is fine: the old spelling leaves", async () => {
    const dir = await clone();
    await commit(dir, app("apps/Revenue2"));
    expect(await push(dir)).toBe("ok");
    const again = await clone();
    await commit(
      again,
      app("apps/REVENUE2"),
      ["apps/Revenue2/mako.json", "apps/Revenue2/src/main.tsx"],
      "case-only rename",
    );
    expect(await push(again)).toBe("ok");
  });

  describe("(a) twins", () => {
    it.each([
      [
        "another case of an app on main",
        { ...app("apps/REPORT") },
        '"apps/REPORT" and "apps/report"',
      ],
      [
        "another case of a FOLDER on main",
        { ...app("apps/sales/y") },
        '"apps/sales" and "apps/Sales"',
      ],
      [
        "two spellings brought in together",
        { ...app("apps/Data"), ...app("apps/data") },
        "differ only in upper/lower case",
      ],
    ])("%s: refused, naming both", async (_label, files, message) => {
      const dir = await clone();
      await commit(dir, files);
      const out = await push(dir);
      expect(out).toContain("mako: refusing");
      expect(out).toContain(message);
      expect(out).toMatch(/git mv/);
    });

    it("the NFD spelling of an app on main (apps/café): refused", async () => {
      const dir = await clone();
      await commit(dir, app("apps/café"));
      const out = await push(dir);
      expect(out).toContain("mako: refusing");
      expect(out).toContain("NFC");
    });
  });

  describe("(b) Windows", () => {
    it.each([
      ["CON", "Windows"],
      ["aux", "Windows"],
      ["NUL.json", "Windows"],
      ["com1", "Windows"],
      ["LPT9", "Windows"],
      ["trailing.", "dot or a space"],
      ["trailing ", "dot or a space"],
      ["a:b", "character"],
      ["a*b", "character"],
      ["a?b", "character"],
      ['a"b', "character"],
      ["a<b", "character"],
      ["a>b", "character"],
      ["a|b", "character"],
    ])(
      "an app folder named %j: refused, with the path and a fix",
      async (name, why) => {
        const dir = await clone();
        await commit(dir, app(`apps/Ops/${name}`));
        const out = await push(dir);
        if (name === "CON") console.info(`[push] ${out.trim()}`);
        expect(out).toContain(`mako: refusing "apps/Ops/${name}"`);
        expect(out).toContain(why);
        expect(out).toMatch(/Rename it — git mv/);
        // Nothing landed.
        await expect(
          run("git", [
            "-C",
            repoDir,
            "cat-file",
            "-e",
            `main:apps/Ops/${name}/mako.json`,
          ]),
        ).rejects.toThrow();
      },
    );

    it("a device name as a FOLDER on the way to an app: refused too", async () => {
      const dir = await clone();
      await commit(dir, app("apps/aux/report"));
      expect(await push(dir)).toContain('mako: refusing "apps/aux"');
    });
  });

  describe("(c) not NFC", () => {
    it("an app folder written in NFD: refused, suggesting the NFC spelling", async () => {
      const dir = await clone();
      await commit(dir, app("apps/résumé"));
      const out = await push(dir);
      expect(out).toContain("mako: refusing");
      expect(out).toContain("NFC");
      expect(out).toContain('"apps/résumé"');
    });
  });

  it("refuses on any branch, not only main — a branch is merged into main later", async () => {
    const dir = await clone();
    await commit(dir, app("apps/PRN"));
    expect(await push(dir, "feature-prn")).toContain("mako: refusing");
  });
});
