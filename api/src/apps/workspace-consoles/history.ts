/**
 * History: the same shapes the apps History popover consumes — commits that
 * touched a console's file, what one commit changed, a file before/after a
 * commit, restore-as-new-commit, and the last saved state at HEAD.
 */
import { Types } from "mongoose";
import type { ISavedConsole } from "../../database/workspace-schema";
import {
  consolesChartsRepo,
  type SavedConsoleRecord,
} from "../../repositories/consoles-charts";
import { workspaceOwnsConnection } from "../../services/consoles/connection-scope";
import { validateScheduledConsoleSchedule } from "../../services/scheduled-query-schedule.service";
import { RepoRequiredError } from "../config";
import { boundRepoDirIfExists } from "../workspace-repo-required";
import {
  chartSidecarPath,
  parseChartSpec,
  parseConsoleFile,
  parseConsoleRepoPath,
} from "../console-files";
import {
  diffNameStatus,
  log as repoLog,
  readBlob,
  resolveCommit,
  type CommitInfo,
} from "../repository.service";
import { EMPTY_TREE } from "../git";
import {
  NotEntityPathError,
  entityCommitChanges,
  entityFileVersions,
  entityHistory,
  fileScope,
  type CommitChanges,
  type EntityGitScope,
  type FileVersions,
} from "../entity-git-history";
import { descriptionIsAuthored, readAt, rowLanguage } from "./files";
import { commitConsoleState } from "./write-through";

type ConsoleScopeRow = {
  workspaceId: Types.ObjectId | string;
  path?: string;
};

/** The console's file and chart sidecar, as one history scope. */
function consoleScope(row: ConsoleScopeRow): EntityGitScope | null {
  if (!row.path) return null;
  return fileScope(
    row.workspaceId.toString(),
    row.path,
    chartSidecarPath(row.path),
  );
}

/** Commits that touched a console's file (renames included via its row path). */
export async function consoleHistory(
  row: ConsoleScopeRow,
  limit = 50,
): Promise<CommitInfo[]> {
  const scope = consoleScope(row);
  return scope ? entityHistory(scope, limit) : [];
}

/** What one commit did to this console (its file and chart sidecar). */
export async function consoleCommitChanges(
  row: ConsoleScopeRow,
  sha: string,
): Promise<CommitChanges> {
  const scope = consoleScope(row) ?? {
    workspaceId: row.workspaceId.toString(),
    pathspec: "",
    owns: () => false,
  };
  return entityCommitChanges(scope, sha);
}

/**
 * The console's file (or chart sidecar) before and after one commit.
 * Throws {@link NotEntityPathError} for any other path.
 */
export async function consoleFileVersions(
  row: ConsoleScopeRow,
  sha: string,
  relPath: string,
): Promise<FileVersions> {
  const scope = consoleScope(row);
  if (!scope) throw new NotEntityPathError(relPath);
  return entityFileVersions(scope, sha, relPath);
}

/**
 * Restore a console to its content at `sha` — a NEW commit, history is
 * append-only — and project the restored file back onto the row. The file
 * is read at the row's current path, or at the path the console had in
 * that commit when it has since moved.
 */
