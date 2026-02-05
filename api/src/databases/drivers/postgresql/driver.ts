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

const logger = loggers.db("postgresql");

/**
 * Map PostgreSQL OID (dataTypeID) to type name
 * Common OIDs from PostgreSQL's pg_type catalog
 * See: https://www.postgresql.org/docs/current/datatype.html
 */
function mapPostgresOidToType(oid: number): string {
  const oidMap: Record<number, string> = {
    // Boolean
    16: "BOOLEAN",
    // Numeric
    20: "BIGINT",
    21: "SMALLINT",
    23: "INTEGER",
    26: "OID",
    700: "REAL",
    701: "DOUBLE PRECISION",
    1700: "NUMERIC",
    // Character
    18: "CHAR",
    25: "TEXT",
    1042: "CHAR",
    1043: "VARCHAR",
    // Binary
    17: "BYTEA",
    // Date/Time
    1082: "DATE",
    1083: "TIME",
    1114: "TIMESTAMP",
    1184: "TIMESTAMPTZ",
    1186: "INTERVAL",
    1266: "TIMETZ",
    // UUID
    2950: "UUID",
    // JSON
    114: "JSON",
    3802: "JSONB",
    // Arrays (common)
    1000: "BOOLEAN[]",
    1005: "SMALLINT[]",
    1007: "INTEGER[]",
    1016: "BIGINT[]",
    1009: "TEXT[]",
    1015: "VARCHAR[]",
    1021: "REAL[]",
    1022: "DOUBLE PRECISION[]",
    // Network
    869: "INET",
    650: "CIDR",
    829: "MACADDR",
    // Geometric
    600: "POINT",
    601: "LSEG",
    602: "PATH",
    603: "BOX",
    604: "POLYGON",
    628: "LINE",
    718: "CIRCLE",
    // Other
    2249: "RECORD",
    2287: "RECORD[]",
    3904: "INT4RANGE",
    3906: "INT8RANGE",
    3908: "NUMRANGE",
    3912: "DATERANGE",
    3910: "TSRANGE",
    3914: "TSTZRANGE",
  };
  return oidMap[oid] || "TEXT";
}

/**
 * Map JavaScript types to PostgreSQL types
 */
function inferPostgresType(value: unknown): string {
  if (value === null || value === undefined) return "TEXT";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      if (value > 2147483647 || value < -2147483648) return "BIGINT";
      return "INTEGER";
    }
    return "DOUBLE PRECISION";
  }
  if (typeof value === "bigint") return "BIGINT";
  if (value instanceof Date) return "TIMESTAMPTZ";
  if (typeof value === "object") return "JSONB";
  if (typeof value === "string") {
    // Try to detect date strings
    if (/^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}:\d{2}/.test(value)) {
      return "TIMESTAMPTZ";
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "DATE";
    }
    // Check for UUID
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      return "UUID";
    }
    return "TEXT";
  }
  return "TEXT";
}

/**
 * Escape a PostgreSQL identifier (table name, column name)
 */
function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Format a value for PostgreSQL insertion
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  // String - escape single quotes
  return `'${String(value).replace(/'/g, "''")}'`;
}

