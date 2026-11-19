/**
 * The MySQL engine: pools (through an SSH tunnel when the connection has
 * one), queries, and cancellation by `KILL QUERY <threadId>`.
 */
import type { Connection as CoreConnection } from "mysql2";
import * as mysql from "mysql2/promise";
import type { IDatabaseConnection } from "../../../database/workspace-schema";
import { loggers } from "../../../logging";
import { sshTunnelManager } from "../../../services/ssh-tunnel.service";
import { ConnectionCache } from "../../connection-cache";
import type { QueryEngine } from "../../engine";
import {
  QUERY_NOT_FOUND,
  type CancelResult,
  type ConnectionTestResult,
  type DatabaseQuery,
  type QueryExecuteOptions,
  type QueryResult,
  type StreamingQueryOptions,
  type StreamingQueryResult,
} from "../../query-types";
import { withRetry } from "../../retry";
import {
  buildMySQLConfig,
  buildSshTunnelConfig,
  MYSQL_MAX_RETRIES,
  MYSQL_RETRY_BASE_DELAY_MS,
} from "./config";

const logger = loggers.db("mysql");

interface RunningMySQLQuery {
  database: IDatabaseConnection;
  targetDatabase?: string;
  poolKey: string;
  threadId: number;
  cancelled?: boolean;
}

/**
 * Make a row JSON-friendly: JSON text in buffers is parsed, other buffers
 * become text, dates become ISO strings.
 */
export function normalizeMySQLValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    const text = value.toString("utf8");
    const trimmed = text.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return text;
      }
    }
    return text;
  }

  if (Array.isArray(value)) {
    return value.map(item => normalizeMySQLValue(item));
  }

  // Handle Date objects before generic object check - mysql2 returns
  // DATETIME, TIMESTAMP, and DATE columns as JavaScript Date objects.
  // Date passes typeof === "object" but Object.entries() returns [] since
  // Date has no enumerable own properties, which would convert dates to {}.
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      normalized[key] = normalizeMySQLValue(entry);
    }
    return normalized;
  }

  return value;
}

function normalizeFields(fields: unknown): unknown {
  if (!Array.isArray(fields)) return fields;
  return fields.map(field => {
    const fieldPacket =
      field && typeof field === "object"
        ? (field as mysql.FieldPacket)
        : undefined;
    return {
      name: fieldPacket?.name,
      type: fieldPacket?.type ?? fieldPacket?.columnType,
      columnType: fieldPacket?.columnType,
      columnLength: fieldPacket?.columnLength,
      decimals: fieldPacket?.decimals,
      flags: fieldPacket?.flags,
      characterSet: fieldPacket?.characterSet,
      encoding: fieldPacket?.encoding,
    };
  });
}

export class MySQLEngine implements QueryEngine {
  // Keyed `${databaseId}:${databaseName}`; the pool's SSH tunnel (if any)
  // is keyed the same and closed with it.
  readonly pools = new ConnectionCache<mysql.Pool>({
    name: "MySQL pool",
    close: async (pool, key) => {
      try {
        await pool.end();
      } finally {
        await sshTunnelManager.closeTunnel(key).catch(error => {
          logger.error("Error closing SSH tunnel for MySQL pool", {
            key,
            error,
          });
        });
      }
    },
  });

  readonly runningQueries = new Map<string, RunningMySQLQuery>();

  async getPool(
    database: IDatabaseConnection,
    targetDatabase?: string,
  ): Promise<mysql.Pool> {
    const dbName = targetDatabase || database.connection.database || "";
    const key = `${database._id.toString()}:${dbName}`;
    return this.pools.acquire(key, () =>
      this.createPool(database, targetDatabase, key),
    );
  }

  private async createPool(
    database: IDatabaseConnection,
    targetDatabase: string | undefined,
    key: string,
  ): Promise<mysql.Pool> {
    const tunnelCfg = buildSshTunnelConfig(database, key);
    const tunnelEndpoint = tunnelCfg
      ? await sshTunnelManager.openTunnel(tunnelCfg)
      : undefined;

    const config = buildMySQLConfig(database, targetDatabase, tunnelEndpoint);
    const pool = mysql.createPool({
      ...config,
      waitForConnections: true,
      connectionLimit: 2,
      maxIdle: 2,
      idleTimeout: 10000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000,
    });

    pool.on("connection", connection => {
      connection.on("error", err => {
        logger.error("MySQL pool connection error", {
          key,
          error: err instanceof Error ? err.message : err,
        });
        this.pools.forget(key, pool);
        pool.end().catch(endErr => {
          logger.error("Error closing MySQL pool after error", {
            key,
            error: endErr,
          });
        });
        sshTunnelManager.closeTunnel(key).catch(() => {});
      });
    });

    logger.debug("Created MySQL pool", { key });
    return pool;
  }

