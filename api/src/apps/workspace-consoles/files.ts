/**
 * Row ↔ file: where a console row lives in the workspace repo (folder chain
 * → directories, private scope → `users/<handle>/consoles/`), and what its
 * file carries (the authored state, plus the chart sidecar). Pure mapping
 * plus the folder lookups it needs; no commits.
 */
import { Types } from "mongoose";
import type {
  ConsoleAccessLevel,
  ISavedConsole,
} from "../../database/workspace-schema";
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import type { OwnerDirectory } from "../user-handles";
import { ownerDirectoryFor } from "../user-handles.service";
import { requireWorkspaceRepo } from "../workspace-repo-required";
import {
  CONSOLES_README_PATH,
  chartSidecarPath,
  consoleRepoPath,
  serializeChartSpec,
  serializeConsoleFile,
  type ConsoleFileState,
  type ConsoleLanguage,
} from "../console-files";
import { DEFAULT_BRANCH, readBlob } from "../repository.service";

export const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

// ---------------------------------------------------------------------------
// Folders ↔ directories
// ---------------------------------------------------------------------------

export type FolderLean = {
  _id: Types.ObjectId | string;
  name: string;
  parentId?: Types.ObjectId | string | null;
};

/** The folder chain of a console as path segments, root first. */
export async function folderSegmentsFor(
  folderId: Types.ObjectId | string | undefined | null,
  workspaceId: string,
  cache: Map<string, FolderLean | null> = new Map(),
): Promise<string[]> {
  const segments: string[] = [];
  let current = folderId ? folderId.toString() : null;
  for (let depth = 0; current && depth < 32; depth++) {
    let folder = cache.get(current);
    if (folder === undefined) {
      const found = await consolesChartsRepo.findConsoleFolderById(
        workspaceId,
        current,
      );
      folder = found
        ? {
            _id: found.id,
            name: found.name,
            parentId: found.parentId ?? null,
          }
        : null;
      cache.set(current, folder);
    }
    if (!folder) break;
    segments.unshift(folder.name);
    current = folder.parentId ? folder.parentId.toString() : null;
  }
  return segments;
}

/**
 * Find-or-create the folder chain for a directory. Folders are organization,
 * not authorization (§10), but a folder created under `users/<handle>/consoles`
 * is that user's private folder so the tree renders where the file lives.
 */
export async function ensureFolderChain(
  segments: string[],
  workspaceId: string,
  scope: { access: ConsoleAccessLevel; ownerId?: string },
): Promise<Types.ObjectId | undefined> {
  let parentId: string | null = null;
  for (const name of segments) {
    let folder = await consolesChartsRepo.findConsoleFolderByNameAndParent(
      workspaceId,
      name,
      parentId,
    );
    if (!folder) {
      folder = await consolesChartsRepo.createConsoleFolder({
        workspaceId,
        name,
        parentId,
        isPrivate: scope.access === "private",
        access: scope.access,
        ownerId: scope.ownerId,
      });
    }
    parentId = folder.id;
  }
  return parentId ? new Types.ObjectId(parentId) : undefined;
}

// ---------------------------------------------------------------------------
// Row ↔ file
// ---------------------------------------------------------------------------

export type RowLike = Omit<
  Pick<
    ISavedConsole,
    | "name"
    | "language"
    | "code"
    | "connectionId"
    | "databaseName"
    | "databaseId"
    | "description"
    | "descriptionSource"
    | "descriptionGeneratedAt"
    | "schedule"
    | "resultsViewMode"
    | "mongoOptions"
    | "chartSpec"
    | "access"
    | "isPrivate"
    | "owner_id"
    | "createdBy"
    | "folderId"
    | "workspaceId"
  >,
  "connectionId" | "folderId" | "workspaceId" | "owner_id" | "createdBy"
> & {
  connectionId?: Types.ObjectId | string | null;
  folderId?: Types.ObjectId | string | null;
  workspaceId: Types.ObjectId | string;
  owner_id?: string | null;
  createdBy?: string | null;
};

export function rowLanguage(row: Pick<RowLike, "language">): ConsoleLanguage {
  return row.language === "javascript" || row.language === "mongodb"
    ? row.language
    : "sql";
}

/** Is this row's description authored (belongs in the file) or generated? */
export function descriptionIsAuthored(
  row: Pick<
    RowLike,
    "description" | "descriptionSource" | "descriptionGeneratedAt"
  >,
): boolean {
  if (!row.description?.trim()) return false;
  if (row.descriptionSource) return row.descriptionSource === "authored";
  // Legacy rows: a description nobody generated was typed by someone.
  return !row.descriptionGeneratedAt;
}

