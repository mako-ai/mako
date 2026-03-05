import { Hono, Context } from "hono";
import { ConsoleManager } from "../utils/console-manager";
import {
  unifiedAuthMiddleware,
  isApiKeyAuth,
} from "../auth/unified-auth.middleware";
import {
  DatabaseConnection,
  SavedConsole,
  IDatabaseConnection,
  ConsoleAccessLevel,
} from "../database/workspace-schema";
import { workspaceService } from "../services/workspace.service";
import { databaseConnectionService } from "../services/database-connection.service";
import {
  queryExecutionService,
  QueryLanguage,
  QueryStatus,
} from "../services/query-execution.service";
import { Types } from "mongoose";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { AuthenticatedContext } from "../middleware/workspace.middleware";

/**
 * Map console language to query language for tracking
 */
function mapConsoleLanguageToQueryLanguage(
  language: "sql" | "javascript" | "mongodb",
): QueryLanguage {
  if (language === "mongodb") return "mongodb";
  if (language === "javascript") return "javascript";
  return "sql";
}

const logger = loggers.api("consoles");

export const consoleRoutes = new Hono();
const consoleManager = new ConsoleManager();

// Apply unified auth middleware to all console routes
consoleRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
consoleRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    // Validate ObjectId format early to return 400 instead of 500
    if (!Types.ObjectId.isValid(workspaceId)) {
      return c.json(
        { success: false, error: "Invalid workspace ID format" },
        400,
      );
    }

    const user = c.get("user");
    const workspace = c.get("workspace");

    if (workspace) {
      // For API key auth, verify the URL workspace matches the API key's workspace
      if (workspace._id.toString() !== workspaceId) {
        return c.json(
          {
            success: false,
            error: "API key not authorized for this workspace",
          },
          403,
        );
      }
    } else if (user) {
      // For session auth, verify user has access to this workspace
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
    } else {
      // Neither API key nor session auth succeeded - reject request
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    // Only enrich logging context after authorization succeeds
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

// Helper function to verify workspace access
async function verifyWorkspaceAccess(
  c: Context,
): Promise<{ hasAccess: boolean; workspaceId: string } | null> {
  const workspaceId = c.req.param("workspaceId");

  if (isApiKeyAuth(c)) {
    // For API key auth, workspace is already verified and set in context
    const workspace = c.get("workspace");
    if (workspace && workspace._id.toString() === workspaceId) {
      return { hasAccess: true, workspaceId };
    }
    return null;
  }

  // For session auth, check user access
  const user = c.get("user");
  if (user && (await workspaceService.hasAccess(workspaceId, user.id))) {
    return { hasAccess: true, workspaceId };
  }

  return null;
}

// GET /api/workspaces/:workspaceId/consoles - List all consoles (tree structure) for workspace
// When a user is authenticated the response includes myConsoles / sharedConsoles split.
consoleRoutes.get("/", async (c: Context) => {
  try {
    const access = await verifyWorkspaceAccess(c);
    if (!access) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    const user = c.get("user");
    const userId: string | undefined = user?.id;

    const tree = await consoleManager.listConsoles(access.workspaceId, userId);

    // Also provide the split view for the frontend
    if (userId) {
      const { myConsoles, sharedConsoles } =
        await consoleManager.listConsolesSplit(
          access.workspaceId,
          userId,
          tree,
        );
      return c.json({ success: true, tree, myConsoles, sharedConsoles });
    }

    return c.json({ success: true, tree });
  } catch (error) {
    logger.error("Error listing consoles", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/consoles/content - Get specific console content
consoleRoutes.get("/content", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.query("id");
    const user = c.get("user");

    // Verify user has access to workspace
    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (!consoleId) {
      return c.json(
        { success: false, error: "ID query parameter is required" },
        400,
      );
    }

    const consoleData = await consoleManager.getConsoleWithMetadata(
      consoleId,
      workspaceId,
    );

    if (!consoleData) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    // Deny access to private consoles not owned by the current user
    const consoleAccess = consoleData.access || "private";
    const ownerId = consoleData.owner_id;
    if (consoleAccess === "private" && ownerId !== user.id) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    // Determine if the current user can write
    const currentUserId = user?.id;
    let readOnly = false;
    if (currentUserId && ownerId) {
      if (consoleAccess === "shared_read" && currentUserId !== ownerId) {
        readOnly = true;
      }
    }

    return c.json({
      success: true,
      content: consoleData.content,
      connectionId: consoleData.connectionId,
      databaseName: consoleData.databaseName,
      databaseId: consoleData.databaseId,
      language: consoleData.language,
      id: consoleData.id,
      name: consoleData.name,
      path: consoleData.path,
      isSaved: consoleData.isSaved,
      access: consoleAccess,
      owner_id: ownerId,
      readOnly,
    });
  } catch (error) {
    logger.error("Error fetching console content", {
      consoleId: c.req.query("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Console not found",
      },
      404,
    );
  }
});

// POST /api/workspaces/:workspaceId/consoles - Create new console
consoleRoutes.post("/", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const body = await c.req.json();
    const {
      id, // Optional client-provided ID
      path: consolePath,
      content,
      connectionId,
      databaseId, // Backward compatibility
      databaseName,
      folderId,
      description,
      language,
      isPrivate,
      access: _requestedAccess, // New: access level (used at share endpoint, not here)
    } = body;
    void _requestedAccess;
    const user = c.get("user");

    // Verify user has access to workspace
    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (!consolePath || typeof consolePath !== "string") {
      return c.json(
        { success: false, error: "Path is required and must be a string" },
        400,
      );
    }
    if (typeof content !== "string") {
      return c.json({ success: false, error: "Content must be a string" }, 400);
    }

    // connectionId is optional - consoles can be saved without being associated with a specific database
    let targetConnectionId = connectionId;
    if (!targetConnectionId) {
      // Try to get the first database for the workspace, but don't require it
      const databases = await DatabaseConnection.find({ workspaceId }).limit(1);
      if (databases.length > 0) {
        targetConnectionId = databases[0]._id.toString();
      }
      // If no databases exist, that's fine - targetConnectionId will remain undefined
    }

    // Check if a console already exists at this path (with a different ID)
    const existingConsole = await consoleManager.getConsoleByPath(
      consolePath,
      workspaceId,
    );

    // If console exists and has a different ID, check for conflict
    // Skip conflict if existing console only has placeholder content (loading...)
    const hasRealContent =
      existingConsole?.code &&
      existingConsole.code.trim() !== "" &&
      existingConsole.code !== "loading...";

    // Determine which ID to use for saving
    let consoleIdToUse = id;

    if (existingConsole && existingConsole._id.toString() !== id) {
      if (hasRealContent) {
        // Real conflict - return conflict response for user to resolve
        return c.json(
          {
            success: false,
            error: "conflict",
            conflict: {
              existingId: existingConsole._id.toString(),
              existingContent: existingConsole.code,
              existingName: existingConsole.name,
              existingLanguage: existingConsole.language,
              path: consolePath,
            },
          },
          409,
        );
      } else {
        // Existing console has placeholder content - overwrite it by using its ID
        // This prevents creating a duplicate at the same path
        // IMPORTANT: The client uses the returned `id` in the response to update its
        // local state, so we must return savedConsole._id (not the original client ID)
        consoleIdToUse = existingConsole._id.toString();
      }
    }

    const savedConsole = await consoleManager.saveConsole(
      consolePath,
      content,
      workspaceId,
      user.id,
      targetConnectionId,
      databaseName,
      databaseId,
      {
        id: consoleIdToUse, // Use existing console ID if overwriting placeholder, otherwise client ID
        folderId,
        description,
        language,
        isPrivate,
      },
    );

    return c.json(
      {
        success: true,
        message: "Console created successfully",
        data: {
          id: savedConsole._id.toString(),
          path: consolePath,
          content,
          connectionId: targetConnectionId,
          databaseName,
          databaseId,
          language: savedConsole.language,
        },
      },
      201,
    );
  } catch (error) {
    logger.error("Error creating console", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error creating console",
      },
      500,
    );
  }
});

// PUT /api/workspaces/:workspaceId/consoles/:pathOrId - Update/upsert console
// If pathOrId is a valid ObjectId, upserts by ID (used for auto-save)
// Otherwise, saves by path (used for explicit user save to folder)
consoleRoutes.put("/:path{.+}", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const pathOrId = c.req.param("path");
    const body = await c.req.json();
    const user = c.get("user");

    // Verify user has access to workspace
    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (typeof body.content !== "string") {
      return c.json(
        { success: false, error: "Content is required and must be a string" },
        400,
      );
    }

    // Check if pathOrId is a valid ObjectId - if so, do ID-based update
    if (Types.ObjectId.isValid(pathOrId) && pathOrId.length === 24) {
      // Check write access on existing console
      const existingById = await SavedConsole.findOne({
        _id: new Types.ObjectId(pathOrId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (existingById && !ConsoleManager.canWrite(existingById, user.id)) {
        return c.json(
          {
            success: false,
            error:
              "This console is shared as read-only. Create a copy to make changes.",
          },
          403,
        );
      }

      const now = new Date();
      const isExplicitSave = body.isSaved === true;

      // If this is an explicit save with a path, check for path conflicts
      if (isExplicitSave && body.path) {
        const consolePath = body.path;
        const existingConsole = await consoleManager.getConsoleByPath(
          consolePath,
          workspaceId,
        );

        // If a different console exists at this path, return conflict
        if (existingConsole && existingConsole._id.toString() !== pathOrId) {
          return c.json(
            {
              success: false,
              error: "conflict",
              conflict: {
                existingId: existingConsole._id.toString(),
                existingContent: existingConsole.code,
                existingName: existingConsole.name,
                existingLanguage: existingConsole.language,
                path: consolePath,
              },
            },
            409,
          );
        }

        // Parse path to get folder and name
        const parts = consolePath.split("/");
        const consoleName = parts[parts.length - 1];
        let folderId: string | undefined;
        if (parts.length > 1) {
          const folderPath = parts.slice(0, -1);
          folderId = await consoleManager.findOrCreateFolderPath(
            folderPath,
            workspaceId,
            user.id,
          );
        }

        // Update with path information (use upsert in case console hasn't been auto-saved yet)
        const setFields: Record<string, any> = {
          code: body.content,
          name: consoleName,
          folderId: folderId ? new Types.ObjectId(folderId) : undefined,
          connectionId: body.connectionId
            ? new Types.ObjectId(body.connectionId)
            : undefined,
          databaseName: body.databaseName,
          databaseId: body.databaseId,
          isSaved: true,
          updatedAt: now,
        };

        const result = await SavedConsole.findOneAndUpdate(
          {
            _id: new Types.ObjectId(pathOrId),
            workspaceId: new Types.ObjectId(workspaceId),
          },
          {
            $set: setFields,
            $setOnInsert: {
              createdBy: user.id,
              language: "sql" as const,
              isPrivate: false,
              executionCount: 0,
              createdAt: now,
            },
          },
          { upsert: true, new: true },
        );

        return c.json({
          success: true,
          message: "Console saved",
          console: {
            id: result._id.toString(),
            name: result.name,
          },
        });
      }

      // Build $set object - only include name if title is explicitly provided
      // This prevents overwriting the name to "Untitled" when only updating content
      const setFields: Record<string, any> = {
        code: body.content,
        connectionId: body.connectionId
          ? new Types.ObjectId(body.connectionId)
          : undefined,
        databaseName: body.databaseName,
        databaseId: body.databaseId,
        updatedAt: now,
      };

      // Only update name if explicitly provided
      if (body.title !== undefined) {
        setFields.name = body.title || "Untitled";
      }

      // If this is an explicit save without path (e.g., Cmd+S on already saved), mark as saved
      if (isExplicitSave) {
        setFields.isSaved = true;
      }

      if (isExplicitSave) {
        // Explicit save without path (e.g., Cmd+S on already saved console)
        // Use upsert in case console hasn't been auto-saved yet
        const setOnInsertFields: Record<string, any> = {
          createdBy: user.id,
          language: "sql" as const,
          isPrivate: false,
          executionCount: 0,
          createdAt: now,
        };
        // Only add name to $setOnInsert if not already in $set (avoid MongoDB conflict)
        if (!setFields.name) {
          setOnInsertFields.name = body.title || "Untitled";
        }

        const result = await SavedConsole.findOneAndUpdate(
          {
            _id: new Types.ObjectId(pathOrId),
            workspaceId: new Types.ObjectId(workspaceId),
          },
          {
            $set: setFields,
            $setOnInsert: setOnInsertFields,
          },
          { upsert: true, new: true },
        );

        return c.json({
          success: true,
          message: "Console saved",
          console: {
            id: result._id.toString(),
            name: result.name,
          },
        });
      }

      // Draft auto-save flow: Use upsert to create if doesn't exist
      // Note: isSaved is NOT set here - drafts remain isSaved: false
      const setOnInsertFields: Record<string, any> = {
        createdBy: user.id,
        language: "sql" as const,
        isPrivate: false,
        isSaved: false, // Draft consoles are not saved to explorer
        executionCount: 0,
        createdAt: now,
      };
      // Only add name to $setOnInsert if not already in $set (avoid MongoDB conflict)
      if (!setFields.name) {
        setOnInsertFields.name = "Untitled";
      }

      const result = await SavedConsole.findOneAndUpdate(
        {
          _id: new Types.ObjectId(pathOrId),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        {
          $set: setFields,
          $setOnInsert: setOnInsertFields,
        },
        { upsert: true, new: true },
      );

      return c.json({
        success: true,
        message: "Console saved",
        console: {
          id: result._id.toString(),
          name: result.name,
        },
      });
    }

    // Path-based save (explicit user save to folder)
    const consolePath = pathOrId;

    // connectionId is optional - consoles can be saved without being associated with a specific database
    let targetConnectionId = body.connectionId;
    if (!targetConnectionId) {
      // Try to get the first database for the workspace, but don't require it
      const databases = await DatabaseConnection.find({ workspaceId }).limit(1);
      if (databases.length > 0) {
        targetConnectionId = databases[0]._id.toString();
      }
      // If no databases exist, that's fine - targetConnectionId will remain undefined
    }

    const savedConsole = await consoleManager.saveConsole(
      consolePath,
      body.content,
      workspaceId,
      user.id,
      targetConnectionId,
      body.databaseName,
      body.databaseId,
      {
        folderId: body.folderId,
        description: body.description,
        language: body.language,
        isPrivate: body.isPrivate,
      },
    );

    return c.json({
      success: true,
      message: "Console updated successfully",
      data: {
        id: savedConsole._id.toString(),
        path: consolePath,
        content: body.content,
        connectionId: targetConnectionId,
        databaseName: body.databaseName,
        databaseId: body.databaseId,
        language: savedConsole.language,
      },
    });
  } catch (error) {
    logger.error("Error updating console", {
      path: c.req.param("path"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error updating console",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/consoles/folders - Create new folder
consoleRoutes.post("/folders", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const body = await c.req.json();
    const { name, parentId, isPrivate } = body;
    const user = c.get("user");

    // Verify user has access to workspace
    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (!name || typeof name !== "string") {
      return c.json(
        { success: false, error: "Name is required and must be a string" },
        400,
      );
    }

    const folder = await consoleManager.createFolder(
      name,
      workspaceId,
      user.id,
      parentId,
      isPrivate || false,
    );

    return c.json(
      {
        success: true,
        message: "Folder created successfully",
        data: {
          id: folder._id.toString(),
          name: folder.name,
          parentId: folder.parentId?.toString(),
          isPrivate: folder.isPrivate,
        },
      },
      201,
    );
  } catch (error) {
    logger.error("Error creating folder", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error creating folder",
      },
      500,
    );
  }
});

// PATCH /api/workspaces/:workspaceId/consoles/:id/rename - Rename a console
consoleRoutes.patch("/:id/rename", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const body = await c.req.json();
    const { name } = body;
    const user = c.get("user");

    // Verify user has access to workspace
    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    // Check write access
    if (Types.ObjectId.isValid(consoleId)) {
      const existing = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (existing && !ConsoleManager.canWrite(existing, user.id)) {
        return c.json(
          {
            success: false,
            error: "Cannot rename a read-only shared console",
          },
          403,
        );
      }
    }

    if (!name || typeof name !== "string") {
      return c.json(
        { success: false, error: "Name is required and must be a string" },
        400,
      );
    }

    const success = await consoleManager.renameConsole(
      consoleId,
      name,
      workspaceId,
      user.id,
    );

    if (success) {
      return c.json({ success: true, message: "Console renamed successfully" });
    } else {
      return c.json({ success: false, error: "Console not found" }, 404);
    }
  } catch (error) {
    logger.error("Error renaming console", {
      consoleId: c.req.param("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error renaming console",
      },
      500,
    );
  }
});

// DELETE /api/workspaces/:workspaceId/consoles/:id - Delete a console
consoleRoutes.delete("/:id", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const user = c.get("user");

    // Verify user has access to workspace
    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    // Only the owner can delete a console
    if (Types.ObjectId.isValid(consoleId)) {
      const existing = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (existing) {
        const ownerId = existing.owner_id || existing.createdBy;
        if (ownerId !== user.id) {
          return c.json(
            { success: false, error: "Only the console owner can delete it" },
            403,
          );
        }
      }
    }

    const success = await consoleManager.deleteConsole(consoleId, workspaceId);

    if (success) {
      return c.json({ success: true, message: "Console deleted successfully" });
    } else {
      return c.json({ success: false, error: "Console not found" }, 404);
    }
  } catch (error) {
    logger.error("Error deleting console", {
      consoleId: c.req.param("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error deleting console",
      },
      500,
    );
  }
});

// PATCH /api/workspaces/:workspaceId/consoles/folders/:id/rename - Rename a folder
consoleRoutes.patch("/folders/:id/rename", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const folderId = c.req.param("id");
    const body = await c.req.json();
    const { name } = body;
    const user = c.get("user");

    // Verify user has access to workspace
    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (!name || typeof name !== "string") {
      return c.json(
        { success: false, error: "Name is required and must be a string" },
        400,
      );
    }

    const success = await consoleManager.renameFolder(
      folderId,
      name,
      workspaceId,
    );

    if (success) {
      return c.json({ success: true, message: "Folder renamed successfully" });
    } else {
      return c.json({ success: false, error: "Folder not found" }, 404);
    }
  } catch (error) {
    logger.error("Error renaming folder", {
      folderId: c.req.param("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error renaming folder",
      },
      500,
    );
  }
});

// DELETE /api/workspaces/:workspaceId/consoles/folders/:id - Delete a folder
consoleRoutes.delete("/folders/:id", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const folderId = c.req.param("id");
    const user = c.get("user");

    // Verify user has access to workspace
    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    const success = await consoleManager.deleteFolder(folderId, workspaceId);

    if (success) {
      return c.json({ success: true, message: "Folder deleted successfully" });
    } else {
      return c.json({ success: false, error: "Folder not found" }, 404);
    }
  } catch (error) {
    logger.error("Error deleting folder", {
      folderId: c.req.param("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error deleting folder",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/consoles/:id/share - Update sharing settings
consoleRoutes.post("/:id/share", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const body = await c.req.json();
    const { access, shared_with } = body as {
      access?: ConsoleAccessLevel;
      shared_with?: string[];
    };
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (
      !access ||
      !["private", "shared_read", "shared_write"].includes(access)
    ) {
      return c.json(
        {
          success: false,
          error:
            "access is required and must be one of: private, shared_read, shared_write",
        },
        400,
      );
    }

    const updated = await consoleManager.updateConsoleAccess(
      consoleId,
      workspaceId,
      user.id,
      access,
      shared_with,
    );

    if (!updated) {
      return c.json(
        {
          success: false,
          error: "Console not found or you are not the owner",
        },
        404,
      );
    }

    return c.json({
      success: true,
      message: "Sharing settings updated",
      data: {
        id: updated._id.toString(),
        access: updated.access,
        owner_id: updated.owner_id,
        shared_with: updated.shared_with?.map(id => id.toString()),
      },
    });
  } catch (error) {
    logger.error("Error updating console sharing", {
      consoleId: c.req.param("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error updating sharing",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/consoles/:id/execute - Execute a saved console
consoleRoutes.post("/:id/execute", async (c: Context) => {
  const startTime = Date.now();
  let database: IDatabaseConnection | null = null;
  let executionStatus: QueryStatus = "error";
  let rowCount: number | undefined;
  let errorType: string | undefined;
  let workspaceId: string | undefined;
  let consoleIdParsed: Types.ObjectId | undefined;

  try {
    const access = await verifyWorkspaceAccess(c);
    if (!access) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }
    workspaceId = access.workspaceId;

    const user = c.get("user");
    const apiKey = c.get("apiKey");
    const consoleId = c.req.param("id");

    // Validate console ID
    if (!Types.ObjectId.isValid(consoleId)) {
      return c.json({ success: false, error: "Invalid console ID" }, 400);
    }
    consoleIdParsed = new Types.ObjectId(consoleId);

    // Find the console
    const savedConsole = await SavedConsole.findOne({
      _id: consoleIdParsed,
      workspaceId: new Types.ObjectId(access.workspaceId),
    });

    if (!savedConsole) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    // If console has a connection ID, verify it exists and belongs to workspace
    if (savedConsole.connectionId) {
      database = await DatabaseConnection.findOne({
        _id: savedConsole.connectionId,
        workspaceId: new Types.ObjectId(access.workspaceId),
      });

      if (!database) {
        return c.json(
          {
            success: false,
            error: "Associated database not found or access denied",
          },
          404,
        );
      }
    }

    // Execute the query based on language
    let result;
    if (!database) {
      return c.json(
        {
          success: false,
          error: "Console has no associated database connection",
        },
        400,
      );
    }

    // Pass explicit databaseId and databaseName for cluster mode (D1, etc.)
    const executionOptions = {
      databaseId: savedConsole.databaseId,
      databaseName: savedConsole.databaseName,
    };

    if (savedConsole.language === "mongodb") {
      if (
        savedConsole.mongoOptions &&
        savedConsole.mongoOptions.collection &&
        savedConsole.mongoOptions.operation
      ) {
        // For structured MongoDB operations (find, aggregate, etc.)
        const mongoQuery = {
          collection: savedConsole.mongoOptions.collection,
          operation: savedConsole.mongoOptions.operation,
          query: savedConsole.code,
        };

        result = await databaseConnectionService.executeQuery(
          database,
          mongoQuery,
          { ...savedConsole.mongoOptions, ...executionOptions },
        );
      } else {
        // For JavaScript-style MongoDB queries (db.collection.find(), etc.)
        result = await databaseConnectionService.executeQuery(
          database,
          savedConsole.code,
          executionOptions,
        );
      }
    } else {
      // For SQL and other languages, execute the code directly
      result = await databaseConnectionService.executeQuery(
        database,
        savedConsole.code,
        executionOptions,
      );
    }

    // Update execution stats
    await SavedConsole.updateOne(
      { _id: savedConsole._id },
      {
        $set: { lastExecutedAt: new Date() },
        $inc: { executionCount: 1 },
      },
    );

    // Return the result
    const data = result.data || [];
    rowCount = result.rowCount || (Array.isArray(data) ? data.length : 0);

    // Determine execution status
    if (result.success) {
      executionStatus = "success";
    } else {
      executionStatus = "error";
      const errorMsg = result.error?.toLowerCase() || "";
      if (errorMsg.includes("syntax")) {
        errorType = "syntax";
      } else if (
        errorMsg.includes("timeout") ||
        errorMsg.includes("timed out")
      ) {
        errorType = "timeout";
        executionStatus = "timeout";
      } else if (errorMsg.includes("cancel") || errorMsg.includes("abort")) {
        errorType = "cancelled";
        executionStatus = "cancelled";
      } else if (
        errorMsg.includes("connection") ||
        errorMsg.includes("connect")
      ) {
        errorType = "connection";
      } else if (
        errorMsg.includes("permission") ||
        errorMsg.includes("access denied")
      ) {
        errorType = "permission";
      } else {
        errorType = "unknown";
      }
    }

    // Track query execution (fire-and-forget)
    const userId = user?.id || apiKey?.createdBy;
    if (userId && database) {
      queryExecutionService.track({
        userId,
        apiKeyId: apiKey?._id,
        workspaceId: new Types.ObjectId(access.workspaceId),
        connectionId: database._id,
        databaseName: savedConsole.databaseName || database.connection.database,
        consoleId: savedConsole._id,
        source: apiKey ? "api" : "console_ui",
        databaseType: database.type,
        queryLanguage: mapConsoleLanguageToQueryLanguage(savedConsole.language),
        status: executionStatus,
        executionTimeMs: Date.now() - startTime,
        rowCount,
        errorType,
      });
    }

    return c.json({
      success: true,
      data: data,
      rowCount: rowCount,
      fields: result.fields || null,
      console: {
        id: savedConsole._id,
        name: savedConsole.name,
        language: savedConsole.language,
        executedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("Error executing console", { error });

    // Track failed execution
    const user = c.get("user");
    const apiKey = c.get("apiKey");
    const userId = user?.id || apiKey?.createdBy;

    if (userId && database && workspaceId) {
      queryExecutionService.track({
        userId,
        apiKeyId: apiKey?._id,
        workspaceId: new Types.ObjectId(workspaceId),
        connectionId: database._id,
        databaseName: database.connection.database,
        consoleId: consoleIdParsed,
        source: apiKey ? "api" : "console_ui",
        databaseType: database.type,
        queryLanguage: mapConsoleLanguageToQueryLanguage(
          database.type === "mongodb" ? "mongodb" : "sql",
        ),
        status: "error",
        executionTimeMs: Date.now() - startTime,
        errorType: "unknown",
      });
    }

    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to execute console",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/consoles/list - List all consoles (flat list for API clients)
consoleRoutes.get("/list", async (c: Context) => {
  try {
    const access = await verifyWorkspaceAccess(c);
    if (!access) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    // Get all consoles for the workspace
    const consoles = await SavedConsole.find({
      workspaceId: new Types.ObjectId(access.workspaceId),
    })
      .select(
        "_id name description language connectionId databaseName createdAt updatedAt lastExecutedAt executionCount access owner_id createdBy",
      )
      .populate("connectionId", "name type")
      .sort({ updatedAt: -1 });

    const user = c.get("user");
    const userId = user?.id;

    // Filter by visibility when we have a user
    const visibleConsoles = userId
      ? consoles.filter(doc => ConsoleManager.canRead(doc, userId))
      : consoles;

    return c.json({
      success: true,
      consoles: visibleConsoles.map(console => ({
        id: console._id,
        name: console.name,
        description: console.description,
        language: console.language,
        connection: console.connectionId
          ? {
              id: console.connectionId._id,
              name: (console.connectionId as any).name,
              type: (console.connectionId as any).type,
            }
          : null,
        databaseName: console.databaseName,
        createdAt: console.createdAt,
        updatedAt: console.updatedAt,
        lastExecutedAt: console.lastExecutedAt,
        executionCount: console.executionCount,
        access: ConsoleManager.resolveAccess(console),
        owner_id: console.owner_id || console.createdBy,
      })),
      total: visibleConsoles.length,
    });
  } catch (error) {
    logger.error("Error listing consoles", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list consoles",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/consoles/:id/details - Get console details (for API clients)
consoleRoutes.get("/:id/details", async (c: Context) => {
  try {
    const access = await verifyWorkspaceAccess(c);
    if (!access) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    const consoleId = c.req.param("id");

    // Validate console ID
    if (!Types.ObjectId.isValid(consoleId)) {
      return c.json({ success: false, error: "Invalid console ID" }, 400);
    }

    // Find the console
    const savedConsole = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(access.workspaceId),
    }).populate("connectionId", "name type");

    if (!savedConsole) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    const user = c.get("user");
    const resolvedAccess = ConsoleManager.resolveAccess(savedConsole);
    const ownerId = savedConsole.owner_id || savedConsole.createdBy;

    return c.json({
      success: true,
      console: {
        id: savedConsole._id,
        name: savedConsole.name,
        description: savedConsole.description,
        code: savedConsole.code,
        language: savedConsole.language,
        mongoOptions: savedConsole.mongoOptions,
        connection: savedConsole.connectionId
          ? {
              id: savedConsole.connectionId._id,
              name: (savedConsole.connectionId as any).name,
              type: (savedConsole.connectionId as any).type,
            }
          : null,
        databaseName: savedConsole.databaseName,
        createdAt: savedConsole.createdAt,
        updatedAt: savedConsole.updatedAt,
        lastExecutedAt: savedConsole.lastExecutedAt,
        executionCount: savedConsole.executionCount,
        access: resolvedAccess,
        owner_id: ownerId,
        readOnly:
          user?.id && resolvedAccess === "shared_read" && user.id !== ownerId,
      },
    });
  } catch (error) {
    logger.error("Error getting console details", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get console details",
      },
      500,
    );
  }
});
