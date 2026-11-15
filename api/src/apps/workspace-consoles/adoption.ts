/**
 * Adoption / migration: bring a workspace's saved consoles into its repo,
 * optionally replaying `entity_versions` as commits, and write the adoption
 * marker. The DB migration and the operator CLI both call it, and so does
 * the first console write on a not-yet-adopted workspace.
 */
import { Types } from "mongoose";
import {
  EntityVersion,
  SavedConsole,
  type ConsoleAccessLevel,
  type IEntityVersion,
  type ISavedConsole,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { mirrorPushNow, resolveMirrorTarget } from "../cloud-repo.service";
import {
  CONSOLES_README,
  CONSOLES_README_PATH,
  chartSidecarPath,
  consoleRepoPath,
  parseConsoleRepoPath,
  serializeConsoleFile,
  type ConsoleFileState,
  type ConsoleLanguage,
} from "../console-files";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  listTree,
  resolveCommit,
  type BlobMutation,
  type GitAuthor,
} from "../repository.service";
import { authorForUser } from "./authors";
import {
  MAIN,
  consolesAdopted,
  descriptionIsAuthored,
  directoryForRow,
  ensureConsolesRepo,
  fileStateFromRow,
  filesFor,
  folderSegmentsFor,
  repoPathForRow,
  rowScope,
  type FolderLean,
  type RowLike,
} from "./files";

const logger = loggers.api("consoles-git");

export interface AdoptionReport {
  workspaceId: string;
  consoles: number;
  alreadyCurrent: number;
  versionsReplayed: number;
  commits: number;
  adopted: boolean;
  durable: boolean;
  dryRun: boolean;
}

interface VersionState {
  state: ConsoleFileState;
  scope: {
    scope: "workspace" | "private";
    ownerId?: string;
    ownerHandle?: string;
  };
  folderSegments: string[];
}

/** A version snapshot, completed from the live row where it is silent. */
async function stateFromSnapshot(
  row: ISavedConsole,
  snapshot: Record<string, unknown>,
  folderCache: Map<string, FolderLean | null>,
): Promise<VersionState> {
  const s = snapshot as Partial<{
    name: string;
    description: string;
    code: string;
    language: string;
    connectionId: string;
    databaseName: string;
    databaseId: string;
    chartSpec: Record<string, unknown>;
    resultsViewMode: "table" | "json" | "chart";
    mongoOptions: { collection: string; operation: string };
    folderId: string;
    access: ConsoleAccessLevel;
  }>;
  const merged: RowLike = {
    workspaceId: row.workspaceId,
    name: s.name ?? row.name,
    // Snapshot descriptions predate the authored/generated split; a
    // description that the live row calls generated stays out of the file.
    description: s.description ?? row.description,
    descriptionSource: row.descriptionSource,
    descriptionGeneratedAt: row.descriptionGeneratedAt,
    code: s.code ?? row.code,
    language: (s.language as ConsoleLanguage) ?? row.language,
    connectionId:
      s.connectionId && Types.ObjectId.isValid(s.connectionId)
        ? new Types.ObjectId(s.connectionId)
        : row.connectionId,
    databaseName: s.databaseName ?? row.databaseName,
    databaseId: s.databaseId ?? row.databaseId,
    chartSpec: s.chartSpec ?? row.chartSpec,
    resultsViewMode: s.resultsViewMode ?? row.resultsViewMode,
    mongoOptions:
      (s.mongoOptions as ISavedConsole["mongoOptions"]) ?? row.mongoOptions,
    schedule: row.schedule,
    access: s.access ?? row.access,
    isPrivate: (s.access ?? row.access) === "private",
    owner_id: row.owner_id,
    createdBy: row.createdBy,
    folderId:
      s.folderId && Types.ObjectId.isValid(s.folderId)
        ? new Types.ObjectId(s.folderId)
        : row.folderId,
  };
  const folderSegments = await folderSegmentsFor(
    merged.folderId,
    row.workspaceId.toString(),
    folderCache,
  );
  return {
    state: fileStateFromRow(merged),
    scope: rowScope(merged, await directoryForRow(merged)),
    folderSegments,
  };
}

