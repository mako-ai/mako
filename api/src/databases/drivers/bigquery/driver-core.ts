import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
  ColumnDefinition,
  InsertOptions,
  TablePartitioning,
  TableClustering,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { executeCheckedQuery } from "../../checked-query";
import type { QueryExecuteOptions, QueryResult } from "../../query-types";
import { getSchema, listDatasets, listTables } from "./catalog";
import { bigQueryEngine } from "./engine";
import { loggers } from "../../../logging";
import { BIGQUERY_WORKING_DATASET } from "../../../utils/bigquery-working-dataset";
import { escapeSqlLiteral } from "../../sql-utils";
import {
  mapToBigQueryType,
  inferBigQueryType,
  escapeIdentifier,
} from "./sql-values";

/**
 * The BigQuery driver's tree, query, schema and table plumbing; the
 * batch writes (batch-writes.ts) and table swaps (driver.ts) build on it.
 */
export class BigQueryDriverCore implements DatabaseDriver {
  protected logger = loggers.db("bigquery");
  protected tableColumnTypeCache = new Map<string, Map<string, string>>();

  protected getTableCacheKey(
    database: IDatabaseConnection,
    dataset: string,
    tableName: string,
  ): string {
    const projectId = this.getProjectId(database);
    return `${projectId}.${dataset}.${tableName}`;
  }

  protected async getCachedTableColumnTypes(
    database: IDatabaseConnection,
    tableName: string,
    dataset: string,
    forceRefresh = false,
  ): Promise<Map<string, string>> {
    const cacheKey = this.getTableCacheKey(database, dataset, tableName);
    if (!forceRefresh) {
      const cached = this.tableColumnTypeCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const fetched = await this.getTableColumnTypes(
      database,
      tableName,
      dataset,
    );
    if (fetched.size > 0) {
      this.tableColumnTypeCache.set(cacheKey, fetched);
      return fetched;
    }

    // Avoid caching empty results so transient metadata lookup failures can recover.
    return this.tableColumnTypeCache.get(cacheKey) || fetched;
  }

  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "bigquery",
      displayName: "BigQuery",
      consoleLanguage: "sql",
    } as any;
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    const datasets = await listDatasets(bigQueryEngine, database);
    return datasets.map<DatabaseTreeNode>(ds => ({
      id: ds,
      label: ds,
      kind: "dataset",
      hasChildren: true,
      metadata: { datasetId: ds },
    }));
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    if (parent.kind !== "dataset") return [];
    const datasetId = parent.metadata?.datasetId || parent.id;
    const items = await listTables(bigQueryEngine, database, datasetId);
    const groups: Record<string, true> = {};
    for (const it of items) {
      const [, tableIdRaw] = it.name.split(".");
      const base = (tableIdRaw || "").replace(/_(\d{8})$/, "_");
      groups[base] = true;
    }
    return Object.keys(groups)
      .sort((a, b) => a.localeCompare(b))
      .map<DatabaseTreeNode>(base => ({
        id: `${datasetId}.${base}`,
        label: base,
        kind: "table",
        hasChildren: false,
        metadata: { datasetId, tableGroup: base },
      }));
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    return executeCheckedQuery(database, query, options);
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<Record<string, any>> {
    return getSchema(bigQueryEngine, database);
  }

  // ============ DESTINATION DIALECT CAPABILITIES ============

  getStagingSchema(): string {
    // BigQuery isolates staging/working tables in a dedicated dataset so they
    // never pollute the user's live dataset.
    return BIGQUERY_WORKING_DATASET;
  }

  requiresSoftDeleteForCdc(): boolean {
    // The BigQuery CDC MERGE path relies on tombstones for correctness.
    return true;
  }

  requiresTypedColumns(): boolean {
    return true;
  }

  mapColumnType(sourceType: string): string {
    return mapToBigQueryType(sourceType);
  }

  formatTableRef(
    schema: string | undefined,
    table: string,
    options?: { projectId?: string },
  ): string {
    const dataset = options?.projectId
      ? `\`${options.projectId}\`.\`${schema}\``
      : `\`${schema}\``;
    return `${dataset}.${table}`;
  }

