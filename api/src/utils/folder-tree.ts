/**
 * Folder-tree mechanics shared by every foldered resource (dashboards,
 * notebooks, consoles). These were copied into each manager: the cycle
 * check was byte-identical modulo the folder model, and the "folders first,
 * then alphabetical" sort existed three times.
 */
import { Types, type Model } from "mongoose";

interface FolderLike {
  _id: Types.ObjectId;
  parentId?: Types.ObjectId | null;
}

/**
 * Would making `folderId` a child of `targetParentId` create a cycle?
 * Walks up from the target through the workspace's folders.
 */
export async function wouldCreateFolderCycle<T extends FolderLike>(
  folderModel: Model<T>,
  folderId: string,
  targetParentId: string | null,
  workspaceId: string,
): Promise<boolean> {
  if (!targetParentId) return false;
  if (folderId === targetParentId) return true;

  const folders = await folderModel
    .find({ workspaceId: new Types.ObjectId(workspaceId) })
    .lean();

  const parentMap = new Map<string, string | undefined>();
  for (const f of folders as unknown as FolderLike[]) {
    parentMap.set(f._id.toString(), f.parentId?.toString());
  }

  let current: string | undefined = targetParentId;
  const visited = new Set<string>();
  while (current) {
    if (current === folderId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    current = parentMap.get(current);
  }
  return false;
}

/**
 * Every folder id under `folderId` (not including it), breadth-first.
 * Used to cascade folder deletion; one query per level, cycle-safe.
 */
export async function collectDescendantFolderIds<T extends FolderLike>(
  folderModel: Model<T>,
  workspaceId: Types.ObjectId,
  folderId: Types.ObjectId,
): Promise<Types.ObjectId[]> {
  const out: Types.ObjectId[] = [];
  const seen = new Set<string>([folderId.toString()]);
  let frontier = [folderId];
  while (frontier.length > 0) {
    const children = (await folderModel
      .find({ workspaceId, parentId: { $in: frontier } })
      .select("_id")
      .lean()) as unknown as { _id: Types.ObjectId }[];
    frontier = [];
    for (const child of children) {
      const key = child._id.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(child._id);
      frontier.push(child._id);
    }
  }
  return out;
}

interface TreeNodeLike {
  name: string;
  isDirectory: boolean;
  children?: TreeNodeLike[];
}

/** Folders before files, then by name — recursively, in place. */
export function sortTreeNodes<T extends TreeNodeLike>(nodes: T[]): T[] {
  nodes.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      sortTreeNodes(node.children as T[]);
    }
  }
  return nodes;
}
