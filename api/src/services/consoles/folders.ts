/**
 * Console folders: create / rename / move / delete, the path ↔ folder-chain
 * lookups saves and renames use, and re-projecting every console under a
 * folder when the folder's place in the repo changes (apps.md §16.2).
 */
import { Types } from "mongoose";
import type { ConsoleAccessLevel } from "../../database/workspace-schema";
import {
  consolesChartsRepo,
  type ConsoleFolderRecord,
  type SavedConsoleRecord,
} from "../../repositories/consoles-charts";
import { getLogger } from "../../logging";
import { FolderChainCache } from "../../utils/folder-chain";
import { canWriteResource } from "../../utils/resource-acl";
import {
  commitConsoleBatch,
  commitConsoleMoves,
} from "../../apps/workspace-consoles.service";
import { chartSidecarPath } from "../../apps/console-files";
import { RepoRequiredError } from "../../apps/config";
import { legacyAccess } from "./access";

const logger = getLogger(["api", "consoles"]);

/**
 * Get folder path by folder ID (for building console paths). Workspace
 * scoped and cycle-safe (see FolderChainCache).
 */
export async function getFolderPathById(
  folderId: string,
  workspaceId: string,
  folders: FolderChainCache = FolderChainCache.forWorkspace(workspaceId),
): Promise<string | null> {
  try {
    const chain = await folders.chainOf(folderId);
    if (chain.length === 0) return null;
    return chain
      .map(folder => folder.name)
      .reverse()
      .join("/");
  } catch (error) {
    logger.error("Error getting folder path", { error, folderId });
    return null;
  }
}

/**
 * Create a new folder in the database
 */
export async function createConsoleFolder(
  folderName: string,
  workspaceId: string,
  userId: string,
  parentId?: string,
  access: ConsoleAccessLevel = "private",
): Promise<ConsoleFolderRecord> {
  // Inherit access from parent folder if creating a subfolder
  let resolvedAccess = access;
  if (parentId) {
    const parentFolder = await consolesChartsRepo.findConsoleFolderById(
      workspaceId,
      parentId,
    );
    // Inherit workspace access from parent
    if (parentFolder && legacyAccess(parentFolder) === "workspace") {
      resolvedAccess = "workspace";
    }
  }

  return consolesChartsRepo.createConsoleFolder({
    workspaceId,
    name: folderName,
    parentId: parentId ?? null,
    isPrivate: resolvedAccess === "private",
    ownerId: userId,
    access: resolvedAccess,
  });
}

/**
 * Rename a folder in the database
 */
export async function renameConsoleFolder(
  folderId: string,
  newName: string,
  workspaceId: string,
  userId?: string,
): Promise<boolean> {
  try {
    const folder = await consolesChartsRepo.findConsoleFolderById(
      workspaceId,
      folderId,
    );
    if (!folder) return false;
    const previousName = folder.name;
    await consolesChartsRepo.updateConsoleFolder(workspaceId, folderId, {
      name: newName,
    });
    try {
      await reprojectFolderSubtree(
        folderId,
        workspaceId,
        userId,
        `rename folder: ${previousName} → ${newName}`,
      );
    } catch (error) {
      await consolesChartsRepo.updateConsoleFolder(workspaceId, folderId, {
        name: previousName,
      });
      throw error;
    }
    return true;
  } catch (error) {
    if (error instanceof RepoRequiredError) throw error;
    logger.error("Error renaming folder", { error });
    return false;
  }
}

/**
 * Every saved console under a folder (recursively), for git moves when the
 * folder itself renames, moves, or changes access.
 */
async function consolesUnderFolder(
  folderId: string,
  workspaceId: string,
): Promise<SavedConsoleRecord[]> {
  const out: SavedConsoleRecord[] = [];
  const queue = [folderId];
  const seen = new Set<string>();
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(
      ...(await consolesChartsRepo.listConsolesByWorkspace(workspaceId, {
        folderId: id,
        isSaved: true,
        excludeDeleted: true,
      })),
    );
    const children = await consolesChartsRepo.listChildConsoleFolders(
      workspaceId,
      id,
    );
    queue.push(...children.map(c => c.id));
  }
  return out;
}

/** Re-commit every console under a folder at its (possibly new) path. */
async function reprojectFolderSubtree(
  folderId: string,
  workspaceId: string,
  userId: string | undefined,
  message: string,
): Promise<void> {
  const rows = await consolesUnderFolder(folderId, workspaceId);
  if (rows.length === 0) return;
  const moved = await commitConsoleMoves({
    workspaceId,
    actorUserId: userId,
    message,
    rows: rows.map(row => ({
      id: row.id,
      row,
      previousPath: row.path,
    })),
  });
  for (const row of rows) {
    const at = moved.paths.get(row.id);
    if (
      !at ||
      (at.path === row.path && at.sourceBlobSha === row.sourceBlobSha)
    ) {
      continue;
    }
    await consolesChartsRepo.updateConsole(workspaceId, row.id, {
      path: at.path,
      sourceBlobSha: at.sourceBlobSha,
    });
  }
}

/**
 * Delete a folder from database
 */
