/**
 * Every surface that creates an app names the person who asked for it.
 *
 * The UI route, in-app chat (createAppsTools as the agent builds it) and MCP
 * (buildMakoMcpToolset) all end in createProject. Each must leave:
 *  - an app row owned by the requester (owner_id and createdBy), and
 *  - a scaffold commit authored by the requester, committed by Mako
 *    (bot@mako.ai), carrying a `Mako-Requested-By: <userId>` trailer.
 * Real git, a real local sandbox and PGlite; only auth is faked.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  generateObjectIdHex,
  legacyUserIdToUuidv7,
} from "../database/pg/id-codec";
import {
  ensureTestMember,
  ensureTestUser,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";
import type { Context, Next } from "hono";

const identity = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (c: Context, next: Next) => {
    c.set("user", { id: identity.userId, email: "ui@example.com" });
    await next();
  },
}));

import { startTestGitServer, type TestGitServer } from "./test-git-server";
import { initRepo, repoDirFor } from "./repository.service";
import { seededTemplateFiles } from "./workspace-template";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";
import { createProject, REQUESTED_BY_TRAILER } from "./worktree/projects";
import { appsMetadataRepo } from "../repositories/apps-metadata";
import { authRepo } from "../repositories/auth";
import { createRouter } from "../openapi/core";
import { appsRoutes } from "../routes/apps";
import { createAppsTools } from "../agent-lib/tools/apps-tools";
import { buildMakoMcpToolset } from "../mcp/mako-mcp-server";
import { WORKSPACE_API_KEY_SCOPES } from "../auth/api-key-scopes";

// Real Mako ids: 15 characters (auth.service.ts generateId).
const UI_USER = "u1b2c3d4e5f6a7b";
const CHAT_USER = "c1b2c3d4e5f6a7b";
const MCP_USER = "m1b2c3d4e5f6a7b";

let pg: PgTestDb;
let tmpRoot: string;
let gitServer: TestGitServer;
const WS = generateObjectIdHex();

type Executable = {
  execute: (input: Record<string, unknown>) => Promise<{
    success: boolean;
    app?: string;
    path?: string;
    error?: string;
  }>;
};

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mako-create-author-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
  pg = await setupPgTestDb();
  await initRepo(repoDirFor(WS), seededTemplateFiles());
  await bindTestWorkspaceRepo(WS);
  await Promise.all(
    [UI_USER, CHAT_USER, MCP_USER].map(async id => {
      await ensureTestUser(pg.db, {
        id,
        email: `${id}@example.com`,
        name: `Person ${id.slice(0, 2)}`,
      });
      await ensureTestMember(pg.db, { workspaceId: WS, userId: id });
    }),
  );
}, 120_000);

afterAll(async () => {
  await gitServer?.close();
  await pg?.close();
  await fs.rm(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

/** The scaffold commit on main for an app folder: author, committer, trailer. */
function scaffoldCommit(appPath: string) {
  const out = execFileSync(
    "git",
    [
      "-C",
      repoDirFor(WS),
      "log",
      "refs/heads/main",
      "--diff-filter=A",
      `--format=%ae%x09%ce%x09%(trailers:key=${REQUESTED_BY_TRAILER},valueonly)%x09%s`,
      "--",
      `${appPath}/mako.json`,
    ],
    { encoding: "utf8" },
  ).trim();
  const [author, committer, trailer, subject] = out.split("\t");
  return {
    author,
    committer,
    trailer: (trailer ?? "").trim(),
    subject,
  };
}

async function expectRequestedBy(
  appId: string,
  userId: string,
  emailPrefix = userId,
) {
  const row = await appsMetadataRepo.findProjectById(appId);
  const expectedOwner = await authRepo.resolveUserUuid(userId);
  expect(expectedOwner).toBeTruthy();
  expect(row?.owner_id).toBe(expectedOwner);
  expect(row?.createdBy).toBe(expectedOwner);
  const commit = scaffoldCommit(row?.path ?? "");
  expect(commit).toMatchObject({
    author: `${emailPrefix}@example.com`,
    committer: "bot@mako.ai",
    trailer: userId,
  });
  expect(commit.subject).toMatch(/^Create app "/);
}

describe("app creation names its requester", () => {
  it("UI: POST /apps", async () => {
    identity.userId = UI_USER;
    const app = createRouter();
    app.route("/api/workspaces/:workspaceId/apps", appsRoutes);
    const response = await app.request(`/api/workspaces/${WS}/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "UI Made", folder: "apps" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { app: { id: string } };
    await expectRequestedBy(body.app.id, UI_USER);
  }, 120_000);

  it("in-app chat: app_create_app as the agent builds it", async () => {
    const tools = createAppsTools({
      workspaceId: WS,
      userId: CHAT_USER,
      supportsVision: false,
      touchedPaths: new Set<string>(),
    }) as unknown as { app_create_app: Executable };
    const result = await tools.app_create_app.execute({
      title: "Chat Made",
      description: "Made from in-app chat",
      folder: "apps",
    });
    expect(result.success).toBe(true);
    await expectRequestedBy(result.app ?? "", CHAT_USER);
  }, 180_000);

  it("MCP: app_create_app through the MCP toolset", async () => {
    const userId = legacyUserIdToUuidv7(MCP_USER);
    const tools = buildMakoMcpToolset({
      workspaceId: WS,
      userId,
      memberRole: "member",
      scopes: [...WORKSPACE_API_KEY_SCOPES],
    }) as unknown as { app_create_app: Executable };
    expect(tools.app_create_app).toBeDefined();
    const result = await tools.app_create_app.execute({
      title: "MCP Made",
      description: "Made over MCP",
    });
    expect(result.success).toBe(true);
    // No folder: the requester's personal tree, still theirs.
    expect(result.path).toMatch(/^users\/[^/]+\/apps\/mcp-made$/);
    await expectRequestedBy(result.app ?? "", userId, MCP_USER);
  }, 180_000);

  it("no requester: Mako authors it, no trailer, no owner", async () => {
    const project = await createProject({
      workspaceId: WS,
      title: "Nobody Made",
    });
    const row = await appsMetadataRepo.findProjectById(project._id.toString());
    expect(row?.owner_id ?? undefined).toBeUndefined();
    expect(row?.createdBy).toBe("");
    expect(scaffoldCommit(row?.path ?? "")).toMatchObject({
      author: "bot@mako.ai",
      committer: "bot@mako.ai",
      trailer: "",
    });
  }, 60_000);
});
