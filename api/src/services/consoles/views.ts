/**
 * The read payloads the console routes answer with: one console's editor
 * content, the bulk revision sync, the flat list and details for API
 * clients, and recent executions. Each returns `null` for "not found or not
 * readable" (the routes answer 404 either way, never leaking existence).
 */
import { Types } from "mongoose";
import { authRepo } from "../../repositories/auth";
import { connectionsRepo } from "../../repositories/connections";
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import { FolderChainCache } from "../../utils/folder-chain";
import { queryExecutionService } from "../query-execution.service";
import { queryExecutionSourceLabel } from "../query-execution-source";
import {
  canReadConsoleWithInheritance,
  canWriteConsole,
  resolveConsoleAccess,
} from "./access";
import { getConsoleWithMetadata, listConsolesFlat } from "./tree";
import { recordConsoleExternalUse } from "./crud";
import { getLatestConsoleSavedStateHash } from "./state-hash";

/** Most consoles one revision sync answers for. */
const REVISION_SYNC_MAX = 100;

async function ownerEmail(ownerId: string | undefined) {
  if (!ownerId) return undefined;
  const ownerUser = await authRepo.findUserById(ownerId);
  return ownerUser?.email;
}

async function connectionSummary(
  connectionId: unknown,
  workspaceId: string,
): Promise<{ id: unknown; name: unknown; type: unknown } | null> {
  if (!connectionId) return null;
  const id =
    typeof connectionId === "object" &&
    connectionId !== null &&
    "_id" in connectionId
      ? (connectionId as { _id: Types.ObjectId })._id
      : connectionId;
  if (!Types.ObjectId.isValid(String(id))) return null;
  const populated =
    typeof connectionId === "object" &&
    connectionId !== null &&
    "name" in connectionId
      ? (connectionId as { _id: Types.ObjectId; name?: string; type?: string })
      : null;
  if (populated?.name) {
    return { id: populated._id, name: populated.name, type: populated.type };
  }
  const doc = await connectionsRepo.findDatabaseConnectionSummary(
    String(id),
    workspaceId,
  );
  if (!doc) return null;
  return { id: doc.id, name: doc.name, type: doc.type };
}

/** GET /content: what the editor tab opens with. */
export async function consoleContent(input: {
  workspaceId: string;
  consoleId: string;
  userId: string;
  memberRole: string | undefined;
}) {
  const consoleData = await getConsoleWithMetadata(
    input.consoleId,
    input.workspaceId,
  );
  if (!consoleData) return null;

  const fullConsole = consoleData._raw;
  if (
    fullConsole &&
    !(await canReadConsoleWithInheritance(fullConsole, input.userId))
  ) {
    return null;
  }

  const ownerId = consoleData.owner_id;
  const readOnly = fullConsole
    ? !canWriteConsole(fullConsole, input.userId, input.memberRole)
    : false;
  const ownerDisplayName = await ownerEmail(ownerId);
  const savedStateHash =
    fullConsole && (consoleData.isSaved ?? true)
      ? await getLatestConsoleSavedStateHash(fullConsole)
      : undefined;

  return {
    content: consoleData.content,
    connectionId: consoleData.connectionId,
    databaseName: consoleData.databaseName,
    databaseId: consoleData.databaseId,
    language: consoleData.language,
    id: consoleData.id,
    name: consoleData.name,
    path: consoleData.path,
    isSaved: consoleData.isSaved,
    savedStateHash,
    lastDraftOrigin: fullConsole?.lastDraftOrigin,
    chartSpec: consoleData.chartSpec,
    resultsViewMode: consoleData.resultsViewMode,
    access: consoleData.access || "private",
    workspaceRole: fullConsole?.workspaceRole ?? "viewer",
    sharedWith: fullConsole?.sharedWith ?? [],
    owner_id: ownerId,
    ownerDisplayName,
    readOnly,
    schedule: fullConsole?.schedule,
    scheduledRun: fullConsole?.scheduledRun,
    // Optimistic-concurrency base: the client echoes this back as
    // expectedVersion on explicit saves.
    version: fullConsole?.version ?? 1,
    // Realtime sync base: clients compare against console.updated pokes
    // and echo it back as expectedDraftRevision on draft auto-saves.
    draftRevision: fullConsole?.draftRevision ?? 1,
    // Latest server-side run artifact (agent run_console while detached);
    // lets a reopened console render results without re-running.
    lastRun: fullConsole?.lastRun,
  };
}

