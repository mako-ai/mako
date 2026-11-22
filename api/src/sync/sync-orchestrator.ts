import { promises as fs } from "fs";
import { inWorkspace } from "../utils/workspace-scope";
import { syncConnectorRegistry } from "./connector-registry";
import { sourceConnectionManager } from "./database-data-source-manager";
import {
  SyncLogger,
  FetchState,
  type ConnectorEntitySchema,
} from "../connectors/base/BaseConnector";
import {
  DatabaseConnection,
  Flow,
  ITableDestination,
} from "../database/workspace-schema";
import {
  markAbsentColumns,
  stripUndefined,
  withPolledDeleteState,
} from "../sync-cdc/sparse-rows";
import { nestedValuesAsJsonText } from "./bulk-buffer-json";
import {
  buildParquetFromBatches,
  isDuckDBMemoryError,
  parquetBuildByteBudget,
  type FieldMeta,
} from "../utils/streaming-parquet-builder";
import { BSON, Collection } from "mongodb";
import { Types } from "mongoose";
import { ProgressReporter } from "./progress-reporter";
import axios from "axios";
import { loggers } from "../logging";
import {
  destinationFallbackSince,
  pollOverlapMsFromEnv,
} from "../sync-cdc/poll-cursor";
import { LEGACY_ENGINE_REMOVED } from "../services/flow-triggers.service";
import type { CdcMergePath } from "../sync-cdc/table-write-lease";
import {
  SandboxedConnector,
  isWorkspaceConnectorType,
} from "../connectors/workspace/SandboxedConnector";
import {
  normalizePayloadKeys,
  normalizePayloadBySchema,
  resolveSourceTimestamp,
  SYNC_REQUIRED_TIMESTAMP_COLUMNS,
} from "../sync-cdc/normalization";
import {
  buildCdcEntityLayout,
  hasCdcDestinationAdapter,
  resolveCdcDestinationAdapter,
  type CdcDestinationAdapter,
} from "../sync-cdc/adapters/registry";

const orchestratorLogger = loggers.sync("orchestrator");

/**
 * A connector's schema could not be resolved: its sandbox dropped the stream,
 * its custom-field lookup timed out, its source connection was not found.
 *
 * Thrown out of the Inngest step, so the step retries. The sync never goes on
 * without the schema. On 17 Nov 2026 the PT Close shadow leads flush logged
 * "Schema resolution failed: [unavailable] the connection to sandbox … ended
 * before the stream completed", flushed with no field types, and wrote 11,165
 * rows whose date_created, date_updated, _syncedAt and _mako_source_ts were
 * NULL: with no types every Date went to Parquet as a JSON-quoted string, and
 * BigQuery's SAFE_CAST turned each one into NULL.
 */
export class SchemaResolutionError extends Error {
  readonly entity: string;
  readonly context: string;
  constructor(entity: string, context: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // The cause stays attached: a box memory refusal under it must still
    // read as one (box-memory.ts boxLowMemoryRefusal), so the step waits
    // for memory instead of failing the run.
    super(
      `Schema resolution failed for "${entity}" (${context}): ${reason}. ` +
        `The step retries; it never writes rows without the schema.`,
      { cause },
    );
    this.name = "SchemaResolutionError";
    this.entity = entity;
    this.context = context;
  }
}

function isWorkspaceConnector(
  connector: unknown,
  sourceType: string | undefined,
): boolean {
  if (connector instanceof SandboxedConnector) return true;
  return !!sourceType && isWorkspaceConnectorType(sourceType);
}

/**
 * Resolve the entity schema for a sync write.
 *
 * Returns null only when the connector has no schema to give: a built-in
 * connector that keeps the BaseConnector default (REST, GraphQL, custom API,
 * BigQuery source), or one that declares no schema for this entity. Every
 * failure throws SchemaResolutionError, so the step retries instead of
 * writing untyped rows.
 *
 * A workspace (ws:) connector always declares its streams in its catalog, so
 * a null there means discovery came back incomplete: it throws too.
 */
