/**
 * The workspace shell (sandbox-tools.ts) with the sandbox driver mocked:
 * who may use it, that it starts at the repo root, that commits never stay
 * on main, that credentials never come back, and that every command is
 * logged. The main-settling script itself runs against real git.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "member" as string | undefined,
  hasSession: true,
  exec: [] as Array<{ command: string; options: Record<string, unknown> }>,
  /** What each exec answers, by a substring of its command. */
  answers: [] as Array<{ match: string; stdout: string; stderr?: string }>,
  files: new Map<string, string>(),
  writes: [] as Array<{ path: string; contents: string }>,
  pushes: 0,
  logs: [] as Array<{ message: string; meta: Record<string, unknown> }>,
}));

vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    getMember: vi.fn(async () => (state.role ? { role: state.role } : null)),
  },
}));

vi.mock("../../apps/user-handles.service", () => ({
  handleForUser: vi.fn(async () => "joan"),
}));

vi.mock("../../apps/box", () => ({
  boxPushIfAhead: vi.fn(async () => {
    state.pushes += 1;
  }),
}));

vi.mock("../../apps/sandbox/provider", () => ({
  getSandboxProvider: () => ({
    hasSession: vi.fn(async () => state.hasSession),
    root: () => "/home/user/app",
  }),
}));

vi.mock("../../logging", () => {
  const log =
    (level: string) => (message: string, meta: Record<string, unknown>) =>
      state.logs.push({ message: `${level}:${message}`, meta });
  const logger = {
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    debug: () => {},
  };
  // Every logger factory (agent, api, app, …) answers the same recorder.
  return { loggers: new Proxy({}, { get: () => () => logger }) };
});

vi.mock("../../apps/repository.service", () => ({ DEFAULT_BRANCH: "main" }));

vi.mock("../../apps/worktree.service", () => ({
  boxCtx: vi.fn(() => ({ sessionKey: "box" })),
  ensureBox: vi.fn(async () => ({ sessionKey: "box" })),
  ensureWorkspaceWorktree: vi.fn(async () => ({
    appRoot: "",
    repoDir: "/repo",
    doc: { branch: "main", userId: "u1" },
  })),
  execInWorktree: vi.fn(
    async (_handle: unknown, command: string, options: object = {}) => {
      state.exec.push({ command, options: options as Record<string, unknown> });
      const answer = state.answers.find(a => command.includes(a.match));
      return {
        exitCode: 0,
        stdout: answer?.stdout ?? "",
        stderr: answer?.stderr ?? "",
        timedOut: false,
        truncated: false,
        durationMs: 5,
      };
    },
  ),
  readSessionFile: vi.fn(async (_handle: unknown, relPath: string) => {
    const contents = state.files.get(relPath);
    if (contents === undefined) throw new Error(`ENOENT ${relPath}`);
    return contents;
  }),
  writeFile: vi.fn(
    async (_handle: unknown, relPath: string, contents: string) => {
      state.writes.push({ path: relPath, contents });
      state.files.set(relPath, contents);
    },
  ),
  writeWorktreeScratchFile: vi.fn(
    async () => "/tmp/mako-scratch/mako-tool-output/t.log",
  ),
}));

type Result = Record<string, unknown> & { success: boolean; error?: string };
type Tools = Record<
  string,
  { execute: (input: object, options: object) => Promise<Result> }
>;

async function tools(userId: string | undefined = "u1"): Promise<Tools> {
  const { createSandboxTools } = await import("./sandbox-tools");
  return createSandboxTools({
    workspaceId: "ws1",
    userId,
  }) as unknown as Tools;
}
const call = async (name: string, input: object, userId?: string) =>
  (await tools(userId))[name].execute(input, {
    toolCallId: "t",
    messages: [],
  });

beforeEach(() => {
  state.role = "member";
  state.hasSession = true;
  state.exec = [];
  state.answers = [];
  state.files = new Map();
  state.writes = [];
  state.pushes = 0;
  state.logs = [];
});

describe("who may use the sandbox", () => {
  it("refuses a viewer, a non-member and a call with no person", async () => {
    state.role = "viewer";
    expect((await call("sandbox_bash", { command: "ls" })).error).toMatch(
      /member role \(you are viewer\)/,
    );
    state.role = undefined;
    expect((await call("sandbox_status", {})).error).toMatch(
      /you are not a member/,
    );
    state.role = "member";
    const noPerson = (await (
      await import("./sandbox-tools")
    ).createSandboxTools({ workspaceId: "ws1" })) as unknown as Tools;
    const result = await noPerson.sandbox_bash.execute(
      { command: "ls" },
      { toolCallId: "t", messages: [] },
    );
    expect(result.error).toMatch(/belongs to a person/);
    expect(state.exec).toHaveLength(0);
  });

  it("refuses a cwd outside the repo before touching the box", async () => {
    for (const cwd of ["/etc", "../..", "dbt/../../x"]) {
      const result = await call("sandbox_bash", { command: "ls", cwd });
      expect(result.success, cwd).toBe(false);
    }
    expect(state.exec).toHaveLength(0);
  });
});

