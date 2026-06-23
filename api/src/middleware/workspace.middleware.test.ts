/* eslint-disable no-console, no-process-exit */
/**
 * Self-running tests for workspace-scoped route middleware.
 * Run with: tsx src/middleware/workspace.middleware.test.ts
 */
import assert from "node:assert/strict";
import { Hono } from "hono";

import {
  createWorkspaceRouteMiddleware,
  type AuthenticatedContext,
} from "./workspace.middleware";
import { workspaceService } from "../services/workspace.service";

const WORKSPACE_ID = "64b000000000000000000001";
const OTHER_WORKSPACE_ID = "64b000000000000000000002";

type WorkspaceServicePatch = {
  getMember: typeof workspaceService.getMember;
  hasAccess: typeof workspaceService.hasAccess;
};

const workspaceServicePatch = workspaceService as unknown as WorkspaceServicePatch;
const originalGetMember = workspaceServicePatch.getMember;
const originalHasAccess = workspaceServicePatch.hasAccess;

function restoreWorkspaceService() {
  workspaceServicePatch.getMember = originalGetMember;
  workspaceServicePatch.hasAccess = originalHasAccess;
}

function buildApp(
  auth:
    | { type: "session"; userId: string }
    | { type: "apiKey"; workspaceId: string },
  options?: Parameters<typeof createWorkspaceRouteMiddleware>[0],
) {
  const app = new Hono();
  app.use("*", async (c: AuthenticatedContext, next) => {
    if (auth.type === "session") {
      c.set("user", { id: auth.userId, email: `${auth.userId}@example.com` });
      c.set("authType", "session");
    } else {
      c.set("workspace", { _id: { toString: () => auth.workspaceId } });
      c.set("authType", "apiKey");
    }
    await next();
  });
  app.use(
    "/api/workspaces/:workspaceId/test",
    createWorkspaceRouteMiddleware(options),
  );
  app.get("/api/workspaces/:workspaceId/test", c =>
    c.json({
      success: true,
      memberRole: c.get("memberRole"),
    }),
  );
  return app;
}

async function testInvalidWorkspaceIdReturnsEnvelope() {
  const app = buildApp({ type: "session", userId: "u1" });
  const res = await app.request("/api/workspaces/not-an-object-id/test");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    success: false,
    error: "Invalid workspace ID format",
  });
}

async function testSessionMemberRoleIsResolved() {
  workspaceServicePatch.getMember = async (workspaceId, userId) => ({
    workspaceId,
    userId,
    role: "member",
  });

  const app = buildApp({ type: "session", userId: "u1" });
  const res = await app.request(`/api/workspaces/${WORKSPACE_ID}/test`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: true,
    memberRole: "member",
  });
}

async function testAccessOnlyModeSkipsRoleResolution() {
  let getMemberCalled = false;
  workspaceServicePatch.getMember = async () => {
    getMemberCalled = true;
    return null;
  };
  workspaceServicePatch.hasAccess = async () => true;

  const app = buildApp(
    { type: "session", userId: "u1" },
    { resolveSessionRole: false },
  );
  const res = await app.request(`/api/workspaces/${WORKSPACE_ID}/test`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: true,
  });
  assert.equal(getMemberCalled, false);
}

async function testApiKeyWorkspaceAndRoleAreResolved() {
  const app = buildApp(
    { type: "apiKey", workspaceId: WORKSPACE_ID },
    { apiKeyRole: "owner" },
  );
  const res = await app.request(`/api/workspaces/${WORKSPACE_ID}/test`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: true,
    memberRole: "owner",
  });
}

async function testApiKeyWorkspaceMismatchIsRejected() {
  const app = buildApp(
    { type: "apiKey", workspaceId: OTHER_WORKSPACE_ID },
    { apiKeyRole: "owner" },
  );
  const res = await app.request(`/api/workspaces/${WORKSPACE_ID}/test`);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), {
    success: false,
    error: "API key not authorized for this workspace",
  });
}

async function main() {
  try {
    await testInvalidWorkspaceIdReturnsEnvelope();
    await testSessionMemberRoleIsResolved();
    await testAccessOnlyModeSkipsRoleResolution();
    await testApiKeyWorkspaceAndRoleAreResolved();
    await testApiKeyWorkspaceMismatchIsRejected();
  } finally {
    restoreWorkspaceService();
  }
  console.log("workspace.middleware.test.ts: all assertions passed");
}

main().catch(error => {
  restoreWorkspaceService();
  console.error(error);
  process.exit(1);
});
