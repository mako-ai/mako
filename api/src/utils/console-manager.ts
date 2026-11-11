import { collectDescendantFolderIds, sortTreeNodes } from "./folder-tree";
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
import { cleanedConsoleName, suffixedConsoleName } from "@mako/schemas";
import {
  commitConsoleBatch,
  commitConsoleMoves,
  commitConsoleRelocation,
  commitConsoleRemoval,
  commitConsoleState,
  consoleCommitHooks,
  descriptionIsAuthored,
  folderSegmentsFor,
  listConsoleDefinitionsAtMain,
  loadLiveConsoleById,
  loadLiveConsoles,
  repoPathForRow,
  restoreConsoleFile,
  syncConsolesIndexFromRepo,
  uniquePath,
  type LiveConsole,
} from "../apps/workspace-consoles.service";
import {
  ConsoleNameError,
  chartSidecarPath,
  cleanConsoleName,
  foldConsolePath,
  parseConsoleRepoPath,
} from "../apps/console-files";
import { RepoRequiredError } from "../apps/config";
import { BlobPreconditionError } from "../apps/repository.service";
import { publishRealtimeEvent } from "../services/realtime.service";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";

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

function folderIdForLive(
  live: LiveConsole,
  folders: IConsoleFolder[],
): Types.ObjectId | undefined {
  if (live.row?.folderId) return live.row.folderId;
  const segments = live.location.folderSegments;
  if (segments.length === 0) return undefined;
  let parentId: string | undefined;
  let found: IConsoleFolder | undefined;
  for (const name of segments) {
    found = folders.find(folder => {
      const sameName = folder.name === name;
      const parent = folder.parentId?.toString();
      return sameName && (parentId ? parent === parentId : !parent);
    });
    if (!found) return undefined;
    parentId = found._id.toString();
  }
  return found?._id;
}

/**
 * Git definition + Mongo overlay, shaped like a SavedConsole so the existing
 * tree/ACL helpers stay unchanged. `code` and front-matter always come from
 * the file; a missing Mongo body does not hide the console.
 */
function liveConsoleToRow(
  live: LiveConsole,
  folderId: Types.ObjectId | undefined,
): ISavedConsole {
  const loc = live.location;
  const access: ConsoleAccessLevel =
    loc.scope === "private" ? "private" : "workspace";
  const ownerId =
    loc.ownerId || live.row?.owner_id || live.row?.createdBy || "git";
  const connectionId =
    live.parsed.meta.connectionId &&
    Types.ObjectId.isValid(live.parsed.meta.connectionId)
      ? new Types.ObjectId(live.parsed.meta.connectionId)
      : live.row?.connectionId;
  const authored = live.parsed.meta.description;
  const generated =
    live.row && !descriptionIsAuthored(live.row)
      ? live.row.description
      : undefined;
  return {
    _id: live.id,
    name: loc.name,
    code: live.parsed.code,
    language: loc.language,
    path: live.path,
    sourceBlobSha: live.oid,
    folderId,
    connectionId,
    databaseName: live.parsed.meta.databaseName ?? live.row?.databaseName,
    databaseId: live.parsed.meta.databaseId ?? live.row?.databaseId,
    description: authored ?? generated,
    chartSpec: live.chartSpec ?? live.row?.chartSpec,
    resultsViewMode:
      live.parsed.meta.resultsViewMode ?? live.row?.resultsViewMode,
    mongoOptions: live.parsed.meta.mongoOptions ?? live.row?.mongoOptions,
    isPrivate: access === "private",
    isSaved: true,
    access,
    owner_id: live.row?.owner_id || ownerId,
    createdBy: live.row?.createdBy || ownerId,
    sharedWith: live.row?.sharedWith,
    workspaceRole: live.row?.workspaceRole,
    lastExecutedAt: live.row?.lastExecutedAt,
    executionCount: live.row?.executionCount ?? 0,
    createdAt: live.row?.createdAt,
    updatedAt: live.row?.updatedAt,
  } as ISavedConsole;
}

function metadataFromRow(savedConsole: ISavedConsole, consolePath: string) {
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
    description: savedConsole.description,
    mongoOptions: savedConsole.mongoOptions,
    owner_id: savedConsole.owner_id || savedConsole.createdBy,
    _raw: savedConsole,
  };
}

export { ConsoleNameError };

/**
 * A rename, move, delete or restore could not be applied as decided: the
 * file changed or moved on main between the read and the commit, or the
 * place it was headed for is taken. A 409 on every route; nothing is
 * overwritten and the caller may reload and retry.
 */
export class ConsoleConflictError extends Error {
  readonly status = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = "ConsoleConflictError";
  }
}

