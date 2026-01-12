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
 */
function formatBigQueryValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return `TIMESTAMP '${value.toISOString()}'`;
  if (Array.isArray(value)) {
    const elements = value.map(v => formatBigQueryValue(v)).join(", ");
    return `[${elements}]`;
  }
  if (typeof value === "object") {
    return `JSON '${JSON.stringify(value).replace(/'/g, "\\'")}'`;
  }
  // String - escape single quotes and backslashes
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export class BigQueryDatabaseDriver implements DatabaseDriver {
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
   * Infer column definitions from sample data
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
      return { success: false, error: "Dataset (schema) is required for BigQuery" };
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
   * Insert a batch of rows into a table using INSERT statement
   * BigQuery has a 10,000 rows per INSERT limit, so we chunk if necessary
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
      return { success: false, rowsWritten: 0, error: "Dataset (schema) is required for BigQuery" };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;

    // Get all unique column names from all rows
    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    const columns = Array.from(allColumns);
    const columnList = columns.map(escapeIdentifier).join(", ");

    // BigQuery INSERT limit is 10,000 rows per statement
    const chunkSize = 5000;
    let totalWritten = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);

      // Build values using SELECT ... UNION ALL pattern for better performance
      const valueRows = chunk.map(row => {
        const values = columns.map(col => {
          const val = row[col];
          return `${formatBigQueryValue(val)} AS ${escapeIdentifier(col)}`;
        });
        return `SELECT ${values.join(", ")}`;
      });

      const query = `INSERT INTO ${fullTableName} (${columnList})\n${valueRows.join("\nUNION ALL\n")};`;

      const result = await this.executeQuery(database, query);

      if (!result.success) {
        return {
          success: false,
          rowsWritten: totalWritten,
          error: result.error,
        };
      }

      totalWritten += chunk.length;
    }

    return { success: true, rowsWritten: totalWritten };
  }

  /**
   * Upsert a batch of rows using MERGE statement
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
      return { success: false, rowsWritten: 0, error: "Key columns required for upsert" };
    }

    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return { success: false, rowsWritten: 0, error: "Dataset (schema) is required for BigQuery" };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;
    const strategy = options?.conflictStrategy || "update";

    // Get all unique column names from all rows
    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    const columns = Array.from(allColumns);

    // Build source data as CTE
    const valueRows = rows.map(row => {
      const values = columns.map(col => {
        const val = row[col];
        return `${formatBigQueryValue(val)} AS ${escapeIdentifier(col)}`;
      });
      return `SELECT ${values.join(", ")}`;
    });

    const sourceQuery = valueRows.join("\nUNION ALL\n");

    // Build MERGE conditions
    const joinConditions = keyColumns
      .map(k => `T.${escapeIdentifier(k)} = S.${escapeIdentifier(k)}`)
      .join(" AND ");

    // Build update and insert columns
    const nonKeyColumns = columns.filter(c => !keyColumns.includes(c));
    const updateClause = nonKeyColumns.length > 0
      ? `UPDATE SET ${nonKeyColumns.map(c => `${escapeIdentifier(c)} = S.${escapeIdentifier(c)}`).join(", ")}`
      : "";
    const insertColumns = columns.map(escapeIdentifier).join(", ");
    const insertValues = columns.map(c => `S.${escapeIdentifier(c)}`).join(", ");

    let query: string;
    if (strategy === "ignore") {
      // Only insert if not matched
      query = `
        MERGE INTO ${fullTableName} T
        USING (${sourceQuery}) S
        ON ${joinConditions}
        WHEN NOT MATCHED THEN
          INSERT (${insertColumns}) VALUES (${insertValues});
      `;
    } else {
      // Update when matched, insert when not matched
      query = `
        MERGE INTO ${fullTableName} T
        USING (${sourceQuery}) S
        ON ${joinConditions}
        ${updateClause ? `WHEN MATCHED THEN ${updateClause}` : ""}
        WHEN NOT MATCHED THEN
          INSERT (${insertColumns}) VALUES (${insertValues});
      `;
    }

    const result = await this.executeQuery(database, query);

    return {
      success: result.success,
      rowsWritten: result.success ? rows.length : 0,
      error: result.error,
    };
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
      return { success: false, error: "Dataset (schema) is required for BigQuery" };
    }

    const fullOriginal = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(stagingTableName)}`;

    // Drop staging table if exists
    const dropResult = await this.executeQuery(database, `DROP TABLE IF EXISTS ${fullStaging};`);
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
      return { success: false, error: "Dataset (schema) is required for BigQuery" };
    }

    const fullOriginal = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(stagingTableName)}`;
    const fullBackup = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(`${originalTableName}_backup_${Date.now()}`)}`;

    // Step 1: Rename original to backup (using CREATE ... AS SELECT and DROP)
    let result = await this.executeQuery(database, `CREATE TABLE ${fullBackup} AS SELECT * FROM ${fullOriginal};`);
    if (!result.success) {
      return { success: false, error: `Failed to backup original: ${result.error}` };
    }

    // Step 2: Drop original
    result = await this.executeQuery(database, `DROP TABLE ${fullOriginal};`);
    if (!result.success) {
      return { success: false, error: `Failed to drop original: ${result.error}` };
    }

    // Step 3: Create new original from staging
    result = await this.executeQuery(database, `CREATE TABLE ${fullOriginal} AS SELECT * FROM ${fullStaging};`);
    if (!result.success) {
      // Try to restore from backup
      await this.executeQuery(database, `CREATE TABLE ${fullOriginal} AS SELECT * FROM ${fullBackup};`);
      return { success: false, error: `Failed to create new table: ${result.error}` };
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
      return { success: false, error: "Dataset (schema) is required for BigQuery" };
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
        error: error instanceof Error ? error.message : "Streaming query failed",
      };
    }
  }
}
