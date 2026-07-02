import { IDatabaseConnection } from "../database/workspace-schema";

export interface DatabaseTreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren?: boolean;
  icon?: string; // optional icon key or inline svg name
  metadata?: any;
}

export interface DatabaseDriverMetadata {
  type: string;
  displayName: string;
  consoleLanguage: "sql" | "mongodb" | "javascript" | string;
  icon?: string;
}

/**
 * Column definition for schema inference and table creation
 */
export interface ColumnDefinition {
  name: string;
  type: string; // Source type (will be mapped to target type)
  nullable?: boolean;
  primaryKey?: boolean;
}

/**
 * Result of a batch write operation
 */
export interface BatchWriteResult {
  success: boolean;
  rowsWritten: number;
  error?: string;
}

/**
 * BigQuery table partitioning configuration
 */
export interface TablePartitioning {
  type: "time" | "ingestion";
  /** Column to partition on (required for type: "time", ignored for "ingestion") */
  field?: string;
  granularity?: "day" | "hour" | "month" | "year";
  requirePartitionFilter?: boolean;
}

/**
 * BigQuery table clustering configuration
 */
export interface TableClustering {
  fields: string[];
}

/**
 * Options for insert operations
 */
export interface InsertOptions {
  /** Schema/dataset name for the target table */
  schema?: string;
  /** Optional schema/dataset where staging/working tables are stored */
  stagingSchema?: string;
  /** Pre-mapped column types for write operations (avoids re-querying INFORMATION_SCHEMA) */
  columnTypes?: Map<string, string>;
  /** Table partitioning config (BigQuery) */
  partitioning?: TablePartitioning;
  /** Table clustering config (BigQuery) */
  clustering?: TableClustering;
  /** Soft-delete column names to inject during table creation */
  softDeleteColumns?: { isDeleted: string; deletedAt: string };
}

/**
 * Options for upsert operations
 */
export interface UpsertOptions extends InsertOptions {
  /** Strategy for handling conflicts */
  conflictStrategy?: "update" | "ignore" | "replace";
}

/**
 * Options for streaming query execution (cursor-based reading)
 */
export interface StreamingQueryOptions {
  /** Batch size for streaming reads */
  batchSize?: number;
  /** Callback for each batch of rows */
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Target database name (for cluster mode) */
  databaseName?: string;
}