async function versionAuthors(
  versions: IEntityVersion[],
): Promise<Map<string, GitAuthor>> {
  const out = new Map<string, GitAuthor>();
  for (const id of new Set(versions.map(v => v.savedBy).filter(Boolean))) {
    const author = await authorForUser(id);
    if (author) out.set(id, author);
  }
  return out;
}

function versionAuthor(
  version: IEntityVersion,
  known: Map<string, GitAuthor>,
): GitAuthor {
  if (version.savedByName === "System") {
    return { name: "Mako", email: "bot@mako.ai", date: version.createdAt };
  }
  const found = known.get(version.savedBy);
  if (found) return { ...found, date: version.createdAt };
  const email =
    version.savedByName && version.savedByName.includes("@")
      ? version.savedByName
      : `${version.savedBy || "unknown"}@users.invalid`;
  return {
    name: version.savedByName || version.savedBy || "Unknown",
    email,
    date: version.createdAt,
  };
}

/**
 * Bring a workspace's saved consoles into its repo. Re-runnable: rows whose
 * file is already at head with the recorded blob are skipped; with
 * `replayHistory` every `entity_versions` snapshot becomes a commit first
 * (original author, timestamp, comment — §13.18), then the live state when
 * it differs from the last version. Existing embeddings are kept by
 * stamping `descriptionSourceSha` (§16.4). Ends by writing the adoption
 * marker and pushing the mirror.
 */
