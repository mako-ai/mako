import { sortTreeNodes } from "./folder-tree";
import { Types } from "mongoose";
import {
  SavedConsole,
  ConsoleFolder,
  ISavedConsole,
  IConsoleFolder,
  ConsoleAccessLevel,
} from "../database/workspace-schema";
import { getLogger } from "../logging";
import { canReadResource, canWriteResource } from "./resource-acl";
import {
  commitConsoleBatch,
  commitConsoleMoves,
  commitConsoleRemoval,
  commitConsoleState,
} from "../apps/workspace-consoles.service";
import { chartSidecarPath } from "../apps/console-files";
import { RepoRequiredError } from "../apps/config";

const logger = getLogger(["api", "consoles"]);

export interface ConsoleFile {
  path: string;
  name: string;
  content: string;
  isDirectory: boolean;
  children?: ConsoleFile[];
  id?: string;
  folderId?: string;
  connectionId?: string;
  databaseName?: string;
  databaseId?: string;
  language?: "sql" | "javascript" | "mongodb";
  description?: string;
  isPrivate?: boolean;
  lastExecutedAt?: Date;
  executionCount?: number;
  access?: ConsoleAccessLevel;
  owner_id?: string;
  createdAt?: Date;
}

export class ConsoleManager {
  constructor() {}

  /**
   * Determine the effective access level for a console.
   * Handles backward compatibility: consoles without an `access` field
   * derive their level from the legacy `isPrivate` boolean.
   */
  static resolveAccess(console: ISavedConsole): ConsoleAccessLevel {
    return console.access || (console.isPrivate ? "private" : "workspace");
  }

  /**
   * Whether `userId` is an explicit collaborator (viewer or editor).
   */
  static isCollaborator(console: ISavedConsole, userId: string): boolean {
    return (console.sharedWith || []).some(s => s.userId === userId);
  }

  /**
   * Check whether `userId` can read the given console.
   */
  static canRead(
    console: ISavedConsole,
    userId: string,
    memberRole?: string,
  ): boolean {
    return canReadResource(console, userId, memberRole, {
      effectiveAccess: ConsoleManager.resolveAccess(console),
    });
  }

  /**
   * Check whether `userId` can write (modify) the given console.
   * Admins can write any workspace-level console.
   */
  static canWrite(
    console: ISavedConsole,
    userId: string,
    isAdmin: boolean = false,
    memberRole?: string,
  ): boolean {
    return canWriteResource(
      console,
      userId,
      memberRole ?? (isAdmin ? "admin" : undefined),
      { effectiveAccess: ConsoleManager.resolveAccess(console) },
    );
  }

  /**
   * Determine which section a console belongs to for a given user.
   */
  static classifyForUser(
    console: ISavedConsole,
    userId: string,
  ): "my" | "workspace" | null {
    const ownerId = (console.owner_id || console.createdBy)?.toString();
    if (ownerId === userId) return "my";

    const access = ConsoleManager.resolveAccess(console);
    if (access === "workspace") return "workspace";
    // Private consoles shared explicitly with this user surface under the
    // shared section so collaborators can find them.
    if (ConsoleManager.isCollaborator(console, userId)) return "workspace";
    return null;
  }

  /**
   * Determine which section a folder belongs to for a given user.
   */
  static classifyFolderForUser(
    folder: IConsoleFolder,
    userId: string,
  ): "my" | "workspace" | null {
    const ownerId = folder.ownerId?.toString();
    if (ownerId && ownerId === userId) return "my";

    const access =
      folder.access || (folder.isPrivate ? "private" : "workspace");
    if (access === "workspace") return "workspace";
    return null;
  }

  /**
   * Check if a user can read a console, considering inherited folder access.
   * Walks up the folder chain to find the effective access level.
   */
  async canReadWithInheritance(
    console: ISavedConsole,
    userId: string,
  ): Promise<boolean> {
    const ownerId = (console.owner_id || console.createdBy)?.toString();
    if (ownerId === userId) return true;
    if (ConsoleManager.isCollaborator(console, userId)) return true;

    const ownAccess = ConsoleManager.resolveAccess(console);
    if (ownAccess === "workspace") return true;

    let currentFolderId = console.folderId?.toString();
    while (currentFolderId) {
      const folder = (await ConsoleFolder.findById(currentFolderId)
        .select("access isPrivate parentId")
        .lean()) as {
        access?: string;
        isPrivate?: boolean;
        parentId?: Types.ObjectId;
      } | null;
      if (!folder) break;

      const folderAccess =
        folder.access || (folder.isPrivate ? "private" : "workspace");
      if (folderAccess === "workspace") return true;
      currentFolderId = folder.parentId?.toString();
    }

    return false;
  }