export async function resolveEntitySchema(params: {
  entity: string;
  dataSourceId?: string;
  workspaceId: string;
  sourceConnection?: { id?: string; type?: string } | null;
  connector?: {
    resolveSchema?: (entity: string) => Promise<unknown>;
    declaresUntypedSchema?: (entity: string) => Promise<boolean>;
  } | null;
  /**
   * The flow's queries, for a connector whose entities they name (GraphQL,
   * PostHog): injected into the connection as `performSyncChunk` does, or
   * the connector built here would not know the entity at all.
   */
  queries?: unknown[];
  context: string;
}): Promise<ConnectorEntitySchema | null> {
  let sourceType = params.sourceConnection?.type;
  let schema: ConnectorEntitySchema | null;
  let connector = params.connector;
  try {
    if (!connector) {
      const ds =
        params.sourceConnection ||
        (params.dataSourceId
          ? await sourceConnectionManager.getSourceConnection(
              params.dataSourceId,
              params.workspaceId,
            )
          : null);
      if (!ds) {
        throw new Error(
          `source connection ${params.dataSourceId ?? "(none)"} not found`,
        );
      }
      sourceType = (ds as { type?: string }).type;
      const withQueries =
        params.queries && params.queries.length > 0
          ? {
              ...ds,
              connection: {
                ...((ds as { connection?: Record<string, unknown> })
                  .connection ?? {}),
                queries: params.queries,
              },
            }
          : ds;
      connector = await syncConnectorRegistry.getConnectorFor(
        withQueries as any,
      );
      if (!connector) {
        throw new Error(`no connector for source type "${sourceType}"`);
      }
    }
    schema = connector?.resolveSchema
      ? (((await connector.resolveSchema(
          params.entity,
        )) as ConnectorEntitySchema | null) ?? null)
      : null;
    // A workspace stream may return no schema when it explicitly declares
    // itself untyped. Errors checking that declaration still need to retry.
    if (
      !schema &&
      isWorkspaceConnector(connector, sourceType) &&
      !(await connector?.declaresUntypedSchema?.(params.entity))
    ) {
      throw new Error("the workspace connector's catalog has no schema for it");
    }
  } catch (err) {
    orchestratorLogger.warn("Schema resolution failed", {
      entity: params.entity,
      context: params.context,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new SchemaResolutionError(params.entity, params.context, err);
  }
  return schema;
}

function camelToSnake(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** A destination error that means the table does not exist (yet). */
export function isMissingTableError(error: unknown): boolean {
  return /not found|does not exist|doesn't exist|no such table|unknown table/i.test(
    String(error ?? ""),
  );
}

/**
 * Get per-entity table name for connector -> SQL destinations.
 * Sub-types use snake_case: activities:Call → call_activities,
 * activities:OpportunityStatusChange → opportunity_status_change_activities
 * When baseName (prefix) is empty, returns just the entity name.
 */
export function getEntityTableName(baseName: string, entity: string): string {
  const normalized = entity.includes(":")
    ? `${camelToSnake(entity.split(":")[1])}_${entity.split(":")[0]}`
    : entity;
  return baseName ? `${baseName}_${normalized}` : normalized;
}

export interface SyncChunkResult {
  state: FetchState;
  entity: string;
  collectionName: string;
  completed: boolean;
  // Cumulative counts for this entity within the current execution
  totalFetched: number;
  totalWritten: number;
}

export interface SyncChunkOptions {
  dataSourceId: string;
  destinationId: string;
  destinationDatabaseName?: string;
  entity: string;
  isIncremental: boolean;
  state?: FetchState;
  maxIterations?: number;
  logger?: SyncLogger;
  step?: any;
  queries?: any[];
  /** When set, writes to SQL/BigQuery instead of MongoDB */
  tableDestination?: ITableDestination;
  deleteMode?: "hard" | "soft";
  /** Airbyte-style destination write mode (default append_dedup). */
  writeMode?: "append_dedup" | "append" | "overwrite";
  flowId?: string;
  /** The flow's workspace: the source connection is looked up in it only. */
  workspaceId: string;
  syncEngine?: string;
  backfillRunId?: string;
  /**
   * This run reads the source in full (a backfill or a resync), not as an
   * incremental poll. Its staged rows may overwrite a live row stamped up to
   * 1 s later (FULL_READ_SKEW_SECONDS in sync-cdc/adapters/bigquery-sql.ts).
   */
  fullRead?: boolean;
  /**
   * Explicit fetch scope for a CDC backfill chunk, decided once per entity
   * and run by sync-cdc/backfill-fetch-mode.ts. When present it replaces the
   * `_syncedAt` incremental anchor below:
   * - "incremental": `since` is passed to the connector on EVERY chunk (not
   *   only the first), so a resumable cursor keeps one consistent filter;
   * - "full": no `since` at all — a genuinely full fetch.
   * Absent: the historical behaviour (poll anchor on the first chunk).
   */
  backfillFetch?: { mode: "full" } | { mode: "incremental"; since: string };
  /**
   * Poll-owned cursor of a scheduled incremental poll, resolved once per
   * entity and run by sync-cdc/poll-cursor.ts. `since` (when a poll or
   * backfill stamp exists) replaces the destination anchor; `overlapMs` is
   * subtracted from the destination fallback too.
   */
  pollCursor?: { since?: string; overlapMs?: number };
  entityPartitioning?: {
    type?: "time" | "ingestion";
    field: string;
    granularity?: "day" | "hour" | "month" | "year";
    requirePartitionFilter?: boolean;
  };
  entityClustering?: { fields: string[] };
}

/**
 * Execute an operation with retry logic
 */
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  logger?: SyncLogger,
  step?: any, // Inngest step object
  operationName?: string, // For unique step names in Inngest
  rateLimitDelayMs: number = 200, // Base delay from data source rate limit settings
): Promise<T> {
  let attempts = 0;

  while (attempts <= maxRetries) {
    try {
      return await operation();
    } catch (error) {
      attempts++;

      if (attempts > maxRetries) {
        throw error;
      }

      // Calculate exponential backoff delay (2^attempts * rate_limit_delay_ms base)
      let delayMs: number;

      // Handle rate limiting with specific delay
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        const retryAfter = error.response.headers["retry-after"];
        delayMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(rateLimitDelayMs * Math.pow(2, attempts), 30000); // Cap at 30 seconds
        logger?.log(
          "warn",
          `Rate limited. Waiting ${delayMs}ms before retry ${attempts}/${maxRetries}`,
        );
      } else if (isRetryableError(error)) {
        // Exponential backoff for other retryable errors (2x each time, starting from rate limit delay)
        delayMs = Math.min(rateLimitDelayMs * Math.pow(2, attempts), 30000); // Cap at 30 seconds
        logger?.log(
          "warn",
          `Retryable error (${getErrorDescription(error)}). Waiting ${delayMs}ms before retry ${attempts}/${maxRetries}`,
        );
      } else {
        // Non-retryable error
        throw error;
      }

      // Use Inngest step.sleep if available (serverless-friendly), otherwise fall back to setTimeout
      if (step && step.sleep) {
        const sleepStepName = `retry-delay-${operationName || "operation"}-${attempts}`;
        await step.sleep(sleepStepName, delayMs);
      } else {
        await sleep(delayMs);
      }
    }
  }

  throw new Error("Max retries exceeded");
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: any): boolean {
  if (axios.isAxiosError(error)) {
    if (!error.response) {
      // Network errors are retryable
      return true;
    }
    // Retry on server errors, rate limiting, and gateway timeouts
    const status = error.response.status;
    return status >= 500 || status === 429 || status === 408; // 408 = Request Timeout
  }
  return false;
}

/**
 * Get human-readable error description
 */
function getErrorDescription(error: any): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) {
      return "Network error";
    }
    const status = error.response.status;
    switch (status) {
      case 500:
        return "Internal Server Error";
      case 502:
        return "Bad Gateway";
      case 503:
        return "Service Unavailable";
      case 504:
        return "Gateway Timeout";
      case 408:
        return "Request Timeout";
      default:
        return `HTTP ${status}`;
    }
  }
  return "Unknown error";
}

/**
 * Sleep utility function
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Performs a single chunk of sync work and returns state for resumption
 */
export async function performSyncChunk(
  options: SyncChunkOptions,
): Promise<SyncChunkResult> {
  const { dataSourceId, isIncremental, logger, queries } = options;

  const syncMode = isIncremental ? "incremental" : "full";

  try {
    // Get the data source
    const sourceConnection = await sourceConnectionManager.getSourceConnection(
      dataSourceId,
      options.workspaceId,
    );
    if (!sourceConnection) {
      throw new Error(`Data source '${dataSourceId}' not found`);
    }

    if (!sourceConnection.active) {
      throw new Error(`Data source '${sourceConnection.name}' is not active`);
    }

    // Inject transfer queries into sourceConnection for GraphQL/PostHog connectors
    // The registry maps connection -> config when creating the connector
    if (queries && queries.length > 0) {
      sourceConnection.connection = {
        ...sourceConnection.connection,
        queries,
      };
    }

    // Get connector from registry
    const connector =
      await syncConnectorRegistry.getConnectorFor(sourceConnection);
    if (!connector) {
      throw new Error(
        `Failed to create connector for type: ${sourceConnection.type}`,
      );
    }

    // Check if connector supports resumable fetching
    if (!connector.supportsResumableFetching()) {
      throw new Error(
        `Connector ${sourceConnection.type} does not support resumable fetching`,
      );
    }

    // ========== SQL/BigQuery destination path ==========
    if (options.tableDestination?.connectionId) {
      return performSyncChunkSql(
        options,
        sourceConnection,
        connector,
        syncMode,
      );
    }

    // The legacy engine (writing to a MongoDB collection without a table
    // destination) has been removed: every connector flow runs on CDC.
    throw new Error(
      `${LEGACY_ENGINE_REMOVED} (flow ${options.flowId ?? "unknown"} has no table destination)`,
    );
  } catch (error) {
    const errorMsg = `Sync chunk failed: ${error instanceof Error ? error.message : String(error)}`;
    logger?.log("error", errorMsg, {
      stack: error instanceof Error ? error.stack : undefined,
    });
    const wrappedError = new Error(errorMsg);
    (wrappedError as Error & { cause?: unknown }).cause = error;
    throw wrappedError;
  }
}

/**
 * SQL/BigQuery destination path for connector sync chunks.
 * Uses DestinationWriter with per-entity table naming.
 */