describe("sandbox_bash", () => {
  it("runs at the repo root without the automatic push", async () => {
    state.answers.push({ match: "pwd", stdout: "/home/user/app\n" });
    const result = await call("sandbox_bash", {
      command: "pwd",
      cwd: "dbt",
      timeoutSeconds: 30,
    });
    expect(result).toMatchObject({ success: true, stdout: "/home/user/app\n" });
    expect(state.exec[0]).toMatchObject({
      command: "pwd",
      options: { cwd: "dbt", timeoutMs: 30_000, pushIfAhead: false },
    });
    // Then the settle script, also without the push.
    expect(state.exec[1].command).toContain("refs/remotes/origin/main..HEAD");
    expect(state.exec[1].options.pushIfAhead).toBe(false);
    // Not on main with commits: the session branch is pushed as app_bash does.
    expect(state.pushes).toBe(1);
  });

  it("moves commits made on main to a sandbox branch and says so", async () => {
    state.answers.push({ match: "settle-me", stdout: "" });
    state.answers.push({
      match: "refs/remotes/origin/main..HEAD",
      stdout: "MOVED 2 keep 1\n",
    });
    const result = await call("sandbox_bash", {
      command: "git commit -am settle-me",
    });
    const moved = result.movedOffMain as Record<string, unknown>;
    expect(moved).toMatchObject({ commits: 2, pushed: true });
    expect(moved.branch).toMatch(/^sandbox\/joan\/\d{8}T\d{6}Z$/);
    expect(String(moved.note)).toMatch(/main is back to origin's/);
    expect(state.pushes).toBe(0);
    const log = state.logs.find(l => l.message === "info:sandbox_bash");
    expect(log?.meta).toMatchObject({ movedOffMain: 2, to: moved.branch });
  });

  it("redacts Mako credentials from output and from the log", async () => {
    const token = "mgt_abcdefghijklmnopqrstuvwxyz0123456789";
    const key = "revops_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    state.answers.push({
      match: "cat",
      stdout: `${token}\nMAKO_API_KEY=${key}\n`,
      stderr: "fatal: https://mako:secretpass@app.mako.ai/x.git",
    });
    const result = await call("sandbox_bash", {
      command: `cat .git/mako-git-token; echo ${token}`,
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(token);
    expect(text).not.toContain(key);
    expect(text).not.toContain("secretpass");
    expect(text).toContain("mgt_[REDACTED]");
    const logged = JSON.stringify(state.logs);
    expect(logged).not.toContain(token);
    expect(logged).toContain("sandbox_bash");
  });

  it("caps long output and saves the full text in the sandbox", async () => {
    state.answers.push({ match: "seq", stdout: "x".repeat(50_000) });
    const result = await call("sandbox_bash", { command: "seq 1 100000" });
    expect(String(result.stdout).length).toBeLessThan(20_000);
    expect(result.outputCapped).toMatchObject({
      fullOutputPath: "/tmp/mako-scratch/mako-tool-output/t.log",
    });
  });

  it("logs every command with who, where and how it ended", async () => {
    await call("sandbox_bash", { command: "git status", cwd: "dbt" });
    const log = state.logs.find(l => l.message === "info:sandbox_bash");
    expect(log?.meta).toMatchObject({
      workspaceId: "ws1",
      userId: "u1",
      branch: "main",
      cwd: "dbt",
      command: "git status",
      exitCode: 0,
    });
  });
});

describe("sandbox_status", () => {
  it("answers without booting a sandbox that is not running", async () => {
    state.hasSession = false;
    const result = await call("sandbox_status", {});
    expect(result).toMatchObject({ success: true, running: false });
    expect(state.exec).toHaveLength(0);
  });

  it("reads branch, counts, changes and tools from the box", async () => {
    state.answers.push({
      match: "BRANCH",
      stdout: [
        "BRANCH main",
        "HEAD abc1234",
        "COUNTS 3 0",
        "TOOL node 1",
        "TOOL dbt 0",
        "CHANGE  M dbt/models/a.sql",
        "CHANGE ?? scripts/new.py",
      ].join("\n"),
    });
    const result = await call("sandbox_status", {});
    expect(result).toMatchObject({
      running: true,
      root: "/home/user/app",
      branch: "main",
      head: "abc1234",
      behind: 3,
      ahead: 0,
      changes: [" M dbt/models/a.sql", "?? scripts/new.py"],
      tools: { node: true, dbt: false },
    });
  });
});

describe("sandbox_read_file and sandbox_write_file", () => {
  it("reads a file by its path from the repo root, redacted", async () => {
    state.files.set("dbt/profiles.yml", "a\ntoken: mgt_abcdefghijklmnop\n");
    const result = await call("sandbox_read_file", {
      path: "dbt/profiles.yml",
    });
    expect(result.success).toBe(true);
    expect(result.contents).toContain("mgt_[REDACTED]");
    expect(result.totalLines).toBe(2);
    expect(typeof result.hash).toBe("string");
  });

  it("creates a new file, and replaces one only with the hash read", async () => {
    expect(
      (
        await call("sandbox_write_file", {
          path: "scripts/a.py",
          contents: "1",
        })
      ).success,
    ).toBe(true);
    const blind = await call("sandbox_write_file", {
      path: "scripts/a.py",
      contents: "2",
    });
    expect(blind.error).toMatch(/already exists/);
    const read = await call("sandbox_read_file", { path: "scripts/a.py" });
    const stale = await call("sandbox_write_file", {
      path: "scripts/a.py",
      contents: "3",
      expectedHash: "0000",
    });
    expect(stale.error).toMatch(/changed since you read it/);
    const ok = await call("sandbox_write_file", {
      path: "scripts/a.py",
      contents: "4",
      expectedHash: read.hash,
    });
    expect(ok.success).toBe(true);
    expect(state.writes.map(w => w.contents)).toEqual(["1", "4"]);
  });
});

describe("settleMainScript against real git", () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const sh = (cwd: string, script: string) =>
    execFileSync("sh", ["-c", script], { cwd, encoding: "utf8" });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mako-sandbox-settle-"));
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(root, "clone", "-q", "origin.git", "box");
    const box = path.join(root, "box");
    git(box, "config", "user.email", "t@example.com");
    git(box, "config", "user.name", "T");
    fs.writeFileSync(path.join(box, "a.txt"), "1\n");
    git(box, "add", ".");
    git(box, "commit", "-qm", "base");
    git(box, "push", "-q", "-u", "origin", "main");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("moves a commit on main to the branch, pushes it, resets main", async () => {
    const { settleMainScript } = await import("./sandbox-tools");
    const box = path.join(root, "box");
    const base = git(box, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(box, "a.txt"), "2\n");
    fs.writeFileSync(path.join(box, "b.txt"), "dirty\n");
    git(box, "commit", "-qam", "on main");
    const out = sh(box, settleMainScript("sandbox/joan/20261116T000000Z"));
    expect(out.trim()).toBe("MOVED 1 keep 1");
    expect(git(box, "rev-parse", "HEAD")).toBe(base);
    expect(git(root, "--git-dir=origin.git", "rev-parse", "main")).toBe(base);
    expect(
      git(
        root,
        "--git-dir=origin.git",
        "log",
        "-1",
        "--format=%s",
        "sandbox/joan/20261116T000000Z",
      ),
    ).toBe("on main");
    // Uncommitted work survives the reset.
    expect(fs.existsSync(path.join(box, "b.txt"))).toBe(true);
  });

  it("does nothing on main without commits, or on another branch", async () => {
    const { settleMainScript } = await import("./sandbox-tools");
    const box = path.join(root, "box");
    expect(sh(box, settleMainScript("sandbox/x/1")).trim()).toBe("");
    git(box, "checkout", "-qb", "feature");
    fs.writeFileSync(path.join(box, "a.txt"), "3\n");
    git(box, "commit", "-qam", "on feature");
    expect(sh(box, settleMainScript("sandbox/x/1")).trim()).toBe("");
    expect(git(box, "log", "-1", "--format=%s")).toBe("on feature");
  });
});

describe("sandboxBranchName", () => {
  it("is a safe branch name from the handle and the time", async () => {
    const { sandboxBranchName } = await import("./sandbox-tools");
    expect(
      sandboxBranchName("joan", new Date("2026-11-16T08:24:14.123Z")),
    ).toBe("sandbox/joan/20261116T082414Z");
    expect(sandboxBranchName("../a b;rm", new Date(0))).toBe(
      "sandbox/a-b-rm/19700101T000000Z",
    );
  });
});