/** The target file (or a case twin of it) already is another console's. */
export class ConsolePathTakenError extends ConsoleConflictError {
  constructor(readonly path: string) {
    const at = parseConsoleRepoPath(path);
    const where = at?.folderSegments.length
      ? ` in ${at.folderSegments.join("/")}`
      : "";
    super(
      at
        ? `A console named “${at.name}” already exists${where}.`
        : `${path} already exists.`,
    );
    this.name = "ConsolePathTakenError";
  }
}

/**
 * Who can see a console — its own access, or what it inherits from the
 * folders it is in — is changed by its owner or a workspace admin. Someone
 * who can merely edit it renames and moves it within its visibility.
 */
export class ConsoleScopeError extends Error {
  readonly status = 403 as const;
  constructor(
    message = "Only the console's owner or a workspace admin can change who sees it.",
  ) {
    super(message);
    this.name = "ConsoleScopeError";
  }
}

/** The visibility rule: the owner, a workspace admin, or a workspace key. */
export function mayChangeVisibility(
  row: { owner_id?: string | null; createdBy?: string | null },
  actor: { userId?: string; isAdmin?: boolean },
): boolean {
  if (!actor.userId || actor.isAdmin) return true;
  return (row.owner_id || row.createdBy)?.toString() === actor.userId;
}

export interface ConsoleChange {
  /** A new name, as typed: stored with the stand-ins a file name needs. */
  name?: string;
  /** `null` moves to the root; `undefined` leaves the folder alone. */
  folderId?: string | null;
  access?: ConsoleAccessLevel;
}

export interface ConsoleActor {
  userId?: string;
  /** The caller is a workspace owner or admin. */
  isAdmin?: boolean;
  /** Commit subject prefix (default `rename`). */
  verb?: "rename" | "move";
}

/** What a folder delete moved to the trash — what its Undo puts back. */
export interface TrashedFolder {
  folders: Array<{
    id: string;
    name: string;
    parentId: string | null;
    access: ConsoleAccessLevel;
  }>;
  consoles: Array<{ id: string; name: string; folderId: string | null }>;
}

type FolderScope = Pick<IConsoleFolder, "access" | "isPrivate" | "ownerId">;

function folderAccess(folder: {
  access?: string | null;
  isPrivate?: boolean | null;
}): ConsoleAccessLevel {
  return folder.access === "workspace" || folder.access === "private"
    ? folder.access
    : folder.isPrivate
      ? "private"
      : "workspace";
}