/**
 * Bulk poke-then-pull reconciliation: the client sends the draftRevision of
 * every console tab it has open; the answer carries full payloads for the
 * ones that changed and the ids that are gone (or no longer readable).
 */
export async function syncConsoleRevisions(input: {
  workspaceId: string;
  userId: string;
  revisions: Record<string, unknown>;
}): Promise<{
  changed: Array<Record<string, unknown>>;
  deleted: string[];
}> {
  const entries = Object.entries(input.revisions)
    .filter(
      ([id, rev]) =>
        Types.ObjectId.isValid(id) &&
        typeof rev === "number" &&
        Number.isFinite(rev),
    )
    .slice(0, REVISION_SYNC_MAX) as Array<[string, number]>;

  if (entries.length === 0) return { changed: [], deleted: [] };

  const docs = await consolesChartsRepo.findConsolesByIds(
    input.workspaceId,
    entries.map(([id]) => id),
  );
  const docsById = new Map(docs.map(d => [d.id, d]));
  // Every folder chain the ACL checks below walk, fetched once per tree
  // level for all docs (not one query per level per console).
  const folders = FolderChainCache.forWorkspace(input.workspaceId);
  await folders.prefetch(docs.map(d => d.folderId?.toString()));

  const changed: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  for (const [id, clientRevision] of entries) {
    const doc = docsById.get(id);
    if (!doc || doc.is_deleted) {
      deleted.push(id);
      continue;
    }
    if (
      !(await canReadConsoleWithInheritance(doc, input.userId, { folders }))
    ) {
      // Not readable (e.g. access flipped to private): treat as gone.
      deleted.push(id);
      continue;
    }
    const serverRevision = doc.draftRevision ?? 1;
    if (serverRevision === clientRevision) continue;
    const isSaved = doc.isSaved ?? true;
    const savedStateHash = isSaved
      ? await getLatestConsoleSavedStateHash(doc)
      : undefined;
    changed.push({
      id,
      draftRevision: serverRevision,
      name: doc.name,
      content: doc.code,
      connectionId: doc.connectionId?.toString(),
      databaseId: doc.databaseId,
      databaseName: doc.databaseName,
      version: doc.version ?? 1,
      // Server truth for draft-vs-saved: clients use this to keep the
      // tab's autosave eligibility correct (drafts autosave, saved
      // consoles don't). Missing on legacy docs ⇒ treated as saved.
      isSaved,
      savedStateHash,
      // Lets the client route an agent edit into the diff-review flow even
      // when the live poke was missed (reconnect/reload). Undefined ⇒ user.
      lastDraftOrigin: doc.lastDraftOrigin,
      lastRun: doc.lastRun,
    });
  }
  return { changed, deleted };
}

