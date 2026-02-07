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
  IPaginationConfig,
  ITypeCoercion,
} from "../database/workspace-schema";
import { databaseRegistry } from "../databases/registry";
import {
  ColumnDefinition,
  BatchWriteResult,
  DatabaseDriver,
} from "../databases/driver";
import {
  databaseConnectionService,
  ConnectionConfig,
} from "./database-connection.service";
import {
  prepareQueryForValidation,
  substituteTemplates,
  detectTemplates,
} from "../utils/template-substitution";

/**
 * Helper function to infer JavaScript type from a value
 */
function inferJsType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "unknown";
}

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
  conflictStrategy?: "update" | "ignore" | "replace";

  // For full sync with staging
  useStaging?: boolean;
  stagingTableName?: string;

  // Type coercions to apply during table creation (overrides inferred types)
  typeCoercions?: ITypeCoercion[];

  // Pre-fetched schema from source database (more reliable than inferring from data)
  sourceSchema?: ColumnDefinition[];
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
  lastKeysetValue?: string; // For keyset pagination
  estimatedTotal?: number;
  stagingPrepared?: boolean;
  sourceSchema?: ColumnDefinition[]; // Cached schema from source query (fetched once)
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
 * Map source database types to BigQuery types
 * This ensures columns are created with correct BigQuery types regardless of source
 */
