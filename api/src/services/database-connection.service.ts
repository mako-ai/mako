import { checkConnectionWrite } from "../access/connection-writes";
import type { Db, MongoClient } from "mongodb";
import { IDatabaseConnection } from "../database/workspace-schema";
import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import { DatabaseDriver } from "../databases/driver";
import type {
  CancelResult,
  CursorReadOptions,
  QueryExecuteOptions,
  QueryPreviewOptions,
  QueryPreviewResult,
  QueryResult,
  ReadingRowsOptions,
  StreamingQueryOptions,
} from "../databases/query-types";
import { CloudSQLPostgresDatabaseDriver } from "../databases/drivers/cloudsql-postgres/driver";
import { CloudflareD1DatabaseDriver } from "../databases/drivers/cloudflare-d1/driver";
import { CloudflareKVDatabaseDriver } from "../databases/drivers/cloudflare-kv/driver";
import { mapPostgresOidToType } from "../databases/drivers/postgresql/pg-type-utils";
import {
  mongoEngine,
  type ConnectionConfig,
  type ConnectionContext,
} from "../databases/drivers/mongodb/engine";
import { mysqlEngine } from "../databases/drivers/mysql/engine";
import { mssqlEngine } from "../databases/drivers/mssql/engine";
import { clickHouseEngine } from "../databases/drivers/clickhouse/engine";
import {
  cursorReadable,
  postgresEngine,
} from "../databases/drivers/postgresql/engine";
import { loggers } from "../logging";
import { createBigQueryPollBudget } from "./bigquery-poll-budget";
import { databaseRegistry } from "../databases/registry";
import { isLocalBigQueryEmulator } from "../utils/bigquery-emulator";
import { bigQueryJobLabels } from "./bigquery-labels";
import {
  buildBigQueryCursor,
  buildPreviewPage,
  checkPreviewQuerySafety,
  decodePreviewCursor,
  hashPreviewQuery,
  inferFieldsFromRows,
  prepareSqlBatchQuery,
  prepareSqlPreviewQuery,
  resolvePreviewPageSize,
} from "./query-pagination.service";

const logger = loggers.db();

export type {
  ConnectionConfig,
  ConnectionContext,
} from "../databases/drivers/mongodb/engine";
export type {
  QueryExecuteOptions,
  QueryPreviewOptions,
  QueryPreviewResult,
  QueryResult,
} from "../databases/query-types";

/**
 * Extract a human-readable message from a Google/BigQuery API error.
 *
 * Handles the two distinct error-body shapes Google returns, both of which the
 * old `error?.response?.data?.error?.message` chain silently dropped:
 *
 * - BigQuery / Google REST API:  `{ error: { code, message, errors: [...] } }`
 *     → `data.error.message` (object shape)
 * - OAuth2 token endpoint:       `{ error: "invalid_grant", error_description }`
 *     → `data.error` is a STRING, so `.message` is `undefined` and the real
 *       reason (e.g. a rotated/disabled service-account key) gets masked as a
 *       generic "Request failed with status code 400".
 *
 * Always includes the HTTP status code so the caller sees 400/401/403 etc.
 */
/**
 * How a timed-out BigQuery query ended, said accurately.
 *
 * The old message always claimed the query "may still be running", which was
 * true only because nothing tried to stop it. Now that we do, the message has
 * to distinguish the two outcomes — a cancelled job stops scanning and stops
 * billing, and telling someone otherwise sends them hunting a job that is
 * already gone.
 */
function bqAbandonedSuffix(cancelled: boolean): string {
  return cancelled
    ? " and was cancelled in BigQuery."
    : ". The query may still be running in BigQuery.";
}

function describeGoogleApiError(error: any, fallback: string): string {
  const status: number | undefined = error?.response?.status;
  const data = error?.response?.data;
  let detail: string | undefined;

  if (data && typeof data === "object") {
    const errField = (data as any).error;
    if (
      errField &&
      typeof errField === "object" &&
      typeof errField.message === "string"
    ) {
      // BigQuery / Google REST API shape
      detail = errField.message;
    } else if (typeof errField === "string") {
      // OAuth2 token endpoint shape: { error, error_description }
      const description = (data as any).error_description;
      detail =
        typeof description === "string" && description.trim()
          ? `${errField}: ${description}`
          : errField;
    }
  } else if (typeof data === "string" && data.trim()) {
    detail = data.trim();
  }

  const message =
    detail ||
    (typeof error?.message === "string" && error.message.trim()
      ? error.message
      : fallback);

  return status ? `${message} (HTTP ${status})` : message;
}

/**
 * Non-SQL engines whose queries cannot be validated by the lexical read-only
 * analyzer (`checkPreviewQuerySafety`). Under `readOnly` these fail closed in
 * `executeQuery`; SQL engines (incl. BigQuery) are enforced read-only lexically
 * instead — see `executeQuery`.
 */
const READ_ONLY_UNSUPPORTED_TYPES = new Set<string>([
  "mongodb",
  "cloudflare-kv",
]);

/**
 * Enhanced Database Connection Service
 *
 * Provides unified connection management for all database types with:
 * - Advanced MongoDB connection pooling with health checks
 * - Multi-database support (PostgreSQL, MySQL, MSSQL, BigQuery, Cloudflare D1/KV)
 * - Automatic reconnection and idle cleanup
 * - Unified query execution interface
 */
export class DatabaseConnectionService {
  // Track running BigQuery jobs for cancellation
  private runningBigQueryJobs: Map<
    string,
    {
      projectId: string;
      jobId: string;
      location?: string;
      client: AxiosInstance;
    }
  > = new Map();

  // Engine-agnostic registry of detached (resumable) executions, layered over
  // the per-engine cancel maps above. Holds the detached task's AbortController
  // plus light metadata so a long query can be cancelled by executionId from
  // any turn (or by the server-side hard cap). The per-engine maps still do the
  // engine-native cancel (pid / query_id / opid / request / BQ jobId).
  private runningExecutions: Map<
    string,
    {
      abortController: AbortController;
      startedAt: number;
      consoleId?: string;
      workspaceId?: string;
    }
  > = new Map();

  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly userDatabaseMaxIdleTime = 15 * 60 * 1000; // 15 minutes - keep user database pools alive during active sessions

  // BigQuery auth/client caching (in-memory)
  private bigQueryClientCache: Map<
    string,
    { client: AxiosInstance; token: string; expiresAtMs: number }
  > = new Map();
  private bigQueryTokenInFlight: Map<
    string,
    Promise<{ token: string; expiresAtMs: number }>
  > = new Map();

  // The stateful drivers this service delegates to. They live in the shared
  // registry (index.ts registers the same slots), never in a private copy:
  // two instances would mean two sets of pools to one instance, and a
  // cancelQuery that cannot see queries started through the other one.
  private get cloudSqlDriver(): CloudSQLPostgresDatabaseDriver {
    return databaseRegistry.getOrRegister(
      "cloudsql-postgres",
      () => new CloudSQLPostgresDatabaseDriver(),
    );
  }

  private get d1Driver(): CloudflareD1DatabaseDriver {
    return databaseRegistry.getOrRegister(
      "cloudflare-d1",
      () => new CloudflareD1DatabaseDriver(),
    );
  }

  private get kvDriver(): CloudflareKVDatabaseDriver {
    return databaseRegistry.getOrRegister(
      "cloudflare-kv",
      () => new CloudflareKVDatabaseDriver(),
    );
  }

  constructor() {
    // Start cleanup interval for idle connections (MongoDB, PostgreSQL, MySQL,
    // Cloud SQL)
    this.cleanupInterval = setInterval(() => {
      void mongoEngine.sweepIdleConnections(this.userDatabaseMaxIdleTime);
      void postgresEngine.sweepIdleConnections(this.userDatabaseMaxIdleTime);
      void mysqlEngine.sweepIdleConnections(this.userDatabaseMaxIdleTime);
      void this.cloudSqlDriver
        .cleanupIdleConnections(this.userDatabaseMaxIdleTime)
        .catch(error =>
          logger.error("Error sweeping idle Cloud SQL pools", { error }),
        );
    }, 60000); // Every minute
    // Housekeeping must not be a reason for the process to stay alive. The
    // singleton below is constructed on IMPORT, so this timer starts in
    // anything that so much as mentions this module — a test, a migration, a
    // CLI — and an interval Node counts keeps the event loop non-empty
    // forever: the work finishes, nothing exits, and it reads as a hang with
    // no error. The server is unaffected (its listener holds the loop open on
    // its own) and the sweep still runs every 60s there. ssh-tunnel.service
    // unrefs its sweep timer for exactly this reason.
    this.cleanupInterval.unref();
  }

