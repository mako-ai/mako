import { syncConnectorRegistry } from "./connector-registry";
import { databaseDataSourceManager } from "./database-data-source-manager";
import { getDestinationManager } from "./destination-manager";
import {
  databaseConnectionService,
  ConnectionConfig,
} from "../services/database-connection.service";
import { SyncLogger, FetchState } from "../connectors/base/BaseConnector";
import { ITableDestination } from "../database/workspace-schema";
import { createDestinationWriter } from "../services/destination-writer.service";
import { Db } from "mongodb";
import { Types } from "mongoose";
import { ProgressReporter } from "./progress-reporter";
import axios from "axios";
import { loggers } from "../logging";

const orchestratorLogger = loggers.sync("orchestrator");

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
 * Ensure required indexes exist on a collection for efficient sync operations
 */
async function ensureCollectionIndexes(
  collection: any,
  logger?: SyncLogger,
): Promise<void> {
  try {
    // Get existing indexes
    const existingIndexes = await collection.indexes();
    const existingIndexNames = existingIndexes.map((idx: any) => idx.name);

    // 1. Unique index on 'id' field for webhook updates
    if (
      !existingIndexNames.includes("id_unique_idx") &&
      !existingIndexNames.includes("id_1")
    ) {
      await collection.createIndex(
        { id: 1 },
        {
          unique: true,
          background: true,
          name: "id_unique_idx",
          partialFilterExpression: { id: { $exists: true } },
        },
      );
      logger?.log(
        "info",
        `Created unique id index for ${collection.collectionName}`,
      );
    }

    // 2. Compound index for bulk sync upserts (uses both id and _dataSourceId)
    if (!existingIndexNames.includes("sync_upsert_idx")) {
      await collection.createIndex(
        { id: 1, _dataSourceId: 1 },
        {
          background: true,
          name: "sync_upsert_idx",
        },
      );
      logger?.log(
        "info",
        `Created sync upsert index for ${collection.collectionName}`,
      );
    }

    // 3. Index for incremental sync date queries
    if (!existingIndexNames.includes("incremental_sync_idx")) {
      await collection.createIndex(
        { _dataSourceId: 1, _syncedAt: -1 },
        {
          background: true,
          name: "incremental_sync_idx",
        },
      );
      logger?.log(
        "info",
        `Created incremental sync index for ${collection.collectionName}`,
      );
    }
  } catch (error) {
    logger?.log(
      "warn",
      `Failed to create indexes: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Don't throw - indexes are for performance, not correctness
  }
}

/**
 * Performs a single chunk of sync work and returns state for resumption
 */
export async function performSyncChunk(
  options: SyncChunkOptions,
): Promise<SyncChunkResult> {
  const {
    dataSourceId,
    destinationId,
    destinationDatabaseName,
    entity,
    isIncremental,
    state,
    maxIterations = 10,
    logger,
    queries,
  } = options;

  const syncMode = isIncremental ? "incremental" : "full";
  let db: Db | null = null;

  try {
    // Get the data source
    const dataSource =
      await databaseDataSourceManager.getDataSource(dataSourceId);
    if (!dataSource) {
      throw new Error(`Data source '${dataSourceId}' not found`);
    }

    if (!dataSource.active) {
      throw new Error(`Data source '${dataSource.name}' is not active`);
    }

    // Inject transfer queries into dataSource for GraphQL/PostHog connectors
    // The registry maps connection -> config when creating the connector
    if (queries && queries.length > 0) {
      dataSource.connection = {
        ...dataSource.connection,
        queries,
      };
    }

    // Get connector from registry
    const connector = await syncConnectorRegistry.getConnector(dataSource);
    if (!connector) {
      throw new Error(
        `Failed to create connector for type: ${dataSource.type}`,
      );
    }

    // Check if connector supports resumable fetching
    if (!connector.supportsResumableFetching()) {
      throw new Error(
        `Connector ${dataSource.type} does not support resumable fetching`,
      );
    }

    // ========== SQL/BigQuery destination path ==========
    if (options.tableDestination?.connectionId) {
      return performSyncChunkSql(options, dataSource, connector, syncMode);
    }

    // ========== Legacy MongoDB destination path (unchanged) ==========
    const connectionIdentifier = destinationDatabaseName
      ? `${destinationId}:${destinationDatabaseName}`
      : destinationId;

    const connection = await databaseConnectionService.getConnectionById(
      "destination",
      connectionIdentifier,
      async (id: string) => {
        const realDestinationId = id.includes(":") ? id.split(":")[0] : id;
        const destinationDb =
          await getDestinationManager().getDestination(realDestinationId);
        if (!destinationDb) return null;

        const config = {
          connectionString: destinationDb.connection.connection_string,
          database: destinationDb.connection.database,
        } as ConnectionConfig;

        if (destinationDatabaseName) {
          config.database = destinationDatabaseName;
        }

        return config;
      },
    );
    db = connection.db;

    const normalizedEntityName = entity.includes(":")
      ? entity.split(":")[0]
      : entity;
    const collectionName = `${dataSource.name}_${normalizedEntityName}`;
    const stagingCollectionName = `${collectionName}_staging`;
    const useStaging = syncMode === "full";

    const collection = useStaging
      ? db.collection(stagingCollectionName)
      : db.collection(collectionName);

    if (!useStaging && !state) {
      await ensureCollectionIndexes(collection, logger);
    }

    if (useStaging && !state) {
      try {
        await db.collection(stagingCollectionName).drop();
      } catch {
        // Ignore if doesn't exist
      }
      await db.createCollection(stagingCollectionName);
      const stagingCollection = db.collection(stagingCollectionName);
      await ensureCollectionIndexes(stagingCollection, logger);
    }

    let lastSyncDate: Date | undefined;

    if (syncMode === "incremental" && !state) {
      const lastRecord = await db
        .collection(collectionName)
        .find({ _dataSourceId: dataSource.id })
        .sort({ _syncedAt: -1 })
        .limit(1)
        .toArray();

      if (lastRecord.length > 0) {
        lastSyncDate = lastRecord[0]._syncedAt;
        logger?.log(
          "info",
          `Syncing ${entity} updated after: ${lastSyncDate?.toISOString() ?? "unknown"}`,
        );
      }
    }

    const progressReporter = new ProgressReporter(entity, undefined, logger);

    const maxRetries = dataSource.settings?.max_retries || 3;
    const rateLimitDelay = dataSource.settings?.rate_limit_delay_ms || 200;
    const fetchState = await executeWithRetry(
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
          onBatch: async batch => {
            if (batch.length === 0) return;

            const processedRecords = batch.map(record => ({
              ...record,
              _dataSourceId: dataSource.id,
              _dataSourceName: dataSource.name,
              _syncedAt: new Date(),
            }));

            const bulkStart = Date.now();
            try {
              const bulkOps = processedRecords.map(record => ({
                replaceOne: {
                  filter: {
                    id: record.id,
                    _dataSourceId: dataSource.id,
                  },
                  replacement: record,
                  upsert: true,
                },
              }));
              const result = await collection.bulkWrite(bulkOps, {
                ordered: false,
              });
              const syncType = useStaging ? "full sync" : "incremental sync";
              orchestratorLogger.info("MongoDB bulkWrite upsert mode used", {
                syncType,
              });
              const bulkDuration = Date.now() - bulkStart;
              orchestratorLogger.info("MongoDB write succeeded", {
                upsertedCount: result.upsertedCount,
                modifiedCount: result.modifiedCount,
                duration: bulkDuration,
                recordCount: batch.length,
              });
            } catch (bulkError: any) {
              const bulkDuration = Date.now() - bulkStart;
              orchestratorLogger.error("MongoDB write failed", {
                duration: bulkDuration,
                error: bulkError.message,
              });
              throw bulkError;
            }
          },
          onProgress: (current, total) => {
            progressReporter.reportProgress(current, total);
          },
        }),
      maxRetries,
      logger,
      options.step,
      `fetch-chunk-${entity}`,
      rateLimitDelay,
    );

    const completed = !fetchState.hasMore;

    if (completed) {
      progressReporter.reportComplete();

      if (syncMode === "full") {
        try {
          await db.collection(collectionName).drop();
        } catch {
          // Ignore if doesn't exist
        }
        await db.collection(stagingCollectionName).rename(collectionName);
      }

      logger?.log(
        "info",
        `✅ ${entity} sync completed (${fetchState.totalProcessed} records)`,
      );
    } else {
      logger?.log(
        "info",
        `📊 ${entity} chunk completed (${fetchState.totalProcessed} records so far, ${fetchState.iterationsInChunk} iterations)`,
      );
    }

    return {
      state: fetchState,
      entity,
      collectionName,
      completed,
    };
  } catch (error) {
    const errorMsg = `Sync chunk failed: ${error instanceof Error ? error.message : String(error)}`;
    logger?.log("error", errorMsg, {
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new Error(errorMsg, { cause: error });
  }
}

/**
 * SQL/BigQuery destination path for connector sync chunks.
 * Uses DestinationWriter with per-entity table naming.
 */
async function performSyncChunkSql(
  options: SyncChunkOptions,
  dataSource: any,
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

  // Build per-entity tableDestination with the resolved table name
  const entityTableDest: ITableDestination = {
    ...tableDestination,
    tableName: entityTableName,
  };

  const writer = await createDestinationWriter(
    {
      destinationDatabaseId: new Types.ObjectId(options.destinationId),
      destinationDatabaseName: options.destinationDatabaseName,
      tableDestination: entityTableDest,
    },
    dataSource.name,
  );
  (writer as any).config.deleteMode = options.deleteMode;

  // Full sync: prepare staging on first chunk
  if (syncMode === "full" && !state) {
    await writer.prepareFullSync();
  } else if (syncMode === "full" && state) {
    (writer as any).stagingActive = true;
  }

  // Incremental: get last sync date from destination table
  let lastSyncDate: Date | undefined;
  if (syncMode === "incremental" && !state) {
    try {
      const { getMaxTrackingValue } = await import(
        "../services/destination-writer.service"
      );
      const { DatabaseConnection } = await import(
        "../database/workspace-schema"
      );
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
  let runningProcessed = state?.totalProcessed || 0;
  const fullSyncWriteBatchSize = 1000;
  let pendingFullSyncRows: Record<string, unknown>[] = [];

  const writeRows = async (
    rowsToWrite: Record<string, unknown>[],
    fetchedCountForLog: number,
  ) => {
    if (rowsToWrite.length === 0) return;

    const writeOptions =
      syncMode === "incremental"
        ? {
            keyColumns: ["id", "_dataSourceId"],
            conflictStrategy: "update" as const,
          }
        : {};

    const result = await writer.writeBatch(rowsToWrite, writeOptions);

    if (!result.success) {
      logger?.log("error", "SQL batch write failed", {
        entity,
        fetchedCount: fetchedCountForLog,
        syncMode,
        error: result.error,
      });
      throw new Error(`SQL write failed: ${result.error}`);
    }

    runningProcessed += result.rowsWritten;

    logger?.log("info", "SQL batch write succeeded", {
      entity,
      fetchedCount: fetchedCountForLog,
      rowsWritten: result.rowsWritten,
      totalProcessed: runningProcessed,
      syncMode,
    });

    orchestratorLogger.info("SQL write succeeded", {
      rowsWritten: result.rowsWritten,
      recordCount: fetchedCountForLog,
      table: entityTableName,
    });
  };

  const flushFullSyncRows = async (reason: "threshold" | "chunk-end") => {
    if (pendingFullSyncRows.length === 0) return;

    const rowsToWrite = pendingFullSyncRows;
    pendingFullSyncRows = [];

    logger?.log("info", "Flushing buffered full-sync rows", {
      entity,
      reason,
      bufferedRows: rowsToWrite.length,
    });

    await writeRows(rowsToWrite, rowsToWrite.length);
  };

  const maxRetries = dataSource.settings?.max_retries || 3;
  const rateLimitDelay = dataSource.settings?.rate_limit_delay_ms || 200;
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
            const flat: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(record)) {
              flat[key.replace(/\./g, "_")] = value;
            }
            return {
              ...flat,
              _dataSourceId: dataSource.id,
              _dataSourceName: dataSource.name,
              _syncedAt: new Date(),
            };
          });

          if (syncMode === "full") {
            pendingFullSyncRows.push(...processedRecords);
            if (pendingFullSyncRows.length >= fullSyncWriteBatchSize) {
              await flushFullSyncRows("threshold");
            }
            return;
          }

          await writeRows(processedRecords, batch.length);
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

  if (syncMode === "full") {
    await flushFullSyncRows("chunk-end");
  }

  const completed = !fetchState.hasMore;

  if (completed) {
    progressReporter.reportComplete();

    if (syncMode === "full") {
      await writer.finalize();
    }

    logger?.log(
      "info",
      `✅ ${entity} SQL sync completed (${fetchState.totalProcessed} records)`,
    );
  } else {
    logger?.log(
      "info",
      `📊 ${entity} SQL chunk done (${fetchState.totalProcessed} so far)`,
    );
  }

  return {
    state: fetchState,
    entity,
    collectionName: entityTableName,
    completed,
  };
}

/**
 * Orchestrates the sync process using the new architecture
 * where connectors are database-agnostic and all DB operations
 * are handled by the sync layer
 */
export async function performSync(
  dataSourceId: string,
  destinationId: string,
  destinationDatabaseName: string | undefined,
  entities: string[] | undefined,
  isIncremental: boolean = false,
  logger?: SyncLogger,
  step?: any, // Inngest step object for serverless-friendly retries
  queries?: any[], // GraphQL/PostHog queries from the transfer
) {
  logger?.log(
    "debug",
    `performSync called with isIncremental: ${isIncremental}`,
  );
  const syncMode = isIncremental ? "incremental" : "full";
  logger?.log("debug", `Sync mode determined as: ${syncMode}`);
  let db: Db | null = null;

  try {
    // Validate configuration
    const validation = databaseDataSourceManager.validateConfig();
    if (!validation.valid) {
      const errorMsg =
        "Configuration validation failed: " + validation.errors.join(", ");
      logger?.log("error", errorMsg);
      throw new Error(errorMsg);
    }

    // Get the data source
    const dataSource =
      await databaseDataSourceManager.getDataSource(dataSourceId);
    if (!dataSource) {
      const errorMsg = `Data source '${dataSourceId}' not found`;
      logger?.log("error", errorMsg);
      throw new Error(errorMsg);
    }

    if (!dataSource.active) {
      const errorMsg = `Data source '${dataSource.name}' is not active`;
      logger?.log("error", errorMsg);
      throw new Error(errorMsg);
    }

    // Inject transfer queries into dataSource for GraphQL/PostHog connectors
    // The registry maps connection -> config when creating the connector
    if (queries && queries.length > 0) {
      dataSource.connection = {
        ...dataSource.connection,
        queries,
      };
    }

    // Get destination database (just for validation)
    const destinationDb =
      await getDestinationManager().getDestination(destinationId);
    if (!destinationDb) {
      const errorMsg = `Destination database '${destinationId}' not found`;
      logger?.log("error", errorMsg);
      throw new Error(errorMsg);
    }

    // Get connector from registry
    const connector = await syncConnectorRegistry.getConnector(dataSource);
    if (!connector) {
      const errorMsg = `Failed to create connector for type: ${dataSource.type}`;
      logger?.log("error", errorMsg);
      throw new Error(errorMsg);
    }

    // Test connection first with retry logic
    const maxRetries = dataSource.settings?.max_retries || 3;
    const rateLimitDelay = dataSource.settings?.rate_limit_delay_ms || 200;
    const connectionTest = await executeWithRetry(
      () => connector.testConnection(),
      maxRetries,
      logger,
      step, // Pass step parameter for Inngest sleep when available
      `test-connection-${dataSource.type}`,
      rateLimitDelay,
    );
    if (!connectionTest.success) {
      const errorMsg = `Failed to connect to ${dataSource.type}: ${connectionTest.message}`;
      logger?.log("error", errorMsg, { details: connectionTest.details });
      throw new Error(errorMsg);
    }

    logger?.log("info", `Successfully connected to ${dataSource.type}`);
    logger?.log("info", `Starting ${syncMode} sync...`);
    logger?.log("info", `Source: ${dataSource.name} (${dataSource.type})`);
    logger?.log("info", `Destination: ${destinationDb.name}`);

    const startTime = Date.now();

    // Get connection from unified pool
    const connectionIdentifier = destinationDatabaseName
      ? `${destinationId}:${destinationDatabaseName}`
      : destinationId;

    const connection = await databaseConnectionService.getConnectionById(
      "destination",
      connectionIdentifier,
      async (id: string) => {
        const realDestinationId = id.includes(":") ? id.split(":")[0] : id;
        const destinationDb =
          await getDestinationManager().getDestination(realDestinationId);
        if (!destinationDb) return null;

        const config = {
          connectionString: destinationDb.connection.connection_string,
          database: destinationDb.connection.database,
        } as ConnectionConfig;

        if (destinationDatabaseName) {
          config.database = destinationDatabaseName;
        }

        return config;
      },
    );
    db = connection.db;

    // Determine which entities to sync
    const availableEntities = connector.getAvailableEntities();
    let entitiesToSync: string[];

    if (entities && entities.length > 0) {
      // Validate requested entities
      const invalidEntities = entities.filter(
        e => !availableEntities.includes(e),
      );
      if (invalidEntities.length > 0) {
        const errorMsg = `Invalid entities for ${dataSource.type} connector: ${invalidEntities.join(", ")}. Available: ${availableEntities.join(", ")}`;
        logger?.log("error", errorMsg);
        throw new Error(errorMsg);
      }
      entitiesToSync = entities;
      logger?.log("info", `Entities: ${entitiesToSync.join(", ")}`);
    } else {
      // Sync all entities
      entitiesToSync = availableEntities;
      logger?.log("info", `Entities: All (${entitiesToSync.join(", ")})`);
    }

    // Sync each entity
    for (const entityName of entitiesToSync) {
      logger?.log("info", `Syncing entity: ${entityName}`);

      // Perform sync using clean architecture
      // Normalize sub-entity notation (e.g., activities:Call) to the parent for collection naming
      const normalizedEntityNameForWrite = entityName.includes(":")
        ? entityName.split(":")[0]
        : entityName;
      const collectionName = `${dataSource.name}_${normalizedEntityNameForWrite}`;
      const stagingCollectionName = `${collectionName}_staging`;
      const useStaging = syncMode === "full";

      const collection = useStaging
        ? db.collection(stagingCollectionName)
        : db.collection(collectionName);

      if (useStaging) {
        // Drop staging collection if exists
        try {
          await db.collection(stagingCollectionName).drop();
        } catch {
          // Ignore if doesn't exist
        }
        await db.createCollection(stagingCollectionName);

        // Create indexes on staging collection
        const stagingCollection = db.collection(stagingCollectionName);
        await ensureCollectionIndexes(stagingCollection, logger);
      } else {
        // Ensure indexes exist for incremental sync
        await ensureCollectionIndexes(collection, logger);
      }

      let recordCount = 0;
      let lastSyncDate: Date | undefined;

      // Get last sync date for incremental
      if (syncMode === "incremental") {
        logger?.log(
          "debug",
          `Looking for last sync date in collection: ${collectionName}`,
        );
        logger?.log("debug", `Using dataSourceId filter: ${dataSource.id}`);

        const lastRecord = await db
          .collection(collectionName)
          .find({ _dataSourceId: dataSource.id })
          .sort({ _syncedAt: -1 })
          .limit(1)
          .toArray();

        logger?.log(
          "debug",
          `Found ${lastRecord.length} records with _dataSourceId: ${dataSource.id}`,
        );

        if (lastRecord.length > 0) {
          lastSyncDate = lastRecord[0]._syncedAt;
          logger?.log(
            "debug",
            `Last record _syncedAt: ${lastRecord[0]._syncedAt}`,
          );
          logger?.log(
            "debug",
            `Last record _dataSourceId: ${lastRecord[0]._dataSourceId}`,
          );
          logger?.log(
            "info",
            `Syncing ${entityName} updated after: ${lastSyncDate?.toISOString() ?? "unknown"}`,
          );
        } else {
          logger?.log(
            "warn",
            `No previous sync records found for ${entityName} with dataSourceId: ${dataSource.id}`,
          );
        }
      }

      // Create progress reporter for this entity
      const progressReporter = new ProgressReporter(
        entityName,
        undefined,
        logger,
      );

      // Fetch data from connector with retry logic
      const maxRetries = dataSource.settings?.max_retries || 3;
      const rateLimitDelay = dataSource.settings?.rate_limit_delay_ms || 200;
      await executeWithRetry(
        () =>
          connector.fetchEntity({
            entity: entityName,
            ...(lastSyncDate && { since: lastSyncDate }),
            onLog: (
              level: "debug" | "info" | "warn" | "error",
              message: string,
              metadata?: unknown,
            ) => logger?.log(level, message, metadata),
            onBatch: async batch => {
              if (batch.length === 0) return;

              // Add metadata to records
              const processedRecords = batch.map(record => ({
                ...record,
                _dataSourceId: dataSource.id,
                _dataSourceName: dataSource.name,
                _syncedAt: new Date(),
              }));

              // Prepare bulk operations
              const bulkOps = processedRecords.map(record => ({
                replaceOne: {
                  filter: {
                    id: record.id,
                    _dataSourceId: dataSource.id,
                  },
                  replacement: record,
                  upsert: true,
                },
              }));

              // Write to database
              await collection.bulkWrite(bulkOps, { ordered: false });
              recordCount += batch.length;
            },
            onProgress: (current, total) => {
              progressReporter.reportProgress(current, total);
            },
          }),
        maxRetries,
        logger,
        step, // Pass step parameter for Inngest sleep when available
        `fetch-entity-${entityName}`,
        rateLimitDelay,
      );

      // Complete the progress reporting
      progressReporter.reportComplete();

      // Hot swap for full sync
      if (useStaging) {
        // Drop the existing collection and rename staging to main
        try {
          await db.collection(collectionName).drop();
        } catch {
          // Ignore if doesn't exist
        }

        // Rename staging to main
        await db.collection(stagingCollectionName).rename(collectionName);
      }

      logger?.log(
        "info",
        `✅ ${entityName} sync completed (${recordCount} records)`,
      );
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logger?.log("info", `Sync completed successfully in ${duration}s`);
  } catch (error) {
    const errorMsg = `Sync failed: ${error instanceof Error ? error.message : String(error)}`;
    logger?.log("error", errorMsg, {
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new Error(errorMsg, { cause: error });
  }
  // Note: We don't close the connection here anymore - it stays in the unified pool
}