export async function deleteConsoleFolder(
  folderId: string,
  workspaceId: string,
  userId?: string,
): Promise<boolean> {
  try {
    // Git first: every file under the folder goes in one commit.
    const rows = await consolesUnderFolder(folderId, workspaceId);
    const paths = rows.map(r => r.path).filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      await commitConsoleBatch({
        workspaceId,
        actorUserId: userId,
        mutation: {
          deletes: paths.flatMap(p => [p, chartSidecarPath(p)]),
        },
        message: `delete folder (${paths.length} console${paths.length === 1 ? "" : "s"})`,
      });
    }
    // Delete all consoles in the folder
    await consolesChartsRepo.deleteConsolesInFolder(workspaceId, folderId);

    // Delete all child folders recursively
    const childFolders = await consolesChartsRepo.listChildConsoleFolders(
      workspaceId,
      folderId,
    );

    for (const childFolder of childFolders) {
      await deleteConsoleFolder(childFolder.id, workspaceId);
    }

    // Delete the folder itself
    return await consolesChartsRepo.deleteConsoleFolder(workspaceId, folderId);
  } catch (error) {
    if (error instanceof RepoRequiredError) throw error;
    logger.error("Error deleting folder", { error });
    return false;
  }
}

/**
 * Ensure folder path exists, creating folders as needed
 * Returns the ID of the deepest folder in the path
 */
export async function ensureConsoleFolderPath(
  folderParts: string[],
  workspaceId: string,
  userId: string,
): Promise<string | undefined> {
  if (folderParts.length === 0) {
    return undefined;
  }

  let currentParentId: string | undefined = undefined;

  for (const folderName of folderParts) {
    // Check if folder exists at this level
    let folder: ConsoleFolderRecord | null =
      await consolesChartsRepo.findConsoleFolderByNameAndParent(
        workspaceId,
        folderName,
        currentParentId ?? null,
      );

    if (!folder) {
      // Create the folder if it doesn't exist
      folder = await createConsoleFolder(
        folderName,
        workspaceId,
        userId,
        currentParentId,
      );
    }

    currentParentId = folder.id;
  }

  return currentParentId;
}

/**
 * Find folder by path parts
 * Returns the folder ID if found, undefined otherwise
 */
export async function findFolderByPath(
  folderParts: string[],
  workspaceId: string,
): Promise<string | undefined> {
  if (folderParts.length === 0) {
    return undefined;
  }

  let currentParentId: string | undefined = undefined;

  for (const folderName of folderParts) {
    const folder = await consolesChartsRepo.findConsoleFolderByNameAndParent(
      workspaceId,
      folderName,
      currentParentId ?? null,
    );

    if (!folder) {
      return undefined;
    }

    currentParentId = folder.id;
  }

  return currentParentId;
}

/**
 * Move a folder to a different parent folder (or root if parentId is null).
 * Prevents circular nesting.
 */
export async function moveConsoleFolder(
  folderId: string,
  workspaceId: string,
  newParentId: string | null,
  access?: ConsoleAccessLevel,
  userId?: string,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(folderId)) return false;

  // Prevent moving folder into itself or a descendant
  if (newParentId === folderId) return false;
  if (
    newParentId &&
    (await consolesChartsRepo.wouldCreateConsoleFolderCycle(
      workspaceId,
      folderId,
      newParentId,
    ))
  ) {
    return false;
  }

  const before = await consolesChartsRepo.findConsoleFolderById(
    workspaceId,
    folderId,
  );
  if (!before) return false;

  const updated = await consolesChartsRepo.updateConsoleFolder(
    workspaceId,
    folderId,
    {
      parentId: newParentId ?? null,
      ...(access ? { access, isPrivate: access === "private" } : {}),
    },
  );
  if (!updated) return false;

  try {
    if (access) {
      // A folder's access moves its consoles between the workspace and
      // the owner's private root (apps.md §16.2).
      await consolesChartsRepo.updateConsolesInFolder(workspaceId, folderId, {
        access,
        isPrivate: access === "private",
      });
    }
    await reprojectFolderSubtree(
      folderId,
      workspaceId,
      userId,
      `move folder: ${before.name}`,
    );
  } catch (error) {
    await consolesChartsRepo.updateConsoleFolder(workspaceId, folderId, {
      parentId: before.parentId ?? null,
      access: before.access,
      isPrivate: before.isPrivate,
    });
    throw error;
  }
  return true;
}

/**
 * Why the caller may not write (rename / move / delete) a console folder,
 * or null when they may: the shared resource ACL over the folder's owner
 * and its (legacy-aware) access level.
 */
export async function consoleFolderWriteRefusal(
  ctx: { workspaceId: string; userId: string; role: string | undefined },
  folderId: string,
): Promise<{ ok: false; status: 403 | 404; error: string } | null> {
  const folder = await consolesChartsRepo.findConsoleFolderById(
    ctx.workspaceId,
    folderId,
  );
  if (!folder) return { ok: false, status: 404, error: "Folder not found" };
  const access = legacyAccess(folder);
  const allowed = canWriteResource(
    { owner_id: folder.ownerId?.toString(), access },
    ctx.userId,
    ctx.role,
    { effectiveAccess: access },
  );
  return allowed ? null : { ok: false, status: 403, error: "Access denied" };
}