  /**
   * Resolve the access level a user sees after folder inheritance.
   */
  async resolveAccessWithInheritance(
    console: ISavedConsole,
  ): Promise<ConsoleAccessLevel> {
    const ownAccess = ConsoleManager.resolveAccess(console);
    if (ownAccess === "workspace") return "workspace";

    let currentFolderId = console.folderId?.toString();
    while (currentFolderId) {
      const folder = (await ConsoleFolder.findById(currentFolderId)
        .select("access isPrivate parentId")
        .lean()) as {
        access?: ConsoleAccessLevel;
        isPrivate?: boolean;
        parentId?: Types.ObjectId;
      } | null;
      if (!folder) break;

      const folderAccess =
        folder.access || (folder.isPrivate ? "private" : "workspace");
      if (folderAccess === "workspace") return "workspace";
      currentFolderId = folder.parentId?.toString();
    }

    return "private";
  }

  /**
   * Get all consoles in a tree structure from database.
   * Only returns explicitly saved consoles (isSaved: true), not drafts.
   */
  async listConsoles(
    workspaceId: string,
    userId?: string,
  ): Promise<ConsoleFile[]> {
    try {
      const [folders, consoles] = await Promise.all([
        ConsoleFolder.find({
          workspaceId: new Types.ObjectId(workspaceId),
        }).sort({ name: 1 }),
        SavedConsole.find({
          workspaceId: new Types.ObjectId(workspaceId),
          isSaved: true,
          $or: [
            { is_deleted: { $ne: true } },
            { is_deleted: { $exists: false } },
          ],
        }).sort({ name: 1 }),
      ]);

      const visibleConsoles = userId
        ? consoles.filter(c => ConsoleManager.canRead(c, userId))
        : consoles;

      return this.buildTree(folders, visibleConsoles);
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error listing consoles from database", { error });
      throw error;
    }
  }

