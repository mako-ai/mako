import { Hono } from "hono";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { DatabaseConnection } from "../database/workspace-schema";
import type { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import { DatabaseManager } from "../utils/database-manager";
import { enrichContextWithWorkspace } from "../logging";

export const databaseRoutes = new Hono();
const databaseManager = new DatabaseManager();

// Legacy database-management endpoints require auth and database ownership.
databaseRoutes.use("*", unifiedAuthMiddleware);

async function requireDatabaseAccess(
  c: AuthenticatedContext,
  databaseId: string,
) {
  if (!Types.ObjectId.isValid(databaseId)) {
    return c.json({ success: false, error: "Invalid database ID format" }, 400);
  }

  const database = await DatabaseConnection.findById(databaseId)
    .select("workspaceId")
    .lean();

  if (!database) {
    return c.json({ success: false, error: "Database not found" }, 404);
  }

  const databaseWorkspaceId = database.workspaceId.toString();
  const authenticatedWorkspace = c.get("workspace");
  const user = c.get("user");

  if (authenticatedWorkspace) {
    if (authenticatedWorkspace._id.toString() !== databaseWorkspaceId) {
      return c.json(
        {
          success: false,
          error: "API key not authorized for this database",
        },
        403,
      );
    }
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(
      databaseWorkspaceId,
      user.id,
    );
    if (!hasAccess) {
      return c.json(
        { success: false, error: "Access denied to database" },
        403,
      );
    }
  } else {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  c.set("workspaceId", databaseWorkspaceId);
  enrichContextWithWorkspace(databaseWorkspaceId);
  return null;
}

// GET /api/database/collections - List all collections
databaseRoutes.get("/collections", async (c: AuthenticatedContext) => {
  try {
    const databaseId = c.req.query("databaseId");
    if (!databaseId) {
      return c.json({ success: false, error: "Database ID is required" }, 400);
    }

    const accessDenied = await requireDatabaseAccess(c, databaseId);
    if (accessDenied) return accessDenied;

    const collections = await databaseManager.listCollections(databaseId);
    return c.json({ success: true, data: collections });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/database/views - List all views
databaseRoutes.get("/views", async (c: AuthenticatedContext) => {
  try {
    const databaseId = c.req.query("databaseId");
    if (!databaseId) {
      return c.json({ success: false, error: "Database ID is required" }, 400);
    }

    const accessDenied = await requireDatabaseAccess(c, databaseId);
    if (accessDenied) return accessDenied;

    const views = await databaseManager.listViews(databaseId);
    return c.json({ success: true, data: views });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/database/collections - Create a new collection
databaseRoutes.post("/collections", async (c: AuthenticatedContext) => {
  try {
    const body = await c.req.json();

    if (!body.databaseId) {
      return c.json({ success: false, error: "Database ID is required" }, 400);
    }

    const accessDenied = await requireDatabaseAccess(c, body.databaseId);
    if (accessDenied) return accessDenied;

    if (!body.name) {
      return c.json(
        { success: false, error: "Collection name is required" },
        400,
      );
    }

    const result = await databaseManager.createCollection(
      body.databaseId,
      body.name,
      body.options,
    );
    return c.json({
      success: true,
      message: "Collection created successfully",
      data: result,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/database/views - Create a new view
databaseRoutes.post("/views", async (c: AuthenticatedContext) => {
  try {
    const body = await c.req.json();

    if (!body.databaseId) {
      return c.json({ success: false, error: "Database ID is required" }, 400);
    }

    const accessDenied = await requireDatabaseAccess(c, body.databaseId);
    if (accessDenied) return accessDenied;

    if (!body.name || !body.viewOn || !body.pipeline) {
      return c.json(
        {
          success: false,
          error:
            "View name, viewOn (source collection), and pipeline are required",
        },
        400,
      );
    }

    const result = await databaseManager.createView(
      body.databaseId,
      body.name,
      body.viewOn,
      body.pipeline,
      body.options,
    );
    return c.json({
      success: true,
      message: "View created successfully",
      data: result,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// DELETE /api/database/collections/:name - Delete a collection
databaseRoutes.delete("/collections/:name", async (c: AuthenticatedContext) => {
  try {
    const collectionName = c.req.param("name");
    const databaseId = c.req.query("databaseId");

    if (!databaseId) {
      return c.json({ success: false, error: "Database ID is required" }, 400);
    }

    const accessDenied = await requireDatabaseAccess(c, databaseId);
    if (accessDenied) return accessDenied;

    const result = await databaseManager.deleteCollection(
      databaseId,
      collectionName,
    );
    return c.json({
      success: true,
      message: "Collection deleted successfully",
      data: result,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// DELETE /api/database/views/:name - Delete a view
databaseRoutes.delete("/views/:name", async (c: AuthenticatedContext) => {
  try {
    const viewName = c.req.param("name");
    const databaseId = c.req.query("databaseId");

    if (!databaseId) {
      return c.json({ success: false, error: "Database ID is required" }, 400);
    }

    const accessDenied = await requireDatabaseAccess(c, databaseId);
    if (accessDenied) return accessDenied;

    const result = await databaseManager.deleteView(databaseId, viewName);
    return c.json({
      success: true,
      message: "View deleted successfully",
      data: result,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/database/collections/:name/info - Get collection information
databaseRoutes.get(
  "/collections/:name/info",
  async (c: AuthenticatedContext) => {
    try {
      const collectionName = c.req.param("name");
      const databaseId = c.req.query("databaseId");

      if (!databaseId) {
        return c.json(
          { success: false, error: "Database ID is required" },
          400,
        );
      }

      const accessDenied = await requireDatabaseAccess(c, databaseId);
      if (accessDenied) return accessDenied;

      const info = await databaseManager.getCollectionInfo(
        databaseId,
        collectionName,
      );
      return c.json({
        success: true,
        data: info,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// GET /api/database/views/:name/info - Get view information
databaseRoutes.get("/views/:name/info", async (c: AuthenticatedContext) => {
  try {
    const viewName = c.req.param("name");
    const databaseId = c.req.query("databaseId");

    if (!databaseId) {
      return c.json({ success: false, error: "Database ID is required" }, 400);
    }

    const accessDenied = await requireDatabaseAccess(c, databaseId);
    if (accessDenied) return accessDenied;

    const info = await databaseManager.getViewInfo(databaseId, viewName);
    return c.json({
      success: true,
      data: info,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});
