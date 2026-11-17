/**
 * SYNC: repo → index. `syncConsolesIndexFromRepo` reconciles the index with
 * the tree after any push (terminal, laptop clone, GitHub webhook). Content
 * addressed: a row whose blob id equals the tree's is skipped; a vanished
 * row whose blob reappears elsewhere is a rename (id, telemetry, shares,
 * embedding survive); a vanished path soft-deletes its row. Never touches
 * a repo that has not adopted (`consoles/README.md` absent).
 */
import { Types } from "mongoose";
import {
  SavedConsole,
  type ConsoleAccessLevel,
  type ISavedConsole,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { publishRealtimeEvent } from "../../services/realtime.service";
import {
  getNextScheduledConsoleRunAt,
  validateScheduledConsoleSchedule,
} from "../../services/scheduled-query-schedule.service";
import { workspaceOwnsConnection } from "../../services/consoles/connection-scope";
import { createSerializer } from "../serialized";
import { loadOwnerDirectory } from "../user-handles.service";
import { boundRepoDirIfExists } from "../workspace-repo-required";
import {
  chartSidecarPath,
  parseChartSpec,
  parseConsoleFile,
  parseConsoleRepoPath,
  serializeChartSpec,
} from "../console-files";
import {
  blobOid,
  listTree,
  resolveCommit,
  type TreeEntry,
} from "../repository.service";
import {
  MAIN,
  consolesAdopted,
  descriptionIsAuthored,
  ensureFolderChain,
  readAt,
  unownedConsoleOwner,
} from "./files";
import { derivedConsoleId } from "./definitions";
import { requestConsoleDescription } from "./descriptions";

const logger = loggers.api("consoles-git");

export interface ConsoleSyncStats {
  created: number;
  updated: number;
  renamed: number;
  deleted: number;
  restored: number;
  skipped: number;
}

/** Serialize per workspace: two rapid pushes must not interleave a sync. */
const serialized = createSerializer();

type IndexRow = ISavedConsole;

/**
 * Reconcile the index with `main`. Called after every push that reaches
 * the workspace repo (worktree.service.notifyRepoPushed, the GitHub
 * webhook). Idempotent and content-addressed — a push that touched nothing
 * under consoles/ costs one ls-tree.
 */
export function syncConsolesIndexFromRepo(
  workspaceId: string,
  userId?: string,
): Promise<ConsoleSyncStats | null> {
  return serialized(workspaceId, () => syncNow(workspaceId, userId));
}

async function syncNow(
  workspaceId: string,
  userId?: string,
): Promise<ConsoleSyncStats | null> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;
  if (!(await consolesAdopted(repoDir))) return null;
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return null;

  const stats: ConsoleSyncStats = {
    created: 0,
    updated: 0,
    renamed: 0,
    deleted: 0,
    restored: 0,
    skipped: 0,
  };
  const entries = await listTree(repoDir, head);
  const byPath = new Map<string, TreeEntry>();
  for (const e of entries) byPath.set(e.path, e);
  const consoleEntries = entries.filter(e => parseConsoleRepoPath(e.path));

  const ws = new Types.ObjectId(workspaceId);
  const rows = (await SavedConsole.find({
    workspaceId: ws,
    isSaved: true,
    path: { $exists: true, $ne: null },
  }).select("+descriptionEmbedding")) as IndexRow[];
  const rowByPath = new Map<string, IndexRow>();
  for (const r of rows) if (r.path) rowByPath.set(r.path, r);
  const seenRows = new Set<string>();
  const touched: IndexRow[] = [];
  const actor = userId && userId.length > 0 ? userId : "git";
  const directory = await loadOwnerDirectory(workspaceId);

  // Rows whose path is gone are rename candidates for new paths with the
  // same blob; anything unclaimed at the end is a deletion.
  const orphans = rows.filter(r => r.path && !byPath.has(r.path));
  const orphanByBlob = new Map<string, IndexRow[]>();
  for (const o of orphans) {
    if (!o.sourceBlobSha) continue;
    const list = orphanByBlob.get(o.sourceBlobSha) ?? [];
    list.push(o);
    orphanByBlob.set(o.sourceBlobSha, list);
  }

  for (const entry of consoleEntries) {
    // One file's failure is that file's problem: a folder-name validation
    // error or a front-matter value the schema cannot cast must not skip
    // every file after it, the deletion pass, and the realtime events.
    try {
      const location = parseConsoleRepoPath(entry.path);
      if (!location) continue;
      const sidecar = byPath.get(chartSidecarPath(entry.path));
      let row = rowByPath.get(entry.path);

      if (!row) {
        const candidates = orphanByBlob.get(entry.oid);
        const moved = candidates?.shift();
        if (moved) {
          row = moved;
          stats.renamed++;
        }
      }

      if (row) {
        seenRows.add(row._id.toString());
        const contentSame =
          row.sourceBlobSha === entry.oid && row.path === entry.path;
        const chartSame = await sidecarMatches(sidecar, row.chartSpec);
        if (contentSame && chartSame && !row.is_deleted) {
          stats.skipped++;
          continue;
        }
        if (row.is_deleted) stats.restored++;
        else if (row.path === entry.path) stats.updated++;
      }

      const contents = await readAt(repoDir, entry.path);
      // Unreadable files are not healed from Mongo. Skip; GET/list omits them.
      if (contents === null) continue;
      const parsed = parseConsoleFile(contents, location.language);
      const chartSpec = sidecar
        ? parseChartSpec((await readAt(repoDir, sidecar.path)) ?? "")
        : undefined;
      const access: ConsoleAccessLevel =
        location.scope === "private" ? "private" : "workspace";
      // A private file's owner is whoever the handle mapping says the
      // folder belongs to — not the pusher, and not the folder's spelling.
      // A handle that is nobody's keeps a moved row's owner, or files it
      // under an owner no user can be.
      const ownerId =
        location.scope === "private"
          ? (directory.ownerOf(location.ownerHandle) ??
            row?.owner_id ??
            unownedConsoleOwner(location.ownerHandle))
          : (row?.owner_id ?? row?.createdBy ?? actor);
      // A folder that first appears from git belongs to whoever pushed it
      // (the console's owner), so they can rename or delete it later.
      const folderId = await ensureFolderChain(
        location.folderSegments,
        workspaceId,
        { access, ownerId },
      );

      const connectionId = await scopedConnectionId(
        workspaceId,
        parsed.meta.connectionId,
        entry.path,
      );
      // Legacy files default database_id to the connection id: a dropped
      // connection takes that copy with it.
      const databaseId =
        connectionId === null &&
        parsed.meta.databaseId === parsed.meta.connectionId
          ? null
          : (parsed.meta.databaseId ?? null);
      const set: Record<string, unknown> = {
        path: entry.path,
        sourceBlobSha: entry.oid,
        name: location.name,
        language: location.language,
        code: parsed.code,
        folderId: folderId ?? null,
        access,
        isPrivate: access === "private",
        owner_id: ownerId,
        connectionId,
        databaseName: parsed.meta.databaseName ?? null,
        databaseId,
        resultsViewMode: parsed.meta.resultsViewMode ?? null,
        mongoOptions: parsed.meta.mongoOptions ?? null,
        chartSpec: chartSpec ?? null,
        is_deleted: false,
        isSaved: true,
        lastDraftOrigin: "user",
        updatedAt: new Date(),
      };
      if (parsed.meta.description) {
        set.description = parsed.meta.description;
        set.descriptionSource = "authored";
      } else if (row && descriptionIsAuthored(row)) {
        // The author removed their description: the generated one takes over
        // on the next derivation.
        set.description = "";
        set.descriptionSource = "generated";
      }
      const scheduleSet = scheduleFields(parsed.meta.schedule, row);
      Object.assign(set, scheduleSet.set);

      if (row) {
        await SavedConsole.updateOne(
          { _id: row._id },
          {
            $set: set,
            $inc: { version: 1, draftRevision: 1 },
            $unset: { deletedAt: "", ...scheduleSet.unset },
          },
        );
        const fresh = await SavedConsole.findById(row._id);
        if (fresh) touched.push(fresh);
        continue;
      }

      try {
        const created = await SavedConsole.create({
          _id: derivedConsoleId(workspaceId, entry.path),
          workspaceId: ws,
          createdBy: actor,
          executionCount: 0,
          version: 1,
          draftRevision: 1,
          ...set,
        });
        stats.created++;
        seenRows.add(created._id.toString());
        touched.push(created);
      } catch {
        // Unique-id race with a concurrent list/sync: keep the winner so a
        // git-only file that already appeared under the derived id does not
        // mint a second row.
        const winner =
          (await SavedConsole.findById(
            derivedConsoleId(workspaceId, entry.path),
          )) ??
          (await SavedConsole.findOne({
            workspaceId: ws,
            path: entry.path,
            isSaved: true,
          }));
        if (!winner) throw new Error("Could not persist the console index row");
        stats.created++;
        seenRows.add(winner._id.toString());
        touched.push(winner);
      }
    } catch (error) {
      logger.warn("Console file could not be reconciled; skipped", {
        workspaceId,
        path: entry.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Deletions: adopted repo, path gone, blob not claimed by a rename.
  for (const row of rows) {
    if (seenRows.has(row._id.toString())) continue;
    if (!row.path || byPath.has(row.path) || row.is_deleted) continue;
    const deleted = await SavedConsole.updateOne(
      { _id: row._id, is_deleted: { $ne: true } },
      { $set: { is_deleted: true, deletedAt: new Date() } },
    );
    // Duplicate push deliveries or concurrent instances may reconcile the
    // same commit. Only the process that changed the row may broadcast it.
    if (deleted.modifiedCount === 0) continue;
    stats.deleted++;
    publishRealtimeEvent(workspaceId, {
      type: "console.deleted",
      consoleId: row._id.toString(),
    });
  }

  for (const row of touched) {
    publishRealtimeEvent(workspaceId, {
      type: "console.updated",
      consoleId: row._id.toString(),
      draftRevision: row.draftRevision ?? 1,
      name: row.name,
      updatedBy: actor,
      origin: "save",
    });
    if (row.descriptionSourceSha !== row.sourceBlobSha) {
      requestConsoleDescription({
        workspaceId,
        consoleId: row._id.toString(),
      });
    }
  }

  if (stats.created || stats.updated || stats.renamed || stats.deleted) {
    logger.info("Console index synced from repo", { workspaceId, ...stats });
  }
  return stats;
}

/**
 * The front-matter connection, if it belongs to this workspace. A pushed
 * file can name any ObjectId; one from another workspace (or one that no
 * longer exists) is dropped with an error, so the console is indexed with
 * no connection and cannot run, scheduled or not.
 */
async function scopedConnectionId(
  workspaceId: string,
  connectionId: string | undefined,
  path: string,
): Promise<Types.ObjectId | null> {
  if (!connectionId || !Types.ObjectId.isValid(connectionId)) return null;
  if (await workspaceOwnsConnection(workspaceId, connectionId)) {
    return new Types.ObjectId(connectionId);
  }
  logger.error(
    "Console file names a connection outside this workspace; indexed without it",
    { workspaceId, path, connectionId },
  );
  return null;
}

async function sidecarMatches(
  sidecar: TreeEntry | undefined,
  chartSpec: Record<string, unknown> | undefined,
): Promise<boolean> {
  const rowHas = Boolean(chartSpec && Object.keys(chartSpec).length > 0);
  if (!sidecar) return !rowHas;
  if (!rowHas || !chartSpec) return false;
  return sidecar.oid === blobOid(serializeChartSpec(chartSpec));
}

function scheduleFields(
  schedule: { cron: string; timezone: string } | undefined,
  row: IndexRow | undefined,
): { set: Record<string, unknown>; unset: Record<string, ""> } {
  if (!schedule) {
    return row?.schedule?.cron
      ? { set: {}, unset: { schedule: "", scheduledRun: "" } }
      : { set: {}, unset: {} };
  }
  try {
    const valid = validateScheduledConsoleSchedule(schedule);
    const same =
      row?.schedule?.cron === valid.cron &&
      row?.schedule?.timezone === valid.timezone;
    if (same) return { set: {}, unset: {} };
    return {
      set: {
        schedule: valid,
        scheduledRun: {
          ...(row?.scheduledRun ?? { runCount: 0, consecutiveFailures: 0 }),
          nextAt: getNextScheduledConsoleRunAt(valid),
        },
      },
      unset: {},
    };
  } catch (error) {
    logger.warn("Ignoring invalid console schedule from repo", {
      schedule,
      error: error instanceof Error ? error.message : String(error),
    });
    return { set: {}, unset: {} };
  }
}