function ownerOf(row: { owner_id?: string | null; createdBy?: string | null }) {
  return (row.owner_id || row.createdBy)?.toString();
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
   * Saved-console tree from git at main. Mongo is overlay (ACL, lastRun).
   * No GitHub binding → empty list, even if leftover Mongo or local git
   * exists. Drafts never appear here.
   */
  async listConsoles(
    workspaceId: string,
    userId?: string,
  ): Promise<ConsoleFile[]> {
    try {
      const bound = await boundRepoDirIfExists(workspaceId);
      if (bound == null) return [];

      const [folders, live] = await Promise.all([
        ConsoleFolder.find({
          workspaceId: new Types.ObjectId(workspaceId),
        }).sort({ name: 1 }),
        loadLiveConsoles(workspaceId),
      ]);
      const consoles = live.map(item =>
        liveConsoleToRow(item, folderIdForLive(item, folders)),
      );

      const visibleConsoles = userId
        ? consoles.filter(c => ConsoleManager.canRead(c, userId))
        : consoles;

      return this.buildTree(folders, visibleConsoles);
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error listing consoles from git", { error });
      throw error;
    }
  }

  /**
   * Flat list for API clients: live saved consoles from git, plus Mongo
   * drafts when a repo is bound. Unbound → empty.
   */
  async listConsolesFlat(
    workspaceId: string,
    userId?: string,
  ): Promise<ISavedConsole[]> {
    const bound = await boundRepoDirIfExists(workspaceId);
    if (bound == null) return [];
    const [folders, live, drafts] = await Promise.all([
      ConsoleFolder.find({
        workspaceId: new Types.ObjectId(workspaceId),
      }),
      loadLiveConsoles(workspaceId),
      SavedConsole.find({
        workspaceId: new Types.ObjectId(workspaceId),
        isSaved: { $ne: true },
        $or: [
          { is_deleted: { $ne: true } },
          { is_deleted: { $exists: false } },
        ],
      }).sort({ updatedAt: -1 }),
    ]);
    const saved = live.map(item =>
      liveConsoleToRow(item, folderIdForLive(item, folders)),
    );
    const all = [...saved, ...drafts];
    const visible = userId
      ? all.filter(doc => ConsoleManager.canRead(doc, userId))
      : all;
    return visible.sort(
      (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
    );
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
      const bound = await boundRepoDirIfExists(workspaceId);
      if (bound == null) {
        return { myConsoles: [], sharedWithWorkspace: [] };
      }

      const [folders, live] = await Promise.all([
        ConsoleFolder.find({
          workspaceId: new Types.ObjectId(workspaceId),
        }).sort({ name: 1 }),
        loadLiveConsoles(workspaceId),
      ]);
      const consoles = live.map(item =>
        liveConsoleToRow(item, folderIdForLive(item, folders)),
      );

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
   * Console body. Saved consoles read the file at main; drafts stay on the
   * Mongo working copy. A saved row with no git file is not found.
   */
  async getConsole(consolePath: string, workspaceId?: string): Promise<string> {
    try {
      if (!workspaceId) {
        throw new Error(`Console not found: ${consolePath}`);
      }
      if (Types.ObjectId.isValid(consolePath)) {
        const found = await loadLiveConsoleById(workspaceId, consolePath);
        if (found && "draft" in found) return found.draft.code;
        if (found && "live" in found) return found.live.parsed.code;
        throw new Error(`Console not found: ${consolePath}`);
      }
      const live = await loadLiveConsoles(workspaceId);
      const name = consolePath.split("/").pop();
      const match = live.find(
        item =>
          item.location.name === name &&
          (item.location.folderSegments.join("/")
            ? `${item.location.folderSegments.join("/")}/${item.location.name}`
            : item.location.name) === consolePath,
      );
      if (match) return match.parsed.code;
      throw new Error(`Console not found: ${consolePath}`);
    } catch (error) {
      if (error instanceof RepoRequiredError) throw error;
      logger.error("Error getting console from git", { error });
      throw error;
    }
  }

  /**
   * GET a console by id. Drafts are the Mongo working copy; saved consoles
   * are live only when the file exists at main.
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
    description?: string;
    mongoOptions?: ISavedConsole["mongoOptions"];
    access?: ConsoleAccessLevel;
    owner_id?: string;
    _raw?: ISavedConsole;
  } | null> {
    try {
      if (!Types.ObjectId.isValid(consoleId)) {
        logger.error("Invalid console ID", { consoleId });
        return null;
      }

      const found = await loadLiveConsoleById(workspaceId, consoleId);
      if (!found) return null;

      if ("draft" in found) {
        const savedConsole = found.draft;
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
          ...metadataFromRow(savedConsole, consolePath),
          access: effectiveAccess,
        };
      }

      const live = found.live;
      const folders = await ConsoleFolder.find({
        workspaceId: new Types.ObjectId(workspaceId),
      });
      const row = liveConsoleToRow(live, folderIdForLive(live, folders));
      const displayPath = live.location.folderSegments.length
        ? `${live.location.folderSegments.join("/")}/${live.location.name}`
        : live.location.name;
      const effectiveAccess = await this.resolveAccessWithInheritance(row);
      return {
        ...metadataFromRow(row, displayPath),
        access: effectiveAccess,
        _raw: live.row ?? row,
      };
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
   * The name a save is about to write: the one the console already has is
   * kept as it is (a name a laptop gave it is not re-judged); a new one is
   * cleaned like a rename's — stand-ins for what a file name cannot carry
   * — or refused (`ConsoleNameError`).
   */
  static nameToStore(
    name: string,
    current?: string | null,
    language?: ISavedConsole["language"],
  ): string {
    if (current && (name === current || cleanedConsoleName(name) === current)) {
      return current;
    }
    return cleanConsoleName(name, "console", language);
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
        savedConsole.name = ConsoleManager.nameToStore(
          consoleName,
          savedConsole.isSaved ? savedConsole.name : undefined,
          options?.language ?? savedConsole.language,
        );
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
          name: ConsoleManager.nameToStore(
            consoleName,
            undefined,
            options?.language,
          ),
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof ConsoleNameError
      ) {
        throw error;
      }
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

    // Named like any folder — a directory in the repo — and no twin of a
    // folder already there: "Team" and "team" are one directory on macOS
    // and Windows.
    const name = cleanConsoleName(folderName, "folder");
    await this.assertNoFolderTwin(workspaceId, name, parentId ?? null, {
      access: resolvedAccess,
      ownerId: userId,
    });

    const folder = new ConsoleFolder({
      workspaceId: new Types.ObjectId(workspaceId),
      name,
      parentId: parentId ? new Types.ObjectId(parentId) : undefined,
      isPrivate: resolvedAccess === "private",
      ownerId: userId,
      access: resolvedAccess,
    });

    return await folder.save();
  }

  /**
   * THE console rename/move: a new name, folder and/or access level, applied
   * to the row with the file moved on main in ONE commit. The explorer's
   * rename and "Move to…", the editor's Rename/Move, the REST routes and
   * `rename_object` all end here, so the id, shares, schedule and
   * telemetry never detach and no route decides a path on its own.
   *
   * The file is moved AS IT IS AT MAIN (`commitConsoleRelocation`): a
   * rename never commits the row's working copy, so an unsaved draft stays
   * a draft. The commit is a compare-and-swap; the target being taken — by
   * another console, a case twin, or a file pushed from a laptop and not
   * indexed yet — refuses with `ConsolePathTakenError`. When the file is
   * not where the row says (a push or another rename landed first), the
   * index is synced and the rename decided ONCE more from the fresh row.
   *
   * Returns null when the console does not exist or is in the trash: a
   * deleted console is not renamed. A draft is renamed in the index only.
   */
  async relocateConsole(
    consoleId: string,
    workspaceId: string,
    change: ConsoleChange,
    actor: ConsoleActor = {},
  ): Promise<{ row: ISavedConsole; commit?: string } | null> {
    if (!Types.ObjectId.isValid(consoleId)) return null;
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.relocateConsoleOnce(
        consoleId,
        workspaceId,
        change,
        actor,
      );
      if (outcome !== "drift") return outcome;
      if (attempt > 0) {
        throw new ConsoleConflictError(
          "The console changed in the repository while it was being renamed. Reload and try again.",
        );
      }
      await syncConsolesIndexFromRepo(workspaceId);
    }
  }

  private async relocateConsoleOnce(
    consoleId: string,
    workspaceId: string,
    change: ConsoleChange,
    actor: ConsoleActor,
  ): Promise<{ row: ISavedConsole; commit?: string } | null | "drift"> {
    const id = new Types.ObjectId(consoleId);
    const ws = new Types.ObjectId(workspaceId);
    const current = await SavedConsole.findOne({
      _id: id,
      workspaceId: ws,
      is_deleted: { $ne: true },
    });
    if (!current) return null;
    const readPath = current.path ?? null;

    // Only a NEW name is judged: the one it has, however it is spelled
    // ("Q1: revenue" for "Q1 - revenue"), is no change, and a name a
    // laptop gave it is not refused until someone changes it.
    const name =
      change.name === undefined ||
      cleanedConsoleName(change.name) === current.name
        ? undefined
        : cleanConsoleName(change.name, "console", current.language);

    // Who can see it is the row's access AND its folder chain. Changing
    // either is the owner's or an admin's call — measured before anything
    // below touches the row.
    const visibleBefore = await this.effectiveVisibility(current);
    const folderId =
      change.folderId === undefined
        ? undefined
        : change.folderId
          ? new Types.ObjectId(change.folderId)
          : null;
    if (folderId) {
      const exists = await ConsoleFolder.exists({
        _id: folderId,
        workspaceId: ws,
      });
      if (!exists) {
        throw new ConsoleConflictError(
          "That folder no longer exists. Reload and choose another.",
        );
      }
    }
    // `access` is the visibility the caller wants the console to have (the
    // section it is dropped in). Where the folder it is headed for already
    // gives it that, the row's own access is left alone: moving a console
    // within what its folder shows asks for no change of who sees it.
    const rowAccess = ConsoleManager.resolveAccess(current);
    const nextFolder = folderId === undefined ? current.folderId : folderId;
    const inherited = await this.effectiveVisibility({
      access: rowAccess,
      folderId: nextFolder,
    });
    const access =
      change.access && change.access !== inherited ? change.access : undefined;
    const visibleAfter = access
      ? await this.effectiveVisibility({ access, folderId: nextFolder })
      : inherited;
    if (
      (access !== undefined || visibleBefore !== visibleAfter) &&
      !mayChangeVisibility(current, actor)
    ) {
      throw new ConsoleScopeError();
    }

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) {
      current.name = name;
      set.name = name;
    }
    if (folderId !== undefined) {
      current.folderId = folderId ?? undefined;
      set.folderId = folderId;
    }
    if (access) {
      current.access = access;
      current.isPrivate = access === "private";
      set.access = access;
      set.isPrivate = current.isPrivate;
    }

    let commit: string | undefined;
    if (current.isSaved) {
      const toPath = await repoPathForRow(current);
      const message = `${actor.verb ?? "rename"}: ${current.name}`;
      if (toPath !== readPath) {
        await this.assertConsolePathFree(workspaceId, toPath, id, readPath);
      }
      if (!readPath) {
        // Never committed: the row is the only definition — project it.
        const committed = await commitConsoleState({
          row: current,
          actorUserId: actor.userId,
          message,
          expectAbsent: true,
        }).catch(error => {
          if (error instanceof BlobPreconditionError) {
            throw new ConsolePathTakenError(toPath);
          }
          throw error;
        });
        set.path = committed.path;
        set.sourceBlobSha = committed.sourceBlobSha;
        commit = committed.commitOid;
      } else if (toPath !== readPath) {
        let moved: Awaited<ReturnType<typeof commitConsoleRelocation>>;
        try {
          moved = await commitConsoleRelocation({
            workspaceId,
            fromPath: readPath,
            toPath,
            actorUserId: actor.userId,
            message,
            sourceBlobSha: current.sourceBlobSha,
          });
        } catch (error) {
          if (!(error instanceof BlobPreconditionError)) throw error;
          // The commit's compare-and-swap, which the check above cannot
          // replace: the target appeared meanwhile → taken; the source is
          // not the file the row knows → decide again from the fresh row.
          if (
            error.path === toPath ||
            error.path === chartSidecarPath(toPath)
          ) {
            throw new ConsolePathTakenError(toPath);
          }
          return "drift";
        }
        // No file where the row says: a push or another rename moved it.
        if (!moved) return "drift";
        set.path = moved.path;
        set.sourceBlobSha = moved.sourceBlobSha;
        commit = moved.commitOid;
        await consoleCommitHooks.afterCommit?.();
      }
    }

    // Never onto a row a delete took meanwhile (its file went with it): the
    // rename answers "not found". And never over a later rename: the row
    // must still be where this one read it, or where this one's commit put
    // the file (a sync may already have followed it there).
    const filter: Record<string, unknown> = {
      _id: id,
      workspaceId: ws,
      is_deleted: { $ne: true },
    };
    if (readPath) filter.path = { $in: [readPath, set.path ?? readPath] };
    const updated = await SavedConsole.findOneAndUpdate(
      filter,
      { $set: set, $inc: { draftRevision: 1 } },
      { returnDocument: "after" },
    );
    if (!updated) {
      const now = await SavedConsole.findOne({ _id: id, workspaceId: ws });
      if (!now || now.is_deleted) return null;
      throw new ConsoleConflictError(
        "The console was renamed or moved again while this change was being applied. Reload to see where it is.",
      );
    }
    publishRealtimeEvent(workspaceId, {
      type: "console.updated",
      consoleId,
      draftRevision: updated.draftRevision ?? 1,
      name: updated.name,
      updatedBy: actor.userId ?? "agent",
      origin: "save",
    });
    return { row: updated, commit };
  }

  /**
   * Who can see a console: "workspace" when its own access is workspace or
   * any folder on its chain is a workspace folder, else "private".
   */
  async effectiveVisibility(console: {
    access?: ConsoleAccessLevel | null;
    isPrivate?: boolean | null;
    folderId?: Types.ObjectId | string | null;
  }): Promise<ConsoleAccessLevel> {
    if (
      folderAccess({ ...console, isPrivate: console.isPrivate ?? false }) ===
      "workspace"
    ) {
      return "workspace";
    }
    let at = console.folderId?.toString();
    for (let depth = 0; at && depth < 32; depth++) {
      const folder = await ConsoleFolder.findById(at)
        .select("access isPrivate parentId")
        .lean<(FolderScope & { parentId?: Types.ObjectId }) | null>();
      if (!folder) break;
      if (folderAccess(folder) === "workspace") return "workspace";
      at = folder.parentId?.toString();
    }
    return "private";
  }

  /**
   * Where a console is, as a rename, a move or a restore answers: its name
   * as saved, its `Folder/Sub/name` path, its folder, and who can see it.
   */
  async consoleLocation(row: ISavedConsole): Promise<{
    id: string;
    name: string;
    path: string;
    folderId: string | null;
    access: ConsoleAccessLevel;
  }> {
    const segments = await folderSegmentsFor(
      row.folderId,
      row.workspaceId.toString(),
    );
    return {
      id: row._id.toString(),
      name: row.name,
      path: [...segments, row.name].join("/"),
      folderId: row.folderId ? row.folderId.toString() : null,
      access: await this.effectiveVisibility(row),
    };
  }

  /** The folded paths every live console holds: files at main, then rows. */
  private async takenConsolePaths(
    workspaceId: string,
    self?: Types.ObjectId,
  ): Promise<Set<string>> {
    const [defs, rows] = await Promise.all([
      listConsoleDefinitionsAtMain(workspaceId),
      SavedConsole.find({
        workspaceId: new Types.ObjectId(workspaceId),
        ...(self ? { _id: { $ne: self } } : {}),
        isSaved: true,
        is_deleted: { $ne: true },
        path: { $exists: true, $ne: null },
      })
        .select("path")
        .lean<Array<{ path?: string }>>(),
    ]);
    return new Set(
      [...defs.map(d => d.path), ...rows.map(r => r.path as string)].map(
        foldConsolePath,
      ),
    );
  }

  /**
   * Throw `ConsolePathTakenError` when a file at main or a live row holds
   * `path`, or a path that differs from it only in letter case or Unicode
   * form (one file on macOS and Windows) — other than the console's own.
   */
  private async assertConsolePathFree(
    workspaceId: string,
    path: string,
    self: Types.ObjectId,
    ownPath: string | null,
  ): Promise<void> {
    const taken = await this.takenConsolePaths(workspaceId, self);
    if (ownPath) taken.delete(foldConsolePath(ownPath));
    if (taken.has(foldConsolePath(path))) throw new ConsolePathTakenError(path);
  }

  /** `name`, or "name (2)", "name (3)"… — the first whose file is free. */
  private async freeNameFor(row: ISavedConsole): Promise<string> {
    const taken = await this.takenConsolePaths(
      row.workspaceId.toString(),
      row._id,
    );
    const free = uniquePath(await repoPathForRow(row), taken, null);
    return parseConsoleRepoPath(free)?.name ?? row.name;
  }

  /**
   * Refuse a folder whose name, in the place it is headed for, is another
   * folder's but for letter case or Unicode form. At the root a private
   * folder only collides with its owner's own.
   */
  private async assertNoFolderTwin(
    workspaceId: string,
    name: string,
    parentId: string | null,
    scope: { access: ConsoleAccessLevel; ownerId?: string },
    self?: string,
  ): Promise<void> {
    const twin = await this.folderTwin(
      workspaceId,
      name,
      parentId,
      scope,
      self,
    );
    if (twin) {
      throw new ConsoleConflictError(
        `A folder named “${twin.name}” already exists here.`,
      );
    }
  }

  private async folderTwin(
    workspaceId: string,
    name: string,
    parentId: string | null,
    scope: { access: ConsoleAccessLevel; ownerId?: string },
    self?: string,
  ): Promise<IConsoleFolder | null> {
    const siblings = await ConsoleFolder.find({
      workspaceId: new Types.ObjectId(workspaceId),
      ...(parentId
        ? { parentId: new Types.ObjectId(parentId) }
        : { $or: [{ parentId: null }, { parentId: { $exists: false } }] }),
    });
    const fold = foldConsolePath(name);
    return (
      siblings.find(
        f =>
          f._id.toString() !== self &&
          foldConsolePath(f.name) === fold &&
          (parentId !== null ||
            (folderAccess(f) === scope.access &&
              (scope.access === "workspace" ||
                f.ownerId?.toString() === scope.ownerId))),
      ) ?? null
    );
  }

  /**
   * Rename a console. A `Folder/Sub/name` value also moves it into that
   * folder chain (found or created), in the same commit.
   */
  async renameConsole(
    consoleId: string,
    newName: string,
    workspaceId: string,
    userId: string,
    isAdmin = false,
  ): Promise<ISavedConsole | null> {
    const parts = newName.split("/");
    const folderId =
      parts.length > 1
        ? ((await this.ensureFolderPath(
            parts.slice(0, -1),
            workspaceId,
            userId,
          )) ?? null)
        : undefined;
    const moved = await this.relocateConsole(
      consoleId,
      workspaceId,
      { name: parts[parts.length - 1], folderId },
      { userId, isAdmin, verb: "rename" },
    );
    return moved?.row ?? null;
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
      if (cleanedConsoleName(newName) === previousName) return true;
      const name = cleanConsoleName(newName, "folder");
      await this.assertNoFolderTwin(
        workspaceId,
        name,
        folder.parentId?.toString() ?? null,
        { access: folderAccess(folder), ownerId: folder.ownerId?.toString() },
        folderId,
      );
      folder.name = name;
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof ConsoleNameError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
   * Delete a folder: every console under it (subfolders included) moves to
   * the TRASH — its row, id, shares and history kept, never erased — and
   * the folder records go. Answers with what was trashed, which is what an
   * Undo puts back.
   *
   * Every console under it must be one the actor may delete on its own:
   * theirs, or any for a workspace admin; otherwise nothing changes
   * (`ConsoleScopeError`). The files leave main in one commit.
   */
  async deleteFolder(
    folderId: string,
    workspaceId: string,
    userId?: string,
    isAdmin = false,
  ): Promise<TrashedFolder | null> {
    const wid = new Types.ObjectId(workspaceId);
    const root = await ConsoleFolder.findOne({
      _id: new Types.ObjectId(folderId),
      workspaceId: wid,
    });
    if (!root) return null;
    const folderIds = [
      root._id,
      ...(await collectDescendantFolderIds(ConsoleFolder, wid, root._id)),
    ];
    const folders = await ConsoleFolder.find({ _id: { $in: folderIds } });
    const rows = await SavedConsole.find({
      workspaceId: wid,
      folderId: { $in: folderIds },
    });
    const live = rows.filter(r => !r.is_deleted);
    if (userId && !isAdmin && live.some(r => ownerOf(r) !== userId)) {
      throw new ConsoleScopeError(
        "This folder holds consoles of other members: only they or a workspace admin can delete those. Move them out first, or ask an admin.",
      );
    }
    // Git first: every file under the folder goes in one commit.
    const paths = live
      .filter(r => r.isSaved !== false && r.path)
      .map(r => r.path as string);
    let removal: string | undefined;
    if (paths.length > 0) {
      const committed = await commitConsoleBatch({
        workspaceId,
        actorUserId: userId,
        mutation: { deletes: paths.flatMap(p => [p, chartSidecarPath(p)]) },
        message: `delete folder (${paths.length} console${paths.length === 1 ? "" : "s"})`,
      });
      if (!committed.unchanged) removal = committed.commitOid;
    }
    // Into the trash and out of the folder, which is about to go.
    const now = new Date();
    for (const row of live) {
      await SavedConsole.updateOne(
        { _id: row._id, workspaceId: wid },
        {
          $set: {
            is_deleted: true,
            deletedAt: now,
            deletedVia: "app",
            folderId: null,
          },
          ...(removal && row.path
            ? {
                $addToSet: {
                  historySegments: { path: row.path, until: removal },
                },
              }
            : {}),
        },
      );
    }
    await SavedConsole.updateMany(
      { workspaceId: wid, folderId: { $in: folderIds } },
      { $set: { folderId: null } },
    );
    await ConsoleFolder.deleteMany({
      _id: { $in: folderIds },
      workspaceId: wid,
    });
    // Announced only now: every open window refetches the tree on
    // `console.deleted`, and a refetch while the folder records still
    // existed listed the deleted folder, empty, until a manual refresh.
    for (const row of live) {
      publishRealtimeEvent(workspaceId, {
        type: "console.deleted",
        consoleId: row._id.toString(),
      });
    }
    return {
      folders: folders.map(f => ({
        id: f._id.toString(),
        name: f.name,
        parentId: f.parentId?.toString() ?? null,
        access: folderAccess(f),
      })),
      consoles: live.map(r => ({
        id: r._id.toString(),
        name: r.name,
        folderId: r.folderId?.toString() ?? null,
      })),
    };
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

      // "team" for an existing "Team" is that folder, not a second one.
      folder ??= await this.folderTwin(
        workspaceId,
        cleanedConsoleName(folderName),
        currentParentId ?? null,
        { access: "private", ownerId: userId },
      );

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
   * Move a console to a different folder (or root if folderId is null),
   * optionally renaming it and changing its access in the same commit.
   */
  async moveConsole(
    consoleId: string,
    workspaceId: string,
    folderId: string | null,
    access?: ConsoleAccessLevel,
    userId?: string,
    options: { name?: string; isAdmin?: boolean } = {},
  ): Promise<boolean> {
    const moved = await this.relocateConsole(
      consoleId,
      workspaceId,
      { folderId, access, name: options.name },
      { userId, isAdmin: options.isAdmin, verb: "move" },
    );
    return moved !== null;
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
    isAdmin = false,
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(folderId)) return false;
    const actor = { userId, isAdmin };

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

    const nextAccess = access ?? folderAccess(before);
    await this.assertNoFolderTwin(
      workspaceId,
      before.name,
      newParentId,
      { access: nextAccess, ownerId: before.ownerId?.toString() },
      folderId,
    );
    // A folder shows what it holds to whoever can see the folder. Moving
    // it so that changes for a console is that console's owner's call, or
    // a workspace admin's — the rule a console's own move follows.
    const seenAs = async (
      parent: Types.ObjectId | string | null | undefined,
      own: ConsoleAccessLevel,
    ) =>
      own === "workspace"
        ? own
        : this.effectiveVisibility({ access: "private", folderId: parent });
    const changesWhoSees =
      (await seenAs(before.parentId, folderAccess(before))) !==
      (await seenAs(newParentId, nextAccess));
    if (changesWhoSees && actor.userId && !actor.isAdmin) {
      const held = await this.consolesUnderFolder(folderId, workspaceId);
      if (held.some(row => ownerOf(row) !== actor.userId)) {
        throw new ConsoleScopeError(
          "This folder holds consoles of other members: only they or a workspace admin can change who sees those.",
        );
      }
    }

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
   * Move a console to the trash: its file leaves main, its row stays
   * (id, shares, history) marked deleted.
   *
   * The file removed is the one the row points to WHEN THE COMMIT LANDS.
   * Read once and committed blindly, a rename landing in between moved the
   * file away: the delete removed nothing, marked the row deleted, the
   * renamed file stayed on main and the next sync brought the console
   * back. So the removal is a compare-and-swap on the file as it is at
   * main, the row is marked deleted only while it still points where the
   * removal looked, and a lost race is decided again from the fresh row —
   * a bounded number of times, then `ConsoleConflictError`. True means the
   * console is in the trash and its file is gone from main.
   */
  async softDeleteConsole(
    consoleId: string,
    workspaceId: string,
    userId?: string,
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(consoleId)) return false;
    const id = new Types.ObjectId(consoleId);
    const ws = new Types.ObjectId(workspaceId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await SavedConsole.findOne({
        _id: id,
        workspaceId: ws,
      }).select("path is_deleted");
      // Nothing to delete, or already in the trash.
      if (!current || current.is_deleted) return false;
      const path = current.path ?? null;
      let segment: { path: string; until: string } | undefined;
      if (path) {
        let removed: Awaited<ReturnType<typeof commitConsoleRemoval>>;
        try {
          removed = await commitConsoleRemoval({
            workspaceId,
            path,
            actorUserId: userId,
            message: `delete: ${path}`,
            onlyAsItIs: true,
          });
        } catch (error) {
          // The file changed or moved between the read and the commit.
          if (error instanceof BlobPreconditionError) continue;
          throw error;
        }
        if (removed.absent) {
          // Not where the row says: a rename or a push moved it and the
          // index has not caught up. Take that in and decide again.
          await syncConsolesIndexFromRepo(workspaceId);
          continue;
        }
        // The file's history up to here is this console's earlier life: a
        // restore adds a new file, where git's history of it starts.
        if (!removed.unchanged) segment = { path, until: removed.commitOid };
      }
      const result = await SavedConsole.updateOne(
        { _id: id, workspaceId: ws, path: path ?? null },
        {
          $set: { is_deleted: true, deletedAt: new Date(), deletedVia: "app" },
          ...(segment ? { $addToSet: { historySegments: segment } } : {}),
        },
      );
      // A rename re-pointed the row meanwhile: decide again.
      if (result.matchedCount === 0) continue;
      return result.modifiedCount > 0;
    }
    throw new ConsoleConflictError(
      "This console was renamed or moved while it was being deleted. Reload and try again.",
    );
  }

  /**
   * Restore a console from the trash: in place, or — when its name was
   * taken meanwhile — as "name (2)". The file comes back as it was last
   * committed, at a path that must be free when the commit lands.
   *
   * `folderId` files it in that folder instead (a folder delete's Undo
   * recreates the folder first); a folder that no longer exists means the
   * root. Returns the row as restored, or null when there is nothing in
   * the trash under that id.
   */
  async restoreConsole(
    consoleId: string,
    workspaceId: string,
    userId?: string,
    options: { folderId?: string | null } = {},
  ): Promise<ISavedConsole | null> {
    if (!Types.ObjectId.isValid(consoleId)) return null;
    const ws = new Types.ObjectId(workspaceId);
    const current = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: ws,
    });
    // Only a deleted console is restored: on a live one this would be a
    // second copy of its file.
    if (!current?.is_deleted) return null;
    const wanted =
      options.folderId === undefined ? current.folderId : options.folderId;
    const folder = wanted
      ? await ConsoleFolder.exists({ _id: wanted, workspaceId: ws })
      : null;
    current.folderId = folder?._id;
    const set: Record<string, unknown> = {
      is_deleted: false,
      folderId: folder?._id ?? null,
    };
    if (current.isSaved) {
      for (let attempt = 0; ; attempt++) {
        current.name = await this.freeNameFor(current);
        try {
          const committed = await restoreConsoleFile({
            row: current,
            actorUserId: userId,
            message: `restore: ${current.name}`,
          });
          set.name = current.name;
          set.path = committed.path;
          set.sourceBlobSha = committed.sourceBlobSha;
          break;
        } catch (error) {
          // The name was taken between the choice and the commit.
          if (!(error instanceof BlobPreconditionError) || attempt > 1) {
            throw error;
          }
        }
      }
    }
    // The revision moves so an open tab picks up the restored console (its
    // name may now be "name (2)").
    return SavedConsole.findOneAndUpdate(
      { _id: current._id, workspaceId: ws, is_deleted: true },
      {
        $set: set,
        $unset: { deletedAt: "", deletedVia: "" },
        $inc: { draftRevision: 1 },
      },
      { returnDocument: "after" },
    );
  }

  /**
   * Duplicate a console: a private copy named "<name> copy" — "<name> copy
   * (2)" when that file is taken — whose name always fits the length
   * limit. The copy never lands on another console's file.
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
      name: suffixedConsoleName(original.name, " copy"),
      description: original.description,
      code: original.code,
      language: original.language,
      mongoOptions: original.mongoOptions ?? undefined,
      createdBy: userId,
      isPrivate: true,
      isSaved: true,
      access: "private" as const,
      owner_id: userId,
      executionCount: 0,
    });
    for (let attempt = 0; ; attempt++) {
      copy.name = await this.freeNameFor(copy);
      try {
        const committed = await commitConsoleState({
          row: copy,
          actorUserId: userId,
          message: `duplicate: ${original.name}`,
          expectAbsent: true,
        });
        copy.path = committed.path;
        copy.sourceBlobSha = committed.sourceBlobSha;
        break;
      } catch (error) {
        if (!(error instanceof BlobPreconditionError) || attempt > 1) {
          throw error;
        }
      }
    }
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
