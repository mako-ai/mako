import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
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
    options?: { databaseId?: string },
  ): Promise<D1QueryResult> {
    try {
      const conn = database.connection as unknown as D1Connection;
      const databaseId = options?.databaseId || conn.database_id;

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
