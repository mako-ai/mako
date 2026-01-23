import * as fs from "fs";
import * as path from "path";
import { Types } from "mongoose";
import {
  SavedConsole,
  ConsoleFolder,
  ISavedConsole,
  IConsoleFolder,
} from "../database/workspace-schema";
import { getLogger } from "../logging";

const logger = getLogger(["api", "consoles"]);

export interface ConsoleFile {
  path: string;
  name: string;
  content: string;
  isDirectory: boolean;
  children?: ConsoleFile[];
  id?: string; // Database ID for saved consoles
  folderId?: string; // Database ID for folders
  connectionId?: string; // Associated database connection ID
  databaseName?: string; // Associated database name (human-readable)
  databaseId?: string; // Associated database ID (e.g., D1 UUID for cluster mode)
  language?: "sql" | "javascript" | "mongodb";
  description?: string;
  isPrivate?: boolean;
  lastExecutedAt?: Date;
  executionCount?: number;
}

export class ConsoleManager {
  private consolesDir: string;

  constructor() {
    // Allow overriding via environment variable
    const envDir = process.env.CONSOLES_DIR;

    const cwdDir = path.join(process.cwd(), "consoles");

    // Secondary candidate – parent directory (useful when the server is started from a sub-folder like /api)
    const parentDir = path.join(process.cwd(), "..", "consoles");

    // Determine which directory actually exists AND contains at least one entry
    let resolvedDir: string | undefined = undefined;

    const candidates = [envDir, parentDir, cwdDir].filter(Boolean) as string[];

    for (const dir of candidates) {
      if (fs.existsSync(dir)) {
        try {
          // Treat directory as valid only if it has files / sub-directories
          const items = fs.readdirSync(dir);
          if (items.length > 0) {
            resolvedDir = dir;
            break;
          }
        } catch {
          // Ignore permission errors etc.
        }
      }
    }

    // Fallback to first existing directory (even if empty) or cwdDir
    if (!resolvedDir) {
      for (const dir of candidates) {
        if (fs.existsSync(dir)) {
          resolvedDir = dir;
          break;
        }
      }
    }

    this.consolesDir = resolvedDir || cwdDir;

    // Log only in development environment
    if (process.env.NODE_ENV !== "production") {
      logger.info("Consoles directory resolved", { path: this.consolesDir });
    }
  }

  /**
   * Get all consoles in a tree structure from database
   * Only returns explicitly saved consoles (isSaved: true), not drafts
   */
  async listConsoles(workspaceId: string): Promise<ConsoleFile[]> {
    try {
      // Get all folders and saved consoles (not drafts) for the workspace
      const [folders, consoles] = await Promise.all([
        ConsoleFolder.find({
          workspaceId: new Types.ObjectId(workspaceId),
        }).sort({ name: 1 }),
        SavedConsole.find({
          workspaceId: new Types.ObjectId(workspaceId),
          isSaved: true, // Only explicitly saved consoles, not drafts
        }).sort({ name: 1 }),
      ]);

      // Build tree structure
      const folderMap = new Map<string, ConsoleFile>();
      const rootItems: ConsoleFile[] = [];

      // Create folder entries
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
        };

        folderMap.set(folder._id.toString(), folderItem);

        if (folder.parentId) {
          // Child folder - will be added to parent later
        } else {
          // Root folder
          rootItems.push(folderItem);
        }
      }

      // Set up parent-child relationships for folders
      for (const folder of folders) {
        if (folder.parentId) {
          const parent = folderMap.get(folder.parentId.toString());
          const child = folderMap.get(folder._id.toString());
          if (parent && child && parent.children) {
            parent.children.push(child);
            // Update path to include parent path
            child.path = `${parent.path}/${child.name}`;
          }
        }
      }

