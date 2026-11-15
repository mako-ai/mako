/**
 * Console mutations (git first, apps.md §16.3: the file is the record, the
 * row follows): save, rename, move, change access, soft delete / restore,
 * duplicate — plus the path lookup used for save conflicts and external-use
 * telemetry.
 */
import { Types } from "mongoose";
import {
  SavedConsole,
  type ConsoleAccessLevel,
  type ISavedConsole,
} from "../../database/workspace-schema";
import { getLogger } from "../../logging";
import {
  commitConsoleRemoval,
  commitConsoleState,
} from "../../apps/workspace-consoles.service";
import { RepoRequiredError } from "../../apps/config";
import { ensureConsoleFolderPath, findFolderByPath } from "./folders";

const logger = getLogger(["api", "consoles"]);

/**
 * Save console content to database
 */
export async function saveConsole(
  consolePath: string,
  content: string,
  workspaceId: string,
  userId: string,
  connectionId?: string,
  databaseName?: string,
  databaseId?: string,
  options?: {
    id?: string; // Optional client-provided ID
    folderId?: string;
    description?: string;
    language?: "sql" | "javascript" | "mongodb";
    isPrivate?: boolean;
    access?: ConsoleAccessLevel;
  },
): Promise<ISavedConsole> {
  try {
    const parts = consolePath.split("/");
    const consoleName = parts[parts.length - 1];

    // Handle folder path from consolePath if not provided in options
    let folderId = options?.folderId;

    if (!folderId && parts.length > 1) {
      // Extract folder path and find/create the folder
      const folderParts = parts.slice(0, -1);
      folderId = await ensureConsoleFolderPath(
        folderParts,
        workspaceId,
        userId,
      );
    }

    // Look up existing console - try by ID first, then by name + folder
    // The POST route handles conflict detection for new consoles
    // The path-based PUT route needs the name + folder fallback to update existing consoles
    let savedConsole: ISavedConsole | null = null;

    if (options?.id && Types.ObjectId.isValid(options.id)) {
      // ID-based lookup (used by POST route and conflict resolution)
      savedConsole = await SavedConsole.findOne({
        _id: new Types.ObjectId(options.id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
    }

    // Fallback: look up by name + folder for path-based PUT requests
    // Only match saved consoles (isSaved: true), not drafts
    if (!savedConsole) {
      const query: Record<string, unknown> = {
        name: consoleName,
        workspaceId: new Types.ObjectId(workspaceId),
        isSaved: true, // Only match saved consoles, not drafts
      };

      if (folderId) {
        query.folderId = new Types.ObjectId(folderId);
      } else {
        // For root level consoles, check that folderId is null/undefined
        query.$or = [{ folderId: null }, { folderId: { $exists: false } }];
      }

      savedConsole = await SavedConsole.findOne(query);
    }

    const requestedAccess =
      options?.access ??
      (options?.isPrivate === undefined
        ? undefined
        : options.isPrivate
          ? "private"
          : "workspace");

    if (savedConsole) {
      // Update existing console (draft -> saved)
      savedConsole.name = consoleName; // Update name (may change if draft is being saved with a path)
      savedConsole.folderId = folderId
        ? new Types.ObjectId(folderId)
        : undefined; // Update folder (draft -> saved with path)
      savedConsole.code = content;
      savedConsole.isSaved = true; // Mark as explicitly saved (no longer a draft)
      savedConsole.updatedAt = new Date();
      if (connectionId !== undefined) {
        savedConsole.connectionId = connectionId
          ? new Types.ObjectId(connectionId)
          : undefined;
      }
      if (databaseName !== undefined) {
        savedConsole.databaseName = databaseName;
      }
      if (databaseId !== undefined) {
        savedConsole.databaseId = databaseId;
      }
      if (options?.description !== undefined) {
        savedConsole.description = options.description;
      }
      if (options?.language) savedConsole.language = options.language;
      if (requestedAccess !== undefined) {
        savedConsole.access = requestedAccess;
        savedConsole.isPrivate = requestedAccess === "private";
      }
      // Backfill owner_id if missing
      if (!savedConsole.owner_id) {
        savedConsole.owner_id = savedConsole.createdBy;
      }
      // Backfill access if missing
      if (!savedConsole.access) {
        savedConsole.access = savedConsole.isPrivate ? "private" : "workspace";
      }

      // Git first (apps.md §16.3): the file is the record, the row follows.
      const committed = await commitConsoleState({
        row: savedConsole,
        previousPath: savedConsole.path,
        actorUserId: userId,
        message: `save: ${consolePath}`,
      });
      savedConsole.path = committed.path;
      savedConsole.sourceBlobSha = committed.sourceBlobSha;
      await savedConsole.save();
    } else {
      // Create new console (explicitly saved)
      const access =
        options?.access ?? (options?.isPrivate ? "private" : "workspace");
      const isPrivate = access === "private";
      const consoleData: Record<string, unknown> = {
        workspaceId: new Types.ObjectId(workspaceId),
        folderId: folderId ? new Types.ObjectId(folderId) : undefined,
        connectionId: connectionId
          ? new Types.ObjectId(connectionId)
          : undefined,
        databaseName: databaseName,
        databaseId: databaseId,
        name: consoleName,
        description: options?.description || "",
        code: content,
        language: options?.language || detectConsoleLanguage(content),
        createdBy: userId,
        isPrivate,
        isSaved: true,
        executionCount: 0,
        access,
        owner_id: userId,
      };

      // Use client-provided ID if available and valid
      if (options?.id && Types.ObjectId.isValid(options.id)) {
        consoleData._id = new Types.ObjectId(options.id);
      }

      savedConsole = new SavedConsole(consoleData);
      const committed = await commitConsoleState({
        row: savedConsole,
        actorUserId: userId,
        message: `create: ${consolePath}`,
      });
      savedConsole.path = committed.path;
      savedConsole.sourceBlobSha = committed.sourceBlobSha;
      await savedConsole.save();
    }

    return savedConsole;
  } catch (error) {
    if (error instanceof RepoRequiredError) throw error;
    logger.error("Error saving console to database", { error });
    throw error;
  }
}

/**
 * Rename a console in the database
 */
export async function renameConsole(
  consoleId: string,
  newName: string,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  try {
    // Parse the new name for potential folder path
    const parts = newName.split("/");
    const consoleName = parts[parts.length - 1];

    let folderId: string | undefined = undefined;

    if (parts.length > 1) {
      // Extract folder path and find/create the folder
      const folderParts = parts.slice(0, -1);
      folderId = await ensureConsoleFolderPath(
        folderParts,
        workspaceId,
        userId,
      );
    }

    const updateFields: Record<string, unknown> = {
      name: consoleName,
      updatedAt: new Date(),
    };

    // Update folderId if we have a folder path
    if (parts.length > 1) {
      updateFields.folderId = folderId ? new Types.ObjectId(folderId) : null;
    }

    const current = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!current) return false;
    if (current.isSaved) {
      current.name = consoleName;
      if (parts.length > 1) {
        current.folderId = folderId ? new Types.ObjectId(folderId) : undefined;
      }
      const committed = await commitConsoleState({
        row: current,
        previousPath: current.path,
        actorUserId: userId,
        message: `rename: ${consoleName}`,
      });
      updateFields.path = committed.path;
      updateFields.sourceBlobSha = committed.sourceBlobSha;
    }

    const result = await SavedConsole.updateOne(
      {
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      },
      {
        $set: updateFields,
      },
    );

    return result.modifiedCount > 0;
  } catch (error) {
    if (error instanceof RepoRequiredError) throw error;
    logger.error("Error renaming console", { error });
    return false;
  }
}

/**
 * Move a console to a different folder (or root if folderId is null)
 */
export async function moveConsole(
  consoleId: string,
  workspaceId: string,
  folderId: string | null,
  access?: ConsoleAccessLevel,
  userId?: string,
): Promise<boolean> {
  const objectId = Types.ObjectId.isValid(consoleId)
    ? new Types.ObjectId(consoleId)
    : null;
  if (!objectId) return false;

  const updateFields: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (folderId) {
    updateFields.folderId = new Types.ObjectId(folderId);
  } else {
    updateFields.folderId = null;
  }

  if (access) {
    updateFields.access = access;
    updateFields.isPrivate = access === "private";
  }

  const current = await SavedConsole.findOne({
    _id: objectId,
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!current) return false;
  if (current.isSaved) {
    current.folderId = folderId ? new Types.ObjectId(folderId) : undefined;
    if (access) {
      current.access = access;
      current.isPrivate = access === "private";
    }
    const committed = await commitConsoleState({
      row: current,
      previousPath: current.path,
      actorUserId: userId,
      message: `move: ${current.name}`,
    });
    updateFields.path = committed.path;
    updateFields.sourceBlobSha = committed.sourceBlobSha;
  }

  const result = await SavedConsole.updateOne(
    {
      _id: objectId,
      workspaceId: new Types.ObjectId(workspaceId),
    },
    { $set: updateFields },
  );

  return result.modifiedCount > 0;
}

/**
 * Update access level for a console.
 * Only the owner can change access.
 */
export async function updateConsoleAccess(
  consoleId: string,
  workspaceId: string,
  userId: string,
  access: ConsoleAccessLevel,
): Promise<ISavedConsole | null> {
  try {
    const savedConsole = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!savedConsole) return null;

    const ownerId = (
      savedConsole.owner_id || savedConsole.createdBy
    )?.toString();
    if (ownerId !== userId) return null;

    savedConsole.access = access;
    savedConsole.isPrivate = access === "private";
    savedConsole.updatedAt = new Date();
    if (savedConsole.isSaved) {
      const committed = await commitConsoleState({
        row: savedConsole,
        previousPath: savedConsole.path,
        actorUserId: userId,
        message: `access ${access}: ${savedConsole.name}`,
      });
      savedConsole.path = committed.path;
      savedConsole.sourceBlobSha = committed.sourceBlobSha;
    }
    await savedConsole.save();
    return savedConsole;
  } catch (error) {
    if (error instanceof RepoRequiredError) throw error;
    logger.error("Error updating console access", { error });
    return null;
  }
}

/**
 * Soft-delete a console (set is_deleted=true instead of removing).
 */
export async function softDeleteConsole(
  consoleId: string,
  workspaceId: string,
  userId?: string,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(consoleId)) return false;
  const current = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  }).select("path name");
  if (!current) return false;
  // The row keeps its `path` so a restore puts the file back where it was.
  if (current.path) {
    await commitConsoleRemoval({
      workspaceId,
      path: current.path,
      actorUserId: userId,
      message: `delete: ${current.path}`,
    });
  }
  const result = await SavedConsole.updateOne(
    {
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    },
    { $set: { is_deleted: true, deletedAt: new Date() } },
  );
  return result.modifiedCount > 0;
}

