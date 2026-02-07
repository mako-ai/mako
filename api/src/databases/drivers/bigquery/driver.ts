import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
  ColumnDefinition,
  BatchWriteResult,
  InsertOptions,
  UpsertOptions,
  StreamingQueryOptions,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";
import { loggers } from "../../../logging";

/**
 * Map JavaScript types to BigQuery types
 */
function inferBigQueryType(value: unknown): string {
  if (value === null || value === undefined) return "STRING";
  if (typeof value === "boolean") return "BOOL";
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return "INT64";
    }
    return "FLOAT64";
  }
  if (typeof value === "bigint") return "INT64";
  if (value instanceof Date) return "TIMESTAMP";
  if (Array.isArray(value)) {
    // Array type - use first element to determine type
    if (value.length > 0) {
      return `ARRAY<${inferBigQueryType(value[0])}>`;
    }
    return "ARRAY<STRING>";
  }
  if (typeof value === "object") return "JSON";
  if (typeof value === "string") {
    // Try to detect date strings
    if (/^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}:\d{2}/.test(value)) {
      return "TIMESTAMP";
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "DATE";
    }
    return "STRING";
  }
  return "STRING";
}

/**
 * Escape a BigQuery identifier (table name, column name)
 */
function escapeIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "\\`")}\``;
}

/**
 * Format a value for BigQuery insertion
 * @param value - The value to format
 * @param targetType - Optional target column type to cast to (e.g., "STRING", "INT64")
 * @param useCast - If true, wrap value in CAST() to ensure consistent types (for STRUCT arrays)
 */
