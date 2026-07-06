import {
  BatchWriteResult,
  ColumnDefinition,
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
  InsertOptions,
  UpsertOptions,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";
import { loggers } from "../../../logging";
import {
  buildCreateTableSql,
  buildDeleteSql,
  buildInsertSql,
  buildUniqueIndexSql,
  buildUpsertSql,
  escapeIdentifier,
  escapeSqlLiteral,
  inferMySqlType,
} from "./write";

const logger = loggers.db("mysql");

/**
 * MySQL system databases that should be excluded from user-facing lists.
 * Exported for reuse in sql-tools and other MySQL-related code.
 */
export const MYSQL_SYSTEM_DATABASES = [
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
] as const;

export const MYSQL_SYSTEM_DATABASES_SET = new Set<string>(
  MYSQL_SYSTEM_DATABASES,
);

export class MySQLDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "mysql",
      displayName: "MySQL",
      consoleLanguage: "sql",
    };
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

    // Cluster Mode: list databases
    try {
      const result = await this.executeQuery(database, "SHOW DATABASES");
      if (!result.success || !result.data) return [];

      return (result.data as Array<Record<string, string>>)
        .map(row => row.Database || row.database || row.name)
        .filter(
          (name): name is string =>
            !!name && !MYSQL_SYSTEM_DATABASES_SET.has(name),
        )
        .map<DatabaseTreeNode>(dbName => ({
          id: dbName,
          label: dbName,
          kind: "database",
          hasChildren: true,
          metadata: { databaseId: dbName, databaseName: dbName },
        }));
    } catch (error) {
      logger.error("Error listing databases in cluster mode", { error });
      return [];
    }
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    if (parent.kind === "database") {
      const dbName =
        parent.metadata?.databaseName ||
        parent.metadata?.databaseId ||
        parent.id;
      const safeDbName = String(dbName).replace(/'/g, "''");

      const result = await this.executeQuery(
        database,
        `SELECT table_name AS table_name, table_type AS table_type
         FROM information_schema.tables
         WHERE table_schema = '${safeDbName}'
         ORDER BY table_name;`,
        { databaseName: dbName },
      );

      if (!result.success || !result.data) return [];

      type TableRow = {
        table_name?: string;
        TABLE_NAME?: string;
        table_type?: string;
        TABLE_TYPE?: string;
      };

      type MappedTable = {
        tableName: string | undefined;
        tableType: string | undefined;
      };

      const tables = (result.data as TableRow[])
        .map(
          (row): MappedTable => ({
            tableName: row.table_name ?? row.TABLE_NAME,
            tableType: row.table_type ?? row.TABLE_TYPE,
          }),
        )
        .filter(
          (row): row is MappedTable & { tableName: string } => !!row.tableName,
        );

      return tables.map<DatabaseTreeNode>(({ tableName, tableType }) => ({
        id: `${dbName}.${tableName}`,
        label: tableName,
        kind: tableType === "VIEW" ? "view" : "table",
        hasChildren: true,
        metadata: { databaseName: dbName, tableName },
      }));
    }

    if (parent.kind === "table" || parent.kind === "view") {
      const { databaseName, tableName } = parent.metadata || {};
      if (!databaseName || !tableName) return [];

      const safeDbName = String(databaseName).replace(/'/g, "''");
      const safeTableName = String(tableName).replace(/'/g, "''");

      const result = await this.executeQuery(
        database,
        `SELECT column_name AS column_name, data_type AS data_type
         FROM information_schema.columns
         WHERE table_schema = '${safeDbName}'
           AND table_name = '${safeTableName}'
         ORDER BY ordinal_position;`,
        { databaseName },
      );

      if (!result.success || !result.data) return [];

      type ColumnRow = {
        column_name?: string;
        COLUMN_NAME?: string;
        data_type?: string;
        DATA_TYPE?: string;
      };

      type MappedColumn = {
        columnName: string | undefined;
        dataType: string | undefined;
      };

      const columns = (result.data as ColumnRow[])
        .map(
          (row): MappedColumn => ({
            columnName: row.column_name ?? row.COLUMN_NAME,
            dataType: row.data_type ?? row.DATA_TYPE,
          }),
        )
        .filter(
          (row): row is MappedColumn & { columnName: string } =>
            !!row.columnName,
        );

      return columns.map<DatabaseTreeNode>(({ columnName, dataType }) => ({
        id: `${databaseName}.${tableName}.${columnName}`,
        label: `${columnName}: ${dataType ?? ""}`.trim(),
        kind: "column",
        hasChildren: false,
        metadata: {
          databaseName,
          tableName,
          columnName,
          columnType: dataType,
        },
      }));
    }

    return [];
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    const excludedSchemas = MYSQL_SYSTEM_DATABASES.map(db => `'${db}'`).join(
      ", ",
    );
    const result = await this.executeQuery(
      database,
      `SELECT table_schema AS table_schema, table_name AS table_name, column_name AS column_name, data_type AS data_type
       FROM information_schema.columns
       WHERE table_schema NOT IN (${excludedSchemas})
       ORDER BY table_schema, table_name, ordinal_position;`,
    );

    if (!result.success || !result.data) {
      return {};
    }

    const schema: Record<
      string,
      Record<string, Array<{ name: string; type: string }>>
    > = {};

    for (const row of result.data as Array<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
    }>) {
      const { table_schema, table_name, column_name, data_type } = row;

      if (!table_schema || !table_name || !column_name) {
        continue;
      }

      if (!schema[table_schema]) {
        schema[table_schema] = {};
      }
      if (!schema[table_schema][table_name]) {
        schema[table_schema][table_name] = [];
      }

      schema[table_schema][table_name].push({
        name: column_name,
        type: data_type || "unknown",
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

  // ============ Write capabilities (destination sync + CDC adapter) ============

  supportsWrites(): boolean {
    return true;
  }

  quoteIdentifier(name: string): string {
    return escapeIdentifier(name);
  }

  formatTableRef(schema: string | undefined, table: string): string {
    return schema
      ? `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`
      : escapeIdentifier(table);
  }

  /** In MySQL a "schema" IS a database — CREATE DATABASE covers both. */
  async ensureSchema(
    database: IDatabaseConnection,
    schemaName: string,
  ): Promise<{ success: boolean; created?: boolean; error?: string }> {
    const result = await this.executeQuery(
      database,
      `CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(schemaName)}`,
    );
    return {
      success: result.success,
      created: result.success ? true : undefined,
      error: result.error,
    };
  }

  inferSchema(rows: Record<string, unknown>[]): ColumnDefinition[] {
    const columns = new Map<string, ColumnDefinition>();
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (!key || key.includes(".")) continue;
        const existing = columns.get(key);
        if (!existing || existing.type === "TEXT") {
          columns.set(key, {
            name: key,
            type: inferMySqlType(value),
            nullable: true,
          });
        }
      }
    }
    return Array.from(columns.values());
  }

  async createTable(
    database: IDatabaseConnection,
    tableName: string,
    columns: ColumnDefinition[],
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const schema = options?.schema || database.connection.database || "";
    const result = await this.executeQuery(
      database,
      buildCreateTableSql(schema, tableName, columns),
    );
    return { success: result.success, error: result.error };
  }

  async tableExists(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<boolean> {
    const schema = options?.schema || database.connection.database || "";
    const result = await this.executeQuery(
      database,
      `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ${escapeSqlLiteral(schema)} AND table_name = ${escapeSqlLiteral(tableName)}`,
    );
    if (!result.success || !result.data) return false;
    const first = result.data[0] as Record<string, unknown> | undefined;
    return Number(first?.c ?? first?.C ?? 0) > 0;
  }

  async addMissingColumns(
    database: IDatabaseConnection,
    tableName: string,
    schemaName: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    if (rows.length === 0) return;

    const existing = await this.fetchColumnTypes(
      database,
      schemaName,
      tableName,
    );
    const allKeys = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(key => allKeys.add(key));
    }

    for (const key of allKeys) {
      if (!key || key.includes(".")) continue;
      if (existing.has(key.toLowerCase())) continue;
      const sampleValue = rows.find(
        row => row[key] !== null && row[key] !== undefined,
      )?.[key];
      // MySQL 8.0 has no ADD COLUMN IF NOT EXISTS — existence checked above.
      const alter = `ALTER TABLE ${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)} ADD COLUMN ${escapeIdentifier(key)} ${inferMySqlType(sampleValue)}`;
      const result = await this.executeQuery(database, alter);
      if (!result.success) {
        throw new Error(
          result.error || `Failed to add missing MySQL column: ${key}`,
        );
      }
    }
  }

  async insertBatch(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    options?: InsertOptions,
  ): Promise<BatchWriteResult> {
    if (rows.length === 0) return { success: true, rowsWritten: 0 };
    const schema = options?.schema || database.connection.database || "";
    const columns = this.collectColumns(rows);
    const result = await this.executeQuery(
      database,
      buildInsertSql(schema, tableName, columns, rows),
    );
    return {
      success: result.success,
      rowsWritten: result.success ? rows.length : 0,
      error: result.error,
    };
  }

  async upsertBatch(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    keyColumns: string[],
    options?: UpsertOptions,
  ): Promise<BatchWriteResult> {
    if (rows.length === 0) return { success: true, rowsWritten: 0 };
    if (keyColumns.length === 0) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Key columns required for upsert",
      };
    }

    const schema = options?.schema || database.connection.database || "";
    const columns = this.collectColumns(rows);

    if (options?.conflictStrategy === "ignore") {
      const result = await this.executeQuery(
        database,
        buildInsertSql(schema, tableName, columns, rows, { ignore: true }),
      );
      return {
        success: result.success,
        rowsWritten: result.success ? rows.length : 0,
        error: result.error,
      };
    }

    await this.ensureUniqueKeyIndex(database, schema, tableName, keyColumns);

    const result = await this.executeQuery(
      database,
      buildUpsertSql(schema, tableName, columns, rows, keyColumns),
    );
    return {
      success: result.success,
      rowsWritten: result.success ? rows.length : 0,
      error: result.error,
    };
  }

  async createStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const schema = options?.schema || database.connection.database || "";
    const drop = await this.executeQuery(
      database,
      `DROP TABLE IF EXISTS ${this.formatTableRef(schema, stagingTableName)}`,
    );
    if (!drop.success) return { success: false, error: drop.error };
    const create = await this.executeQuery(
      database,
      `CREATE TABLE ${this.formatTableRef(schema, stagingTableName)} LIKE ${this.formatTableRef(schema, originalTableName)}`,
    );
    return { success: create.success, error: create.error };
  }

  async swapStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const schema = options?.schema || database.connection.database || "";
    const backupName = `${originalTableName}_old_${Date.now()}`;
    // RENAME TABLE is atomic across multiple renames in MySQL.
    const rename = await this.executeQuery(
      database,
      `RENAME TABLE ${this.formatTableRef(schema, originalTableName)} TO ${this.formatTableRef(schema, backupName)}, ${this.formatTableRef(schema, stagingTableName)} TO ${this.formatTableRef(schema, originalTableName)}`,
    );
    if (!rename.success) return { success: false, error: rename.error };
    const drop = await this.executeQuery(
      database,
      `DROP TABLE IF EXISTS ${this.formatTableRef(schema, backupName)}`,
    );
    return { success: drop.success, error: drop.error };
  }

  async dropTable(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const schema = options?.schema || database.connection.database || "";
    const result = await this.executeQuery(
      database,
      `DROP TABLE IF EXISTS ${this.formatTableRef(schema, tableName)}`,
    );
    return { success: result.success, error: result.error };
  }

  async deleteBatch(
    database: IDatabaseConnection,
    tableName: string,
    keyFilters: Record<string, unknown>,
    options?: InsertOptions,
  ): Promise<BatchWriteResult> {
    const schema = options?.schema || database.connection.database || "";
    const filterEntries = Object.entries(keyFilters || {}).filter(
      ([, value]) => value !== undefined,
    );
    if (filterEntries.length === 0) {
      return {
        success: false,
        rowsWritten: 0,
        error: "deleteBatch requires at least one key filter",
      };
    }
    const result = await this.executeQuery(
      database,
      buildDeleteSql(schema, tableName, keyFilters),
    );
    return {
      success: result.success,
      rowsWritten: result.success ? (result.rowCount ?? 0) : 0,
      error: result.error,
    };
  }

  // ============ Write internals ============

  private collectColumns(rows: Record<string, unknown>[]): string[] {
    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    return Array.from(allColumns);
  }

  /** Column-name → data-type map (public: the CDC adapter reuses it). */
  async fetchColumnTypes(
    database: IDatabaseConnection,
    schema: string,
    tableName: string,
  ): Promise<Map<string, string>> {
    const result = await this.executeQuery(
      database,
      `SELECT column_name AS column_name, data_type AS data_type FROM information_schema.columns WHERE table_schema = ${escapeSqlLiteral(schema)} AND table_name = ${escapeSqlLiteral(tableName)}`,
    );
    const map = new Map<string, string>();
    for (const row of (result.data || []) as Array<Record<string, unknown>>) {
      const name = String(row.column_name ?? row.COLUMN_NAME ?? "");
      if (name) {
        map.set(
          name.toLowerCase(),
          String(row.data_type ?? row.DATA_TYPE ?? ""),
        );
      }
    }
    return map;
  }

  private async ensureUniqueKeyIndex(
    database: IDatabaseConnection,
    schema: string,
    tableName: string,
    keyColumns: string[],
  ): Promise<void> {
    const existing = await this.executeQuery(
      database,
      `SELECT index_name AS index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols FROM information_schema.statistics WHERE table_schema = ${escapeSqlLiteral(schema)} AND table_name = ${escapeSqlLiteral(tableName)} AND non_unique = 0 GROUP BY index_name`,
    );
    if (existing.success) {
      const wanted = keyColumns.map(c => c.toLowerCase()).join(",");
      for (const row of (existing.data || []) as Array<
        Record<string, unknown>
      >) {
        const cols = String(row.cols ?? row.COLS ?? "").toLowerCase();
        if (cols === wanted) return;
      }
    }

    const columnTypes = await this.fetchColumnTypes(
      database,
      schema,
      tableName,
    );
    const { sql } = buildUniqueIndexSql(
      schema,
      tableName,
      keyColumns,
      columnTypes,
    );
    const created = await this.executeQuery(database, sql);
    if (!created.success) {
      // Racing writers can both attempt creation; duplicates are fine.
      const message = created.error || "";
      if (!/duplicate key name/i.test(message)) {
        throw new Error(
          message || "Failed to create MySQL unique key index",
        );
      }
    }
  }
}