/**
 * Restore a soft-deleted console.
 */
export async function restoreConsole(
  consoleId: string,
  workspaceId: string,
  userId?: string,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(consoleId)) return false;
  const current = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!current) return false;
  const set: Record<string, unknown> = { is_deleted: false };
  if (current.isSaved) {
    const committed = await commitConsoleState({
      row: current,
      actorUserId: userId,
      message: `restore: ${current.name}`,
    });
    set.path = committed.path;
    set.sourceBlobSha = committed.sourceBlobSha;
  }
  const result = await SavedConsole.updateOne(
    {
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    },
    { $set: set, $unset: { deletedAt: "" } },
  );
  return result.modifiedCount > 0;
}

/**
 * Duplicate a console: creates a copy with " copy" appended to the name.
 */
export async function duplicateConsole(
  consoleId: string,
  workspaceId: string,
  userId: string,
): Promise<ISavedConsole | null> {
  if (!Types.ObjectId.isValid(consoleId)) return null;
  const original = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!original) return null;

  const copy = new SavedConsole({
    workspaceId: original.workspaceId,
    folderId: original.folderId,
    connectionId: original.connectionId,
    databaseName: original.databaseName,
    databaseId: original.databaseId,
    name: `${original.name} copy`,
    description: original.description,
    code: original.code,
    language: original.language,
    mongoOptions: original.mongoOptions,
    createdBy: userId,
    isPrivate: true,
    isSaved: true,
    access: "private" as const,
    owner_id: userId,
    executionCount: 0,
  });
  const committed = await commitConsoleState({
    row: copy,
    actorUserId: userId,
    message: `duplicate: ${original.name}`,
  });
  copy.path = committed.path;
  copy.sourceBlobSha = committed.sourceBlobSha;
  await copy.save();
  return copy;
}