export interface DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata;
  getTreeRoot(database: IDatabaseConnection): Promise<DatabaseTreeNode[]>;
  getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]>;
  getAutocompleteData?(
    database: IDatabaseConnection,
  ): Promise<Record<string, any>>;

  /**
   * Optional: full SQL definition script for a table or view (DDL, comments,
   * indexes, triggers). Currently implemented by the Postgres-family drivers.
   */
  getTableDefinition?(
    database: IDatabaseConnection,
    params: { schema: string; table: string; databaseName?: string },
  ): Promise<{ success: boolean; definition?: string; error?: string }>;
  executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: any,
  ): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    rowCount?: number;
  }>;

  /**
   * Optional: cancel an in-flight query started via executeQuery that was provided an executionId.
   * Implementations should return { success: false, error: "Query not found or already completed" }
   * when the executionId is unknown.
   */
  cancelQuery?(
    executionId: string,
  ): Promise<{ success: boolean; error?: string }>;

  // ============ DESTINATION DIALECT CAPABILITIES ============
  // These let generic sync/route code stay engine-agnostic instead of
  // branching on `database.type`. Drivers override only what differs from
  // the conventional SQL defaults assumed by callers.

  /**
   * Schema/dataset where staging & working tables should be created.
   * Defaults (when not implemented) to the primary/live schema. BigQuery
   * isolates staging in a dedicated working dataset (`mako_internal`).
   */
  getStagingSchema?(primarySchema?: string): string | undefined;

  /**
   * Whether CDC/webhook flows to this destination must use soft-delete
   * (tombstones) rather than hard deletes. Defaults to false. BigQuery's CDC
   * MERGE path relies on tombstones for correctness.
   */
  requiresSoftDeleteForCdc?(): boolean;

  /**
   * Whether write operations need a pre-built `columnTypes` map passed in
   * InsertOptions/UpsertOptions. Defaults to false. BigQuery requires explicit
   * column types so MERGE/INSERT statements are correctly typed.
   */
  requiresTypedColumns?(): boolean;

  /**
   * Map a logical/source column type to this destination's native type.
   * Defaults to identity (no implementation = caller keeps the source type).
   */
  mapColumnType?(sourceType: string): string;

  /**
   * Build a fully-qualified, properly-quoted table reference for raw SQL.
   * Defaults (when not implemented) to standard SQL double-quoting:
   * `"schema"."table"`.
   */
  formatTableRef?(
    schema: string | undefined,
    table: string,
    options?: { projectId?: string },
  ): string;

  /**
   * Quote a single identifier (column/table/schema) for raw SQL against this
   * engine. Implement for engines whose bare identifiers are case-folded
   * (Postgres family lowercases `_syncedAt` → `_syncedat`). Leave unset for
   * engines where bare identifiers match case-insensitively (BigQuery, MySQL)
   * — callers fall back to the bare name there.
   */
  quoteIdentifier?(name: string): string;

  /**
   * Build a single batch query returning approximate row counts for the given
   * tables, yielding rows shaped `{ table_id, row_count }`. Returns null when
   * the engine has no cheap metadata-based row-count path (callers then skip
   * counting). Each engine uses its own metadata source (e.g. BigQuery's
   * `__TABLES__`, Postgres' `pg_class.reltuples`).
   */
  buildRowCountBatchQuery?(
    schema: string,
    tableNames: string[],
    options?: { projectId?: string },
  ): string | null;

  // ============ WRITE CAPABILITIES (for db-to-db sync) ============

  /**
   * Check if this driver supports write operations
   */
  supportsWrites?(): boolean;

  /**
   * Ensure the target schema/dataset exists, creating it if needed.
   * Only applicable to databases where schema must exist before tables (e.g. BigQuery datasets).
   */
  ensureSchema?(
    database: IDatabaseConnection,
    schemaName: string,
    options?: { location?: string },
  ): Promise<{ success: boolean; created?: boolean; error?: string }>;

  /**
   * Get the schema (column definitions) for a query without fully executing it.
   * This is more robust than inferring from sample data as it:
   * - Handles NULL values correctly (knows the actual column type)
   * - Doesn't depend on data sampling
   * - Uses database metadata (INFORMATION_SCHEMA, dry run, etc.)
   *
   * @param database - Database connection
   * @param query - The SQL query to analyze
   * @param options - Additional options (databaseName for cluster mode)
   * @returns Column definitions from the database
   */
  getQuerySchema?(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseName?: string },
  ): Promise<{
    success: boolean;
    columns?: ColumnDefinition[];
    error?: string;
  }>;

  /**
   * Infer column definitions from query result data
   * DEPRECATED: Prefer getQuerySchema() which is more reliable
   * Used as fallback when getQuerySchema is not available
   */
  inferSchema?(rows: Record<string, unknown>[]): ColumnDefinition[];

  /**
   * Create a table with the given schema
   * @param database - Database connection
   * @param tableName - Name of the table to create
   * @param columns - Column definitions
   * @param options - Additional options (schema/dataset name)
   */
  createTable?(
    database: IDatabaseConnection,
    tableName: string,
    columns: ColumnDefinition[],
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Check if a table exists
   */
  tableExists?(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<boolean>;

  /**
   * Insert a batch of rows into a table
   * @param database - Database connection
   * @param tableName - Name of the table
   * @param rows - Array of row objects
   * @param options - Insert options
   */
  insertBatch?(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    options?: InsertOptions,
  ): Promise<BatchWriteResult>;

  /**
   * Upsert a batch of rows into a table
   * @param database - Database connection
   * @param tableName - Name of the table
   * @param rows - Array of row objects
   * @param keyColumns - Columns that form the unique key for conflict detection
   * @param options - Upsert options
   */
  upsertBatch?(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    keyColumns: string[],
    options?: UpsertOptions,
  ): Promise<BatchWriteResult>;

  /**
   * Add columns that are present in incoming rows but missing from the table.
   * Used by CDC/event-driven syncs where payload shape can evolve over time.
   */
  addMissingColumns?(
    database: IDatabaseConnection,
    tableName: string,
    schemaName: string,
    rows: Record<string, unknown>[],
  ): Promise<void>;

  /**
   * Create a staging table (copy of original table structure)
   * Used for full sync with atomic swap
   */
  createStagingTable?(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Swap staging table with the original table (atomic operation)
   * Renames staging -> original, drops old original
   */
  swapStagingTable?(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Create a table with the same schema as a source table, with optional
   * partitioning/clustering. Does NOT copy data.
   */
  createTableFromSource?(
    database: IDatabaseConnection,
    sourceTableName: string,
    targetTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Drop a table
   */
  dropTable?(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Delete rows by key column values
   * @param database - Database connection
   * @param tableName - Name of the table
   * @param keyFilters - Object mapping column names to values for the WHERE clause (AND'd together)
   * @param options - Options (schema/dataset)
   */
  deleteBatch?(
    database: IDatabaseConnection,
    tableName: string,
    keyFilters: Record<string, unknown>,
    options?: InsertOptions,
  ): Promise<BatchWriteResult>;

  /**
   * Execute a streaming query, calling onBatch for each batch of rows
   * This is memory-efficient for large result sets
   */
  executeStreamingQuery?(
    database: IDatabaseConnection,
    query: string,
    options: StreamingQueryOptions,
  ): Promise<{ success: boolean; totalRows: number; error?: string }>;
}