async function performSyncChunkSql(
  options: SyncChunkOptions,
  sourceConnection: any,
  connector: any,
  syncMode: string,
): Promise<SyncChunkResult> {
  const {
    entity,
    state,
    maxIterations = 10,
    logger,
    tableDestination,
  } = options;

  if (!tableDestination) {
    throw new Error("tableDestination required for SQL sync path");
  }

  const entityTableName = getEntityTableName(
    tableDestination.tableName,
    entity,
  );

  const destinationConn = await DatabaseConnection.findOne(
    inWorkspace(tableDestination.connectionId, options.workspaceId),
  )
    .select({ type: 1 })
    .lean();
  // CDC is the only engine: a connector flow writes through its
  // destination's CDC adapter (the legacy DestinationWriter path is gone).
  const isCdcEnabled =
    Boolean(options.flowId && options.workspaceId) &&
    options.syncEngine === "cdc" &&
    hasCdcDestinationAdapter(destinationConn?.type);
  if (!isCdcEnabled) {
    throw new Error(
      `${LEGACY_ENGINE_REMOVED} (flow ${options.flowId ?? "unknown"}, destination ${destinationConn?.type ?? "unknown"})`,
    );
  }

  const cdcAdapter = resolveCdcDestinationAdapter({
    destinationType: destinationConn?.type || "",
    flowId: options.flowId,
    workspaceId: options.workspaceId,
    destinationDatabaseId: options.destinationId,
    destinationDatabaseName: options.destinationDatabaseName,
    tableDestination: {
      connectionId: String(tableDestination.connectionId),
      schema: tableDestination.schema || "public",
      tableName: entityTableName,
    },
  });

  // Incremental poll anchor (first chunk only; the connector carries its
  // cursor in `state` for later chunks).
  //
  // The anchor is the poll's own cursor (sync-cdc/poll-cursor.ts): the start
  // of the last completed poll or backfill run of this entity, minus an
  // overlap. It used to be MAX(_syncedAt) of the live table, Mako's write
  // time, which webhook writes advance too: a change a webhook missed before
  // the latest webhook write was never polled again. Without a stamp, the
  // flow's last successful run of the entity anchors it. With neither, the
  // destination is the last resort, on the source timestamp first.
  // Incremental CDC polls are upsert-only; deletes are reconciled by the
  // periodic full backfill (backfillSchedule), not by polls.
  const backfillFetch = options.backfillFetch;
  const anchorIncremental =
    !backfillFetch &&
    syncMode === "incremental" &&
    options.writeMode !== "overwrite" &&
    !state;
  let lastSyncDate: Date | undefined;
  if (backfillFetch?.mode === "incremental") {
    const since = new Date(backfillFetch.since);
    if (!Number.isNaN(since.getTime())) {
      lastSyncDate = since;
      if (!state) {
        logger?.log(
          "info",
          `Incremental resync: fetching ${entity} updated since ${since.toISOString()}`,
        );
      }
    }
  }
  const pollSince = options.pollCursor?.since
    ? new Date(options.pollCursor.since)
    : undefined;
  const hasPollSince = Boolean(pollSince && !Number.isNaN(pollSince.getTime()));
  if (anchorIncremental) {
    const overlapMs = options.pollCursor?.overlapMs ?? pollOverlapMsFromEnv();
    const overlapMin = Math.round(overlapMs / 60_000);
    // The destination is always asked first: an empty or missing live table
    // (dropped, or the flow pointed at a new table) needs a full fetch even
    // when a poll cursor is on record, or older history never arrives.
    let destination:
      | { kind: "rows"; maxSyncedAt: string }
      | { kind: "empty"; reason: string }
      | { kind: "unknown"; reason: string };
    let maxOf: ((column: string) => Promise<string | undefined>) | undefined;
    try {
      const { getMaxTrackingValue } =
        await import("../services/destination-writer.service");
      const { DatabaseConnection } =
        await import("../database/workspace-schema");
      const destConn = await DatabaseConnection.findOne(
        inWorkspace(tableDestination.connectionId, options.workspaceId),
      );
      if (!destConn) {
        destination = { kind: "unknown", reason: "destination not found" };
      } else {
        const probe = (column: string) =>
          getMaxTrackingValue(
            destConn,
            entityTableName,
            column,
            tableDestination.schema,
            tableDestination.database,
          );
        maxOf = async column => {
          const r = await probe(column);
          return r.success ? r.maxValue : undefined;
        };
        const synced = await probe("_syncedAt");
        if (synced.success) {
          destination = synced.maxValue
            ? { kind: "rows", maxSyncedAt: synced.maxValue }
            : { kind: "empty", reason: "the live table is empty" };
        } else if (isMissingTableError(synced.error)) {
          destination = { kind: "empty", reason: "the live table is missing" };
        } else {
          destination = { kind: "unknown", reason: String(synced.error) };
        }
      }
    } catch (err) {
      destination = { kind: "unknown", reason: String(err) };
    }

    if (destination.kind === "empty") {
      logger?.log(
        "info",
        `Incremental poll: ${destination.reason} for ${entity}; fetching everything`,
      );
    } else if (hasPollSince && pollSince) {
      lastSyncDate = pollSince;
      if (destination.kind === "unknown") {
        logger?.log(
          "warn",
          `Could not read the destination for ${entity} (${destination.reason}); using the poll cursor`,
        );
      }
      logger?.log(
        "info",
        `Incremental poll: syncing ${entity} updated since ${pollSince.toISOString()} (poll cursor)`,
      );
    } else if (destination.kind === "unknown") {
      logger?.log(
        "warn",
        `Could not get incremental anchor from SQL destination: ${destination.reason}`,
      );
    } else if (maxOf) {
      const maxSourceTs = await maxOf("_mako_source_ts").catch(() => undefined);
      const fallback = destinationFallbackSince({
        maxSourceTs,
        maxSyncedAt: maxSourceTs ? undefined : destination.maxSyncedAt,
        overlapMs,
      });
      if (fallback) {
        lastSyncDate = fallback.since;
        logger?.log(
          fallback.column === "_syncedAt" ? "warn" : "info",
          fallback.column === "_syncedAt"
            ? `Incremental poll: ${entity} has no _mako_source_ts; anchoring on MAX(_syncedAt) minus ${overlapMin} min: ${fallback.since.toISOString()}`
            : `Incremental poll: no poll cursor on record for ${entity}; anchoring on MAX(_mako_source_ts) minus ${overlapMin} min: ${fallback.since.toISOString()}`,
        );
      }
    }
  }

  const progressReporter = new ProgressReporter(entity, undefined, logger);
  const previousRowsWritten = (() => {
    const raw = (state?.metadata as Record<string, unknown> | undefined)
      ?.rowsWrittenTotal;
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  })();
  let runningRowsWritten = previousRowsWritten;

  const entitySchema = await resolveEntitySchema({
    entity,
    connector: connector as any,
    sourceConnection,
    workspaceId: options.workspaceId,
    context: "syncChunk",
  });
  orchestratorLogger.info("Schema resolution result", {
    entity,
    hasSchema: !!entitySchema,
    fieldCount: entitySchema ? Object.keys(entitySchema.fields).length : 0,
  });

  const cdcLayout = isCdcEnabled
    ? buildCdcEntityLayout({
        entity,
        tableName: entityTableName,
        keyColumns: entitySchema?.keyColumns,
        deleteMode: options.deleteMode,
        writeMode: options.writeMode,
        partitioning: options.entityPartitioning,
        clustering: options.entityClustering,
      })
    : undefined;

  // Full Refresh | Overwrite: clear the live table once, before the first
  // chunk of the run writes (checkpoint resumes carry state and skip this).
  if (
    isCdcEnabled &&
    cdcAdapter?.truncateLiveTable &&
    cdcLayout &&
    options.writeMode === "overwrite" &&
    !state
  ) {
    await cdcAdapter.truncateLiveTable(cdcLayout);
    logger?.log(
      "info",
      `Overwrite mode: cleared live table ${entityTableName}`,
    );
  }

  const useBulkPath =
    isCdcEnabled && Boolean(cdcAdapter?.loadStagingFromParquet);
  let bulkTempCollection: Collection | null = null;
  const bulkRunId = options.backfillRunId || options.flowId || "";
  if (useBulkPath && options.flowId) {
    const db = Flow.db;
    bulkTempCollection = db.collection(
      bulkBufferName(options.flowId, entity, options.fullRead),
    );
    const isFirstChunk = !state || state.totalProcessed === 0;
    if (isFirstChunk) {
      await bulkTempCollection.deleteMany({});
    } else {
      const staleCount = await bulkTempCollection.countDocuments({
        _bulkRunId: { $ne: bulkRunId },
      });
      if (staleCount > 0) {
        await bulkTempCollection.deleteMany({
          _bulkRunId: { $ne: bulkRunId },
        });
        orchestratorLogger.info(
          "Cleared stale temp collection docs from previous run",
          { entity, staleCount, currentRunId: bulkRunId },
        );
      }
    }
  }

  const maxRetries = sourceConnection.settings?.max_retries || 3;
  const rateLimitDelay = sourceConnection.settings?.rate_limit_delay_ms || 200;
  const fetchState: FetchState = await executeWithRetry<FetchState>(
    () =>
      connector.fetchEntityChunk({
        entity,
        state,
        maxIterations,
        ...(lastSyncDate && { since: lastSyncDate }),
        onLog: (
          level: "debug" | "info" | "warn" | "error",
          message: string,
          metadata?: unknown,
        ) => logger?.log(level, message, metadata),
        onBatch: async (batch: any[]) => {
          if (batch.length === 0) return;

          logger?.log("info", "SQL batch received from source", {
            entity,
            fetchedCount: batch.length,
            syncMode,
          });

          const processedRecords = batch.map((record: any) => {
            // Undefined keys are absent keys. Dropping them here keeps the
            // Mongo bulk buffer from storing them as null (sparse-rows.ts).
            const keyed = stripUndefined(normalizePayloadKeys(record));
            const normalized = {
              ...withPolledDeleteState(keyed),
              _dataSourceId: sourceConnection.id,
              _dataSourceName: sourceConnection.name,
              _syncedAt: new Date(),
            };
            if (!entitySchema) return normalized;
            const { payload: typed } = normalizePayloadBySchema(
              normalized,
              entitySchema,
            );
            return typed;
          });

          if (isCdcEnabled) {
            if (!options.flowId || !options.workspaceId) {
              throw new Error(
                "BigQuery CDC requires flowId and workspaceId on chunk options",
              );
            }
            if (!cdcAdapter || !cdcLayout) {
              throw new Error("CDC adapter not initialized");
            }

            if (useBulkPath && bulkTempCollection) {
              const enrichedRecords = processedRecords.map(
                (record: Record<string, unknown>) => ({
                  ...nestedValuesAsJsonText(record, entitySchema),
                  _mako_source_ts: resolveSourceTimestamp(record),
                  _bulkRunId: bulkRunId,
                }),
              );
              await bulkTempCollection.insertMany(enrichedRecords, {
                ordered: false,
                // A hung buffer write held a CH Close backfill step open
                // for 40 min on 17 Nov 2026, until its instance shut down.
                // Fail the write instead, so the chunk step errors and
                // Inngest retries it from the last saved state.
                timeoutMS: BUFFER_WRITE_TIMEOUT_MS,
              });
              // Buffered, not written: the caller adds the rows its flush
              // merges into the destination (sync-entity.ts).
              logger?.log("info", "Buffered batch to MongoDB temp collection", {
                entity,
                fetchedCount: batch.length,
                writeMode: "bulk-buffer",
              });
              return;
            }

            const applyResult = await cdcAdapter.applyBatch({
              records: processedRecords,
              layout: cdcLayout,
              flow: {
                _id: new Types.ObjectId(options.flowId),
                deleteMode: options.deleteMode,
                dataSourceId:
                  typeof sourceConnection.id === "string" &&
                  Types.ObjectId.isValid(sourceConnection.id)
                    ? new Types.ObjectId(sourceConnection.id)
                    : undefined,
              } as any,
              entitySchema: entitySchema ?? undefined,
            });
            runningRowsWritten += applyResult.written;
            logger?.log("info", "SQL batch write succeeded", {
              entity,
              fetchedCount: batch.length,
              rowsWritten: applyResult.written,
              totalProcessed: runningRowsWritten,
              totalRowsWritten: runningRowsWritten,
              syncMode,
              writeMode: "cdc",
            });
            return;
          }
        },
        onProgress: (current: number, total?: number) => {
          progressReporter.reportProgress(current, total);
        },
      }),
    maxRetries,
    logger,
    options.step,
    `fetch-chunk-${entity}`,
    rateLimitDelay,
  );

  const nextMetadata =
    fetchState.metadata && typeof fetchState.metadata === "object"
      ? { ...(fetchState.metadata as Record<string, unknown>) }
      : {};
  nextMetadata.rowsWrittenTotal = runningRowsWritten;
  fetchState.metadata = nextMetadata;

  const completed = !fetchState.hasMore;

  if (useBulkPath) {
    // Bulk path: rows are in the buffer; the flush reports what it merged.
    if (completed) progressReporter.reportComplete();
    logger?.log(
      "info",
      `📊 ${entity} chunk buffered (${fetchState.totalProcessed} fetched so far)`,
    );
  } else if (completed) {
    progressReporter.reportComplete();

    const fetchWriteDelta = fetchState.totalProcessed - runningRowsWritten;
    logger?.log(
      "info",
      `✅ ${entity} SQL sync completed (${runningRowsWritten} written, ${fetchState.totalProcessed} fetched)`,
    );
    if (fetchWriteDelta !== 0) {
      logger?.log(
        "warn",
        `⚠️ ${entity} fetch/write mismatch: ${fetchState.totalProcessed} fetched but ${runningRowsWritten} written (delta: ${fetchWriteDelta})`,
        {
          entity,
          totalFetched: fetchState.totalProcessed,
          totalWritten: runningRowsWritten,
          delta: fetchWriteDelta,
        },
      );
    }
  } else {
    logger?.log(
      "info",
      `📊 ${entity} SQL chunk done (${runningRowsWritten} written, ${fetchState.totalProcessed} fetched so far)`,
    );
  }

  return {
    state: fetchState,
    entity,
    collectionName: entityTableName,
    completed,
    totalFetched: fetchState.totalProcessed,
    totalWritten: runningRowsWritten,
  };
}

