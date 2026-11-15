/**
 * `/api/workspaces/:workspaceId/flows` — authenticated + workspace-scoped.
 *
 * This module owns the router and its auth chain; the endpoints live in
 * `./flows/*` by concern and register onto it in a fixed order.
 */
import { Types } from "mongoose";
import { enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import type { AuthenticatedContext } from "../middleware/workspace.middleware";
import { createRouter } from "../openapi/core";
import { fail } from "./lib/respond";
import { registerCdcBackfillRoutes } from "./flows/cdc-backfill";
import { registerCdcStatusRoutes } from "./flows/cdc-status";
import { registerCdcStreamRoutes } from "./flows/cdc-stream";
import { registerCrudRoutes } from "./flows/crud";
import { registerFlowGitHistoryRoutes } from "./flows/git-history";
import { registerRunsRoutes } from "./flows/runs";
import { registerSettingsRoutes } from "./flows/settings";
import { registerValidationRoutes } from "./flows/validation";
import { registerWebhooksRoutes } from "./flows/webhooks";

export const flowRoutes = createRouter();

// Apply unified auth middleware to all flow routes
flowRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
flowRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    // Validate ObjectId format early to return 400 instead of 500
    if (!Types.ObjectId.isValid(workspaceId)) {
      return fail(c, 400, "Invalid workspace ID format");
    }

    const user = c.get("user");
    const workspace = c.get("workspace");

    if (workspace) {
      // For API key auth, verify the URL workspace matches the API key's workspace
      if (workspace._id.toString() !== workspaceId) {
        return fail(c, 403, "API key not authorized for this workspace");
      }
    } else if (user) {
      // For session auth, verify user has access to this workspace
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return fail(c, 403, "Access denied to workspace");
      }
    } else {
      // Neither API key nor session auth succeeded - reject request
      return fail(c, 401, "Unauthorized");
    }

    // Only enrich logging context after authorization succeeds
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

registerCrudRoutes(flowRoutes);
registerSettingsRoutes(flowRoutes);
registerRunsRoutes(flowRoutes);
registerCdcBackfillRoutes(flowRoutes);
registerCdcStreamRoutes(flowRoutes);
registerWebhooksRoutes(flowRoutes);
registerCdcStatusRoutes(flowRoutes);
registerValidationRoutes(flowRoutes);
registerFlowGitHistoryRoutes(flowRoutes);