/**
 * Get console by path - returns the full console document
 * Used for conflict detection when saving
 */
export async function getConsoleByPath(
  consolePath: string,
  workspaceId: string,
): Promise<ISavedConsole | null> {
  try {
    const parts = consolePath.split("/");
    const consoleName = parts[parts.length - 1];

    // Get folder ID if there's a folder path
    let folderId: string | undefined;
    const hasFolder = parts.length > 1;
    if (hasFolder) {
      const folderParts = parts.slice(0, -1);
      folderId = await findFolderByPath(folderParts, workspaceId);

      // If path specifies a folder but it doesn't exist, no console can exist at this path
      if (!folderId) {
        return null;
      }
    }

    // Build query for console with same name in same folder (or root if no folder)
    // Only match explicitly saved consoles (isSaved: true) - not drafts
    const query: Record<string, unknown> = {
      name: consoleName,
      workspaceId: new Types.ObjectId(workspaceId),
      isSaved: true, // Only match saved consoles, not drafts
    };

    if (folderId) {
      query.folderId = new Types.ObjectId(folderId);
    } else {
      // For root level consoles (hasFolder is false), check that folderId is null/undefined
      query.$or = [{ folderId: null }, { folderId: { $exists: false } }];
    }

    // Sort by updatedAt descending to get the most recently updated console
    // in case there are duplicate entries
    return await SavedConsole.findOne(query).sort({ updatedAt: -1 });
  } catch (error) {
    logger.error("Error getting console by path", { error });
    return null;
  }
}

