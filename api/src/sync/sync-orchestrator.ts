import { promises as fs } from "fs";
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
  buildParquetFromBatches,
  isDuckDBMemoryError,
  type FieldMeta,
} from "../utils/streaming-parquet-builder";
import { Collection } from "mongodb";
import { Types } from "mongoose";
import { ProgressReporter } from "./progress-reporter";
import axios from "axios";
import { loggers } from "../logging";
import { LEGACY_ENGINE_REMOVED } from "../services/flow-triggers.service";
import {
  normalizePayloadKeys,
  normalizePayloadBySchema,
  resolveSourceTimestamp,
} from "../sync-cdc/normalization";
import {
  buildCdcEntityLayout,
  hasCdcDestinationAdapter,
  resolveCdcDestinationAdapter,
  type CdcDestinationAdapter,
} from "../sync-cdc/adapters/registry";

const orchestratorLogger = loggers.sync("orchestrator");

async function resolveEntitySchemaSafe(params: {
  entity: string;
  dataSourceId?: string;
  sourceConnection?: { id?: string } | null;
  connector?: { resolveSchema?: (entity: string) => Promise<unknown> } | null;
  context: string;
}): Promise<ConnectorEntitySchema | null> {
  try {
    let connector = params.connector;
    if (!connector) {
      const ds =
        params.sourceConnection ||
        (params.dataSourceId
          ? await sourceConnectionManager.getSourceConnection(
              params.dataSourceId,
            )
          : null);
      if (!ds) return null;
      connector = await syncConnectorRegistry.getConnectorFor(ds as any);
    }
    const schema = connector?.resolveSchema
      ? ((await connector.resolveSchema(
          params.entity,
        )) as ConnectorEntitySchema)
      : null;
    return schema || null;
  } catch (err) {
    orchestratorLogger.warn("Schema resolution failed", {
      entity: params.entity,
      context: params.context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function camelToSnake(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
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
  workspaceId?: string;
  syncEngine?: string;
  backfillRunId?: string;
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
    const sourceConnection =
      await sourceConnectionManager.getSourceConnection(dataSourceId);
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

  const destinationConn = await DatabaseConnection.findById(
    tableDestination.connectionId,
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
    destinationDatabaseId: options.destinationId,
    destinationDatabaseName: options.destinationDatabaseName,
    tableDestination: {
      connectionId: String(tableDestination.connectionId),
      schema: tableDestination.schema || "public",
      tableName: entityTableName,
    },
  });

  // Incremental: get last sync date from destination table.
  //
  // Historically skipped for CDC because CDC runs were always full webhook
  // backfills. Under the unified trigger model a scheduled CDC flow polls
  // with syncMode=incremental, and without an anchor every poll would
  // re-fetch the entire entity. The CDC live table carries the same
  // _syncedAt column, so anchor there too. Note: incremental CDC polls are
  // upsert-only; deletes are reconciled by the periodic full backfill
  // (backfillSchedule), not by polls.
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
  if (anchorIncremental) {
    try {
      const { getMaxTrackingValue } =
        await import("../services/destination-writer.service");
      const { DatabaseConnection } =
        await import("../database/workspace-schema");
      const destConn = await DatabaseConnection.findById(
        tableDestination.connectionId,
      );
      if (destConn) {
        const result = await getMaxTrackingValue(
          destConn,
          entityTableName,
          "_syncedAt",
          tableDestination.schema,
          tableDestination.database,
        );
        if (result.success && result.maxValue) {
          lastSyncDate = new Date(result.maxValue);
          logger?.log(
            "info",
            `Incremental from SQL: syncing ${entity} after ${lastSyncDate.toISOString()}`,
          );
        }
      }
    } catch (err) {
      logger?.log(
        "warn",
        `Could not get incremental anchor from SQL destination: ${err}`,
      );
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

  const entitySchema = await resolveEntitySchemaSafe({
    entity,
    connector: connector as any,
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
    const collName = `backfill_tmp_${options.flowId}_${entity.replace(/[^a-zA-Z0-9]/g, "_")}`;
    bulkTempCollection = db.collection(collName);
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
            const normalized = {
              ...normalizePayloadKeys(record),
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
                  ...record,
                  _mako_source_ts: resolveSourceTimestamp(record),
                  _bulkRunId: bulkRunId,
                }),
              );
              await bulkTempCollection.insertMany(enrichedRecords, {
                ordered: false,
              });
              runningRowsWritten += processedRecords.length;
              logger?.log("info", "Buffered batch to MongoDB temp collection", {
                entity,
                fetchedCount: batch.length,
                totalProcessed: runningRowsWritten,
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

  if (completed) {
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
 * Flush ALL rows from the temp collection to BQ staging in batches of
 * FLUSH_BATCH_SIZE.  Each batch builds its own parquet file and loads it
 * independently so peak memory stays bounded.
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
): Promise<{ flushed: number }> {
  const initialCount = await tempCollection.countDocuments();
  if (initialCount === 0) return { flushed: 0 };

  const loadStagingFromParquet =
    cdcAdapter.loadStagingFromParquet?.bind(cdcAdapter);
  if (!loadStagingFromParquet) return { flushed: 0 };

  let currentBatchSize = FLUSH_BATCH_SIZE;
  let totalFlushed = 0;
  let batchNum = 0;

  logger?.log(
    "info",
    `Flushing ${entity} buffer to staging (${initialCount.toLocaleString()} rows, starting batch size ${currentBatchSize.toLocaleString()})`,
    {
      entity,
      totalCount: initialCount,
      batchSize: currentBatchSize,
      minBatchSize: MIN_FLUSH_BATCH_SIZE,
      mongoStreamChunk: MONGO_TO_PARQUET_CHUNK,
      memoryBefore: syncMemorySnapshot(),
    },
  );

  const DELETE_CHUNK = 2000;
  const CONSECUTIVE_OK_TO_GROW = 5;
  let consecutiveSuccesses = 0;
  let oomCeiling = FLUSH_BATCH_SIZE;

  let remaining = await tempCollection.countDocuments();
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

    let parquet;
    try {
      parquet = await buildParquetFromBatches({
        filenameBase: `backfill-${entity}`,
        fields: schemaFields,
        streamBatches: async insertBatch => {
          const cursor = tempCollection
            .find({}, { projection: { _bulkRunId: 0 } })
            .sort({ _id: 1 })
            .limit(effectiveBatchSize);

          let buffer: Record<string, unknown>[] = [];
          for await (const doc of cursor) {
            const d = doc as Record<string, unknown>;
            const { _id, ...rest } = d;
            currentChunk.push(_id);
            if (currentChunk.length >= DELETE_CHUNK) {
              docIdChunks.push(currentChunk);
              currentChunk = [];
            }
            buffer.push(rest);
            if (buffer.length >= MONGO_TO_PARQUET_CHUNK) {
              await insertBatch(buffer);
              buffer = [];
            }
          }
          if (buffer.length > 0) {
            await insertBatch(buffer);
          }
          if (currentChunk.length > 0) {
            docIdChunks.push(currentChunk);
            currentChunk = [];
          }
        },
      });
    } catch (err) {
      if (isDuckDBMemoryError(err)) {
        const shrunkSize = Math.max(
          MIN_FLUSH_BATCH_SIZE,
          Math.floor(currentBatchSize / 2),
        );

        if (
          shrunkSize <= MIN_FLUSH_BATCH_SIZE &&
          currentBatchSize <= MIN_FLUSH_BATCH_SIZE
        ) {
          logger?.log(
            "error",
            `${entity} flush: DuckDB memory error at minimum batch size (${currentBatchSize}), cannot shrink further`,
            {
              entity,
              batchSize: currentBatchSize,
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
      const actualRemaining = await tempCollection.countDocuments();
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
            stagingSuffix: "backfill_staging",
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

    let batchRows = 0;
    for (const chunk of docIdChunks) {
      await tempCollection.deleteMany({ _id: { $in: chunk as any } });
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

    remaining = await tempCollection.countDocuments();
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
  const destinationConn = await DatabaseConnection.findById(
    tableDestination.connectionId,
  )
    .select({ type: 1 })
    .lean();

  const cdcAdapter = resolveCdcDestinationAdapter({
    destinationType: destinationConn?.type || "",
    flowId: options.flowId,
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

  const db = Flow.db;
  const collName = `backfill_tmp_${options.flowId}_${entity.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const tempCollection = db.collection(collName);

  const entitySchema = await resolveEntitySchemaSafe({
    entity,
    dataSourceId: options.dataSourceId,
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
  await cdcAdapter.prepareStaging(cdcLayout, flowId, {
    stagingSuffix: "backfill_staging",
  });
}

export function getTempCollectionCount(
  flowId: string,
  entity: string,
): Promise<number> {
  const db = Flow.db;
  const collName = `backfill_tmp_${flowId}_${entity.replace(/[^a-zA-Z0-9]/g, "_")}`;
  return db.collection(collName).countDocuments();
}

export async function performStagingMerge(
  options: SyncChunkOptions,
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
  );
  const entitySchema = await resolveEntitySchemaSafe({
    entity,
    sourceConnection,
    context: "performStagingMerge",
  });
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
    { stagingSuffix: "backfill_staging" },
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
  await cdcAdapter.cleanupStaging(cdcLayout, flowId, {
    stagingSuffix: "backfill_staging",
  });

  const db = Flow.db;
  const collName = `backfill_tmp_${flowId}_${entity.replace(/[^a-zA-Z0-9]/g, "_")}`;
  await db
    .collection(collName)
    .drop()
    .catch(() => undefined);
}