/**
 * Which tree a row's file belongs in. A private console goes under its
 * owner's handle; an owner without one (not a member of this workspace any
 * more, never given a handle) has no tree to write into.
 */
export function rowScope(
  row: Pick<RowLike, "access" | "isPrivate" | "owner_id" | "createdBy">,
  directory: OwnerDirectory,
): { scope: "workspace" | "private"; ownerId?: string; ownerHandle?: string } {
  const access: ConsoleAccessLevel =
    row.access ?? (row.isPrivate ? "private" : "workspace");
  if (access === "workspace") return { scope: "workspace" };
  const ownerId = row.owner_id || row.createdBy || "";
  const ownerHandle = directory.handleOf(ownerId);
  if (!ownerHandle) {
    throw new Error(
      `A private console needs an owner with a personal folder (owner ${JSON.stringify(ownerId)} has none in this workspace)`,
    );
  }
  return { scope: "private", ownerId, ownerHandle };
}

/** The handle mapping, holding the owner's handle when the row is private. */
export async function directoryForRow(
  row: Pick<
    RowLike,
    "access" | "isPrivate" | "owner_id" | "createdBy" | "workspaceId"
  >,
): Promise<OwnerDirectory> {
  const access = row.access ?? (row.isPrivate ? "private" : "workspace");
  return ownerDirectoryFor(
    row.workspaceId.toString(),
    access === "private"
      ? row.owner_id || row.createdBy || undefined
      : undefined,
  );
}

/**
 * The owner a private file at `users/<handle>/consoles/…` is filed under
 * when the handle is nobody's: never the pusher, never anyone the folder
 * name happens to spell. Contains `:`, so it can never equal a userId.
 */
export function unownedConsoleOwner(handle: string | undefined): string {
  return `unowned:${handle ?? ""}`;
}

/** The authored part of a row — what the file carries. */
export function fileStateFromRow(row: RowLike): ConsoleFileState {
  const state: ConsoleFileState = {
    name: row.name,
    language: rowLanguage(row),
    code: row.code ?? "",
  };
  if (row.connectionId) state.connectionId = row.connectionId.toString();
  if (row.databaseName) state.databaseName = row.databaseName;
  if (row.databaseId) state.databaseId = row.databaseId;
  if (descriptionIsAuthored(row)) state.description = row.description;
  if (row.schedule?.cron) {
    state.schedule = {
      cron: row.schedule.cron,
      timezone: row.schedule.timezone || "UTC",
    };
  }
  if (row.resultsViewMode) state.resultsViewMode = row.resultsViewMode;
  if (row.mongoOptions?.collection) {
    state.mongoOptions = {
      collection: row.mongoOptions.collection,
      operation: row.mongoOptions.operation,
    };
  }
  if (row.chartSpec && Object.keys(row.chartSpec).length > 0) {
    state.chartSpec = row.chartSpec;
  }
  return state;
}

/** Where a row lives in the repo, given its folder chain. */
export async function repoPathForRow(
  row: RowLike,
  folderCache?: Map<string, FolderLean | null>,
): Promise<string> {
  const segments = await folderSegmentsFor(
    row.folderId,
    row.workspaceId.toString(),
    folderCache,
  );
  return consoleRepoPath({
    ...rowScope(row, await directoryForRow(row)),
    folderSegments: segments,
    name: row.name,
    language: rowLanguage(row),
  });
}

/** The file (and sidecar) a state projects to, keyed by path. */
export function filesFor(
  path: string,
  state: ConsoleFileState,
): { writes: Record<string, string>; deletes: string[] } {
  const writes: Record<string, string> = {
    [path]: serializeConsoleFile(state),
  };
  const sidecar = chartSidecarPath(path);
  const deletes: string[] = [];
  if (state.chartSpec) writes[sidecar] = serializeChartSpec(state.chartSpec);
  else deletes.push(sidecar);
  return { writes, deletes };
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

/** The workspace bare repo, restored from its mirror or initialized. */
export async function ensureConsolesRepo(workspaceId: string): Promise<string> {
  return requireWorkspaceRepo(workspaceId);
}

export async function readAt(
  repoDir: string,
  relPath: string,
): Promise<string | null> {
  try {
    const blob = await readBlob(repoDir, MAIN, relPath);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

/** Whether this repo's consoles folder has been adopted (module doc). */
export async function consolesAdopted(repoDir: string): Promise<boolean> {
  return (await readAt(repoDir, CONSOLES_README_PATH)) !== null;
}
