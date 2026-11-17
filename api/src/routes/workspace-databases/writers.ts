/**
 * Who may write through a connection (its writers list).
 */
import {
  covers,
  principalsOutsideWorkspace,
} from "../../access/connection-writes";
import {
  LISTABLE_PRINCIPAL,
  nextWriters,
  publicWriters,
  recentWriters,
  WRITERS_IN_APP_ONLY,
  writersEditor,
} from "../../access/connection-writers-list";
import {
  listChange,
  recordAccessChange,
  writerLabel,
} from "../../access/connection-access-event";
import { createRoute, z } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../../auth/unified-auth.middleware";
import {
  requireWorkspace,
  requireWorkspaceRole,
} from "../../middleware/workspace.middleware";
import { DatabaseConnection } from "../../database/workspace-schema";
import { Types } from "mongoose";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";

import { logger } from "./shared";

export const connectionWriterRoutes = createRouter();

// Who may write through a connection (access/connection-writes.ts). Anyone
// in the workspace may look; the owner and admins change it, in the app.
const writersParams = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

const WriterSchema = z.object({
  principal: z
    .string()
    .regex(LISTABLE_PRINCIPAL)
    .openapi({ example: "workflow:crm-chat-issues" }),
  where: z
    .string()
    .regex(/^[^.\s]+(\.[^.\s]+)?$/)
    .optional()
    .openapi({ example: "mako_out.issue_labels" }),
});

connectionWriterRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/writers",
    tags: ["Databases"],
    summary: "Who may write through this connection",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware, requireWorkspace] as const,
    request: { params: writersParams },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    const databaseId = c.req.param("id");
    if (!Types.ObjectId.isValid(databaseId)) {
      return c.json({ success: false, error: "Invalid database ID" }, 400);
    }
    const database = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(databaseId),
      workspaceId: workspace._id,
    })
      .select("writers")
      .lean();
    if (!database) {
      return c.json({ success: false, error: "Database not found" }, 404);
    }
    const memberRole = c.get("memberRole");
    return c.json({
      success: true,
      data: {
        writers: publicWriters(database.writers),
        canEdit: memberRole === "owner" || memberRole === "admin",
        recent: await recentWriters(databaseId, (principal, target) =>
          covers(database.writers, principal, target),
        ),
      },
    });
  },
);

connectionWriterRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}/writers",
    tags: ["Databases"],
    summary: "Change who may write through this connection",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: {
      params: writersParams,
      body: {
        content: {
          "application/json": {
            schema: z.object({ writers: z.array(WriterSchema).max(200) }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const workspace = c.get("workspace");
    const databaseId = c.req.param("id");
    const userId = writersEditor(c.get("authType"), c.get("user"));
    if (!userId) {
      return c.json({ success: false, error: WRITERS_IN_APP_ONLY }, 403);
    }
    if (!Types.ObjectId.isValid(databaseId)) {
      return c.json({ success: false, error: "Invalid database ID" }, 400);
    }
    const database = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(databaseId),
      workspaceId: workspace._id,
    });
    if (!database) {
      return c.json({ success: false, error: "Database not found" }, 404);
    }
    const { writers } = c.req.valid("json");
    // As before source connections shared this list: only strangers are
    // refused here. A viewer may be listed on a database connection; its
    // write check (access/connection-writes.ts) does not look at roles.
    const strangers = await principalsOutsideWorkspace(
      String(workspace._id),
      writers.map(w => w.principal),
    );
    if (strangers.length > 0) {
      return c.json(
        {
          success: false,
          error: `${strangers.join(", ")} is not a member of this workspace`,
        },
        400,
      );
    }
    const before = (database.writers ?? []).map(writerLabel);
    database.writers = nextWriters(database.writers, writers, userId);
    await database.save();
    await recordAccessChange({
      workspaceId: workspace._id,
      connectionId: databaseId,
      kind: "database",
      actor: userId,
      via: "app",
      changes: {
        writers: listChange(before, database.writers.map(writerLabel)),
      },
    });
    logger.info("Connection writers changed", {
      workspaceId: String(workspace._id),
      databaseId,
      userId,
      writers: database.writers.length,
    });
    return c.json({ success: true });
  },
);
