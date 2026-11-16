/**
 * The workspace shell (sandbox-tools.ts) with the sandbox driver mocked:
 * who may use it, private apps, confirmation, that it starts at the repo
 * root, that commits never stay on main, that credentials never come back,
 * and that every command is logged. The main-settling script itself runs
 * against real git, including a command that deleted the tracking ref.
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
  answers: [] as Array<{
    match: string;
    stdout?: string;
    stderr?: string;
    throws?: string;
  }>,
  files: new Map<string, string>(),
  writes: [] as Array<{ path: string; contents: string }>,
  pushes: 0,
  logs: [] as Array<{ message: string; meta: Record<string, unknown> }>,
  /** Live apps in the index: path, scope, owner. */
  apps: [] as Array<{
    appId: string;
    path: string;
    scope: string;
    ownerId?: string;
  }>,
  archived: [] as Array<{ path: string; ownerId?: string; scope: string }>,
  lockHeld: [] as boolean[],
  locked: false,
  /** The lock is held elsewhere past the wait: withBoxPushLock gives up. */
  lockBusy: false,
  /** Symlinks in the working copy: path → where it really points. */
  links: new Map<string, string>(),
  /** Every path on any ref under users/ or archive/ (the history scan). */
  historyPaths: [] as string[],
  /** Origin's main as the box knew it before the command. */
  knownBase: "",
}));

vi.mock("../../apps/git", async importOriginal => ({
  ...(await importOriginal<typeof import("../../apps/git")>()),
  runGit: vi.fn(async () => ({
    stdout: state.historyPaths.join("\n"),
    stderr: "",
  })),
}));

vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    getMember: vi.fn(async () => (state.role ? { role: state.role } : null)),
  },
}));

vi.mock("../../apps/user-handles.service", () => ({
  handleForUser: vi.fn(async () => "joan"),
  loadOwnerDirectory: vi.fn(async () => ({
    handleOf: (id: string) => (id === "u1" ? "joan" : undefined),
  })),
}));

vi.mock("../../apps/app-index.service", () => ({
  loadAppsIndex: vi.fn(async () => ({ apps: state.apps })),
}));

vi.mock("../../apps/app-archive.service", () => ({
  listArchivedApps: vi.fn(async (_ws: string, userId: string | undefined) =>
    state.archived.filter(
      app => !userId || app.scope !== "private" || app.ownerId === userId,
    ),
  ),
}));