export async function adoptWorkspaceConsoles(
  workspaceId: string,
  options: {
    replayHistory: boolean;
    dryRun?: boolean;
    actorUserId?: string;
  },
): Promise<AdoptionReport> {
  const ws = new Types.ObjectId(workspaceId);
  const report: AdoptionReport = {
    workspaceId,
    consoles: 0,
    alreadyCurrent: 0,
    versionsReplayed: 0,
    commits: 0,
    adopted: false,
    durable: false,
    dryRun: Boolean(options.dryRun),
  };
  const rows = (await SavedConsole.find({
    workspaceId: ws,
    isSaved: true,
    $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
  })
    .select("+descriptionEmbedding")
    .sort({ createdAt: 1 })) as ISavedConsole[];
  report.consoles = rows.length;
  if (options.dryRun) {
    if (options.replayHistory) {
      report.versionsReplayed = await EntityVersion.countDocuments({
        workspaceId: ws,
        entityType: "console",
        entityId: { $in: rows.map(r => r._id) },
      });
    }
    return report;
  }

  const repoDir = await ensureConsolesRepo(workspaceId);
  const alreadyAdopted = await consolesAdopted(repoDir);
  const head = await resolveCommit(repoDir, MAIN);
  const tree = new Map<string, string>();
  if (head) {
    for (const e of await listTree(repoDir, head)) tree.set(e.path, e.oid);
  }
  const folderCache = new Map<string, FolderLean | null>();
  const actorAuthor = await authorForUser(options.actorUserId);
  const takenPaths = new Set<string>(tree.keys());
  // Paths other rows already own. A file at the wanted path with the SAME
  // blob and no owner is this console (an earlier run that stopped between
  // its commit and its stamp) — claim it rather than minting "(2)".
  const claimed = new Set<string>(
    rows.map(r => r.path).filter((p): p is string => Boolean(p)),
  );

  const commit = async (
    mutation: BlobMutation,
    message: string,
    author?: GitAuthor,
    // Version replays commit even when file-identical (a schedule-only or
    // comment-only save still happened); lifecycle commits stay deduped.
    allowEmpty = false,
  ) => {
    const r = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
      message,
      author,
      allowEmpty,
    });
    if (!r.unchanged) report.commits++;
    return r;
  };

  for (const row of rows) {
    const finalState = fileStateFromRow(row);
    const finalContents = serializeConsoleFile(finalState);
    const finalSha = blobOid(finalContents);
    const wanted = await repoPathForRow(row, folderCache);
    const finalPath =
      !row.path && tree.get(wanted) === finalSha && !claimed.has(wanted)
        ? wanted
        : uniquePath(wanted, takenPaths, row.path);
    claimed.add(finalPath);
    if (row.path === finalPath && tree.get(finalPath) === finalSha) {
      report.alreadyCurrent++;
      await stampRow(row, finalPath, finalSha);
      continue;
    }

    let previousPath: string | null =
      row.path && tree.has(row.path) ? row.path : null;
    if (options.replayHistory && !row.path) {
      const versions = (await EntityVersion.find({
        entityType: "console",
        entityId: row._id,
      }).sort({ version: 1 })) as IEntityVersion[];
      const known = await versionAuthors(versions);
      for (const version of versions) {
        const vs = await stateFromSnapshot(
          row,
          version.snapshot ?? {},
          folderCache,
        );
        const vPath = uniquePath(
          consoleRepoPath({
            ...vs.scope,
            folderSegments: vs.folderSegments,
            name: vs.state.name,
            language: vs.state.language,
          }),
          takenPaths,
          previousPath ?? undefined,
        );
        const files = filesFor(vPath, vs.state);
        const deletes = [...files.deletes];
        if (previousPath && previousPath !== vPath) {
          deletes.push(previousPath, chartSidecarPath(previousPath));
        }
        await commit(
          { writes: files.writes, deletes },
          (version.comment ?? "").trim() || `v${version.version}`,
          versionAuthor(version, known),
          true,
        );
        report.versionsReplayed++;
        previousPath = vPath;
      }
    }

    const files = filesFor(finalPath, finalState);
    const deletes = [...files.deletes];
    if (previousPath && previousPath !== finalPath) {
      deletes.push(previousPath, chartSidecarPath(previousPath));
    }
    const author =
      actorAuthor ?? (await authorForUser(row.owner_id || row.createdBy));
    await commit(
      { writes: files.writes, deletes },
      previousPath
        ? `Adopt current state: ${finalPath}`
        : `Adopt console: ${finalPath}`,
      author,
    );
    takenPaths.add(finalPath);
    await stampRow(row, finalPath, finalSha);
  }

  if (!alreadyAdopted) {
    await commit(
      { writes: { [CONSOLES_README_PATH]: CONSOLES_README } },
      `Adopt consoles into git (${rows.length} console${rows.length === 1 ? "" : "s"})`,
      actorAuthor,
    );
  }
  report.adopted = true;

  // Durable tier (§13.17): the connected repo when bound; local-only otherwise.
  const durable = await resolveMirrorTarget(workspaceId);
  if (durable) {
    await mirrorPushNow(workspaceId);
    report.durable = true;
  }
  logger.info("Workspace consoles adopted into git", { ...report });
  return report;
}

/** Two rows that sanitize to the same path get " (2)", " (3)", … */
function uniquePath(
  wanted: string,
  taken: Set<string>,
  ownPath: string | undefined | null,
): string {
  if (wanted === ownPath || !taken.has(wanted)) return wanted;
  const location = parseConsoleRepoPath(wanted);
  if (!location) return wanted;
  for (let i = 2; ; i++) {
    const candidate = consoleRepoPath({
      ...location,
      name: `${location.name} (${i})`,
    });
    if (candidate === ownPath || !taken.has(candidate)) return candidate;
  }
}

async function stampRow(
  row: ISavedConsole,
  path: string,
  sourceBlobSha: string,
): Promise<void> {
  const set: Record<string, unknown> = { path, sourceBlobSha };
  const hasEmbedding =
    Array.isArray(row.descriptionEmbedding) &&
    row.descriptionEmbedding.length > 0;
  if (!row.descriptionSource) {
    set.descriptionSource = descriptionIsAuthored(row)
      ? "authored"
      : "generated";
  }
  // Keep every existing embedding: it described this same content.
  if (hasEmbedding && !row.descriptionSourceSha) {
    set.descriptionSourceSha = sourceBlobSha;
  }
  await SavedConsole.updateOne({ _id: row._id }, { $set: set });
}
