/**
 * Console mutations (git first, apps.md §16.3: the file is the record, the
 * row follows): save, rename, move, change access, soft delete / restore,
 * duplicate — plus the path lookup used for save conflicts and external-use
 * telemetry.
 */
import { Types } from "mongoose";
import type { ConsoleAccessLevel } from "../../database/workspace-schema";
import {
  consolesChartsRepo,
  type SavedConsoleRecord,
  type UpdateConsolePatch,
} from "../../repositories/consoles-charts";
import { getLogger } from "../../logging";
import {
  commitConsoleRemoval,
  commitConsoleState,
} from "../../apps/workspace-consoles.service";
import { RepoRequiredError } from "../../apps/config";
import { canReadConsoleWithInheritance, canWriteConsole } from "./access";
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
): Promise<SavedConsoleRecord> {
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
    let savedConsole: SavedConsoleRecord | null = null;

    if (options?.id && Types.ObjectId.isValid(options.id)) {
      // ID-based lookup (used by POST route and conflict resolution)
      savedConsole = await consolesChartsRepo.findConsoleById(
        workspaceId,
        options.id,
      );
    }

    // Fallback: look up by name + folder for path-based PUT requests
    // Only match saved consoles (isSaved: true), not drafts
    if (!savedConsole) {
      savedConsole = await consolesChartsRepo.findConsoleByNameAndFolder(
        workspaceId,
        consoleName,
        folderId ?? null,
        { isSavedOnly: true },
      );
    }

    const requestedAccess =
      options?.access ??
      (options?.isPrivate === undefined
        ? undefined
        : options.isPrivate
          ? "private"
          : "workspace");

    if (savedConsole) {
      const nextAccess =
        requestedAccess ??
        savedConsole.access ??
        (savedConsole.isPrivate ? "private" : "workspace");
      const nextOwner = savedConsole.owner_id || savedConsole.createdBy;
      const desired: SavedConsoleRecord = {
        ...savedConsole,
        name: consoleName,
        folderId: folderId || undefined,
        code: content,
        isSaved: true,
        updatedAt: new Date(),
        connectionId:
          connectionId !== undefined
            ? connectionId || undefined
            : savedConsole.connectionId,
        databaseName:
          databaseName !== undefined ? databaseName : savedConsole.databaseName,
        databaseId:
          databaseId !== undefined ? databaseId : savedConsole.databaseId,
        description:
          options?.description !== undefined
            ? options.description
            : savedConsole.description,
        language: options?.language ?? savedConsole.language,
        access: nextAccess,
        isPrivate: nextAccess === "private",
        owner_id: nextOwner,
      };

      // Git first (apps.md §16.3): the file is the record, the row follows.
      const committed = await commitConsoleState({
        row: desired,
        previousPath: savedConsole.path,
        actorUserId: userId,
        message: `save: ${consolePath}`,
      });

      const patch: UpdateConsolePatch = {
        name: desired.name,
        folderId: folderId ?? null,
        code: desired.code,
        isSaved: true,
        updatedAt: desired.updatedAt,
        access: desired.access,
        isPrivate: desired.isPrivate,
        owner_id: nextOwner,
        path: committed.path,
        sourceBlobSha: committed.sourceBlobSha,
      };
      if (connectionId !== undefined) patch.connectionId = connectionId || null;
      if (databaseName !== undefined) patch.databaseName = databaseName;
      if (databaseId !== undefined) patch.databaseId = databaseId;
      if (options?.description !== undefined) {
        patch.description = options.description;
      }
      if (options?.language) patch.language = options.language;

      const updated = await consolesChartsRepo.updateConsole(
        workspaceId,
        savedConsole.id,
        patch,
      );
      return (
        updated ?? {
          ...desired,
          path: committed.path,
          sourceBlobSha: committed.sourceBlobSha,
        }
      );
    }

    // Create new console (explicitly saved)
    const access =
      options?.access ?? (options?.isPrivate ? "private" : "workspace");
    const isPrivate = access === "private";
    const language = options?.language || detectConsoleLanguage(content);
    const id =
      options?.id && Types.ObjectId.isValid(options.id)
        ? options.id
        : new Types.ObjectId().toString();
    const draftRow = {
      workspaceId,
      folderId: folderId || undefined,
      connectionId: connectionId || undefined,
      databaseName,
      databaseId,
      name: consoleName,
      description: options?.description || "",
      code: content,
      language,
      createdBy: userId,
      isPrivate,
      access,
      owner_id: userId,
    };

    const committed = await commitConsoleState({
      row: draftRow,
      actorUserId: userId,
      message: `create: ${consolePath}`,
    });

    return await consolesChartsRepo.createConsole({
      id,
      workspaceId,
      folderId: folderId ?? null,
      connectionId: connectionId ?? null,
      databaseName,
      databaseId,
      name: consoleName,
      description: options?.description || "",
      code: content,
      language,
      createdBy: userId,
      isPrivate,
      isSaved: true,
      executionCount: 0,
      access,
      owner_id: userId,
      path: committed.path,
      sourceBlobSha: committed.sourceBlobSha,
    });
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

    const patch: UpdateConsolePatch = {
      name: consoleName,
      updatedAt: new Date(),
    };

    // Update folderId if we have a folder path
    if (parts.length > 1) {
      patch.folderId = folderId ?? null;
    }

    const current = await consolesChartsRepo.findConsoleById(
      workspaceId,
      consoleId,
    );
    if (!current) return false;
    if (current.isSaved) {
      const nextRow: SavedConsoleRecord = {
        ...current,
        name: consoleName,
        ...(parts.length > 1 ? { folderId: folderId || undefined } : {}),
      };
      const committed = await commitConsoleState({
        row: nextRow,
        previousPath: current.path,
        actorUserId: userId,
        message: `rename: ${consoleName}`,
      });
      patch.path = committed.path;
      patch.sourceBlobSha = committed.sourceBlobSha;
    }

    const updated = await consolesChartsRepo.updateConsole(
      workspaceId,
      consoleId,
      patch,
    );
    return updated !== null;
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
  if (!Types.ObjectId.isValid(consoleId)) return false;

  const patch: UpdateConsolePatch = {
    folderId: folderId ?? null,
    updatedAt: new Date(),
  };

  if (access) {
    patch.access = access;
    patch.isPrivate = access === "private";
  }

  const current = await consolesChartsRepo.findConsoleById(
    workspaceId,
    consoleId,
  );
  if (!current) return false;
  if (current.isSaved) {
    const nextRow: SavedConsoleRecord = {
      ...current,
      folderId: folderId || undefined,
      ...(access ? { access, isPrivate: access === "private" } : {}),
    };
    const committed = await commitConsoleState({
      row: nextRow,
      previousPath: current.path,
      actorUserId: userId,
      message: `move: ${current.name}`,
    });
    patch.path = committed.path;
    patch.sourceBlobSha = committed.sourceBlobSha;
  }

  const updated = await consolesChartsRepo.updateConsole(
    workspaceId,
    consoleId,
    patch,
  );
  return updated !== null;
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
): Promise<SavedConsoleRecord | null> {
  try {
    const savedConsole = await consolesChartsRepo.findConsoleById(
      workspaceId,
      consoleId,
    );

    if (!savedConsole) return null;

    const ownerId = (
      savedConsole.owner_id || savedConsole.createdBy
    )?.toString();
    if (ownerId !== userId) return null;

    const patch: UpdateConsolePatch = {
      access,
      isPrivate: access === "private",
      updatedAt: new Date(),
    };
    if (savedConsole.isSaved) {
      const nextRow: SavedConsoleRecord = {
        ...savedConsole,
        access,
        isPrivate: access === "private",
      };
      const committed = await commitConsoleState({
        row: nextRow,
        previousPath: savedConsole.path,
        actorUserId: userId,
        message: `access ${access}: ${savedConsole.name}`,
      });
      patch.path = committed.path;
      patch.sourceBlobSha = committed.sourceBlobSha;
    }
    return await consolesChartsRepo.updateConsole(
      workspaceId,
      consoleId,
      patch,
    );
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
  const current = await consolesChartsRepo.findConsoleById(
    workspaceId,
    consoleId,
  );
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
  return await consolesChartsRepo.softDeleteConsole(workspaceId, consoleId);
}

/**
 * Restore a soft-deleted console.
 */
export async function restoreConsole(
  consoleId: string,
  workspaceId: string,
  userId?: string,
  memberRole?: string,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(consoleId)) return false;
  const current = await consolesChartsRepo.findConsoleById(
    workspaceId,
    consoleId,
  );
  if (!current) return false;
  // A console the caller cannot write is "not found", not restorable.
  if (userId && !canWriteConsole(current, userId, memberRole)) return false;
  const patch: { path?: string; sourceBlobSha?: string } = {};
  if (current.isSaved) {
    const committed = await commitConsoleState({
      row: current,
      actorUserId: userId,
      message: `restore: ${current.name}`,
    });
    patch.path = committed.path;
    patch.sourceBlobSha = committed.sourceBlobSha;
  }
  return await consolesChartsRepo.restoreConsole(workspaceId, consoleId, patch);
}

