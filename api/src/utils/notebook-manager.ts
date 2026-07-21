import { Types } from "mongoose";

import {
  NotebookFolder,
  NotebookIndex,
  type INotebookFolder,
  type INotebookIndex,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  canReadResource,
  canWriteResource,
  type ShareableResourceLike,
} from "./resource-acl";
import { syncNotebookIndexFromStore } from "../services/notebook-index.service";

const logger = loggers.api("notebook-manager");

export type NotebookAccessLevel = "private" | "workspace";

export interface NotebookTreeNode {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  children?: NotebookTreeNode[];
  access?: NotebookAccessLevel;
  owner_id?: string;
  readOnly?: boolean;
  updatedAt?: string;
}

function indexAsResource(index: INotebookIndex): ShareableResourceLike {
  return {
    owner_id: index.ownerId,
    access: index.access,
    sharedWith: index.sharedWith,
  };
}

/**
 * Centralized permission + tree logic for notebooks (mirrors DashboardManager).
 */
export class NotebookManager {
  static isOwner(index: INotebookIndex, userId: string): boolean {
    return index.ownerId === userId;
  }

  static isCollaborator(index: INotebookIndex, userId: string): boolean {
    return (index.sharedWith || []).some(s => s.userId === userId);
  }

  static canRead(
    index: INotebookIndex,
    userId: string,
    memberRole?: string,
    effectiveAccess?: NotebookAccessLevel,
  ): boolean {
    return canReadResource(indexAsResource(index), userId, memberRole, {
      effectiveAccess,
    });
  }

  static canWrite(
    index: INotebookIndex,
    userId: string,
    isAdmin: boolean = false,
    memberRole?: string,
    effectiveAccess?: NotebookAccessLevel,
  ): boolean {
    return canWriteResource(
      indexAsResource(index),
      userId,
      memberRole ?? (isAdmin ? "admin" : undefined),
      { effectiveAccess },
    );
  }

  static canReadFolder(
    folder: INotebookFolder,
    userId: string,
    memberRole?: string,
    effectiveAccess?: NotebookAccessLevel,
  ): boolean {
    return canReadResource(
      {
        owner_id: folder.ownerId,
        access: folder.access,
      },
      userId,
      memberRole,
      { effectiveAccess },
    );
  }

  static canWriteFolder(
    folder: INotebookFolder,
    userId: string,
    isAdmin: boolean = false,
    memberRole?: string,
    effectiveAccess?: NotebookAccessLevel,
  ): boolean {
    return canWriteResource(
      {
        owner_id: folder.ownerId,
        access: folder.access,
      },
      userId,
      memberRole ?? (isAdmin ? "admin" : undefined),
      { effectiveAccess },
    );
  }

  private static getFolderPath(
    folderId: string,
    folderMap: Map<string, NotebookTreeNode>,
  ): string {
    const folder = folderMap.get(folderId);
    if (!folder) return "";
    return folder.path;
  }

  static buildTree(
    folders: INotebookFolder[],
    notebooks: INotebookIndex[],
    userId?: string,
    isAdmin: boolean = false,
    memberRole?: string,
    folderById?: Map<string, INotebookFolder>,
  ): NotebookTreeNode[] {
    const folderMap = new Map<string, NotebookTreeNode>();
    const rootItems: NotebookTreeNode[] = [];

    for (const folder of folders) {
      const folderItem: NotebookTreeNode = {
        path: folder.name,
        name: folder.name,
        isDirectory: true,
        children: [],
        id: folder._id.toString(),
        owner_id: folder.ownerId,
        access: folder.access || "private",
        updatedAt: folder.createdAt?.toISOString(),
      };
      folderMap.set(folder._id.toString(), folderItem);
      if (!folder.parentId) {
        rootItems.push(folderItem);
      }
    }

    for (const folder of folders) {
      if (folder.parentId) {
        const parent = folderMap.get(folder.parentId.toString());
        const child = folderMap.get(folder._id.toString());
        if (parent && child && parent.children) {
          parent.children.push(child);
          child.path = `${parent.path}/${child.name}`;
        }
      }
    }

    for (const notebook of notebooks) {
      const folderId = notebook.folderId?.toString();
      const effectiveAccess = folderById
        ? NotebookManager.effectiveAccessForItem(
            notebook.access || "private",
            notebook.folderId,
            folderById,
          )
        : notebook.access || "private";

      const notebookItem: NotebookTreeNode = {
        path: folderId
          ? `${NotebookManager.getFolderPath(folderId, folderMap)}/${notebook.name}`
          : notebook.name,
        name: notebook.name,
        isDirectory: false,
        id: notebook.notebookId,
        access: notebook.access,
        owner_id: notebook.ownerId,
        readOnly: userId
          ? !NotebookManager.canWrite(
              notebook,
              userId,
              isAdmin,
              memberRole,
              effectiveAccess,
            )
          : undefined,
        updatedAt: notebook.updatedAt?.toISOString(),
      };

      if (folderId) {
        const folder = folderMap.get(folderId);
        if (folder && folder.children) {
          folder.children.push(notebookItem);
        } else {
          rootItems.push(notebookItem);
        }
      } else {
        rootItems.push(notebookItem);
      }
    }

    const sortNodes = (nodes: NotebookTreeNode[]) => {
      nodes.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
      for (const node of nodes) {
        if (node.isDirectory && node.children) {
          sortNodes(node.children);
        }
      }
    };
    sortNodes(rootItems);

    return rootItems;
  }