vi.mock("../../database/workspace-schema", () => ({
  AppProject: { find: vi.fn(async () => []) },
  AppWorktree: { findOne: vi.fn() },
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

vi.mock("../../apps/worktree.service", () => {
  class BoxPushLockTimeoutError extends Error {
    constructor() {
      super("The sandbox is busy with another command (waited 30 s).");
    }
  }
  return {
    BoxPushLockTimeoutError,
    boxCtx: vi.fn(() => ({ sessionKey: "box" })),
    ensureBox: vi.fn(async () => ({ sessionKey: "box" })),
    ensureWorkspaceWorktree: vi.fn(async () => ({
      appRoot: "",
      repoDir: "/repo",
      doc: { branch: "main", userId: "u1" },
    })),
    withBoxPushLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => {
      if (state.lockBusy) throw new BoxPushLockTimeoutError();
      state.locked = true;
      try {
        return await fn();
      } finally {
        state.locked = false;
      }
    }),
    execInWorktree: vi.fn(
      async (_handle: unknown, command: string, options: object = {}) => {
        // Path resolution and the pre-command base read answer from state;
        // they are not the commands under test.
        const real = /^realpath -m --relative-to=\. -- '(.*)'$/.exec(command);
        if (real) {
          const target =
            state.links.get(real[1]) ?? real[1].replace(/^\.\//, "");
          return {
            exitCode: 0,
            stdout: `${target}\n`,
            stderr: "",
            timedOut: false,
            truncated: false,
            durationMs: 1,
          };
        }
        state.exec.push({
          command,
          options: options as Record<string, unknown>,
        });
        state.lockHeld.push(state.locked);
        if (
          command.startsWith(
            "git rev-parse -q --verify refs/remotes/origin/main",
          )
        ) {
          return {
            exitCode: 0,
            stdout: `${state.knownBase}\n`,
            stderr: "",
            timedOut: false,
            truncated: false,
            durationMs: 1,
          };
        }
        const answer = state.answers.find(a => command.includes(a.match));
        if (answer?.throws) throw new Error(answer.throws);
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
  };
});

// repo-tools.ts is imported for repoPathVisibility only; its own heavy
// imports are not exercised.
vi.mock("../../apps/cloud-repo.service", () => ({
  freshenForServe: vi.fn(),
}));
vi.mock("../../apps/workspace-repo-required", () => ({
  boundRepoDirIfExists: vi.fn(async () => "/repo"),
}));

const WS = "6846e6a01b05af0948070582";

type Result = Record<string, unknown> & { success: boolean; error?: string };
type Tools = Record<
  string,
  {
    execute: (input: object, options: object) => Promise<Result>;
    needsApproval?: unknown;
    inputSchema: { safeParse: (input: unknown) => { success: boolean } };
  }
>;

async function tools(
  userId: string | undefined = "u1",
  maxTimeoutSeconds?: number,
  automationKey?: boolean,
): Promise<Tools> {
  const { createSandboxTools, forgetHiddenPathsCache } =
    await import("./sandbox-tools");
  forgetHiddenPathsCache();
  return createSandboxTools({
    workspaceId: WS,
    userId,
    maxTimeoutSeconds,
    automationKey,
  }) as unknown as Tools;
}
const call = async (name: string, input: object, userId?: string) =>
  (await tools(userId))[name].execute(input, {
    toolCallId: "t",
    messages: [],
  });
const settleCommands = () =>
  state.exec.filter(e => e.command.includes("ls-remote origin"));
/** The command under test, not the base read or the settle step. */
const commandRuns = () =>
  state.exec.filter(
    e =>
      !e.command.includes("ls-remote origin") &&
      !e.command.startsWith("git rev-parse -q --verify refs/remotes/origin"),
  );

beforeEach(() => {
  state.role = "member";
  state.hasSession = true;
  state.exec = [];
  state.answers = [];
  state.files = new Map();
  state.writes = [];
  state.pushes = 0;
  state.logs = [];
  state.apps = [
    { appId: "a1", path: "apps/sales", scope: "workspace" },
    {
      appId: "a2",
      path: "users/joan/apps/mine",
      scope: "private",
      ownerId: "u1",
    },
  ];
  state.archived = [];
  state.lockHeld = [];
  state.locked = false;
  state.lockBusy = false;
  state.links = new Map();
  state.historyPaths = [
    "users/joan/consoles/mine.sql",
    "users/joan/apps/mine/src/App.tsx",
  ];
  state.knownBase = "";
});

describe("who may use the sandbox", () => {
  it("refuses a viewer, a non-member and a credential with no person", async () => {
    state.role = "viewer";
    expect((await call("sandbox_bash", { command: "ls" })).error).toMatch(
      /member role \(you are viewer\)/,
    );
    state.role = undefined;
    expect((await call("sandbox_status", {})).error).toMatch(
      /you are not a member/,
    );
    state.role = "member";
    const noPerson = await (
      await import("./sandbox-tools")
    ).createSandboxTools({ workspaceId: WS });
    for (const name of [
      "sandbox_bash",
      "sandbox_status",
      "sandbox_read_file",
      "sandbox_write_file",
    ]) {
      const result = (await (noPerson as unknown as Tools)[name].execute(
        { command: "ls", path: "a.txt", contents: "x" },
        { toolCallId: "t", messages: [] },
      )) as Result;
      expect(result.error, name).toMatch(/not tied to one/);
    }
    expect(state.exec).toHaveLength(0);
  });

  it("refuses a cwd outside the repo before touching the box", async () => {
    for (const cwd of ["/etc", "../..", "dbt/../../x"]) {
      const result = await call("sandbox_bash", { command: "ls", cwd });
      expect(result.success, cwd).toBe(false);
    }
    expect(state.exec).toHaveLength(0);
  });

  it("asks the user before every command and every write in chat", async () => {
    const all = await tools();
    expect(all.sandbox_bash.needsApproval).toBe(true);
    expect(all.sandbox_write_file.needsApproval).toBe(true);
    expect(all.sandbox_read_file.needsApproval).toBeUndefined();
    expect(all.sandbox_status.needsApproval).toBeUndefined();
  });

  it("caps the timeout at what the caller allows (100 s over MCP)", async () => {
    const mcp = await tools("u1", 100);
    expect(
      mcp.sandbox_bash.inputSchema.safeParse({
        command: "ls",
        timeoutSeconds: 101,
      }).success,
    ).toBe(false);
    await mcp.sandbox_bash.execute(
      { command: "ls" },
      { toolCallId: "t", messages: [] },
    );
    expect(commandRuns()[0].options.timeoutMs).toBe(100_000);
  });
});

describe("another member's private app", () => {
  beforeEach(() => {
    state.apps.push({
      appId: "a3",
      path: "users/vadim/apps/secret",
      scope: "private",
      ownerId: "u2",
    });
  });

  it("refuses sandbox_bash while the repo holds an app the caller cannot see", async () => {
    const result = await call("sandbox_bash", {
      command: "git show origin/main:users/vadim/apps/secret/src/App.tsx",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/holds 1 app\(s\) and \d+ file\(s\)/);
    expect(state.exec).toHaveLength(0);
  });

  it("counts a hidden archived app too", async () => {
    state.apps.pop();
    state.archived = [
      { path: "archive/users/vadim/apps/old", scope: "private", ownerId: "u2" },
    ];
    const result = await call("sandbox_bash", { command: "ls" });
    expect(result.error).toMatch(/holds 1 app/);
  });

  it("reads and writes it as not found, own and shared paths still work", async () => {
    state.files.set("users/vadim/apps/secret/src/App.tsx", "secret");
    state.files.set("users/joan/apps/mine/a.ts", "mine");
    state.files.set("apps/sales/a.ts", "shared");
    const hidden = await call("sandbox_read_file", {
      path: "users/vadim/apps/secret/src/App.tsx",
    });
    expect(hidden).toMatchObject({ success: false });
    expect(hidden.error).toMatch(/not found/);
    expect(JSON.stringify(hidden)).not.toContain('secret"');
    expect(
      (await call("sandbox_read_file", { path: "users/joan/apps/mine/a.ts" }))
        .success,
    ).toBe(true);
    expect(
      (await call("sandbox_read_file", { path: "apps/sales/a.ts" })).success,
    ).toBe(true);
    const write = await call("sandbox_write_file", {
      path: "users/vadim/apps/secret/new.ts",
      contents: "x",
    });
    expect(write.error).toMatch(/not found/);
    expect(state.writes).toHaveLength(0);
  });

  it("leaves it out of sandbox_status's changes", async () => {
    state.answers.push({
      match: "BRANCH",
      stdout: [
        "BRANCH main",
        "CHANGE  M users/vadim/apps/secret/a.ts",
        "CHANGE  M apps/sales/a.ts",
      ].join("\n"),
    });
    const result = await call("sandbox_status", {});
    expect(result.changes).toEqual([" M apps/sales/a.ts"]);
  });
});

describe("sandbox_bash", () => {
  it("runs at the repo root, then settles, all under the push lock", async () => {
    state.answers.push({ match: "pwd", stdout: "/home/user/app\n" });
    state.answers.push({ match: "ls-remote", stdout: "OFFMAIN feature\n" });
    const result = await call("sandbox_bash", {
      command: "pwd",
      cwd: "dbt",
      timeoutSeconds: 30,
    });
    expect(result).toMatchObject({ success: true, stdout: "/home/user/app\n" });
    expect(commandRuns()[0]).toMatchObject({
      command: "pwd",
      options: { cwd: "dbt", timeoutMs: 30_000, pushIfAhead: false },
    });
    expect(settleCommands()).toHaveLength(1);
    expect(settleCommands()[0].options.pushIfAhead).toBe(false);
    // Base read, command, settle step: all under the lock.
    expect(state.lockHeld).toEqual([true, true, true]);
    // On a branch other than main: the session branch is pushed.
    expect(state.pushes).toBe(1);
  });

  it("settles even when the command throws, and pushes nothing on main", async () => {
    state.answers.push({ match: "boom", throws: "sandbox exec failed" });
    state.answers.push({ match: "ls-remote", stdout: "CLEAN\n" });
    const result = await call("sandbox_bash", { command: "boom" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sandbox exec failed/);
    expect(settleCommands()).toHaveLength(1);
    expect(state.pushes).toBe(0);
  });

  it("pushes nothing when origin's main cannot be read", async () => {
    state.answers.push({ match: "ls-remote", stdout: "UNVERIFIED\n" });
    const result = await call("sandbox_bash", { command: "git commit -m x" });
    expect(result.pushSkipped).toMatch(/nothing was pushed/);
    expect(state.pushes).toBe(0);
  });

  it("pushes nothing when the settle step itself fails", async () => {
    state.answers.push({ match: "ls-remote", throws: "box gone" });
    await call("sandbox_bash", { command: "ls" });
    expect(state.pushes).toBe(0);
  });

  it("moves commits made on main to a sandbox branch and says so", async () => {
    state.answers.push({
      match: "ls-remote",
      stdout: "MOVED 2 keep 1 sandbox/joan/20261116T082414Z-abcd1234 1\n",
    });
    const result = await call("sandbox_bash", {
      command: "git commit -am settle-me",
    });
    const moved = result.movedOffMain as Record<string, unknown>;
    expect(moved).toMatchObject({
      commits: 2,
      pushed: true,
      branch: "sandbox/joan/20261116T082414Z-abcd1234",
    });
    expect(String(moved.note)).toMatch(/main is back to origin's/);
    expect(state.pushes).toBe(0);
    const log = state.logs.find(l => l.message === "info:sandbox_bash");
    expect(log?.meta).toMatchObject({ movedOffMain: 2, to: moved.branch });
  });

  it("redacts credentials from output and from the logged command", async () => {
    const secrets = [
      "mgt_abcdefghijklmnopqrstuvwxyz0123456789",
      "revops_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "sk_live_51HabcdefghijklmnopQRST",
      "sk_test_51HabcdefghijklmnopQRST",
      "xoxb-1234567890-abcdefghijkl",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.payloadpayload",
      "secretpass",
    ];
    state.answers.push({
      match: "cat",
      stdout: `${secrets[0]}\nMAKO_API_KEY=${secrets[1]}\nSTRIPE=${secrets[2]}\n${secrets[3]}\nSLACK=${secrets[4]}\n${secrets[5]}\nAuthorization: Bearer ${secrets[6]}\n`,
      stderr: "fatal: https://mako:secretpass@app.mako.ai/x.git",
    });
    const result = await call("sandbox_bash", {
      command: `cat .git/mako-git-token; curl -H 'Authorization: Bearer ${secrets[6]}' -d key=${secrets[2]} -d slack=${secrets[4]} -d aws=${secrets[5]}`,
    });
    const text = JSON.stringify(result) + JSON.stringify(state.logs);
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
    expect(text).toContain("mgt_[REDACTED]");
    const log = state.logs.find(l => l.message === "info:sandbox_bash");
    expect(String(log?.meta.command)).toContain("sk_live_[REDACTED]");
  });

  it("keeps the logged command to 2,000 characters", async () => {
    await call("sandbox_bash", { command: `echo ${"a".repeat(5_000)}` });
    const log = state.logs.find(l => l.message === "info:sandbox_bash");
    expect(String(log?.meta.command).length).toBe(2_000);
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
      workspaceId: WS,
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
  it("refuses to write back a file whose read was redacted", async () => {
    const original = "index = https://user:secretpass@pypi.internal/simple\n";
    state.files.set("pip.conf", original);
    const read = await call("sandbox_read_file", { path: "pip.conf" });
    expect(read).toMatchObject({ success: true, redacted: true });
    expect(String(read.contents)).not.toContain("secretpass");
    const write = await call("sandbox_write_file", {
      path: "pip.conf",
      contents: String(read.contents),
      expectedHash: read.hash,
    });
    expect(write.error).toMatch(/redacted/);
    expect(state.files.get("pip.conf")).toBe(original);
    expect(state.writes).toHaveLength(0);
  });

  it("refuses env files by name", async () => {
    for (const path of [".env", "apps/sales/.env.local", "dbt/.env"]) {
      const write = await call("sandbox_write_file", { path, contents: "K=v" });
      expect(write.error, path).toMatch(/env file/);
      const read = await call("sandbox_read_file", { path });
      expect(read.error, path).toMatch(/env file/);
    }
    expect(state.writes).toHaveLength(0);
  });

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

describe("second security review", () => {
  it("refuses sandbox_bash when another member's private console or notebook exists", async () => {
    for (const hidden of [
      "users/vadim/consoles/pipeline.sql",
      "users/vadim/notebooks/churn.ipynb",
    ]) {
      state.historyPaths = [...state.historyPaths, hidden];
      const result = await call("sandbox_bash", { command: "ls users" });
      expect(result.success, hidden).toBe(false);
      expect(result.error, hidden).toMatch(/0 app\(s\) and 1 file\(s\)/);
      state.historyPaths = state.historyPaths.filter(p => p !== hidden);
    }
    expect(commandRuns()).toHaveLength(0);
  });

  it("keeps another member's private console and notebook hidden from the file tools", async () => {
    state.files.set("users/vadim/consoles/pipeline.sql", "select secret");
    state.files.set("users/vadim/notebooks/churn.ipynb", "{}");
    for (const path of [
      "users/vadim/consoles/pipeline.sql",
      "users/vadim/notebooks/churn.ipynb",
    ]) {
      expect((await call("sandbox_read_file", { path })).error, path).toMatch(
        /not found/,
      );
      expect(
        (await call("sandbox_write_file", { path, contents: "x" })).error,
        path,
      ).toMatch(/not found/);
    }
    // The caller's own console is theirs.
    state.files.set("users/joan/consoles/mine.sql", "select 1");
    expect(
      (
        await call("sandbox_read_file", {
          path: "users/joan/consoles/mine.sql",
        })
      ).success,
    ).toBe(true);
    expect(state.writes).toHaveLength(0);
  });

  it("allows sandbox_bash when every path under users/ is the caller's own", async () => {
    const result = await call("sandbox_bash", { command: "ls" });
    expect(result.success).toBe(true);
  });

  it("fails closed when the history scan cannot run", async () => {
    const git = await import("../../apps/git");
    vi.mocked(git.runGit).mockRejectedValueOnce(new Error("mirror gone"));
    const result = await call("sandbox_bash", { command: "ls" });
    expect(result.success).toBe(false);
    expect(commandRuns()).toHaveLength(0);
  });

  it("follows a symlink before checking visibility", async () => {
    state.apps.push({
      appId: "a3",
      path: "users/vadim/apps/secret",
      scope: "private",
      ownerId: "u2",
    });
    state.files.set("users/vadim/apps/secret/.env.prod", "KEY=1");
    state.files.set("users/vadim/apps/secret/src/App.tsx", "secret");
    state.links.set(
      "apps/sales/link.tsx",
      "users/vadim/apps/secret/src/App.tsx",
    );
    state.links.set("apps/sales/out", "../../etc/passwd");
    const read = await call("sandbox_read_file", {
      path: "apps/sales/link.tsx",
    });
    expect(read.error).toMatch(/not found/);
    expect(JSON.stringify(read)).not.toContain('secret"');
    const write = await call("sandbox_write_file", {
      path: "apps/sales/link.tsx",
      contents: "overwrite",
    });
    expect(write.error).toMatch(/not found/);
    expect(
      (await call("sandbox_read_file", { path: "apps/sales/out" })).error,
    ).toMatch(/outside the repo/);
    expect(state.writes).toHaveLength(0);
  });

  it("reads and writes through a symlink that stays visible, at its target", async () => {
    state.files.set("apps/sales/real.ts", "export const a = 1;");
    state.links.set("apps/sales/alias.ts", "apps/sales/real.ts");
    const read = await call("sandbox_read_file", {
      path: "apps/sales/alias.ts",
    });
    expect(read).toMatchObject({ success: true, path: "apps/sales/real.ts" });
  });

  it("gives a redacted read a token that stripping the prefix cannot turn into the file's hash", async () => {
    const original = "token = mgt_abcdefghijklmnopqrstuv\n";
    state.files.set("cfg.ini", original);
    const read = await call("sandbox_read_file", { path: "cfg.ini" });
    const token = String(read.hash);
    expect(token.startsWith("redacted-")).toBe(true);
    const { contentHash } = await import("./apps-tools/context");
    expect(token.slice("redacted-".length)).not.toBe(contentHash(original));
    const stripped = await call("sandbox_write_file", {
      path: "cfg.ini",
      contents: String(read.contents),
      expectedHash: token.slice("redacted-".length),
    });
    expect(stripped.success).toBe(false);
    expect(state.files.get("cfg.ini")).toBe(original);
  });

  it("says the sandbox is busy, and runs nothing, when the lock wait runs out", async () => {
    state.lockBusy = true;
    const result = await call("sandbox_bash", { command: "git commit -m x" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/busy.*Nothing ran/);
    expect(state.exec).toHaveLength(0);
  });

  it("refuses a key Mako minted for automation", async () => {
    const automation = await tools("u1", 100, true);
    for (const name of [
      "sandbox_bash",
      "sandbox_status",
      "sandbox_read_file",
      "sandbox_write_file",
    ]) {
      const result = await automation[name].execute(
        { command: "ls", path: "a.txt", contents: "x" },
        { toolCallId: "t", messages: [] },
      );
      expect(result.error, name).toMatch(/minted for automation/);
    }
    expect(state.exec).toHaveLength(0);
  });

  it("redacts OpenAI keys and service-account private keys", async () => {
    const { redactSandboxSecrets } = await import("./sandbox-tools");
    const openai = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const legacy = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const sa = JSON.stringify({
      type: "service_account",
      private_key:
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n",
    });
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const out = redactSandboxSecrets(`${openai} ${legacy}\n${sa}\n${pem}`);
    expect(out).not.toContain(openai);
    expect(out).not.toContain(legacy);
    expect(out).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(out).not.toContain("MIIEpAIBAAKCAQEA");
    expect(out).toContain('"private_key":"[REDACTED]"');
  });
});

describe("settleMainScript against real git", () => {
  let root: string;
  let box: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const sh = (cwd: string, script: string) =>
    execFileSync("sh", ["-c", script], { cwd, encoding: "utf8" });
  const originMain = () =>
    git(root, "--git-dir=origin.git", "rev-parse", "main");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mako-sandbox-settle-"));
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(root, "clone", "-q", "origin.git", "box");
    box = path.join(root, "box");
    git(box, "config", "user.email", "t@example.com");
    git(box, "config", "user.name", "T");
    fs.writeFileSync(path.join(box, "a.txt"), "1\n");
    git(box, "add", ".");
    git(box, "commit", "-qm", "base");
    git(box, "push", "-q", "-u", "origin", "main");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("moves a commit on main to a sha-named branch, pushes it, resets main", async () => {
    const { settleMainScript, parseSettled } = await import("./sandbox-tools");
    const base = git(box, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(box, "a.txt"), "2\n");
    fs.writeFileSync(path.join(box, "b.txt"), "dirty\n");
    git(box, "commit", "-qam", "on main");
    const sha = git(box, "rev-parse", "--short=8", "HEAD");
    const settled = parseSettled(
      sh(box, settleMainScript("sandbox/joan/20261116T000000Z")),
    );
    expect(settled).toEqual({
      state: "moved",
      commits: 1,
      mode: "keep",
      pushed: true,
      branch: `sandbox/joan/20261116T000000Z-${sha}`,
      verified: true,
    });
    expect(git(box, "rev-parse", "HEAD")).toBe(base);
    expect(originMain()).toBe(base);
    expect(
      git(
        root,
        "--git-dir=origin.git",
        "log",
        "-1",
        "--format=%s",
        `sandbox/joan/20261116T000000Z-${sha}`,
      ),
    ).toBe("on main");
    // Uncommitted work survives the reset.
    expect(fs.existsSync(path.join(box, "b.txt"))).toBe(true);
  });

  it("never pushes main after a command deleted the tracking ref", async () => {
    const { settleMainScript, parseSettled } = await import("./sandbox-tools");
    const base = originMain();
    fs.writeFileSync(path.join(box, "a.txt"), "evil\n");
    git(box, "commit", "-qam", "evil on main");
    git(box, "update-ref", "-d", "refs/remotes/origin/main");
    const settled = parseSettled(sh(box, settleMainScript("sandbox/x/1")));
    expect(settled.state).toBe("moved");
    expect(originMain()).toBe(base);
    // The tracking ref is back, so a later app_bash push sees nothing ahead.
    expect(git(box, "rev-parse", "refs/remotes/origin/main")).toBe(base);
    expect(git(box, "rev-list", "--count", "origin/main..HEAD")).toBe("0");
  });

  it("ignores a hook the command installed", async () => {
    const { settleMainScript } = await import("./sandbox-tools");
    const base = originMain();
    const hooks = path.join(box, ".evil-hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(
      path.join(hooks, "pre-push"),
      "#!/bin/sh\ngit push -q --no-verify origin HEAD:refs/heads/main\n",
      { mode: 0o755 },
    );
    git(box, "config", "core.hooksPath", hooks);
    fs.writeFileSync(path.join(box, "a.txt"), "x\n");
    git(box, "commit", "-qam", "x");
    sh(box, settleMainScript("sandbox/x/2"));
    expect(originMain()).toBe(base);
  });

  it("says CLEAN on main without commits, OFFMAIN on another branch", async () => {
    const { settleMainScript, parseSettled } = await import("./sandbox-tools");
    expect(parseSettled(sh(box, settleMainScript("sandbox/x/1")))).toEqual({
      state: "clean",
      verified: true,
    });
    git(box, "checkout", "-qb", "feature");
    fs.writeFileSync(path.join(box, "a.txt"), "3\n");
    git(box, "commit", "-qam", "on feature");
    expect(parseSettled(sh(box, settleMainScript("sandbox/x/1")))).toEqual({
      state: "offmain",
      branch: "feature",
    });
    expect(git(box, "log", "-1", "--format=%s")).toBe("on feature");
  });

  it("origin unreadable: moves the commits to a local branch and resets main to the last-known base", async () => {
    const { settleMainScript, parseSettled } = await import("./sandbox-tools");
    const base = originMain();
    fs.writeFileSync(path.join(box, "a.txt"), "4\n");
    git(box, "commit", "-qam", "offline");
    const sha = git(box, "rev-parse", "--short=8", "HEAD");
    // The command broke the remote AND deleted the tracking ref; the tool
    // read the base before it ran.
    git(box, "remote", "set-url", "origin", path.join(root, "missing.git"));
    git(box, "update-ref", "-d", "refs/remotes/origin/main");
    const settled = parseSettled(
      sh(box, settleMainScript("sandbox/x/1", base)),
    );
    expect(settled).toEqual({
      state: "moved",
      commits: 1,
      mode: "keep",
      pushed: false,
      branch: `sandbox/x/1-${sha}`,
      verified: false,
    });
    expect(git(box, "rev-parse", "HEAD")).toBe(base);
    expect(git(box, "log", "-1", "--format=%s", `sandbox/x/1-${sha}`)).toBe(
      "offline",
    );
    // The next push from this box (what app_bash or the terminal does) once
    // the remote is back carries nothing to main.
    git(box, "remote", "set-url", "origin", path.join(root, "origin.git"));
    git(box, "push", "-q", "origin", "HEAD");
    expect(originMain()).toBe(base);
  });

  it("origin unreadable and no known base: parks the work on a branch, deletes local main", async () => {
    const { settleMainScript, parseSettled } = await import("./sandbox-tools");
    const base = originMain();
    fs.writeFileSync(path.join(box, "a.txt"), "5\n");
    git(box, "commit", "-qam", "stranded");
    const sha = git(box, "rev-parse", "--short=8", "HEAD");
    git(box, "remote", "set-url", "origin", path.join(root, "missing.git"));
    git(box, "update-ref", "-d", "refs/remotes/origin/main");
    expect(parseSettled(sh(box, settleMainScript("sandbox/x/1")))).toEqual({
      state: "parked",
      branch: `sandbox/x/1-${sha}`,
    });
    expect(git(box, "symbolic-ref", "--short", "HEAD")).toBe(
      `sandbox/x/1-${sha}`,
    );
    expect(() =>
      git(box, "rev-parse", "-q", "--verify", "refs/heads/main"),
    ).toThrow();
    git(box, "remote", "set-url", "origin", path.join(root, "origin.git"));
    git(box, "push", "-q", "origin", "HEAD");
    expect(originMain()).toBe(base);
  });

  it("ignores a known base that is not a sha", async () => {
    const { settleMainScript } = await import("./sandbox-tools");
    expect(settleMainScript("p", "$(rm -rf /)")).not.toContain("rm -rf");
  });
});

describe("sandboxBranchPrefix and parseSettled", () => {
  it("makes a safe branch prefix from the handle and the time", async () => {
    const { sandboxBranchPrefix } = await import("./sandbox-tools");
    expect(
      sandboxBranchPrefix("joan", new Date("2026-11-16T08:24:14.123Z")),
    ).toBe("sandbox/joan/20261116T082414Z");
    expect(sandboxBranchPrefix("../a b;rm", new Date(0))).toBe(
      "sandbox/a-b-rm/19700101T000000Z",
    );
  });

  it("treats anything unexpected as unverified", async () => {
    const { parseSettled } = await import("./sandbox-tools");
    expect(parseSettled("")).toEqual({ state: "unverified" });
    expect(parseSettled("garbage\nMOVED x")).toEqual({ state: "unverified" });
    expect(parseSettled("OFFMAIN \n")).toEqual({
      state: "offmain",
      branch: "",
    });
  });
});
