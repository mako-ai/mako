/**
 * app_bash / app_read_file / app_grep output caps: a tool result must never
 * carry an unbounded command log, file or match list into the prompt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  project: {
    _id: { toString: () => "6a9411eb4c8b33609a65e665" },
    workspaceId: { toString: () => "6a9411eb4c8b33609a65e666" },
    slug: "sales",
    title: "Sales",
    defaultBranch: "main",
  },
}));

vi.mock("../../database/workspace-schema", () => ({
  AppProject: {
    find: vi.fn(async () => []),
    findOne: vi.fn(async () => null),
  },
}));

vi.mock("../../services/workspace.service", () => ({
  workspaceService: { getMember: vi.fn(async () => null) },
}));

vi.mock("../../utils/resource-acl", () => ({
  canReadResource: vi.fn(() => true),
  canWriteResource: vi.fn(() => true),
}));

vi.mock("../../apps/cloud-repo.service", () => ({
  freshenForServe: vi.fn(async () => state.events.push("freshen")),
  ensureCommitLocally: vi.fn(),
}));

vi.mock("../../apps/worktree.service", () => ({
  WorktreeConflictError: class WorktreeConflictError extends Error {},
  PUBLISH_ACTOR: "publish",
  appRootFor: vi.fn(() => "apps/sales"),
  boxCtx: vi.fn(() => ({ sessionKey: "box" })),
  catchUpLiveBox: vi.fn(async () => state.events.push("catch-up")),
  commitWorktree: vi.fn(),
  createProject: vi.fn(),
  ensureWorktree: vi.fn(async () => {
    state.events.push("worktree");
    return {
      project: state.project,
      appRoot: "apps/sales",
      doc: { branch: "main" },
    };
  }),
  execInWorktree: vi.fn(),
  writeWorktreeScratchFile: vi.fn(),
  globFiles: vi.fn(),
  grepFiles: vi.fn(),
  listAppFolders: vi.fn(async () => {
    state.events.push("list");
    return [
      {
        id: "6a9411eb4c8b33609a65e665",
        slug: "sales",
        path: "apps/sales",
        scope: "workspace",
        title: "Sales",
      },
    ];
  }),
  listAppFolderPaths: vi.fn(async () => []),
  folderTargetFromPath: vi.fn(),
  moveProject: vi.fn(),
  listBranches: vi.fn(),
  listFiles: vi.fn(),
  mergeBranchToMain: vi.fn(),
  readFile: vi.fn(),
  readSessionFile: vi.fn(),
  scopeOf: vi.fn(),
  resolveProjectRef: vi.fn(
    async (_ws: string, _ref: string, options?: { fetchOnMiss?: boolean }) => {
      state.events.push(
        options?.fetchOnMiss ? "synthesize(fetch-on-miss)" : "synthesize",
      );
      return state.project;
    },
  ),
  worktreeStatus: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../apps/bindings.service", () => ({
  materializeAppBinding: vi.fn(async () => {
    state.events.push("materialize");
    return { rowCount: 1, byteSize: 10, materializedAt: new Date() };
  }),
}));

vi.mock("../../apps/repository.service", () => ({
  DEFAULT_BRANCH: "main",
  repoDirFor: vi.fn(() => "/repo"),
  resolveCommit: vi.fn(),
}));

vi.mock("../../apps/git", () => ({ runGit: vi.fn() }));
vi.mock("../../apps/deployment.service", () => ({
  buildLogPath: vi.fn(() => "/tmp/build.log"),
}));
vi.mock("../../apps/sandbox/provider", () => ({
  getSandboxProvider: vi.fn(() => ({ hasSession: vi.fn(async () => false) })),
}));
vi.mock("../../apps/dev-server.service", () => ({
  devConsolePath: vi.fn(),
  devLogPath: vi.fn(),
  ensureDevServer: vi.fn(),
}));
vi.mock("../../services/dashboard-artifact-store.service", () => ({
  getDashboardArtifactStore: vi.fn(),
}));
vi.mock("../../apps/eyes.service", () => ({
  browseApp: vi.fn(),
  eyesShotKey: vi.fn(),
}));
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));

import { createAppsTools } from "./apps-tools";
import {
  execInWorktree,
  grepFiles,
  readFile,
  writeWorktreeScratchFile,
} from "../../apps/worktree.service";
import {
  BASH_STDOUT_MAX_CHARS,
  GREP_MAX_MATCHES,
  READ_DEFAULT_LIMIT_LINES,
} from "./shared/output-cap";

type Executable = {
  execute: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

const tools = () =>
  createAppsTools({
    workspaceId: "6a9411eb4c8b33609a65e666",
  }) as unknown as Record<string, Executable>;

const execResult = (stdout: string, stderr = "") => ({
  exitCode: 0,
  stdout,
  stderr,
  timedOut: false,
  truncated: false,
  durationMs: 5,
});

beforeEach(() => {
  state.events = [];
  vi.clearAllMocks();
});

describe("app_bash output cap", () => {
  it("returns small output untouched, without a cap note", async () => {
    vi.mocked(execInWorktree).mockResolvedValue(execResult("ok\n"));
    const result = await tools().app_bash.execute(
      { appId: "sales", command: "echo ok" },
      { toolCallId: "call_1", messages: [] },
    );
    expect(result.stdout).toBe("ok\n");
    expect(result.outputCapped).toBeUndefined();
    expect(writeWorktreeScratchFile).not.toHaveBeenCalled();
  });

  it("keeps head and tail, saves the full output, and says where", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const stdout = `${lines.join("\n")}\nBUILD FAILED: missing export\n`;
    vi.mocked(execInWorktree).mockResolvedValue(execResult(stdout));
    vi.mocked(writeWorktreeScratchFile).mockResolvedValue(
      "/tmp/mako-tool-output/call_2.log",
    );

    const result = await tools().app_bash.execute(
      { appId: "sales", command: "npm run build" },
      { toolCallId: "call_2", messages: [] },
    );

    const text = result.stdout as string;
    expect(text.length).toBeLessThan(BASH_STDOUT_MAX_CHARS + 200);
    expect(text.startsWith("line 0\n")).toBe(true);
    expect(text).toContain("BUILD FAILED: missing export");
    expect(text).toMatch(/chars omitted/);

    const [, relPath, saved] = vi.mocked(writeWorktreeScratchFile).mock
      .calls[0];
    expect(relPath).toBe("mako-tool-output/call_2.log");
    expect(saved).toContain(stdout);
    expect(vi.mocked(writeWorktreeScratchFile).mock.calls[0][3]).toEqual({
      keepNewest: 20,
    });

    const capped = result.outputCapped as Record<string, unknown>;
    expect(capped.fullOutputPath).toBe("/tmp/mako-tool-output/call_2.log");
    expect(capped.note).toMatch(/grep, tail or sed/);
  });

  it("still returns the capped output when saving the full copy fails", async () => {
    vi.mocked(execInWorktree).mockResolvedValue(
      execResult("x".repeat(BASH_STDOUT_MAX_CHARS * 3)),
    );
    vi.mocked(writeWorktreeScratchFile).mockRejectedValue(
      new Error("sandbox gone"),
    );
    const result = await tools().app_bash.execute(
      { appId: "sales", command: "cat big" },
      { toolCallId: "call_3", messages: [] },
    );
    expect(result.success).toBe(true);
    const capped = result.outputCapped as Record<string, unknown>;
    expect(capped.fullOutputPath).toBeUndefined();
    expect(capped.note).toMatch(/could not be saved/);
  });
});

describe("app_read_file paging", () => {
  const file = (lines: number) => ({
    path: "src/big.ts",
    contents: Array.from({ length: lines }, (_, i) => `const v${i} = ${i};`)
      .join("\n")
      .concat("\n"),
    isBinary: false,
    size: 0,
  });

  it("reads a small file whole, with no paging fields", async () => {
    vi.mocked(readFile).mockResolvedValue(file(3));
    const result = await tools().app_read_file.execute({
      appId: "sales",
      path: "src/big.ts",
    });
    expect(result.contents).toBe(
      "    1\u2502const v0 = 0;\n    2\u2502const v1 = 1;\n    3\u2502const v2 = 2;",
    );
    expect(result.nextOffset).toBeUndefined();
    expect(result.totalLines).toBeUndefined();
  });

  it("stops at the default line limit and points at the next page", async () => {
    vi.mocked(readFile).mockResolvedValue(file(READ_DEFAULT_LIMIT_LINES + 10));
    const result = await tools().app_read_file.execute({
      appId: "sales",
      path: "src/big.ts",
    });
    expect(result.endLine).toBe(READ_DEFAULT_LIMIT_LINES);
    expect(result.totalLines).toBe(READ_DEFAULT_LIMIT_LINES + 10);
    expect(result.nextOffset).toBe(READ_DEFAULT_LIMIT_LINES + 1);
  });

  it("numbers lines from the offset, so edits anchor correctly", async () => {
    vi.mocked(readFile).mockResolvedValue(file(50));
    const result = await tools().app_read_file.execute({
      appId: "sales",
      path: "src/big.ts",
      offset: 41,
      limit: 2,
    });
    expect(result.contents).toBe(
      "   41\u2502const v40 = 40;\n   42\u2502const v41 = 41;",
    );
    expect(result.nextOffset).toBe(43);
  });

  it("shortens a minified line instead of returning all of it", async () => {
    vi.mocked(readFile).mockResolvedValue({
      path: "dist/app.js",
      contents: "a".repeat(200_000),
      isBinary: false,
      size: 200_000,
    });
    const result = await tools().app_read_file.execute({
      appId: "sales",
      path: "dist/app.js",
    });
    expect((result.contents as string).length).toBeLessThan(2_100);
    expect(result.longLinesCut).toBe(1);
  });
});

describe("app_grep cap", () => {
  it("caps the match count and long matched lines", async () => {
    vi.mocked(grepFiles).mockResolvedValue(
      Array.from({ length: GREP_MAX_MATCHES + 1 }, (_, i) => ({
        path: "src/a.ts",
        line: i + 1,
        text: i === 0 ? "z".repeat(5_000) : "match",
      })),
    );
    const result = await tools().app_grep.execute({
      appId: "sales",
      pattern: "match",
    });
    expect(vi.mocked(grepFiles).mock.calls[0][3]).toMatchObject({
      maxMatches: GREP_MAX_MATCHES + 1,
    });
    expect(result.count).toBe(GREP_MAX_MATCHES);
    expect(result.truncated).toBe(true);
    const first = (result.matches as Array<{ text: string }>)[0];
    expect(first.text.length).toBeLessThan(600);
  });
});