  static effectiveAccessForItem(
    ownAccess: NotebookAccessLevel,
    folderId: Types.ObjectId | undefined,
    folderById: Map<string, INotebookFolder>,
  ): NotebookAccessLevel {
    if (ownAccess === "workspace") return "workspace";
    let currentFolderId = folderId?.toString();
    while (currentFolderId) {
      const folder = folderById.get(currentFolderId);
      if (!folder) break;
      if (folder.access === "workspace") return "workspace";
      currentFolderId = folder.parentId?.toString();
    }
    return "private";
  }

  static async listNotebooksSplit(
    workspaceId: string,
    userId: string,
    userRole: string = "member",
  ): Promise<{
    myNotebooks: NotebookTreeNode[];
    workspaceNotebooks: NotebookTreeNode[];
  }> {
    try {
      await syncNotebookIndexFromStore(workspaceId);

      const isAdmin = userRole === "owner" || userRole === "admin";
      const wsId = new Types.ObjectId(workspaceId);

      const [folders, notebooks] = await Promise.all([
        NotebookFolder.find({ workspaceId: wsId }).sort({ name: 1 }),
        NotebookIndex.find({
          workspaceId: wsId,
          $or: [
            { access: "workspace" },
            { access: "private", ownerId: userId },
            { "sharedWith.userId": userId },
          ],
        }).sort({ name: 1 }),
      ]);

      const folderById = new Map<string, INotebookFolder>();
      for (const f of folders) {
        folderById.set(f._id.toString(), f);
      }

      const effectiveAccess = (
        ownAccess: NotebookAccessLevel,
        folderId?: Types.ObjectId,
      ): NotebookAccessLevel =>
        NotebookManager.effectiveAccessForItem(ownAccess, folderId, folderById);

      const classify = (
        ownAccess: NotebookAccessLevel,
        ownerId: string | undefined,
        folderId?: Types.ObjectId,
      ): "my" | "workspace" | null => {
        const access = effectiveAccess(ownAccess, folderId);
        if (access === "workspace") return "workspace";
        if (ownerId === userId) return "my";
        return null;
      };

      const myNotebooksRaw: INotebookIndex[] = [];
      const sharedNotebooksRaw: INotebookIndex[] = [];

      for (const n of notebooks) {
        const ownerId = n.ownerId?.toString();
        let section = classify(n.access || "private", ownerId, n.folderId);
        if (section === null && NotebookManager.isCollaborator(n, userId)) {
          section = "workspace";
        }
        if (section === "my") myNotebooksRaw.push(n);
        else if (section === "workspace") sharedNotebooksRaw.push(n);
      }

      const myFolders: INotebookFolder[] = [];
      const sharedFolders: INotebookFolder[] = [];

      for (const f of folders) {
        const ownerId = f.ownerId?.toString();
        const section = classify(f.access || "private", ownerId, f.parentId);
        if (section === "my") myFolders.push(f);
        else if (section === "workspace") sharedFolders.push(f);
      }

      return {
        myNotebooks: NotebookManager.buildTree(
          myFolders,
          myNotebooksRaw,
          userId,
          isAdmin,
          userRole,
          folderById,
        ),
        workspaceNotebooks: NotebookManager.buildTree(
          sharedFolders,
          sharedNotebooksRaw,
          userId,
          isAdmin,
          userRole,
          folderById,
        ),
      };
    } catch (error) {
      logger.error("Error listing notebooks split", { error });
      return { myNotebooks: [], workspaceNotebooks: [] };
    }
  }

  static async wouldCreateCycle(
    folderId: string,
    targetParentId: string | null,
    workspaceId: string,
  ): Promise<boolean> {
    if (!targetParentId) return false;
    if (folderId === targetParentId) return true;

    const folders = await NotebookFolder.find({
      workspaceId: new Types.ObjectId(workspaceId),
    }).lean();

    const parentMap = new Map<string, string | undefined>();
    for (const f of folders) {
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

  static async getEffectiveAccessForNotebook(
    index: INotebookIndex,
    workspaceId: string,
  ): Promise<NotebookAccessLevel> {
    if (index.access === "workspace") return "workspace";
    if (!index.folderId) return index.access || "private";

    const folders = await NotebookFolder.find({
      workspaceId: new Types.ObjectId(workspaceId),
    }).lean();
    const folderById = new Map<string, INotebookFolder>();
    for (const f of folders) {
      folderById.set(f._id.toString(), f as INotebookFolder);
    }
    return NotebookManager.effectiveAccessForItem(
      index.access || "private",
      index.folderId,
      folderById,
    );
  }
}
