import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
  ColumnDefinition,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import axios, { AxiosInstance } from "axios";
import { loggers } from "../../../logging";

const logger = loggers.db("cloudflare-d1");

interface D1Connection {
  account_id: string;
  api_token: string;
  database_id?: string;
}

interface D1QueryResult {
  success: boolean;
  data?: any[];
  error?: string;
  rowCount?: number;
  meta?: {
    duration: number;
    changes: number;
    last_row_id: number;
    served_by: string;
  };
}

interface D1Database {
  uuid: string;
  name: string;
  created_at: string;
  version: string;
  num_tables?: number;
  file_size?: number;
}

export class CloudflareD1DatabaseDriver implements DatabaseDriver {
  private httpClients: Map<string, AxiosInstance> = new Map();

  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "cloudflare-d1",
      displayName: "Cloudflare D1",
      consoleLanguage: "sql",
    };
  }

  private getHttpClient(database: IDatabaseConnection): AxiosInstance {
    const key = database._id.toString();
    const existingClient = this.httpClients.get(key);
    if (existingClient) {
      return existingClient;
    }

    const conn = database.connection as unknown as D1Connection;
    if (!conn.account_id || !conn.api_token) {
      throw new Error(
        "Cloudflare D1 requires 'account_id' and 'api_token' in connection",
      );
    }

    const client = axios.create({
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${conn.account_id}/d1/database`,
      headers: {
        Authorization: `Bearer ${conn.api_token}`,
        "Content-Type": "application/json",
      },
    });

    this.httpClients.set(key, client);
    return client;
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    const conn = database.connection as unknown as D1Connection;

    // If a specific database_id is configured, show only that database
    if (conn.database_id) {
      return [
        {
          id: conn.database_id,
          label: conn.database_id,
          kind: "database",
          hasChildren: true,
          metadata: {
            databaseId: conn.database_id,
            databaseName: conn.database_id,
          },
        },
      ];
    }

    // Otherwise, list all D1 databases in the account
    try {
      const client = this.getHttpClient(database);
      const response = await client.get("", {
        params: { per_page: 100 },
      });

      const result = response.data;
      if (!result.success) {
        logger.error("D1 list databases failed", { errors: result.errors });
        return [];
      }

      const databases: D1Database[] = result.result || [];
      return databases.map<DatabaseTreeNode>(db => ({
        id: db.uuid,
        label: db.name,
        kind: "database",
        hasChildren: true,
        // databaseId: UUID (used for API calls), databaseName: human-readable label (for display)
        metadata: { databaseId: db.uuid, databaseName: db.name },
      }));
    } catch (error) {
      logger.error("Error listing D1 databases", { error });
      return [];
    }
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    if (parent.kind !== "database") return [];

    // databaseId is the UUID (for API calls), databaseName is the human-readable label
    const databaseId =
      parent.metadata?.databaseId || parent.metadata?.databaseName || parent.id;
    const databaseName =
      parent.metadata?.databaseName || parent.metadata?.databaseId || parent.id;

    // Query SQLite master table to get tables
    try {
      const result = await this.executeQuery(
        database,
        `SELECT name, type FROM sqlite_master 
         WHERE type IN ('table', 'view') 
         AND name NOT LIKE 'sqlite_%' 
         AND name NOT LIKE '_cf_%'
         ORDER BY type DESC, name ASC`,
        { databaseId },
      );

      if (!result.success || !result.data) {
        return [];
      }

      return result.data.map<DatabaseTreeNode>(row => ({
        id: `${databaseId}.${row.name}`,
        label: row.name,
        kind: row.type === "view" ? "view" : "table",
        hasChildren: false,
        metadata: { databaseId, databaseName, table: row.name },
      }));
    } catch (error) {
      logger.error("Error listing D1 tables", { error });
      return [];
    }
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseId?: string; databaseName?: string },
  ): Promise<D1QueryResult> {
    try {
      const conn = database.connection as unknown as D1Connection;
      // D1 uses UUID for database identification; accept both databaseId and databaseName
      // since other parts of the system may pass databaseName (which for D1 is also the UUID)
      const databaseId =
        options?.databaseId || options?.databaseName || conn.database_id;

      if (!databaseId) {
        return {
          success: false,
          error:
            "No database_id specified. Please select a D1 database or configure one in the connection settings.",
        };
      }

      if (typeof query !== "string" || !query.trim()) {
        return { success: false, error: "Query must be a non-empty string" };
      }

      const client = this.getHttpClient(database);

      // Use the query endpoint for standard queries
      const response = await client.post(`/${databaseId}/query`, {
        sql: query,
      });

      const result = response.data;

      if (!result.success) {
        const errorMessages =
          result.errors?.map((e: any) => e.message).join("; ") ||
          "D1 query failed";
        return {
          success: false,
          error: errorMessages,
        };
      }

      // D1 returns results in an array (one per statement)
      // For simplicity, we take the first result
      const queryResults = result.result || [];
      const firstResult = queryResults[0] || {};

      return {
        success: true,
        data: firstResult.results || [],
        rowCount: firstResult.results?.length || 0,
        meta: firstResult.meta,
      };
    } catch (error: any) {
      const errorMessage =
        error?.response?.data?.errors?.[0]?.message ||
        error?.message ||
        "D1 query failed";
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Get the schema (column types) for a query.
   * SQLite/D1 doesn't have a dry run feature, so we use multiple strategies:
   *
   * 1. For simple "SELECT * FROM table" queries, use PRAGMA table_info
   * 2. Try LIMIT 1 to get a sample row
   * 3. If sample has NULLs, try finding non-NULL values with targeted queries
   * 4. Fall back to TEXT for columns that are always NULL
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
      const dbOptions = {
        databaseId: options?.databaseName,
        databaseName: options?.databaseName,
      };

      // Strategy 1: Check if this is a simple "SELECT * FROM table" query
      // and use PRAGMA table_info for accurate types
      const simpleTableMatch = query
        .trim()
        .match(/^\s*SELECT\s+\*\s+FROM\s+["'`]?(\w+)["'`]?\s*$/i);

      if (simpleTableMatch) {
        const tableName = simpleTableMatch[1];
        const pragmaResult = await this.executeQuery(
          database,
          `PRAGMA table_info("${tableName}")`,
          dbOptions,
        );

        if (pragmaResult.success && pragmaResult.data?.length > 0) {
          const columns: ColumnDefinition[] = pragmaResult.data.map(
            (col: any) => ({
              name: col.name,
              type: this.normalizeSqliteType(col.type || "TEXT"),
              nullable: col.notnull === 0,
            }),
          );
          return { success: true, columns };
        }
      }

      // Strategy 2: Execute with LIMIT 1 to get sample data
      const schemaQuery = `SELECT * FROM (${query}) AS _schema_query LIMIT 1`;
      const result = await this.executeQuery(database, schemaQuery, dbOptions);

      if (!result.success) {
        return { success: false, error: result.error };
      }

      const rows = result.data || [];

      // No rows - try to at least get column names
      if (rows.length === 0) {
        // Strategy 3: Try PRAGMA for the base table if we can extract it
        const fromMatch = query.match(/FROM\s+["'`]?(\w+)["'`]?/i);
        if (fromMatch) {
          const tableName = fromMatch[1];
          const pragmaResult = await this.executeQuery(
            database,
            `PRAGMA table_info("${tableName}")`,
            dbOptions,
          );

          if (pragmaResult.success && pragmaResult.data?.length > 0) {
            // We have table schema - now we need to figure out which columns
            // are in the query. Execute the query to at least get column names.
            // Since there are 0 rows, we'll use TEXT as fallback for computed columns.
            const columns: ColumnDefinition[] = pragmaResult.data.map(
              (col: any) => ({
                name: col.name,
                type: this.normalizeSqliteType(col.type || "TEXT"),
                nullable: true,
              }),
            );
            return { success: true, columns };
          }
        }

        return {
          success: false,
          error: "Query returned no rows - cannot infer column types",
        };
      }

      // Strategy 4: Infer from sample row, with fallback queries for NULL values
      const sampleRow = rows[0];
      const columnEntries = Object.entries(sampleRow);

      // Find columns with NULL values that need better type detection
      const nullColumns = columnEntries
        .filter(([, value]) => value === null)
        .map(([name]) => name);

      // If we have NULL columns, try to find non-NULL values
      if (nullColumns.length > 0 && nullColumns.length < columnEntries.length) {
        // Use a single query with COALESCE-style sampling
        // Select first non-NULL value for each column
        const sampleNonNullQuery = `
          SELECT ${nullColumns.map(col => `(SELECT "${col}" FROM (${query}) WHERE "${col}" IS NOT NULL LIMIT 1) AS "${col}"`).join(", ")}
        `;

        const nonNullResult = await this.executeQuery(
          database,
          sampleNonNullQuery,
          dbOptions,
        );

        if (nonNullResult.success && nonNullResult.data?.[0]) {
          const nonNullSample = nonNullResult.data[0];
          // Merge non-NULL samples into our sample row
          for (const col of nullColumns) {
            if (nonNullSample[col] !== null) {
              sampleRow[col] = nonNullSample[col];
            }
          }
        }
      }

      // Build final column definitions
      const columns: ColumnDefinition[] = columnEntries.map(([name]) => ({
        name,
        type: this.inferSqliteType(sampleRow[name]),
        nullable: true,
      }));

      return { success: true, columns };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || "Failed to get query schema",
      };
    }
  }

  /**
   * Normalize SQLite type names from PRAGMA to standard types
   */
  private normalizeSqliteType(type: string): string {
    const upper = type.toUpperCase().trim();
    // SQLite type affinity rules
    if (upper.includes("INT")) return "INTEGER";
    if (
      upper.includes("CHAR") ||
      upper.includes("CLOB") ||
      upper.includes("TEXT")
    )
      return "TEXT";
    if (
      upper.includes("BLOB") ||
      upper === "" // No type = BLOB affinity
    )
      return "BLOB";
    if (
      upper.includes("REAL") ||
      upper.includes("FLOA") ||
      upper.includes("DOUB")
    )
      return "REAL";
    // NUMERIC affinity for everything else
    if (
      upper.includes("NUMERIC") ||
      upper.includes("DECIMAL") ||
      upper.includes("BOOL") ||
      upper.includes("DATE") ||
      upper.includes("TIME")
    )
      return upper; // Keep original for clarity
    return "TEXT";
  }

  /**
   * Infer SQLite column type from a JavaScript value
   */
  private inferSqliteType(value: unknown): string {
    if (value === null || value === undefined) return "TEXT";
    if (typeof value === "boolean") return "INTEGER"; // SQLite stores booleans as 0/1
    if (typeof value === "number") {
      return Number.isInteger(value) ? "INTEGER" : "REAL";
    }
    if (typeof value === "bigint") return "INTEGER";
    if (value instanceof Date) return "TEXT"; // SQLite stores dates as text
    if (typeof value === "string") {
      // Try to detect date strings
      if (/^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}:\d{2}/.test(value)) {
        return "TEXT"; // Keep as TEXT for timestamps
      }
      return "TEXT";
    }
    if (typeof value === "object") return "TEXT"; // JSON stored as text
    return "TEXT";
  }

  async testConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const conn = database.connection as unknown as D1Connection;

      if (!conn.account_id || !conn.api_token) {
        return {
          success: false,
          error: "account_id and api_token are required",
        };
      }

      const client = this.getHttpClient(database);

      // If a specific database_id is configured, test querying it
      if (conn.database_id) {
        const result = await this.executeQuery(database, "SELECT 1 AS test", {
          databaseId: conn.database_id,
        });
        return result.success
          ? { success: true }
          : { success: false, error: result.error };
      }

      // Otherwise, test by listing databases
      const response = await client.get("", {
        params: { per_page: 1 },
      });

      if (response.data.success) {
        return { success: true };
      }

      return {
        success: false,
        error:
          response.data.errors?.[0]?.message || "Failed to connect to D1 API",
      };
    } catch (error: any) {
      return {
        success: false,
        error:
          error?.response?.data?.errors?.[0]?.message ||
          error?.message ||
          "D1 connection test failed",
      };
    }
  }

  async listDatabases(database: IDatabaseConnection): Promise<D1Database[]> {
    try {
      const client = this.getHttpClient(database);
      const databases: D1Database[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await client.get("", {
          params: { per_page: 100, page },
        });

        if (!response.data.success) {
          break;
        }

        const results: D1Database[] = response.data.result || [];
        databases.push(...results);

        const resultInfo = response.data.result_info;
        hasMore =
          resultInfo &&
          resultInfo.page * resultInfo.per_page < resultInfo.count;
        page++;
      }

      return databases;
    } catch (error) {
      logger.error("Error listing D1 databases", { error });
      return [];
    }
  }

  closeConnection(databaseId: string): void {
    this.httpClients.delete(databaseId);
  }

  closeAllConnections(): void {
    this.httpClients.clear();
  }
}
