import { Hono } from "hono";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { SavedConsole } from "../database/workspace-schema";
import { loggers } from "../logging";
import { requireWorkspaceAdmin } from "../middleware/workspace-admin.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";

const logger = loggers.api("scheduled-queries");

export const scheduledQueryRoutes = new Hono();

scheduledQueryRoutes.use("*", unifiedAuthMiddleware);

scheduledQueryRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");

  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return c.json(
      { success: false, error: "Invalid workspace ID format" },
      400,
    );
  }

  if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
    return c.json({ success: false, error: "Access denied to workspace" }, 403);
  }

  await next();
});

scheduledQueryRoutes.use("*", requireWorkspaceAdmin);

scheduledQueryRoutes.get("/", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");

    const consoles = await SavedConsole.find({
      workspaceId: new Types.ObjectId(workspaceId),
      isSaved: true,
      "schedule.cron": { $exists: true, $ne: "" },
      $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
    })
      .select(
        "_id name schedule scheduledRun connectionId databaseName databaseId access owner_id createdBy updatedAt",
      )
      .sort({ name: 1 })
      .lean();

    return c.json({
      success: true,
      scheduledQueries: consoles.map(consoleDoc => ({
        id: consoleDoc._id.toString(),
        name: consoleDoc.name,
        connectionId: consoleDoc.connectionId?.toString(),
        databaseId: consoleDoc.databaseId,
        databaseName: consoleDoc.databaseName,
        schedule: consoleDoc.schedule,
        scheduledRun: consoleDoc.scheduledRun,
        access: consoleDoc.access,
        owner_id: consoleDoc.owner_id || consoleDoc.createdBy,
        updatedAt: consoleDoc.updatedAt,
      })),
    });
  } catch (error) {
    logger.error("Failed to list scheduled queries", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to list scheduled queries",
      },
      500,
    );
  }
});
