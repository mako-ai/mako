import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Types } from "mongoose";
import type {
  IAppV2Project,
  IAppV2Worktree,
} from "../database/workspace-schema";
import type { AuthEnv } from "../openapi/core";

const context = vi.hoisted(() => ({
  userId: "owner",
  authType: "session" as "session" | "apiKey",
  workspaceAllowed: true,
  workspaceChecks: 0,
  mergeConflict: false,
  listedBranchActor: "",
  mergedBranchActor: "",
}));

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: {
      json: (body: unknown, status: number) => Response;
      set: (key: string, value: unknown) => void;
    },
    next: () => Promise<void>,
  ) => {
    if (!context.userId) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    c.set("user", { id: context.userId });
    c.set("authType", context.authType);
    await next();
  },
}));

vi.mock("../middleware/workspace.middleware", () => ({
  requireWorkspace: async (
    c: {
      json: (body: unknown, status: number) => Response;
      set: (key: string, value: unknown) => void;
    },
    next: () => Promise<void>,
  ) => {
    context.workspaceChecks += 1;
    if (!context.workspaceAllowed) {
      return c.json({ success: false, error: "Workspace not found" }, 404);
    }
    c.set("memberRole", "member");
    await next();
  },
}));

const workspaceId = new Types.ObjectId();
const projectId = new Types.ObjectId();
const worktreeId = new Types.ObjectId();
const agentWorktreeId = new Types.ObjectId();
const oid = "a".repeat(40);
const project = {
  _id: projectId,
  workspaceId,
  title: "Private app",
  access: "private",
  workspaceRole: "viewer",
  sharedWith: [{ userId: "viewer", role: "viewer" }],
  owner_id: "owner",
  repositoryProvider: "mako-git",
  repositoryId: projectId.toString(),
  defaultBranch: "main",
  headSha: oid,
  deletionStatus: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as IAppV2Project;
const worktree = {
  _id: worktreeId,
  workspaceId,
  projectId,
  actorId: "owner",
  kind: "manual",
  contextKey: "manual",
  branch: "main",
  baseSha: oid,
  wipRef: `refs/mako/worktrees/${worktreeId.toString()}`,
  wipOid: oid,
  revision: 0,
  leaseEpoch: 1,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as IAppV2Worktree;

vi.mock("../apps-v2/app-project.service", async () => {
  const { AppV2MergeConflictError, AppV2NotFoundError } =
    await vi.importActual<typeof import("./errors")>("./errors");
  return {
    AppV2ProjectService: class {
      async list() {
        return context.userId === "owner" ? [project] : [];
      }
      async getReadable() {
        if (context.userId !== "owner" && context.userId !== "viewer") {
          throw new AppV2NotFoundError("Project not found");
        }
        return project;
      }
      async getWritable() {
        if (context.userId !== "owner") {
          throw new AppV2NotFoundError("Project not found");
        }
        return project;
      }
      async listConversationBranches(
        _project: unknown,
        actor: { userId: string },
      ) {
        context.listedBranchActor = actor.userId;
        return [
          {
            worktree: {
              chatId: "64b7f0f0f0f0f0f0f0f0f0f0",
              branch: "mako/chat/64b7f0f0f0f0f0f0f0f0f0f0",
              baseSha: oid,
              wipOid: "b".repeat(40),
              status: "active",
            },
            git: {
              name: "mako/chat/64b7f0f0f0f0f0f0f0f0f0f0",
              headSha: "c".repeat(40),
              isDefault: false,
              aheadBy: 1,
              behindBy: 0,
              lastCommit: {
                sha: "c".repeat(40),
                treeSha: "d".repeat(40),
                parentShas: [oid],
                authorName: "Mako Agent",
                authorEmail: "agent@mako.local",
                authoredAt: new Date("2026-01-01T00:00:00.000Z"),
                message: "Agent turn",
                stats: { filesChanged: 1, additions: 1, deletions: 0 },
              },
            },
            dirty: true,
          },
        ];
      }
      async mergeConversationBranchToDefault(
        _project: unknown,
        branch: string,
        actor: { userId: string },
      ) {
        context.mergedBranchActor = actor.userId;
        if (context.mergeConflict) {
          throw new AppV2MergeConflictError(
            "Conversation branch conflicts with main",
            branch,
            "main",
          );
        }
        return {
          project: { ...project, headSha: "e".repeat(40) },
          branch,
          branchHeadSha: "c".repeat(40),
          mergedSha: "e".repeat(40),
          fastForward: false,
        };
      }
    },
  };
});

vi.mock("../apps-v2/worktree.service", async () => {
  const { AppV2ConflictError, AppV2NotFoundError } =
    await vi.importActual<typeof import("./errors")>("./errors");
  return {
    AppV2WorktreeService: class {
      async getOrCreate() {
        return worktree;
      }
      async getById() {
        return worktree;
      }
      async getManualById(_project: unknown, requestedWorktreeId: string) {
        if (requestedWorktreeId === agentWorktreeId.toString()) {
          throw new AppV2NotFoundError("Worktree not found");
        }
        return worktree;
      }
      async getActorWorktree() {
        return worktree;
      }
      async write(
        _project: unknown,
        _worktree: unknown,
        state: { ifRevision: number },
      ) {
        if (state.ifRevision !== worktree.revision) {
          throw new AppV2ConflictError("Stale worktree mutation state");
        }
        return worktree;
      }
      async rotateLease(
        _project: unknown,
        _worktree: unknown,
        state: { ifRevision: number; leaseEpoch: number },
      ) {
        if (
          state.ifRevision !== worktree.revision ||
          state.leaseEpoch !== worktree.leaseEpoch
        ) {
          throw new AppV2ConflictError("Worktree lease changed concurrently");
        }
        return {
          ...worktree,
          revision: worktree.revision + 1,
          leaseEpoch: worktree.leaseEpoch + 1,
        };
      }
    },
  };
});

describe("Apps v2 route isolation", () => {
  let app: OpenAPIHono<AuthEnv>;

  beforeAll(async () => {
    process.env.APPS_V2_ENABLED = "true";
    process.env.APPS_V2_GITHUB_PUSH_ENABLED = "false";
    const { appsV2Routes } = await import("../routes/apps-v2");
    app = new OpenAPIHono<AuthEnv>();
    app.route("/api/workspaces/:workspaceId/apps-v2", appsV2Routes);
  });

  beforeEach(() => {
    process.env.APPS_V2_ENABLED = "true";
    process.env.APPS_V2_GITHUB_PUSH_ENABLED = "false";
    process.env.APPS_V2_SANDBOX_PROVIDER = "off";
    context.userId = "owner";
    context.authType = "session";
    context.workspaceAllowed = true;
    context.workspaceChecks = 0;
    context.mergeConflict = false;
    context.listedBranchActor = "";
    context.mergedBranchActor = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports feature availability after authentication and workspace scoping", async () => {
    const enabledResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/status`,
    );
    expect(enabledResponse.status).toBe(200);
    expect(await enabledResponse.json()).toEqual({
      enabled: true,
      sandboxAvailable: false,
      sandboxProvider: "off",
      githubPushAvailable: false,
    });

    process.env.APPS_V2_ENABLED = "false";
    const disabledResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/status`,
    );
    expect(disabledResponse.status).toBe(200);
    expect(await disabledResponse.json()).toEqual({
      enabled: false,
      sandboxAvailable: false,
      sandboxProvider: "off",
      githubPushAvailable: false,
    });
  });

  it("authenticates and scopes status before disclosing feature availability", async () => {
    process.env.APPS_V2_ENABLED = "false";
    context.userId = "";
    const unauthenticated = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/status`,
    );
    expect(unauthenticated.status).toBe(401);

    context.userId = "owner";
    context.workspaceAllowed = false;
    const wrongWorkspace = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/status`,
    );
    expect(wrongWorkspace.status).toBe(404);
  });

  it("rejects API-key auth before workspace or Apps v2 operations", async () => {
    context.authType = "apiKey";
    const base = `/api/workspaces/${workspaceId.toString()}/apps-v2`;
    const requests: Array<Promise<Response>> = [
      app.request(`${base}/status`),
      app.request(base),
      app.request(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Must not be created" }),
      }),
      app.request(
        `${base}/${projectId.toString()}/worktrees/${worktreeId.toString()}/file`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ifRevision: 0,
            expectedWipOid: oid,
            leaseEpoch: 1,
            path: "src/blocked.ts",
            content: "blocked",
            executable: false,
          }),
        },
      ),
      app.request(`${base}/${projectId.toString()}/session`, {
        method: "POST",
      }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        success: false,
        error: "Apps v2 requires session authentication",
      });
    }
    expect(context.workspaceChecks).toBe(0);

    context.authType = "session";
    const sessionStatus = await app.request(`${base}/status`);
    expect(sessionStatus.status).toBe(200);
    expect(context.workspaceChecks).toBe(1);
  });

  it("keeps non-status routes unavailable when the feature is disabled", async () => {
    process.env.APPS_V2_ENABLED = "false";
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Apps v2 feature is unavailable",
    });
    const flushResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/session/flush`,
      { method: "POST" },
    );
    expect(flushResponse.status).toBe(404);
    expect(await flushResponse.json()).toEqual({
      success: false,
      error: "Apps v2 feature is unavailable",
    });
  });

  it("keeps GitHub binding isolated behind its own disabled-by-default flag", async () => {
    process.env.APPS_V2_ENABLED = "true";
    process.env.APPS_V2_GITHUB_PUSH_ENABLED = "false";
    const base = `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}`;

    const githubResponse = await app.request(`${base}/github`);
    expect(githubResponse.status).toBe(404);
    expect(await githubResponse.json()).toEqual({
      success: false,
      error: "Apps v2 GitHub push is unavailable",
    });

    const projectResponse = await app.request(base);
    expect(projectResponse.status).toBe(200);
    expect(await projectResponse.json()).toMatchObject({
      project: { githubCanManage: false },
    });
  });

  it("rejects GitHub path and ref injection at the route boundary", async () => {
    process.env.APPS_V2_GITHUB_PUSH_ENABLED = "true";
    const path = `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/github`;
    const valid = {
      installationId: 42,
      owner: "mako",
      repo: "app",
      baseBranch: "main",
      autoPushOnTurnEnd: true,
    };
    for (const body of [
      { ...valid, owner: "../mako" },
      { ...valid, repo: "app?ref=other" },
      { ...valid, baseBranch: "../main" },
      { ...valid, baseBranch: "main?x=1" },
      { ...valid, subdirectory: "../secrets" },
    ]) {
      const response = await app.request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  it("does not disclose a private project to another workspace member", async () => {
    context.userId = "other-member";
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Project not found",
    });
  });

  it("lists only the caller's read-only conversation branch metadata", async () => {
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/conversation-branches`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      branches: [
        {
          chatId: "64b7f0f0f0f0f0f0f0f0f0f0",
          branch: "mako/chat/64b7f0f0f0f0f0f0f0f0f0f0",
          lastCommitSha: "c".repeat(40),
          headSha: "c".repeat(40),
          aheadBy: 1,
          behindBy: 0,
          dirty: true,
          lastCommit: { message: "Agent turn" },
          status: "active",
        },
      ],
    });
    expect(context.listedBranchActor).toBe("owner");
  });

  it("requires write access and returns structured merge conflicts", async () => {
    const branch = "mako/chat/64b7f0f0f0f0f0f0f0f0f0f0";
    const path = `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/conversation-branches/merge`;
    context.userId = "viewer";
    const denied = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    expect(denied.status).toBe(404);
    expect(context.mergedBranchActor).toBe("");

    context.userId = "owner";
    context.mergeConflict = true;
    const conflict = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      success: false,
      error: "Conversation branch conflicts with main",
      code: "merge_conflict",
      branch,
      defaultBranch: "main",
    });
  });

  it("merges an owned conversation branch and returns the new project head", async () => {
    const branch = "mako/chat/64b7f0f0f0f0f0f0f0f0f0f0";
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/conversation-branches/merge`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      project: { headSha: "e".repeat(40) },
      result: {
        branch,
        branchHeadSha: "c".repeat(40),
        mergedSha: "e".repeat(40),
        fastForward: false,
      },
    });
    expect(context.mergedBranchActor).toBe("owner");
  });

  it("allows a viewer to create a personal read-only worktree", async () => {
    context.userId = "viewer";
    const projectResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}`,
    );
    expect(projectResponse.status).toBe(200);
    expect(await projectResponse.json()).toMatchObject({
      project: { effectiveRole: "viewer", readOnly: true },
    });

    const worktreeResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/worktree`,
      { method: "POST" },
    );
    expect(worktreeResponse.status).toBe(200);
    expect(await worktreeResponse.json()).toMatchObject({
      success: true,
      worktree: { id: worktreeId.toString() },
    });

    const writeResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/worktrees/${worktreeId.toString()}/file`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ifRevision: 0,
          expectedWipOid: oid,
          leaseEpoch: 1,
          path: "src/App.tsx",
          content: "viewer write",
          executable: false,
        }),
      },
    );
    expect(writeResponse.status).toBe(404);
  });

  it("maps stale mutation state to 409", async () => {
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/worktrees/${worktreeId.toString()}/file`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ifRevision: 9,
          expectedWipOid: oid,
          leaseEpoch: 1,
          path: "src/App.tsx",
          content: "export default null",
          executable: false,
        }),
      },
    );
    expect(response.status).toBe(409);
  });

  it("does not expose an agent conversation worktree through manual routes", async () => {
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/worktrees/${agentWorktreeId.toString()}/file`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ifRevision: 0,
          expectedWipOid: oid,
          leaseEpoch: 1,
          path: "src/App.tsx",
          content: "should not write",
          executable: false,
        }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("rotates the actor lease and advances its fencing state", async () => {
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/worktree/lease`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ifRevision: 0,
          expectedWipOid: oid,
          leaseEpoch: 1,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      worktree: { revision: number; leaseEpoch: number };
    };
    expect(body.worktree).toMatchObject({ revision: 1, leaseEpoch: 2 });
  });

  it("returns provider_unavailable without affecting other Apps v2 APIs", async () => {
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/session`,
      { method: "POST" },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: "Apps v2 sandbox provider is unavailable",
      code: "provider_unavailable",
    });
    const flushResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/session/flush`,
      { method: "POST" },
    );
    expect(flushResponse.status).toBe(503);

    const projectResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}`,
    );
    expect(projectResponse.status).toBe(200);
  });

  it("rejects shell execution inputs that escape the workspace", async () => {
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/session/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          argv: ["echo", "safe"],
          cwd: "../outside",
          timeoutMs: 1_000,
        }),
      },
    );
    expect(response.status).toBe(400);

    const excessiveTimeout = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/session/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          argv: ["echo", "safe"],
          cwd: "",
          timeoutMs: 10 * 60 * 1_000 + 1,
        }),
      },
    );
    expect(excessiveTimeout.status).toBe(400);

    const excessiveDepth = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/session/exec`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          argv: ["echo", "safe"],
          cwd: Array.from({ length: 65 }, () => "directory").join("/"),
          timeoutMs: 1_000,
        }),
      },
    );
    expect(excessiveDepth.status).toBe(400);
  });

  it("does not authenticate a caller missing a user principal", async () => {
    context.userId = "";
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2`,
    );
    expect(response.status).toBe(401);
  });
});
