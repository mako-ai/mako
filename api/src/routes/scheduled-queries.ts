import { createRoute, z } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { consolesChartsRepo } from "../repositories/consoles-charts";
import { loggers } from "../logging";
import { requireWorkspaceAdmin } from "../middleware/workspace-admin.middleware";
import { consoleWorkspaceAccess } from "./consoles/middleware";
import {
  AUTH_SECURITY,
  createRouter,
  errorJson,
  jsonContent,
} from "../openapi/core";

const logger = loggers.api("scheduled-queries");

export const scheduledQueryRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});

scheduledQueryRoutes.use("*", unifiedAuthMiddleware);

// The consoles router's workspace check: a member, or an API key minted for
// THIS workspace (acting with its owner's role).
scheduledQueryRoutes.use("*", consoleWorkspaceAccess);
scheduledQueryRoutes.use("*", requireWorkspaceAdmin);

scheduledQueryRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Scheduled Queries"],
    summary: "List scheduled queries",
    description:
      "Lists saved consoles in the workspace that have a cron schedule configured. Requires workspace admin.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: {
      200: jsonContent(
        z.object({
          success: z.literal(true),
          scheduledQueries: z.array(z.record(z.string(), z.any())),
        }),
        "Scheduled queries.",
      ),
      500: errorJson("Failed to list scheduled queries"),
    },
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");

      const consoles = await consolesChartsRepo.listConsolesByWorkspace(
        workspaceId,
        {
          isSaved: true,
          hasSchedule: true,
          excludeDeleted: true,
          sortBy: "nameAsc",
        },
      );

      return c.json(
        {
          success: true as const,
          scheduledQueries: consoles.map(consoleDoc => ({
            id: consoleDoc.id,
            name: consoleDoc.name,
            connectionId: consoleDoc.connectionId,
            databaseId: consoleDoc.databaseId,
            databaseName: consoleDoc.databaseName,
            schedule: consoleDoc.schedule,
            scheduledRun: consoleDoc.scheduledRun,
            access: consoleDoc.access,
            owner_id: consoleDoc.owner_id || consoleDoc.createdBy,
            updatedAt: consoleDoc.updatedAt,
          })),
        },
        200,
      );
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
  },
);