/** GET /list: every console the caller can read, flat, for API clients. */
export async function listConsoleSummaries(
  workspaceId: string,
  userId: string | undefined,
) {
  const consoles = await listConsolesFlat(workspaceId, userId);

  const connectionIds = [
    ...new Set(
      consoles
        .map(doc => doc.connectionId?.toString())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const connections =
    connectionIds.length === 0
      ? []
      : await connectionsRepo.findDatabaseConnectionSummariesByIds(
          connectionIds,
          workspaceId,
        );
  const connectionById = new Map(connections.map(doc => [doc.id, doc]));

  return consoles.map(console => {
    const connId = console.connectionId?.toString();
    const conn = connId ? connectionById.get(connId) : undefined;
    return {
      id: console._id,
      name: console.name,
      description: console.description,
      language: console.language,
      connection: conn
        ? { id: conn.id, name: conn.name, type: conn.type }
        : null,
      databaseName: console.databaseName,
      createdAt: console.createdAt,
      updatedAt: console.updatedAt,
      lastExecutedAt: console.lastExecutedAt,
      executionCount: console.executionCount,
      lastExternalUsedAt: console.lastExternalUsedAt ?? null,
      externalUseCount: console.externalUseCount ?? 0,
      lastExternalSource: console.lastExternalSource ?? null,
      access: resolveConsoleAccess(console),
      owner_id: console.owner_id || console.createdBy,
    };
  });
}

/** GET /{id}/details: one console for API clients. */
export async function consoleDetails(input: {
  workspaceId: string;
  consoleId: string;
  userId: string | undefined;
  memberRole: string | undefined;
  /** API-key clients reading details count as external access. */
  viaApiKey: boolean;
}) {
  const { workspaceId, consoleId, userId } = input;
  const consoleData = await getConsoleWithMetadata(consoleId, workspaceId);
  if (!consoleData) return null;

  const savedConsole = consoleData._raw ?? null;
  if (!savedConsole) return null;

  const resolvedAccess =
    consoleData.access || resolveConsoleAccess(savedConsole);
  const ownerId = consoleData.owner_id || savedConsole.createdBy;

  if (userId && !(await canReadConsoleWithInheritance(savedConsole, userId))) {
    return null;
  }

  const readOnly = userId
    ? !canWriteConsole(savedConsole, userId, input.memberRole)
    : false;
  const ownerDisplayName = await ownerEmail(ownerId);

  if (input.viaApiKey) {
    void recordConsoleExternalUse(
      savedConsole._id.toString(),
      workspaceId,
      "api",
      "access",
    );
  }

  const connection = await connectionSummary(
    consoleData.connectionId ?? savedConsole.connectionId,
    workspaceId,
  );

  return {
    id: consoleData.id ?? savedConsole._id,
    name: consoleData.name ?? savedConsole.name,
    description: consoleData.description ?? savedConsole.description,
    code: consoleData.content,
    language: consoleData.language ?? savedConsole.language,
    mongoOptions: consoleData.mongoOptions ?? savedConsole.mongoOptions,
    connection,
    databaseName: consoleData.databaseName ?? savedConsole.databaseName,
    createdAt: savedConsole.createdAt,
    updatedAt: savedConsole.updatedAt,
    lastExecutedAt: savedConsole.lastExecutedAt,
    executionCount: savedConsole.executionCount,
    lastExternalUsedAt: savedConsole.lastExternalUsedAt ?? null,
    externalUseCount: savedConsole.externalUseCount ?? 0,
    lastExternalSource: savedConsole.lastExternalSource ?? null,
    access: resolvedAccess,
    owner_id: ownerId,
    ownerDisplayName,
    readOnly,
  };
}

/** GET /{id}/executions: recent query-execution log rows for a console. */
export async function consoleExecutions(input: {
  workspaceId: string;
  consoleId: string;
  userId: string | undefined;
  limit: number;
}) {
  const savedConsole = await consolesChartsRepo.findConsoleById(
    input.workspaceId,
    input.consoleId,
    { excludeDeleted: true },
  );
  if (!savedConsole) return null;
  if (
    input.userId &&
    !(await canReadConsoleWithInheritance(savedConsole, input.userId))
  ) {
    return null;
  }

  const executions = await queryExecutionService.getConsoleExecutions(
    input.workspaceId,
    input.consoleId,
    { limit: input.limit },
  );
  return executions.map(execution => ({
    id: execution._id,
    executedAt: execution.executedAt,
    source: execution.source,
    sourceLabel: queryExecutionSourceLabel(execution.source),
    status: execution.status,
    executionTimeMs: execution.executionTimeMs,
    rowCount: execution.rowCount ?? null,
    errorType: execution.errorType ?? null,
    userId: execution.userId,
    apiKeyId: execution.apiKeyId ?? null,
    databaseType: execution.databaseType,
    queryLanguage: execution.queryLanguage,
  }));
}