export class PostgreSQLDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "postgresql",
      displayName: "PostgreSQL",
      consoleLanguage: "sql",
    } as any;
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    // Single Database Mode
    if (database.connection.database) {
      const dbName = database.connection.database;
      return [
        {
          id: dbName,
          label: dbName,
          kind: "database",
          hasChildren: true,
          metadata: { databaseId: dbName, databaseName: dbName },
        },
      ];
    }

    // Cluster Mode: List all databases
    try {
      const result = await this.executeQuery(
        database,
        `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;`,
      );
      if (!result.success) return [];

      const rows: Array<{ datname: string }> = result.data || [];
      return rows.map<DatabaseTreeNode>(r => ({
        id: r.datname,
        label: r.datname,
        kind: "database",
        hasChildren: true,
        metadata: { databaseId: r.datname, databaseName: r.datname },
      }));
    } catch (error) {
      logger.error("Error listing databases in cluster mode", { error });
      return [];
    }
  }

  private async listSchemas(
    database: IDatabaseConnection,
    dbName?: string,
  ): Promise<DatabaseTreeNode[]> {
    const result = await this.executeQuery(
      database,
      `SELECT schema_name FROM information_schema.schemata ORDER BY schema_name;`,
      { databaseName: dbName },
    );
    if (!result.success) return [];

    const systemSchemas: Record<string, true> = {
      information_schema: true,
      pg_catalog: true,
      pg_toast: true,
      pg_temp_1: true,
      pg_toast_temp_1: true,
    };

    const rows: Array<{ schema_name: string }> = result.data || [];
    return rows
      .map(r => r.schema_name)
      .filter(s => !systemSchemas[s])
      .sort((a, b) => a.localeCompare(b))
      .map<DatabaseTreeNode>(schema => ({
        id: dbName ? `${dbName}.${schema}` : schema,
        label: schema,
        kind: "schema",
        hasChildren: true,
        metadata: { schema, databaseId: dbName, databaseName: dbName },
      }));
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    // Expanding a Database Node (Cluster Mode)
    if (parent.kind === "database") {
      const dbName =
        parent.metadata?.databaseName || parent.metadata?.databaseId;
      return this.listSchemas(database, dbName);
    }

    if (parent.kind !== "schema") return [];

    const schema = parent.metadata?.schema || parent.id;
    const dbName = parent.metadata?.databaseName || parent.metadata?.databaseId;
    const safeSchema = String(schema).replace(/'/g, "''");

    const result = await this.executeQuery(
      database,
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = '${safeSchema}' ORDER BY table_name;`,
      { databaseName: dbName },
    );

    if (!result.success) return [];
    const rows: Array<{ table_name: string; table_type: string }> =
      result.data || [];
    return rows.map<DatabaseTreeNode>(r => ({
      id: `${dbName ? dbName + "." : ""}${schema}.${r.table_name}`,
      label: r.table_name,
      kind: r.table_type === "VIEW" ? "view" : "table",
      hasChildren: false,
      metadata: {
        schema,
        table: r.table_name,
        databaseId: dbName,
        databaseName: dbName,
      },
    }));
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    const result = await this.executeQuery(
      database,
      `SELECT table_schema, table_name, column_name, data_type 
       FROM information_schema.columns 
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
       ORDER BY table_schema, table_name, ordinal_position;`,
    );

    if (!result.success || !result.data) {
      return {};
    }

    const schema: Record<
      string,
      Record<string, Array<{ name: string; type: string }>>
    > = {};

    for (const row of result.data) {
      const { table_schema, table_name, column_name, data_type } = row;

      if (!schema[table_schema]) {
        schema[table_schema] = {};
      }
      if (!schema[table_schema][table_name]) {
        schema[table_schema][table_name] = [];
      }

      schema[table_schema][table_name].push({
        name: column_name,
        type: data_type,
      });
    }

    return schema;
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseName?: string; databaseId?: string },
  ) {
    return databaseConnectionService.executeQuery(database, query, options);
  }

  // ============ WRITE CAPABILITIES ============

  supportsWrites(): boolean {
    return true;
  }

  /**
   * Get the schema (column types) for a query using PostgreSQL's metadata.
   *
   * PostgreSQL returns column metadata (OIDs) even for empty result sets,
   * making this more reliable than inferring from sample data.
   */
  async getQuerySchema(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseName?: string },
  ): Promise<{
    success: boolean;
    columns?: ColumnDefinition[];
    error?: string;
  }> {
    try {
      // LIMIT 0 gives us column metadata without fetching any data
      const schemaQuery = `SELECT * FROM (${query}) AS _schema_query LIMIT 0`;

      const result = await databaseConnectionService.executeQuery(
        database,
        schemaQuery,
        { databaseName: options?.databaseName },
      );

      if (!result.success) {
        return { success: false, error: result.error };
      }

      // PostgreSQL's pg library returns field metadata with OIDs
      const fields = result.fields || [];

      if (fields.length > 0) {
        // Map PostgreSQL OIDs to type names
        const columns: ColumnDefinition[] = fields.map((field: any) => ({
          name: field.name,
          type: mapPostgresOidToType(field.dataTypeID),
          nullable: true,
        }));
        return { success: true, columns };
      }

      // Fallback: try with LIMIT 1 and infer from data
      const sampleQuery = `SELECT * FROM (${query}) AS _schema_query LIMIT 1`;
      const sampleResult = await databaseConnectionService.executeQuery(
        database,
        sampleQuery,
        { databaseName: options?.databaseName },
      );

      if (!sampleResult.success) {
        return { success: false, error: sampleResult.error };
      }

      // Check fields again from sample query
      if (sampleResult.fields && sampleResult.fields.length > 0) {
        const columns: ColumnDefinition[] = sampleResult.fields.map(
          (field: any) => ({
            name: field.name,
            type: mapPostgresOidToType(field.dataTypeID),
            nullable: true,
          }),
        );
        return { success: true, columns };
      }

      // Last resort: infer from data values
      const rows = sampleResult.data || [];
      if (rows.length === 0) {
        return {
          success: false,
          error: "Query returned no rows and no field metadata",
        };
      }

      const sampleRow = rows[0];
      const columns: ColumnDefinition[] = Object.entries(sampleRow).map(
        ([name, value]) => ({
          name,
          type: inferPostgresType(value),
          nullable: true,
        }),
      );

      return { success: true, columns };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || "Failed to get query schema",
      };
    }
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
          columnTypes.get(key)!.add(inferPostgresType(value));
        }
      }
    }

    // Build column definitions
    const columns: ColumnDefinition[] = [];
    for (const [name, types] of columnTypes) {
      // If multiple types detected, use TEXT as fallback
      let type = "TEXT";
      const typeArray = Array.from(types);
      if (typeArray.length === 1) {
        type = typeArray[0];
      } else if (typeArray.length > 1) {
        // Try to find a common type
        if (
          typeArray.every(t =>
            ["INTEGER", "BIGINT", "DOUBLE PRECISION"].includes(t),
          )
        ) {
          type = "DOUBLE PRECISION";
        } else if (typeArray.every(t => ["INTEGER", "BIGINT"].includes(t))) {
          type = "BIGINT";
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
   */
  async createTable(
    database: IDatabaseConnection,
    tableName: string,
    columns: ColumnDefinition[],
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const schema = options?.schema || "public";
    const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(tableName)}`;

    const columnDefs = columns.map(col => {
      let def = `${escapeIdentifier(col.name)} ${col.type}`;
      if (col.primaryKey) def += " PRIMARY KEY";
      if (!col.nullable && !col.primaryKey) def += " NOT NULL";
      return def;
    });

    const query = `CREATE TABLE IF NOT EXISTS ${fullTableName} (\n  ${columnDefs.join(",\n  ")}\n);`;

    const result = await this.executeQuery(database, query, {
      databaseName: options?.schema ? undefined : database.connection.database,
    });

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
    const schema = options?.schema || "public";
    const query = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = '${schema.replace(/'/g, "''")}'
        AND table_name = '${tableName.replace(/'/g, "''")}'
      );
    `;

    const result = await this.executeQuery(database, query);
    if (!result.success || !result.data) return false;
    return result.data[0]?.exists === true;
  }

  /**
   * Insert a batch of rows into a table
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

    const schema = options?.schema || "public";
    const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(tableName)}`;

    // Get all unique column names from all rows
    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    const columns = Array.from(allColumns);
    const columnList = columns.map(escapeIdentifier).join(", ");

    // Build values
    const valueRows = rows.map(row => {
      const values = columns.map(col => formatValue(row[col]));
      return `(${values.join(", ")})`;
    });

    const query = `INSERT INTO ${fullTableName} (${columnList}) VALUES\n${valueRows.join(",\n")};`;

    const result = await this.executeQuery(database, query);

    return {
      success: result.success,
      rowsWritten: result.success ? rows.length : 0,
      error: result.error,
    };
  }

  /**
   * Upsert a batch of rows into a table
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

    const schema = options?.schema || "public";
    const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(tableName)}`;
    const strategy = options?.conflictStrategy || "update";

    // Get all unique column names from all rows
    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    const columns = Array.from(allColumns);
    const columnList = columns.map(escapeIdentifier).join(", ");

    // Build values
    const valueRows = rows.map(row => {
      const values = columns.map(col => formatValue(row[col]));
      return `(${values.join(", ")})`;
    });

    // Build conflict clause
    const keyColumnList = keyColumns.map(escapeIdentifier).join(", ");
    let conflictClause: string;

    if (strategy === "ignore") {
      conflictClause = `ON CONFLICT (${keyColumnList}) DO NOTHING`;
    } else if (strategy === "replace") {
      // Update all columns on conflict
      const updateCols = columns
        .filter(c => !keyColumns.includes(c))
        .map(c => `${escapeIdentifier(c)} = EXCLUDED.${escapeIdentifier(c)}`)
        .join(", ");
      conflictClause = updateCols
        ? `ON CONFLICT (${keyColumnList}) DO UPDATE SET ${updateCols}`
        : "ON CONFLICT DO NOTHING";
    } else {
      // Default: update
      const updateCols = columns
        .filter(c => !keyColumns.includes(c))
        .map(c => `${escapeIdentifier(c)} = EXCLUDED.${escapeIdentifier(c)}`)
        .join(", ");
      conflictClause = updateCols
        ? `ON CONFLICT (${keyColumnList}) DO UPDATE SET ${updateCols}`
        : "ON CONFLICT DO NOTHING";
    }

    const query = `INSERT INTO ${fullTableName} (${columnList}) VALUES\n${valueRows.join(",\n")}\n${conflictClause};`;

    const result = await this.executeQuery(database, query);

    return {
      success: result.success,
      rowsWritten: result.success ? rows.length : 0,
      error: result.error,
    };
  }

  /**
   * Create a staging table (clone of original table structure)
   */
  async createStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const schema = options?.schema || "public";
    const fullOriginal = `${escapeIdentifier(schema)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(schema)}.${escapeIdentifier(stagingTableName)}`;

    // Drop staging table if exists, then create as copy of original structure
    const dropQuery = `DROP TABLE IF EXISTS ${fullStaging};`;
    const createQuery = `CREATE TABLE ${fullStaging} (LIKE ${fullOriginal} INCLUDING ALL);`;

    let result = await this.executeQuery(database, dropQuery);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    result = await this.executeQuery(database, createQuery);
    return { success: result.success, error: result.error };
  }

  /**
   * Swap staging table with original (atomic via transaction)
   */
  async swapStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const schema = options?.schema || "public";
    const fullOriginal = `${escapeIdentifier(schema)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(schema)}.${escapeIdentifier(stagingTableName)}`;
    const backupSuffix = `${originalTableName}_old_${Date.now()}`;
    const tempName = `${escapeIdentifier(schema)}.${escapeIdentifier(backupSuffix)}`;

    // Atomic swap using transaction
    const query = `
      BEGIN;
      ALTER TABLE IF EXISTS ${fullOriginal} RENAME TO ${escapeIdentifier(backupSuffix)};
      ALTER TABLE ${fullStaging} RENAME TO ${escapeIdentifier(originalTableName)};
      DROP TABLE IF EXISTS ${tempName};
      COMMIT;
    `;

    const result = await this.executeQuery(database, query);
    return { success: result.success, error: result.error };
  }

  /**
   * Drop a table
   */
  async dropTable(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const schema = options?.schema || "public";
    const fullTableName = `${escapeIdentifier(schema)}.${escapeIdentifier(tableName)}`;

    const query = `DROP TABLE IF EXISTS ${fullTableName};`;
    const result = await this.executeQuery(database, query);

    return { success: result.success, error: result.error };
  }

  /**
   * Execute a streaming query with batched callbacks
   * Uses CURSOR for memory-efficient large result set handling
   */
  async executeStreamingQuery(
    database: IDatabaseConnection,
    query: string,
    options: StreamingQueryOptions,
  ): Promise<{ success: boolean; totalRows: number; error?: string }> {
    const batchSize = options.batchSize || 1000;
    let totalRows = 0;

    try {
      // For PostgreSQL, we use LIMIT/OFFSET based streaming
      // because cursors require a single transaction and connection
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        // Check for cancellation
        if (options.signal?.aborted) {
          return { success: false, totalRows, error: "Query cancelled" };
        }

        // Add LIMIT/OFFSET to query
        const paginatedQuery = `${query.replace(/;?\s*$/, "")} LIMIT ${batchSize} OFFSET ${offset};`;

        const result = await this.executeQuery(database, paginatedQuery, {
          databaseName: options.databaseName,
        });

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
