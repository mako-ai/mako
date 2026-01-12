/**
 * Unified Destination Writer Service
 *
 * Provides a consistent interface for writing data to different destination types:
 * - MongoDB collections (existing behavior)
 * - SQL tables (PostgreSQL, BigQuery, etc.)
 *
 * This service abstracts away the differences between destination types,
 * allowing the sync orchestrator to use the same code path regardless of
 * whether data comes from an API connector or a database query.
 */

import { Types } from "mongoose";
import { Db, Collection } from "mongodb";
import {
  DatabaseConnection,
  IDatabaseConnection,
  ITableDestination,
  IIncrementalConfig,
} from "../database/workspace-schema";
import { getDatabaseDriver } from "../databases/registry";
import {
  ColumnDefinition,
  BatchWriteResult,
  DatabaseDriver,
} from "../databases/driver";
import {
  databaseConnectionService,
  ConnectionConfig,
} from "./database-connection.service";

export interface DestinationConfig {
  // For MongoDB collections
  mongoDb?: Db;
  collectionName?: string;

  // For SQL tables
  tableDestination?: ITableDestination;

  // Common
  dataSourceId?: string;
  dataSourceName?: string;
}

export interface WriteOptions {
  // For upsert operations
  keyColumns?: string[];
  conflictStrategy?: "upsert" | "ignore" | "replace";

  // For full sync with staging
  useStaging?: boolean;
  stagingTableName?: string;
}

export interface WriteResult {
  success: boolean;
  rowsWritten: number;
  error?: string;
}

/**
 * State for resumable chunked execution
 */
export interface DbSyncChunkState {
  offset: number;
  totalProcessed: number;
  hasMore: boolean;
  lastTrackingValue?: string;
  estimatedTotal?: number;
  stagingPrepared?: boolean;
}

/**
 * Result of a single chunk execution
 */
export interface DbSyncChunkResult {
  state: DbSyncChunkState;
  rowsProcessed: number;
  completed: boolean;
  error?: string;
}

/**
 * Unified destination writer that handles both MongoDB and SQL destinations
 */
export class DestinationWriter {
  private config: DestinationConfig;
  private driver?: DatabaseDriver;
  private connection?: IDatabaseConnection;
  private stagingActive = false;
  private inferredColumns?: ColumnDefinition[];

  constructor(config: DestinationConfig) {
    this.config = config;
  }

  /**
   * Initialize the writer (connect to destination if needed)
   */
  async initialize(): Promise<void> {
    if (this.config.tableDestination) {
      // Load the database connection for SQL destination
      const conn = await DatabaseConnection.findById(
        this.config.tableDestination.connectionId,
      );
      if (!conn) {
        throw new Error(
          `Database connection not found: ${this.config.tableDestination.connectionId}`,
        );
      }
      this.connection = conn;

      // Get the appropriate driver
      this.driver = getDatabaseDriver(conn.type);
      if (!this.driver) {
        throw new Error(`No driver found for database type: ${conn.type}`);
      }

      // Check if driver supports writes
      if (!this.driver.supportsWrites?.()) {
        throw new Error(
          `Database driver ${conn.type} does not support write operations`,
        );
      }
    }
  }

  /**
   * Determine if we're writing to a SQL table or MongoDB
   */
  isTableDestination(): boolean {
    return !!this.config.tableDestination?.tableName;
  }

  /**
   * Get the target table/collection name
   */
  getTargetName(): string {
    if (this.config.tableDestination?.tableName) {
      return this.config.tableDestination.tableName;
    }
    return this.config.collectionName || "unknown";
  }

  /**
   * Prepare for full sync (create staging table/collection if needed)
   */
  async prepareFullSync(options: WriteOptions = {}): Promise<void> {
    if (this.isTableDestination()) {
      await this.prepareSqlStaging(options);
    } else {
      await this.prepareMongoStaging(options);
    }
    this.stagingActive = true;
  }

  /**
   * Write a batch of rows to the destination
   */
  async writeBatch(
    rows: Record<string, unknown>[],
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    if (rows.length === 0) {
      return { success: true, rowsWritten: 0 };
    }

    if (this.isTableDestination()) {
      return this.writeBatchToTable(rows, options);
    } else {
      return this.writeBatchToMongo(rows, options);
    }
  }

