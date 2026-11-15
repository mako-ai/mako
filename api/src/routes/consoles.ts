/**
 * /api/workspaces/:workspaceId/consoles — authenticated + workspace-scoped.
 *
 * This module is the mount point: auth, the workspace-access middleware
 * (which sets `memberRole`, an API key's owner's role included) and the
 * admin gate on schedules, then the sub-routers in `./consoles/`, each one
 * concern. Handlers parse and answer; the work is in `services/consoles/`.
 *
 * Mount order is part of the contract: Hono matches in registration order,
 * so the sharing routes' PUTs must stay ahead of the catch-all
 * `PUT /:path{.+}` (write.ts), and `DELETE /{id}/schedule` ahead of the
 * folder registrar's `DELETE /folders/{id}`.
 */
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { requireWorkspaceAdmin } from "../middleware/workspace-admin.middleware";
import { createRouter } from "../openapi/core";
import { consoleWorkspaceAccess } from "./consoles/middleware";
import { consoleSharingRoutes } from "./consoles/sharing";
import { consoleReadRoutes } from "./consoles/read";
import { consoleScheduleRoutes } from "./consoles/schedule";
import { consoleWriteRoutes } from "./consoles/write";
import { consoleExecuteRoutes } from "./consoles/execute";
import { consoleHistoryRoutes } from "./consoles/history";
import { consoleFolderRoutes } from "./consoles/folders";

export const consoleRoutes = createRouter();

consoleRoutes.use("*", unifiedAuthMiddleware);
consoleRoutes.use("*", consoleWorkspaceAccess);
consoleRoutes.use("/:id/schedule", requireWorkspaceAdmin);
consoleRoutes.use("/:id/schedule/*", requireWorkspaceAdmin);

consoleRoutes.route("/", consoleSharingRoutes);
consoleRoutes.route("/", consoleReadRoutes);
consoleRoutes.route("/", consoleScheduleRoutes);
consoleRoutes.route("/", consoleWriteRoutes);
consoleRoutes.route("/", consoleExecuteRoutes);
consoleRoutes.route("/", consoleHistoryRoutes);
consoleRoutes.route("/", consoleFolderRoutes);
