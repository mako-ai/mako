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
  commitConsoleRelocation,
  commitConsoleRemoval,
  commitConsoleState,
  consoleFilesDrifted,
  descriptionIsAuthored,
  ensureFolderChain,
  folderSegmentsFor,
  loadLiveConsoleById,
  listConsoleDefinitionsAtMain,
  loadLiveConsoles,
  readConsoleDefinitionAtMain,
  repoPathForRow,
  restoreConsoleBlob,
  syncConsolesIndexFromRepo,
  uniquePath,
  type LiveConsole,
} from "../apps/workspace-consoles.service";
import { chartSidecarPath, parseConsoleRepoPath } from "../apps/console-files";
import { BlobPreconditionError } from "../apps/repository.service";
import { RepoRequiredError } from "../apps/config";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";
import { publishRealtimeEvent } from "../services/realtime.service";

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
  // In the file's scope, as `ensureFolderChain` files it: a private file's
  // "Team" is its owner's private folder, never the workspace namesake —
  // which would make the console LOOK workspace-visible, and the editor's
  // next save would send that access back as a re-scope.
  const inScope = (folder: IConsoleFolder): boolean => {
    const access =
      folder.access || (folder.isPrivate ? "private" : "workspace");
    return live.location.scope === "private"
      ? access === "private" &&
          folder.ownerId?.toString() === live.location.ownerId
      : access === "workspace";
  };
  let parentId: string | undefined;
  let found: IConsoleFolder | undefined;
  for (const name of segments) {
    found = folders.find(folder => {
      const sameName = folder.name === name;
      const parent = folder.parentId?.toString();
      return (
        sameName &&
        (parentId ? parent === parentId : !parent) &&
        inScope(folder)
      );
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

/**
 * A rename/move could not be applied as decided: the file changed or moved
 * on main between the read and the commit (a concurrent save or rename).
 * Surfaced as a 409 by every caller; the caller may re-read and retry.
 */
export class ConsoleConflictError extends Error {
  readonly status = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = "ConsoleConflictError";
  }
}

/**
 * A rename/move's target file is already another console's — found by the
 * pre-check, or by the commit's compare-and-swap when it appeared in
 * between. Never resolved by overwriting.
 */
export class ConsolePathTakenError extends ConsoleConflictError {
  constructor(readonly path: string) {
    super(`A console already exists at ${path}`);
    this.name = "ConsolePathTakenError";
  }
}

/**
 * Re-scoping a console (private ↔ workspace) is the owner's call, as in
 * `updateConsoleAccess`; a shared editor may rename and move it within its
 * scope but not change who can see it.
 */
export class ConsoleScopeError extends Error {
  readonly status = 403 as const;
  constructor(
    message = "Only the owner can move a console between private and workspace",
  ) {
    super(message);
    this.name = "ConsoleScopeError";
  }
}

/**
 * What a save, a rename or a sharing change asks of an EXISTING console.
 * `placeConsole` turns it into a name, a folder and (on a re-scope) an
 * access level; `relocateConsole` applies that.
 */
export interface ConsolePlacementRequest {
  /**
   * `Folder/Sub/name` as the editor shows it: a name and a folder chain
   * (no `/` = the root). The chain is found-or-created IN A SCOPE.
   */
  path?: string;
  /** A new name in the same folder (a title). Ignored when `path` is set. */
  name?: string;
  /** An explicit folder (`null` = the root); wins over `path`'s chain. */
  folderId?: string | null;
  /**
   * The visibility the client shows and asks for — the EFFECTIVE one (row
   * access + folder chain), which is what the editor's tab carries.
   */
  access?: ConsoleAccessLevel;
}

/** How `relocateForSave` reports the move it made (see relocateConsole). */
type RelocateOptions = {
  verb?: "rename" | "move";
  publish?: boolean;
  bumpRevision?: boolean;
};

/** The row shape `repoPathForRow` derives a repo path from. */
type RowLikeForPath = Parameters<typeof repoPathForRow>[0];

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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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

      await this.syncSubtreeIfDrifted(folderId, workspaceId);
      const before = { access: folder.access, isPrivate: folder.isPrivate };
      const snapshot = await this.folderSubtreeAccessSnapshot(
        folderId,
        workspaceId,
      );
      folder.access = access;
      folder.isPrivate = access === "private";
      await folder.save();
      try {
        await this.assertFolderScopeFlipAllowed(
          folderId,
          workspaceId,
          access,
          userId,
        );
        await this.assertFolderSubtreePathsFree(
          folderId,
          workspaceId,
          this.ownedRescope(access, userId),
        );
        await this.propagateFolderAccess(folderId, workspaceId, userId, access);
        await this.reprojectFolderSubtree(
          folderId,
          workspaceId,
          userId,
          `access ${access}: folder ${folder.name}`,
        );
      } catch (error) {
        // Nothing moved in git: the rows must not say the new access while
        // their files stay where they were.
        await this.restoreFolderSubtreeAccess(snapshot);
        folder.access = before.access;
        folder.isPrivate = before.isPrivate;
        await folder.save();
        throw error;
      }

      return true;
    } catch (error) {
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
    scope: { access: ConsoleAccessLevel; ownerId: string },
  ): Promise<string | undefined> {
    return this.ensureFolderPath(folderParts, workspaceId, scope);
  }

  /**
   * Save a console by path (POST / and the path-addressed PUT): create it,
   * or save over the console the request names — by `options.id`, else the
   * console at that path IN THE SAVE'S SCOPE (the saver's own private one,
   * or the workspace one; never another member's console that happens to
   * share its name).
   *
   * An existing console is saved only by someone who can write it, and its
   * name, folder and access change through `relocateForSave` (scoped
   * folders, free-path check, compare-and-swap, owner-only visibility)
   * before the content is projected onto the path it then owns. A new
   * console's file must be absent at commit time: a laptop-pushed file is
   * never overwritten by a create.
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
      /** The caller's workspace role, for the write check on an existing console. */
      memberRole?: string;
    },
  ): Promise<ISavedConsole> {
    try {
      const parts = consolePath.split("/");
      const consoleName = parts[parts.length - 1];
      const folderParts = parts.slice(0, -1);

      // What the caller asked for (undefined = keep, on an existing console)
      // and what a NEW console gets (historically workspace by default).
      const requestedAccess =
        options?.access ??
        (options?.isPrivate === undefined
          ? undefined
          : options.isPrivate
            ? "private"
            : "workspace");
      const newAccess: ConsoleAccessLevel = requestedAccess ?? "workspace";

      let savedConsole: ISavedConsole | null = null;
      if (options?.id && Types.ObjectId.isValid(options.id)) {
        savedConsole = await SavedConsole.findOne({
          _id: new Types.ObjectId(options.id),
          workspaceId: new Types.ObjectId(workspaceId),
        });
      }
      if (!savedConsole) {
        savedConsole = await this.findSavedConsoleInScope(
          consoleName,
          options?.folderId ?? folderParts,
          workspaceId,
          { access: newAccess, ownerId: userId },
        );
      }

      if (savedConsole) {
        const role = options?.memberRole;
        if (
          !ConsoleManager.canWrite(
            savedConsole,
            userId,
            role === "owner" || role === "admin",
            role,
          )
        ) {
          throw new ConsoleScopeError(
            "This console is read-only. Create a copy to make changes.",
          );
        }
        if (savedConsole.is_deleted) {
          throw new ConsoleConflictError(
            "This console is deleted. Restore it before saving over it.",
          );
        }
        // Name, folder and access first, through the one relocation path.
        const moved = await this.relocateForSave(
          savedConsole,
          {
            path: consolePath,
            ...(options?.folderId ? { folderId: options.folderId } : {}),
            access: requestedAccess,
          },
          userId,
        );
        if (moved) savedConsole = moved.row;

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

        // A language change is a new extension, i.e. a new file: it must be
        // free like any other move. A first save (a draft, a row never
        // committed) must find its path free at commit time.
        const toPath = await repoPathForRow(savedConsole);
        if (savedConsole.path && toPath !== savedConsole.path) {
          await this.assertConsolePathFree(
            workspaceId,
            toPath,
            savedConsole._id,
          );
        }
        // Git first (apps.md §16.3): the file is the record, the row follows.
        const committed = await commitConsoleState({
          row: savedConsole,
          previousPath: savedConsole.path,
          actorUserId: userId,
          message: `save: ${consolePath}`,
          expectAbsent: !savedConsole.path,
        });
        savedConsole.path = committed.path;
        savedConsole.sourceBlobSha = committed.sourceBlobSha;
        await savedConsole.save();
      } else {
        // Create new console (explicitly saved), its folders in its scope.
        const folderId =
          options?.folderId ??
          (folderParts.length > 0
            ? await this.ensureFolderPath(folderParts, workspaceId, {
                access: newAccess,
                ownerId: userId,
              })
            : undefined);
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
          isPrivate: newAccess === "private",
          isSaved: true,
          executionCount: 0,
          access: newAccess,
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
          expectAbsent: true,
        });
        savedConsole.path = committed.path;
        savedConsole.sourceBlobSha = committed.sourceBlobSha;
        await savedConsole.save();
      }

      return savedConsole;
    } catch (error) {
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError ||
        error instanceof ConsoleScopeError
      ) {
        throw error;
      }
      logger.error("Error saving console to database", { error });
      throw error;
    }
  }

  /**
   * The live saved console named `name` in a folder chain, looked up IN A
   * SCOPE: a private save finds only the saver's own private console, a
   * workspace save only a workspace one. `folder` is a folder id or the
   * chain's names (not created when missing: then nothing is there).
   */
  private async findSavedConsoleInScope(
    name: string,
    folder: string | string[],
    workspaceId: string,
    scope: { access: ConsoleAccessLevel; ownerId: string },
  ): Promise<ISavedConsole | null> {
    const ws = new Types.ObjectId(workspaceId);
    let folderId: Types.ObjectId | undefined;
    if (typeof folder === "string") {
      if (!Types.ObjectId.isValid(folder)) return null;
      folderId = new Types.ObjectId(folder);
    } else {
      for (const segment of folder) {
        const found = (await ConsoleFolder.findOne({
          workspaceId: ws,
          name: segment,
          $and: [
            folderId
              ? { parentId: folderId }
              : { $or: [{ parentId: null }, { parentId: { $exists: false } }] },
            scope.access === "private"
              ? {
                  ownerId: scope.ownerId,
                  $or: [{ access: "private" }, { isPrivate: true }],
                }
              : { $nor: [{ access: "private" }, { isPrivate: true }] },
          ],
        })
          .select("_id")
          .lean()) as { _id: Types.ObjectId } | null;
        if (!found) return null;
        folderId = found._id;
      }
    }
    return SavedConsole.findOne({
      workspaceId: ws,
      name,
      isSaved: true,
      is_deleted: { $ne: true },
      $and: [
        folderId
          ? { folderId }
          : { $or: [{ folderId: null }, { folderId: { $exists: false } }] },
        scope.access === "private"
          ? {
              $or: [{ owner_id: scope.ownerId }, { createdBy: scope.ownerId }],
              $nor: [{ access: "workspace" }],
              isPrivate: { $ne: false },
            }
          : { $nor: [{ access: "private" }, { isPrivate: true }] },
      ],
    });
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
   * THE console rename/move: a new name, folder and/or access level applied
   * to the row and the file moved on the repo in ONE commit (the old file
   * goes in the same commit — brief rule 4). Every path that changes where
   * a console lives — the explorer's rename and "Move to…", the REST routes,
   * the agent's `modify_console` title and `rename_object` — ends here, so
   * the id, shares, schedule and telemetry never detach and the file never
   * moves twice.
   *
   * The file is moved AS IT IS AT MAIN (`commitConsoleRelocation`): a
   * rename never commits the row's working copy, which may hold an
   * unreviewed draft. The draft stays a draft. Only a saved console whose
   * file is missing from main is (re)projected from the row, since nothing
   * else defines it.
   *
   * Throws `ConsolePathTakenError` when another console already occupies
   * the target path — names are sanitized into file names, so two names
   * can mean one file, and a silent overwrite would lose the other
   * console's definition. Returns the updated row (and the commit, when
   * the file moved), or null when the console does not exist in the
   * workspace. A draft (unsaved) console is renamed in the index only; it
   * reaches git on its first save.
   */
  async relocateConsole(
    consoleId: string,
    workspaceId: string,
    change: {
      name?: string;
      /** `null` moves to the root; `undefined` leaves the folder alone. */
      folderId?: string | null;
      access?: ConsoleAccessLevel;
    },
    options: {
      userId?: string;
      /** Commit subject prefix: `<verb>: <new name>` (default `rename`). */
      verb?: "rename" | "move";
      /**
       * Poke `console.updated` subscribers (default). A caller that writes
       * more in the same step (`modify_console`) publishes once itself.
       */
      publish?: boolean;
      /** Bump `draftRevision` (default); the editor's save bumps it itself. */
      bumpRevision?: boolean;
    } = {},
  ): Promise<{ row: ISavedConsole; commit?: string } | null> {
    if (!Types.ObjectId.isValid(consoleId)) return null;
    // Two attempts: the first may find that a push reached main before its
    // sync ran (the row's file moved, vanished or changed there). The repo
    // is the truth, so the index is synced and the rename decided again
    // from the fresh row — never from a row the tree has moved on from.
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.relocateConsoleOnce(
        consoleId,
        workspaceId,
        change,
        options,
      );
      if (outcome !== "drift") return outcome;
      if (attempt > 0) {
        throw new ConsoleConflictError(
          "The console changed in the repository (a push is being synced). Reload and try again.",
        );
      }
      // No actor: an on-demand sync must not credit the caller with the
      // ownership of every unindexed console it happens to index.
      await syncConsolesIndexFromRepo(workspaceId);
    }
  }

  private async relocateConsoleOnce(
    consoleId: string,
    workspaceId: string,
    change: {
      name?: string;
      folderId?: string | null;
      access?: ConsoleAccessLevel;
    },
    options: {
      userId?: string;
      verb?: "rename" | "move";
      publish?: boolean;
      bumpRevision?: boolean;
    },
  ): Promise<{ row: ISavedConsole; commit?: string } | null | "drift"> {
    // A soft-deleted console is not renamed: it would be projected from its
    // row (its file is gone) — an unreviewed draft committed under a new
    // name — and come back to life. Restore it first.
    const current = await SavedConsole.findOne({
      _id: new Types.ObjectId(consoleId),
      workspaceId: new Types.ObjectId(workspaceId),
      is_deleted: { $ne: true },
    });
    if (!current) return null;

    // Who can see it is the row's access AND its folder chain (a private
    // console in a workspace folder is workspace-visible by inheritance).
    // Changing either — the row's `access`, or the EFFECTIVE visibility by
    // a move into / out of a workspace folder — is the owner's call; a
    // shared editor keeps the visibility the owner chose. Measured on the
    // row AS LOADED, before any change below is applied to it.
    const visibleBefore = await this.effectiveVisibility(current);
    const accessChanges =
      change.access !== undefined &&
      change.access !== ConsoleManager.resolveAccess(current);
    const probe = {
      ...(current.toObject() as unknown as Record<string, unknown>),
      ...(change.folderId !== undefined
        ? {
            folderId: change.folderId
              ? new Types.ObjectId(change.folderId)
              : undefined,
          }
        : {}),
      ...(change.access
        ? { access: change.access, isPrivate: change.access === "private" }
        : {}),
    } as unknown as ISavedConsole;
    const visibleAfter = await this.effectiveVisibility(probe);
    if (accessChanges || visibleBefore !== visibleAfter) {
      const ownerId = (current.owner_id || current.createdBy)?.toString();
      if (options.userId && ownerId !== options.userId) {
        throw new ConsoleScopeError();
      }
    }

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (change.name !== undefined) {
      current.name = change.name;
      updateFields.name = change.name;
    }
    if (change.folderId !== undefined) {
      current.folderId = change.folderId
        ? new Types.ObjectId(change.folderId)
        : undefined;
      updateFields.folderId = change.folderId
        ? new Types.ObjectId(change.folderId)
        : null;
    }
    if (change.access) {
      current.access = change.access;
      current.isPrivate = change.access === "private";
      updateFields.access = change.access;
      updateFields.isPrivate = change.access === "private";
    }
    let commit: string | undefined;
    if (current.isSaved) {
      const toPath = await repoPathForRow(current);
      const message = `${options.verb ?? "rename"}: ${current.name}`;
      if (toPath !== current.path) {
        await this.assertConsolePathFree(workspaceId, toPath, current._id);
      }
      if (!current.path) {
        // Never committed (a saved console from before adoption): the row
        // is the only definition — project it, as a save would.
        const committed = await commitConsoleState({
          row: current,
          actorUserId: options.userId,
          message,
        });
        updateFields.path = committed.path;
        updateFields.sourceBlobSha = committed.sourceBlobSha;
        if (!committed.unchanged) commit = committed.commitOid;
      } else if (toPath !== current.path) {
        let relocated: Awaited<ReturnType<typeof commitConsoleRelocation>>;
        try {
          relocated = await commitConsoleRelocation({
            workspaceId,
            fromPath: current.path,
            toPath,
            actorUserId: options.userId,
            message,
            sourceBlobSha: current.sourceBlobSha ?? null,
          });
        } catch (error) {
          if (!(error instanceof BlobPreconditionError)) throw error;
          // The commit's compare-and-swap is the guarantee the pre-check
          // above cannot give: the target appeared (another rename won the
          // race, or a laptop push landed it) → taken. The source is not
          // the blob the row knows (a push edited or moved it, not yet
          // synced; or a save raced the rename) → let the caller sync and
          // decide again from the fresh row.
          if (
            error.path === toPath ||
            error.path === chartSidecarPath(toPath)
          ) {
            throw new ConsolePathTakenError(error.path);
          }
          return "drift";
        }
        // No file at the row's path: a push moved or removed it and the
        // sync has not run. Never project the row's draft in its place.
        if (!relocated) return "drift";
        updateFields.path = relocated.path;
        updateFields.sourceBlobSha = relocated.sourceBlobSha;
        if (!relocated.unchanged) commit = relocated.commitOid;
      }
      // A soft-deleted row that still points at the new path would be
      // restored onto this console's file by the next sync; it has lost
      // its place for good (a restore picks a free name).
      if (updateFields.path) {
        await SavedConsole.updateMany(
          {
            workspaceId: new Types.ObjectId(workspaceId),
            path: updateFields.path,
            _id: { $ne: current._id },
            is_deleted: true,
          },
          { $unset: { path: "" } },
        );
      }
    }

    // Bump the draft revision so revision-sync catches the rename, then
    // poke subscribers (other tabs/users update the tab title live). A
    // caller whose own guarded write follows (the editor's save) keeps
    // the revision for that write to bump.
    const updated = await SavedConsole.findOneAndUpdate(
      {
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
      },
      options.bumpRevision === false
        ? { $set: updateFields }
        : { $set: updateFields, $inc: { draftRevision: 1 } },
      { new: true },
    );
    if (!updated) return null;
    if (options.publish !== false) {
      publishRealtimeEvent(workspaceId, {
        type: "console.updated",
        consoleId,
        draftRevision: updated.draftRevision ?? 1,
        name: updated.name,
        updatedBy: options.userId ?? "agent",
        origin: "save",
      });
    }
    return { row: updated, commit };
  }

  /**
   * Where a save, a rename or a sharing change puts an EXISTING console —
   * decided here for every route that takes a name, a `Folder/Sub/name`
   * path or an access level, so no route resolves a folder or a scope on
   * its own:
   *
   * - `access` is what the client shows: the EFFECTIVE visibility. Equal to
   *   the console's current one it asks for nothing (the row keeps its own
   *   access); different, it is a re-scope — the owner's call, refused here
   *   before any folder is created for it.
   * - A folder chain is found-or-created IN A SCOPE: the new visibility on a
   *   re-scope, else the current one, under the console's owner. Looked up
   *   by name alone, a private console's "Team" was the workspace folder of
   *   that name — and a folder publishes what it holds by inheritance.
   * - The chain the console already has keeps its folder: a plain Cmd+S
   *   never re-homes a console into a namesake folder of another scope.
   *
   * Nothing is written to the row; `relocateConsole` applies the result
   * (and re-checks the owner rule on the effective visibility).
   */
  async placeConsole(
    existing: ISavedConsole,
    request: ConsolePlacementRequest,
    userId: string,
  ): Promise<{
    name: string;
    folderId: string | null;
    /** Set on a re-scope only; undefined keeps the row's access. */
    access?: ConsoleAccessLevel;
    /** Whether anything differs from the row as loaded. */
    changes: boolean;
  }> {
    const workspaceId = existing.workspaceId.toString();
    const ownerId = (existing.owner_id || existing.createdBy)?.toString();
    const visibleNow = await this.effectiveVisibility(existing);
    const reScope =
      request.access !== undefined && request.access !== visibleNow;
    if (reScope && ownerId !== userId) throw new ConsoleScopeError();
    const access = reScope ? request.access : undefined;

    let name = existing.name;
    let wanted: string[] | undefined;
    if (request.path !== undefined) {
      const parts = request.path.split("/");
      name = parts[parts.length - 1];
      wanted = parts.slice(0, -1);
    } else if (request.name !== undefined) {
      name = request.name;
    }

    const currentFolderId = existing.folderId?.toString() ?? null;
    let folderId = currentFolderId;
    if (request.folderId !== undefined) {
      folderId = request.folderId;
    } else {
      const current = await folderSegmentsFor(existing.folderId, workspaceId);
      const chain = wanted ?? current;
      const sameChain =
        chain.length === current.length &&
        chain.every((segment, i) => segment === current[i]);
      // A re-scope re-files the console in the new scope's namesake chain
      // (the owner's private "Team", or the workspace "Team").
      if (reScope || !sameChain) {
        folderId =
          chain.length === 0
            ? null
            : ((
                await ensureFolderChain(chain, workspaceId, {
                  access: access ?? visibleNow,
                  ownerId: ownerId ?? userId,
                })
              )?.toString() ?? null);
      }
    }

    const changes =
      name !== existing.name ||
      folderId !== currentFolderId ||
      (access !== undefined &&
        access !== ConsoleManager.resolveAccess(existing));
    return { name, folderId, access, changes };
  }

  /**
   * Apply a placement request to an existing console: `placeConsole`, then
   * `relocateConsole` — free-path check (a laptop-pushed file with no row
   * included), compare-and-swap commit, owner-only rule on the EFFECTIVE
   * visibility. The editor's save calls it before projecting content (by
   * default quietly, its own guarded write bumps the revision); a rename or
   * a sharing change passes its own reporting options. A draft is placed in
   * the index only. Returns null when nothing changes.
   */
  async relocateForSave(
    existing: ISavedConsole,
    request: ConsolePlacementRequest,
    userId: string,
    options: RelocateOptions = {
      verb: "move",
      publish: false,
      bumpRevision: false,
    },
  ): Promise<{ row: ISavedConsole; commit?: string } | null> {
    const placed = await this.placeConsole(existing, request, userId);
    if (!placed.changes) return null;
    const moved = await this.relocateConsole(
      existing._id.toString(),
      existing.workspaceId.toString(),
      { name: placed.name, folderId: placed.folderId, access: placed.access },
      { userId, ...options },
    );
    if (!moved) {
      throw new ConsoleConflictError(
        "This console was deleted meanwhile. Reload and try again.",
      );
    }
    return moved;
  }

  /**
   * Who can see a console: "workspace" when its own access is workspace OR
   * any folder on its chain is a workspace folder (the inheritance rule
   * `canReadWithInheritance` applies), else "private".
   */
  async effectiveVisibility(console: {
    access?: ConsoleAccessLevel | null;
    isPrivate?: boolean | null;
    folderId?: Types.ObjectId | string | null;
  }): Promise<ConsoleAccessLevel> {
    if (
      ConsoleManager.resolveAccess(console as unknown as ISavedConsole) ===
      "workspace"
    ) {
      return "workspace";
    }
    let currentFolderId = console.folderId?.toString();
    for (let depth = 0; currentFolderId && depth < 32; depth++) {
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
      if (folderAccess === "workspace") return "workspace";
      currentFolderId = folder.parentId?.toString();
    }
    return "private";
  }

  /** Throw `ConsolePathTakenError` when a file or a live saved row holds `path`. */
  private async assertConsolePathFree(
    workspaceId: string,
    path: string,
    self: Types.ObjectId,
  ): Promise<void> {
    const [def, row] = await Promise.all([
      readConsoleDefinitionAtMain(workspaceId, path),
      SavedConsole.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        path,
        _id: { $ne: self },
        isSaved: true,
        is_deleted: { $ne: true },
      }).select("_id"),
    ]);
    if (def || row) throw new ConsolePathTakenError(path);
  }

  /**
   * Rename a console. A `Folder/Sub/name` value also moves it into that
   * folder chain — found or created in the console's own visibility scope
   * (`placeConsole`), in the same commit. A plain name keeps the folder.
   */
  async renameConsole(
    consoleId: string,
    newName: string,
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    try {
      if (!Types.ObjectId.isValid(consoleId)) return false;
      const current = await SavedConsole.findOne({
        _id: new Types.ObjectId(consoleId),
        workspaceId: new Types.ObjectId(workspaceId),
        is_deleted: { $ne: true },
      });
      if (!current) return false;
      await this.relocateForSave(
        current,
        newName.includes("/") ? { path: newName } : { name: newName },
        userId,
        { verb: "rename" },
      );
      return true;
    } catch (error) {
      if (
        error instanceof RepoRequiredError ||
        error instanceof ConsoleConflictError ||
        error instanceof ConsoleScopeError
      ) {
        throw error;
      }
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
      await this.syncSubtreeIfDrifted(folderId, workspaceId);
      const previousName = folder.name;
      folder.name = newName;
      await folder.save();
      try {
        await this.assertFolderSubtreePathsFree(folderId, workspaceId);
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
        error instanceof BlobPreconditionError ||
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

  /**
   * What a folder operation must be able to put back: the access of every
   * console and folder under it. The folder's own row is restored by the
   * operation. A refused move (a target file held by someone else, a
   * concurrent save) that left the rows re-scoped in Mongo while their
   * files stayed where they were would make a private console readable by
   * the workspace, and the next plain save would project it onto the other
   * console's file.
   */
  private async folderSubtreeAccessSnapshot(
    folderId: string,
    workspaceId: string,
  ): Promise<{
    rows: Array<{
      _id: Types.ObjectId;
      access?: ConsoleAccessLevel;
      isPrivate?: boolean;
    }>;
    folders: Array<{
      _id: Types.ObjectId;
      access?: ConsoleAccessLevel;
      isPrivate?: boolean;
    }>;
  }> {
    const wid = new Types.ObjectId(workspaceId);
    const rows = (await this.consolesUnderFolder(folderId, workspaceId)).map(
      r => ({ _id: r._id, access: r.access, isPrivate: r.isPrivate }),
    );
    const folders: Array<{
      _id: Types.ObjectId;
      access?: ConsoleAccessLevel;
      isPrivate?: boolean;
    }> = [];
    const queue = [folderId];
    while (queue.length > 0) {
      const children = await ConsoleFolder.find({
        workspaceId: wid,
        parentId: new Types.ObjectId(queue.shift() as string),
      }).select("access isPrivate");
      for (const child of children) {
        folders.push({
          _id: child._id,
          access: child.access,
          isPrivate: child.isPrivate,
        });
        queue.push(child._id.toString());
      }
    }
    return { rows, folders };
  }

  private async restoreFolderSubtreeAccess(snapshot: {
    rows: Array<{
      _id: Types.ObjectId;
      access?: ConsoleAccessLevel;
      isPrivate?: boolean;
    }>;
    folders: Array<{
      _id: Types.ObjectId;
      access?: ConsoleAccessLevel;
      isPrivate?: boolean;
    }>;
  }): Promise<void> {
    for (const row of snapshot.rows) {
      await SavedConsole.updateOne(
        { _id: row._id },
        { $set: { access: row.access, isPrivate: row.isPrivate } },
      );
    }
    for (const folder of snapshot.folders) {
      await ConsoleFolder.updateOne(
        { _id: folder._id },
        { $set: { access: folder.access, isPrivate: folder.isPrivate } },
      );
    }
  }

  /**
   * Before a folder operation re-projects its consoles: every destination
   * path must be free — a file at main (a laptop-pushed console with no
   * row included) or a live row outside the subtree refuses it with a
   * human `ConsolePathTakenError`, before Mongo changes, rather than the
   * commit's compare-and-swap refusing it afterwards. Called AFTER the
   * folder row carries its new name/parent/access, so the paths are the
   * ones the commit would write; `access`, when given, is what the rows
   * are about to be set to.
   */
  private async assertFolderSubtreePathsFree(
    folderId: string,
    workspaceId: string,
    nextAccess?: (row: ISavedConsole) => ConsoleAccessLevel | undefined,
  ): Promise<void> {
    const rows = await this.consolesUnderFolder(folderId, workspaceId);
    if (rows.length === 0) return;
    const [defs, outside] = await Promise.all([
      listConsoleDefinitionsAtMain(workspaceId),
      SavedConsole.find({
        workspaceId: new Types.ObjectId(workspaceId),
        _id: { $nin: rows.map(r => r._id) },
        isSaved: true,
        is_deleted: { $ne: true },
        path: { $exists: true, $ne: null },
      }).select("path"),
    ]);
    const ownPaths = new Set(rows.map(r => r.path).filter(Boolean));
    const taken = new Set<string>([
      ...defs.map(d => d.path).filter(p => !ownPaths.has(p)),
      ...outside.map(r => r.path as string),
    ]);
    const folderCache = new Map();
    // Two consoles INSIDE the subtree landing on one path (two owners' "x"
    // meeting in the workspace tree) is a merge the commit's CAS cannot
    // see: refused here, as a taken path.
    const chosen = new Set<string>();
    for (const row of rows) {
      const access = nextAccess?.(row);
      const probe = {
        ...(row.toObject() as Record<string, unknown>),
        ...(access ? { access, isPrivate: access === "private" } : {}),
      } as unknown as RowLikeForPath;
      const wanted = await repoPathForRow(probe, folderCache);
      if ((wanted !== row.path && taken.has(wanted)) || chosen.has(wanted)) {
        throw new ConsolePathTakenError(wanted);
      }
      chosen.add(wanted);
    }
  }

  /**
   * A folder flipped to the workspace publishes every console under it by
   * inheritance — so only the actor's own private consoles may be there;
   * someone else's private console (shared with the actor, filed into the
   * actor's folder) is not theirs to publish, and the move is refused
   * rather than leaving it private-but-visible. A flip to private
   * re-scopes only the actor's own consoles (others keep their scope and
   * their files), exactly as `propagateFolderAccess` has always done.
   */
  private async assertFolderScopeFlipAllowed(
    folderId: string,
    workspaceId: string,
    access: ConsoleAccessLevel,
    actorId: string | undefined,
  ): Promise<void> {
    if (access !== "workspace" || !actorId) return;
    const rows = await this.consolesUnderFolder(folderId, workspaceId);
    for (const row of rows) {
      const ownerId = (row.owner_id || row.createdBy)?.toString();
      if (
        ConsoleManager.resolveAccess(row) === "private" &&
        ownerId !== actorId
      ) {
        throw new ConsoleScopeError();
      }
    }
  }

  /** The access a folder-level flip gives one console: the actor's own only. */
  private ownedRescope(
    access: ConsoleAccessLevel | undefined,
    actorId: string | undefined,
  ): (row: ISavedConsole) => ConsoleAccessLevel | undefined {
    return row => {
      if (!access) return undefined;
      const ownerId = (row.owner_id || row.createdBy)?.toString();
      return !actorId || ownerId === actorId ? access : undefined;
    };
  }

  /**
   * Before a folder is renamed, moved or re-scoped in Mongo: if a push
   * reached main that the index has not taken in for any console under it
   * (file moved, removed or edited there), sync first. Syncing AFTER the
   * folder changed would re-home those rows under the tree's old folder
   * name — a freshly created folder — and strand the renamed one.
   */
  private async syncSubtreeIfDrifted(
    folderId: string,
    workspaceId: string,
  ): Promise<void> {
    const rows = await this.consolesUnderFolder(folderId, workspaceId);
    if (rows.length === 0) return;
    if (await consoleFilesDrifted(workspaceId, rows)) {
      // No actor (see relocateConsole): the caller owns nothing by syncing.
      await syncConsolesIndexFromRepo(workspaceId);
    }
  }

  /** Re-commit every console under a folder at its (possibly new) path. */
  private async reprojectFolderSubtree(
    folderId: string,
    workspaceId: string,
    userId: string | undefined,
    message: string,
  ): Promise<void> {
    // Each file moves AS IT IS AT MAIN (drafts stay drafts) under one CAS
    // commit. Drift (a push under the folder not yet synced) was taken in
    // by `syncSubtreeIfDrifted` before the folder changed in Mongo; a
    // refusal here is a concurrent save or push and surfaces as a 409 with
    // the folder rows left untouched.
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
        sourceBlobSha: row.sourceBlobSha ?? null,
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
      if (
        error instanceof RepoRequiredError ||
        error instanceof BlobPreconditionError ||
        error instanceof ConsoleConflictError
      ) {
        throw error;
      }
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
   * Find-or-create a folder chain by name IN THE CONSOLE'S SCOPE: a private
   * console's `Team/x` is the owner's private "Team", a workspace console's
   * is the workspace "Team". Looking a folder up by name alone picked the
   * workspace namesake for a private console — and a folder publishes what
   * it holds by inheritance, so a plain save or rename changed who could
   * read it. Delegates to the service's scoped `ensureFolderChain`.
   */
  private async ensureFolderPath(
    folderParts: string[],
    workspaceId: string,
    scope: { access: ConsoleAccessLevel; ownerId: string },
  ): Promise<string | undefined> {
    if (folderParts.length === 0) {
      return undefined;
    }
    const id = await ensureFolderChain(folderParts, workspaceId, scope);
    return id?.toString();
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
   * optionally changing its access and its name in the same commit — the
   * explorer's "Move to…" lets the user rename while moving, and that must
   * be one commit, not a rename followed by a move.
   */
  async moveConsole(
    consoleId: string,
    workspaceId: string,
    folderId: string | null,
    access?: ConsoleAccessLevel,
    userId?: string,
    name?: string,
  ): Promise<boolean> {
    const updated = await this.relocateConsole(
      consoleId,
      workspaceId,
      { folderId, access, name: name?.trim() || undefined },
      { userId, verb: "move" },
    );
    return updated !== null;
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
    await this.syncSubtreeIfDrifted(folderId, workspaceId);

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

    // Who sees the folder's contents before and after: a parent change
    // alone can publish them by inheritance (a drag under a workspace
    // folder sends no `access`), and an explicit `access: "private"` does
    // not make a folder under a workspace parent private. Measured on the
    // folder chain, before any row changes.
    const ownBefore: ConsoleAccessLevel =
      before.access ?? (before.isPrivate ? "private" : "workspace");
    const visibleBefore = await this.effectiveVisibility({
      access: ownBefore,
      folderId: before.parentId ?? undefined,
    });
    const visibleAfter = await this.effectiveVisibility({
      access: access ?? ownBefore,
      folderId: newParentId ? new Types.ObjectId(newParentId) : undefined,
    });
    const publishes =
      access === "workspace" ||
      (visibleBefore === "private" && visibleAfter === "workspace");

    const result = await ConsoleFolder.updateOne(
      {
        _id: new Types.ObjectId(folderId),
        workspaceId: new Types.ObjectId(workspaceId),
      },
      { $set: updateFields },
    );
    if (result.modifiedCount === 0) return false;

    const snapshot = await this.folderSubtreeAccessSnapshot(
      folderId,
      workspaceId,
    );
    try {
      // Destinations free, and the publication the actor's to make? Asked
      // with the folder's new parent/access in place and BEFORE any
      // console row changes — the same rule as an access flip: only the
      // actor's own private consoles may be published by the folder.
      if (publishes) {
        await this.assertFolderScopeFlipAllowed(
          folderId,
          workspaceId,
          "workspace",
          userId,
        );
      }
      await this.assertFolderSubtreePathsFree(
        folderId,
        workspaceId,
        this.ownedRescope(access, userId),
      );
      if (access) {
        // A folder's access moves ITS OWNER'S consoles between the
        // workspace and the private root (apps.md §16.2); another member's
        // console filed here keeps the scope its owner chose.
        await SavedConsole.updateMany(
          {
            workspaceId: new Types.ObjectId(workspaceId),
            folderId: new Types.ObjectId(folderId),
            ...(userId
              ? { $or: [{ owner_id: userId }, { createdBy: userId }] }
              : {}),
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
      // Nothing moved in git: put every row and folder back as they were,
      // so no console says "workspace" while its file is still private.
      await this.restoreFolderSubtreeAccess(snapshot);
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
    // Only a deleted console is restored: on a live one this would be a
    // commit of the row's working copy under the guise of a restore.
    if (!current.is_deleted) return false;
    const set: Record<string, unknown> = { is_deleted: false };
    if (current.isSaved) {
      // The console's old name may have been taken while it was deleted (a
      // rename or a push landed there, and the sync released this row's
      // path): a restore must not overwrite that file — it comes back as
      // "name (2)", exactly as adoption resolves two rows on one path.
      const freeName = await this.freeNameFor(current, current.path);
      if (freeName !== current.name) {
        current.name = freeName;
        set.name = freeName;
      }
      // What comes back is the file as it was LAST COMMITTED (its blob is
      // still in the object store), never the row's working copy — an
      // unsaved draft must not reach main through a restore. A row that
      // was never committed (no blob) is projected, as its only definition.
      const committed = await restoreConsoleBlob({
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
   * The name a row can take without landing on another console's file
   * (one at main, or a live row's): its own, or "name (2)", "name (3)"… —
   * the way adoption resolves two rows on one path.
   */
  private async freeNameFor(
    row: ISavedConsole,
    ownPath: string | null | undefined,
  ): Promise<string> {
    const workspaceId = row.workspaceId.toString();
    const wanted = await repoPathForRow(row);
    const [defs, liveRows] = await Promise.all([
      listConsoleDefinitionsAtMain(workspaceId),
      SavedConsole.find({
        workspaceId: new Types.ObjectId(workspaceId),
        _id: { $ne: row._id },
        isSaved: true,
        is_deleted: { $ne: true },
        path: { $exists: true, $ne: null },
      }).select("path"),
    ]);
    const taken = new Set<string>([
      ...defs.map(d => d.path),
      ...liveRows.map(r => r.path as string),
    ]);
    const free = uniquePath(wanted, taken, ownPath);
    if (free === wanted) return row.name;
    return parseConsoleRepoPath(free)?.name ?? row.name;
  }

  /**
   * Duplicate a console: creates a copy with " copy" appended to the name
   * (" copy (2)" when that file is taken — a second copy must not land on
   * the first one's file). The caller checks the original is readable.
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
    copy.name = await this.freeNameFor(copy, null);
    const committed = await commitConsoleState({
      row: copy,
      actorUserId: userId,
      message: `duplicate: ${original.name}`,
      expectAbsent: true,
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