  /**
   * Finalize the sync (swap staging table/collection if full sync)
   */
  async finalize(options: WriteOptions = {}): Promise<void> {
    if (!this.stagingActive) {
      return;
    }

    if (this.isTableDestination()) {
      await this.finalizeSqlSync(options);
    } else {
      await this.finalizeMongoSync(options);
    }
    this.stagingActive = false;
  }

  /**
   * Clean up on failure (drop staging table/collection)
   */
  async cleanup(options: WriteOptions = {}): Promise<void> {
    if (!this.stagingActive) {
      return;
    }

    if (this.isTableDestination()) {
      await this.cleanupSqlStaging(options);
    } else {
      await this.cleanupMongoStaging(options);
    }
    this.stagingActive = false;
  }

  // ============ MongoDB Implementation ============

  private async prepareMongoStaging(options: WriteOptions): Promise<void> {
    if (!this.config.mongoDb || !this.config.collectionName) {
      throw new Error("MongoDB destination not configured");
    }

    const stagingName =
      options.stagingTableName || `${this.config.collectionName}_staging`;

    // Drop staging collection if exists
    try {
      await this.config.mongoDb.collection(stagingName).drop();
    } catch {
      // Ignore if doesn't exist
    }

    // Create staging collection
    await this.config.mongoDb.createCollection(stagingName);

    // Create indexes on staging collection
    await this.ensureMongoIndexes(this.config.mongoDb.collection(stagingName));
  }

