/**
 * The git-over-HTTP endpoint, tested with a real git client.
 *
 * Every case here drives the actual `git` binary against the actual route on
 * a real port, because the interesting failures live in the seams — the CGI
 * bridge, the auth challenge, the pre-receive hook, ref hiding — and none of
 * those are exercised by calling functions.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The push reaction is the one side effect the endpoint owns; observe it
// instead of the mirror queue and realtime bus it fans out to.
const pushed = vi.hoisted(() => vi.fn());
vi.mock("./worktree.service", () => ({ notifyRepoPushed: pushed }));

import {
  GitTokenError,
  mintGitToken,
  verifyGitToken,
} from "./git-token.service";
import { startTestGitServer, type TestGitServer } from "./test-git-server";

const run = promisify(execFile);
const WS = "6846e6a01b05af0948070599";
const OTHER_WS = "6846e6a01b05af0948070600";

let tmpRoot: string;
let server: TestGitServer;
let repoDir: string;

/** Env that lets the git CLI authenticate non-interactively with `token`. */
function gitEnv(token: string | null): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // Ignore the machine's git config entirely. Xcode ships a system-level
    // `credential.helper=osxkeychain`, and after a SUCCESSFUL auth git asks
    // every configured helper to STORE the credential — which blocks forever
    // on the Keychain in a headless process. The clone works; the bookkeeping
    // after it hangs. Same disease the sandbox fix cured, one layer up.
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: path.join(tmpRoot, "home"),
    ...(token
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: `!f() { printf 'username=mako\\npassword=%s\\n' '${token}'; }; f`,
        }
      : {}),
  };
}

function url(ws = WS): string {
  return `${server.url}/api/apps-git/${ws}.git`;
}

async function freshClone(token: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "clone-"));
  await run("git", ["clone", "-q", url(), dir], { env: gitEnv(token) });
  await run("git", ["-C", dir, "config", "user.email", "t@t"]);
  await run("git", ["-C", dir, "config", "user.name", "T"]);
  return dir;
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-git-endpoint-"));
  await fs.mkdir(path.join(tmpRoot, "home"), { recursive: true });
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";

  repoDir = path.join(tmpRoot, "repos", `${WS}.git`);
  await fs.mkdir(repoDir, { recursive: true });
  await run("git", ["init", "-q", "--bare", "-b", "main", repoDir]);
  const seed = await fs.mkdtemp(path.join(tmpRoot, "seed-"));
  await run("git", ["clone", "-q", repoDir, seed]);
  await run("git", ["-C", seed, "config", "user.email", "s@s"]);
  await run("git", ["-C", seed, "config", "user.name", "S"]);
  await fs.writeFile(path.join(seed, "a.txt"), "one\n");
  await run("git", ["-C", seed, "add", "-A"]);
  await run("git", ["-C", seed, "commit", "-qm", "seed"]);
  await run("git", [
    "-C",
    seed,
    "push",
    "-q",
    "origin",
    "HEAD:refs/heads/main",
  ]);
  // An internal bookkeeping ref, of the kind publish parks its candidates on.
  const { stdout } = await run("git", ["-C", repoDir, "rev-parse", "main"]);
  await run("git", [
    "-C",
    repoDir,
    "update-ref",
    "refs/mako/publish-candidate",
    stdout.trim(),
  ]);

  server = await startTestGitServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("tokens", () => {
  it("round-trips, and rejects tampering and expiry", () => {
    const token = mintGitToken({ workspaceId: WS, userId: "u1" });
    expect(verifyGitToken(token)).toMatchObject({ wsId: WS, userId: "u1" });

    const [head, sig] = token.split(".");
    expect(() => verifyGitToken(`${head}x.${sig}`)).toThrow(GitTokenError);
    expect(() => verifyGitToken(`${head}.${sig}x`)).toThrow(GitTokenError);
    expect(() =>
      verifyGitToken(
        mintGitToken({ workspaceId: WS, userId: "u1", ttlSeconds: -60 }),
      ),
    ).toThrow(/expired/i);
  });
});