/**
 * Max rows per parquet file in bulk flush.
 * A single DuckDB instance is used per parquet file; keep this large to avoid
 * spawning many instances (native memory overhead ~40-60 MB each, not released
 * to the OS promptly). The streaming pipeline micro-chunks rows via
 * MONGO_TO_PARQUET_CHUNK so peak JS heap stays bounded regardless of this value.
 */
function resolvePositiveIntEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Deadline for one insert into the bulk buffer (MongoDB CSOT `timeoutMS`). */
const BUFFER_WRITE_TIMEOUT_MS = resolvePositiveIntEnv(
  process.env.SYNC_BULK_BUFFER_WRITE_TIMEOUT_MS,
  120_000,
);

const FLUSH_BATCH_SIZE = resolvePositiveIntEnv(
  process.env.SYNC_BULK_FLUSH_BATCH_SIZE,
  2_000,
);

/** Absolute minimum rows per parquet flush — below this we surface the OOM error. */
const MIN_FLUSH_BATCH_SIZE = resolvePositiveIntEnv(
  process.env.SYNC_BULK_FLUSH_MIN_BATCH_SIZE,
  100,
);

/** Rows passed per DuckDB insertBatch from Mongo (parquet builder micro-chunks SQL). */
const MONGO_TO_PARQUET_CHUNK = resolvePositiveIntEnv(
  process.env.SYNC_BULK_MONGO_TO_PARQUET_CHUNK,
  100,
);

