/**
 * Console folders: create / rename / move / delete, the path ↔ folder-chain
 * lookups saves and renames use, and re-projecting every console under a
 * folder when the folder's place in the repo changes (apps.md §16.2).
 */
import { Types } from "mongoose";
import {
  ConsoleFolder,
  SavedConsole,
  type ConsoleAccessLevel,
  type IConsoleFolder,
  type ISavedConsole,
} from "../../database/workspace-schema";
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
): Promise<IConsoleFolder> {
  // Inherit access from parent folder if creating a subfolder
  let resolvedAccess = access;
  if (parentId) {
    const parentFolder = (await ConsoleFolder.findById(parentId)
      .select("access isPrivate")
      .lean()) as {
      access?: ConsoleAccessLevel;
      isPrivate?: boolean;
    } | null;
    // Inherit workspace access from parent
    if (parentFolder && legacyAccess(parentFolder) === "workspace") {
      resolvedAccess = "workspace";
    }
  }

  const folder = new ConsoleFolder({
    workspaceId: new Types.ObjectId(workspaceId),
    name: folderName,
    parentId: parentId ? new Types.ObjectId(parentId) : undefined,
    isPrivate: resolvedAccess === "private",
    ownerId: userId,
    access: resolvedAccess,
  });

  return await folder.save();
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
    const folder = await ConsoleFolder.findOne({
      _id: new Types.ObjectId(folderId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!folder) return false;
    const previousName = folder.name;
    folder.name = newName;
    await folder.save();
    try {
      await reprojectFolderSubtree(
        folderId,
        workspaceId,
        userId,
        `rename folder: ${previousName} → ${newName}`,
      );
    } catch (error) {
      folder.name = previousName;
      await folder.save();
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
): Promise<ISavedConsole[]> {
  const wid = new Types.ObjectId(workspaceId);
  const out: ISavedConsole[] = [];
  const queue = [folderId];
  const seen = new Set<string>();
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const fid = new Types.ObjectId(id);
    out.push(
      ...(await SavedConsole.find({
        workspaceId: wid,
        folderId: fid,
        isSaved: true,
        $or: [
          { is_deleted: { $ne: true } },
          { is_deleted: { $exists: false } },
        ],
      })),
    );
    const children = await ConsoleFolder.find({
      workspaceId: wid,
      parentId: fid,
    }).select("_id");
    queue.push(...children.map(c => c._id.toString()));
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
      id: row._id.toString(),
      row,
      previousPath: row.path,
    })),
  });
  for (const row of rows) {
    const at = moved.paths.get(row._id.toString());
    if (
      !at ||
      (at.path === row.path && at.sourceBlobSha === row.sourceBlobSha)
    ) {
      continue;
    }
    await SavedConsole.updateOne(
      { _id: row._id },
      { $set: { path: at.path, sourceBlobSha: at.sourceBlobSha } },
    );
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
    await SavedConsole.deleteMany({
      folderId: new Types.ObjectId(folderId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    // Delete all child folders recursively
    const childFolders = await ConsoleFolder.find({
      parentId: new Types.ObjectId(folderId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    for (const childFolder of childFolders) {
      await deleteConsoleFolder(childFolder._id.toString(), workspaceId);
    }

    // Delete the folder itself
    const result = await ConsoleFolder.deleteOne({
      _id: new Types.ObjectId(folderId),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    return result.deletedCount > 0;
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
    let folder: IConsoleFolder | null = await ConsoleFolder.findOne({
      name: folderName,
      workspaceId: new Types.ObjectId(workspaceId),
      parentId: currentParentId
        ? new Types.ObjectId(currentParentId)
        : undefined,
    });

    if (!folder) {
      // Create the folder if it doesn't exist
      folder = await createConsoleFolder(
        folderName,
        workspaceId,
        userId,
        currentParentId,
      );
    }

    currentParentId = folder._id.toString();
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
    const folder: IConsoleFolder | null = await ConsoleFolder.findOne({
      name: folderName,
      workspaceId: new Types.ObjectId(workspaceId),
      parentId: currentParentId
        ? new Types.ObjectId(currentParentId)
        : undefined,
    });

    if (!folder) {
      return undefined;
    }

    currentParentId = folder._id.toString();
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

  // Prevent moving folder into itself
  if (newParentId === folderId) return false;

  // Prevent circular nesting: walk up from newParentId to ensure folderId is not an ancestor
  if (newParentId) {
    let currentId: string | null = newParentId;
    while (currentId) {
      if (currentId === folderId) return false;
      const parent: { parentId?: Types.ObjectId } | null =
        await ConsoleFolder.findById(currentId).select("parentId").lean();
      currentId = parent?.parentId?.toString() || null;
    }
  }

  const updateFields: Record<string, unknown> = {};
  if (newParentId) {
    updateFields.parentId = new Types.ObjectId(newParentId);
  } else {
    updateFields.parentId = null;
  }

  if (access) {
    updateFields.access = access;
    updateFields.isPrivate = access === "private";
  }

  const before = await ConsoleFolder.findOne({
    _id: new Types.ObjectId(folderId),
    workspaceId: new Types.ObjectId(workspaceId),
  }).lean();
  if (!before) return false;

  const result = await ConsoleFolder.updateOne(
    {
      _id: new Types.ObjectId(folderId),
      workspaceId: new Types.ObjectId(workspaceId),
    },
    { $set: updateFields },
  );
  if (result.modifiedCount === 0) return false;

  try {
    if (access) {
      // A folder's access moves its consoles between the workspace and
      // the owner's private root (apps.md §16.2).
      await SavedConsole.updateMany(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          folderId: new Types.ObjectId(folderId),
        },
        { $set: { access, isPrivate: access === "private" } },
      );
    }
    await reprojectFolderSubtree(
      folderId,
      workspaceId,
      userId,
      `move folder: ${before.name}`,
    );
  } catch (error) {
    await ConsoleFolder.updateOne(
      { _id: new Types.ObjectId(folderId) },
      {
        $set: {
          parentId: before.parentId ?? null,
          access: before.access,
          isPrivate: before.isPrivate,
        },
      },
    );
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
  const folder = await ConsoleFolder.findOne({
    _id: new Types.ObjectId(folderId),
    workspaceId: new Types.ObjectId(ctx.workspaceId),
  }).lean();
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
