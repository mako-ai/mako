/**
 * POST /demo: the onboarding demo database.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import {
  requireWorkspace,
  requireWorkspaceRole,
} from "../../middleware/workspace.middleware";
import { DatabaseConnection } from "../../database/workspace-schema";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";

import { logger, getDemoDatabaseConfig } from "./shared";

export const demoDatabaseRoutes = createRouter();

// Create demo database for workspace (onboarding)
demoDatabaseRoutes.openapi(
  createRoute({
    method: "post",
    path: "/demo",
    tags: ["Databases"],
    summary: "POST /demo",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin", "member"]),
    ] as const,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const user = c.get("user");
      if (!user) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const workspace = c.get("workspace");

      // Check if workspace already has a demo database
      const existingDemo = await DatabaseConnection.findOne({
        workspaceId: workspace._id,
        isDemo: true,
      });

      if (existingDemo) {
        return c.json({
          success: true,
          data: {
            id: existingDemo._id,
            name: existingDemo.name,
            type: existingDemo.type,
            isDemo: true,
          },
          message: "Demo database already exists",
        });
      }

      // Create demo database connection
      const demoConfig = getDemoDatabaseConfig();
      const database = new DatabaseConnection({
        workspaceId: workspace._id,
        name: demoConfig.name,
        type: demoConfig.type,
        connection: demoConfig.connection,
        isDemo: true,
        createdBy: user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await database.save();

      return c.json(
        {
          success: true,
          data: {
            id: database._id,
            name: database.name,
            type: database.type,
            isDemo: true,
            createdAt: database.createdAt,
          },
          message: "Demo database created successfully",
        },
        201,
      );
    } catch (error) {
      logger.error("Error creating demo database", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to create demo database",
        },
        500,
      );
    }
  },
);

// Get all databases for workspace