  /**
   * Build a tree from folders and consoles, preserving hierarchy.
   */
  private buildTree(
    folders: IConsoleFolder[],
    consoles: ISavedConsole[],
  ): ConsoleFile[] {
    const folderMap = new Map<string, ConsoleFile>();
    const rootItems: ConsoleFile[] = [];

    for (const folder of folders) {
      const folderItem: ConsoleFile = {
        path: folder.name,
        name: folder.name,
        content: "",
        isDirectory: true,
        children: [],
        id: folder._id.toString(),
        folderId: folder._id.toString(),
        isPrivate: folder.isPrivate,
        owner_id: folder.ownerId,
        access: folder.access || (folder.isPrivate ? "private" : "workspace"),
        createdAt: folder.createdAt,
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

    for (const console of consoles) {
      const consoleItem: ConsoleFile = {
        path: console.folderId
          ? `${this.getFolderPath(console.folderId.toString(), folderMap)}/${console.name}`
          : console.name,
        name: console.name,
        content: console.code,
        isDirectory: false,
        id: console._id.toString(),
        connectionId: console.connectionId?.toString(),
        databaseName: console.databaseName,
        databaseId: console.databaseId,
        language: console.language,
        description: console.description,
        isPrivate: console.isPrivate,
        lastExecutedAt: console.lastExecutedAt,
        executionCount: console.executionCount,
        access: ConsoleManager.resolveAccess(console),
        owner_id: console.owner_id || console.createdBy,
      };

      if (console.folderId) {
        const folder = folderMap.get(console.folderId.toString());
        if (folder && folder.children) {
          folder.children.push(consoleItem);
        } else {
          rootItems.push(consoleItem);
        }
      } else {
        rootItems.push(consoleItem);
      }
    }

    sortTreeNodes(rootItems);

    return rootItems;
  }

  /**
   * List consoles split into 2 groups: myConsoles and sharedWithWorkspace.
   *
   * Items inherit access from their parent folder. A console inside a
   * "workspace" folder is workspace-visible regardless of the console's own
   * access field. This lets users move items between sections by simply
   * moving them into/out of shared folders — no access field update needed.
   */
  async listConsolesSplit(
    workspaceId: string,
    userId: string,
    _userRole: string = "member",
  ): Promise<{
    myConsoles: ConsoleFile[];
    sharedWithWorkspace: ConsoleFile[];
  }> {
    try {
      const [folders, consoles] = await Promise.all([
        ConsoleFolder.find({
          workspaceId: new Types.ObjectId(workspaceId),
        }).sort({ name: 1 }),
        SavedConsole.find({
          workspaceId: new Types.ObjectId(workspaceId),
          isSaved: true,
          $or: [
            { is_deleted: { $ne: true } },
            { is_deleted: { $exists: false } },
          ],
        }).sort({ name: 1 }),
      ]);

      const folderById = new Map<string, IConsoleFolder>();
      for (const f of folders) {
        folderById.set(f._id.toString(), f);
      }

      // Walk up the folder chain; workspace wins over private.
      const effectiveAccess = (
        ownAccess: ConsoleAccessLevel,
        folderId?: Types.ObjectId,
      ): ConsoleAccessLevel => {
        if (ownAccess === "workspace") return "workspace";
        let currentFolderId = folderId?.toString();
        while (currentFolderId) {
          const folder = folderById.get(currentFolderId);
          if (!folder) break;
          const fa =
            folder.access || (folder.isPrivate ? "private" : "workspace");
          if (fa === "workspace") return "workspace";
          currentFolderId = folder.parentId?.toString();
        }
        return "private";
      };

      const classify = (
        ownAccess: ConsoleAccessLevel,
        ownerId: string | undefined,
        folderId?: Types.ObjectId,
      ): "my" | "workspace" | null => {
        const access = effectiveAccess(ownAccess, folderId);
        if (access === "workspace") return "workspace";
        if (ownerId === userId) return "my";
        return null;
      };

      const myConsolesRaw: ISavedConsole[] = [];
      const sharedWithWorkspaceRaw: ISavedConsole[] = [];

      for (const c of consoles) {
        const ownerId = (c.owner_id || c.createdBy)?.toString();
        const ownAccess = ConsoleManager.resolveAccess(c);
        let section = classify(ownAccess, ownerId, c.folderId);
        // Private consoles shared explicitly with this user surface in the
        // shared section so collaborators can find them.
        if (section === null && ConsoleManager.isCollaborator(c, userId)) {
          section = "workspace";
        }
        if (section === "my") myConsolesRaw.push(c);
        else if (section === "workspace") sharedWithWorkspaceRaw.push(c);
      }

      const myFolders: IConsoleFolder[] = [];
      const sharedWithWorkspaceFolders: IConsoleFolder[] = [];

      for (const f of folders) {
        const ownerId = f.ownerId?.toString();
        const ownAccess = (f.access ||
          (f.isPrivate ? "private" : "workspace")) as ConsoleAccessLevel;
        const section = classify(ownAccess, ownerId, f.parentId);
        if (section === "my") myFolders.push(f);
        else if (section === "workspace") sharedWithWorkspaceFolders.push(f);
      }

      return {
        myConsoles: this.buildTree(myFolders, myConsolesRaw),
        sharedWithWorkspace: this.buildTree(
          sharedWithWorkspaceFolders,
          sharedWithWorkspaceRaw,
        ),
      };
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error listing consoles split", { error });
      return { myConsoles: [], sharedWithWorkspace: [] };
    }
  }

  /**
   * Get content of a specific console from database
   */
  async getConsole(consolePath: string, workspaceId?: string): Promise<string> {
    try {
      // Try to get from database first (by path or ID)
      if (workspaceId) {
        let savedConsole;

        // Check if consolePath is an ObjectId
        if (Types.ObjectId.isValid(consolePath)) {
          savedConsole = await SavedConsole.findOne({
            _id: new Types.ObjectId(consolePath),
            workspaceId: new Types.ObjectId(workspaceId),
          });
        } else {
          // Try to find by path
          const parts = consolePath.split("/");
          const consoleName = parts[parts.length - 1];

          if (parts.length > 1) {
            // Console is in a folder - need to find the folder first
            const folderParts = parts.slice(0, -1);
            const folderId = await this.findFolderByPath(
              folderParts,
              workspaceId,
            );

            savedConsole = await SavedConsole.findOne({
              name: consoleName,
              workspaceId: new Types.ObjectId(workspaceId),
              folderId: folderId
                ? new Types.ObjectId(folderId)
                : { $exists: false },
            });
          } else {
            // Console is at root level
            savedConsole = await SavedConsole.findOne({
              name: consoleName,
              workspaceId: new Types.ObjectId(workspaceId),
              folderId: { $exists: false },
            });
          }
        }

        if (savedConsole) {
          return savedConsole.code;
        }
      }

      throw new Error(`Console not found: ${consolePath}`);
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error getting console from database", { error });
      throw error;
    }
  }

  /**
   * Get full console data from database by ID only
   */
  async getConsoleWithMetadata(
    consoleId: string,
    workspaceId: string,
  ): Promise<{
    content: string;
    connectionId?: string;
    databaseName?: string;
    databaseId?: string;
    language?: string;
    id?: string;
    name?: string;
    path?: string;
    isSaved?: boolean;
    chartSpec?: Record<string, unknown>;
    resultsViewMode?: "table" | "json" | "chart";
    access?: ConsoleAccessLevel;
    owner_id?: string;
    _raw?: ISavedConsole;
  } | null> {
    try {
      // Only accept valid ObjectIds
      if (!Types.ObjectId.isValid(consoleId)) {
        logger.error("Invalid console ID", { consoleId });
        return null;
      }

      const savedConsole = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (savedConsole) {
        // Build path from name and folder
        let consolePath = savedConsole.name;
        if (savedConsole.folderId) {
          const folderPath = await this.getFolderPathById(
            savedConsole.folderId.toString(),
            workspaceId,
          );
          if (folderPath) {
            consolePath = `${folderPath}/${savedConsole.name}`;
          }
        }

        const effectiveAccess =
          await this.resolveAccessWithInheritance(savedConsole);

        return {
          content: savedConsole.code,
          connectionId: savedConsole.connectionId?.toString(),
          databaseName: savedConsole.databaseName,
          databaseId: savedConsole.databaseId,
          language: savedConsole.language,
          id: savedConsole._id.toString(),
          name: savedConsole.name,
          path: consolePath,
          isSaved: savedConsole.isSaved,
          chartSpec: savedConsole.chartSpec,
          resultsViewMode: savedConsole.resultsViewMode,
          access: effectiveAccess,
          owner_id: savedConsole.owner_id || savedConsole.createdBy,
          _raw: savedConsole,
        };
      }

      return null;
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error getting console with metadata", { error });
      return null;
    }
  }

  /**
   * Update access level for a console.
   * Only the owner can change access.
   */
  async updateConsoleAccess(
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
   * Update access level for a folder.
   * Propagates to child folders and consoles owned by the same user.
   */
  async updateFolderAccess(
    folderId: string,
    workspaceId: string,
    userId: string,
    access: ConsoleAccessLevel,
  ): Promise<boolean> {
    try {
      const folder = await ConsoleFolder.findOne({
        _id: new Types.ObjectId(folderId),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!folder) return false;

      const ownerId = folder.ownerId?.toString();
      if (!ownerId || ownerId !== userId) return false;

      folder.access = access;
      folder.isPrivate = access === "private";
      await folder.save();

      await this.propagateFolderAccess(folderId, workspaceId, userId, access);
      await this.reprojectFolderSubtree(
        folderId,
        workspaceId,
        userId,
        `access ${access}: folder ${folder.name}`,
      );

      return true;
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error updating folder access", { error });
      return false;
    }
  }

  /**
   * Recursively propagate access to all children of a folder.
   */
  private async propagateFolderAccess(
    folderId: string,
    workspaceId: string,
    ownerId: string,
    access: ConsoleAccessLevel,
  ): Promise<void> {
    const wid = new Types.ObjectId(workspaceId);
    const fid = new Types.ObjectId(folderId);

    await SavedConsole.updateMany(
      {
        workspaceId: wid,
        folderId: fid,
        $or: [{ owner_id: ownerId }, { createdBy: ownerId }],
      },
      { $set: { access, isPrivate: access === "private" } },
    );

    const childFolders = await ConsoleFolder.find({
      workspaceId: wid,
      parentId: fid,
      ownerId,
    });

    for (const child of childFolders) {
      child.access = access;
      child.isPrivate = access === "private";
      await child.save();
      await this.propagateFolderAccess(
        child._id.toString(),
        workspaceId,
        ownerId,
        access,
      );
    }
  }

  /**
   * Get folder path by folder ID (for building console paths)
   */
  private async getFolderPathById(
    folderId: string,
    workspaceId: string,
  ): Promise<string | null> {
    try {
      const folder = await ConsoleFolder.findOne({
        _id: new Types.ObjectId(folderId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!folder) return null;

      if (folder.parentId) {
        const parentPath = await this.getFolderPathById(
          folder.parentId.toString(),
          workspaceId,
        );
        return parentPath ? `${parentPath}/${folder.name}` : folder.name;
      }

      return folder.name;
    } catch (error) {
      console.error("Error getting folder path:", error);
      return null;
    }
  }

  /**
   * Find or create folder path (public version of ensureFolderPath)
   * Used by consoles.ts for explicit saves with path
   */
  async findOrCreateFolderPath(
    folderParts: string[],
    workspaceId: string,
    userId: string,
  ): Promise<string | undefined> {
    return this.ensureFolderPath(folderParts, workspaceId, userId);
  }

  /**
   * Save console content to database
   */
  async saveConsole(
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
        folderId = await this.ensureFolderPath(
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
        const query: any = {
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
          savedConsole.access = savedConsole.isPrivate
            ? "private"
            : "workspace";
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
        const consoleData: any = {
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
          language: options?.language || this.detectLanguage(content),
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
   * Create a new folder in the database
   */
  async createFolder(
    folderName: string,
    workspaceId: string,
    userId: string,
    parentId?: string,
    _isPrivate: boolean = false,
    access: ConsoleAccessLevel = "private",
  ): Promise<IConsoleFolder> {
    // Inherit access from parent folder if creating a subfolder
    let resolvedAccess = access;
    if (parentId) {
      const parentFolder = (await ConsoleFolder.findById(parentId)
        .select("access isPrivate")
        .lean()) as { access?: string; isPrivate?: boolean } | null;
      if (parentFolder) {
        const parentAccess = (parentFolder.access ||
          (parentFolder.isPrivate
            ? "private"
            : "workspace")) as ConsoleAccessLevel;
        // Inherit workspace access from parent
        if (parentAccess === "workspace") {
          resolvedAccess = "workspace";
        }
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
   * Rename a console in the database
   */
  async renameConsole(
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
        folderId = await this.ensureFolderPath(
          folderParts,
          workspaceId,
          userId,
        );
      }

      const updateFields: any = {
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
          current.folderId = folderId
            ? new Types.ObjectId(folderId)
            : undefined;
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
   * Delete a console from database
   */
  async deleteConsole(
    consoleId: string,
    workspaceId: string,
  ): Promise<boolean> {
    try {
      const doomed = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      }).select("path");
      if (doomed?.path) {
        await commitConsoleRemoval({
          workspaceId,
          path: doomed.path,
          message: `delete: ${doomed.path}`,
        });
      }
      const result = await SavedConsole.deleteOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      return result.deletedCount > 0;
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error deleting console", { error });
      return false;
    }
  }

  /**
   * Rename a folder in the database
   */
  async renameFolder(
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
        await this.reprojectFolderSubtree(
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
  private async consolesUnderFolder(
    folderId: string,
    workspaceId: string,
  ): Promise<ISavedConsole[]> {
    const wid = new Types.ObjectId(workspaceId);
    const out: ISavedConsole[] = [];
    const queue = [folderId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
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
  private async reprojectFolderSubtree(
    folderId: string,
    workspaceId: string,
    userId: string | undefined,
    message: string,
  ): Promise<void> {
    const rows = await this.consolesUnderFolder(folderId, workspaceId);
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
  async deleteFolder(
    folderId: string,
    workspaceId: string,
    userId?: string,
  ): Promise<boolean> {
    try {
      // Git first: every file under the folder goes in one commit.
      const rows = await this.consolesUnderFolder(folderId, workspaceId);
      const paths = rows
        .map(r => r.path)
        .filter((p): p is string => Boolean(p));
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
        await this.deleteFolder(childFolder._id.toString(), workspaceId);
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
   * Check if console exists in database
   */
  async consoleExists(
    consolePath: string,
    workspaceId?: string,
  ): Promise<boolean> {
    try {
      if (workspaceId) {
        if (Types.ObjectId.isValid(consolePath)) {
          const savedConsole = await SavedConsole.findOne({
            _id: new Types.ObjectId(consolePath),
            workspaceId: new Types.ObjectId(workspaceId),
          });
          return !!savedConsole;
        } else {
          const parts = consolePath.split("/");
          const consoleName = parts[parts.length - 1];

          // Get folder ID if there's a folder path
          let folderId: string | undefined;
          if (parts.length > 1) {
            const folderParts = parts.slice(0, -1);
            folderId = await this.findFolderByPath(folderParts, workspaceId);
          }

          // Check for console with same name in same folder (or root if no folder)
          const query: any = {
            name: consoleName,
            workspaceId: new Types.ObjectId(workspaceId),
          };

          if (folderId) {
            query.folderId = new Types.ObjectId(folderId);
          } else {
            // For root level consoles, check that folderId is null/undefined
            query.$or = [{ folderId: null }, { folderId: { $exists: false } }];
          }

          const savedConsole = await SavedConsole.findOne(query);
          return !!savedConsole;
        }
      }

      return false;
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error checking console existence", { error });
      return false;
    }
  }

  /**
   * Get console by path - returns the full console document
   * Used for conflict detection when saving
   */
  async getConsoleByPath(
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
        folderId = await this.findFolderByPath(folderParts, workspaceId);

        // If path specifies a folder but it doesn't exist, no console can exist at this path
        if (!folderId) {
          return null;
        }
      }

      // Build query for console with same name in same folder (or root if no folder)
      // Only match explicitly saved consoles (isSaved: true) - not drafts
      const query: any = {
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
      console.error("Error getting console by path:", error);
      return null;
    }
  }

  /**
   * Update execution stats
   */
  async updateExecutionStats(
    consoleId: string,
    workspaceId: string,
  ): Promise<void> {
    try {
      await SavedConsole.updateOne(
        {
          _id: new Types.ObjectId(consoleId),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        {
          $inc: { executionCount: 1 },
          $set: { lastExecutedAt: new Date() },
        },
      );
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error updating execution stats", { error });
    }
  }

  /**
   * Record external (API key / MCP) use of a console.
   *
   * - `execute`: bumps lastExternalUsedAt, externalUseCount, lastExternalSource
   * - `access`: bumps lastExternalUsedAt / lastExternalSource only, throttled
   *   to at most once per minute (reads/list details should not write-amplify)
   */
  async recordExternalUse(
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
   * Ensure folder path exists, creating folders as needed
   * Returns the ID of the deepest folder in the path
   */
  private async ensureFolderPath(
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
        folder = await this.createFolder(
          folderName,
          workspaceId,
          userId,
          currentParentId,
          false, // Default to not private
        );
      }

      currentParentId = folder._id.toString();
    }

    return currentParentId;
  }

  /**
   * Helper to get folder path from folder map
   */
  private getFolderPath(
    folderId: string,
    folderMap: Map<string, ConsoleFile>,
  ): string {
    const folder = folderMap.get(folderId);
    if (!folder) return "";

    // If folder has parent, get full path recursively
    return folder.path;
  }

  /**
   * Find folder by path parts
   * Returns the folder ID if found, undefined otherwise
   */
  private async findFolderByPath(
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
   * Move a console to a different folder (or root if folderId is null)
   */
  async moveConsole(
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

    const updateFields: Record<string, any> = {
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
   * Move a folder to a different parent folder (or root if parentId is null).
   * Prevents circular nesting.
   */
  async moveFolder(
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

    const updateFields: Record<string, any> = {};
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
      await this.reprojectFolderSubtree(
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
   * Soft-delete a console (set is_deleted=true instead of removing).
   */
  async softDeleteConsole(
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
  async restoreConsole(
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
  async duplicateConsole(
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
   * Detect language from content
   */
  private detectLanguage(content: string): "sql" | "javascript" | "mongodb" {
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
}