/**
 * Record external (API key / MCP) use of a console.
 *
 * - `execute`: bumps lastExternalUsedAt, externalUseCount, lastExternalSource
 * - `access`: bumps lastExternalUsedAt / lastExternalSource only, throttled
 *   to at most once per minute (reads/list details should not write-amplify)
 */
export async function recordConsoleExternalUse(
  consoleId: string,
  workspaceId: string,
  source: "api" | "mcp",
  mode: "execute" | "access" = "execute",
): Promise<void> {
  if (!Types.ObjectId.isValid(consoleId)) return;
  try {
    const now = new Date();
    const filter: Record<string, unknown> = {
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
    };

    if (mode === "access") {
      // Throttle access bumps so chatty MCP/API clients don't hammer writes.
      filter.$or = [
        { lastExternalUsedAt: { $exists: false } },
        { lastExternalUsedAt: null },
        {
          lastExternalUsedAt: {
            $lte: new Date(now.getTime() - 60_000),
          },
        },
      ];
      await SavedConsole.updateOne(filter, {
        $set: {
          lastExternalUsedAt: now,
          lastExternalSource: source,
        },
      });
      return;
    }

    await SavedConsole.updateOne(filter, {
      $set: {
        lastExternalUsedAt: now,
        lastExternalSource: source,
      },
      $inc: { externalUseCount: 1 },
    });
  } catch (error) {
    if (error instanceof RepoRequiredError) throw error;
    logger.error("Error recording external console use", {
      error,
      consoleId,
      workspaceId,
      source,
      mode,
    });
  }
}

/**
 * Detect language from content
 */
function detectConsoleLanguage(
  content: string,
): "sql" | "javascript" | "mongodb" {
  const lowerContent = content.toLowerCase().trim();

  // Check for MongoDB patterns
  if (
    lowerContent.includes("db.") ||
    lowerContent.includes("collection.") ||
    lowerContent.includes("aggregate(") ||
    lowerContent.includes("find(")
  ) {
    return "mongodb";
  }

  // Check for SQL patterns
  if (
    lowerContent.includes("select ") ||
    lowerContent.includes("insert ") ||
    lowerContent.includes("update ") ||
    lowerContent.includes("delete ") ||
    lowerContent.includes("create ") ||
    lowerContent.includes("alter ")
  ) {
    return "sql";
  }

  // Default to javascript
  return "javascript";
}