/**
 * Duplicate a console: creates a copy with " copy" appended to the name.
 */
export async function duplicateConsole(
  consoleId: string,
  workspaceId: string,
  userId: string,
): Promise<SavedConsoleRecord | null> {
  if (!Types.ObjectId.isValid(consoleId)) return null;
  const original = await consolesChartsRepo.findConsoleById(
    workspaceId,
    consoleId,
  );
  if (!original) return null;
  // Same read rule as execute and export: a console the caller cannot read
  // (private, or in a folder they cannot see) is "not found", not copyable.
  if (!(await canReadConsoleWithInheritance(original, userId))) return null;

  const copyDraft = {
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
    access: "private" as const,
    owner_id: userId,
  };
  const committed = await commitConsoleState({
    row: copyDraft,
    actorUserId: userId,
    message: `duplicate: ${original.name}`,
  });
  return await consolesChartsRepo.createConsole({
    ...copyDraft,
    isSaved: true,
    executionCount: 0,
    path: committed.path,
    sourceBlobSha: committed.sourceBlobSha,
  });
}

/**
 * Get console by path - returns the full console document
 * Used for conflict detection when saving
 */
export async function getConsoleByPath(
  consolePath: string,
  workspaceId: string,
): Promise<SavedConsoleRecord | null> {
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

    // Only match explicitly saved consoles (isSaved: true) - not drafts.
    // Sorted by updatedAt descending to pick the most recently updated console.
    return await consolesChartsRepo.findConsoleByNameAndFolder(
      workspaceId,
      consoleName,
      folderId ?? null,
      { isSavedOnly: true },
    );
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
    await consolesChartsRepo.recordConsoleExternalUse(
      workspaceId,
      consoleId,
      source,
      mode,
    );
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
