/**
 * The PostgreSQL wire engine (PostgreSQL and Redshift connections): pools,
 * queries, server-side cursor reads, and cancellation by `pg_cancel_backend`.
 */
import {
  Client as PgClient,
  Pool as PgPool,
  type PoolClient,
  type QueryResult as PgQueryResult,
} from "pg";
import {
  inReadOnlyTransaction,
  isWrite,
  ownResult,
} from "../../../access/connection-writes";
import type { IDatabaseConnection } from "../../../database/workspace-schema";
import { loggers } from "../../../logging";
import { stripLeadingSqlComments } from "../../../services/query-pagination.service";
import { StopReading } from "../../../services/query-row-cap";
import { countTopLevelSemicolons } from "../../../services/sql-query-utils";
import { ConnectionCache } from "../../connection-cache";
import type { QueryEngine } from "../../engine";
import {
  QUERY_NOT_FOUND,
  type CancelResult,
  type ConnectionTestResult,
  type CursorReadOptions,
  type DatabaseQuery,
  type QueryExecuteOptions,
  type QueryResult,
} from "../../query-types";
import { withRetry } from "../../retry";
import {
  buildPostgreSQLConfig,
  POSTGRES_MAX_RETRIES,
  POSTGRES_RETRY_BASE_DELAY_MS,
} from "./config";
import { pgBackendPid } from "./pg-backend-pid";
import {
  normalizePostgresFields,
  normalizePostgresRows,
} from "./pg-type-utils";

const logger = loggers.db("postgresql");

/** Rows a Postgres cursor fetches at a time. */
const CURSOR_FETCH_ROWS = 1000;

interface RunningPostgresQuery {
  database: IDatabaseConnection;
  pid: number;
  cancelled?: boolean;
}

/**
 * The query without its trailing semicolon, when it is one statement that a
 * Postgres cursor can read (a SELECT, WITH, VALUES or TABLE that writes
 * nothing); null otherwise.
 */
