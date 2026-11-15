/**
 * Source/destination lookups for flow list and detail responses, and the list
 * projection. Git-only flows have no Mongo row, so these replace the `$lookup`
 * an aggregation on `_id` used to do.
 */
import { Types } from "mongoose";
import {
  DatabaseConnection,
  SourceConnection,
} from "../database/workspace-schema";
import { deriveFlowType } from "./flow-triggers.service";

export function asObjectIdString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    return Types.ObjectId.isValid(value) ? value : null;
  }
  if (value instanceof Types.ObjectId) return value.toString();
  if (typeof value === "object" && value !== null && "_id" in value) {
    return asObjectIdString((value as { _id: unknown })._id);
  }
  const text = String(value);
  return Types.ObjectId.isValid(text) ? text : null;
}

function connectionSummary(
  doc: {
    _id: Types.ObjectId;
    name?: string;
    type?: string;
  } | null,
): Record<string, unknown> | null {
  if (!doc) return null;
  return { _id: doc._id, name: doc.name, type: doc.type };
}

/**
 * Populate source/destination lookups the list used to get from `$lookup`.
 * Git-only flows have no Mongo row, so aggregation on `_id` cannot see them.
 */
export async function attachFlowLookups(
  workspaceId: string,
  flows: Record<string, unknown>[],
  options: { includeSourceConfig?: boolean } = {},
): Promise<void> {
  const sourceIds: Types.ObjectId[] = [];
  const destIds: Types.ObjectId[] = [];
  const seenSource = new Set<string>();
  const seenDest = new Set<string>();

  const pushId = (
    raw: unknown,
    into: Types.ObjectId[],
    seen: Set<string>,
  ): void => {
    const id = asObjectIdString(raw);
    if (!id || seen.has(id)) return;
    seen.add(id);
    into.push(new Types.ObjectId(id));
  };

  for (const flow of flows) {
    const sourceType =
      flow.sourceType === "database" ? "database" : "connector";
    const databaseSource = flow.databaseSource as
      { connectionId?: unknown } | undefined;
    const tableDestination = flow.tableDestination as
      { connectionId?: unknown } | undefined;
    if (sourceType === "database") {
      pushId(databaseSource?.connectionId, destIds, seenDest);
    } else {
      pushId(flow.dataSourceId, sourceIds, seenSource);
    }
    pushId(flow.destinationDatabaseId, destIds, seenDest);
    pushId(tableDestination?.connectionId, destIds, seenDest);
  }

  const ws = new Types.ObjectId(workspaceId);
  const [sources, dests] = await Promise.all([
    sourceIds.length === 0
      ? []
      : SourceConnection.find({ _id: { $in: sourceIds }, workspaceId: ws })
          .select(
            options.includeSourceConfig ? "name type config" : "name type",
          )
          .lean(),
    destIds.length === 0
      ? []
      : DatabaseConnection.find({ _id: { $in: destIds }, workspaceId: ws })
          .select("name type")
          .lean(),
  ]);
  const sourceById = new Map(sources.map(doc => [doc._id.toString(), doc]));
  const destById = new Map(dests.map(doc => [doc._id.toString(), doc]));

  for (const flow of flows) {
    const sourceType =
      flow.sourceType === "database" ? "database" : "connector";
    const databaseSource = flow.databaseSource as
      { connectionId?: unknown } | undefined;
    const tableDestination = flow.tableDestination as
      { connectionId?: unknown } | undefined;
    if (sourceType === "database") {
      const dbConn = destById.get(
        asObjectIdString(databaseSource?.connectionId) ?? "",
      );
      flow.dataSourceId = connectionSummary(dbConn ?? null);
    } else {
      const source = sourceById.get(asObjectIdString(flow.dataSourceId) ?? "");
      if (source) {
        flow.dataSourceId = options.includeSourceConfig
          ? {
              _id: source._id,
              name: source.name,
              type: source.type,
              config: source.config,
            }
          : connectionSummary(source);
      } else {
        flow.dataSourceId = null;
      }
    }
    const dest = destById.get(
      asObjectIdString(flow.destinationDatabaseId) ?? "",
    );
    flow.destinationDatabaseId = connectionSummary(dest ?? null);
    const tableConn = destById.get(
      asObjectIdString(tableDestination?.connectionId) ?? "",
    );
    flow.tableDestinationConnection = connectionSummary(tableConn ?? null);
  }
}

export function projectFlowListItem(
  flow: Record<string, unknown>,
): Record<string, unknown> {
  return {
    _id: flow._id,
    workspaceId: flow.workspaceId,
    // Retired field: an old document's stored value, else a display label
    // (deriveFlowType). Never branched on.
    type: flow.type ?? deriveFlowType(flow as never),
    name: flow.name,
    slug: flow.slug,
    sourceType: flow.sourceType ?? "connector",
    destinationDatabaseName: flow.destinationDatabaseName,
    schedule: flow.schedule,
    webhookConfig: flow.webhookConfig,
    entityFilter: flow.entityFilter,
    queries: flow.queries,
    syncMode: flow.syncMode,
    writeMode: flow.writeMode,
    backfillSchedule: flow.backfillSchedule,
    syncEngine: flow.syncEngine,
    syncState: flow.syncState,
    syncStateUpdatedAt: flow.syncStateUpdatedAt,
    syncStateMeta: flow.syncStateMeta,
    lastRunAt: flow.lastRunAt,
    lastSuccessAt: flow.lastSuccessAt,
    lastError: flow.lastError,
    nextRunAt: flow.nextRunAt,
    runCount: flow.runCount,
    avgDurationMs: flow.avgDurationMs,
    createdBy: flow.createdBy,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    dataSourceId: flow.dataSourceId,
    databaseSource: flow.databaseSource,
    destinationDatabaseId: flow.destinationDatabaseId,
    tableDestination: flow.tableDestination,
    tableDestinationConnection: flow.tableDestinationConnection,
    incrementalConfig: flow.incrementalConfig,
    conflictConfig: flow.conflictConfig,
    batchSize: flow.batchSize,
    entityLayouts: flow.entityLayouts,
    deleteMode: flow.deleteMode,
    sourceBlobSha: flow.sourceBlobSha,
    definitionInvalid: flow.definitionInvalid,
  };
}
