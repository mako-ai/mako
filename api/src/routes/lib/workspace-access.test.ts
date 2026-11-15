import assert from "node:assert/strict";
import { Hono } from "hono";

import { workspaceService } from "../../services/workspace.service";
import type { AuthEnv } from "../../openapi/core";
import {
  requireWorkspaceAccess,
  workspaceAccessDenial,
} from "./workspace-access";

const WS = "507f1f77bcf86cd799439011";
const OTHER = "507f1f77bcf86cd799439012";

// Members of WS only.
(workspaceService as { hasAccess: unknown }).hasAccess = async (
  workspaceId: string,
) => workspaceId === WS;

async function main(): Promise<void> {
  const key = { _id: { toString: () => WS } };

  assert.equal(await workspaceAccessDenial({ workspace: key }, WS), null);
  assert.deepEqual(await workspaceAccessDenial({ workspace: key }, OTHER), {
    status: 403,
    error: "API key not authorized for this workspace",
  });
  assert.equal(await workspaceAccessDenial({ user: { id: "u" } }, WS), null);
  assert.deepEqual(
    await workspaceAccessDenial({ user: { id: "u" } }, OTHER, "Access denied"),
    { status: 403, error: "Access denied" },
  );
  assert.deepEqual(await workspaceAccessDenial({}, WS), {
    status: 401,
    error: "Unauthorized",
  });

  const app = (options: Parameters<typeof requireWorkspaceAccess>[0]) => {
    const a = new Hono<AuthEnv>();
    a.use("*", async (c, next) => {
      c.set("user", { id: "u" } as never);
      await next();
    });
    a.use("/w/:workspaceId/*", requireWorkspaceAccess(options));
    a.use("/plain/*", requireWorkspaceAccess(options));
    a.get("/w/:workspaceId/x", c => c.json({ ok: true }));
    a.get("/plain/x", c => c.json({ ok: true }));
    return a;
  };

  const skip = app({});
  assert.equal((await skip.request(`/w/${WS}/x`)).status, 200);
  const denied = await skip.request(`/w/${OTHER}/x`);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    success: false,
    error: "Access denied to workspace",
  });
  assert.equal((await skip.request("/plain/x")).status, 200);

  const strict = app({ whenMissing: "reject", validateId: true });
  assert.equal((await strict.request("/plain/x")).status, 400);
  const bad = await strict.request("/w/not-an-id/x");
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), {
    success: false,
    error: "Invalid workspace ID format",
  });

  console.info("workspace-access tests passed");
}

main().catch((error: unknown) => {
  throw error;
});