  private async writeBatchToMongo(
    rows: Record<string, unknown>[],
    options: WriteOptions,
  ): Promise<WriteResult> {
    if (!this.config.mongoDb || !this.config.collectionName) {
      return { success: false, rowsWritten: 0, error: "MongoDB not configured" };
    }

    try {
      const collectionName = this.stagingActive
        ? options.stagingTableName || `${this.config.collectionName}_staging`
        : this.config.collectionName;

      const collection = this.config.mongoDb.collection(collectionName);

      // Add metadata to records
      const processedRecords = rows.map(record => ({
        ...record,
        _dataSourceId: this.config.dataSourceId,
        _dataSourceName: this.config.dataSourceName,
        _syncedAt: new Date(),
      }));

      // Use bulkWrite with upserts
      const bulkOps = processedRecords.map(record => ({
        replaceOne: {
          filter: {
            id: (record as any).id,
            _dataSourceId: this.config.dataSourceId,
          },
          replacement: record,
          upsert: true,
        },
      }));

      const result = await collection.bulkWrite(bulkOps, { ordered: false });

      return {
        success: true,
        rowsWritten: result.upsertedCount + result.modifiedCount,
      };
    } catch (error) {
      return {
        success: false,
        rowsWritten: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async finalizeMongoSync(options: WriteOptions): Promise<void> {
    if (!this.config.mongoDb || !this.config.collectionName) {
      throw new Error("MongoDB destination not configured");
    }

    const stagingName =
      options.stagingTableName || `${this.config.collectionName}_staging`;

    // Drop the original collection
    try {
      await this.config.mongoDb.collection(this.config.collectionName).drop();
    } catch {
      // Ignore if doesn't exist
    }

    // Rename staging to original
    await this.config.mongoDb
      .collection(stagingName)
      .rename(this.config.collectionName);
  }

  private async cleanupMongoStaging(options: WriteOptions): Promise<void> {
    if (!this.config.mongoDb || !this.config.collectionName) {
      return;
    }

    const stagingName =
      options.stagingTableName || `${this.config.collectionName}_staging`;

    try {
      await this.config.mongoDb.collection(stagingName).drop();
    } catch {
      // Ignore if doesn't exist
    }
  }

  private async ensureMongoIndexes(collection: Collection): Promise<void> {
    try {
      const existingIndexes = await collection.indexes();
      const existingIndexNames = existingIndexes.map((idx: any) => idx.name);

      // Unique index on 'id' field
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
      }

      // Compound index for bulk sync upserts
      if (!existingIndexNames.includes("sync_upsert_idx")) {
        await collection.createIndex(
          { id: 1, _dataSourceId: 1 },
          { background: true, name: "sync_upsert_idx" },
        );
      }

      // Index for incremental sync date queries
      if (!existingIndexNames.includes("incremental_sync_idx")) {
        await collection.createIndex(
          { _dataSourceId: 1, _syncedAt: -1 },
          { background: true, name: "incremental_sync_idx" },
        );
      }
    } catch {
      // Indexes are for performance, not correctness
    }
  }

  // ============ SQL Table Implementation ============

  private async prepareSqlStaging(options: WriteOptions): Promise<void> {
    if (!this.driver || !this.connection || !this.config.tableDestination) {
      throw new Error("SQL destination not configured");
    }

    const { tableName, schema } = this.config.tableDestination;
    const stagingName = options.stagingTableName || `${tableName}_staging`;

    // Check if original table exists
    const tableExists = await this.driver.tableExists?.(
      this.connection,
      tableName,
      { schema },
    );

    if (tableExists) {
      // Create staging table based on original structure
      const result = await this.driver.createStagingTable?.(
        this.connection,
        tableName,
        stagingName,
        { schema },
      );

      if (!result?.success) {
        throw new Error(
          `Failed to create staging table: ${result?.error || "Unknown error"}`,
        );
      }
    }
    // If original doesn't exist, we'll create it when we get the first batch
  }

  private async writeBatchToTable(
    rows: Record<string, unknown>[],
    options: WriteOptions,
  ): Promise<WriteResult> {
    if (!this.driver || !this.connection || !this.config.tableDestination) {
      return {
        success: false,
        rowsWritten: 0,
        error: "SQL destination not configured",
      };
    }

    const { tableName, schema, createIfNotExists } =
      this.config.tableDestination;
    const targetTable = this.stagingActive
      ? options.stagingTableName || `${tableName}_staging`
      : tableName;

    try {
      // Check if table exists, create if needed
      const tableExists = await this.driver.tableExists?.(
        this.connection,
        targetTable,
        { schema },
      );

      if (!tableExists && createIfNotExists) {
        // Infer schema from first batch if not already done
        if (!this.inferredColumns) {
          this.inferredColumns = this.driver.inferSchema?.(rows);
          if (!this.inferredColumns) {
            throw new Error("Failed to infer schema from data");
          }
        }

        // Create table
        const createResult = await this.driver.createTable?.(
          this.connection,
          targetTable,
          this.inferredColumns,
          { schema },
        );

        if (!createResult?.success) {
          throw new Error(
            `Failed to create table: ${createResult?.error || "Unknown error"}`,
          );
        }
      }

      // Write data
      let result: BatchWriteResult;

      if (options.keyColumns && options.keyColumns.length > 0 && !this.stagingActive) {
        // Upsert for incremental sync
        result =
          (await this.driver.upsertBatch?.(
            this.connection,
            targetTable,
            rows,
            options.keyColumns,
            { schema, conflictStrategy: options.conflictStrategy || "update" },
          )) || { success: false, rowsWritten: 0, error: "Upsert not supported" };
      } else {
        // Insert for full sync (staging) or when no key columns
        result =
          (await this.driver.insertBatch?.(this.connection, targetTable, rows, {
            schema,
          })) || { success: false, rowsWritten: 0, error: "Insert not supported" };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        rowsWritten: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async finalizeSqlSync(options: WriteOptions): Promise<void> {
    if (!this.driver || !this.connection || !this.config.tableDestination) {
      throw new Error("SQL destination not configured");
    }

    const { tableName, schema } = this.config.tableDestination;
    const stagingName = options.stagingTableName || `${tableName}_staging`;

    // Swap staging with original
    const result = await this.driver.swapStagingTable?.(
      this.connection,
      tableName,
      stagingName,
      { schema },
    );

    if (!result?.success) {
      throw new Error(
        `Failed to swap staging table: ${result?.error || "Unknown error"}`,
      );
    }
  }

  private async cleanupSqlStaging(options: WriteOptions): Promise<void> {
    if (!this.driver || !this.connection || !this.config.tableDestination) {
      return;
    }

    const { tableName, schema } = this.config.tableDestination;
    const stagingName = options.stagingTableName || `${tableName}_staging`;

    try {
      await this.driver.dropTable?.(this.connection, stagingName, { schema });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Factory function to create a destination writer from flow configuration
 */
export async function createDestinationWriter(
  flow: {
    destinationDatabaseId: Types.ObjectId;
    destinationDatabaseName?: string;
    tableDestination?: ITableDestination;
    dataSourceId?: Types.ObjectId;
  },
  dataSourceName?: string,
): Promise<DestinationWriter> {
  let config: DestinationConfig = {
    dataSourceId: flow.dataSourceId?.toString(),
    dataSourceName,
  };

  if (flow.tableDestination?.tableName) {
    // SQL table destination
    config.tableDestination = flow.tableDestination;
  } else {
    // MongoDB destination (default)
    const connectionIdentifier = flow.destinationDatabaseName
      ? `${flow.destinationDatabaseId}:${flow.destinationDatabaseName}`
      : flow.destinationDatabaseId.toString();

    const connection = await databaseConnectionService.getConnectionById(
      "destination",
      connectionIdentifier,
      async (id: string) => {
        const realDestinationId = id.includes(":") ? id.split(":")[0] : id;
        const destConn = await DatabaseConnection.findById(realDestinationId);
        if (!destConn) return null;

        return {
          connectionString:
            destConn.connection.connectionString ||
            `mongodb://${destConn.connection.host}:${destConn.connection.port}`,
          database:
            flow.destinationDatabaseName || destConn.connection.database,
        } as ConnectionConfig;
      },
    );

    config.mongoDb = connection.db;
  }

  const writer = new DestinationWriter(config);
  await writer.initialize();

  return writer;
}

/**
 * Execute a streaming query from a source database and write to destination
 */
export async function streamFromDatabaseToDestination(options: {
  sourceConnection: IDatabaseConnection;
  sourceQuery: string;
  sourceDatabase?: string;
  destinationWriter: DestinationWriter;
  batchSize?: number;
  syncMode: "full" | "incremental";
  incrementalConfig?: {
    trackingColumn: string;
    trackingType: "timestamp" | "numeric";
    lastValue?: string;
  };
  keyColumns?: string[];
  onProgress?: (rowsProcessed: number) => void;
  signal?: AbortSignal;
}): Promise<{ success: boolean; totalRows: number; error?: string }> {
  const {
    sourceConnection,
    sourceQuery,
    sourceDatabase,
    destinationWriter,
    batchSize = 2000,
    syncMode,
    incrementalConfig,
    keyColumns,
    onProgress,
    signal,
  } = options;

  const driver = getDatabaseDriver(sourceConnection.type);
  if (!driver) {
    return {
      success: false,
      totalRows: 0,
      error: `No driver found for source type: ${sourceConnection.type}`,
    };
  }

  if (!driver.executeStreamingQuery) {
    return {
      success: false,
      totalRows: 0,
      error: `Driver ${sourceConnection.type} does not support streaming queries`,
    };
  }

  // Modify query for incremental sync
  let effectiveQuery = sourceQuery;
  if (
    syncMode === "incremental" &&
    incrementalConfig?.trackingColumn &&
    incrementalConfig?.lastValue
  ) {
    const operator =
      incrementalConfig.trackingType === "timestamp" ? ">" : ">";
    const value =
      incrementalConfig.trackingType === "timestamp"
        ? `'${incrementalConfig.lastValue}'`
        : incrementalConfig.lastValue;

    // Simple WHERE clause injection (assumes query doesn't have WHERE or we append with AND)
    if (effectiveQuery.toLowerCase().includes("where")) {
      effectiveQuery = `${effectiveQuery} AND ${incrementalConfig.trackingColumn} ${operator} ${value}`;
    } else {
      effectiveQuery = `${effectiveQuery} WHERE ${incrementalConfig.trackingColumn} ${operator} ${value}`;
    }
  }

  // Prepare for full sync (staging)
  if (syncMode === "full") {
    await destinationWriter.prepareFullSync();
  }

  let totalRows = 0;
  let lastError: string | undefined;

  try {
    const result = await driver.executeStreamingQuery(
      sourceConnection,
      effectiveQuery,
      {
        batchSize,
        databaseName: sourceDatabase,
        signal,
        onBatch: async rows => {
          const writeResult = await destinationWriter.writeBatch(rows, {
            keyColumns,
            conflictStrategy: "update",
          });

          if (!writeResult.success) {
            throw new Error(
              `Failed to write batch: ${writeResult.error || "Unknown error"}`,
            );
          }

          totalRows += writeResult.rowsWritten;
          onProgress?.(totalRows);
        },
      },
    );

    if (!result.success) {
      throw new Error(result.error || "Streaming query failed");
    }

    // Finalize (swap staging if full sync)
    await destinationWriter.finalize();

    return { success: true, totalRows };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);

    // Cleanup staging on failure
    await destinationWriter.cleanup();

    return { success: false, totalRows, error: lastError };
  }
}

/**
 * Estimate the total row count for a query (for progress tracking)
 */
export async function estimateQueryRowCount(
  connection: IDatabaseConnection,
  query: string,
  database?: string,
): Promise<{ success: boolean; estimatedCount?: number; error?: string }> {
  const driver = getDatabaseDriver(connection.type);
  if (!driver) {
    return { success: false, error: `No driver found for type: ${connection.type}` };
  }

  try {
    // Wrap query in COUNT(*) - works for most SQL databases
    // Remove any ORDER BY clause as it's not needed for count
    const cleanQuery = query.replace(/\s+ORDER\s+BY\s+[^)]+$/i, "");
    const countQuery = `SELECT COUNT(*) as total FROM (${cleanQuery}) AS count_subquery`;

    const result = await driver.executeQuery(connection, countQuery, {
      databaseName: database,
    });

    if (result.success && result.data && result.data.length > 0) {
      const count = result.data[0].total || result.data[0].count || result.data[0].COUNT;
      return { success: true, estimatedCount: Number(count) };
    }

    return { success: false, error: "Could not determine row count" };
  } catch (error) {
    // Count estimation is optional, don't fail the sync
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get the maximum value of a tracking column from the destination
 * Used for updating incremental sync state after completion
 */
export async function getMaxTrackingValue(
  connection: IDatabaseConnection,
  tableName: string,
  trackingColumn: string,
  schema?: string,
  database?: string,
): Promise<{ success: boolean; maxValue?: string; error?: string }> {
  const driver = getDatabaseDriver(connection.type);
  if (!driver) {
    return { success: false, error: `No driver found for type: ${connection.type}` };
  }

  try {
    const qualifiedTable = schema ? `${schema}.${tableName}` : tableName;
    const query = `SELECT MAX(${trackingColumn}) as max_value FROM ${qualifiedTable}`;

    const result = await driver.executeQuery(connection, query, {
      databaseName: database,
    });

    if (result.success && result.data && result.data.length > 0) {
      const maxValue = result.data[0].max_value;
      if (maxValue !== null && maxValue !== undefined) {
        // Convert to string for storage
        if (maxValue instanceof Date) {
          return { success: true, maxValue: maxValue.toISOString() };
        }
        return { success: true, maxValue: String(maxValue) };
      }
    }

    return { success: true, maxValue: undefined }; // No data in table
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Validate a query by executing with LIMIT 1 and return column info
 */
export async function validateQuery(
  connection: IDatabaseConnection,
  query: string,
  database?: string,
): Promise<{
  success: boolean;
  columns?: Array<{ name: string; type: string }>;
  sampleRow?: Record<string, unknown>;
  error?: string;
}> {
  const driver = getDatabaseDriver(connection.type);
  if (!driver) {
    return { success: false, error: `No driver found for type: ${connection.type}` };
  }

  try {
    // Execute with LIMIT 1 to validate and get schema
    const testQuery = `SELECT * FROM (${query}) AS validation_subquery LIMIT 1`;

    const result = await driver.executeQuery(connection, testQuery, {
      databaseName: database,
    });

    if (!result.success) {
      return { success: false, error: result.error || "Query validation failed" };
    }

    // Infer columns from result
    let columns: Array<{ name: string; type: string }> = [];
    let sampleRow: Record<string, unknown> | undefined;

    if (result.data && result.data.length > 0) {
      sampleRow = result.data[0];
      columns = Object.entries(sampleRow).map(([name, value]) => ({
        name,
        type: inferJsType(value),
      }));
    }

    return { success: true, columns, sampleRow };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Infer JavaScript type from a value
 */
function inferJsType(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (value instanceof Date) return "timestamp";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "unknown";
}

/**
 * Execute a single chunk of database sync with pagination
 * Returns state for resumption in the next chunk
 */
export async function executeDbSyncChunk(options: {
  sourceConnection: IDatabaseConnection;
  sourceQuery: string;
  sourceDatabase?: string;
  destinationWriter: DestinationWriter;
  batchSize?: number;
  syncMode: "full" | "incremental";
  incrementalConfig?: IIncrementalConfig;
  keyColumns?: string[];
  state?: DbSyncChunkState;
  maxRowsPerChunk?: number;
  onProgress?: (rowsProcessed: number, estimatedTotal?: number) => void;
}): Promise<DbSyncChunkResult> {
  const {
    sourceConnection,
    sourceQuery,
    sourceDatabase,
    destinationWriter,
    batchSize = 2000,
    syncMode,
    incrementalConfig,
    keyColumns,
    state,
    maxRowsPerChunk = 10000,
    onProgress,
  } = options;

  const driver = getDatabaseDriver(sourceConnection.type);
  if (!driver) {
    return {
      state: { offset: 0, totalProcessed: 0, hasMore: false },
      rowsProcessed: 0,
      completed: true,
      error: `No driver found for source type: ${sourceConnection.type}`,
    };
  }

  // Initialize or restore state
  let currentState: DbSyncChunkState = state || {
    offset: 0,
    totalProcessed: 0,
    hasMore: true,
    stagingPrepared: false,
  };

  // Estimate total rows on first chunk (if not already done)
  if (!currentState.estimatedTotal && currentState.offset === 0) {
    const countResult = await estimateQueryRowCount(
      sourceConnection,
      sourceQuery,
      sourceDatabase,
    );
    if (countResult.success) {
      currentState.estimatedTotal = countResult.estimatedCount;
    }
  }

  // Prepare staging on first chunk for full sync
  if (syncMode === "full" && !currentState.stagingPrepared) {
    await destinationWriter.prepareFullSync();
    currentState.stagingPrepared = true;
  }

  // Build paginated query
  let effectiveQuery = sourceQuery;

  // Add incremental filter if applicable
  if (
    syncMode === "incremental" &&
    incrementalConfig?.trackingColumn &&
    incrementalConfig?.lastValue
  ) {
    const operator = ">";
    const value =
      incrementalConfig.trackingType === "timestamp"
        ? `'${incrementalConfig.lastValue}'`
        : incrementalConfig.lastValue;

    if (effectiveQuery.toLowerCase().includes("where")) {
      effectiveQuery = `${effectiveQuery} AND ${incrementalConfig.trackingColumn} ${operator} ${value}`;
    } else {
      effectiveQuery = `${effectiveQuery} WHERE ${incrementalConfig.trackingColumn} ${operator} ${value}`;
    }
  }

  // Add ORDER BY for consistent pagination (use tracking column if available)
  const orderColumn = incrementalConfig?.trackingColumn || "1";
  if (!effectiveQuery.toLowerCase().includes("order by")) {
    effectiveQuery = `${effectiveQuery} ORDER BY ${orderColumn}`;
  }

  // Add LIMIT and OFFSET for pagination
  const paginatedQuery = `${effectiveQuery} LIMIT ${maxRowsPerChunk} OFFSET ${currentState.offset}`;

  let rowsProcessedInChunk = 0;
  let lastTrackingValue: string | undefined;

  try {
    const result = await driver.executeQuery(sourceConnection, paginatedQuery, {
      databaseName: sourceDatabase,
    });

    if (!result.success) {
      return {
        state: currentState,
        rowsProcessed: 0,
        completed: false,
        error: result.error || "Query execution failed",
      };
    }

    const rows = result.data || [];

    // Process in smaller batches for writing
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      const writeResult = await destinationWriter.writeBatch(batch, {
        keyColumns,
        conflictStrategy: "update",
      });

      if (!writeResult.success) {
        return {
          state: currentState,
          rowsProcessed: rowsProcessedInChunk,
          completed: false,
          error: `Failed to write batch: ${writeResult.error}`,
        };
      }

      rowsProcessedInChunk += writeResult.rowsWritten;
      currentState.totalProcessed += writeResult.rowsWritten;

      // Track the last value for incremental column
      if (incrementalConfig?.trackingColumn && batch.length > 0) {
        const lastRow = batch[batch.length - 1];
        const trackingValue = lastRow[incrementalConfig.trackingColumn];
        if (trackingValue !== null && trackingValue !== undefined) {
          lastTrackingValue =
            trackingValue instanceof Date
              ? trackingValue.toISOString()
              : String(trackingValue);
        }
      }

      onProgress?.(currentState.totalProcessed, currentState.estimatedTotal);
    }

    // Check if there's more data
    const hasMore = rows.length === maxRowsPerChunk;

    // Update state
    currentState.offset += rows.length;
    currentState.hasMore = hasMore;
    if (lastTrackingValue) {
      currentState.lastTrackingValue = lastTrackingValue;
    }

    return {
      state: currentState,
      rowsProcessed: rowsProcessedInChunk,
      completed: !hasMore,
    };
  } catch (error) {
    return {
      state: currentState,
      rowsProcessed: rowsProcessedInChunk,
      completed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
