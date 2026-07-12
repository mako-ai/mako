import { beforeAll, describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Types } from "mongoose";
import type {
  IAppV2Project,
  IAppV2Worktree,
} from "../database/workspace-schema";
import type { AuthEnv } from "../openapi/core";

const calls = vi.hoisted(() => ({
  installedPackages: [] as string[],
}));

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "actor" });
    c.set("authType", "session");
    await next();
  },
}));

vi.mock("../middleware/workspace.middleware", () => ({
  requireWorkspace: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("memberRole", "member");
    await next();
  },
}));

vi.mock("./config", async () => {
  const actual = await vi.importActual<typeof import("./config")>("./config");
  return {
    ...actual,
    isAppsV2Enabled: () => true,
    getAppsV2SandboxConfiguration: () => ({
      available: true,
      provider: "e2b",
      apiKey: "control-only",
      templateId: "pinned",
      user: "mako",
    }),
  };
});

vi.mock("./providers/sandbox-provider-factory", () => ({
  createAppsV2SandboxProvider: () => ({ name: "fake" }),
}));

vi.mock("./cloud-session-executor", () => ({
  CloudSessionExecutor: class {},
}));

const workspaceId = new Types.ObjectId();
const projectId = new Types.ObjectId();
const worktreeId = new Types.ObjectId();
const oid = "a".repeat(40);
const project = {
  _id: projectId,
  workspaceId,
  repositoryId: projectId.toString(),
  defaultBranch: "main",
  headSha: oid,
  deletionStatus: "active",
} as unknown as IAppV2Project;
const worktree = {
  _id: worktreeId,
  workspaceId,
  projectId,
  actorId: "actor",
  branch: "main",
  baseSha: oid,
  wipOid: oid,
  revision: 0,
  leaseEpoch: 1,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as IAppV2Worktree;
const session = {
  id: new Types.ObjectId().toString(),
  workspaceId: workspaceId.toString(),
  projectId: projectId.toString(),
  worktreeId: worktreeId.toString(),
  actorId: "actor",
  purpose: "dev" as const,
  provider: "fake",
  sandboxId: "sandbox",
  generation: 0,
  leaseEpoch: 1,
  appliedWipOid: oid,
  status: "active" as const,
  lastActiveAt: new Date(),
};
const flush = {
  excludedPaths: [],
  durability: {
    status: "durable" as const,
    revision: { wipOid: oid, revision: 0 },
  },
};

vi.mock("./app-project.service", () => ({
  AppV2ProjectService: class {
    async getWritable() {
      return project;
    }
  },
}));

vi.mock("./worktree.service", () => ({
  AppV2WorktreeService: class {
    async getActorWorktree() {
      return worktree;
    }
    async getOrCreate() {
      return worktree;
    }
  },
}));

vi.mock("./session.service", () => ({
  AppV2SessionService: class {
    async get() {
      return session;
    }
    async ensure() {
      return { session, worktree };
    }
    async exec() {
      return {
        exitCode: 0,
        stdout: "literal argv",
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        excludedPaths: [],
        durability: {
          status: "durable",
          revision: { wipOid: "b".repeat(40), revision: 1 },
        },
      };
    }
    async install(
      _project: unknown,
      _worktree: unknown,
      _actor: unknown,
      request: { packages: string[] },
    ) {
      calls.installedPackages = [...request.packages];
      return {
        exitCode: 0,
        stdout: "installed",
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        excludedPaths: ["node_modules"],
        durability: {
          status: "durable",
          revision: { wipOid: "c".repeat(40), revision: 2 },
        },
      };
    }
    async pause() {
      return {
        session: { ...session, status: "paused" },
        worktree,
        flush,
      };
    }
    async flush() {
      return { session, worktree, flush };
    }
    async destroy() {
      return {
        session: { ...session, status: "destroyed" },
        worktree: { ...worktree, revision: 1, leaseEpoch: 2 },
        flush,
      };
    }
  },
}));

describe("Apps v2 session routes", () => {
  let app: OpenAPIHono<AuthEnv>;
  const base = `/api/workspaces/${workspaceId.toString()}/apps-v2/${projectId.toString()}/session`;

  beforeAll(async () => {
    const { appsV2Routes } = await import("../routes/apps-v2");
    app = new OpenAPIHono<AuthEnv>();
    app.route("/api/workspaces/:workspaceId/apps-v2", appsV2Routes);
  });

  it("wires ensure, get, finite exec, install, flush, pause, and destroy", async () => {
    const status = await app.request(
      `/api/workspaces/${workspaceId.toString()}/apps-v2/status`,
    );
    expect(await status.json()).toEqual({
      enabled: true,
      sandboxAvailable: true,
      sandboxProvider: "e2b",
      githubPushAvailable: false,
    });
    expect((await app.request(base, { method: "POST" })).status).toBe(200);
    expect((await app.request(base)).status).toBe(200);

    const execution = await app.request(`${base}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        argv: ["printf", "%s", "; rm -rf /"],
        cwd: "src",
        timeoutMs: 1_000,
      }),
    });
    expect(execution.status).toBe(200);
    expect(await execution.json()).toMatchObject({
      success: true,
      result: {
        stdout: "literal argv",
        durability: { status: "durable" },
      },
    });

    const installation = await app.request(`${base}/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packages: ["react@^18.3.1", "@scope/pkg@latest"],
      }),
    });
    expect(installation.status).toBe(200);
    expect(calls.installedPackages).toEqual([
      "react@^18.3.1",
      "@scope/pkg@latest",
    ]);
    expect(await installation.json()).toMatchObject({
      success: true,
      result: {
        stdout: "installed",
        excludedPaths: ["node_modules"],
        durability: { status: "durable" },
      },
    });

    expect(
      (await app.request(`${base}/flush`, { method: "POST" })).status,
    ).toBe(200);

    expect(
      (await app.request(`${base}/pause`, { method: "POST" })).status,
    ).toBe(200);
    const destroyed = await app.request(base, { method: "DELETE" });
    expect(destroyed.status).toBe(200);
    expect(await destroyed.json()).toMatchObject({
      session: { status: "destroyed" },
      worktree: { leaseEpoch: 2 },
    });
  });

  it("rejects non-registry specs and arbitrary install controls", async () => {
    for (const body of [
      { packages: ["file:../private-package"] },
      { packages: ["react"], networkPhase: "allow-all" },
      { packages: [] },
    ]) {
      const response = await app.request(`${base}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });
});