function syncMemorySnapshot(): {
  heapUsedMb: number;
  rssMb: number;
  externalMb: number;
} {
  const m = process.memoryUsage();
  return {
    heapUsedMb: Math.round(m.heapUsed / 1024 / 1024),
    rssMb: Math.round(m.rss / 1024 / 1024),
    externalMb: Math.round(m.external / 1024 / 1024),
  };
}

/**
 * Marks a buffered row as loaded into the staging table. The row stays in
 * the buffer until the merge (append_dedup: until performStagingCleanup;
 * append / overwrite: until just before the INSERT, see performStagingMerge),
 * so a failed load or a retried flush never leaves staging as the only copy.
 * A retried flush step drops staging and clears the marks
 * (performPrepareStaging), which loads every staged row again. Before this, each batch was deleted from the buffer as
 * soon as it was loaded, and a retry that dropped staging lost whole
 * FLUSH_BATCH_SIZE blocks while the run still reported "completed".
 */
export const BULK_STAGED_FIELD = "_mako_bulk_staged";

/**
 * The row cap for the retry after a flush batch failed with a DuckDB memory
 * error: half the rows the failed attempt read, or null when it cannot get
 * smaller. `minBatchSize` floors a batch the row cap ended. A batch the byte
 * budget ended was already below its row cap, so it halves past the floor,
 * down to 1 row: 2 MB rows end a 128 MiB batch at 64 rows, and a floor of
 * 100 would only read the same 64 again. So does a batch an earlier byte
 * cut already shrank below the floor.
 */
export function flushBatchSizeAfterMemoryError(params: {
  batchSize: number;
  rowsRead: number;
  minBatchSize: number;
}): number | null {
  const attempted = Math.min(
    params.batchSize,
    params.rowsRead || params.batchSize,
  );
  // Below the floor already (an earlier byte cut shrank it there): no floor.
  const byteCut =
    attempted < params.batchSize || params.batchSize < params.minBatchSize;
  const floor = byteCut ? 1 : params.minBatchSize;
  if (attempted <= floor) return null;
  return Math.max(floor, Math.floor(attempted / 2));
}

/**
 * A backfill (full read) and a poll of the same flow can run at once: Inngest
 * interleaves their steps. On 17 Nov a PostHog poll and backfill shared one
 * buffer and one staging table; one run's first chunk emptied the buffer the
 * other had filled, and 26 survey_responses never landed. Each lane gets its
 * own buffer and staging table. The full-read lane keeps the historical names.
 */