  getConnection(database: IDatabaseConnection): Promise<mysql.Pool> {
    return this.getPool(database);
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
    const ephemeralKey = `test:${Date.now()}`;
    let connection: mysql.Connection | null = null;
    try {
      const tunnelCfg = buildSshTunnelConfig(database, ephemeralKey);
      const tunnelEndpoint = tunnelCfg
        ? await sshTunnelManager.openTunnel(tunnelCfg)
        : undefined;

      const config = buildMySQLConfig(database, undefined, tunnelEndpoint);
      connection = await mysql.createConnection(config);
      await connection.ping();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "MySQL connection failed",
      };
    } finally {
      if (connection) {
        await connection.end();
      }
      await sshTunnelManager.closeTunnel(ephemeralKey).catch(() => {});
    }
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: DatabaseQuery,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    let result: QueryResult = { success: false };
    const failed = await this.onConnection(
      database,
      options,
      async connection => {
        const [rows, fields] = await connection.execute(query as string);
        const normalizedRows = Array.isArray(rows)
          ? rows.map(row => normalizeMySQLValue(row))
          : rows;
        result = {
          success: true,
          data: normalizedRows,
          fields: normalizeFields(fields) as QueryResult["fields"],
        };
        return false;
      },
    );
    return failed ?? result;
  }

  /**
   * Run `query` ONCE and hand its rows to `onBatch` in `batchSize` batches
   * as the server sends them (mysql2's query().stream(), which pauses the
   * socket while a batch is written). Never pages with LIMIT/OFFSET: without
   * an ORDER BY, separate queries may return rows in different orders, so
   * offset pages overlap and skip rows. A throw from `onBatch` stops the read
   * and the connection is destroyed, not pooled.
   */
  async executeStreamingQuery(
    database: IDatabaseConnection,
    query: string,
    options: StreamingQueryOptions & QueryExecuteOptions,
  ): Promise<StreamingQueryResult> {
    const batchSize = Math.max(1, Math.floor(options.batchSize || 1000));
    let totalRows = 0;
    const failed = await this.onConnection(
      database,
      options,
      async connection => {
        // The promise wrapper's underlying callback connection streams.
        const core = connection.connection as unknown as CoreConnection;
        const stream = core.query(query).stream({ highWaterMark: batchSize });
        let batch: Record<string, unknown>[] = [];
        try {
          for await (const row of stream) {
            batch.push(normalizeMySQLValue(row) as Record<string, unknown>);
            if (batch.length >= batchSize) {
              await options.onBatch(batch);
              totalRows += batch.length;
              batch = [];
            }
          }
        } catch (error) {
          stream.destroy();
          // Rows still in flight belong to this statement: never pool it.
          (error as { destroyConnection?: boolean }).destroyConnection = true;
          throw error;
        }
        if (batch.length > 0) {
          await options.onBatch(batch);
          totalRows += batch.length;
        }
        return false;
      },
    );
    return failed
      ? { success: false, totalRows, error: failed.error }
      : { success: true, totalRows };
  }

  /**
   * Check out a pooled connection, make it cancellable, open a read-only
   * transaction when asked, and run `use` on it. Returns a failed result, or
   * undefined when `use` succeeded.
   */
  private async onConnection(
    database: IDatabaseConnection,
    options: QueryExecuteOptions | undefined,
    use: (connection: mysql.PoolConnection) => Promise<boolean>,
  ): Promise<QueryResult | undefined> {
    const signal = options?.signal;
    const targetDatabase =
      options?.databaseName || database.connection.database;

    try {
      if (signal?.aborted) {
        return { success: false, error: "Query cancelled" };
      }

      const pool = await this.getPool(database, targetDatabase);
      const connection = await withRetry(async () => pool.getConnection(), {
        maxRetries: MYSQL_MAX_RETRIES,
        baseDelayMs: MYSQL_RETRY_BASE_DELAY_MS,
        signal,
      });

      let readOnlyTransactionStarted = false;
      let destroy = false;
      // Cancellable by executionId (cancelQuery) and by the signal alone.
      const untrack = this.trackQuery(
        database,
        targetDatabase,
        connection,
        options?.executionId,
        signal,
      );
      try {
        if (signal?.aborted) {
          return { success: false, error: "Query cancelled" };
        }

        if (options?.readOnly || options?.readOnlyTransaction) {
          await connection.query("START TRANSACTION READ ONLY");
          readOnlyTransactionStarted = true;
        }
        await use(connection);
        if (readOnlyTransactionStarted) {
          await connection.commit();
          readOnlyTransactionStarted = false;
        }
        return undefined;
      } catch (error) {
        destroy =
          (error as { destroyConnection?: boolean } | null)
            ?.destroyConnection === true;
        throw error;
      } finally {
        if (readOnlyTransactionStarted && !destroy) {
          await connection.rollback().catch(() => undefined);
        }
        // A connection a KILL was aimed at is retired, not pooled: a KILL
        // still in flight must not land on the next query it runs.
        if (untrack() || destroy) connection.destroy();
        else connection.release();
      }
    } catch (error) {
      if (
        signal?.aborted ||
        (error as { code?: string } | null)?.code === "ER_QUERY_INTERRUPTED"
      ) {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "MySQL query failed",
      };
    }
  }

  /**
   * Register a pooled MySQL connection's statement for cancellation by
   * `executionId` and/or `signal`. Returns the function to call once the
   * statement settles (before releasing the connection); it returns
   * whether a cancel was sent, in which case the connection is destroyed.
   */
  private trackQuery(
    database: IDatabaseConnection,
    targetDatabase: string | undefined,
    connection: { threadId: number | null },
    executionId?: string,
    signal?: AbortSignal,
  ): () => boolean {
    const threadId = connection.threadId;
    if ((!executionId && !signal) || typeof threadId !== "number") {
      return () => false;
    }
    const poolKey = `${database._id.toString()}:${targetDatabase || ""}`;
    const entry: RunningMySQLQuery = {
      database,
      targetDatabase,
      poolKey,
      threadId,
    };
    if (executionId) this.runningQueries.set(executionId, entry);
    const onAbort = () => {
      if (entry.cancelled) return;
      entry.cancelled = true;
      void this.killQuery(entry).then(result => {
        if (!result.success) {
          logger.warn("MySQL cancel on abort failed", {
            threadId,
            error: result.error,
          });
        }
      });
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    return () => {
      signal?.removeEventListener("abort", onAbort);
      if (executionId && this.runningQueries.get(executionId) === entry) {
        this.runningQueries.delete(executionId);
      }
      return entry.cancelled === true;
    };
  }

  async cancelQuery(executionId: string): Promise<CancelResult> {
    const running = this.runningQueries.get(executionId);
    if (!running) {
      return { success: false, error: QUERY_NOT_FOUND };
    }
    // Marked first: the query's release then retires its connection rather
    // than pool one a KILL is aimed at (see trackQuery).
    running.cancelled = true;
    const result = await this.killQuery(running);
    if (result.success) this.runningQueries.delete(executionId);
    return result;
  }

  /**
   * `KILL QUERY <threadId>` from a separate, unpooled connection: the pool
   * (connectionLimit 2) may be fully occupied by the very query being
   * cancelled. KILL QUERY stops the statement and leaves the connection
   * usable. Through the pool's own SSH tunnel when it has one.
   */
  async killQuery(running: RunningMySQLQuery): Promise<CancelResult> {
    let killer: mysql.Connection | undefined;
    try {
      const tunnelCfg = buildSshTunnelConfig(running.database, running.poolKey);
      const tunnelEndpoint = tunnelCfg
        ? await sshTunnelManager.openTunnel(tunnelCfg)
        : undefined;
      killer = await mysql.createConnection(
        buildMySQLConfig(
          running.database,
          running.targetDatabase,
          tunnelEndpoint,
        ),
      );
      await killer.query(`KILL QUERY ${Math.trunc(running.threadId)}`);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to cancel query",
      };
    } finally {
      await killer?.end().catch(() => undefined);
    }
  }
}

export const mysqlEngine = new MySQLEngine();
