/**
 * Reading consoles: the explorer tree (my / shared-with-workspace), the flat
 * list for API clients, and one console with its metadata. Saved consoles
 * come from git at main (Mongo is the overlay: ACL, runtime stats); drafts
 * are the Mongo working copy. No GitHub binding → empty, never 412.
 */
import { Types } from "mongoose";
import type { ConsoleAccessLevel } from "../../database/workspace-schema";
import {
  consolesChartsRepo,
  type ConsoleFolderRecord,
  type SavedConsoleRecord,
} from "../../repositories/consoles-charts";
import { getLogger } from "../../logging";
import { sortTreeNodes } from "../../utils/folder-tree";
import { FolderChainCache } from "../../utils/folder-chain";
import {
  descriptionIsAuthored,
  loadLiveConsoleById,
  loadLiveConsoles,
  type LiveConsole,
} from "../../apps/workspace-consoles.service";
import { RepoRequiredError } from "../../apps/config";
import { boundRepoDirIfExists } from "../../apps/workspace-repo-required";
import {
  canReadConsole,
  isConsoleCollaborator,
  legacyAccess,
  resolveConsoleAccess,
  resolveConsoleAccessWithInheritance,
} from "./access";
import { getFolderPathById } from "./folders";

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
  folders: ConsoleFolderRecord[],
): string | undefined {
  if (live.row?.folderId) return live.row.folderId;
  const segments = live.location.folderSegments;
  if (segments.length === 0) return undefined;
  let parentId: string | undefined;
  let found: ConsoleFolderRecord | undefined;
  for (const name of segments) {
    found = folders.find(folder => {
      const sameName = folder.name === name;
      const parent = folder.parentId;
      return sameName && (parentId ? parent === parentId : !parent);
    });
    if (!found) return undefined;
    parentId = found.id;
  }
  return found?.id;
}

/**
 * Git definition + store overlay, shaped like a SavedConsoleRecord so the
 * existing tree/ACL helpers stay unchanged. `code` and front-matter always
 * come from the file; a missing overlay row does not hide the console.
 */
function liveConsoleToRow(
  live: LiveConsole,
  folderId: string | undefined,
  workspaceId: string,
): SavedConsoleRecord {
  const loc = live.location;
  const access: ConsoleAccessLevel =
    loc.scope === "private" ? "private" : "workspace";
  const ownerId =
    loc.ownerId || live.row?.owner_id || live.row?.createdBy || "git";
  // A row synced from this blob holds the connection the reactor kept: a
  // foreign or deleted id in the file is already dropped there.
  const rowInSync = live.row?.sourceBlobSha === live.oid;
  const connectionId = rowInSync
    ? (live.row?.connectionId ?? undefined)
    : live.parsed.meta.connectionId &&
        Types.ObjectId.isValid(live.parsed.meta.connectionId)
      ? live.parsed.meta.connectionId
      : live.row?.connectionId;
  const authored = live.parsed.meta.description;
  const generated =
    live.row && !descriptionIsAuthored(live.row)
      ? live.row.description
      : undefined;
  const id = live.id.toString();
  const now = new Date();
  return {
    id,
    _id: id,
    workspaceId: live.row?.workspaceId ?? workspaceId,
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
    mongoOptions:
      (live.parsed.meta.mongoOptions as SavedConsoleRecord["mongoOptions"]) ??
      live.row?.mongoOptions,
    isPrivate: access === "private",
    isSaved: true,
    access,
    owner_id: live.row?.owner_id || ownerId,
    createdBy: live.row?.createdBy || ownerId,
    sharedWith: live.row?.sharedWith ?? [],
    workspaceRole: live.row?.workspaceRole ?? "viewer",
    schedule: live.row?.schedule,
    scheduledRun: live.row?.scheduledRun,
    version: live.row?.version ?? 1,
    draftRevision: live.row?.draftRevision ?? 1,
    lastDraftOrigin: live.row?.lastDraftOrigin,
    lastRun: live.row?.lastRun,
    lastExecutedAt: live.row?.lastExecutedAt,
    executionCount: live.row?.executionCount ?? 0,
    lastExternalUsedAt: live.row?.lastExternalUsedAt,
    externalUseCount: live.row?.externalUseCount ?? 0,
    lastExternalSource: live.row?.lastExternalSource,
    is_deleted: live.row?.is_deleted ?? false,
    deletedAt: live.row?.deletedAt,
    createdAt: live.row?.createdAt ?? now,
    updatedAt: live.row?.updatedAt ?? now,
  };
}

