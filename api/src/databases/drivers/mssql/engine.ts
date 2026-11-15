/**
 * The MSSQL engine: one pool per connection, queries, and cancellation of
 * the running request. MSSQL has no tree/write driver, so it is not in the
 * driver registry (which lists the database types the UI offers); the
 * engine resolver (`databases/engines.ts`) knows it directly.
 */
import { ConnectionPool, type Request as MSSQLRequest } from "mssql";
import type { IDatabaseConnection } from "../../../database/workspace-schema";
import { ConnectionCache } from "../../connection-cache";
import type { QueryEngine } from "../../engine";
import {
  QUERY_NOT_FOUND,
  type CancelResult,
  type ConnectionTestResult,
  type DatabaseQuery,
  type QueryExecuteOptions,
  type QueryResult,
} from "../../query-types";

function createPool(database: IDatabaseConnection): ConnectionPool {
  return new ConnectionPool({
    server: database.connection.host ?? "",
    port: database.connection.port || 1433,
    database: database.connection.database ?? "",
    user: database.connection.username ?? "",
    password: database.connection.password ?? "",
    options: {
      encrypt: database.connection.ssl || false,
      trustServerCertificate: true,
    },
  });
}

export class MSSQLEngine implements QueryEngine {
  // Keyed by connection id.
  readonly pools = new ConnectionCache<ConnectionPool>({
    name: "MSSQL pool",
    close: pool => pool.close(),
  });

  readonly runningQueries = new Map<string, { request: MSSQLRequest }>();

  async getConnection(database: IDatabaseConnection): Promise<ConnectionPool> {
    return this.pools.acquire(database._id.toString(), async () => {
      const pool = createPool(database);
      await pool.connect();
      return pool;
    });
  }

  async closeConnection(databaseId: string): Promise<void> {
    await this.pools.closeConnection(databaseId);
  }

  async closeAllConnections(): Promise<void> {
    await this.pools.closeAll();
  }

  async sweepIdleConnections(maxIdleMs: number): Promise<void> {
    await this.pools.sweepIdle(maxIdleMs);
  }

  async testConnection(
    database: IDatabaseConnection,
  ): Promise<ConnectionTestResult> {
    let pool: ConnectionPool | null = null;
    try {
      pool = createPool(database);
      await pool.connect();
      await pool.request().query("SELECT 1");
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "MSSQL connection failed",
      };
    } finally {
      if (pool) {
        await pool.close();
      }
    }
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: DatabaseQuery,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    const pool = await this.getConnection(database);
    const request = pool.request();
    const executionId = options?.executionId;
    try {
      if (executionId) {
        this.runningQueries.set(executionId, { request });
      }
      const result = await request.query(query as string);
      return {
        success: true,
        data: result.recordset,
        rowCount: result.rowsAffected[0],
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "MSSQL query failed",
      };
    } finally {
      if (executionId) {
        this.runningQueries.delete(executionId);
      }
    }
  }

  async cancelQuery(executionId: string): Promise<CancelResult> {
    const running = this.runningQueries.get(executionId);
    if (!running) {
      return { success: false, error: QUERY_NOT_FOUND };
    }

    try {
      running.request.cancel();
      this.runningQueries.delete(executionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to cancel query",
      };
    }
  }
}

export const mssqlEngine = new MSSQLEngine();