export function cursorReadable(query: string): string | null {
  const statement = stripLeadingSqlComments(query.trim());
  if (!/^[\s(]*(select|with|values|table)\b/i.test(statement)) return null;
  if (isWrite("postgresql", query)) return null;
  const { count, lastIndex } = countTopLevelSemicolons(statement);
  if (count === 0) return statement;
  if (count === 1 && lastIndex === statement.trimEnd().length - 1) {
    return statement.trimEnd().slice(0, -1);
  }
  return null;
}

function cancelled(error: unknown, message: string): boolean {
  return error instanceof Error && error.message.includes(message);
}

export class PostgresEngine implements QueryEngine {
  // Keyed `${databaseId}:${databaseName}`.
  readonly pools = new ConnectionCache<PgPool>({
    name: "PostgreSQL pool",
    close: pool => pool.end(),
  });

  readonly runningQueries = new Map<string, RunningPostgresQuery>();

  /**
   * Get or create a PostgreSQL connection pool for the given database
   * Uses lazy initialization with aggressive cleanup to minimize memory usage
   */
  async getPool(
    database: IDatabaseConnection,
    targetDatabase?: string,
  ): Promise<PgPool> {
    // Use empty string when no database specified to avoid collision with a database literally named "default".
    // Empty string is not a valid PostgreSQL database name (must start with letter or underscore),
    // so there's no risk of collision with an actual database name.
    const dbName = targetDatabase || database.connection.database || "";
    const key = `${database._id.toString()}:${dbName}`;
    return this.pools.acquire(key, async () =>
      this.createPool(database, targetDatabase, key),
    );
  }

  private createPool(
    database: IDatabaseConnection,
    targetDatabase: string | undefined,
    key: string,
  ): PgPool {
    const config = buildPostgreSQLConfig(database, targetDatabase);

    // Create pool with settings optimized for Cloud Run / serverless:
    // - min: 0 = no idle connections when unused (saves memory)
    // - max: 2 = limit concurrent connections per database
    // - idleTimeoutMillis: 10000 = close idle connections after 10s (pg default)
    // - maxLifetimeSeconds: 1800 = max 30 min connection lifetime
    // - keepAlive: true = enable TCP keepalive probes
    // - keepAliveInitialDelayMillis: 30000 = start keepalive after 30s idle
    const pool = new PgPool({
      ...config,
      min: 0,
      max: 2,
      idleTimeoutMillis: 10000,
      maxLifetimeSeconds: 1800,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30000,
    });

    // Handle pool errors to prevent crashes and clean up stale pools
    pool.on("error", err => {
      logger.error("PostgreSQL pool error", { key, error: err.message });
      // Only forgotten while it is still the pool for this key: a pool that
      // was already replaced must not evict (and so leak) its successor.
      this.pools.forget(key, pool);
      pool.end().catch(endErr => {
        logger.error("Error closing PostgreSQL pool after error", {
          key,
          error: endErr,
        });
      });
    });

    logger.debug("Created PostgreSQL pool", { key });
    return pool;
  }

  getConnection(database: IDatabaseConnection): Promise<PgPool> {
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
    try {
      const config = buildPostgreSQLConfig(database);

      // A temporary client (not the pool), retried over transient failures.
      await withRetry(
        async () => {
          const client = new PgClient(config);
          try {
            await client.connect();
            await client.query("SELECT 1");
          } finally {
            await client.end();
          }
        },
        {
          maxRetries: POSTGRES_MAX_RETRIES,
          baseDelayMs: POSTGRES_RETRY_BASE_DELAY_MS,
        },
      );

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "PostgreSQL connection failed",
      };
    }
  }

  /** A pooled client, retried over transient failures and cold starts. */
  private async connect(
    database: IDatabaseConnection,
    targetDatabase: string | undefined,
    signal?: AbortSignal,
  ): Promise<PoolClient> {
    const pool = await this.getPool(database, targetDatabase);
    // The pool keeps min: 0, so a connection may need to be established fresh.
    return withRetry(async () => pool.connect(), {
      maxRetries: POSTGRES_MAX_RETRIES,
      baseDelayMs: POSTGRES_RETRY_BASE_DELAY_MS,
      signal,
    });
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: DatabaseQuery,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    const executionId = options?.executionId;
    const signal = options?.signal;

    // Determine the target database: options override or connection default
    const targetDatabase =
      options?.databaseName || database.connection.database;

    try {
      if (signal?.aborted) {
        return { success: false, error: "Query cancelled" };
      }

      const client = await this.connect(database, targetDatabase, signal);

      let readOnlyTransactionStarted = false;
      let release: (() => void) | undefined;
      try {
        // Cancellable by executionId (cancelQuery) and by the signal alone.
        release = await this.trackQuery(database, client, executionId, signal);

        if (signal?.aborted) {
          return { success: false, error: "Query cancelled" };
        }

        const text = query as string;
        let result: PgQueryResult;
        if (options?.readOnly || options?.readOnlyTransaction) {
          readOnlyTransactionStarted = true;
          result = ownResult(
            (await client.query(inReadOnlyTransaction(text))) as
              PgQueryResult | PgQueryResult[],
          );
          readOnlyTransactionStarted = false;
        } else {
          result = await client.query(text);
        }
        const fields = normalizePostgresFields(result.fields);
        const rows = normalizePostgresRows(
          result.rows as Record<string, unknown>[],
          fields,
        );
        return {
          success: true,
          data: rows,
          rowCount: result.rowCount ?? undefined,
          fields,
        };
      } finally {
        if (readOnlyTransactionStarted) {
          await client.query("ROLLBACK").catch(() => undefined);
        }
        // Always release the client back to the pool
        if (release) release();
        else client.release();
      }
    } catch (error) {
      if (cancelled(error, "canceling statement")) {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "PostgreSQL query failed",
      };
    }
  }

  /**
   * `query` (one statement `cursorReadable` passed) through a cursor:
   * DECLARE once, FETCH a batch at a time in one transaction (read-only
   * where the caller may not write), so the statement runs once and is one
   * snapshot.
   */
  async readCursor(
    database: IDatabaseConnection,
    query: string,
    options: CursorReadOptions,
  ): Promise<QueryResult> {
    const { executionId, signal, timeoutMs } = options;
    const fetchRows = Math.max(
      1,
      Math.floor(options.fetchRows ?? CURSOR_FETCH_ROWS),
    );
    const keepRows = options.keepRows !== false;
    try {
      if (signal?.aborted) return { success: false, error: "Query cancelled" };
      const client = await this.connect(
        database,
        options.databaseName || database.connection.database,
        signal,
      );
      let open = false;
      let release: (() => void) | undefined;
      try {
        release = await this.trackQuery(database, client, executionId, signal);
        await client.query(
          options.readOnly || options.readOnlyTransaction
            ? "BEGIN TRANSACTION READ ONLY"
            : "BEGIN",
        );
        open = true;
        if (timeoutMs) {
          await client.query(
            `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`,
          );
        }
        // On its own lines: a trailing `-- comment` cannot eat the rest.
        await client.query(
          `DECLARE _mako_rows NO SCROLL CURSOR FOR\n${query}\n`,
        );
        const rows: Record<string, unknown>[] = [];
        let rowCount = 0;
        let fields: ReturnType<typeof normalizePostgresFields> | undefined;
        for (;;) {
          if (signal?.aborted) {
            return { success: false, error: "Query cancelled" };
          }
          // pg reads query_timeout per query; its types do not list it.
          const batch = await client.query({
            text: `FETCH ${fetchRows} FROM _mako_rows`,
            ...(timeoutMs ? { query_timeout: timeoutMs } : {}),
          } as { text: string });
          fields ??= normalizePostgresFields(batch.fields);
          const batchRows = normalizePostgresRows(
            batch.rows as Record<string, unknown>[],
            fields,
          );
          // StopReading ends the read with what was read (a row cap).
          let stop = false;
          if (keepRows || batchRows.length > 0) {
            try {
              await options.onRows(batchRows);
            } catch (error) {
              if (!(error instanceof StopReading)) throw error;
              stop = true;
            }
          }
          rowCount += batchRows.length;
          if (keepRows) rows.push(...batchRows);
          if (stop || batch.rows.length < fetchRows) break;
        }
        await client.query("COMMIT");
        open = false;
        return {
          success: true,
          data: keepRows ? rows : undefined,
          rowCount,
          fields,
        };
      } finally {
        if (open) await client.query("ROLLBACK").catch(() => undefined);
        if (release) release();
        else client.release();
      }
    } catch (error) {
      if (cancelled(error, "canceling statement due to user request")) {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "PostgreSQL query failed",
      };
    }
  }

  /**
   * Make a checked-out client's statements cancellable — by `executionId`
   * (cancelQuery) and by `signal` on its own — via `pg_cancel_backend` on
   * the client's backend pid (`client.processID`: no extra round trip).
   *
   * Returns the function that MUST replace `client.release()`: it
   * unregisters, and when a cancel was sent it destroys the client instead
   * of pooling it, so a cancel still in flight cannot land on whatever
   * query that backend runs next.
   */
  private async trackQuery(
    database: IDatabaseConnection,
    client: PoolClient,
    executionId?: string,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (!executionId && !signal) return () => client.release();
    const pid = await pgBackendPid(client);
    if (!pid) return () => client.release();

    const entry: RunningPostgresQuery = { database, pid };
    if (executionId) this.runningQueries.set(executionId, entry);
    const onAbort = () => {
      if (entry.cancelled) return;
      entry.cancelled = true;
      void this.cancelBackend(database, pid).then(result => {
        if (!result.success) {
          logger.warn("PostgreSQL cancel on abort failed", {
            pid,
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
      client.release(entry.cancelled ? true : undefined);
    };
  }

  /**
   * Cancel a running PostgreSQL query
   *
   * IMPORTANT: This intentionally creates a dedicated client outside the pool.
   * Since the pool has limited connections (max: 2), using pool.query() would
   * deadlock if all connections are occupied by running queries—the cancellation
   * request would wait for a connection that can never be released because the
   * query being cancelled is holding it.
   */
  async cancelQuery(executionId: string): Promise<CancelResult> {
    const query = this.runningQueries.get(executionId);
    if (!query) {
      return { success: false, error: QUERY_NOT_FOUND };
    }
    // Marked first: the query's release then retires its client (see
    // trackQuery) rather than pool a backend a cancel is aimed at.
    query.cancelled = true;
    const result = await this.cancelBackend(query.database, query.pid);
    if (result.success) this.runningQueries.delete(executionId);
    return result;
  }

  /**
   * `pg_cancel_backend(pid)` from a dedicated connection outside the pool
   * (a pooled one could deadlock: see cancelQuery).
   */
  async cancelBackend(
    database: IDatabaseConnection,
    pid: number,
  ): Promise<CancelResult> {
    let cancelClient: PgClient | null = null;
    try {
      cancelClient = new PgClient(buildPostgreSQLConfig(database));
      await cancelClient.connect();
      const res = await cancelClient.query<{ cancelled: boolean }>(
        "SELECT pg_cancel_backend($1) as cancelled",
        [pid],
      );
      const cancelledBackend = res.rows?.[0]?.cancelled;
      if (!cancelledBackend) {
        return {
          success: false,
          error: "Failed to cancel query (pg_cancel_backend returned false)",
        };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to cancel query",
      };
    } finally {
      if (cancelClient) {
        await cancelClient.end().catch(() => {});
      }
    }
  }
}

/** The one engine every PostgreSQL and Redshift connection shares. */
export const postgresEngine = new PostgresEngine();
