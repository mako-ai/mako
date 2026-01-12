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
