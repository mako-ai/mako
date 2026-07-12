import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type {
  IAppV2Project,
  IAppV2Worktree,
} from "../../database/workspace-schema";
import { AppV2NotFoundError } from "../../apps-v2/errors";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { createAppsV2Tools } from "./apps-v2-tools";

vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    getMember: vi.fn(async () => ({ role: "member" })),
  },
}));
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));

const workspaceId = new Types.ObjectId();
const projectId = new Types.ObjectId();
const worktreeId = new Types.ObjectId();
const chatId = new Types.ObjectId().toString();
const turnId = "turn-test";
const initialOid = "a".repeat(40);
const touchProject = vi.fn(async () => undefined);
const assertOwnership = vi.fn(async () => undefined);

function project(): IAppV2Project {
  return {
    _id: projectId,
    workspaceId,
    title: "Agent Project",
    description: "Test project",
    access: "private",
    workspaceRole: "viewer",
    sharedWith: [],
    owner_id: "user-1",
    createdBy: "user-1",
    repositoryProvider: "mako-git",
    repositoryId: projectId.toString(),
    defaultBranch: "main",
    headSha: initialOid,
    mutationRevision: 0,
    deletionStatus: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as IAppV2Project;
}

function worktree(revision = 0, wipOid = initialOid): IAppV2Worktree {
  return {
    _id: worktreeId,
    workspaceId,
    projectId,
    actorId: "user-1",
    branch: "main",
    baseSha: initialOid,
    wipRef: "refs/mako/worktrees/test/wip",
    wipOid,
    leaseRef: "refs/mako/worktrees/test/lease",
    leaseOid: "b".repeat(40),
    revision,
    leaseEpoch: 1,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as IAppV2Worktree;
}

type ToolOutput = Record<string, unknown>;
type ExecutableTool = {
  execute?: (input: unknown, options: unknown) => Promise<unknown>;
};

async function execute(
  tools: ReturnType<typeof createAppsV2Tools>,
  name: string,
  input: Record<string, unknown>,
  abortSignal = new AbortController().signal,
): Promise<ToolOutput> {
  const selected = tools[name] as ExecutableTool | undefined;
  if (!selected?.execute) throw new Error(`Missing executable tool: ${name}`);
  return (await selected.execute(input, {
    toolCallId: `call-${name}`,
    messages: [],
    abortSignal,
  })) as ToolOutput;
}

function createMockServices(options?: {
  sessions?: {
    ensure: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    install: ReturnType<typeof vi.fn>;
  };
}) {
  let currentWorktree = worktree();
  let contents = "export const value = 1;\n";
  const calls = {
    create: vi.fn(async () => project()),
    getReadable: vi.fn(async () => project()),
    getWritable: vi.fn(async (_workspace: string, id: string) => {
      if (id === "private-project") {
        throw new AppV2NotFoundError("Project not found");
      }
      return project();
    }),
    write: vi.fn(
      async (
        _project: IAppV2Project,
        _worktree: IAppV2Worktree,
        _state: unknown,
        _path: string,
        nextContents: string,
      ) => {
        contents = nextContents;
        currentWorktree = worktree(
          currentWorktree.revision + 1,
          String(currentWorktree.revision + 2)
            .padStart(40, "c")
            .slice(0, 40),
        );
        return currentWorktree;
      },
    ),
    commit: vi.fn(async () => ({
      worktree: worktree(3, "d".repeat(40)),
      sha: "e".repeat(40),
    })),
    getOrCreateAgent: vi.fn(async () => currentWorktree),
  };
  return {
    calls,
    services: () => ({
      projects: {
        list: vi.fn(async () => [project()]),
        create: calls.create,
        getReadable: calls.getReadable,
        getWritable: calls.getWritable,
      },
      worktrees: {
        getOrCreateAgent: calls.getOrCreateAgent,
        tree: vi.fn(async () => [
          {
            path: "src/App.tsx",
            oid: initialOid,
            size: contents.length,
            mode: "regular" as const,
          },
        ]),
        read: vi.fn(async () => ({
          entry: {
            path: "src/App.tsx",
            oid: currentWorktree.wipOid,
            size: contents.length,
            mode: "regular" as const,
          },
          content: contents,
        })),
        write: calls.write,
        delete: vi.fn(async () => worktree(2, "f".repeat(40))),
        move: vi.fn(async () => worktree(2, "f".repeat(40))),
        status: vi.fn(async () => ({ clean: false, changes: [] })),
        commit: calls.commit,
      },
      sessions: options?.sessions,
    }),
  };
}

beforeEach(() => {
  process.env.APPS_V2_ENABLED = "true";
  vi.clearAllMocks();
});

describe("Apps v2 agent tools", () => {
  it("is flag/principal gated and never registers Apps v1 names", () => {
    const { services } = createMockServices();
    expect(
      Object.keys(
        createAppsV2Tools({
          workspaceId: workspaceId.toString(),
          authType: "session",
          services,
        }),
      ),
    ).toEqual([]);
    expect(
      Object.keys(
        createAppsV2Tools({
          workspaceId: workspaceId.toString(),
          authType: "apiKey",
          userId: "real-user-id",
          services,
        }),
      ),
    ).toEqual([]);

    const names = Object.keys(
      createAppsV2Tools({
        workspaceId: workspaceId.toString(),
        authType: "session",
        userId: "user-1",
        chatId,
        turnId,
        touchProject,
        assertOwnership,
        services,
      }),
    );
    expect(names.every(name => name.startsWith("app2_"))).toBe(true);
    expect(names).not.toContain("create_app");
    expect(names).not.toContain("app_write_file");
    expect(
      Object.keys(
        createAppsV2Tools({
          workspaceId: workspaceId.toString(),
          authType: "session",
          userId: "user-1",
          chatId: "../main",
          turnId,
          touchProject,
          assertOwnership,
          services,
        }),
      ),
    ).toEqual([]);
  });

  it("delegates hidden-project ACL checks to the project service", async () => {
    const { services } = createMockServices();
    const tools = createAppsV2Tools({
      workspaceId: workspaceId.toString(),
      authType: "session",
      userId: "user-1",
      chatId,
      turnId,
      touchProject,
      assertOwnership,
      services,
    });

    const output = await execute(tools, "app2_write_file", {
      projectId: "private-project",
      path: "src/App.tsx",
      contents: "denied",
    });
    expect(output).toMatchObject({
      success: false,
      projectId: "private-project",
      appId: "private-project",
      error: "Project not found",
    });
  });

  it("fences an older tool factory when a newer turn takes ownership", async () => {
    const { services, calls } = createMockServices();
    let activeTurnId = "turn-a";
    const durableOwnership = vi.fn(async (identity: { turnId: string }) => {
      if (identity.turnId !== activeTurnId) {
        throw new Error("A newer chat turn superseded this Apps v2 operation");
      }
    });
    const createTurnTools = (factoryTurnId: string) =>
      createAppsV2Tools({
        workspaceId: workspaceId.toString(),
        authType: "session",
        userId: "user-1",
        chatId,
        turnId: factoryTurnId,
        touchProject,
        assertOwnership: durableOwnership,
        services,
      });
    const olderTools = createTurnTools("turn-a");
    const newerTools = createTurnTools("turn-b");

    activeTurnId = "turn-b";
    const stale = await execute(olderTools, "app2_write_file", {
      projectId: projectId.toString(),
      path: "src/App.tsx",
      contents: "stale",
    });
    const current = await execute(newerTools, "app2_write_file", {
      projectId: projectId.toString(),
      path: "src/App.tsx",
      contents: "current",
    });

    expect(stale).toMatchObject({
      success: false,
      error: expect.stringContaining("newer chat turn superseded"),
    });
    expect(current).toMatchObject({ success: true });
    expect(calls.write).toHaveBeenCalledOnce();
  });

  it("creates, writes, anchored-edits, and commits through secure services", async () => {
    const { services, calls } = createMockServices();
    const tools = createAppsV2Tools({
      workspaceId: workspaceId.toString(),
      authType: "session",
      userId: "user-1",
      chatId,
      turnId,
      touchProject,
      assertOwnership,
      services,
    });

    const created = await execute(tools, "app2_create_app", {
      title: "Agent Project",
    });
    expect(created).toMatchObject({
      success: true,
      projectId: projectId.toString(),
      appId: projectId.toString(),
      files: ["src/App.tsx"],
    });
    expect(calls.create).toHaveBeenCalledWith(
      workspaceId.toString(),
      expect.objectContaining({ userId: "user-1" }),
      expect.objectContaining({ access: "private" }),
    );

    const written = await execute(tools, "app2_write_file", {
      projectId: projectId.toString(),
      path: "src/App.tsx",
      contents: "export const value = 2;\n",
    });
    expect(written).toMatchObject({ success: true, revision: 1 });

    const edited = await execute(tools, "app2_edit_file", {
      projectId: projectId.toString(),
      path: "src/App.tsx",
      oldString: "value = 2",
      newString: "value = 3",
    });
    expect(edited).toMatchObject({ success: true, replacements: 1 });
    expect(calls.write).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        ifRevision: 1,
        expectedWipOid: expect.any(String),
        leaseEpoch: 1,
      }),
      "src/App.tsx",
      "export const value = 3;\n",
      false,
    );

    const committed = await execute(tools, "app2_commit", {
      projectId: projectId.toString(),
      message: "Finish agent project",
    });
    expect(committed).toMatchObject({
      success: true,
      sha: "e".repeat(40),
      projectId: projectId.toString(),
      appId: projectId.toString(),
    });
    expect(calls.commit).toHaveBeenCalledOnce();
    expect(publishRealtimeEvent).toHaveBeenCalledWith(
      workspaceId.toString(),
      expect.objectContaining({
        type: "app-v2.commit.created",
        forUserId: "user-1",
      }),
    );
    expect(calls.getOrCreateAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1" }),
      chatId,
    );
  });

  it("returns provider unavailable for bash while Git/file tools stay active", async () => {
    const { services } = createMockServices();
    const tools = createAppsV2Tools({
      workspaceId: workspaceId.toString(),
      authType: "session",
      userId: "user-1",
      chatId,
      turnId,
      touchProject,
      assertOwnership,
      services,
    });

    const output = await execute(tools, "app2_bash", {
      projectId: projectId.toString(),
      command: "pwd",
    });
    expect(output).toMatchObject({
      success: false,
      code: "provider_unavailable",
      projectId: projectId.toString(),
      appId: projectId.toString(),
    });
    expect(tools.app2_read_file).toBeDefined();
    expect(tools.app2_commit).toBeDefined();
  });

  it("dispatches Bash argv and registry packages to dedicated session methods", async () => {
    const durableResult = {
      exitCode: 0,
      stdout: "installed",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      excludedPaths: ["node_modules"],
      durability: {
        status: "durable" as const,
        revision: { wipOid: "f".repeat(40), revision: 4 },
      },
    };
    const session = {
      ensure: vi.fn(async () => ({
        session: { status: "active" },
        worktree: worktree(),
      })),
      exec: vi.fn(async () => durableResult),
      install: vi.fn(async () => durableResult),
    };
    const { services } = createMockServices({ sessions: session });
    const tools = createAppsV2Tools({
      workspaceId: workspaceId.toString(),
      authType: "session",
      userId: "user-1",
      chatId,
      turnId,
      touchProject,
      assertOwnership,
      services,
    });

    const shellOutput = await execute(tools, "app2_bash", {
      projectId: projectId.toString(),
      command: "printf '%s' \"$HOME\"",
      cwd: "src",
      timeoutMs: 12_000,
    });
    expect(shellOutput).toMatchObject({ success: true });
    expect(session.exec).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: "user-1" }),
      expect.objectContaining({
        argv: ["bash", "-lc", "printf '%s' \"$HOME\""],
        cwd: "/workspace/src",
        timeoutMs: 12_000,
        signal: expect.any(AbortSignal),
      }),
    );

    const output = await execute(tools, "app2_install_packages", {
      projectId: projectId.toString(),
      packages: ["zod@latest", "@types/node"],
    });
    expect(output).toMatchObject({ success: true });
    expect(session.install).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: "user-1" }),
      expect.objectContaining({
        packages: ["zod@latest", "@types/node"],
        signal: expect.any(AbortSignal),
      }),
    );
    expect(session.exec).toHaveBeenCalledOnce();
  });

  it("rechecks ownership after a long sandbox operation before acknowledging", async () => {
    let activeTurnId = "turn-a";
    const durableOwnership = vi.fn(async (identity: { turnId: string }) => {
      if (identity.turnId !== activeTurnId) {
        throw new Error("A newer chat turn superseded this Apps v2 operation");
      }
    });
    const durableResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      excludedPaths: [],
      durability: {
        status: "durable" as const,
        revision: { wipOid: "f".repeat(40), revision: 4 },
      },
    };
    const session = {
      ensure: vi.fn(async () => ({
        session: { status: "active" },
        worktree: worktree(),
      })),
      exec: vi.fn(async () => {
        activeTurnId = "turn-b";
        return durableResult;
      }),
      install: vi.fn(),
    };
    const { services } = createMockServices({ sessions: session });
    const tools = createAppsV2Tools({
      workspaceId: workspaceId.toString(),
      authType: "session",
      userId: "user-1",
      chatId,
      turnId: "turn-a",
      touchProject,
      assertOwnership: durableOwnership,
      services,
    });

    const output = await execute(tools, "app2_bash", {
      projectId: projectId.toString(),
      command: "npm run build",
    });

    expect(session.exec).toHaveBeenCalledOnce();
    expect(output).toMatchObject({
      success: false,
      error: expect.stringContaining("newer chat turn superseded"),
    });
  });

  it("propagates chat cancellation through ensure and provider operations", async () => {
    const session = {
      ensure: vi.fn(async () => ({
        session: { status: "active" },
        worktree: worktree(),
      })),
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        excludedPaths: [],
        durability: {
          status: "durable" as const,
          revision: { wipOid: "f".repeat(40), revision: 4 },
        },
      })),
      install: vi.fn(),
    };
    const chatAbort = new AbortController();
    const toolAbort = new AbortController();
    const { services } = createMockServices({ sessions: session });
    const tools = createAppsV2Tools({
      workspaceId: workspaceId.toString(),
      authType: "session",
      userId: "user-1",
      chatId,
      turnId,
      touchProject,
      assertOwnership,
      executionContext: {
        signal: chatAbort.signal,
        createExecutionId: vi.fn(() => "execution-1"),
        registerExecution: vi.fn(),
        releaseExecution: vi.fn(),
        isAborted: () => chatAbort.signal.aborted,
      },
      services,
    });

    await execute(
      tools,
      "app2_bash",
      { projectId: projectId.toString(), command: "sleep 30" },
      toolAbort.signal,
    );

    const ensureSignal = session.ensure.mock.calls[0][3] as AbortSignal;
    const execSignal = session.exec.mock.calls[0][3].signal as AbortSignal;
    expect(ensureSignal).toBe(execSignal);
    expect(execSignal.aborted).toBe(false);
    chatAbort.abort();
    expect(execSignal.aborted).toBe(true);
  });
});
