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
 * Options for insert operations
 */
export interface InsertOptions {
  /** Schema/dataset name for the target table */
  schema?: string;
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
  getAutocompleteData?(database: IDatabaseConnection): Promise<Record<string, any>>;
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

  // ============ WRITE CAPABILITIES (for db-to-db sync) ============

  /**
   * Check if this driver supports write operations
   */
  supportsWrites?(): boolean;

  /**
   * Infer column definitions from query result data
   * Used for auto-creating tables when they don't exist
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
   * Drop a table
   */
  dropTable?(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }>;

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
