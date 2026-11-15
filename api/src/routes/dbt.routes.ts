/**
 * dbt routes — projects, files, jobs, runs, ad-hoc compile/run, lineage.
 *
 * Mounted at `/api/workspaces/:workspaceId/dbt`. Authenticated +
 * workspace-scoped (unifiedAuthMiddleware then the same workspace access
 * check as skills.ts), then the RBAC policy — both registered here, once,
 * ahead of every sub-router in ./dbt/. Business logic lives in api/src/dbt/**.
 */

import { Hono } from "hono";
import { enrichContextWithWorkspace } from "../logging";
import {
  isMcpOAuthAuth,
  unifiedAuthMiddleware,
} from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import type { AuthenticatedContext } from "../middleware/workspace.middleware";
import { resolveDbtAccess } from "../dbt/rbac";
import { dbtCommandRoutes } from "./dbt/commands";
import { dbtFileRoutes } from "./dbt/files";
import { dbtJobRoutes } from "./dbt/jobs";
import { dbtLineageRoutes } from "./dbt/lineage";
import { dbtLocalRunRoutes } from "./dbt/local-runs";
import { dbtProjectRoutes } from "./dbt/projects";
import { dbtRunRoutes } from "./dbt/runs";
import { fail } from "./lib/respond";

export const dbtRoutes = new Hono();

dbtRoutes.use("*", unifiedAuthMiddleware);

// Workspace access check — mirrors skills.ts, and resolves the caller's
// workspace role (memberRole) so the RBAC policy below can gate mutations.
dbtRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    await next();
    return;
  }
  const user = c.get("user");
  const workspace = c.get("workspace");

  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return fail(c, 403, "API key not authorized for this workspace");
    }
    if (isMcpOAuthAuth(c) && user) {
      // An MCP OAuth token acts as ONE person (`mako dbt run`): their live
      // role, not a service credential's — a demoted or departed member's
      // token must not keep building.
      const member = await workspaceService.getMember(workspaceId, user.id);
      if (!member) {
        return fail(c, 403, "Access denied to workspace");
      }
      c.set("memberRole", member.role);
    } else {
      // Workspace-scoped API keys are service credentials with full access.
      c.set("memberRole", "owner");
    }
  } else if (user) {
    const member = await workspaceService.getMember(workspaceId, user.id);
    if (!member) {
      return fail(c, 403, "Access denied to workspace");
    }
    c.set("memberRole", member.role);
  } else {
    return fail(c, 401, "Unauthorized");
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
});

// RBAC policy lives in ../dbt/rbac.ts (pure + unit-tested). Reads (GET) are
// open to any member incl. viewer; viewers are otherwise read-only;
// deployment-config mutations require admin+; other writes are member+.
dbtRoutes.use("*", async (c: AuthenticatedContext, next) => {
  if (!c.req.param("workspaceId")) {
    await next();
    return;
  }
  const decision = resolveDbtAccess({
    method: c.req.method,
    path: c.req.path,
    role: c.get("memberRole"),
  });
  if (!decision.ok) {
    return fail(c, decision.status ?? 403, decision.error as string);
  }
  await next();
});

dbtRoutes.route("/", dbtProjectRoutes);
dbtRoutes.route("/", dbtFileRoutes);
dbtRoutes.route("/", dbtJobRoutes);
dbtRoutes.route("/", dbtRunRoutes);
dbtRoutes.route("/", dbtLocalRunRoutes);
dbtRoutes.route("/", dbtCommandRoutes);
dbtRoutes.route("/", dbtLineageRoutes);