function formatBigQueryValue(
  value: unknown,
  targetType?: string,
  useCast = false,
): string {
  // For useCast mode (STRUCT arrays in MERGE/INSERT), NULL must be typed to avoid
  // BigQuery defaulting to INT64 and causing "Array elements of types do not have
  // a common supertype" errors when mixed with other typed values
  if (value === null || value === undefined) {
    if (useCast && targetType) {
      return `CAST(NULL AS ${targetType.toUpperCase()})`;
    }
    return "NULL";
  }

  const upperType = targetType?.toUpperCase();
  const isNumericTarget =
    upperType === "INT64" ||
    upperType === "INTEGER" ||
    upperType === "FLOAT64" ||
    upperType === "FLOAT" ||
    upperType === "NUMERIC" ||
    upperType === "BIGNUMERIC";

  // When useCast is true (for STRUCT arrays in MERGE), we need to ensure ALL values
  // are formatted consistently to avoid "Array elements of types do not have a common supertype"
  // We do this by always formatting as string and casting to target type
  if (useCast && targetType) {
    // First, format the value as a plain string literal
    let stringValue: string;

    if (typeof value === "boolean") {
      stringValue = value ? "true" : "false";
    } else if (value instanceof Date) {
      stringValue = value.toISOString();
    } else if (Array.isArray(value)) {
      // Arrays need special handling - format each element and wrap in CAST
      const elements = value
        .map(v => formatBigQueryValue(v, undefined, false))
        .join(", ");
      return `[${elements}]`;
    } else if (typeof value === "object") {
      stringValue = JSON.stringify(value).replace(/'/g, "\\'");
      // JSON columns: use JSON literal syntax
      if (upperType === "JSON") {
        return `JSON '${stringValue}'`;
      }
    } else {
      stringValue = String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    }

    // Use SAFE_CAST for type conversion to handle mismatched data gracefully
    // This ensures all STRUCTs have consistent schema
    if (isNumericTarget) {
      return `SAFE_CAST('${stringValue}' AS ${upperType})`;
    } else if (upperType === "BOOL" || upperType === "BOOLEAN") {
      // BigQuery SAFE_CAST doesn't handle 'true'/'false' strings well for BOOL
      // Use explicit CASE for boolean conversion
      const lower = stringValue.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") return "TRUE";
      if (lower === "false" || lower === "0" || lower === "no") return "FALSE";
      return `SAFE_CAST('${stringValue}' AS BOOL)`;
    } else if (upperType === "TIMESTAMP" || upperType === "DATETIME") {
      // If the value is a numeric Unix timestamp (seconds or milliseconds),
      // convert to ISO string first since SAFE_CAST can't parse numeric strings
      const numericValue = Number(stringValue);
      if (!isNaN(numericValue) && stringValue.trim() !== "") {
        // Timestamps > 1e12 are in milliseconds, otherwise seconds
        const ms = numericValue > 1e12 ? numericValue : numericValue * 1000;
        const date = new Date(ms);
        if (!isNaN(date.getTime())) {
          stringValue = date.toISOString();
        }
      }
      return `SAFE_CAST('${stringValue}' AS TIMESTAMP)`;
    } else if (upperType === "DATE") {
      // If the value is a numeric Unix timestamp, convert to date string
      const numericValue = Number(stringValue);
      if (!isNaN(numericValue) && stringValue.trim() !== "") {
        const ms = numericValue > 1e12 ? numericValue : numericValue * 1000;
        const date = new Date(ms);
        if (!isNaN(date.getTime())) {
          stringValue = date.toISOString();
        }
      }
      return `SAFE_CAST('${stringValue.slice(0, 10)}' AS DATE)`;
    } else if (upperType === "STRING") {
      return `CAST('${stringValue}' AS STRING)`;
    } else {
      return `SAFE_CAST('${stringValue}' AS ${upperType})`;
    }
  }

  // Non-CAST mode (for VALUES clause in INSERT, which handles types per-row)
  // Handle numbers: ONLY unquote if we have EXPLICIT numeric target type
  // When targetType is undefined/unknown, ALWAYS quote (safer default)
  if (typeof value === "number" || typeof value === "bigint") {
    // Only output unquoted number if we're 100% sure target is numeric
    if (targetType && isNumericTarget) {
      return String(value);
    }
    // For STRING, unknown, or ANY other case: quote the number
    return `'${String(value)}'`;
  }

  // Handle booleans
  if (typeof value === "boolean") {
    if (upperType === "BOOL" || upperType === "BOOLEAN") {
      return value ? "TRUE" : "FALSE";
    }
    // For STRING or unknown, quote it
    return value ? "'true'" : "'false'";
  }

  // Handle dates
  if (value instanceof Date) {
    if (upperType === "DATE") {
      return `DATE '${value.toISOString().slice(0, 10)}'`;
    }
    if (upperType === "TIMESTAMP" || upperType === "DATETIME" || !upperType) {
      return `TIMESTAMP '${value.toISOString()}'`;
    }
    // For STRING target, quote the ISO string
    return `'${value.toISOString()}'`;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    const elements = value
      .map(v => formatBigQueryValue(v, undefined, false))
      .join(", ");
    return `[${elements}]`;
  }

  // Handle objects (JSON)
  if (typeof value === "object") {
    const jsonStr = JSON.stringify(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    if (upperType === "JSON") {
      return `JSON '${jsonStr}'`;
    }
    // For STRING or unknown, just quote the JSON string
    return `'${jsonStr}'`;
  }

  // Handle strings
  const strVal = String(value);
  const escapedStr = strVal.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  // If target is TIMESTAMP, wrap with TIMESTAMP keyword
  if (upperType === "TIMESTAMP" || upperType === "DATETIME") {
    return `TIMESTAMP '${escapedStr}'`;
  }

  // If target is DATE, extract date part and wrap
  if (upperType === "DATE") {
    return `DATE '${escapedStr.slice(0, 10)}'`;
  }

  // If target is numeric, try to parse string as number
  if (isNumericTarget) {
    const parsed = parseFloat(strVal);
    if (!isNaN(parsed)) return String(parsed);
  }

  // If target is BOOL, try to parse string as boolean
  if (upperType === "BOOL" || upperType === "BOOLEAN") {
    const lower = strVal.toLowerCase();
    if (lower === "true" || lower === "1") return "TRUE";
    if (lower === "false" || lower === "0") return "FALSE";
  }

  // Default: quoted string
  return `'${escapedStr}'`;
}

export class BigQueryDatabaseDriver implements DatabaseDriver {
  private logger = loggers.db("bigquery");
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
    const datasets =
      await databaseConnectionService.listBigQueryDatasets(database);
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
    const items = await databaseConnectionService.listBigQueryTables(
      database,
      datasetId,
    );
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
    options?: any,
  ) {
    return databaseConnectionService.executeQuery(database, query, options);
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<Record<string, any>> {
    return databaseConnectionService.getBigQuerySchema(database);
  }

  // ============ WRITE CAPABILITIES ============

  supportsWrites(): boolean {
    return true;
  }

  /**
   * Get the project ID from the database connection
   */
  private getProjectId(database: IDatabaseConnection): string {
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
    const result = await databaseConnectionService.getBigQueryQuerySchema(
      database,
      query,
    );

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
   * @deprecated Prefer getQuerySchema() which is more reliable
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
          columnTypes.get(key)!.add(inferBigQueryType(value));
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
   * Create a table with the given schema
   * In BigQuery, schema = dataset
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

    const columnDefs = columns.map(col => {
      let def = `${escapeIdentifier(col.name)} ${col.type}`;
      if (!col.nullable) def += " NOT NULL";
      return def;
    });

    const query = `CREATE TABLE IF NOT EXISTS ${fullTableName} (\n  ${columnDefs.join(",\n  ")}\n);`;

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
      WHERE table_name = '${tableName.replace(/'/g, "\\'")}'
    `;

    const result = await this.executeQuery(database, query);
    if (!result.success || !result.data) return false;
    return (result.data[0]?.cnt ?? 0) > 0;
  }

  /**
   * Get column types for an existing table from INFORMATION_SCHEMA
   * Returns a map of column name -> BigQuery data type
   */
  private async getTableColumnTypes(
    database: IDatabaseConnection,
    tableName: string,
    dataset: string,
  ): Promise<Map<string, string>> {
    const projectId = this.getProjectId(database);
    const columnTypes = new Map<string, string>();

    const query = `
      SELECT column_name, data_type
      FROM ${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.INFORMATION_SCHEMA.COLUMNS
      WHERE table_name = '${tableName.replace(/'/g, "\\'")}'
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
   * Insert a batch of rows into a table using INSERT statement
   * BigQuery has a 1MB query size limit, so we chunk adaptively based on query size
   */
  async insertBatch(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    options?: InsertOptions,
  ): Promise<BatchWriteResult> {
    if (rows.length === 0) {
      return { success: true, rowsWritten: 0 };
    }

    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;

    // ALWAYS get column types from INFORMATION_SCHEMA for existing tables
    // This is more reliable than passed types which come from source schema mapping
    // and may not match the actual destination table schema
    const columnTypes = await this.getTableColumnTypes(
      database,
      tableName,
      dataset,
    );

    // Get all unique column names from all rows
    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    const columns = Array.from(allColumns);
    const columnList = columns.map(escapeIdentifier).join(", ");

    // Start with a reasonable chunk size, will adapt based on query size
    // BigQuery has a 1MB (1,024,000 chars) query limit
    const MAX_QUERY_SIZE = 900_000; // Leave some buffer below 1MB
    let chunkSize = 1000; // Start smaller to be safe
    let totalWritten = 0;

    for (let i = 0; i < rows.length; ) {
      // Build query for current chunk using VALUES syntax (more compact than SELECT...UNION ALL)
      let chunk = rows.slice(i, i + chunkSize);
      let query = this.buildInsertQuery(
        fullTableName,
        columnList,
        columns,
        chunk,
        columnTypes,
      );

      // If query is too large, reduce chunk size and retry
      while (query.length > MAX_QUERY_SIZE && chunkSize > 50) {
        chunkSize = Math.floor(chunkSize / 2);
        chunk = rows.slice(i, i + chunkSize);
        query = this.buildInsertQuery(
          fullTableName,
          columnList,
          columns,
          chunk,
          columnTypes,
        );
      }

      // If still too large with minimum chunk size, fail with helpful error
      if (query.length > MAX_QUERY_SIZE) {
        return {
          success: false,
          rowsWritten: totalWritten,
          error: `Query size (${Math.round(query.length / 1024)}KB) exceeds BigQuery limit even with minimum batch size. Consider reducing data size per row or using BigQuery load jobs for very large data.`,
        };
      }

      const result = await this.executeQuery(database, query);

      if (!result.success) {
        const preview =
          rows.length > 0 ? JSON.stringify(rows[0]).slice(0, 1000) : "{}";
        this.logger.error("BigQuery insert failed", {
          table: tableName,
          dataset,
          error: result.error,
          queryPreview: query.slice(0, 2000),
          firstRowPreview: preview,
          columnTypes: Object.fromEntries(columnTypes.entries()),
        });
        return {
          success: false,
          rowsWritten: totalWritten,
          error: result.error,
        };
      }

      totalWritten += chunk.length;
      i += chunk.length;

      // If query was well under the limit, try increasing chunk size for efficiency
      if (query.length < MAX_QUERY_SIZE * 0.5 && chunkSize < 2000) {
        chunkSize = Math.min(chunkSize * 2, 2000);
      }
    }

    return { success: true, rowsWritten: totalWritten };
  }

  /**
   * Build an INSERT query using VALUES syntax (more compact than SELECT...UNION ALL)
   * @param columnTypes - Optional map of column name -> BigQuery type for type coercion
   */
  private buildInsertQuery(
    fullTableName: string,
    columnList: string,
    columns: string[],
    rows: Record<string, unknown>[],
    columnTypes?: Map<string, string>,
  ): string {
    // Use VALUES syntax: INSERT INTO table (cols) VALUES (v1, v2), (v1, v2), ...
    const valueRows = rows.map(row => {
      const values = columns.map(col => {
        // Use lowercase for case-insensitive lookup
        const targetType = columnTypes?.get(col.toLowerCase());
        return formatBigQueryValue(row[col], targetType, true);
      });
      return `(${values.join(", ")})`;
    });

    return `INSERT INTO ${fullTableName} (${columnList}) VALUES\n${valueRows.join(",\n")};`;
  }

  /**
   * Upsert a batch of rows using MERGE statement
   * Chunks data adaptively to stay under BigQuery's 1MB query limit
   */
  async upsertBatch(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    keyColumns: string[],
    options?: UpsertOptions,
  ): Promise<BatchWriteResult> {
    if (rows.length === 0) {
      return { success: true, rowsWritten: 0 };
    }

    if (keyColumns.length === 0) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Key columns required for upsert",
      };
    }

    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;
    const strategy = options?.conflictStrategy || "update";

    // ALWAYS get column types from INFORMATION_SCHEMA for existing tables
    // This is more reliable than passed types which come from source schema mapping
    // and may not match the actual destination table schema
    const columnTypes = await this.getTableColumnTypes(
      database,
      tableName,
      dataset,
    );

    // Get all unique column names from all rows
    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    const columns = Array.from(allColumns);

    // BigQuery has a 1MB (1,024,000 chars) query limit
    const MAX_QUERY_SIZE = 900_000; // Leave some buffer below 1MB
    let chunkSize = 500; // MERGE is more verbose, start smaller
    let totalWritten = 0;

    for (let i = 0; i < rows.length; ) {
      // Build MERGE query for current chunk
      let chunk = rows.slice(i, i + chunkSize);
      let query = this.buildMergeQuery(
        fullTableName,
        columns,
        chunk,
        keyColumns,
        strategy,
        columnTypes,
      );

      // If query is too large, reduce chunk size and retry
      while (query.length > MAX_QUERY_SIZE && chunkSize > 25) {
        chunkSize = Math.floor(chunkSize / 2);
        chunk = rows.slice(i, i + chunkSize);
        query = this.buildMergeQuery(
          fullTableName,
          columns,
          chunk,
          keyColumns,
          strategy,
          columnTypes,
        );
      }

      // If still too large with minimum chunk size, fail with helpful error
      if (query.length > MAX_QUERY_SIZE) {
        return {
          success: false,
          rowsWritten: totalWritten,
          error: `MERGE query size (${Math.round(query.length / 1024)}KB) exceeds BigQuery limit even with minimum batch size. Consider reducing data size per row.`,
        };
      }

      const result = await this.executeQuery(database, query);

      if (!result.success) {
        const preview =
          rows.length > 0 ? JSON.stringify(rows[0]).slice(0, 1000) : "{}";
        this.logger.error("BigQuery merge failed", {
          table: tableName,
          dataset,
          error: result.error,
          queryPreview: query.slice(0, 2000),
          firstRowPreview: preview,
          columnTypes: Object.fromEntries(columnTypes.entries()),
        });
        return {
          success: false,
          rowsWritten: totalWritten,
          error: result.error,
        };
      }

      totalWritten += chunk.length;
      i += chunk.length;

      // If query was well under the limit, try increasing chunk size for efficiency
      if (query.length < MAX_QUERY_SIZE * 0.5 && chunkSize < 1000) {
        chunkSize = Math.min(chunkSize * 2, 1000);
      }
    }

    return { success: true, rowsWritten: totalWritten };
  }

  /**
   * Build a MERGE query using a more compact source format
   * Uses UNNEST with STRUCT array for better efficiency than SELECT...UNION ALL
   * @param columnTypes - Optional map of column name -> BigQuery type for type coercion
   *
   * IMPORTANT: We use SAFE_CAST for all values in STRUCTs to ensure consistent types.
   * Without this, if source data has mixed types (e.g., template_id is INT64 in one row
   * and STRING in another), BigQuery throws "Array elements of types do not have a
   * common supertype" because each STRUCT would have a different schema.
   */
  private buildMergeQuery(
    fullTableName: string,
    columns: string[],
    rows: Record<string, unknown>[],
    keyColumns: string[],
    strategy: string,
    columnTypes?: Map<string, string>,
  ): string {
    // Build source data using UNNEST with STRUCT - more compact than SELECT...UNION ALL
    // Format: UNNEST([STRUCT(v1 AS c1, v2 AS c2), STRUCT(v1 AS c1, v2 AS c2), ...])
    // We use useCast=true to ensure all STRUCTs have consistent column types via SAFE_CAST
    const structRows = rows.map(row => {
      const values = columns.map(col => {
        // Use lowercase for case-insensitive lookup
        const targetType = columnTypes?.get(col.toLowerCase());
        // useCast=true ensures consistent types across all STRUCTs in the array
        return `${formatBigQueryValue(row[col], targetType, true)} AS ${escapeIdentifier(col)}`;
      });
      return `STRUCT(${values.join(", ")})`;
    });

    const sourceQuery = `UNNEST([${structRows.join(", ")}])`;

    // Build MERGE conditions
    const joinConditions = keyColumns
      .map(k => `T.${escapeIdentifier(k)} = S.${escapeIdentifier(k)}`)
      .join(" AND ");

    // Build update and insert columns
    const nonKeyColumns = columns.filter(c => !keyColumns.includes(c));
    const updateClause =
      nonKeyColumns.length > 0
        ? `UPDATE SET ${nonKeyColumns.map(c => `${escapeIdentifier(c)} = S.${escapeIdentifier(c)}`).join(", ")}`
        : "";
    const insertColumns = columns.map(escapeIdentifier).join(", ");
    const insertValues = columns
      .map(c => `S.${escapeIdentifier(c)}`)
      .join(", ");

    if (strategy === "ignore") {
      // Only insert if not matched
      return `
        MERGE INTO ${fullTableName} T
        USING ${sourceQuery} AS S
        ON ${joinConditions}
        WHEN NOT MATCHED THEN
          INSERT (${insertColumns}) VALUES (${insertValues});
      `;
    } else {
      // Update when matched, insert when not matched
      return `
        MERGE INTO ${fullTableName} T
        USING ${sourceQuery} AS S
        ON ${joinConditions}
        ${updateClause ? `WHEN MATCHED THEN ${updateClause}` : ""}
        WHEN NOT MATCHED THEN
          INSERT (${insertColumns}) VALUES (${insertValues});
      `;
    }
  }

  /**
   * Create a staging table (copy of original table structure)
   */
  async createStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
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

    const fullOriginal = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(stagingTableName)}`;

    // Drop staging table if exists
    const dropResult = await this.executeQuery(
      database,
      `DROP TABLE IF EXISTS ${fullStaging};`,
    );
    if (!dropResult.success) {
      return { success: false, error: dropResult.error };
    }

    // Create staging table with same schema as original
    const query = `CREATE TABLE ${fullStaging} AS SELECT * FROM ${fullOriginal} WHERE FALSE;`;
    const result = await this.executeQuery(database, query);

    return { success: result.success, error: result.error };
  }

  /**
   * Swap staging table with original
   * BigQuery doesn't support RENAME, so we use copy and delete
   */
  async swapStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
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

    const fullOriginal = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(stagingTableName)}`;
    const fullBackup = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(`${originalTableName}_backup_${Date.now()}`)}`;

    // Step 1: Rename original to backup (using CREATE ... AS SELECT and DROP)
    let result = await this.executeQuery(
      database,
      `CREATE TABLE ${fullBackup} AS SELECT * FROM ${fullOriginal};`,
    );
    if (!result.success) {
      return {
        success: false,
        error: `Failed to backup original: ${result.error}`,
      };
    }

    // Step 2: Drop original
    result = await this.executeQuery(database, `DROP TABLE ${fullOriginal};`);
    if (!result.success) {
      return {
        success: false,
        error: `Failed to drop original: ${result.error}`,
      };
    }

    // Step 3: Create new original from staging
    result = await this.executeQuery(
      database,
      `CREATE TABLE ${fullOriginal} AS SELECT * FROM ${fullStaging};`,
    );
    if (!result.success) {
      // Try to restore from backup
      await this.executeQuery(
        database,
        `CREATE TABLE ${fullOriginal} AS SELECT * FROM ${fullBackup};`,
      );
      return {
        success: false,
        error: `Failed to create new table: ${result.error}`,
      };
    }

    // Step 4: Drop staging and backup
    await this.executeQuery(database, `DROP TABLE IF EXISTS ${fullStaging};`);
    await this.executeQuery(database, `DROP TABLE IF EXISTS ${fullBackup};`);

    return { success: true };
  }

  /**
   * Drop a table
   */
  async dropTable(
    database: IDatabaseConnection,
    tableName: string,
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

    const query = `DROP TABLE IF EXISTS ${fullTableName};`;
    const result = await this.executeQuery(database, query);

    return { success: result.success, error: result.error };
  }

  /**
   * Execute a streaming query with batched callbacks
   * Uses LIMIT/OFFSET pagination for BigQuery
   */
  async executeStreamingQuery(
    database: IDatabaseConnection,
    query: string,
    options: StreamingQueryOptions,
  ): Promise<{ success: boolean; totalRows: number; error?: string }> {
    const batchSize = options.batchSize || 10000; // BigQuery can handle larger batches
    let totalRows = 0;

    try {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        // Check for cancellation
        if (options.signal?.aborted) {
          return { success: false, totalRows, error: "Query cancelled" };
        }

        // Add LIMIT/OFFSET to query
        const paginatedQuery = `${query.replace(/;?\s*$/, "")} LIMIT ${batchSize} OFFSET ${offset};`;

        const result = await this.executeQuery(database, paginatedQuery);

        if (!result.success) {
          return { success: false, totalRows, error: result.error };
        }

        const rows = result.data || [];
        if (rows.length === 0) {
          hasMore = false;
        } else {
          await options.onBatch(rows);
          totalRows += rows.length;
          offset += rows.length;

          // If we got fewer rows than batch size, we're done
          if (rows.length < batchSize) {
            hasMore = false;
          }
        }
      }

      return { success: true, totalRows };
    } catch (error) {
      return {
        success: false,
        totalRows,
        error:
          error instanceof Error ? error.message : "Streaming query failed",
      };
    }
  }
}