function metadataFromRow(
  savedConsole: SavedConsoleRecord,
  consolePath: string,
) {
  return {
    content: savedConsole.code,
    connectionId: savedConsole.connectionId?.toString(),
    databaseName: savedConsole.databaseName,
    databaseId: savedConsole.databaseId,
    language: savedConsole.language,
    id: savedConsole.id,
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
 * Saved-console tree from git at main. Store row is overlay (ACL, lastRun).
 * No GitHub binding → empty list, even if leftover store or local git
 * exists. Drafts never appear here.
 */
export async function listConsoles(
  workspaceId: string,
  userId?: string,
): Promise<ConsoleFile[]> {
  try {
    const bound = await boundRepoDirIfExists(workspaceId);
    if (bound == null) return [];

    const [folders, live] = await Promise.all([
      consolesChartsRepo.listConsoleFolders(workspaceId, { sortByName: true }),
      loadLiveConsoles(workspaceId),
    ]);
    const consoles = live.map(item =>
      liveConsoleToRow(item, folderIdForLive(item, folders), workspaceId),
    );

    const visibleConsoles = userId
      ? consoles.filter(c => canReadConsole(c, userId))
      : consoles;

    return buildConsoleTree(folders, visibleConsoles);
  } catch (error) {
    if (error instanceof RepoRequiredError) throw error;
    logger.error("Error listing consoles from git", { error });
    throw error;
  }
}

/**
 * Flat list for API clients: live saved consoles from git, plus drafts
 * when a repo is bound. Unbound → empty.
 */
export async function listConsolesFlat(
  workspaceId: string,
  userId?: string,
): Promise<SavedConsoleRecord[]> {
  const bound = await boundRepoDirIfExists(workspaceId);
  if (bound == null) return [];
  const [folders, live, drafts] = await Promise.all([
    consolesChartsRepo.listConsoleFolders(workspaceId),
    loadLiveConsoles(workspaceId),
    consolesChartsRepo.listConsolesByWorkspace(workspaceId, {
      draftsOnly: true,
      excludeDeleted: true,
      sortBy: "updatedAtDesc",
    }),
  ]);
  const saved = live.map(item =>
    liveConsoleToRow(item, folderIdForLive(item, folders), workspaceId),
  );
  const all = [...saved, ...drafts];
  const visible = userId ? all.filter(doc => canReadConsole(doc, userId)) : all;
  return visible.sort(
    (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
  );
}

/**
 * Build a tree from folders and consoles, preserving hierarchy.
 */
function buildConsoleTree(
  folders: ConsoleFolderRecord[],
  consoles: SavedConsoleRecord[],
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
      id: folder.id,
      folderId: folder.id,
      isPrivate: folder.isPrivate,
      owner_id: folder.ownerId,
      access: legacyAccess(folder),
      createdAt: folder.createdAt,
    };
    folderMap.set(folder.id, folderItem);
    if (!folder.parentId) {
      rootItems.push(folderItem);
    }
  }

  for (const folder of folders) {
    if (folder.parentId) {
      const parent = folderMap.get(folder.parentId);
      const child = folderMap.get(folder.id);
      if (parent && child && parent.children) {
        parent.children.push(child);
        child.path = `${parent.path}/${child.name}`;
      }
    }
  }

  for (const console of consoles) {
    const consoleItem: ConsoleFile = {
      path: console.folderId
        ? `${folderPathOf(console.folderId, folderMap)}/${console.name}`
        : console.name,
      name: console.name,
      content: console.code,
      isDirectory: false,
      id: console.id,
      connectionId: console.connectionId,
      databaseName: console.databaseName,
      databaseId: console.databaseId,
      language: console.language,
      description: console.description,
      isPrivate: console.isPrivate,
      lastExecutedAt: console.lastExecutedAt,
      executionCount: console.executionCount,
      access: resolveConsoleAccess(console),
      owner_id: console.owner_id || console.createdBy,
    };

    if (console.folderId) {
      const folder = folderMap.get(console.folderId);
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
 * Helper to get folder path from folder map
 */
function folderPathOf(
  folderId: string,
  folderMap: Map<string, ConsoleFile>,
): string {
  const folder = folderMap.get(folderId);
  if (!folder) return "";

  // If folder has parent, get full path recursively
  return folder.path;
}

/**
 * List consoles split into 2 groups: myConsoles and sharedWithWorkspace.
 *
 * Items inherit access from their parent folder. A console inside a
 * "workspace" folder is workspace-visible regardless of the console's own
 * access field. This lets users move items between sections by simply
 * moving them into/out of shared folders — no access field update needed.
 */
export async function listConsolesSplit(
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
      consolesChartsRepo.listConsoleFolders(workspaceId, { sortByName: true }),
      loadLiveConsoles(workspaceId),
    ]);
    const consoles = live.map(item =>
      liveConsoleToRow(item, folderIdForLive(item, folders), workspaceId),
    );

    const folderById = new Map<string, ConsoleFolderRecord>();
    for (const f of folders) {
      folderById.set(f.id, f);
    }

    // Walk up the folder chain; workspace wins over private.
    const effectiveAccess = (
      ownAccess: ConsoleAccessLevel,
      folderId?: string,
    ): ConsoleAccessLevel => {
      if (ownAccess === "workspace") return "workspace";
      let currentFolderId = folderId;
      while (currentFolderId) {
        const folder = folderById.get(currentFolderId);
        if (!folder) break;
        if (legacyAccess(folder) === "workspace") return "workspace";
        currentFolderId = folder.parentId;
      }
      return "private";
    };

    const classify = (
      ownAccess: ConsoleAccessLevel,
      ownerId: string | undefined,
      folderId?: string,
    ): "my" | "workspace" | null => {
      const access = effectiveAccess(ownAccess, folderId);
      if (access === "workspace") return "workspace";
      if (ownerId === userId) return "my";
      return null;
    };

    const myConsolesRaw: SavedConsoleRecord[] = [];
    const sharedWithWorkspaceRaw: SavedConsoleRecord[] = [];

    for (const c of consoles) {
      const ownerId = (c.owner_id || c.createdBy)?.toString();
      const ownAccess = resolveConsoleAccess(c);
      let section = classify(ownAccess, ownerId, c.folderId);
      // Private consoles shared explicitly with this user surface in the
      // shared section so collaborators can find them.
      if (section === null && isConsoleCollaborator(c, userId)) {
        section = "workspace";
      }
      if (section === "my") myConsolesRaw.push(c);
      else if (section === "workspace") sharedWithWorkspaceRaw.push(c);
    }

    const myFolders: ConsoleFolderRecord[] = [];
    const sharedWithWorkspaceFolders: ConsoleFolderRecord[] = [];

    for (const f of folders) {
      const ownerId = f.ownerId?.toString();
      const section = classify(legacyAccess(f), ownerId, f.parentId);
      if (section === "my") myFolders.push(f);
      else if (section === "workspace") sharedWithWorkspaceFolders.push(f);
    }

    return {
      myConsoles: buildConsoleTree(myFolders, myConsolesRaw),
      sharedWithWorkspace: buildConsoleTree(
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
 * GET a console by id. Drafts are the working copy; saved consoles
 * are live only when the file exists at main.
 */
export async function getConsoleWithMetadata(
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
  mongoOptions?: SavedConsoleRecord["mongoOptions"];
  access?: ConsoleAccessLevel;
  owner_id?: string;
  _raw?: SavedConsoleRecord;
} | null> {
  try {
    if (!Types.ObjectId.isValid(consoleId)) {
      logger.error("Invalid console ID", { consoleId });
      return null;
    }

    const found = await loadLiveConsoleById(workspaceId, consoleId);
    if (!found) return null;

    const folderCache = FolderChainCache.forWorkspace(workspaceId);
    if ("draft" in found) {
      const savedConsole = found.draft;
      let consolePath = savedConsole.name;
      if (savedConsole.folderId) {
        const folderPath = await getFolderPathById(
          savedConsole.folderId,
          workspaceId,
          folderCache,
        );
        if (folderPath) {
          consolePath = `${folderPath}/${savedConsole.name}`;
        }
      }
      const effectiveAccess = await resolveConsoleAccessWithInheritance(
        savedConsole,
        { folders: folderCache },
      );
      return {
        ...metadataFromRow(savedConsole, consolePath),
        access: effectiveAccess,
      };
    }

    const live = found.live;
    const folders = await consolesChartsRepo.listConsoleFolders(workspaceId);
    folderCache.seed(folders);
    const row = liveConsoleToRow(
      live,
      folderIdForLive(live, folders),
      workspaceId,
    );
    const displayPath = live.location.folderSegments.length
      ? `${live.location.folderSegments.join("/")}/${live.location.name}`
      : live.location.name;
    const effectiveAccess = await resolveConsoleAccessWithInheritance(row, {
      folders: folderCache,
    });
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