  /**
   * Test database connection
   */
  async testConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      switch (database.type) {
        case "mongodb":
          return await mongoEngine.testConnection(database);
        case "postgresql":
        case "redshift":
          return await postgresEngine.testConnection(database);
        case "mysql":
          return await mysqlEngine.testConnection(database);
        case "mssql":
          return await mssqlEngine.testConnection(database);
        case "bigquery":
          return await this.testBigQueryConnection(database);
        case "clickhouse":
          return await clickHouseEngine.testConnection(database);
        case "cloudsql-postgres":
          return await this.cloudSqlDriver.testConnection(database);
        case "cloudflare-d1":
          return await this.d1Driver.testConnection(database);
        case "cloudflare-kv":
          return await this.kvDriver.testConnection(database);
        default:
          return {
            success: false,
            error: `Unsupported database type: ${database.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute query on database
   */
  async executeQuery(
    database: IDatabaseConnection,
    query: any,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    try {
      // Writes are for the connection's writers; a read returns from this
      // at once, in memory (access/connection-writes.ts).
      const check = await checkConnectionWrite(database, query, options);
      if (check.refused) return { success: false, error: check.refused };
      if (check.readOnlyTransaction) {
        options = { ...options, readOnlyTransaction: true };
      }
      if (options?.readOnly) {
        if (typeof query !== "string") {
          return {
            success: false,
            error:
              "Read-only execution only supports SQL strings; arbitrary MongoDB execution is disabled",
          };
        }
        // Lexical read-only validation is the uniform guarantee. Engines with a
        // session/transaction read-only mode (Postgres READ ONLY txn, ClickHouse
        // readonly=2, ...) additionally enforce it below; SQL engines without one
        // (e.g. BigQuery) rely on this validated single SELECT/WITH statement.
        const safety = checkPreviewQuerySafety(query);
        if (!safety.safe) {
          return { success: false, error: safety.errors.join(" ") };
        }
        // Non-SQL engines can't be validated by the SQL analyzer, so fail closed.
        if (READ_ONLY_UNSUPPORTED_TYPES.has(database.type)) {
          return {
            success: false,
            error: `Read-only execution is not supported for ${database.type}; connect it with database credentials restricted to read access`,
          };
        }
      }

      switch (database.type) {
        case "mongodb":
          return await mongoEngine.executeQuery(database, query, options);
        case "postgresql":
        case "redshift":
          return await this.executePostgreSQLQuery(database, query, options);
        case "cloudsql-postgres":
          return await this.cloudSqlDriver.executeQuery(
            database,
            query,
            options,
          );
        case "mysql":
          return await mysqlEngine.executeQuery(database, query, options);
        case "mssql":
          return await mssqlEngine.executeQuery(database, query, options);
        case "bigquery":
          return await this.executeBigQueryQuery(database, query, options);
        case "clickhouse":
          return await clickHouseEngine.executeQuery(database, query, options);
        case "cloudflare-d1":
          return await this.d1Driver.executeQuery(database, query, options);
        case "cloudflare-kv":
          return await this.kvDriver.executeQuery(database, query, options);
        default:
          return {
            success: false,
            error: `Unsupported database type: ${database.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Run `query` exactly once and read its whole result, handing each batch
   * of rows to `options.onRows` as it arrives (it throws to stop reading;
   * StopReading stops a Postgres cursor read with the rows read so far).
   * On Postgres a read goes through a cursor in one transaction, so a result
   * past the caller's limit is never held whole; BigQuery reads its job's
   * pages; any other engine, or a write, returns its result whole first.
   */
  async executeQueryReadingRows(
    database: IDatabaseConnection,
    query: string,
    options: ReadingRowsOptions,
  ): Promise<QueryResult> {
    const check = await checkConnectionWrite(database, query, options);
    if (check.refused) return { success: false, error: check.refused };
    options = {
      ...options,
      writeChecked: true,
      readOnlyTransaction:
        options.readOnlyTransaction || check.readOnlyTransaction,
    };
    const readable =
      database.type === "postgresql" ? cursorReadable(query) : null;
    if (readable !== null) {
      return this.executePostgreSQLCursor(database, readable, options);
    }
    let read = false;
    const result = await this.executeQuery(database, query, {
      ...options,
      bigQueryJobMaxWaitMs: options.timeoutMs ?? options.bigQueryJobMaxWaitMs,
      onRows: rows => {
        read = true;
        options.onRows(rows);
      },
    });
    if (result.success && !read && Array.isArray(result.data)) {
      try {
        options.onRows(result.data as Record<string, unknown>[]);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return result;
  }

  async executePreviewQuery(
    database: IDatabaseConnection,
    query: any,
    options?: QueryPreviewOptions,
  ): Promise<QueryPreviewResult> {
    try {
      const check = await checkConnectionWrite(database, query, options);
      if (check.refused) return { success: false, error: check.refused };
      options = {
        ...options,
        writeChecked: true,
        readOnlyTransaction:
          options?.readOnlyTransaction || check.readOnlyTransaction,
      };
      if (
        !options?.readOnly &&
        database.type === "bigquery" &&
        typeof query === "string"
      ) {
        return await this.executeBigQueryPreviewQuery(database, query, options);
      }

      if (
        typeof query !== "string" ||
        database.type === "mongodb" ||
        database.type === "cloudflare-kv"
      ) {
        const result = await this.executeQuery(database, query, options);
        if (!result.success) {
          return {
            success: false,
            error: result.error,
          };
        }

        const { pageSize, capApplied } = resolvePreviewPageSize(
          options?.pageSize,
        );
        const rows = Array.isArray(result.data)
          ? (result.data as Record<string, unknown>[])
          : result.data == null
            ? []
            : [result.data as Record<string, unknown>];
        const page = buildPreviewPage({
          rows,
          pageSize,
          capApplied,
          query: typeof query === "string" ? query : JSON.stringify(query),
        });

        return {
          success: true,
          rows: page.rows,
          rowCount: page.pageInfo.returnedRows,
          fields: this.normalizeQueryFields(result.fields, page.rows),
          pageInfo: page.pageInfo,
          warnings: result.truncated
            ? [
                ...(page.warnings ?? []),
                `Only the first ${rows.length} documents were read (server row cap). Narrow the query with a filter, $group or .limit().`,
              ]
            : page.warnings,
        };
      }

      const prepared = prepareSqlPreviewQuery({
        query,
        databaseType: database.type,
        pageSize: options?.pageSize,
        cursor: options?.cursor,
      });

      const result = await this.executeQuery(
        database,
        prepared.paginatedQuery,
        {
          databaseName: options?.databaseName,
          databaseId: options?.databaseId,
          executionId: options?.executionId,
          signal: options?.signal,
          readOnly: options?.readOnly,
          actor: options?.actor,
          writeChecked: true,
          readOnlyTransaction: options?.readOnlyTransaction,
        },
      );

      if (!result.success) {
        return {
          success: false,
          error: result.error,
        };
      }

      const rows = Array.isArray(result.data)
        ? (result.data as Record<string, unknown>[])
        : [];
      const page = buildPreviewPage({
        rows,
        pageSize: prepared.pageSize,
        capApplied: prepared.capApplied,
        query,
        offset: prepared.offset,
        warnings: prepared.warnings,
      });

      return {
        success: true,
        rows: page.rows,
        rowCount: page.pageInfo.returnedRows,
        fields: this.normalizeQueryFields(result.fields, page.rows),
        pageInfo: page.pageInfo,
        warnings: page.warnings,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Preview query failed",
      };
    }
  }

  async executeStreamingQuery(
    database: IDatabaseConnection,
    query: any,
    options: StreamingQueryOptions & QueryExecuteOptions,
  ): Promise<{ success: boolean; totalRows: number; error?: string }> {
    const check = await checkConnectionWrite(database, query, options);
    if (check.refused) {
      return { success: false, totalRows: 0, error: check.refused };
    }
    options = {
      ...options,
      writeChecked: true,
      readOnlyTransaction:
        options.readOnlyTransaction || check.readOnlyTransaction,
    };
    // Read-only enforcement is engine-agnostic: validate the query lexically
    // once, up front. Engines with a session read-only mode additionally get it
    // via executeQuery below; engines without one (e.g. BigQuery, whose native
    // streaming path bypasses executeQuery) rely solely on this check.
    if (options.readOnly && typeof query === "string") {
      const safety = checkPreviewQuerySafety(query);
      if (!safety.safe) {
        return { success: false, totalRows: 0, error: safety.errors.join(" ") };
      }
    }

    // BigQuery paginates via native job page tokens, not offset batches, so it
    // always streams through its native path.
    if (database.type === "bigquery" && typeof query === "string") {
      return await this.executeBigQueryStreamingQuery(database, query, options);
    }

    const batchSize = Math.max(1, Math.floor(options.batchSize || 1000));

    // A Postgres read streams through a real server-side cursor: the query
    // runs ONCE, in one transaction/snapshot, and batches are FETCHed in the
    // query's own order. (OFFSET pages re-run the query per page and, with
    // no ORDER BY, may skip or repeat rows between pages.) Same path with
    // or without readOnly; the cursor's transaction is READ ONLY when asked.
    const readable =
      database.type === "postgresql" && typeof query === "string"
        ? cursorReadable(query)
        : null;
    if (readable !== null) {
      let streamed = 0;
      const result = await this.executePostgreSQLCursor(database, readable, {
        databaseName: options.databaseName,
        databaseId: options.databaseId,
        executionId: options.executionId,
        signal: options.signal,
        readOnly: options.readOnly,
        actor: options.actor,
        writeChecked: true,
        readOnlyTransaction: options.readOnlyTransaction,
        fetchRows: batchSize,
        keepRows: false,
        onRows: async rows => {
          await options.onBatch(rows);
          streamed += rows.length;
        },
      });
      return result.success
        ? { success: true, totalRows: streamed }
        : { success: false, totalRows: streamed, error: result.error };
    }

    if (
      database.type === "mongodb" ||
      database.type === "cloudflare-kv" ||
      typeof query !== "string"
    ) {
      const result = await this.executeQuery(database, query, options);
      if (!result.success) {
        return { success: false, totalRows: 0, error: result.error };
      }
      const rows = Array.isArray(result.data)
        ? (result.data as Record<string, unknown>[])
        : result.data == null
          ? []
          : [result.data as Record<string, unknown>];
      if (rows.length > 0) {
        await options.onBatch(rows);
      }
      return { success: true, totalRows: rows.length };
    }

    let totalRows = 0;
    let offset = 0;

    try {
      for (;;) {
        if (options.signal?.aborted) {
          return { success: false, totalRows, error: "Query cancelled" };
        }

        const prepared = prepareSqlBatchQuery({
          query: String(query),
          databaseType: database.type,
          batchSize,
          offset,
        });

        const result = await this.executeQuery(database, prepared.query, {
          databaseName: options.databaseName,
          databaseId: options.databaseId,
          executionId: options.executionId,
          signal: options.signal,
          readOnly: options.readOnly,
          actor: options.actor,
          writeChecked: true,
          readOnlyTransaction: options.readOnlyTransaction,
        });

        if (!result.success) {
          return { success: false, totalRows, error: result.error };
        }

        const rows = Array.isArray(result.data)
          ? (result.data as Record<string, unknown>[])
          : [];

        if (rows.length === 0) {
          break;
        }

        await options.onBatch(rows);
        totalRows += rows.length;
        offset += rows.length;

        if (rows.length < batchSize) {
          break;
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

  async getStreamingQueryFields(
    database: IDatabaseConnection,
    query: any,
    options: QueryExecuteOptions = {},
  ): Promise<{
    success: boolean;
    fields?: Array<{ name: string; type?: string }>;
    error?: string;
  }> {
    if (database.type === "cloudflare-kv") {
      return {
        success: false,
        error: "Arrow export is not supported for this database type",
      };
    }

    // BigQuery paginates via native job page tokens, not offset batches, so it
    // must never reach the offset-batch probe below (`prepareSqlBatchQuery`
    // hard-throws for BigQuery). Probe its schema through the native dry-run
    // directly — registry-independent, exactly like `executeStreamingQuery`
    // special-cases BigQuery — so the probe works even where the driver
    // registry is not populated. The dry-run never executes the query, so it
    // is safe regardless of `readOnly`.
    if (database.type === "bigquery" && typeof query === "string") {
      const schema = await this.getBigQueryQuerySchema(database, query);
      if (!schema.success) {
        return { success: false, error: schema.error };
      }
      const fields = (schema.columns || []).map(column => ({
        name: column.name,
        type: column.type,
      }));
      if (fields.length === 0) {
        return {
          success: false,
          error: "Unable to determine query schema for Arrow export",
        };
      }
      return { success: true, fields };
    }

    // Schema introspection (dry-run / describe / `LIMIT 0`) never mutates data,
    // so it is always used regardless of `readOnly`. Gating it on `readOnly`
    // (previously the case) forced every engine onto a `LIMIT 1` sample probe —
    // degrading type fidelity everywhere and breaking BigQuery, whose native
    // dry-run was skipped in favor of an unsupported offset-batch probe.
    if (typeof query === "string") {
      const driver = databaseRegistry.getDriver(database.type);
      if (driver?.getQuerySchema) {
        const result = await driver.getQuerySchema(database, query, {
          databaseName: options.databaseName,
        });
        if (!result.success) {
          return { success: false, error: result.error };
        }

        const fields = (result.columns || []).map(column => ({
          name: column.name,
          type: column.type,
        }));
        if (fields.length > 0) {
          return { success: true, fields };
        }
      }
    }

    const probeQuery =
      typeof query === "string"
        ? prepareSqlBatchQuery({
            query,
            databaseType: database.type,
            batchSize: 1,
            offset: 0,
          }).query
        : query;

    const probe = await this.executeQuery(database, probeQuery, {
      databaseId: options.databaseId,
      databaseName: options.databaseName,
      signal: options.signal,
      readOnly: options.readOnly,
    });

    if (!probe.success) {
      return { success: false, error: probe.error };
    }

    const rows = Array.isArray(probe.data)
      ? (probe.data as Record<string, unknown>[])
      : probe.data == null
        ? []
        : [probe.data as Record<string, unknown>];
    const fields = this.normalizeQueryFields(probe.fields, rows);

    if (fields.length === 0) {
      return {
        success: false,
        error: "Unable to determine query schema for Arrow export",
      };
    }

    return { success: true, fields };
  }

  /**
   * Get database connection
   */
  async getConnection(database: IDatabaseConnection): Promise<any> {
    // For MongoDB, use advanced pooling
    if (database.type === "mongodb") {
      return mongoEngine.getConnection(database);
    }

    // For PostgreSQL and Redshift (PostgreSQL wire-compatible), use dedicated pool management
    if (database.type === "postgresql" || database.type === "redshift") {
      return postgresEngine.getPool(database);
    }

    // For MySQL, use dedicated pool management
    if (database.type === "mysql") {
      return mysqlEngine.getPool(database);
    }

    switch (database.type) {
      case "cloudsql-postgres":
        return this.cloudSqlDriver.getConnection(database);
      case "mssql":
        return mssqlEngine.getConnection(database);
      case "bigquery":
      case "clickhouse":
        // Stateless HTTP requests: no persistent connection
        return null;
      default:
        throw new Error(`Unsupported database type: ${database.type}`);
    }
  }

  /**
   * Close database connection. Same as {@link invalidateConnection}.
   */
  async closeConnection(databaseId: string): Promise<void> {
    await this.invalidateConnection(databaseId);
  }

  /**
   * Drop every cached pool, client, connector and HTTP client held for a
   * connection, in this service and in every registered driver, so the next
   * query connects afresh from the saved configuration.
   *
   * Call it whenever a connection's configuration changes (edit) or the
   * connection goes away (delete): all of these caches are keyed by the
   * connection id alone, so without it an edited host or rotated password
   * keeps being served by the pool built from the old one.
   */
  async invalidateConnection(databaseId: string): Promise<void> {
    const steps: Array<[string, () => Promise<void> | void]> = [
      ["mongodb", () => mongoEngine.closeConnection(databaseId)],
      ["postgresql", () => postgresEngine.closeConnection(databaseId)],
      ["mysql", () => mysqlEngine.closeConnection(databaseId)],
      ["mssql", () => mssqlEngine.closeConnection(databaseId)],
    ];
    for (const driver of databaseRegistry.getAllDrivers()) {
      if (typeof driver.closeConnection === "function") {
        steps.push([
          `driver:${driver.getMetadata().type}`,
          () => driver.closeConnection?.(databaseId),
        ]);
      }
    }
    // One failing cache must not keep the others serving stale config.
    for (const [cache, close] of steps) {
      try {
        await close();
      } catch (error) {
        logger.error("Error invalidating cached connection", {
          databaseId,
          cache,
          error,
        });
      }
    }
  }

  /**
   * Close all connections
   */
  async closeAllConnections(): Promise<void> {
    // Close MongoDB connections
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Close MongoDB connections, including ones still connecting
    await mongoEngine.closeAllConnections();

    // Close PostgreSQL pools
    await postgresEngine.closeAllConnections();

    // Close MySQL pools
    await mysqlEngine.closeAllConnections();

    // Close MSSQL pools
    await mssqlEngine.closeAllConnections();

    // Close every pool, connector and client the registered drivers hold
    for (const driver of databaseRegistry.getAllDrivers()) {
      if (typeof driver.closeAllConnections !== "function") continue;
      try {
        await driver.closeAllConnections();
      } catch (error) {
        logger.error("Error closing driver connections", {
          driver: driver.getMetadata().type,
          error,
        });
      }
    }
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    totalConnections: number;
    mongodb: number;
    other: number;
    mongoConnections: Array<{
      key: string;
      context: ConnectionContext;
      identifier: string;
      lastUsed: Date;
    }>;
  } {
    const mongoConnections = mongoEngine.getStats();

    return {
      totalConnections: mongoConnections.length + mssqlEngine.pools.size,
      mongodb: mongoConnections.length,
      other: mssqlEngine.pools.size,
      mongoConnections,
    };
  }

  // Convenience methods for MongoDB connections

  /** Connection for Mako's own database (DATABASE_URL). */
  getMainConnection(): Promise<{ client: MongoClient; db: Db }> {
    return mongoEngine.getMainConnection();
  }

  /** Connection by database ID (for destinations/datasources). */
  getConnectionById(
    context: ConnectionContext,
    databaseId: string,
    lookupFn: (id: string) => Promise<ConnectionConfig | null>,
  ): Promise<{ client: MongoClient; db: Db }> {
    return mongoEngine.getConnectionById(context, databaseId, lookupFn);
  }

  /** Update the last used time for a connection to keep it alive */
  updateConnectionLastUsed(
    context: ConnectionContext,
    identifier: string,
  ): void {
    mongoEngine.touch(context, identifier);
  }

  /** Cancel a running ClickHouse query by its executionId. */
  cancelClickHouseQuery(executionId: string): Promise<CancelResult> {
    return clickHouseEngine.cancelQuery(executionId);
  }

  /** Cancel a running MongoDB query by its executionId. */
  cancelMongoDBQuery(executionId: string): Promise<CancelResult> {
    return mongoEngine.cancelQuery(executionId);
  }

  // -------------------- BigQuery helpers --------------------
  // Public: list BigQuery datasets (by datasetId)
  async listBigQueryDatasets(database: IDatabaseConnection): Promise<string[]> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );

    const datasets: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: any = { maxResults: 1000 };
      if (pageToken) params.pageToken = pageToken;
      const res = await client.get(`/projects/${project_id}/datasets`, {
        params,
      });
      const data = res.data || {};
      const items: any[] = Array.isArray(data.datasets) ? data.datasets : [];
      for (const ds of items) {
        const id = ds?.datasetReference?.datasetId;
        if (id) datasets.push(id);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return datasets.sort((a, b) => a.localeCompare(b));
  }

  /**
   * List all D1 databases in a Cloudflare account
   * Returns both uuid (for API calls) and name (human-readable)
   */
  async listD1Databases(
    database: IDatabaseConnection,
  ): Promise<Array<{ uuid: string; name: string }>> {
    if (database.type !== "cloudflare-d1") {
      throw new Error(
        "listD1Databases only works with cloudflare-d1 connections",
      );
    }

    const databases = await this.d1Driver.listDatabases(database);
    return databases.map(db => ({
      uuid: db.uuid,
      name: db.name,
    }));
  }

  // Public (autocomplete): list BigQuery datasets with prefix/limit and early-stop pagination
  async listBigQueryDatasetsForAutocomplete(
    database: IDatabaseConnection,
    opts?: { prefix?: string; limit?: number },
  ): Promise<string[]> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }

    const prefix = String(opts?.prefix || "");
    const limit = Math.max(1, Math.min(200, Number(opts?.limit || 100)));

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );

    const datasets: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: any = { maxResults: 1000 };
      if (pageToken) params.pageToken = pageToken;
      const res = await client.get(`/projects/${project_id}/datasets`, {
        params,
      });
      const data = res.data || {};
      const items: any[] = Array.isArray(data.datasets) ? data.datasets : [];
      for (const ds of items) {
        const id = ds?.datasetReference?.datasetId;
        if (!id) continue;
        if (prefix && !String(id).startsWith(prefix)) continue;
        datasets.push(String(id));
        if (datasets.length >= limit) {
          return datasets;
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return datasets.sort((a, b) => a.localeCompare(b));
  }

  // Public: get columns for a single BigQuery table (for incremental autocomplete)
  async getBigQueryTableColumns(
    database: IDatabaseConnection,
    datasetId: string,
    tableId: string,
  ): Promise<Array<{ name: string; type: string }>> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }
    if (!datasetId || !tableId) return [];

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );
    const res = await client.get(
      `/projects/${project_id}/datasets/${encodeURIComponent(
        datasetId,
      )}/tables/${encodeURIComponent(tableId)}`,
    );
    const fields: any[] = Array.isArray(res?.data?.schema?.fields)
      ? res.data.schema.fields
      : [];

    const out: Array<{ name: string; type: string }> = [];
    const flatten = (prefix: string, field: any) => {
      const name = String(field?.name || "");
      const type = String(field?.type || "");
      if (!name) return;
      const full = prefix ? `${prefix}.${name}` : name;
      out.push({ name: full, type });
      const nested: any[] = Array.isArray(field?.fields) ? field.fields : [];
      if (String(type).toUpperCase() === "RECORD" && nested.length > 0) {
        nested.forEach(f => flatten(full, f));
      }
    };
    fields.forEach(f => flatten("", f));
    return out;
  }

  // Public (autocomplete): list BigQuery tableIds for a dataset with prefix/limit and early-stop
  async listBigQueryTableIdsForAutocomplete(
    database: IDatabaseConnection,
    datasetId: string,
    opts?: { prefix?: string; limit?: number },
  ): Promise<string[]> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }
    const prefix = String(opts?.prefix || "");
    const limit = Math.max(1, Math.min(200, Number(opts?.limit || 100)));

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );
    const out: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: any = { maxResults: 1000 };
      if (pageToken) params.pageToken = pageToken;
      const res = await client.get(
        `/projects/${project_id}/datasets/${encodeURIComponent(
          datasetId,
        )}/tables`,
        { params },
      );
      const data = res.data || {};
      const tables: any[] = Array.isArray(data.tables) ? data.tables : [];
      for (const t of tables) {
        const tableId = t?.tableReference?.tableId;
        if (!tableId) continue;
        const tid = String(tableId);
        if (prefix && !tid.startsWith(prefix)) continue;
        out.push(tid);
        if (out.length >= limit) {
          return out;
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out.sort((a, b) => a.localeCompare(b));
  }

  // Public: Get BigQuery schema (tables and columns) for autocomplete
  async getBigQuerySchema(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    const { project_id } = (database.connection as any) || {};
    if (!project_id) {
      throw new Error("BigQuery requires 'project_id' in connection");
    }

    // List all datasets first
    const datasetIds = await this.listBigQueryDatasets(database);

    const schema: Record<
      string,
      Record<string, Array<{ name: string; type: string }>>
    > = {};

    // Fetch schema for each dataset in parallel with concurrency limit
    const fetchDatasetSchema = async (datasetId: string) => {
      try {
        const query = `
          SELECT table_name, column_name, data_type 
          FROM \`${project_id}.${datasetId}.INFORMATION_SCHEMA.COLUMNS\`
          ORDER BY table_name, ordinal_position
        `;

        const result = await this.executeBigQueryQuery(database, query, {
          labels: { mako_source: "metadata" },
        });
        if (result.success && Array.isArray(result.data)) {
          if (!schema[datasetId]) schema[datasetId] = {};

          for (const row of result.data) {
            const tableName = row.table_name;
            const colName = row.column_name;
            const colType = row.data_type;

            if (!schema[datasetId][tableName]) {
              schema[datasetId][tableName] = [];
            }
            schema[datasetId][tableName].push({ name: colName, type: colType });
          }
        }
      } catch (e) {
        logger.warn("Failed to fetch schema for dataset", {
          datasetId,
          error: e,
        });
      }
    };

    const limit = 5;
    const runners: Promise<void>[] = [];
    let index = 0;
    const runNext = async () => {
      while (index < datasetIds.length) {
        const current = datasetIds[index++];
        await fetchDatasetSchema(current);
      }
    };
    for (let i = 0; i < Math.min(limit, datasetIds.length); i++) {
      runners.push(runNext());
    }
    await Promise.all(runners);

    return schema;
  }

  // Public: list BigQuery tables in a dataset
  async listBigQueryTables(
    database: IDatabaseConnection,
    datasetId: string,
  ): Promise<Array<{ name: string; type: string; options: any }>> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );

    const out: Array<{ name: string; type: string; options: any }> = [];
    let pageToken: string | undefined;
    do {
      const params: any = { maxResults: 1000 };
      if (pageToken) params.pageToken = pageToken;
      const res = await client.get(
        `/projects/${project_id}/datasets/${encodeURIComponent(
          datasetId,
        )}/tables`,
        { params },
      );
      const data = res.data || {};
      const tables: any[] = Array.isArray(data.tables) ? data.tables : [];
      for (const t of tables) {
        const tableId = t?.tableReference?.tableId;
        if (!tableId) continue;
        out.push({
          name: `${datasetId}.${tableId}`,
          type: t?.type || "TABLE",
          options: { datasetId, tableId },
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return out;
  }

  private getBigQueryPollIntervalMs(): number {
    const configured = Number.parseInt(
      process.env.BIGQUERY_QUERY_POLL_INTERVAL_MS || "",
      10,
    );
    if (!Number.isFinite(configured)) {
      return 1000;
    }
    return Math.max(100, configured);
  }

  /**
   * The `labels` map for a BigQuery job on this connection (see
   * bigquery-labels.ts), or undefined for a local emulator: emulator jobs
   * cost nothing, and an emulator that rejects the field must not fail them.
   */
  private bigQueryLabels(
    database: IDatabaseConnection,
    apiBaseUrl: string | undefined,
    options?: Pick<QueryExecuteOptions, "labels">,
  ): Record<string, string> | undefined {
    if (isLocalBigQueryEmulator(apiBaseUrl)) return undefined;
    return bigQueryJobLabels({
      workspaceId: database.workspaceId,
      explicit: options?.labels,
    });
  }

  private async testBigQueryConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { project_id, service_account_json, location, api_base_url } =
        (database.connection as any) || {};
      if (!project_id || !service_account_json) {
        return {
          success: false,
          error:
            "BigQuery requires 'project_id' and 'service_account_json' in connection",
        };
      }

      const client = await this.getBigQueryHttpClient(
        service_account_json,
        api_base_url,
      );
      const body: any = {
        query: "SELECT 1 AS one",
        useLegacySql: false,
        maxResults: 1,
      };
      if (location) body.location = location;
      const labels = this.bigQueryLabels(database, api_base_url, {
        labels: { mako_source: "connection_test" },
      });
      if (labels) body.labels = labels;
      await client.post(`/projects/${project_id}/queries`, body);
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: describeGoogleApiError(error, "BigQuery connection failed"),
      };
    }
  }

  private async executeBigQueryQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    const executionId = options?.executionId;
    const signal = options?.signal;

    const checkAborted = () => {
      if (signal?.aborted) throw new Error("Query cancelled");
    };

    try {
      checkAborted();
      if (typeof query !== "string" || !query.trim()) {
        return { success: false, error: "Query must be a non-empty string" };
      }
      const {
        project_id,
        service_account_json,
        location: dbLocation,
        api_base_url,
      } = (database.connection as any) || {};
      if (!project_id || !service_account_json) {
        return {
          success: false,
          error:
            "BigQuery requires 'project_id' and 'service_account_json' in connection",
        };
      }

      const client = await this.getBigQueryHttpClient(
        service_account_json,
        api_base_url,
      );
      const configuredLocation = options?.location || dbLocation;
      const batchSize = Math.max(
        1,
        Math.min(10000, options?.batchSize || 1000),
      );

      // Start the query
      const startBody: any = {
        query,
        useLegacySql: false,
        maxResults: batchSize,
      };
      if (configuredLocation) startBody.location = configuredLocation;
      const labels = this.bigQueryLabels(database, api_base_url, options);
      if (labels) startBody.labels = labels;
      checkAborted();
      let response = await client.post(
        `/projects/${project_id}/queries`,
        startBody,
      );

      let data = response.data || {};
      const jobId: string | undefined = data.jobReference?.jobId;
      const jobLocation: string | undefined =
        data.jobReference?.location || configuredLocation;
      let schema: any = data.schema;
      let pageToken: string | undefined = data.pageToken;
      const rowsAccum: any[] = [];

      // Track running job for cancellation
      if (executionId && jobId) {
        this.runningBigQueryJobs.set(executionId, {
          projectId: project_id,
          jobId,
          location: jobLocation,
          client,
        });
      }

      // Wait for job completion (interactive default 5m; sync MERGE etc. pass bigQueryJobMaxWaitMs)
      const configuredMax = options?.bigQueryJobMaxWaitMs;
      const maxWaitMs = Math.min(
        Math.max(
          typeof configuredMax === "number" &&
            Number.isFinite(configuredMax) &&
            configuredMax > 0
            ? configuredMax
            : 5 * 60 * 1000,
          1000,
        ),
        60 * 60 * 1000,
      );
      const pollIntervalMs = this.getBigQueryPollIntervalMs();
      // A wall-clock deadline: see bigquery-poll-budget.ts for why counting
      // only the sleeps turned 5 minutes into 55.
      const budget = createBigQueryPollBudget(maxWaitMs);

      while (data.jobComplete === false && jobId && !budget.expired()) {
        checkAborted();
        await new Promise(resolve =>
          setTimeout(resolve, budget.sleepMs(pollIntervalMs)),
        );
        checkAborted();
        if (budget.expired()) break;

        const params: any = {
          maxResults: batchSize,
          timeoutMs: budget.requestTimeoutMs(),
        };
        if (jobLocation) params.location = jobLocation;
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          { params },
        );
        data = response.data || {};
        schema = data.schema || schema;
      }

      checkAborted();
      if (data.jobComplete === false) {
        const stopped = await this.cancelAbandonedBigQueryJob({
          client,
          projectId: project_id,
          jobId: jobId as string,
          location: jobLocation,
          executionId,
        });
        return {
          success: false,
          error: `Query timed out after ${maxWaitMs / 1000} seconds${bqAbandonedSuffix(stopped)}`,
        };
      }

      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const fatalErrors = data.errors.filter(
          (e: { reason?: string }) => e?.reason !== "warning",
        );
        if (fatalErrors.length > 0) {
          return {
            success: false,
            error: fatalErrors
              .map(
                (e: { message?: string }) =>
                  (e && typeof e.message === "string" && e.message) ||
                  "BigQuery job error",
              )
              .join("; "),
          };
        }
      }

      // Collect results
      if (Array.isArray(data.rows) && schema) {
        const page = this.bqMapRowsToObjects(data.rows, schema);
        options?.onRows?.(page);
        rowsAccum.push(...page);
      }
      pageToken = data.pageToken;

      while (pageToken) {
        checkAborted();
        const params: any = { maxResults: batchSize };
        if (pageToken) params.pageToken = pageToken;
        if (jobLocation) params.location = jobLocation;
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          { params },
        );
        data = response.data || {};
        schema = data.schema || schema;
        if (Array.isArray(data.rows) && schema) {
          const page = this.bqMapRowsToObjects(data.rows, schema);
          options?.onRows?.(page);
          rowsAccum.push(...page);
        }
        pageToken = data.pageToken;
      }