export function bulkBufferName(
  flowId: string,
  entity: string,
  fullRead?: boolean,
): string {
  const lane = fullRead === false ? "poll_tmp" : "backfill_tmp";
  return `${lane}_${flowId}_${entity.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/** The staging table suffix of a lane (see bulkBufferName). */
export function bulkStagingSuffix(fullRead?: boolean): string {
  return fullRead === false ? "poll_staging" : "backfill_staging";
}

function bulkBufferCollection(
  flowId: string,
  entity: string,
  fullRead?: boolean,
): Collection {
  return Flow.db.collection(bulkBufferName(flowId, entity, fullRead));
}
const NOT_STAGED = { [BULK_STAGED_FIELD]: { $ne: true } };

/**
 * Flush every not-yet-staged row from the temp collection to BQ staging in
 * batches of FLUSH_BATCH_SIZE.  Each batch builds its own parquet file and
 * loads it independently so peak memory stays bounded.
 *
 * This runs inside a single Inngest step — the internal loop handles memory
 * via small parquet files but doesn't create additional Inngest steps.
 */
async function flushBulkBuffer(
  tempCollection: Collection,
  cdcAdapter: CdcDestinationAdapter,
  cdcLayout: ReturnType<typeof buildCdcEntityLayout>,
  entity: string,
  flowId: string,
  logger?: SyncLogger,
  schemaFields?: FieldMeta[],
  onBatchFlushed?: () => Promise<void>,
  stagingSuffix: string = bulkStagingSuffix(),
): Promise<{ flushed: number }> {
  const initialCount = await tempCollection.countDocuments(NOT_STAGED);
  if (initialCount === 0) return { flushed: 0 };

  const loadStagingFromParquet =
    cdcAdapter.loadStagingFromParquet?.bind(cdcAdapter);
  if (!loadStagingFromParquet) return { flushed: 0 };

  let currentBatchSize = FLUSH_BATCH_SIZE;
  // Bytes per batch (BSON size of the buffered rows):
  // SYNC_BULK_FLUSH_BATCH_BYTES, else a quarter of the DuckDB memory limit.
  const batchBytes =
    resolvePositiveIntEnv(process.env.SYNC_BULK_FLUSH_BATCH_BYTES, 0) ||
    parquetBuildByteBudget();
  let totalFlushed = 0;
  let batchNum = 0;

  logger?.log(
    "info",
    `Flushing ${entity} buffer to staging (${initialCount.toLocaleString()} rows, batches of up to ${currentBatchSize.toLocaleString()} rows or ${Math.round(batchBytes / 1024 / 1024)} MiB)`,
    {
      entity,
      totalCount: initialCount,
      batchSize: currentBatchSize,
      batchBytes,
      minBatchSize: MIN_FLUSH_BATCH_SIZE,
      mongoStreamChunk: MONGO_TO_PARQUET_CHUNK,
      memoryBefore: syncMemorySnapshot(),
    },
  );

  // A buffered row lacks the schema columns its source read did not return
  // (Close Search never returns lead.source, only webhooks do). Staging
  // still has every schema column, so mark the ones each row lacks and the
  // MERGE keeps their live values (sparse-rows.ts).
  const schemaColumnNames = schemaFields?.map(f => f.name) ?? [];
  const markRows = (rows: Record<string, unknown>[]) =>
    cdcAdapter.honoursAbsentColumns && schemaColumnNames.length > 0
      ? markAbsentColumns(rows, schemaColumnNames)
      : rows;

  const DELETE_CHUNK = 2000;
  const CONSECUTIVE_OK_TO_GROW = 5;
  let consecutiveSuccesses = 0;
  let oomCeiling = FLUSH_BATCH_SIZE;

  let remaining = await tempCollection.countDocuments(NOT_STAGED);
  while (remaining > 0) {
    batchNum++;
    const effectiveBatchSize = Math.min(currentBatchSize, remaining);

    let docIdChunks: unknown[][] = [];
    let currentChunk: unknown[] = [];

    const memBeforeBatch = syncMemorySnapshot();
    logger?.log(
      "debug",
      `${entity} flush batch ${batchNum}: starting parquet build (${effectiveBatchSize} rows, rss ${memBeforeBatch.rssMb}MB, heap ${memBeforeBatch.heapUsedMb}MB)`,
      { entity, batch: batchNum, effectiveBatchSize, memory: memBeforeBatch },
    );

    const tParquetStart = Date.now();
    let rowsRead = 0;
    let bytesRead = 0;

    let parquet;
    try {
      parquet = await buildParquetFromBatches({
        filenameBase: `backfill-${entity}`,
        fields: schemaFields,
        requiredTimestampColumns: SYNC_REQUIRED_TIMESTAMP_COLUMNS,
        streamBatches: async insertBatch => {
          const cursor = tempCollection
            .find(NOT_STAGED, {
              projection: { _bulkRunId: 0, [BULK_STAGED_FIELD]: 0 },
            })
            .sort({ _id: 1 })
            .limit(effectiveBatchSize);

          let buffer: Record<string, unknown>[] = [];
          for await (const doc of cursor) {
            const d = doc as Record<string, unknown>;
            // The batch ends at its byte budget as well as its row count:
            // wide rows past the budget fail the build (see
            // parquetBuildByteBudget). The rows left stay for the next batch.
            if (rowsRead > 0 && bytesRead >= batchBytes) break;
            rowsRead++;
            bytesRead += BSON.calculateObjectSize(d);
            const { _id, ...rest } = d;
            currentChunk.push(_id);
            if (currentChunk.length >= DELETE_CHUNK) {
              docIdChunks.push(currentChunk);
              currentChunk = [];
            }
            buffer.push(rest);
            if (buffer.length >= MONGO_TO_PARQUET_CHUNK) {
              await insertBatch(markRows(buffer));
              buffer = [];
            }
          }
          if (buffer.length > 0) {
            await insertBatch(markRows(buffer));
          }
          if (currentChunk.length > 0) {
            docIdChunks.push(currentChunk);
            currentChunk = [];
          }
        },
      });
    } catch (err) {
      if (isDuckDBMemoryError(err)) {
        const shrunkSize = flushBatchSizeAfterMemoryError({
          batchSize: currentBatchSize,
          rowsRead,
          minBatchSize: MIN_FLUSH_BATCH_SIZE,
        });

        if (shrunkSize === null) {
          logger?.log(
            "error",
            `${entity} flush: DuckDB memory error at minimum batch size (${Math.min(currentBatchSize, rowsRead || currentBatchSize)} rows), cannot shrink further`,
            {
              entity,
              batchSize: currentBatchSize,
              rowsRead,
              minBatchSize: MIN_FLUSH_BATCH_SIZE,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          throw err;
        }

        oomCeiling = currentBatchSize;
        logger?.log(
          "warn",
          `${entity} flush batch ${batchNum}: DuckDB memory error, reducing batch size from ${currentBatchSize} to ${shrunkSize} and retrying (ceiling now ${oomCeiling})`,
          {
            entity,
            previousBatchSize: currentBatchSize,
            newBatchSize: shrunkSize,
            oomCeiling,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        currentBatchSize = shrunkSize;
        consecutiveSuccesses = 0;
        batchNum--;
        continue;
      }
      throw err;
    }

    const parquetMs = Date.now() - tParquetStart;
    const memAfterParquet = syncMemorySnapshot();
    logger?.log(
      "debug",
      `${entity} flush batch ${batchNum}: parquet built (${parquet.rowCount} rows, ${parquetMs}ms, rss ${memAfterParquet.rssMb}MB, heap ${memAfterParquet.heapUsedMb}MB)`,
      {
        entity,
        batch: batchNum,
        rowCount: parquet.rowCount,
        parquetMs,
        memory: memAfterParquet,
      },
    );

    if (parquet.rowCount === 0) {
      const actualRemaining = await tempCollection.countDocuments(NOT_STAGED);
      logger?.log(
        "warn",
        `${entity} flush: empty parquet (possible race), stopping flush loop (${actualRemaining} rows still in temp, ${totalFlushed} flushed so far)`,
        { entity, batch: batchNum, actualRemaining, totalFlushed },
      );
      break;
    }

    const tLoadStart = Date.now();
    const LOAD_MAX_RETRIES = 3;
    try {
      for (let attempt = 1; attempt <= LOAD_MAX_RETRIES; attempt++) {
        try {
          await loadStagingFromParquet(parquet.filePath, cdcLayout, flowId, {
            stagingSuffix,
            skipDrop: true,
            skipParquetCleanup: true,
          });
          break;
        } catch (err) {
          if (attempt === LOAD_MAX_RETRIES) throw err;
          const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 15_000);
          logger?.log(
            "warn",
            `${entity} flush batch ${batchNum} load failed (attempt ${attempt}/${LOAD_MAX_RETRIES}), retrying in ${backoffMs}ms`,
            { entity, batch: batchNum, attempt, error: String(err) },
          );
          await new Promise(r => setTimeout(r, backoffMs));
        }
      }
    } finally {
      await fs.rm(parquet.filePath, { force: true }).catch(() => undefined);
    }
    const loadMs = Date.now() - tLoadStart;
    const memAfterLoad = syncMemorySnapshot();
    logger?.log(
      "debug",
      `${entity} flush batch ${batchNum}: staging load complete (${loadMs}ms, rss ${memAfterLoad.rssMb}MB, heap ${memAfterLoad.heapUsedMb}MB)`,
      { entity, batch: batchNum, loadMs, memory: memAfterLoad },
    );

    // Mark, don't delete: until the merge runs, staging must not be the
    // only copy of these rows (see BULK_STAGED_FIELD).
    let batchRows = 0;
    for (const chunk of docIdChunks) {
      await tempCollection.updateMany(
        { _id: { $in: chunk as any } },
        { $set: { [BULK_STAGED_FIELD]: true } },
      );
      batchRows += chunk.length;
    }
    docIdChunks = [];
    totalFlushed += batchRows;

    if (global.gc) {
      global.gc();
    }

    await onBatchFlushed?.();

    consecutiveSuccesses++;
    if (
      consecutiveSuccesses >= CONSECUTIVE_OK_TO_GROW &&
      currentBatchSize < oomCeiling
    ) {
      const grownSize = Math.min(currentBatchSize * 2, oomCeiling);
      if (grownSize > currentBatchSize) {
        logger?.log(
          "info",
          `${entity} flush: ${consecutiveSuccesses} consecutive successes, growing batch size from ${currentBatchSize} to ${grownSize} (ceiling ${oomCeiling})`,
          {
            entity,
            previousBatchSize: currentBatchSize,
            newBatchSize: grownSize,
            oomCeiling,
          },
        );
        currentBatchSize = grownSize;
      }
      consecutiveSuccesses = 0;
    }

    logger?.log(
      "info",
      `📦 ${entity} flush batch ${batchNum} — ${batchRows.toLocaleString()} rows (${totalFlushed.toLocaleString()}/${initialCount.toLocaleString()}) [parquet ${parquetMs}ms, load ${loadMs}ms, batchSize ${effectiveBatchSize}]`,
      {
        entity,
        batch: batchNum,
        batchRows,
        totalFlushed,
        totalCount: initialCount,
        effectiveBatchSize,
        durationParquetMs: parquetMs,
        durationLoadStagingMs: loadMs,
        memory: syncMemorySnapshot(),
      },
    );

    remaining = await tempCollection.countDocuments(NOT_STAGED);
  }

  logger?.log(
    "info",
    `✅ ${entity} buffer fully flushed to staging (${totalFlushed.toLocaleString()} rows in ${batchNum} batch${batchNum !== 1 ? "es" : ""})`,
    {
      entity,
      totalFlushed,
      initialCount,
      batches: batchNum,
      finalBatchSize: currentBatchSize,
      memory: syncMemorySnapshot(),
    },
  );

  if (totalFlushed !== initialCount) {
    logger?.log(
      "warn",
      `⚠️ ${entity} flush mismatch: ${initialCount} rows in temp but only ${totalFlushed} flushed to staging (${initialCount - totalFlushed} lost)`,
      {
        entity,
        initialCount,
        totalFlushed,
        delta: initialCount - totalFlushed,
      },
    );
  }

  return { flushed: totalFlushed };
}

async function resolveAdapterContext(options: SyncChunkOptions) {
  const entity = options.entity;
  const tableDestination = options.tableDestination;
  if (!tableDestination) {
    throw new Error(
      "resolveAdapterContext requires options.tableDestination to be set",
    );
  }
  const entityTableName = getEntityTableName(
    tableDestination.tableName,
    entity,
  );
  const destinationConn = await DatabaseConnection.findOne(
    inWorkspace(tableDestination.connectionId, options.workspaceId),
  )
    .select({ type: 1 })
    .lean();

  const cdcAdapter = resolveCdcDestinationAdapter({
    destinationType: destinationConn?.type || "",
    flowId: options.flowId,
    workspaceId: options.workspaceId,
    destinationDatabaseId: options.destinationId,
    destinationDatabaseName: options.destinationDatabaseName,
    tableDestination: {
      connectionId: String(tableDestination.connectionId),
      schema: tableDestination.schema || "public",
      tableName: entityTableName,
    },
  });

  return { entity, entityTableName, cdcAdapter };
}

export async function performBulkFlush(
  options: SyncChunkOptions,
  onBatchFlushed?: () => Promise<void>,
): Promise<{ flushed: number }> {
  if (!options.tableDestination?.connectionId || !options.flowId) {
    return { flushed: 0 };
  }
  const flowId = options.flowId;
  const { entity, entityTableName, cdcAdapter } =
    await resolveAdapterContext(options);

  if (!cdcAdapter.loadStagingFromParquet) return { flushed: 0 };

  const tempCollection = bulkBufferCollection(flowId, entity, options.fullRead);

  const entitySchema = await resolveEntitySchema({
    entity,
    dataSourceId: options.dataSourceId,
    workspaceId: options.workspaceId,
    queries: options.queries,
    context: "performBulkFlush",
  });
  const cdcLayout = buildCdcEntityLayout({
    entity,
    tableName: entityTableName,
    keyColumns: entitySchema?.keyColumns,
  });
  const schemaFields: FieldMeta[] | undefined = entitySchema
    ? Object.entries(entitySchema.fields).map(([name, f]) => ({
        name,
        type: f.type,
      }))
    : undefined;

  orchestratorLogger.info("performBulkFlush: flushing buffer to staging", {
    entity,
    flowId,
    hasSchema: !!entitySchema,
  });
  return flushBulkBuffer(
    tempCollection,
    cdcAdapter,
    cdcLayout,
    entity,
    flowId,
    options.logger,
    schemaFields,
    onBatchFlushed,
    bulkStagingSuffix(options.fullRead),
  );
}

/**
 * Clears the live table for `writeMode: "overwrite"` bulk-staging runs.
 *
 * Callers MUST invoke this exactly once per entity sync run (from the
 * initial `prepare-staging-*` step only). It is deliberately NOT called from
 * `performPrepareStaging`, which runs once per flush cycle (0..N times per
 * run) — truncating there wiped rows written by earlier flushes of the same
 * run, leaving only the last flush's rows in the live table (see
 * `docs/sync-modes-hardening-plan.md`, Phase 1 / bug B1).
 */
export async function performOverwriteTruncate(
  options: SyncChunkOptions,
): Promise<void> {
  if (!options.tableDestination?.connectionId || !options.flowId) return;
  if (options.writeMode !== "overwrite") return;
  const flowId = options.flowId;
  const { entity, entityTableName, cdcAdapter } =
    await resolveAdapterContext(options);

  if (!cdcAdapter.truncateLiveTable) return;

  const cdcLayout = buildCdcEntityLayout({
    entity,
    tableName: entityTableName,
    writeMode: options.writeMode,
  });

  await cdcAdapter.truncateLiveTable(cdcLayout);
  orchestratorLogger.info("Overwrite mode: cleared live table (once per run)", {
    entity,
    flowId,
  });
}

export async function performPrepareStaging(
  options: SyncChunkOptions,
): Promise<void> {
  if (!options.tableDestination?.connectionId || !options.flowId) return;
  const flowId = options.flowId;
  const { entity, entityTableName, cdcAdapter } =
    await resolveAdapterContext(options);

  if (!cdcAdapter.prepareStaging) return;

  const cdcLayout = buildCdcEntityLayout({
    entity,
    tableName: entityTableName,
    writeMode: options.writeMode,
  });

  orchestratorLogger.info(
    "performPrepareStaging: dropping staging table for fresh load",
    { entity, flowId },
  );
  // strict: the marks below are cleared only once staging is really gone.
  // A swallowed drop failure would leave the staged rows in staging and
  // load them a second time.
  await cdcAdapter.prepareStaging(cdcLayout, flowId, {
    stagingSuffix: bulkStagingSuffix(options.fullRead),
    strict: true,
  });

  // Staging is empty now, so no buffered row is in it any more: clear the
  // marks so the next flush loads those rows again (see BULK_STAGED_FIELD).
  const { modifiedCount } = await bulkBufferCollection(
    flowId,
    entity,
    options.fullRead,
  ).updateMany(
    { [BULK_STAGED_FIELD]: true },
    { $unset: { [BULK_STAGED_FIELD]: "" } },
  );
  if (modifiedCount > 0) {
    orchestratorLogger.warn(
      "Staging dropped before its merge ran; its rows go back to the flush buffer",
      { entity, flowId, rows: modifiedCount },
    );
  }
}

/**
 * Merges whatever a previous attempt left in the backfill staging table into
 * live, then drops the staging table for a fresh load.
 *
 * Use this instead of a bare `performPrepareStaging` wherever a flush follows.
 * An Inngest retry of a flush step (load failure, merge timeout, instance
 * restart) used to start by dropping staging. `performBulkFlush` used to
 * delete each batch from the temp buffer as soon as it was loaded, so the
 * retry lost every batch the failed attempt had already loaded — whole
 * FLUSH_BATCH_SIZE blocks, with the run still reporting "completed". The
 * buffer now keeps staged rows until the merge (BULK_STAGED_FIELD), so a
 * drop no longer loses rows in any write mode; the rescue merge stays for
 * staging left by a run that crashed before that change.
 *
 * `dedupOnly` (the per-flush steps): rescue only when the merge is keyed
 * (`append_dedup`, the default), where merging the same rows twice is a
 * no-op. A retry cannot tell whether the failed attempt's merge had already
 * committed, or whether a batch in staging is also still in the buffer; in
 * `append` / `overwrite` the merge is a plain INSERT, so a rescue there could
 * write rows to live twice. Those modes keep the previous behaviour (drop
 * staging and re-flush from the buffer).
 *
 * A merge failure is rethrown, so the caller never goes on to drop staging
 * rows it could not merge. Adapters return `{ written: 0 }` for a missing or
 * empty staging table; the only error treated as "nothing to rescue" is a
 * destination dataset that does not exist yet (first run).
 */
export async function performRescueAndPrepareStaging(
  options: SyncChunkOptions,
  opts?: { dedupOnly?: boolean },
): Promise<{ rescued: number }> {
  const isDedup =
    options.writeMode !== "append" && options.writeMode !== "overwrite";
  let rescued = 0;
  if (isDedup || !opts?.dedupOnly) {
    try {
      // A per-flush rescue (dedupOnly) merges rows an earlier attempt of the
      // same step loaded, so they keep this run's guard. The run-start
      // rescue may merge an earlier run of another kind (a poll): strict.
      rescued = (
        await performStagingMerge(
          {
            ...options,
            fullRead: opts?.dedupOnly ? options.fullRead : false,
          },
          { mergePath: "rescue" },
        )
      ).written;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!STAGING_CONTAINER_MISSING.test(message)) {
        throw err;
      }
    }
  }
  if (rescued > 0) {
    orchestratorLogger.warn(
      "Rescued staging rows left by a previous attempt before dropping staging",
      { entity: options.entity, flowId: options.flowId, rescued },
    );
    // The staged rows are in live now: release them from the buffer so the
    // drop below does not send them back to be loaded again.
    if (options.flowId) {
      await bulkBufferCollection(
        options.flowId,
        options.entity,
        options.fullRead,
      ).deleteMany({
        [BULK_STAGED_FIELD]: true,
      });
    }
  }
  await performPrepareStaging(options);
  return { rescued };
}

// The destination dataset/database itself is missing: nothing was ever
// staged. Deliberately does NOT match "Not found: Table …" — that is a real
// merge failure (e.g. live table dropped under a stale schema cache), and
// swallowing it would drop the staged rows.
const STAGING_CONTAINER_MISSING =
  /not found: dataset|was not found in location/i;

/**
 * Empty an entity's flush buffer. sync-entity.ts saves a resume cursor only
 * when the buffer is empty, so rows found here at the start of an invocation
 * lie past the cursor (a cancelled or failed attempt) and are fetched again.
 */
export async function discardBulkBuffer(
  flowId: string,
  entity: string,
  fullRead?: boolean,
): Promise<number> {
  const { deletedCount } = await bulkBufferCollection(
    flowId,
    entity,
    fullRead,
  ).deleteMany({});
  return deletedCount ?? 0;
}

export function getTempCollectionCount(
  flowId: string,
  entity: string,
  fullRead?: boolean,
): Promise<number> {
  return bulkBufferCollection(flowId, entity, fullRead).countDocuments();
}

export async function performStagingMerge(
  options: SyncChunkOptions,
  opts?: { mergePath?: CdcMergePath },
): Promise<{ written: number }> {
  if (!options.tableDestination?.connectionId || !options.flowId) {
    return { written: 0 };
  }
  const flowId = options.flowId;
  const { entity, entityTableName, cdcAdapter } =
    await resolveAdapterContext(options);

  if (!cdcAdapter.mergeFromStaging) return { written: 0 };

  const sourceConnection = await sourceConnectionManager.getSourceConnection(
    options.dataSourceId,
    options.workspaceId,
  );
  const entitySchema = await resolveEntitySchema({
    entity,
    sourceConnection,
    dataSourceId: options.dataSourceId,
    workspaceId: options.workspaceId,
    queries: options.queries,
    context: "performStagingMerge",
  });
  // Resolve the schema first: it can throw (and retry), and a throw after
  // the release below would leave staging as the rows' only copy, which the
  // next run's prepare drops.
  // append / overwrite merge with a plain INSERT. Release the staged rows
  // from the buffer before it, so no later flush can load them again: from
  // here staging is their only copy, and it stays until cleanup. The merge
  // runs in its own Inngest step (flush-apply / merge-final), so a failed
  // merge is retried against that staging table, not re-flushed. A merge
  // that commits and then throws is retried too and appends twice: a retry
  // cannot tell it from one that failed, and a duplicate beats a lost row.
  // append_dedup keeps the rows until cleanup: its keyed merge is a no-op
  // the second time.
  const isDedup =
    options.writeMode !== "append" && options.writeMode !== "overwrite";
  if (!isDedup) {
    await bulkBufferCollection(flowId, entity, options.fullRead).deleteMany({
      [BULK_STAGED_FIELD]: true,
    });
  }

  const cdcLayout = buildCdcEntityLayout({
    entity,
    tableName: entityTableName,
    keyColumns: entitySchema?.keyColumns,
    writeMode: options.writeMode,
    partitioning: options.entityPartitioning,
    clustering: options.entityClustering,
  });

  orchestratorLogger.info("performStagingMerge: merging staging to live", {
    entity,
    flowId,
  });
  return cdcAdapter.mergeFromStaging(
    cdcLayout,
    {
      _id: new Types.ObjectId(flowId),
      deleteMode: options.deleteMode,
      dataSourceId:
        sourceConnection &&
        typeof sourceConnection.id === "string" &&
        Types.ObjectId.isValid(sourceConnection.id)
          ? new Types.ObjectId(sourceConnection.id)
          : undefined,
    } as any,
    flowId,
    entitySchema ?? undefined,
    {
      stagingSuffix: bulkStagingSuffix(options.fullRead),
      fullRead: options.fullRead,
      mergePath: opts?.mergePath ?? "final",
    },
  );
}

export async function performStagingCleanup(
  options: SyncChunkOptions,
): Promise<void> {
  if (!options.tableDestination?.connectionId || !options.flowId) return;
  const flowId = options.flowId;
  const { entity, entityTableName, cdcAdapter } =
    await resolveAdapterContext(options);

  if (!cdcAdapter.cleanupStaging) return;

  const cdcLayout = buildCdcEntityLayout({
    entity,
    tableName: entityTableName,
  });
  orchestratorLogger.info(
    "performStagingCleanup: dropping staging table and temp collection",
    { entity, flowId },
  );
  // The merge has run: the staged rows are in live. Delete them from the
  // buffer before dropping staging, so a crash in between leaves rows a
  // retry can only re-merge from staging (append_dedup) or skip, never load
  // twice from the buffer.
  const tempCollection = bulkBufferCollection(flowId, entity, options.fullRead);
  await tempCollection.deleteMany({ [BULK_STAGED_FIELD]: true });

  await cdcAdapter.cleanupStaging(cdcLayout, flowId, {
    stagingSuffix: bulkStagingSuffix(options.fullRead),
  });

  // Rows still here were never staged (a flush that stopped early). Keep
  // them for the next flush instead of dropping them with the collection.
  const leftover = await tempCollection.countDocuments();
  if (leftover > 0) {
    orchestratorLogger.warn(
      "performStagingCleanup: rows left in the flush buffer were never staged; keeping them",
      { entity, flowId, leftover },
    );
    return;
  }
  await tempCollection.drop().catch(() => undefined);
}
