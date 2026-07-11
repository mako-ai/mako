import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Types } from "mongoose";
import type {
  IAppV2Project,
  IAppV2Worktree,
} from "../database/workspace-schema";
import type { AuthEnv } from "../openapi/core";

const context = vi.hoisted(() => ({
  userId: "owner",
  workspaceAllowed: true,
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
  const { AppV2NotFoundError } =
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
    },
  };
});

vi.mock("../apps-v2/worktree.service", async () => {
  const { AppV2ConflictError } =
    await vi.importActual<typeof import("./errors")>("./errors");
  return {
    AppV2WorktreeService: class {
      async getOrCreate() {
        return worktree;
      }
      async getById() {
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
    const { appsV2Routes } = await import("../routes/apps-v2");
    app = new OpenAPIHono<AuthEnv>();
    app.route("/api/workspaces/:workspaceId/apps-v2", appsV2Routes);
  });

  beforeEach(() => {
    process.env.APPS_V2_ENABLED = "true";
    context.userId = "owner";
    context.workspaceAllowed = true;
  });

  it("reports feature availability after authentication and workspace scoping", async () => {
    const enabledResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/status`,
    );
    expect(enabledResponse.status).toBe(200);
    expect(await enabledResponse.json()).toEqual({ enabled: true });

    process.env.APPS_V2_ENABLED = "false";
    const disabledResponse = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/status`,
    );
    expect(disabledResponse.status).toBe(200);
    expect(await disabledResponse.json()).toEqual({ enabled: false });
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

  it("does not authenticate a caller missing a user principal", async () => {
    context.userId = "";
    const response = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2`,
    );
    expect(response.status).toBe(401);
  });
});