      // Add consoles to appropriate folders or root
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
        };

        if (console.folderId) {
          const folder = folderMap.get(console.folderId.toString());
          if (folder && folder.children) {
            folder.children.push(consoleItem);
          } else {
            // Folder not found, add to root
            rootItems.push(consoleItem);
          }
        } else {
          // Root console
          rootItems.push(consoleItem);
        }
      }

      // Sort children in each folder
      for (const folder of folderMap.values()) {
        if (folder.children) {
          folder.children.sort((a, b) => {
            // Directories first, then files
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
          });
        }
      }

      // Sort root items
      rootItems.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      return rootItems;
    } catch (error) {
      logger.error("Error listing consoles from database", { error });
      // Fallback to filesystem if database fails
      return this.listConsolesFromFilesystem();
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

      // Fallback to filesystem
      return this.getConsoleFromFilesystem(consolePath);
    } catch (error) {
      logger.error("Error getting console from database", { error });
      // Fallback to filesystem
      return this.getConsoleFromFilesystem(consolePath);
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
        };
      }

      return null;
    } catch (error) {
      logger.error("Error getting console with metadata", { error });
      return null;
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
        if (options?.isPrivate !== undefined) {
          savedConsole.isPrivate = options.isPrivate;
        }

        await savedConsole.save();
      } else {
        // Create new console (explicitly saved)
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
          isPrivate: options?.isPrivate || false,
          isSaved: true, // Explicitly saved console
          executionCount: 0,
        };

        // Use client-provided ID if available and valid
        if (options?.id && Types.ObjectId.isValid(options.id)) {
          consoleData._id = new Types.ObjectId(options.id);
        }

        savedConsole = new SavedConsole(consoleData);
        await savedConsole.save();
      }

      return savedConsole;
    } catch (error) {
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
    isPrivate: boolean = false,
  ): Promise<IConsoleFolder> {
    const folder = new ConsoleFolder({
      workspaceId: new Types.ObjectId(workspaceId),
      name: folderName,
      parentId: parentId ? new Types.ObjectId(parentId) : undefined,
      isPrivate,
      ownerId: isPrivate ? userId : undefined,
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
      const result = await SavedConsole.deleteOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      return result.deletedCount > 0;
    } catch (error) {
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
  ): Promise<boolean> {
    try {
      const result = await ConsoleFolder.updateOne(
        {
          _id: new Types.ObjectId(folderId),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        {
          $set: {
            name: newName,
            updatedAt: new Date(),
          },
        },
      );

      return result.modifiedCount > 0;
    } catch (error) {
      logger.error("Error renaming folder", { error });
      return false;
    }
  }

  /**
   * Delete a folder from database
   */
  async deleteFolder(folderId: string, workspaceId: string): Promise<boolean> {
    try {
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

      // Fallback to filesystem
      const fullPath = path.join(this.consolesDir, `${consolePath}.js`);
      return fs.existsSync(fullPath);
    } catch (error) {
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
      logger.error("Error updating execution stats", { error });
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

  // --- Filesystem fallback methods ---

  /**
   * Get all consoles in a tree structure from filesystem (fallback)
   */
  private listConsolesFromFilesystem(): ConsoleFile[] {
    const results = this.scanDirectory("");
    return results;
  }

  /**
   * Get console content from filesystem (fallback)
   */
  private getConsoleFromFilesystem(consolePath: string): string {
    const fullPath = path.join(this.consolesDir, `${consolePath}.js`);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Console file not found: ${consolePath}`);
    }

    return fs.readFileSync(fullPath, "utf8");
  }

  /**
   * Save console to filesystem (for backward compatibility)
   */
  private saveConsoleToFilesystem(consolePath: string, content: string): void {
    const fullPath = path.join(this.consolesDir, `${consolePath}.js`);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, "utf8");
  }

  /**
   * Recursively scan directory for console files (filesystem fallback)
   */
  private scanDirectory(relativePath: string): ConsoleFile[] {
    const fullPath = path.join(this.consolesDir, relativePath);

    if (!fs.existsSync(fullPath)) {
      logger.warn("Directory not found", { path: fullPath });
      return [];
    }

    const items = fs.readdirSync(fullPath);
    const result: ConsoleFile[] = [];

    for (const item of items) {
      const itemPath = path.join(fullPath, item);
      const relativeItemPath = path.join(relativePath, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        const children = this.scanDirectory(relativeItemPath);
        result.push({
          path: relativeItemPath,
          name: item,
          content: "", // Directories don't have direct content in this model
          isDirectory: true,
          children,
        });
      } else if (item.endsWith(".js")) {
        const content = fs.readFileSync(itemPath, "utf8");
        const nameWithoutExt = item.replace(".js", "");
        result.push({
          path: relativeItemPath.replace(".js", ""), // Store path without .js extension
          name: nameWithoutExt,
          content,
          isDirectory: false,
        });
      }
    }

    return result.sort((a, b) => {
      // Directories first, then files
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
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