describe("authentication at the endpoint", () => {
  it("no token: 401 with a Basic challenge, so git asks its helper", async () => {
    const res = await fetch(`${url()}/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("a valid token for ANOTHER workspace is refused", async () => {
    const token = mintGitToken({ workspaceId: OTHER_WS, userId: "u1" });
    const res = await fetch(`${url(WS)}/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("an expired token is refused", async () => {
    const token = mintGitToken({
      workspaceId: WS,
      userId: "u1",
      ttlSeconds: -60,
    });
    const res = await fetch(`${url()}/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("a garbage token cannot clone", async () => {
    const dir = path.join(tmpRoot, "no-clone");
    await expect(
      run("git", ["clone", "-q", url(), dir], { env: gitEnv("mgt_garbage.x") }),
    ).rejects.toThrow();
  });
});

describe("what the network may do to refs", () => {
  const token = () => mintGitToken({ workspaceId: WS, userId: "u1" });

  it("clones, pushes an ordinary branch, and the push reaction fires", async () => {
    const dir = await freshClone(token());
    await fs.writeFile(path.join(dir, "b.txt"), "two\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-qm", "feature work"]);
    pushed.mockClear();
    await run(
      "git",
      ["-C", dir, "push", "-q", "origin", "HEAD:refs/heads/feature"],
      {
        env: gitEnv(token()),
      },
    );
    const { stdout } = await run("git", [
      "-C",
      repoDir,
      "rev-parse",
      "refs/heads/feature",
    ]);
    expect(stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(pushed).toHaveBeenCalledWith(WS, "u1");
  });

  it("internal refs are invisible to fetch and closed to push", async () => {
    const dir = await freshClone(token());
    const { stdout } = await run("git", ["ls-remote", url()], {
      env: gitEnv(token()),
    });
    expect(stdout).not.toContain("refs/mako/");

    await run("git", [
      "-C",
      dir,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "smuggle",
    ]);
    await expect(
      run(
        "git",
        ["-C", dir, "push", "origin", "HEAD:refs/mako/publish-candidate"],
        {
          env: gitEnv(token()),
        },
      ),
    ).rejects.toThrow(/hidden ref|internal/i);
    // And the candidate still points where the server put it.
    const before = await run("git", [
      "-C",
      repoDir,
      "rev-parse",
      "refs/mako/publish-candidate",
    ]);
    const main = await run("git", [
      "-C",
      repoDir,
      "rev-parse",
      "refs/heads/main",
    ]);
    expect(before.stdout.trim()).toBe(main.stdout.trim());
  });

  it("main cannot be force-pushed — its history is production", async () => {
    const dir = await freshClone(token());
    await run("git", [
      "-C",
      dir,
      "commit",
      "-q",
      "--amend",
      "-m",
      "rewritten seed",
    ]);
    await expect(
      run(
        "git",
        ["-C", dir, "push", "--force", "origin", "HEAD:refs/heads/main"],
        {
          env: gitEnv(token()),
        },
      ),
    ).rejects.toThrow(/force-push to main/i);
  });

  it("main cannot be deleted", async () => {
    await expect(
      run("git", ["clone", "-q", url(), path.join(tmpRoot, "del")], {
        env: gitEnv(token()),
      }).then(() =>
        run(
          "git",
          [
            "-C",
            path.join(tmpRoot, "del"),
            "push",
            "origin",
            ":refs/heads/main",
          ],
          {
            env: gitEnv(token()),
          },
        ),
      ),
    ).rejects.toThrow(/delete main/i);
  });

  it("ordinary branches keep git's full freedom: force-push and delete work", async () => {
    // The lesson of the checkout bug, applied here: the rules must be
    // GitHub's, not something stricter that felt safer. Rebasing your own
    // branch in your own sandbox is normal work.
    const dir = await freshClone(token());
    await run("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "x"]);
    await run(
      "git",
      ["-C", dir, "push", "-q", "origin", "HEAD:refs/heads/scratch"],
      {
        env: gitEnv(token()),
      },
    );
    await run("git", [
      "-C",
      dir,
      "commit",
      "-q",
      "--amend",
      "--allow-empty",
      "-m",
      "x rebased",
    ]);
    await run(
      "git",
      ["-C", dir, "push", "-q", "--force", "origin", "HEAD:refs/heads/scratch"],
      {
        env: gitEnv(token()),
      },
    );
    await run(
      "git",
      ["-C", dir, "push", "-q", "origin", ":refs/heads/scratch"],
      {
        env: gitEnv(token()),
      },
    );
    await expect(
      run("git", [
        "-C",
        repoDir,
        "rev-parse",
        "--verify",
        "refs/heads/scratch",
      ]),
    ).rejects.toThrow();
  });

  it("a plain fast-forward push to main is allowed — that is publishing by git", async () => {
    const dir = await freshClone(token());
    await fs.writeFile(path.join(dir, "c.txt"), "three\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-qm", "ship it"]);
    await run(
      "git",
      ["-C", dir, "push", "-q", "origin", "HEAD:refs/heads/main"],
      {
        env: gitEnv(token()),
      },
    );
    const log = await run("git", [
      "-C",
      repoDir,
      "log",
      "--format=%s",
      "-1",
      "main",
    ]);
    expect(log.stdout.trim()).toBe("ship it");
  });
});

describe("commit authorship enforcement", () => {
  const ALICE = "alice@mako.ai";
  const aliceToken = () =>
    mintGitToken({ workspaceId: WS, userId: "alice", email: ALICE });

  /** Commit `file` on a new branch, authored by `email`, and return the dir. */
  async function commitAs(email: string, message: string): Promise<string> {
    const dir = await freshClone(aliceToken());
    await fs.writeFile(path.join(dir, "auth.txt"), `${message}\n`);
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", [
      "-C",
      dir,
      "-c",
      `user.email=${email}`,
      "-c",
      "user.name=Author",
      "commit",
      "-qm",
      message,
    ]);
    return dir;
  }

  it("accepts a commit authored by the pushing user", async () => {
    const dir = await commitAs(ALICE, "alice authored");
    await run(
      "git",
      ["-C", dir, "push", "-q", "origin", "HEAD:refs/heads/alice-ok"],
      { env: gitEnv(aliceToken()) },
    );
    const { stdout } = await run("git", [
      "-C",
      repoDir,
      "log",
      "--format=%ae",
      "-1",
      "refs/heads/alice-ok",
    ]);
    expect(stdout.trim()).toBe(ALICE);
  });

  it("rejects a commit forged to look like someone else's", async () => {
    const dir = await commitAs("victim@mako.ai", "spoofed");
    await expect(
      run("git", ["-C", dir, "push", "-q", "origin", "HEAD:refs/heads/spoof"], {
        env: gitEnv(aliceToken()),
      }),
    ).rejects.toThrow(
      /authored by <victim@mako\.ai>|can only push commits you authored/i,
    );
    // And nothing was created.
    await expect(
      run("git", ["-C", repoDir, "rev-parse", "--verify", "refs/heads/spoof"]),
    ).rejects.toThrow();
  });

  it("does not re-check commits already on the server (merges keep their authors)", async () => {
    // The clone already contains the seed commit, authored by s@s. Alice adds
    // her own commit on top and pushes: the seed is reachable from main, so it
    // is excluded from the check and its foreign author does not block Alice.
    const dir = await commitAs(ALICE, "on top of the seed");
    await run(
      "git",
      ["-C", dir, "push", "-q", "origin", "HEAD:refs/heads/alice-ontop"],
      { env: gitEnv(aliceToken()) },
    );
    const { stdout } = await run("git", [
      "-C",
      repoDir,
      "log",
      "--format=%ae",
      "refs/heads/alice-ontop",
    ]);
    // Both authors survive in history; the push was allowed.
    expect(stdout).toContain(ALICE);
    expect(stdout).toContain("s@s");
  });

  it("a legacy token without an email is attributed but not gated", async () => {
    // Backward compatibility: tokens minted before authorship was bound in
    // carry no email, so the endpoint sets no expectation and the hook skips
    // the check — exactly the pre-existing behaviour.
    const dir = await commitAs("anyone@example.com", "legacy");
    const legacy = mintGitToken({ workspaceId: WS, userId: "u1" });
    await run(
      "git",
      ["-C", dir, "push", "-q", "origin", "HEAD:refs/heads/legacy"],
      { env: gitEnv(legacy) },
    );
    await expect(
      run("git", ["-C", repoDir, "rev-parse", "--verify", "refs/heads/legacy"]),
    ).resolves.toBeTruthy();
  });
});