  buildRowCountBatchQuery(
    schema: string,
    tableNames: string[],
    options?: { projectId?: string },
  ): string | null {
    if (tableNames.length === 0) return null;
    const inList = tableNames.map(escapeSqlLiteral).join(",");
    const dataset = options?.projectId
      ? `\`${options.projectId}\`.\`${schema}\``
      : `\`${schema}\``;
    return `SELECT table_id, row_count FROM ${dataset}.__TABLES__ WHERE table_id IN (${inList})`;
  }

  buildColumnListQuery(
    schema: string,
    tableNames: string[],
    options?: { projectId?: string },
  ): string {
    const inList = tableNames.map(escapeSqlLiteral).join(",");
    const dataset = options?.projectId
      ? `\`${options.projectId}\`.\`${schema}\``
      : `\`${schema}\``;
    return `SELECT table_name, column_name FROM ${dataset}.INFORMATION_SCHEMA.COLUMNS WHERE table_name IN (${inList}) ORDER BY table_name, ordinal_position`;
  }

  // ============ WRITE CAPABILITIES ============

  supportsWrites(): boolean {
    return true;
  }

  /**
   * Ensure the BigQuery dataset exists, creating it if not.
   */
  async ensureSchema(
    database: IDatabaseConnection,
    schemaName: string,
    options?: { location?: string },
  ): Promise<{ success: boolean; created?: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const location =
      options?.location || (database.connection as any).location || "US";

    const checkQuery = `
      SELECT schema_name, location
      FROM ${escapeIdentifier(projectId)}.INFORMATION_SCHEMA.SCHEMATA
      WHERE schema_name = '${schemaName.replace(/'/g, "''")}'
    `;
    const checkResult = await this.executeQuery(database, checkQuery);
    if (
      checkResult.success &&
      checkResult.data &&
      checkResult.data.length > 0
    ) {
      const existingLocationRaw = String(checkResult.data[0]?.location || "")
        .trim()
        .toLowerCase();
      const requestedLocationRaw = String(location || "")
        .trim()
        .toLowerCase();
      if (
        existingLocationRaw &&
        requestedLocationRaw &&
        existingLocationRaw !== requestedLocationRaw
      ) {
        return {
          success: false,
          error: `Dataset ${schemaName} exists in location ${checkResult.data[0]?.location}, but connection is configured for ${location}.`,
        };
      }
      return { success: true, created: false };
    }

    const createQuery = `CREATE SCHEMA IF NOT EXISTS ${escapeIdentifier(projectId)}.${escapeIdentifier(schemaName)} OPTIONS(location='${location}')`;
    const createResult = await this.executeQuery(database, createQuery);
    if (!createResult.success) {
      return { success: false, error: createResult.error };
    }
    return { success: true, created: true };
  }

  /**
   * Get the project ID from the database connection
   */
  protected getProjectId(database: IDatabaseConnection): string {
    const conn = database.connection as any;
    return conn.project_id;
  }

  /**
   * Get the schema (column types) for a query using BigQuery's dry run feature.
   * This is more reliable than inferring from sample data because:
   * - NULL values are handled correctly
   * - No data sampling variance
   * - Works even if query returns 0 rows
   */
  async getQuerySchema(
    database: IDatabaseConnection,
    query: string,
    _options?: { databaseName?: string },
  ): Promise<{
    success: boolean;
    columns?: ColumnDefinition[];
    error?: string;
  }> {
    const result = await bigQueryEngine.getQuerySchema(database, query);

    if (!result.success || !result.columns) {
      return { success: false, error: result.error };
    }

    // Map to ColumnDefinition format
    const columns: ColumnDefinition[] = result.columns.map(col => ({
      name: col.name,
      type: col.type,
      nullable: col.nullable,
    }));

    return { success: true, columns };
  }

