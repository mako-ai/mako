import { Hono, Context } from "hono";
import { ConsoleManager } from "../utils/console-manager";
import {
  unifiedAuthMiddleware,
  isApiKeyAuth,
} from "../auth/unified-auth.middleware";
import {
  DatabaseConnection,
  SavedConsole,
  ConsoleFolder,
  IDatabaseConnection,
  EntityVersion,
  type ISavedConsole,
} from "../database/workspace-schema";
import { User } from "../database/schema";
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
import {
  isDescriptionGenAvailable,
  generateDescriptionAndEmbedding,
} from "../services/console-description.service";
import { generateVersionComment } from "../services/version-comment.service";
import {
  applySqlRowLimit,
  checkPreviewQuerySafety,
} from "../services/query-pagination.service";
import { createStreamingExportResponse } from "../utils/query-export-stream";
import {
  createVersion,
  listVersions,
  getVersion,
  getUserDisplayName,
} from "../services/entity-version.service";

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

function buildConsoleSnapshot(doc: ISavedConsole): Record<string, unknown> {
  return {
    name: doc.name,
    description: doc.description,
    code: doc.code,
    language: doc.language,
    connectionId: doc.connectionId?.toString(),
    databaseName: doc.databaseName,
    databaseId: doc.databaseId,
    chartSpec: doc.chartSpec,
    resultsViewMode: doc.resultsViewMode,
    mongoOptions: doc.mongoOptions,
    folderId: doc.folderId?.toString(),
    access: doc.access,
  };
}

function sanitizeDownloadFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

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

    if (userId) {
      const member = await workspaceService.getMember(
        access.workspaceId,
        userId,
      );
      const userRole = member?.role || "member";

      const { myConsoles, sharedWithWorkspace } =
        await consoleManager.listConsolesSplit(
          access.workspaceId,
          userId,
          userRole,
        );

      return c.json({
        success: true,
        myConsoles,
        sharedWithWorkspace,
        tree: myConsoles,
      });
    }

    const tree = await consoleManager.listConsoles(access.workspaceId, userId);
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

    const fullConsole = consoleData._raw;

    if (
      fullConsole &&
      !(await consoleManager.canReadWithInheritance(fullConsole, user.id))
    ) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    const consoleAccess = consoleData.access || "private";
    const ownerId = consoleData.owner_id;

    const member = await workspaceService.getMember(workspaceId, user.id);
    const isAdmin = member?.role === "owner" || member?.role === "admin";

    const readOnly = fullConsole
      ? !ConsoleManager.canWrite(fullConsole, user.id, isAdmin)
      : false;

    // Resolve owner display name
    let ownerDisplayName: string | undefined;
    if (ownerId) {
      const ownerUser = await User.findById(ownerId).select("email").lean();
      ownerDisplayName = ownerUser?.email;
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
      chartSpec: consoleData.chartSpec,
      resultsViewMode: consoleData.resultsViewMode,
      access: consoleAccess,
      owner_id: ownerId,
      ownerDisplayName,
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

// GET /api/workspaces/:workspaceId/consoles/search?q=...
consoleRoutes.get("/search", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const query = c.req.query("q") || "";
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 50) : 20;

    if (query.length < 2) {
      return c.json({ results: [] });
    }

    const { searchConsoles } = await import(
      "../agent-lib/tools/console-search-tools"
    );
    const results = await searchConsoles(query, workspaceId, limit);

    return c.json({ results });
  } catch (err) {
    logger.error("Console search failed", { error: err });
    return c.json({ success: false, error: "Search failed" }, 500);
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
    } = body;
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

    // Persist chart spec and view mode if provided
    if (body.chartSpec !== undefined || body.resultsViewMode !== undefined) {
      const chartUpdate: Record<string, unknown> = {};
      if (body.chartSpec !== undefined) chartUpdate.chartSpec = body.chartSpec;
      if (body.resultsViewMode !== undefined) {
        chartUpdate.resultsViewMode = body.resultsViewMode;
      }
      await SavedConsole.findByIdAndUpdate(savedConsole._id, {
        $set: chartUpdate,
      });
    }

    // Create version 1 for this new console
    const freshDoc = await SavedConsole.findById(savedConsole._id).lean();
    if (freshDoc) {
      const displayName = await getUserDisplayName(user.id);
      await createVersion({
        entityType: "console",
        entityId: savedConsole._id,
        workspaceId: new Types.ObjectId(workspaceId),
        snapshot: buildConsoleSnapshot(freshDoc as ISavedConsole),
        savedBy: user.id,
        savedByName: displayName,
        comment: body.comment ?? "",
      });
      await SavedConsole.updateOne(
        { _id: savedConsole._id },
        { $set: { version: 1 } },
      );
    }

    // Fire-and-forget: generate description + embedding for searchability
    if (isDescriptionGenAvailable() && content.trim()) {
      void (async () => {
        try {
          const connDoc = targetConnectionId
            ? await DatabaseConnection.findById(targetConnectionId)
            : null;
          const {
            description: genDesc,
            embedding,
            embeddingModel,
          } = await generateDescriptionAndEmbedding(
            {
              code: content,
              title: consolePath.split("/").pop() || consolePath,
              connectionName: connDoc?.name,
              databaseType: connDoc?.type,
              databaseName,
              language: savedConsole.language,
            },
            { workspaceId, userId: user.id },
          );
          if (genDesc || embedding) {
            const update: Record<string, unknown> = {};
            if (genDesc && !description) update.description = genDesc;
            if (embedding) {
              update.descriptionEmbedding = embedding;
              update.embeddingModel = embeddingModel;
            }
            if (Object.keys(update).length > 0) {
              await SavedConsole.findByIdAndUpdate(savedConsole._id, {
                $set: update,
              });
            }
          }
        } catch (err) {
          logger.debug("Console description generation failed", { error: err });
        }
      })();
    }

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

    const memberPut = await workspaceService.getMember(workspaceId, user.id);
    const isAdminPut =
      memberPut?.role === "owner" || memberPut?.role === "admin";

    // Check if pathOrId is a valid ObjectId - if so, do ID-based update
    if (Types.ObjectId.isValid(pathOrId) && pathOrId.length === 24) {
      const existingById = await SavedConsole.findOne({
        _id: new Types.ObjectId(pathOrId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (
        existingById &&
        !ConsoleManager.canWrite(existingById, user.id, isAdminPut)
      ) {
        return c.json(
          {
            success: false,
            error: "This console is read-only. Create a copy to make changes.",
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

        const displayName = await getUserDisplayName(user.id);

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
        if (body.chartSpec !== undefined) setFields.chartSpec = body.chartSpec;
        if (body.resultsViewMode !== undefined) {
          setFields.resultsViewMode = body.resultsViewMode;
        }

        const result = await SavedConsole.findOneAndUpdate(
          {
            _id: new Types.ObjectId(pathOrId),
            workspaceId: new Types.ObjectId(workspaceId),
          },
          {
            $set: setFields,
            $inc: { version: 1 },
            $setOnInsert: {
              createdBy: user.id,
              owner_id: user.id,
              language: "sql" as const,
              isPrivate: true,
              access: "private" as const,
              executionCount: 0,
              createdAt: now,
            },
          },
          { upsert: true, new: true },
        );

        // Create version record for the new state
        await createVersion({
          entityType: "console",
          entityId: result._id,
          workspaceId: new Types.ObjectId(workspaceId),
          snapshot: buildConsoleSnapshot(result as ISavedConsole),
          savedBy: user.id,
          savedByName: displayName,
          comment: body.comment ?? "",
        });

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

      if (body.chartSpec !== undefined) setFields.chartSpec = body.chartSpec;
      if (body.resultsViewMode !== undefined) {
        setFields.resultsViewMode = body.resultsViewMode;
      }

      // If this is an explicit save without path (e.g., Cmd+S on already saved), mark as saved
      if (isExplicitSave) {
        setFields.isSaved = true;
      }

      if (isExplicitSave) {
        const setOnInsertFields: Record<string, any> = {
          createdBy: user.id,
          owner_id: user.id,
          language: "sql" as const,
          isPrivate: true,
          access: "private" as const,
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
            $inc: { version: 1 },
            $setOnInsert: setOnInsertFields,
          },
          { upsert: true, new: true },
        );

        // Create version record for the new state
        const displayNameExplicit = await getUserDisplayName(user.id);
        await createVersion({
          entityType: "console",
          entityId: result._id,
          workspaceId: new Types.ObjectId(workspaceId),
          snapshot: buildConsoleSnapshot(result as ISavedConsole),
          savedBy: user.id,
          savedByName: displayNameExplicit,
          comment: body.comment ?? "",
        });

        // Fire-and-forget: generate description + embedding on explicit save
        if (isDescriptionGenAvailable() && body.content?.trim()) {
          void (async () => {
            try {
              const connDoc = body.connectionId
                ? await DatabaseConnection.findById(body.connectionId)
                : null;
              const {
                description: genDesc,
                embedding,
                embeddingModel,
              } = await generateDescriptionAndEmbedding(
                {
                  code: body.content,
                  title: result.name,
                  connectionName: connDoc?.name,
                  databaseType: connDoc?.type,
                  databaseName: body.databaseName,
                  language: result.language,
                },
                { workspaceId, userId: user.id },
              );
              if (genDesc || embedding) {
                const descUpdate: Record<string, unknown> = {};
                if (genDesc) descUpdate.description = genDesc;
                if (embedding) {
                  descUpdate.descriptionEmbedding = embedding;
                  descUpdate.embeddingModel = embeddingModel;
                }
                if (Object.keys(descUpdate).length > 0) {
                  await SavedConsole.findByIdAndUpdate(result._id, {
                    $set: descUpdate,
                  });
                }
              }
            } catch (err) {
              logger.debug("Console description generation failed", {
                error: err,
              });
            }
          })();
        }

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
      const setOnInsertFields: Record<string, any> = {
        createdBy: user.id,
        owner_id: user.id,
        language: "sql" as const,
        isPrivate: true,
        access: "private" as const,
        isSaved: false,
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

    // Create version 1 for this new console
    const freshDocPath = await SavedConsole.findById(savedConsole._id).lean();
    if (freshDocPath) {
      const displayNamePath = await getUserDisplayName(user.id);
      await createVersion({
        entityType: "console",
        entityId: savedConsole._id,
        workspaceId: new Types.ObjectId(workspaceId),
        snapshot: buildConsoleSnapshot(freshDocPath as ISavedConsole),
        savedBy: user.id,
        savedByName: displayNamePath,
        comment: body.comment ?? "",
      });
      await SavedConsole.updateOne(
        { _id: savedConsole._id },
        { $set: { version: 1 } },
      );
    }

    // Fire-and-forget: regenerate description + embedding when content changes
    if (isDescriptionGenAvailable() && body.content.trim()) {
      void (async () => {
        try {
          const connDoc = targetConnectionId
            ? await DatabaseConnection.findById(targetConnectionId)
            : null;
          const {
            description: genDesc,
            embedding,
            embeddingModel,
          } = await generateDescriptionAndEmbedding(
            {
              code: body.content,
              title: consolePath.split("/").pop() || consolePath,
              connectionName: connDoc?.name,
              databaseType: connDoc?.type,
              databaseName: body.databaseName,
              language: savedConsole.language,
            },
            { workspaceId, userId: user.id },
          );
          if (genDesc || embedding) {
            const update: Record<string, unknown> = {};
            if (genDesc) update.description = genDesc;
            if (embedding) {
              update.descriptionEmbedding = embedding;
              update.embeddingModel = embeddingModel;
            }
            if (Object.keys(update).length > 0) {
              await SavedConsole.findByIdAndUpdate(savedConsole._id, {
                $set: update,
              });
            }
          }
        } catch (err) {
          logger.debug("Console description generation failed", { error: err });
        }
      })();
    }

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
    const { name, parentId, isPrivate, access } = body;
    const user = c.get("user");

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
      access || "private",
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

    const memberRename = await workspaceService.getMember(workspaceId, user.id);
    const isAdminRename =
      memberRename?.role === "owner" || memberRename?.role === "admin";

    if (Types.ObjectId.isValid(consoleId)) {
      const existing = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (
        existing &&
        !ConsoleManager.canWrite(existing, user.id, isAdminRename)
      ) {
        return c.json(
          {
            success: false,
            error: "Cannot rename a read-only console",
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

// DELETE /api/workspaces/:workspaceId/consoles/:id - Soft-delete a console
consoleRoutes.delete("/:id", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (Types.ObjectId.isValid(consoleId)) {
      const existing = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (existing) {
        const ownerId = existing.owner_id || existing.createdBy;
        if (ownerId !== user.id) {
          const isAdminOrOwner = await workspaceService.hasRole(
            workspaceId,
            user.id,
            ["owner", "admin"],
          );
          if (!isAdminOrOwner) {
            return c.json(
              {
                success: false,
                error:
                  "Only the console owner or a workspace admin can delete it",
              },
              403,
            );
          }
        }
      }
    }

    const success = await consoleManager.softDeleteConsole(
      consoleId,
      workspaceId,
    );

    if (success) {
      return c.json({
        success: true,
        message: "Console deleted successfully",
        id: consoleId,
      });
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

// POST /api/workspaces/:workspaceId/consoles/:id/duplicate - Duplicate a console
consoleRoutes.post("/:id/duplicate", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    const copy = await consoleManager.duplicateConsole(
      consoleId,
      workspaceId,
      user.id,
    );

    if (copy) {
      return c.json(
        {
          success: true,
          message: "Console duplicated",
          data: {
            id: copy._id.toString(),
            name: copy.name,
            folderId: copy.folderId?.toString(),
          },
        },
        201,
      );
    } else {
      return c.json({ success: false, error: "Console not found" }, 404);
    }
  } catch (error) {
    logger.error("Error duplicating console", {
      consoleId: c.req.param("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error duplicating console",
      },
      500,
    );
  }
});

// PATCH /api/workspaces/:workspaceId/consoles/:id/restore - Restore a soft-deleted console
consoleRoutes.patch("/:id/restore", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    const success = await consoleManager.restoreConsole(consoleId, workspaceId);

    if (success) {
      return c.json({ success: true, message: "Console restored" });
    } else {
      return c.json({ success: false, error: "Console not found" }, 404);
    }
  } catch (error) {
    logger.error("Error restoring console", {
      consoleId: c.req.param("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error restoring console",
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

    // Verify ownership or admin/owner role
    if (Types.ObjectId.isValid(folderId)) {
      const folder = await ConsoleFolder.findOne({
        _id: new Types.ObjectId(folderId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (folder) {
        const isOwnFolder = folder.ownerId?.toString() === user.id;
        if (!isOwnFolder) {
          const isAdminOrOwner = await workspaceService.hasRole(
            workspaceId,
            user.id,
            ["owner", "admin"],
          );
          if (!isAdminOrOwner) {
            return c.json(
              {
                success: false,
                error:
                  "Only the folder owner or a workspace admin can delete it",
              },
              403,
            );
          }
        }
      }
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

// PATCH /api/workspaces/:workspaceId/consoles/:id/move - Move a console to a different folder
consoleRoutes.patch("/:id/move", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const body = await c.req.json();
    const { folderId, access } = body as {
      folderId: string | null;
      access?: "private" | "workspace";
    };
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    const memberMove = await workspaceService.getMember(workspaceId, user.id);
    const isAdminMove =
      memberMove?.role === "owner" || memberMove?.role === "admin";

    if (Types.ObjectId.isValid(consoleId)) {
      const existing = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (
        existing &&
        !ConsoleManager.canWrite(existing, user.id, isAdminMove)
      ) {
        return c.json(
          { success: false, error: "Cannot move a read-only console" },
          403,
        );
      }
    }

    const success = await consoleManager.moveConsole(
      consoleId,
      workspaceId,
      folderId ?? null,
      access,
    );

    if (success) {
      return c.json({ success: true, message: "Console moved successfully" });
    } else {
      return c.json({ success: false, error: "Console not found" }, 404);
    }
  } catch (error) {
    logger.error("Error moving console", {
      consoleId: c.req.param("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error moving console",
      },
      500,
    );
  }
});

// PATCH /api/workspaces/:workspaceId/consoles/folders/:id/move - Move a folder to a different parent
consoleRoutes.patch("/folders/:id/move", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const folderId = c.req.param("id");
    const body = await c.req.json();
    const { parentId, access } = body as {
      parentId: string | null;
      access?: "private" | "workspace";
    };
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    const success = await consoleManager.moveFolder(
      folderId,
      workspaceId,
      parentId ?? null,
      access,
    );

    if (success) {
      return c.json({ success: true, message: "Folder moved successfully" });
    } else {
      return c.json(
        { success: false, error: "Folder not found or circular nesting" },
        404,
      );
    }
  } catch (error) {
    logger.error("Error moving folder", {
      folderId: c.req.param("id"),
      error,
    });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error moving folder",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/consoles/:id/version-comment - Generate AI version comment
consoleRoutes.post("/:id/version-comment", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    const body = await c.req.json();
    const { newContent, source, aiPrompt } = body;

    if (typeof newContent !== "string") {
      return c.json(
        { success: false, error: "newContent must be a string" },
        400,
      );
    }

    if (newContent.length > 50_000) {
      return c.json(
        { success: false, error: "Content too large for comment generation" },
        400,
      );
    }

    let previousContent = "";
    let versionFound = false;
    if (Types.ObjectId.isValid(consoleId)) {
      const latestSnapshot = await EntityVersion.findOne(
        {
          entityId: new Types.ObjectId(consoleId),
          entityType: "console",
        },
        { snapshot: 1, version: 1 },
      )
        .sort({ version: -1 })
        .lean();

      if (latestSnapshot?.snapshot?.code) {
        previousContent = latestSnapshot.snapshot.code as string;
        versionFound = true;
      }

      logger.debug("Version comment baseline lookup", {
        consoleId,
        versionFound,
        latestVersion: latestSnapshot?.version ?? null,
        snapshotKeys: latestSnapshot?.snapshot
          ? Object.keys(latestSnapshot.snapshot)
          : null,
        previousContentLength: previousContent.length,
        newContentLength: newContent.length,
      });
    }

    const result = await generateVersionComment(
      {
        previousContent,
        newContent,
        language: "sql",
        source: source === "ai" ? "ai" : "user",
        aiPrompt: typeof aiPrompt === "string" ? aiPrompt : undefined,
      },
      { workspaceId, userId: user.id },
    );

    return c.json({
      success: true,
      comment: result.comment,
      diff: result.diff,
      debug: {
        consoleId,
        versionFound,
        previousContentLength: previousContent.length,
        newContentLength: newContent.length,
      },
    });
  } catch (error) {
    logger.error("Error generating version comment", { error });
    return c.json(
      { success: false, error: "Failed to generate version comment" },
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
    const mode = c.req.query("mode");
    const pageSizeParam = c.req.query("pageSize");
    const cursorParam = c.req.query("cursor");

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

    if (
      user &&
      !(await consoleManager.canReadWithInheritance(savedConsole, user.id))
    ) {
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
    const isPreviewMode = mode === "preview";

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

        result = isPreviewMode
          ? await databaseConnectionService.executePreviewQuery(
              database,
              mongoQuery,
              {
                ...savedConsole.mongoOptions,
                ...executionOptions,
                pageSize: pageSizeParam
                  ? parseInt(pageSizeParam, 10)
                  : undefined,
                cursor: cursorParam || null,
              },
            )
          : await databaseConnectionService.executeQuery(database, mongoQuery, {
              ...savedConsole.mongoOptions,
              ...executionOptions,
            });
      } else {
        // For JavaScript-style MongoDB queries (db.collection.find(), etc.)
        result = isPreviewMode
          ? await databaseConnectionService.executePreviewQuery(
              database,
              savedConsole.code,
              {
                ...executionOptions,
                pageSize: pageSizeParam
                  ? parseInt(pageSizeParam, 10)
                  : undefined,
                cursor: cursorParam || null,
              },
            )
          : await databaseConnectionService.executeQuery(
              database,
              savedConsole.code,
              executionOptions,
            );
      }
    } else {
      // For SQL and other languages, execute the code directly
      result = isPreviewMode
        ? await databaseConnectionService.executePreviewQuery(
            database,
            savedConsole.code,
            {
              ...executionOptions,
              pageSize: pageSizeParam ? parseInt(pageSizeParam, 10) : undefined,
              cursor: cursorParam || null,
            },
          )
        : await databaseConnectionService.executeQuery(
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
    const previewRows =
      "rows" in result && Array.isArray(result.rows) ? result.rows : undefined;
    const data = "data" in result ? result.data || [] : [];
    rowCount =
      result.rowCount ||
      (Array.isArray(previewRows)
        ? previewRows.length
        : Array.isArray(data)
          ? data.length
          : 0);

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

    return c.json(
      isPreviewMode
        ? {
            success: true,
            rows: previewRows || [],
            rowCount,
            fields: result.fields || null,
            pageInfo: "pageInfo" in result ? result.pageInfo || null : null,
            console: {
              id: savedConsole._id,
              name: savedConsole.name,
              language: savedConsole.language,
              executedAt: new Date().toISOString(),
            },
          }
        : {
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
          },
    );
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

// GET /api/workspaces/:workspaceId/consoles/:id/export - Export console query results as Arrow IPC or JSON
consoleRoutes.get("/:id/export", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const format = (c.req.query("format") || "arrow") as
      | "arrow"
      | "json"
      | "ndjson"
      | "csv";
    const limit = parseInt(c.req.query("limit") || "500000", 10);

    if (!Types.ObjectId.isValid(consoleId)) {
      return c.json({ success: false, error: "Invalid console ID" }, 400);
    }

    const savedConsole = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!savedConsole) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    if (!savedConsole.connectionId) {
      return c.json(
        { success: false, error: "Console has no database connection" },
        400,
      );
    }

    const database = await DatabaseConnection.findOne({
      _id: savedConsole.connectionId,
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!database) {
      return c.json(
        { success: false, error: "Database connection not found" },
        404,
      );
    }

    const startTime = Date.now();

    let query: any = savedConsole.code;
    if (
      savedConsole.language === "mongodb" &&
      (savedConsole as any).mongoOptions?.collection
    ) {
      query = {
        collection: (savedConsole as any).mongoOptions.collection,
        operation: (savedConsole as any).mongoOptions.operation || "find",
        query: savedConsole.code,
      };
    }

    if (
      (format === "ndjson" || format === "csv") &&
      typeof query === "string" &&
      database.type !== "cloudflare-kv"
    ) {
      const safety = checkPreviewQuerySafety(query);
      if (!safety.safe) {
        return c.json(
          {
            success: false,
            error: safety.errors.join(" "),
          },
          400,
        );
      }
    }

    if (format === "ndjson" || format === "csv") {
      const safeFileBase = sanitizeDownloadFilename(
        savedConsole.name || `console-${savedConsole._id.toString()}`,
      );
      const streamQuery =
        typeof query === "string" &&
        database.type !== "cloudflare-kv" &&
        database.type !== "mongodb"
          ? applySqlRowLimit({
              query,
              databaseType: database.type,
              limit,
            })
          : query;

      return createStreamingExportResponse({
        format,
        filename: `${safeFileBase}.${format === "csv" ? "csv" : "ndjson"}`,
        streamRows: emitRows =>
          databaseConnectionService.executeStreamingQuery(
            database,
            streamQuery,
            {
              databaseId: savedConsole.databaseId,
              databaseName: savedConsole.databaseName,
              batchSize: Math.max(1, Math.min(10000, limit)),
              signal: c.req.raw.signal,
              onBatch: emitRows,
            },
          ),
      });
    }

    const result = await databaseConnectionService.executeQuery(
      database,
      query,
      {
        databaseId: savedConsole.databaseId,
        databaseName: savedConsole.databaseName,
      },
    );

    if (!result.success || !result.data) {
      return c.json(
        { success: false, error: result.error || "Query execution failed" },
        500,
      );
    }

    const rows = Array.isArray(result.data) ? result.data : [];
    const limitedRows = rows.slice(0, limit);
    const fields = (result.fields || []).map((f: any) => ({
      name: f.name || f.columnName || String(f),
      type: f.type || f.dataType,
    }));

    if (fields.length === 0 && limitedRows.length > 0) {
      for (const key of Object.keys(limitedRows[0])) {
        fields.push({ name: key, type: undefined });
      }
    }

    const duration = Date.now() - startTime;

    if (format === "json") {
      return c.json({
        success: true,
        data: limitedRows,
        fields,
        rowCount: limitedRows.length,
        durationMs: duration,
      });
    }

    const { serializeToArrowIPC } = await import("../utils/arrow-serializer");
    const arrowBuffer = serializeToArrowIPC(limitedRows, fields, { limit });

    return new Response(arrowBuffer, {
      headers: {
        "Content-Type": "application/vnd.apache.arrow.stream",
        "X-Row-Count": String(limitedRows.length),
        "X-Export-Duration-Ms": String(duration),
      },
    });
  } catch (error) {
    logger.error("Error exporting console data", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Export failed",
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

    if (
      user?.id &&
      !(await consoleManager.canReadWithInheritance(savedConsole, user.id))
    ) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    const memberDetail = user?.id
      ? await workspaceService.getMember(access.workspaceId, user.id)
      : null;
    const isAdminDetail =
      memberDetail?.role === "owner" || memberDetail?.role === "admin";
    const readOnly = user?.id
      ? !ConsoleManager.canWrite(savedConsole, user.id, isAdminDetail)
      : false;

    let ownerDisplayName: string | undefined;
    if (ownerId) {
      const ownerUser = await User.findById(ownerId).select("email").lean();
      ownerDisplayName = ownerUser?.email;
    }

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
        ownerDisplayName,
        readOnly,
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

// ---------------------------------------------------------------------------
// Version history routes
// ---------------------------------------------------------------------------

// GET /api/workspaces/:workspaceId/consoles/:id/versions
consoleRoutes.get("/:id/versions", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (!Types.ObjectId.isValid(consoleId)) {
      return c.json({ success: false, error: "Invalid console ID" }, 400);
    }

    const consoleDoc = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!consoleDoc) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    const limit = Math.min(
      parseInt(c.req.query("limit") ?? "50", 10) || 50,
      100,
    );
    const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;

    const result = await listVersions(
      new Types.ObjectId(consoleId),
      "console",
      { limit, offset },
    );

    return c.json({ success: true, ...result });
  } catch (error) {
    logger.error("Error listing console versions", { error });
    return c.json({ success: false, error: "Failed to list versions" }, 500);
  }
});

// GET /api/workspaces/:workspaceId/consoles/:id/versions/:version
consoleRoutes.get("/:id/versions/:version", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const versionNum = parseInt(c.req.param("version"), 10);
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (!Types.ObjectId.isValid(consoleId) || isNaN(versionNum)) {
      return c.json(
        { success: false, error: "Invalid console ID or version" },
        400,
      );
    }

    const consoleDoc = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!consoleDoc) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    const version = await getVersion(consoleId, "console", versionNum);
    if (!version) {
      return c.json({ success: false, error: "Version not found" }, 404);
    }

    return c.json({ success: true, version });
  } catch (error) {
    logger.error("Error getting console version", { error });
    return c.json({ success: false, error: "Failed to get version" }, 500);
  }
});

// POST /api/workspaces/:workspaceId/consoles/:id/versions/:version/restore
consoleRoutes.post("/:id/versions/:version/restore", async (c: Context) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const consoleId = c.req.param("id");
    const versionNum = parseInt(c.req.param("version"), 10);
    const body = await c.req.json().catch(() => ({}));
    const user = c.get("user");

    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }

    if (!Types.ObjectId.isValid(consoleId) || isNaN(versionNum)) {
      return c.json(
        { success: false, error: "Invalid console ID or version" },
        400,
      );
    }

    const consoleDoc = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!consoleDoc) {
      return c.json({ success: false, error: "Console not found" }, 404);
    }

    const member = await workspaceService.getMember(workspaceId, user.id);
    const isAdmin = member?.role === "owner" || member?.role === "admin";
    if (!ConsoleManager.canWrite(consoleDoc, user.id, isAdmin)) {
      return c.json(
        { success: false, error: "You do not have write access" },
        403,
      );
    }

    const oldVersion = await getVersion(consoleId, "console", versionNum);
    if (!oldVersion) {
      return c.json({ success: false, error: "Version not found" }, 404);
    }

    const snap = oldVersion.snapshot as Record<string, any>;

    // Apply the snapshot to the console document. Includes every field
    // captured in buildConsoleSnapshot so restore is a true revert.
    const restoreFields: Record<string, any> = {
      code: snap.code,
      name: snap.name,
      language: snap.language,
      description: snap.description,
      chartSpec: snap.chartSpec,
      resultsViewMode: snap.resultsViewMode,
      mongoOptions: snap.mongoOptions,
      connectionId: snap.connectionId
        ? new Types.ObjectId(snap.connectionId)
        : undefined,
      databaseName: snap.databaseName,
      databaseId: snap.databaseId,
      folderId: snap.folderId ? new Types.ObjectId(snap.folderId) : null,
      access: snap.access,
    };

    const restored = await SavedConsole.findOneAndUpdate(
      {
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      },
      { $set: restoreFields, $inc: { version: 1 } },
      { new: true },
    ).lean();

    if (!restored) {
      return c.json({ success: false, error: "Restore failed" }, 500);
    }

    const displayName = await getUserDisplayName(user.id);
    const comment = body.comment ?? `Restored from version ${versionNum}`;
    await createVersion({
      entityType: "console",
      entityId: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
      snapshot: buildConsoleSnapshot(restored as ISavedConsole),
      savedBy: user.id,
      savedByName: displayName,
      comment,
      restoredFrom: versionNum,
    });

    return c.json({
      success: true,
      message: `Restored to version ${versionNum}`,
      console: {
        id: restored._id.toString(),
        name: restored.name,
        version: restored.version,
      },
    });
  } catch (error) {
    logger.error("Error restoring console version", { error });
    return c.json({ success: false, error: "Failed to restore version" }, 500);
  }
});
