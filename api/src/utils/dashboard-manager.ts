import { Types } from "mongoose";
import {
  Dashboard,
  DashboardFolder,
  type IDashboard,
  type IDashboardFolder,
} from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.api("dashboard-manager");

export type DashboardAccessLevel = "private" | "workspace";

export interface DashboardTreeNode {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  children?: DashboardTreeNode[];
  access?: DashboardAccessLevel;
  owner_id?: string;
  readOnly?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Centralized permission + tree logic for dashboards.
 *
 * Access model (mirrors console-manager pattern):
 * - `access` is the source of truth for visibility ('private' | 'workspace')
 * - `owner_id` tracks the dashboard creator (backfilled from `createdBy`)
 * - Private dashboards are only visible/editable by the owner
 * - Workspace dashboards are visible to all members; editable by owner + admins
 */
export class DashboardManager {
  static getOwnerId(dashboard: IDashboard): string {
    return (dashboard.owner_id || dashboard.createdBy)?.toString();
  }

  static isOwner(dashboard: IDashboard, userId: string): boolean {
    return DashboardManager.getOwnerId(dashboard) === userId;
  }

  static canRead(dashboard: IDashboard, userId: string): boolean {
    if (DashboardManager.isOwner(dashboard, userId)) return true;
    return dashboard.access === "workspace";
  }

  static canWrite(
    dashboard: IDashboard,
    userId: string,
    isAdmin: boolean = false,
  ): boolean {
    if (DashboardManager.isOwner(dashboard, userId)) return true;
    if (dashboard.access === "private") return false;
    return isAdmin;
  }

  static classifyForUser(
    dashboard: IDashboard,
    userId: string,
  ): "my" | "workspace" | null {
    if (DashboardManager.isOwner(dashboard, userId)) return "my";
    if (dashboard.access === "workspace") return "workspace";
    return null;
  }

  // ── Tree building ──

  private static getFolderPath(
    folderId: string,
    folderMap: Map<string, DashboardTreeNode>,
  ): string {
    const folder = folderMap.get(folderId);
    if (!folder) return "";
    return folder.path;
  }

  static buildTree(
    folders: IDashboardFolder[],
    dashboards: IDashboard[],
    userId?: string,
    isAdmin: boolean = false,
  ): DashboardTreeNode[] {
    const folderMap = new Map<string, DashboardTreeNode>();
    const rootItems: DashboardTreeNode[] = [];

    for (const folder of folders) {
      const folderItem: DashboardTreeNode = {
        path: folder.name,
        name: folder.name,
        isDirectory: true,
        children: [],
        id: folder._id.toString(),
        owner_id: folder.ownerId,
        access: folder.access || "private",
        createdAt: folder.createdAt?.toISOString(),
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

    for (const dashboard of dashboards) {
      const folderId = dashboard.folderId?.toString();
      const dashboardItem: DashboardTreeNode = {
        path: folderId
          ? `${DashboardManager.getFolderPath(folderId, folderMap)}/${dashboard.title}`
          : dashboard.title,
        name: dashboard.title,
        isDirectory: false,
        id: dashboard._id.toString(),
        access: dashboard.access,
        owner_id: dashboard.owner_id || dashboard.createdBy,
        readOnly: userId
          ? !DashboardManager.canWrite(dashboard, userId, isAdmin)
          : undefined,
        createdAt: dashboard.createdAt?.toISOString(),
        updatedAt: dashboard.updatedAt?.toISOString(),
      };

      if (folderId) {
        const folder = folderMap.get(folderId);
        if (folder && folder.children) {
          folder.children.push(dashboardItem);
        } else {
          rootItems.push(dashboardItem);
        }
      } else {
        rootItems.push(dashboardItem);
      }
    }

    const sortNodes = (nodes: DashboardTreeNode[]) => {
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

  /**
   * List dashboards split into 2 groups: myDashboards and workspaceDashboards.
   * Items inherit access from their parent folder chain (workspace wins).
   */
  static async listDashboardsSplit(
    workspaceId: string,
    userId: string,
    userRole: string = "member",
  ): Promise<{
    myDashboards: DashboardTreeNode[];
    workspaceDashboards: DashboardTreeNode[];
  }> {
    try {
      const isAdmin = userRole === "owner" || userRole === "admin";
      const wsId = new Types.ObjectId(workspaceId);

      const [folders, dashboards] = await Promise.all([
        DashboardFolder.find({ workspaceId: wsId }).sort({ name: 1 }),
        Dashboard.find({
          workspaceId: wsId,
          $or: [
            { access: "workspace" },
            { access: "private", createdBy: userId },
            { access: "private", owner_id: userId },
          ],
        }).sort({ title: 1 }),
      ]);

      const folderById = new Map<string, IDashboardFolder>();
      for (const f of folders) {
        folderById.set(f._id.toString(), f);
      }

      const effectiveAccess = (
        ownAccess: DashboardAccessLevel,
        folderId?: Types.ObjectId,
      ): DashboardAccessLevel => {
        if (ownAccess === "workspace") return "workspace";
        let currentFolderId = folderId?.toString();
        while (currentFolderId) {
          const folder = folderById.get(currentFolderId);
          if (!folder) break;
          if (folder.access === "workspace") return "workspace";
          currentFolderId = folder.parentId?.toString();
        }
        return "private";
      };

      const classify = (
        ownAccess: DashboardAccessLevel,
        ownerId: string | undefined,
        folderId?: Types.ObjectId,
      ): "my" | "workspace" | null => {
        const access = effectiveAccess(ownAccess, folderId);
        if (access === "workspace") return "workspace";
        if (ownerId === userId) return "my";
        return null;
      };

      const myDashboardsRaw: IDashboard[] = [];
      const sharedDashboardsRaw: IDashboard[] = [];

      for (const d of dashboards) {
        const ownerId = (d.owner_id || d.createdBy)?.toString();
        const section = classify(d.access || "private", ownerId, d.folderId);
        if (section === "my") myDashboardsRaw.push(d);
        else if (section === "workspace") sharedDashboardsRaw.push(d);
      }

      const myFolders: IDashboardFolder[] = [];
      const sharedFolders: IDashboardFolder[] = [];

      for (const f of folders) {
        const ownerId = f.ownerId?.toString();
        const section = classify(f.access || "private", ownerId, f.parentId);
        if (section === "my") myFolders.push(f);
        else if (section === "workspace") sharedFolders.push(f);
      }

      return {
        myDashboards: DashboardManager.buildTree(
          myFolders,
          myDashboardsRaw,
          userId,
          isAdmin,
        ),
        workspaceDashboards: DashboardManager.buildTree(
          sharedFolders,
          sharedDashboardsRaw,
          userId,
          isAdmin,
        ),
      };
    } catch (error) {
      logger.error("Error listing dashboards split", { error });
      return { myDashboards: [], workspaceDashboards: [] };
    }
  }

  /**
   * Detect circular folder nesting.
   * Returns true if making `folderId` a child of `targetParentId` would create a cycle.
   */
  static async wouldCreateCycle(
    folderId: string,
    targetParentId: string | null,
    workspaceId: string,
  ): Promise<boolean> {
    if (!targetParentId) return false;
    if (folderId === targetParentId) return true;

    const folders = await DashboardFolder.find({
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
}