  /**
   * Infer column definitions from sample data
   * Fallback for when getQuerySchema() is unavailable or fails (destination-writer).
   */
  inferSchema(rows: Record<string, unknown>[]): ColumnDefinition[] {
    if (rows.length === 0) return [];

    const columnTypes: Map<string, Set<string>> = new Map();
    const columnNullable: Map<string, boolean> = new Map();

    // Analyze all rows to determine column types
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (!columnTypes.has(key)) {
          columnTypes.set(key, new Set());
          columnNullable.set(key, false);
        }

        if (value === null || value === undefined) {
          columnNullable.set(key, true);
        } else {
          const existing = columnTypes.get(key);
          if (existing) existing.add(inferBigQueryType(value));
        }
      }
    }

    // Build column definitions
    const columns: ColumnDefinition[] = [];
    for (const [name, types] of columnTypes) {
      // If multiple types detected, use STRING as fallback
      let type = "STRING";
      const typeArray = Array.from(types);
      if (typeArray.length === 1) {
        type = typeArray[0];
      } else if (typeArray.length > 1) {
        // Try to find a common numeric type
        if (typeArray.every(t => ["INT64", "FLOAT64"].includes(t))) {
          type = "FLOAT64";
        }
      }

      columns.push({
        name,
        type,
        nullable: columnNullable.get(name) ?? true,
      });
    }

    return columns;
  }

  /**
   * Build PARTITION BY clause from config
   */
  protected buildPartitionClause(partitioning?: TablePartitioning): string {
    if (!partitioning) return "";
    if (partitioning.type === "ingestion") {
      return "\nPARTITION BY _PARTITIONDATE";
    }
    const field = partitioning.field || "_syncedAt";
    const gran = (partitioning.granularity || "day").toUpperCase();
    return `\nPARTITION BY TIMESTAMP_TRUNC(${escapeIdentifier(field)}, ${gran})`;
  }

  /**
   * Build CLUSTER BY clause from config
   */
  protected buildClusterClause(clustering?: TableClustering): string {
    if (!clustering || clustering.fields.length === 0) return "";
    const cols = clustering.fields.slice(0, 4).map(escapeIdentifier).join(", ");
    return `\nCLUSTER BY ${cols}`;
  }

  /**
   * Build OPTIONS clause for partition filter requirement
   */
  protected buildTableOptions(partitioning?: TablePartitioning): string {
    if (!partitioning?.requirePartitionFilter) return "";
    return `\nOPTIONS (require_partition_filter = TRUE)`;
  }

  /**
   * Create a table with the given schema
   * In BigQuery, schema = dataset
   * Supports partition/cluster/soft-delete column injection via InsertOptions
   */
  async createTable(
    database: IDatabaseConnection,
    tableName: string,
    columns: ColumnDefinition[],
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;

    const allColumns = [...columns];

    if (options?.softDeleteColumns) {
      const existingNames = new Set(allColumns.map(c => c.name.toLowerCase()));
      if (
        !existingNames.has(options.softDeleteColumns.isDeleted.toLowerCase())
      ) {
        allColumns.push({
          name: options.softDeleteColumns.isDeleted,
          type: "BOOL",
          nullable: true,
        });
      }
      if (
        !existingNames.has(options.softDeleteColumns.deletedAt.toLowerCase())
      ) {
        allColumns.push({
          name: options.softDeleteColumns.deletedAt,
          type: "TIMESTAMP",
          nullable: true,
        });
      }
    }

    const columnDefs = allColumns.map(col => {
      let def = `${escapeIdentifier(col.name)} ${col.type}`;
      if (!col.nullable) def += " NOT NULL";
      return def;
    });

    const partitionClause = this.buildPartitionClause(options?.partitioning);
    const clusterClause = this.buildClusterClause(options?.clustering);
    const tableOptions = this.buildTableOptions(options?.partitioning);

    const query = `CREATE TABLE IF NOT EXISTS ${fullTableName} (\n  ${columnDefs.join(",\n  ")}\n)${partitionClause}${clusterClause}${tableOptions};`;

    const result = await this.executeQuery(database, query);

    return {
      success: result.success,
      error: result.error,
    };
  }

  /**
   * Check if a table exists
   */
  async tableExists(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<boolean> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) return false;

    const query = `
      SELECT COUNT(*) as cnt
      FROM ${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.INFORMATION_SCHEMA.TABLES
      WHERE table_name = '${tableName.replace(/'/g, "''")}'
    `;

    const result = await this.executeQuery(database, query);
    if (!result.success || !result.data) return false;
    return (result.data[0]?.cnt ?? 0) > 0;
  }

  /**
   * Get column types for an existing table from INFORMATION_SCHEMA
   * Returns a map of column name -> BigQuery data type
   */
  protected async getTableColumnTypes(
    database: IDatabaseConnection,
    tableName: string,
    dataset: string,
  ): Promise<Map<string, string>> {
    const projectId = this.getProjectId(database);
    const columnTypes = new Map<string, string>();

    const query = `
      SELECT column_name, data_type
      FROM ${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.INFORMATION_SCHEMA.COLUMNS
      WHERE table_name = '${tableName.replace(/'/g, "''")}'
    `;

    const result = await this.executeQuery(database, query);
    if (result.success && result.data) {
      for (const row of result.data) {
        if (row.column_name && row.data_type) {
          // Store with lowercase key for case-insensitive lookup
          columnTypes.set(row.column_name.toLowerCase(), row.data_type);
        }
      }
    }

    return columnTypes;
  }

  /**
   * Add missing columns to an existing table via ALTER TABLE ADD COLUMN.
   * Compares row keys against INFORMATION_SCHEMA and adds any that don't exist.
   */
  async addMissingColumns(
    database: IDatabaseConnection,
    tableName: string,
    dataset: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    const existingColumns = await this.getCachedTableColumnTypes(
      database,
      tableName,
      dataset,
    );

    const allKeys = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allKeys.add(k));
    }

    const missing: Array<{ key: string; colType: string }> = [];
    for (const key of allKeys) {
      if (key.includes(".")) continue;
      if (!existingColumns.has(key.toLowerCase())) {
        const sampleValue = rows.find(
          r => r[key] !== null && r[key] !== undefined,
        )?.[key];
        missing.push({ key, colType: inferBigQueryType(sampleValue) });
      }
    }

    if (missing.length === 0) return;

    const projectId = this.getProjectId(database);
    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;
    const maxRetries = Math.max(
      parseInt(process.env.BIGQUERY_SCHEMA_UPDATE_MAX_RETRIES || "8", 10) || 8,
      1,
    );
    const baseDelayMs = Math.max(
      parseInt(
        process.env.BIGQUERY_SCHEMA_UPDATE_RETRY_BASE_MS || "1000",
        10,
      ) || 1000,
      200,
    );
    const maxDelayMs = Math.max(
      parseInt(
        process.env.BIGQUERY_SCHEMA_UPDATE_RETRY_MAX_MS || "30000",
        10,
      ) || 30000,
      baseDelayMs,
    );
    const addedColumns: string[] = [];
    const unresolved: Array<{ key: string; error?: string }> = [];

    // Fast path: add all missing columns in one DDL statement.
    // This avoids N round-trips when payloads contain many new fields.
    const batchAlterQuery = `ALTER TABLE ${fullTableName} ${missing
      .map(
        ({ key, colType }) =>
          `ADD COLUMN IF NOT EXISTS ${escapeIdentifier(key)} ${colType}`,
      )
      .join(", ")}`;
    const batchResult = await this.executeQuery(database, batchAlterQuery);
    if (batchResult.success) {
      for (const { key, colType } of missing) {
        existingColumns.set(key.toLowerCase(), colType);
        addedColumns.push(key);
      }
    } else {
      const batchError =
        typeof batchResult.error === "string"
          ? batchResult.error
          : JSON.stringify(batchResult.error);

      if (this.isSchemaContainerMissingError(batchError)) {
        throw new Error(
          `BIGQUERY_SCHEMA_UPDATE_FAILED: Unable to add ${missing.length} columns for ${dataset}.${tableName}. First error: ${batchError}`,
        );
      }

      this.logger.warn("Batched schema update failed; retrying per column", {
        table: tableName,
        missingColumns: missing.length,
        error: batchError,
      });
    }

    if (addedColumns.length === missing.length) {
      this.logger.info("Schema evolution: added columns", {
        table: tableName,
        columns: addedColumns,
        count: addedColumns.length,
      });
      const cacheKey = this.getTableCacheKey(database, dataset, tableName);
      this.tableColumnTypeCache.set(cacheKey, existingColumns);
      return;
    }

    for (const { key, colType } of missing) {
      if (existingColumns.has(key.toLowerCase())) {
        continue;
      }
      let added = false;
      let lastError: string | undefined;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const query = `ALTER TABLE ${fullTableName} ADD COLUMN IF NOT EXISTS ${escapeIdentifier(key)} ${colType}`;
        const result = await this.executeQuery(database, query);
        if (result.success) {
          existingColumns.set(key.toLowerCase(), colType);
          addedColumns.push(key);
          added = true;
          break;
        }

        lastError =
          typeof result.error === "string"
            ? result.error
            : JSON.stringify(result.error);
        if (this.isSchemaContainerMissingError(lastError)) {
          throw new Error(
            `BIGQUERY_SCHEMA_UPDATE_FAILED: Unable to add ${missing.length} columns for ${dataset}.${tableName}. First error: ${lastError}`,
          );
        }
        const quotaExceeded = this.isTableUpdateQuotaExceededError(lastError);
        this.logger.warn("Failed to add column", {
          table: tableName,
          column: key,
          attempt: attempt + 1,
          maxRetries,
          quotaExceeded,
          error: lastError,
        });

        if (quotaExceeded && attempt < maxRetries - 1) {
          const jitter = Math.floor(Math.random() * 250);
          const backoff = Math.min(
            baseDelayMs * 2 ** attempt + jitter,
            maxDelayMs,
          );
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }

        break;
      }

      if (!added) {
        unresolved.push({ key, error: lastError });
      }
    }

    if (addedColumns.length > 0) {
      this.logger.info("Schema evolution: added columns", {
        table: tableName,
        columns: addedColumns,
        count: addedColumns.length,
      });
    }

    const cacheKey = this.getTableCacheKey(database, dataset, tableName);
    this.tableColumnTypeCache.set(cacheKey, existingColumns);

    if (unresolved.length > 0) {
      const quotaOnly = unresolved.every(entry =>
        this.isTableUpdateQuotaExceededError(entry.error),
      );
      const firstError = unresolved[0]?.error || "unknown";
      const reason = quotaOnly
        ? "BIGQUERY_SCHEMA_UPDATE_QUOTA_EXCEEDED"
        : "BIGQUERY_SCHEMA_UPDATE_FAILED";
      throw new Error(
        `${reason}: Unable to add ${unresolved.length} columns for ${dataset}.${tableName}. First error: ${firstError}`,
      );
    }
  }

  protected isTableUpdateQuotaExceededError(error?: string): boolean {
    if (!error) return false;
    const normalized = error.toLowerCase();
    return (
      normalized.includes("table exceeded quota for table update operations") ||
      normalized.includes("job exceeded rate limits") ||
      normalized.includes("rate limit exceeded")
    );
  }

  protected isSchemaContainerMissingError(error?: string): boolean {
    if (!error) return false;
    const normalized = error.toLowerCase();
    return (
      normalized.includes("not found: dataset") ||
      normalized.includes("was not found in location")
    );
  }

  protected extractRequiredNullField(error?: string): string | undefined {
    if (!error) return undefined;
    // BigQuery pattern: "Required field in_reply_to_id cannot be null"
    const match = error.match(/Required field ([A-Za-z0-9_]+) cannot be null/i);
    return match?.[1];
  }

  protected async relaxRequiredColumn(
    database: IDatabaseConnection,
    tableName: string,
    dataset: string,
    columnName: string,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;
    const query = `ALTER TABLE ${fullTableName} ALTER COLUMN ${escapeIdentifier(columnName)} DROP NOT NULL;`;
    const result = await this.executeQuery(database, query);
    return { success: result.success, error: result.error };
  }
}