function mapToBigQueryType(sourceType: string): string {
  const t = sourceType.toUpperCase();
  if (t === "TEXT" || t.includes("CHAR") || t.includes("CLOB")) return "STRING";
  if (t === "INTEGER" || t === "INT" || t.includes("INT")) return "INT64";
  if (t === "REAL" || t === "FLOAT" || t === "DOUBLE" || t === "NUMERIC") {
    return "FLOAT64";
  }
  if (t === "BLOB") return "BYTES";
  if (t.includes("BOOL")) return "BOOL";
  if (t.includes("TIME") || t.includes("DATE")) return "TIMESTAMP";
  return "STRING"; // Default to STRING for safety
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
  private columnTypeMap: Map<string, string> | null = null; // Mapped types for BigQuery writes

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
      this.driver = databaseRegistry.getDriver(conn.type);
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
      return {
        success: false,
        rowsWritten: 0,
        error: "MongoDB not configured",
      };
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
      // When a record has a non-null 'id' field, use it for deduplication
      // via replaceOne. When a record lacks an 'id' field (or it is null),
      // fall back to a plain insert to avoid matching documents with
      // { id: null/undefined } which would cause data loss by overwriting
      // unrelated documents.
      // NOTE: The check is per-record, not batch-level, because a batch can
      // contain a mix of records with and without valid id values.
      const bulkOps = processedRecords.map(record => {
        if ((record as any).id != null) {
          return {
            replaceOne: {
              filter: {
                id: (record as any).id,
                _dataSourceId: this.config.dataSourceId,
              },
              replacement: record,
              upsert: true,
            },
          };
        } else {
          return {
            insertOne: {
              document: record,
            },
          };
        }
      });

      const result = await collection.bulkWrite(bulkOps, { ordered: false });

      return {
        success: true,
        rowsWritten:
          result.insertedCount + result.upsertedCount + result.modifiedCount,
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
    const backupName = `${this.config.collectionName}_backup_${Date.now()}`;

    // Step 1: Rename original to backup (if it exists)
    try {
      await this.config.mongoDb
        .collection(this.config.collectionName)
        .rename(backupName);
    } catch {
      // Ignore if original doesn't exist (first sync)
    }

    // Step 2: Rename staging to original
    try {
      await this.config.mongoDb
        .collection(stagingName)
        .rename(this.config.collectionName);
    } catch (error) {
      // If rename fails, try to restore from backup
      try {
        await this.config.mongoDb
          .collection(backupName)
          .rename(this.config.collectionName);
      } catch {
        // Backup restore failed too - log but don't mask original error
      }
      throw error;
    }

    // Step 3: Drop backup collection (non-critical)
    try {
      await this.config.mongoDb.collection(backupName).drop();
    } catch {
      // Ignore cleanup errors - backup will be cleaned up eventually
    }
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
        // Get schema for table creation
        // Priority order:
        // 1. typeCoercions (explicit user-defined schema from ETL mapping) - AUTHORITATIVE
        // 2. sourceSchema (pre-fetched from source database)
        // 3. inferred from data (fallback, less reliable for NULLs)
        if (!this.inferredColumns) {
          // Priority 1: Use typeCoercions as AUTHORITATIVE schema if available
          // This is the explicit mapping configured by the user in the schema mapping step
          if (options.typeCoercions && options.typeCoercions.length > 0) {
            // Convert typeCoercions directly to column definitions
            // The targetType from typeCoercions IS the authoritative destination type
            this.inferredColumns = options.typeCoercions.map(tc => ({
              name: tc.column,
              type: tc.targetType, // Use targetType directly (already in destination format)
              nullable: true, // Default to nullable for safety
            }));

            // For BigQuery: ensure types are valid BigQuery types
            if (this.connection?.type === "bigquery") {
              this.columnTypeMap = new Map(
                this.inferredColumns.map(c => [
                  c.name.toLowerCase(),
                  c.type, // Already in BigQuery format from typeCoercions
                ]),
              );
            }
          }
          // Priority 2: Use pre-fetched source schema (most reliable after explicit mapping)
          else if (options.sourceSchema && options.sourceSchema.length > 0) {
            this.inferredColumns = options.sourceSchema;

            // Apply type coercions as overrides if present
            if (options.typeCoercions && options.typeCoercions.length > 0) {
              this.inferredColumns = applyTypeCoercionsToSchema(
                this.inferredColumns,
                options.typeCoercions,
              );
            }

            // For BigQuery: map source types to BigQuery types
            if (this.connection?.type === "bigquery") {
              this.columnTypeMap = new Map(
                this.inferredColumns.map(c => [
                  c.name.toLowerCase(),
                  mapToBigQueryType(c.type),
                ]),
              );
              this.inferredColumns = this.inferredColumns.map(c => ({
                ...c,
                type: mapToBigQueryType(c.type),
              }));
            }
          } else {
            // Priority 3: Fallback to inferring from data (less reliable for NULLs)
            this.inferredColumns = this.driver.inferSchema?.(rows);
            if (!this.inferredColumns) {
              throw new Error("Failed to infer schema from data");
            }

            // For BigQuery: map source types to BigQuery types and store for writes
            // Use lowercase keys for case-insensitive lookup
            if (this.connection?.type === "bigquery") {
              this.columnTypeMap = new Map(
                this.inferredColumns.map(c => [
                  c.name.toLowerCase(),
                  mapToBigQueryType(c.type),
                ]),
              );
              // Update inferredColumns with mapped types for table creation
              this.inferredColumns = this.inferredColumns.map(c => ({
                ...c,
                type: mapToBigQueryType(c.type),
              }));
            }
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

      if (
        options.keyColumns &&
        options.keyColumns.length > 0 &&
        !this.stagingActive
      ) {
        // Upsert for incremental sync
        result = (await this.driver.upsertBatch?.(
          this.connection,
          targetTable,
          rows,
          options.keyColumns,
          {
            schema,
            conflictStrategy: options.conflictStrategy || "update",
            columnTypes: this.columnTypeMap ?? undefined,
          },
        )) || { success: false, rowsWritten: 0, error: "Upsert not supported" };
      } else {
        // Insert for full sync (staging) or when no key columns
        result = (await this.driver.insertBatch?.(
          this.connection,
          targetTable,
          rows,
          {
            schema,
            columnTypes: this.columnTypeMap ?? undefined,
          },
        )) || { success: false, rowsWritten: 0, error: "Insert not supported" };
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
  const config: DestinationConfig = {
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
 * Estimate the total row count for a query (for progress tracking)
 */
export async function estimateQueryRowCount(
  connection: IDatabaseConnection,
  query: string,
  database?: string,
): Promise<{ success: boolean; estimatedCount?: number; error?: string }> {
  const driver = databaseRegistry.getDriver(connection.type);
  if (!driver) {
    return {
      success: false,
      error: `No driver found for type: ${connection.type}`,
    };
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
      const count =
        result.data[0].total || result.data[0].count || result.data[0].COUNT;
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
  const driver = databaseRegistry.getDriver(connection.type);
  if (!driver) {
    return {
      success: false,
      error: `No driver found for type: ${connection.type}`,
    };
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
  const driver = databaseRegistry.getDriver(connection.type);
  if (!driver) {
    return {
      success: false,
      error: `No driver found for type: ${connection.type}`,
    };
  }

  try {
    // Substitute template placeholders with safe defaults for validation
    // This handles {{limit}}, {{offset}}, {{last_sync_value}}, {{keyset_value}}
    const preparedQuery = prepareQueryForValidation(query);

    // Execute with LIMIT 1 to validate and get schema
    const testQuery = `SELECT * FROM (${preparedQuery}) AS validation_subquery LIMIT 1`;

    const result = await driver.executeQuery(connection, testQuery, {
      databaseName: database,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Query validation failed",
      };
    }

    // Extract column names from result (no type inference - let AI/user set types)
    let columns: Array<{ name: string; type: string }> = [];
    let sampleRow: Record<string, unknown> | undefined;

    if (result.data && result.data.length > 0) {
      sampleRow = result.data[0] as Record<string, unknown>;
      columns = Object.keys(sampleRow!).map(name => ({
        name,
        type: "", // Empty - types should be set by AI agent or user
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

// SQL query utilities (extracted to sql-query-utils.ts for testability)
import {
  findTopLevelKeyword,
  appendWhereCondition,
  appendSqlClause,
} from "./sql-query-utils";

/**
 * Dangerous SQL statement patterns that should be rejected
 */
const DANGEROUS_PATTERNS = [
  { pattern: /^\s*DROP\s+/i, name: "DROP" },
  { pattern: /^\s*DELETE\s+/i, name: "DELETE" },
  { pattern: /^\s*TRUNCATE\s+/i, name: "TRUNCATE" },
  { pattern: /^\s*ALTER\s+/i, name: "ALTER" },
  { pattern: /^\s*CREATE\s+/i, name: "CREATE" },
  { pattern: /^\s*INSERT\s+/i, name: "INSERT" },
  { pattern: /^\s*UPDATE\s+/i, name: "UPDATE" },
  { pattern: /^\s*GRANT\s+/i, name: "GRANT" },
  { pattern: /^\s*REVOKE\s+/i, name: "REVOKE" },
  {
    pattern:
      /;\s*(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE|GRANT|REVOKE)\s+/i,
    name: "multi-statement",
  },
  // CTE with data-modifying operations (e.g., WITH deleted AS (DELETE FROM ...) SELECT ...)
  // Only match when a DML keyword appears after "AS (" inside a CTE definition,
  // to avoid false positives on column names or string literals containing these words.
  {
    pattern:
      /\bWITH\b[^;]*\bAS\s*\(\s*(DELETE|INSERT|UPDATE|DROP|TRUNCATE|ALTER)\b/i,
    name: "data-modifying CTE",
  },
];

/**
 * Result of query safety check
 */
export interface QuerySafetyResult {
  safe: boolean;
  warnings: string[];
  errors: string[];
  suggestedFixes?: string[];
}

/**
 * Check if a query is safe for sync operations (read-only)
 * Returns errors for dangerous statements and warnings for best practices
 */
export function checkQuerySafety(query: string): QuerySafetyResult {
  const result: QuerySafetyResult = {
    safe: true,
    warnings: [],
    errors: [],
    suggestedFixes: [],
  };

  const trimmedQuery = query.trim();

  // Check for dangerous patterns
  for (const { pattern, name } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmedQuery)) {
      result.safe = false;
      result.errors.push(
        `Query contains dangerous ${name} statement. Only SELECT queries are allowed for sync operations.`,
      );
    }
  }

  // Check if query starts with SELECT
  if (
    !trimmedQuery.match(/^\s*SELECT\s+/i) &&
    !trimmedQuery.match(/^\s*WITH\s+/i)
  ) {
    result.safe = false;
    result.errors.push(
      "Query must start with SELECT or WITH (CTE). Only read operations are allowed.",
    );
  }

  // Check for ORDER BY (warning, not error)
  if (!trimmedQuery.match(/ORDER\s+BY\s+/i)) {
    result.warnings.push(
      "Query does not have ORDER BY clause. For consistent pagination results, consider adding ORDER BY.",
    );
    result.suggestedFixes?.push(
      "Add ORDER BY clause with a unique column (e.g., ORDER BY id ASC)",
    );
  }

  // Check for multiple statements (semicolons)
  const semicolonCount = (trimmedQuery.match(/;/g) || []).length;
  if (
    semicolonCount > 1 ||
    (semicolonCount === 1 && !trimmedQuery.endsWith(";"))
  ) {
    result.safe = false;
    result.errors.push(
      "Query contains multiple statements. Only single SELECT queries are allowed.",
    );
  }

  // Check for LIMIT without ORDER BY (warning)
  if (
    trimmedQuery.match(/LIMIT\s+\d+/i) &&
    !trimmedQuery.match(/ORDER\s+BY\s+/i)
  ) {
    result.warnings.push(
      "Query has LIMIT without ORDER BY. Results may be non-deterministic across runs.",
    );
  }

  return result;
}

/**
 * Apply type coercions to a row of data
 */
export function applyTypeCoercions(
  row: Record<string, unknown>,
  coercions: ITypeCoercion[],
): Record<string, unknown> {
  const result = { ...row };

  for (const coercion of coercions) {
    const { column, targetType, format, nullValue, transformer } = coercion;

    if (!(column in result)) {
      continue;
    }

    let value = result[column];

    // Handle null values
    if (value === null || value === undefined) {
      if (nullValue !== undefined) {
        result[column] = nullValue;
      }
      continue;
    }

    // Apply transformer first
    if (transformer && typeof value === "string") {
      switch (transformer) {
        case "lowercase":
          value = value.toLowerCase();
          break;
        case "uppercase":
          value = value.toUpperCase();
          break;
        case "trim":
          value = value.trim();
          break;
        case "json_parse":
          try {
            value = JSON.parse(value);
          } catch {
            // Keep original value if parse fails
          }
          break;
        case "json_stringify":
          value = JSON.stringify(value);
          break;
      }
    }

    // Apply type coercion
    switch (targetType) {
      case "string":
        result[column] = String(value);
        break;
      case "integer":
        result[column] = parseInt(String(value), 10);
        break;
      case "number":
      case "float":
      case "double":
        result[column] = parseFloat(String(value));
        break;
      case "boolean":
        if (typeof value === "string") {
          result[column] = ["true", "1", "yes", "on"].includes(
            value.toLowerCase(),
          );
        } else {
          result[column] = Boolean(value);
        }
        break;
      case "timestamp":
      case "date":
      case "datetime":
        if (value instanceof Date) {
          result[column] = value;
        } else if (typeof value === "string" || typeof value === "number") {
          const date = new Date(value);
          if (!isNaN(date.getTime())) {
            // Apply format if specified (for output formatting)
            if (format === "ISO") {
              result[column] = date.toISOString();
            } else if (format === "YYYY-MM-DD") {
              result[column] = date.toISOString().split("T")[0];
            } else {
              result[column] = date;
            }
          }
        }
        break;
      case "json":
        if (typeof value === "string") {
          try {
            result[column] = JSON.parse(value);
          } catch {
            result[column] = value;
          }
        } else {
          result[column] = value;
        }
        break;
      default:
        // Unknown type, keep as-is but apply transformer result
        result[column] = value;
    }
  }

  return result;
}

/**
 * Map type coercion target types to database column types
 * This is used to override inferred schema during table creation
 */
const coercionTypeToDbType: Record<string, string> = {
  string: "STRING",
  integer: "INT64",
  number: "FLOAT64",
  float: "FLOAT64",
  double: "FLOAT64",
  boolean: "BOOL",
  timestamp: "TIMESTAMP",
  date: "DATE",
  datetime: "TIMESTAMP",
  json: "JSON",
};

/**
 * Apply type coercions to the inferred schema
 * This ensures that the table is created with the correct column types
 * even when the data values might infer a different type
 */
export function applyTypeCoercionsToSchema(
  columns: ColumnDefinition[],
  coercions: ITypeCoercion[],
): ColumnDefinition[] {
  // Create a map of column name -> target type
  const coercionMap = new Map<string, string>();
  for (const coercion of coercions) {
    const dbType = coercionTypeToDbType[coercion.targetType.toLowerCase()];
    if (dbType) {
      coercionMap.set(coercion.column, dbType);
    }
  }

  // Apply overrides to the column definitions
  return columns.map(col => {
    const overrideType = coercionMap.get(col.name);
    if (overrideType) {
      return { ...col, type: overrideType };
    }
    return col;
  });
}

/**
 * Execute a single chunk of database sync with pagination
 * Supports both offset-based and keyset pagination
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
  paginationConfig?: IPaginationConfig;
  typeCoercions?: ITypeCoercion[];
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
    paginationConfig,
    typeCoercions,
    keyColumns,
    state,
    maxRowsPerChunk = 10000,
    onProgress,
  } = options;

  const driver = databaseRegistry.getDriver(sourceConnection.type);
  if (!driver) {
    return {
      state: { offset: 0, totalProcessed: 0, hasMore: false },
      rowsProcessed: 0,
      completed: true,
      error: `No driver found for source type: ${sourceConnection.type}`,
    };
  }

  // Initialize or restore state
  const currentState: DbSyncChunkState = state || {
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

  // Get source schema on first chunk (more reliable than inferring from data)
  // This uses the source database's metadata rather than sampling data values
  if (!currentState.sourceSchema && currentState.offset === 0) {
    if (driver.getQuerySchema) {
      const schemaResult = await driver.getQuerySchema(
        sourceConnection,
        sourceQuery,
        { databaseName: sourceDatabase },
      );
      if (schemaResult.success && schemaResult.columns) {
        currentState.sourceSchema = schemaResult.columns;
      }
      // If getQuerySchema fails, we'll fall back to inferSchema when writing
    }
  }

  // Prepare staging on first chunk for full sync
  if (syncMode === "full" && !currentState.stagingPrepared) {
    await destinationWriter.prepareFullSync();
    currentState.stagingPrepared = true;
  } else if (syncMode === "full" && currentState.stagingPrepared) {
    // Restore staging state for subsequent chunks (new writer instances
    // default to stagingActive=false, but staging was already prepared)
    (destinationWriter as any).stagingActive = true;
  }

  // Determine pagination mode
  const paginationMode = paginationConfig?.mode || "offset";
  const keysetColumn = paginationConfig?.keysetColumn;
  const keysetDirection = paginationConfig?.keysetDirection || "asc";

  // Check if the query uses template placeholders
  const queryTemplates = detectTemplates(sourceQuery);
  const usesTemplates =
    queryTemplates.hasLimit ||
    queryTemplates.hasOffset ||
    queryTemplates.hasLastSyncValue ||
    queryTemplates.hasKeysetValue;

  // Build paginated query
  let paginatedQuery: string;

  if (usesTemplates) {
    // Template-based query: substitute placeholders with runtime values
    const lastKeyset =
      currentState.lastKeysetValue || paginationConfig?.lastKeysetValue;

    // Prepare last_sync_value: format based on tracking type
    let lastSyncValue: string | number | null = null;
    if (
      syncMode === "incremental" &&
      incrementalConfig?.trackingColumn &&
      incrementalConfig?.lastValue
    ) {
      lastSyncValue =
        incrementalConfig.trackingType === "timestamp"
          ? incrementalConfig.lastValue // Keep as string for timestamps
          : incrementalConfig.lastValue;
    }

    // Prepare keyset_value: preserve type (string vs number)
    let keysetValue: string | number | null = null;
    if (paginationMode === "keyset" && lastKeyset) {
      keysetValue = isNaN(Number(lastKeyset)) ? lastKeyset : Number(lastKeyset);
    }

    paginatedQuery = substituteTemplates(sourceQuery, {
      limit: maxRowsPerChunk,
      offset: currentState.offset,
      last_sync_value: lastSyncValue,
      keyset_value: keysetValue,
    });
  } else {
    // Legacy mode: append WHERE clauses and LIMIT/OFFSET dynamically
    // Strip trailing semicolons to avoid "... ; LIMIT ..." syntax errors
    let effectiveQuery = sourceQuery.replace(/;\s*$/, "");

    // Helper: escape a value for safe SQL interpolation
    const escapeValue = (val: string, type: string): string => {
      if (type === "timestamp") {
        // Escape single quotes in timestamp values
        return `'${val.replace(/'/g, "''")}'`;
      }
      // Numeric values - validate they are actually numeric
      const num = Number(val);
      if (!isNaN(num) && isFinite(num)) {
        return String(num);
      }
      // Fallback: treat as string
      return `'${val.replace(/'/g, "''")}'`;
    };

    // Add incremental filter if applicable
    if (
      syncMode === "incremental" &&
      incrementalConfig?.trackingColumn &&
      incrementalConfig?.lastValue
    ) {
      const value = escapeValue(
        incrementalConfig.lastValue,
        incrementalConfig.trackingType || "timestamp",
      );
      const condition = `${incrementalConfig.trackingColumn} > ${value}`;
      effectiveQuery = appendWhereCondition(effectiveQuery, condition);
    }

    // Handle pagination based on mode
    if (paginationMode === "keyset" && keysetColumn) {
      // Keyset pagination: use WHERE column > last_value
      const lastKeyset =
        currentState.lastKeysetValue || paginationConfig?.lastKeysetValue;

      if (lastKeyset) {
        // Add keyset filter with proper escaping
        const keysetOperator = keysetDirection === "asc" ? ">" : "<";
        const keysetValue = isNaN(Number(lastKeyset))
          ? `'${String(lastKeyset).replace(/'/g, "''")}'`
          : lastKeyset;
        const condition = `${keysetColumn} ${keysetOperator} ${keysetValue}`;
        effectiveQuery = appendWhereCondition(effectiveQuery, condition);
      }

      // Ensure ORDER BY matches keyset column and direction
      if (findTopLevelKeyword(effectiveQuery, /^ORDER\s+BY\b/i) === -1) {
        effectiveQuery = appendSqlClause(
          effectiveQuery,
          `ORDER BY ${keysetColumn} ${keysetDirection.toUpperCase()}`,
        );
      }

      // Add LIMIT only (no OFFSET needed for keyset)
      paginatedQuery = appendSqlClause(
        effectiveQuery,
        `LIMIT ${maxRowsPerChunk}`,
      );
    } else {
      // Offset pagination: use LIMIT/OFFSET
      const orderColumn = incrementalConfig?.trackingColumn || "1";
      if (findTopLevelKeyword(effectiveQuery, /^ORDER\s+BY\b/i) === -1) {
        effectiveQuery = appendSqlClause(
          effectiveQuery,
          `ORDER BY ${orderColumn}`,
        );
      }

      paginatedQuery = appendSqlClause(
        effectiveQuery,
        `LIMIT ${maxRowsPerChunk} OFFSET ${currentState.offset}`,
      );
    }
  }

  let rowsProcessedInChunk = 0;
  let lastTrackingValue: string | undefined;
  let lastKeysetValue: string | undefined;

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

    let rows = result.data || [];

    // Apply type coercions if configured
    if (typeCoercions && typeCoercions.length > 0) {
      rows = rows.map((row: Record<string, unknown>) =>
        applyTypeCoercions(row, typeCoercions),
      );
    }

    // Process in smaller batches for writing
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);

      const writeResult = await destinationWriter.writeBatch(batch, {
        keyColumns,
        conflictStrategy: "update",
        typeCoercions, // Pass coercions for table creation schema overrides
        sourceSchema: currentState.sourceSchema, // Use source schema for reliable table creation
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

      // Track the last keyset value for keyset pagination
      if (paginationMode === "keyset" && keysetColumn && batch.length > 0) {
        const lastRow = batch[batch.length - 1];
        const keysetValue = lastRow[keysetColumn];
        if (keysetValue !== null && keysetValue !== undefined) {
          lastKeysetValue =
            keysetValue instanceof Date
              ? keysetValue.toISOString()
              : String(keysetValue);
        }
      }

      onProgress?.(currentState.totalProcessed, currentState.estimatedTotal);
    }

    // Check if there's more data
    const hasMore = rows.length === maxRowsPerChunk;

    // Update state based on pagination mode
    if (paginationMode === "keyset") {
      // For keyset pagination, don't use offset
      if (lastKeysetValue) {
        currentState.lastKeysetValue = lastKeysetValue;
      }
    } else {
      // For offset pagination
      currentState.offset += rows.length;
    }

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

/**
 * Dry run a sync configuration: execute 3 pages and return preview data
 */
export async function dryRunDbSync(options: {
  sourceConnection: IDatabaseConnection;
  sourceQuery: string;
  sourceDatabase?: string;
  paginationConfig?: IPaginationConfig;
  typeCoercions?: ITypeCoercion[];
  pageSize?: number;
  pages?: number;
}): Promise<{
  success: boolean;
  totalRows: number;
  sampleData: Record<string, unknown>[];
  columns: Array<{ name: string; type: string }>;
  estimatedTotal?: number;
  safetyCheck: QuerySafetyResult;
  error?: string;
}> {
  const {
    sourceConnection,
    sourceQuery,
    sourceDatabase,
    paginationConfig,
    typeCoercions,
    pageSize = 100,
    pages = 3,
  } = options;

  // First, run safety checks
  const safetyCheck = checkQuerySafety(sourceQuery);
  if (!safetyCheck.safe) {
    return {
      success: false,
      totalRows: 0,
      sampleData: [],
      columns: [],
      safetyCheck,
      error: safetyCheck.errors.join("; "),
    };
  }

  const driver = databaseRegistry.getDriver(sourceConnection.type);
  if (!driver) {
    return {
      success: false,
      totalRows: 0,
      sampleData: [],
      columns: [],
      safetyCheck,
      error: `No driver found for type: ${sourceConnection.type}`,
    };
  }

  // Estimate total
  const countResult = await estimateQueryRowCount(
    sourceConnection,
    sourceQuery,
    sourceDatabase,
  );

  const allRows: Record<string, unknown>[] = [];
  let lastKeysetValue: string | undefined;
  const paginationMode = paginationConfig?.mode || "offset";
  const keysetColumn = paginationConfig?.keysetColumn;
  const keysetDirection = paginationConfig?.keysetDirection || "asc";

  try {
    // Execute specified number of pages
    for (let page = 0; page < pages; page++) {
      let paginatedQuery: string;
      // Strip trailing semicolons before appending clauses
      const baseQuery = sourceQuery.replace(/;\s*$/, "");

      if (paginationMode === "keyset" && keysetColumn) {
        let effectiveQuery = baseQuery;

        if (lastKeysetValue) {
          const keysetOperator = keysetDirection === "asc" ? ">" : "<";
          const keysetValue = isNaN(Number(lastKeysetValue))
            ? `'${String(lastKeysetValue).replace(/'/g, "''")}'`
            : lastKeysetValue;
          const condition = `${keysetColumn} ${keysetOperator} ${keysetValue}`;
          effectiveQuery = appendWhereCondition(effectiveQuery, condition);
        }

        if (findTopLevelKeyword(effectiveQuery, /^ORDER\s+BY\b/i) === -1) {
          effectiveQuery = appendSqlClause(
            effectiveQuery,
            `ORDER BY ${keysetColumn} ${keysetDirection.toUpperCase()}`,
          );
        }

        paginatedQuery = appendSqlClause(effectiveQuery, `LIMIT ${pageSize}`);
      } else {
        let effectiveQuery = baseQuery;
        if (findTopLevelKeyword(effectiveQuery, /^ORDER\s+BY\b/i) === -1) {
          effectiveQuery = appendSqlClause(effectiveQuery, `ORDER BY 1`);
        }
        paginatedQuery = appendSqlClause(
          effectiveQuery,
          `LIMIT ${pageSize} OFFSET ${page * pageSize}`,
        );
      }

      const result = await driver.executeQuery(
        sourceConnection,
        paginatedQuery,
        {
          databaseName: sourceDatabase,
        },
      );

      if (!result.success) {
        return {
          success: false,
          totalRows: allRows.length,
          sampleData: allRows,
          columns: [],
          estimatedTotal: countResult.estimatedCount,
          safetyCheck,
          error: result.error,
        };
      }

      let rows = result.data || [];
      if (rows.length === 0) break;

      // Apply type coercions
      if (typeCoercions && typeCoercions.length > 0) {
        rows = rows.map((row: Record<string, unknown>) =>
          applyTypeCoercions(row, typeCoercions),
        );
      }

      allRows.push(...rows);

      // Update keyset value for next page
      if (paginationMode === "keyset" && keysetColumn && rows.length > 0) {
        const lastRow = rows[rows.length - 1];
        const value = lastRow[keysetColumn];
        if (value !== null && value !== undefined) {
          lastKeysetValue =
            value instanceof Date ? value.toISOString() : String(value);
        }
      }

      // Stop if we got fewer rows than requested
      if (rows.length < pageSize) break;
    }

    // Infer columns from results
    const columns: Array<{ name: string; type: string }> = [];
    if (allRows.length > 0) {
      for (const [name, value] of Object.entries(allRows[0])) {
        columns.push({ name, type: inferJsType(value) });
      }
    }

    return {
      success: true,
      totalRows: allRows.length,
      sampleData: allRows,
      columns,
      estimatedTotal: countResult.estimatedCount,
      safetyCheck,
    };
  } catch (error) {
    return {
      success: false,
      totalRows: allRows.length,
      sampleData: allRows,
      columns: [],
      estimatedTotal: countResult.estimatedCount,
      safetyCheck,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