      // A DML statement returns no rows; BigQuery says how many it changed.
      const affected = Number(data.numDmlAffectedRows);
      return {
        success: true,
        data: rowsAccum,
        rowCount:
          rowsAccum.length === 0 && Number.isFinite(affected)
            ? affected
            : rowsAccum.length,
      };
    } catch (error: any) {
      if (error?.message === "Query cancelled") {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error: describeGoogleApiError(error, "BigQuery query failed"),
      };
    } finally {
      if (executionId) this.runningBigQueryJobs.delete(executionId);
    }
  }

  private async executeBigQueryPreviewQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryPreviewOptions,
  ): Promise<QueryPreviewResult> {
    const baseQuery = query.trim().replace(/;\s*$/, "");
    const safety = checkPreviewQuerySafety(baseQuery);
    if (!safety.safe) {
      return { success: false, error: safety.errors.join(" ") };
    }

    const decodedCursor = decodePreviewCursor(options?.cursor);
    const queryHash = hashPreviewQuery(baseQuery);
    if (decodedCursor && decodedCursor.queryHash !== queryHash) {
      return {
        success: false,
        error: "The provided preview cursor does not match the current query",
      };
    }
    if (decodedCursor && decodedCursor.kind !== "bigquery") {
      return {
        success: false,
        error: "The provided preview cursor is invalid for this BigQuery query",
      };
    }

    const {
      project_id,
      service_account_json,
      location: dbLocation,
      api_base_url,
    } = (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      return {
        success: false,
        error:
          "BigQuery requires 'project_id' and 'service_account_json' in connection",
      };
    }

    const { pageSize, capApplied } = resolvePreviewPageSize(options?.pageSize);
    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );
    const configuredLocation =
      decodedCursor?.kind === "bigquery"
        ? decodedCursor.location || options?.location || dbLocation
        : options?.location || dbLocation;
    const executionId = options?.executionId;
    const signal = options?.signal;

    const checkAborted = () => {
      if (signal?.aborted) throw new Error("Query cancelled");
    };

    try {
      checkAborted();

      let response;
      let data: any = {};
      let jobId: string | undefined =
        decodedCursor?.kind === "bigquery" ? decodedCursor.jobId : undefined;
      let jobLocation: string | undefined = configuredLocation;

      if (decodedCursor?.kind === "bigquery") {
        const params: any = {
          maxResults: pageSize,
          pageToken: decodedCursor.pageToken,
        };
        if (jobLocation) {
          params.location = jobLocation;
        }
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          {
            params,
          },
        );
        data = response.data || {};
      } else {
        const startBody: any = {
          query: baseQuery,
          useLegacySql: false,
          maxResults: pageSize,
        };
        if (configuredLocation) {
          startBody.location = configuredLocation;
        }
        const labels = this.bigQueryLabels(database, api_base_url, options);
        if (labels) startBody.labels = labels;

        response = await client.post(
          `/projects/${project_id}/queries`,
          startBody,
        );
        data = response.data || {};
        jobId = data.jobReference?.jobId;
        jobLocation = data.jobReference?.location || configuredLocation;
      }

      if (executionId && jobId) {
        this.runningBigQueryJobs.set(executionId, {
          projectId: project_id,
          jobId,
          location: jobLocation,
          client,
        });
      }

      const maxWaitMs = 5 * 60 * 1000;
      const pollIntervalMs = this.getBigQueryPollIntervalMs();
      // A wall-clock deadline: see bigquery-poll-budget.ts.
      const budget = createBigQueryPollBudget(maxWaitMs);

      while (data.jobComplete === false && jobId && !budget.expired()) {
        checkAborted();
        await new Promise(resolve =>
          setTimeout(resolve, budget.sleepMs(pollIntervalMs)),
        );
        checkAborted();
        if (budget.expired()) break;

        const params: any = {
          maxResults: pageSize,
          timeoutMs: budget.requestTimeoutMs(),
        };
        if (jobLocation) {
          params.location = jobLocation;
        }
        if (decodedCursor?.kind === "bigquery" && decodedCursor.pageToken) {
          params.pageToken = decodedCursor.pageToken;
        }

        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          {
            params,
          },
        );
        data = response.data || {};
      }

      checkAborted();
      if (data.jobComplete === false) {
        const stopped = await this.cancelAbandonedBigQueryJob({
          client,
          projectId: project_id,
          jobId: jobId as string,
          location: jobLocation,
          executionId,
        });
        return {
          success: false,
          error: `Query timed out after ${maxWaitMs / 1000} seconds${bqAbandonedSuffix(stopped)}`,
        };
      }

      const schema = data.schema;
      const rows =
        Array.isArray(data.rows) && schema
          ? (this.bqMapRowsToObjects(data.rows, schema) as Array<
              Record<string, unknown>
            >)
          : [];
      const fields = this.bqSchemaToFields(schema, rows);
      const nextPageToken =
        typeof data.pageToken === "string" && data.pageToken.length > 0
          ? data.pageToken
          : undefined;

      return {
        success: true,
        rows,
        rowCount: rows.length,
        fields,
        warnings: safety.warnings,
        pageInfo: {
          pageSize,
          hasMore: Boolean(nextPageToken),
          nextCursor:
            nextPageToken && jobId
              ? buildBigQueryCursor({
                  jobId,
                  pageToken: nextPageToken,
                  query: baseQuery,
                  location: jobLocation,
                })
              : null,
          returnedRows: rows.length,
          capApplied,
        },
      };
    } catch (error: any) {
      if (error?.message === "Query cancelled") {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error: describeGoogleApiError(error, "BigQuery preview query failed"),
      };
    } finally {
      if (executionId) {
        this.runningBigQueryJobs.delete(executionId);
      }
    }
  }

  private async executeBigQueryStreamingQuery(
    database: IDatabaseConnection,
    query: string,
    options: StreamingQueryOptions & QueryExecuteOptions,
  ): Promise<{ success: boolean; totalRows: number; error?: string }> {
    const executionId = options.executionId;
    const signal = options.signal;

    const checkAborted = () => {
      if (signal?.aborted) throw new Error("Query cancelled");
    };

    let totalRows = 0;

    try {
      checkAborted();
      if (typeof query !== "string" || !query.trim()) {
        return {
          success: false,
          totalRows,
          error: "Query must be a non-empty string",
        };
      }

      const {
        project_id,
        service_account_json,
        location: dbLocation,
        api_base_url,
      } = (database.connection as any) || {};
      if (!project_id || !service_account_json) {
        return {
          success: false,
          totalRows,
          error:
            "BigQuery requires 'project_id' and 'service_account_json' in connection",
        };
      }

      // Asked for again per poll and per page: a job or a stream can outlive
      // the token it started with (smp0's 250+ seconds of pages ended in a 401
      // for two deploys on 2026-11-03), and this call is what renews it.
      let client = await this.getBigQueryHttpClient(
        service_account_json,
        api_base_url,
      );
      const configuredLocation = options.location || dbLocation;
      const batchSize = Math.max(1, Math.min(10000, options.batchSize || 1000));

      const startBody: any = {
        query,
        useLegacySql: false,
        maxResults: batchSize,
      };
      if (configuredLocation) {
        startBody.location = configuredLocation;
      }
      const labels = this.bigQueryLabels(database, api_base_url, options);
      if (labels) startBody.labels = labels;

      checkAborted();
      let response = await client.post(
        `/projects/${project_id}/queries`,
        startBody,
      );
      let data = response.data || {};
      const jobId: string | undefined = data.jobReference?.jobId;
      const jobLocation: string | undefined =
        data.jobReference?.location || configuredLocation;
      let schema: any = data.schema;
      let pageToken: string | undefined = data.pageToken;

      if (executionId && jobId) {
        this.runningBigQueryJobs.set(executionId, {
          projectId: project_id,
          jobId,
          location: jobLocation,
          client,
        });
      }

      const maxWaitMs = 5 * 60 * 1000;
      const pollIntervalMs = this.getBigQueryPollIntervalMs();
      // A wall-clock deadline: see bigquery-poll-budget.ts.
      const budget = createBigQueryPollBudget(maxWaitMs);

      while (data.jobComplete === false && jobId && !budget.expired()) {
        checkAborted();
        await new Promise(resolve =>
          setTimeout(resolve, budget.sleepMs(pollIntervalMs)),
        );
        checkAborted();
        if (budget.expired()) break;

        const params: any = {
          maxResults: batchSize,
          timeoutMs: budget.requestTimeoutMs(),
        };
        if (jobLocation) {
          params.location = jobLocation;
        }
        client = await this.getBigQueryHttpClient(
          service_account_json,
          api_base_url,
        );
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          {
            params,
          },
        );
        data = response.data || {};
        schema = data.schema || schema;
      }

      checkAborted();
      if (data.jobComplete === false) {
        const stopped = await this.cancelAbandonedBigQueryJob({
          client,
          projectId: project_id,
          jobId: jobId as string,
          location: jobLocation,
          executionId,
        });
        return {
          success: false,
          totalRows,
          error: `Query timed out after ${maxWaitMs / 1000} seconds${bqAbandonedSuffix(stopped)}`,
        };
      }

      if (Array.isArray(data.rows) && schema) {
        const rows = this.bqMapRowsToObjects(data.rows, schema) as Array<
          Record<string, unknown>
        >;
        if (rows.length > 0) {
          await options.onBatch(rows);
          totalRows += rows.length;
        }
      }

      pageToken = data.pageToken;

      while (pageToken && jobId) {
        checkAborted();
        const params: any = { maxResults: batchSize, pageToken };
        if (jobLocation) {
          params.location = jobLocation;
        }
        client = await this.getBigQueryHttpClient(
          service_account_json,
          api_base_url,
        );
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          {
            params,
          },
        );
        data = response.data || {};
        schema = data.schema || schema;

        const rows =
          Array.isArray(data.rows) && schema
            ? (this.bqMapRowsToObjects(data.rows, schema) as Array<
                Record<string, unknown>
              >)
            : [];
        if (rows.length > 0) {
          await options.onBatch(rows);
          totalRows += rows.length;
        }

        pageToken = data.pageToken;
      }

      return { success: true, totalRows };
    } catch (error: any) {
      if (error?.message === "Query cancelled") {
        return { success: false, totalRows, error: "Query cancelled" };
      }
      return {
        success: false,
        totalRows,
        error: describeGoogleApiError(error, "BigQuery streaming query failed"),
      };
    } finally {
      if (executionId) {
        this.runningBigQueryJobs.delete(executionId);
      }
    }
  }

  /**
   * Stop a job we have stopped waiting for.
   *
   * When the poll loop gives up at `maxWaitMs` the HTTP request ends, but the
   * BigQuery job does not: it runs to completion, scans what it was going to
   * scan, and bills for it — which is what "the query may still be running in
   * BigQuery" in the timeout message has always meant. Nobody reads the
   * result, so every byte after we walk away is paid for and thrown away.
   *
   * Measured on 2026-09-01: one app's two bindings abandoned 41 jobs in 48
   * minutes, each a 300s query. The circuit breaker in front of live bindings
   * cut that to 7; this makes the ones that still happen stop scanning.
   *
   * Best effort by construction — it runs on a path that is already failing,
   * so a failed cancel must not replace the timeout the caller needs to hear
   * about. Returns whether the job was actually cancelled, so the message can
   * say which happened instead of always claiming the worse one.
   */
  private async cancelAbandonedBigQueryJob(input: {
    client: AxiosInstance;
    projectId: string;
    jobId: string;
    location?: string;
    executionId?: string;
  }): Promise<boolean> {
    const { client, projectId, jobId, location, executionId } = input;
    try {
      const params: Record<string, string> = {};
      if (location) params.location = location;
      await client.post(
        `/projects/${projectId}/jobs/${jobId}/cancel`,
        {},
        { params },
      );
      if (executionId) this.runningBigQueryJobs.delete(executionId);
      logger.info("Cancelled an abandoned BigQuery job", {
        category: "db.bigquery",
        projectId,
        jobId,
      });
      return true;
    } catch (error) {
      logger.warn("Could not cancel an abandoned BigQuery job", {
        category: "db.bigquery",
        projectId,
        jobId,
        error: describeGoogleApiError(error, "Failed to cancel job"),
      });
      return false;
    }
  }

  /**
   * Cancel a running BigQuery job
   */
  async cancelBigQueryJob(
    executionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const job = this.runningBigQueryJobs.get(executionId);
    if (!job) {
      return { success: false, error: "Job not found or already completed" };
    }

    try {
      const params: any = {};
      if (job.location) params.location = job.location;
      await job.client.post(
        `/projects/${job.projectId}/jobs/${job.jobId}/cancel`,
        {},
        { params },
      );
      this.runningBigQueryJobs.delete(executionId);
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: describeGoogleApiError(error, "Failed to cancel job"),
      };
    }
  }

  /**
   * Get the schema (column types) of a BigQuery query without executing it.
   * Uses BigQuery's dry run feature which validates the query and returns
   * the result schema without actually running it.
   *
   * This is more reliable than inferring types from sample data because:
   * - NULL values are handled correctly (column type is known)
   * - No data sampling variance issues
   * - Works even if query returns 0 rows
   *
   * @param database - BigQuery database connection
   * @param query - SQL query to analyze
   * @returns Column definitions with name and BigQuery type
   */
  async getBigQueryQuerySchema(
    database: IDatabaseConnection,
    query: string,
  ): Promise<{
    success: boolean;
    columns?: Array<{ name: string; type: string; nullable: boolean }>;
    error?: string;
  }> {
    try {
      const { project_id, service_account_json, location, api_base_url } =
        (database.connection as any) || {};
      if (!project_id || !service_account_json) {
        return {
          success: false,
          error:
            "BigQuery requires 'project_id' and 'service_account_json' in connection",
        };
      }

      const client = await this.getBigQueryHttpClient(
        service_account_json,
        api_base_url,
      );

      // Use dry run to get schema without executing
      const body: any = {
        query,
        useLegacySql: false,
        dryRun: true, // Key: validates query and returns schema without running
      };
      if (location) body.location = location;
      const labels = this.bigQueryLabels(database, api_base_url);
      if (labels) body.labels = labels;

      const response = await client.post(
        `/projects/${project_id}/queries`,
        body,
      );

      const schema = response?.data?.schema;
      if (!schema?.fields) {
        return {
          success: false,
          error: "No schema returned from dry run query",
        };
      }

      // Map BigQuery schema fields to column definitions
      const columns = this.flattenBigQuerySchemaFields(schema.fields);

      return { success: true, columns };
    } catch (error: any) {
      return {
        success: false,
        error: describeGoogleApiError(error, "Failed to get query schema"),
      };
    }
  }

  /**
   * Flatten BigQuery schema fields to column definitions
   * Handles nested RECORD/STRUCT types by flattening with dot notation
   */
  private flattenBigQuerySchemaFields(
    fields: any[],
    prefix = "",
  ): Array<{ name: string; type: string; nullable: boolean }> {
    const columns: Array<{ name: string; type: string; nullable: boolean }> =
      [];

    for (const field of fields) {
      const name = prefix ? `${prefix}.${field.name}` : field.name;
      const mode = field.mode || "NULLABLE";
      const nullable = mode !== "REQUIRED";

      if (field.type === "RECORD" && Array.isArray(field.fields)) {
        // Flatten nested records
        columns.push(...this.flattenBigQuerySchemaFields(field.fields, name));
      } else {
        columns.push({
          name,
          type: field.type,
          nullable,
        });
      }
    }

    return columns;
  }

  // The PostgreSQL engine's entry points, by name: route tests stub these
  // on the service to see what reaches the database.
  private executePostgreSQLQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    return postgresEngine.executeQuery(database, query, options);
  }

  private executePostgreSQLCursor(
    database: IDatabaseConnection,
    query: string,
    options: CursorReadOptions,
  ): Promise<QueryResult> {
    return postgresEngine.readCursor(database, query, options);
  }

  /** Cancel a running PostgreSQL query by its executionId. */
  async cancelPostgresQuery(executionId: string): Promise<CancelResult> {
    return postgresEngine.cancelQuery(executionId);
  }

  /**
   * Register a detached (resumable) execution so it can be cancelled by
   * executionId from any turn, and aborted by the server-side hard cap.
   * The caller owns the AbortController and wires it into executeQuery's
   * `signal`. Returns nothing; pair with {@link releaseDetachedExecution}.
   */
  registerDetachedExecution(
    executionId: string,
    info: {
      abortController: AbortController;
      consoleId?: string;
      workspaceId?: string;
    },
  ): void {
    this.runningExecutions.set(executionId, {
      abortController: info.abortController,
      startedAt: Date.now(),
      consoleId: info.consoleId,
      workspaceId: info.workspaceId,
    });
  }

  /** Clear a detached execution entry once its task has settled. */
  releaseDetachedExecution(executionId: string): void {
    this.runningExecutions.delete(executionId);
  }

  /** Whether a detached execution is currently registered. */
  hasDetachedExecution(executionId: string): boolean {
    return this.runningExecutions.has(executionId);
  }

  /**
   * Cancel a running query (auto-detects database type)
   */
  async cancelQuery(
    executionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Abort the detached task first (if any) so the in-process poll/await
    // stops; the engine-native cancel below actually kills the server-side
    // query. Both are needed: aborting the signal alone does not stop most
    // engines, and engine-native cancel alone leaves the detached await hanging.
    const detached = this.runningExecutions.get(executionId);
    if (detached) {
      try {
        detached.abortController.abort();
      } catch {
        // AbortController.abort never throws in practice; ignore defensively.
      }
    }

    // Try BigQuery first
    if (this.runningBigQueryJobs.has(executionId)) {
      return this.cancelBigQueryJob(executionId);
    }
    // Try PostgreSQL
    if (postgresEngine.runningQueries.has(executionId)) {
      return this.cancelPostgresQuery(executionId);
    }
    // Try MongoDB
    if (mongoEngine.runningQueries.has(executionId)) {
      return mongoEngine.cancelQuery(executionId);
    }
    // Try ClickHouse
    if (clickHouseEngine.runningQueries.has(executionId)) {
      return clickHouseEngine.cancelQuery(executionId);
    }
    // Try MSSQL
    if (mssqlEngine.runningQueries.has(executionId)) {
      return mssqlEngine.cancelQuery(executionId);
    }

    // Try MySQL
    if (mysqlEngine.runningQueries.has(executionId)) {
      return mysqlEngine.cancelQuery(executionId);
    }

    // Delegate to the drivers this service runs queries through that track
    // their own (cloudsql-postgres). The same registry instance ran the query.
    for (const driver of [this.cloudSqlDriver, this.d1Driver, this.kvDriver]) {
      const cancel = (driver as DatabaseDriver).cancelQuery;
      if (typeof cancel === "function") {
        const res = await cancel.call(driver, executionId);
        if (res?.success) return res;
        // If the driver found the executionId but failed to cancel, return that error.
        if (
          res?.error &&
          res.error !== "Query not found or already completed"
        ) {
          return res;
        }
      }
    }

    // No engine-native handle matched. If a detached task was registered we
    // still aborted it above, so report success — the engine query (if any)
    // will unwind once the abort propagates or its connection closes.
    if (detached) {
      return { success: true };
    }

    return { success: false, error: "Query not found or already completed" };
  }

  // New: list BigQuery datasets and tables via REST (fast, no deprecated auth)
  async listBigQueryDatasetsAndTables(
    database: IDatabaseConnection,
  ): Promise<Array<{ name: string; type: string; options: any }>> {
    const datasetIds = await this.listBigQueryDatasets(database);

    // Concurrency limiter
    const limit = 5;
    const results: Array<{ name: string; type: string; options: any }>[] = [];
    let index = 0;
    const runners: Promise<void>[] = [];
    const runNext = async () => {
      while (index < datasetIds.length) {
        const current = datasetIds[index++];
        const tables = await this.listBigQueryTables(database, current);
        results.push(tables);
      }
    };
    for (let i = 0; i < Math.min(limit, datasetIds.length); i++) {
      runners.push(runNext());
    }
    await Promise.all(runners);

    return results.flat();
  }

  private async getBigQueryHttpClient(
    serviceAccountJson: string | object,
    apiBaseUrl?: string,
  ): Promise<AxiosInstance> {
    const sa = this.parseServiceAccount(serviceAccountJson);
    const base = (apiBaseUrl || "https://bigquery.googleapis.com").trim();
    const normalized = /^https?:\/\//i.test(base) ? base : `https://${base}`;
    const baseURL = normalized.replace(/\/+$/, "") + "/bigquery/v2";

    const cacheKey = crypto
      .createHash("sha256")
      .update(`${sa.client_email}|${sa.token_uri}|${baseURL}`)
      .digest("hex");

    const cached = this.bigQueryClientCache.get(cacheKey);
    const now = Date.now();

    // Local emulator (e.g. goccy/bigquery-emulator): no auth. Skip the JWT/OAuth
    // token exchange entirely and send a dummy bearer the emulator ignores. This
    // lets local dev / integration tests run fully offline with fake credentials.
    if (isLocalBigQueryEmulator(apiBaseUrl)) {
      const emulatorClient = cached?.client || axios.create({ baseURL });
      emulatorClient.defaults.headers.common["Authorization"] =
        "Bearer emulator";
      emulatorClient.defaults.headers.common["Content-Type"] =
        "application/json";
      const expiresAtMs = now + 365 * 24 * 60 * 60 * 1000;
      this.bigQueryClientCache.set(cacheKey, {
        client: emulatorClient,
        token: "emulator",
        expiresAtMs,
      });
      return emulatorClient;
    }

    // Refresh token if expiring soon (within 2 minutes)
    const needsRefresh = !cached || cached.expiresAtMs - now < 2 * 60 * 1000;

    if (!needsRefresh && cached) {
      return cached.client;
    }

    const inFlight = this.bigQueryTokenInFlight.get(cacheKey);
    const tokenPromise =
      inFlight ||
      (async () => {
        try {
          return await this.createGoogleAccessTokenWithExpiry(sa);
        } finally {
          this.bigQueryTokenInFlight.delete(cacheKey);
        }
      })();

    if (!inFlight) {
      this.bigQueryTokenInFlight.set(cacheKey, tokenPromise);
    }

    const { token, expiresAtMs } = await tokenPromise;

    const client = cached?.client || axios.create({ baseURL });
    client.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    client.defaults.headers.common["Content-Type"] = "application/json";
    this.bigQueryClientCache.set(cacheKey, { client, token, expiresAtMs });
    return client;
  }

  private parseServiceAccount(sa: string | object): {
    client_email: string;
    private_key: string;
    token_uri: string;
  } {
    let obj: any;
    try {
      obj = typeof sa === "string" ? JSON.parse(sa) : sa;
    } catch (e) {
      logger.error("Failed to parse service_account_json", { error: e });
      throw new Error("Invalid service_account_json: Not a valid JSON string", {
        cause: e,
      });
    }

    if (!obj || typeof obj !== "object") {
      throw new Error("Invalid service_account_json: Content is not an object");
    }

    return {
      client_email: obj.client_email,
      private_key: obj.private_key,
      token_uri: obj.token_uri || "https://oauth2.googleapis.com/token",
    };
  }

  private async createGoogleAccessTokenWithExpiry(sa: {
    client_email: string;
    private_key: string;
    token_uri: string;
  }): Promise<{ token: string; expiresAtMs: number }> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/bigquery",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    } as any;
    const base64url = (input: Buffer | string) =>
      (Buffer.isBuffer(input) ? input : Buffer.from(input))
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(sa.private_key);
    const assertion = `${signingInput}.${base64url(signature)}`;
    let res;
    try {
      res = await axios.post(
        sa.token_uri,
        new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
    } catch (error: any) {
      const detail = describeGoogleApiError(
        error,
        "Failed to obtain Google access token",
      );
      logger.error("Google access token request failed", {
        clientEmail: sa.client_email,
        tokenUri: sa.token_uri,
        status: error?.response?.status,
        detail,
      });
      // invalid_grant / invalid_client almost always means the service-account
      // key was rotated, disabled, or deleted. Surface that explicitly instead
      // of the opaque "Request failed with status code 400".
      throw new Error(
        `Google authentication failed for service account "${sa.client_email}": ${detail}. ` +
          `The service-account key may have been rotated, disabled, or deleted — update this connection's service_account_json with a current key.`,
        { cause: error },
      );
    }
    const token = res.data.access_token as string;
    const expiresInSec = Number(res.data.expires_in || 3600);
    // Refresh a bit early by setting the stored expiry slightly before real expiry
    const expiresAtMs = Date.now() + Math.max(60, expiresInSec - 60) * 1000;
    return { token, expiresAtMs };
  }

  private normalizeQueryFields(
    fields: any[] | undefined,
    rows: Array<Record<string, unknown>>,
  ): Array<{ name: string; type?: string }> {
    if (Array.isArray(fields) && fields.length > 0) {
      return fields
        .map(field => {
          if (typeof field === "string") {
            return { name: field };
          }

          const name =
            field?.name || field?.columnName || field?.originalName || "";
          if (!name) {
            return null;
          }

          const type =
            field?.type ||
            field?.dataType ||
            field?.columnType ||
            (typeof field?.dataTypeID === "number"
              ? mapPostgresOidToType(field.dataTypeID)
              : undefined);
          return {
            name: String(name),
            type: type ? String(type) : undefined,
          };
        })
        .filter(
          (field): field is { name: string; type?: string } => field !== null,
        );
    }

    return inferFieldsFromRows(rows);
  }

  private bqSchemaToFields(
    schema: any,
    rows: Array<Record<string, unknown>>,
  ): Array<{ name: string; type?: string }> {
    const schemaFields = Array.isArray(schema?.fields) ? schema.fields : [];
    if (schemaFields.length === 0) {
      return inferFieldsFromRows(rows);
    }

    return schemaFields
      .map((field: any) => {
        const name = field?.name ? String(field.name) : "";
        if (!name) {
          return null;
        }
        return {
          name,
          type: field?.type ? String(field.type) : undefined,
        };
      })
      .filter(
        (
          field: { name: string; type?: string } | null,
        ): field is { name: string; type?: string } => field !== null,
      );
  }

  private bqMapRowsToObjects(rows: any[], schema: any): any[] {
    const fields = (schema?.fields || []) as Array<any>;
    return (rows || []).map(r => this.bqMapRow(r, fields));
  }

  private bqMapRow(row: any, fields: Array<any>): any {
    const obj: Record<string, any> = {};
    const cells: any[] = Array.isArray(row?.f) ? row.f : [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const cell = cells[i]?.v;
      obj[field.name] = this.bqParseCellValue(cell, field);
    }
    return obj;
  }

  private bqParseCellValue(value: any, field: any): any {
    if (value === null || value === undefined) return null;
    const mode = String(field?.mode || "").toUpperCase();
    const type = String(field?.type || "").toUpperCase();
    if (mode === "REPEATED") {
      const arr: any[] = Array.isArray(value) ? value : [];
      return arr.map(v =>
        this.bqParseCellValue(v?.v ?? v, { ...field, mode: undefined }),
      );
    }
    switch (type) {
      case "RECORD":
        return this.bqMapRow(value, field.fields || []);
      case "INTEGER":
      case "INT64":
      case "FLOAT":
      case "FLOAT64":
      case "NUMERIC":
      case "BIGNUMERIC":
        return value === "" ? null : Number(value);
      case "BOOLEAN":
      case "BOOL":
        return value === true || value === "true";
      case "TIMESTAMP": {
        if (value === "") return null;
        // BigQuery REST API returns TIMESTAMP as epoch-seconds float (e.g. "1.677123456E9").
        // Convert to ISO 8601 string for human-readable display.
        const num = Number(value);
        if (!isNaN(num)) {
          return new Date(num * 1000)
            .toISOString()
            .replace("T", " ")
            .replace("Z", " UTC");
        }
        return value;
      }
      case "DATETIME": {
        // DATETIME has no timezone in BigQuery; value is already a string like "2025-01-01 20:45:28".
        return value;
      }
      default:
        return value;
    }
  }
}

// Export singleton instance
export const databaseConnectionService = new DatabaseConnectionService();