export async function restoreConsoleTo(
  row: ISavedConsole | SavedConsoleRecord,
  sha: string,
  actorUserId: string,
): Promise<{ commitOid: string; unchanged: boolean }> {
  if (!row.path) throw new Error("This console has no file in the repo yet");
  const wsId = row.workspaceId.toString();
  const repoDir = await boundRepoDirIfExists(wsId);
  if (repoDir == null) throw new RepoRequiredError();
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  let at = row.path;
  let blob = await readBlob(repoDir, oid, at).catch(() => null);
  if (!blob) {
    // The console lived elsewhere at that commit: find its file by blob id
    // lineage is not tracked, so fall back to the commit's own touched path.
    const changes = await diffNameStatus(
      repoDir,
      (await resolveCommit(repoDir, `${oid}^`)) ?? EMPTY_TREE,
      oid,
    );
    const candidate = changes.find(
      f => parseConsoleRepoPath(f.path) && f.status !== "deleted",
    );
    if (candidate) {
      at = candidate.path;
      blob = await readBlob(repoDir, oid, at).catch(() => null);
    }
  }
  if (!blob || blob.isBinary) {
    throw new Error("That commit has no readable version of this console");
  }
  const location = parseConsoleRepoPath(at);
  const parsed = parseConsoleFile(
    blob.contents,
    location?.language ?? rowLanguage(row),
  );
  const sidecar = await readBlob(repoDir, oid, chartSidecarPath(at)).catch(
    () => null,
  );
  const [info] = await repoLog(repoDir, oid, 1);
  const subject = info?.subject ? ` "${info.subject}"` : "";

  const nextConnectionId =
    parsed.meta.connectionId &&
    Types.ObjectId.isValid(parsed.meta.connectionId) &&
    (await workspaceOwnsConnection(wsId, parsed.meta.connectionId))
      ? parsed.meta.connectionId
      : undefined;
  const nextDatabaseId =
    !nextConnectionId && parsed.meta.databaseId === parsed.meta.connectionId
      ? undefined
      : parsed.meta.databaseId;
  const nextChartSpec =
    sidecar && !sidecar.isBinary ? parseChartSpec(sidecar.contents) : undefined;
  let nextDescription = row.description;
  let nextDescriptionSource = row.descriptionSource;
  if (parsed.meta.description) {
    nextDescription = parsed.meta.description;
    nextDescriptionSource = "authored";
  } else if (descriptionIsAuthored(row)) {
    nextDescription = "";
    nextDescriptionSource = "generated";
  }
  let nextSchedule: { cron: string; timezone: string } | undefined;
  if (parsed.meta.schedule) {
    try {
      nextSchedule = validateScheduledConsoleSchedule(parsed.meta.schedule);
    } catch {
      nextSchedule = undefined;
    }
  }

  const baseRow: Record<string, unknown> =
    typeof (row as { toObject?: () => unknown }).toObject === "function"
      ? ((row as ISavedConsole).toObject() as Record<string, unknown>)
      : ({ ...row } as Record<string, unknown>);
  const nextRow = {
    ...baseRow,
    workspaceId: wsId,
    code: parsed.code,
    connectionId: nextConnectionId,
    databaseName: parsed.meta.databaseName,
    databaseId: nextDatabaseId,
    resultsViewMode: parsed.meta.resultsViewMode,
    mongoOptions: parsed.meta.mongoOptions as ISavedConsole["mongoOptions"],
    chartSpec: nextChartSpec,
    description: nextDescription,
    descriptionSource: nextDescriptionSource,
    schedule: nextSchedule,
  } as unknown as SavedConsoleRecord;
  const committed = await commitConsoleState({
    row: nextRow,
    previousPath: row.path,
    actorUserId,
    message: `Restore${subject} (${oid.slice(0, 7)})`,
  });
  const nextVersion = (row.version ?? 1) + 1;
  const nextDraftRevision = (row.draftRevision ?? 1) + 1;

  await consolesChartsRepo.updateConsole(wsId, row._id.toString(), {
    code: parsed.code,
    connectionId: nextConnectionId ?? null,
    databaseName: parsed.meta.databaseName ?? null,
    databaseId: nextDatabaseId ?? null,
    resultsViewMode: parsed.meta.resultsViewMode ?? null,
    mongoOptions:
      (parsed.meta.mongoOptions as ISavedConsole["mongoOptions"]) ?? null,
    chartSpec: nextChartSpec ?? null,
    description: nextDescription ?? null,
    descriptionSource: nextDescriptionSource ?? null,
    schedule: nextSchedule ?? null,
    path: committed.path,
    sourceBlobSha: committed.sourceBlobSha,
    version: nextVersion,
    draftRevision: nextDraftRevision,
    lastDraftOrigin: "user",
  });

  row.code = parsed.code;
  row.path = committed.path;
  row.sourceBlobSha = committed.sourceBlobSha;
  row.version = nextVersion;
  row.draftRevision = nextDraftRevision;
  row.lastDraftOrigin = "user";

  return { commitOid: committed.commitOid, unchanged: committed.unchanged };
}

/**
 * The last explicitly saved state of a console — its file at HEAD. Git is
 * the history now; snapshot rows are no longer written (§16.6).
 */
export async function savedConsoleStateFromRepo(row: ConsoleScopeRow): Promise<{
  code: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
} | null> {
  if (!row.path) return null;
  const location = parseConsoleRepoPath(row.path);
  if (!location) return null;
  const repoDir = await boundRepoDirIfExists(row.workspaceId.toString());
  if (repoDir == null) return null;
  const contents = await readAt(repoDir, row.path);
  if (contents === null) return null;
  const parsed = parseConsoleFile(contents, location.language);
  return {
    code: parsed.code,
    connectionId: parsed.meta.connectionId,
    databaseId: parsed.meta.databaseId,
    databaseName: parsed.meta.databaseName,
  };
}
