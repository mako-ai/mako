/**
 * The database connection service: the one entry point the rest of the API
 * runs queries through. A facade over the engines in `databases/drivers/`:
 * it resolves the engine for a connection's type (`databases/engines.ts`),
 * applies what every engine shares once — the connection's write rules and
 * read-only checks (`databases/checked-query.ts`), preview paging, export
 * streaming, cancellation by executionId, connection invalidation and the
 * idle sweep — and delegates the rest.
 *
 * Two engines have native paths here: a Postgres read goes through a
 * server-side cursor (one snapshot, read in batches), and BigQuery pages
 * previews and streams with its job page tokens.
 */
import type { Db, MongoClient } from "mongodb";
import { checkConnectionWrite } from "../access/connection-writes";
import type { IDatabaseConnection } from "../database/workspace-schema";
import { executeCheckedQuery, runOnEngine } from "../databases/checked-query";
import * as bigQueryCatalog from "../databases/drivers/bigquery/catalog";
import { bigQueryEngine } from "../databases/drivers/bigquery/engine";
import { clickHouseEngine } from "../databases/drivers/clickhouse/engine";
import {
  mongoEngine,
  type ConnectionConfig,
  type ConnectionContext,
} from "../databases/drivers/mongodb/engine";
import { mssqlEngine } from "../databases/drivers/mssql/engine";
import {
  cursorReadable,
  postgresEngine,
} from "../databases/drivers/postgresql/engine";
import type { QueryEngine } from "../databases/engine";
import { allEngines, d1Driver, engineFor } from "../databases/engines";
import { normalizeQueryFields, resultRows } from "../databases/query-fields";
import {
  QUERY_NOT_FOUND,
  type CancelResult,
  type ConnectionTestResult,
  type CursorReadOptions,
  type DatabaseQuery,
  type QueryExecuteOptions,
  type QueryPreviewOptions,
  type QueryPreviewResult,
  type QueryResult,
  type ReadingRowsOptions,
  type StreamingQueryOptions,
  type StreamingQueryResult,
} from "../databases/query-types";
import { databaseRegistry } from "../databases/registry";
import { loggers } from "../logging";
import {
  buildPreviewPage,
  checkPreviewQuerySafety,
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

/** Pools unused this long are closed by the sweep (kept during sessions). */
const USER_DATABASE_MAX_IDLE_MS = 15 * 60 * 1000;

export class DatabaseConnectionService {
  // Engine-agnostic registry of detached (resumable) executions, layered over
  // the engines' own running-query maps. Holds the detached task's
  // AbortController plus light metadata so a long query can be cancelled by
  // executionId from any turn (or by the server-side hard cap). The engines
  // still do the native cancel (pid / query_id / session / request / jobId).
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

  constructor() {
    // Every minute, close the pools and clients nothing used for a while.
    this.cleanupInterval = setInterval(() => {
      for (const engine of allEngines()) {
        void engine
          .sweepIdleConnections?.(USER_DATABASE_MAX_IDLE_MS)
          .catch(error =>
            logger.error("Error sweeping idle connections", { error }),
          );
      }
    }, 60000);
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
  ): Promise<ConnectionTestResult> {
    try {
      const engine = engineFor(database.type);
      if (!engine) {
        return {
          success: false,
          error: `Unsupported database type: ${database.type}`,
        };
      }
      return await engine.testConnection(database);
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
    query: DatabaseQuery,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    return executeCheckedQuery(database, query, options, (db, q, o) =>
      this.runEngineQuery(db, q, o),
    );
  }

  /**
   * The engine call behind executeQuery. Postgres and BigQuery go through
   * their named entry points below, which route tests stub on this service
   * to see what reaches the database.
   */
  private runEngineQuery(
    database: IDatabaseConnection,
    query: DatabaseQuery,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    switch (database.type) {
      case "postgresql":
      case "redshift":
        return this.executePostgreSQLQuery(database, query as string, options);
      case "bigquery":
        return this.executeBigQueryQuery(database, query as string, options);
      default:
        return runOnEngine(database, query, options);
    }
  }

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

  private executeBigQueryQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    return bigQueryEngine.executeQuery(database, query, options);
  }

  private executeBigQueryPreviewQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryPreviewOptions,
  ): Promise<QueryPreviewResult> {
    return bigQueryEngine.executePreviewQuery(database, query, options);
  }

  private executeBigQueryStreamingQuery(
    database: IDatabaseConnection,
    query: string,
    options: StreamingQueryOptions & QueryExecuteOptions,
  ): Promise<StreamingQueryResult> {
    return bigQueryEngine.executeStreamingQuery(database, query, options);
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
    query: DatabaseQuery,
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

      // Non-SQL engines (MongoDB, KV) cannot be paged with LIMIT/OFFSET: their
      // whole result is read and paged here.
      if (typeof query !== "string" || engineFor(database.type)?.nonSql) {
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
        const rows = resultRows(result.data);
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
          fields: normalizeQueryFields(result.fields, page.rows),
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
        fields: normalizeQueryFields(result.fields, page.rows),
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
    query: DatabaseQuery,
    options: StreamingQueryOptions & QueryExecuteOptions,
  ): Promise<StreamingQueryResult> {
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

    if (engineFor(database.type)?.nonSql || typeof query !== "string") {
      const result = await this.executeQuery(database, query, options);
      if (!result.success) {
        return { success: false, totalRows: 0, error: result.error };
      }
      const rows = resultRows(result.data);
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
    query: DatabaseQuery,
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
      const schema = await bigQueryEngine.getQuerySchema(database, query);
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

    const rows = resultRows(probe.data);
    const fields = normalizeQueryFields(probe.fields, rows);

    if (fields.length === 0) {
      return {
        success: false,
        error: "Unable to determine query schema for Arrow export",
      };
    }

    return { success: true, fields };
  }

  /**
   * The engine's native handle for a connection: a MongoClient, a pg or
   * MySQL/MSSQL pool, or null for the HTTP engines (BigQuery, ClickHouse).
   */
  async getConnection(database: IDatabaseConnection): Promise<any> {
    const engine = engineFor(database.type);
    if (!engine?.getConnection) {
      throw new Error(`Unsupported database type: ${database.type}`);
    }
    return engine.getConnection(database);
  }

  /**
   * Close database connection. Same as {@link invalidateConnection}.
   */
  async closeConnection(databaseId: string): Promise<void> {
    await this.invalidateConnection(databaseId);
  }

  /**
   * Every engine, and every registered driver that caches something of its
   * own, once each.
   */
  private connectionHolders(): Array<[string, QueryEngine]> {
    const holders = new Map<QueryEngine, string>();
    for (const engine of allEngines()) holders.set(engine, "engine");
    for (const driver of databaseRegistry.getAllDrivers()) {
      const holder = driver as unknown as QueryEngine;
      if (!holders.has(holder)) {
        holders.set(holder, `driver:${driver.getMetadata().type}`);
      }
    }
    return [...holders].map(([holder, name]) => [
      name === "engine" ? holder.constructor.name : name,
      holder,
    ]);
  }

  /**
   * Drop every cached pool, client, connector and HTTP client held for a
   * connection, in every engine and every registered driver, so the next
   * query connects afresh from the saved configuration.
   *
   * Call it whenever a connection's configuration changes (edit) or the
   * connection goes away (delete): all of these caches are keyed by the
   * connection id, so without it an edited host or rotated password keeps
   * being served by the pool built from the old one.
   */
  async invalidateConnection(databaseId: string): Promise<void> {
    // One failing cache must not keep the others serving stale config.
    for (const [cache, holder] of this.connectionHolders()) {
      if (typeof holder.closeConnection !== "function") continue;
      try {
        await holder.closeConnection(databaseId);
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
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const [cache, holder] of this.connectionHolders()) {
      if (typeof holder.closeAllConnections !== "function") continue;
      try {
        await holder.closeAllConnections();
      } catch (error) {
        logger.error("Error closing driver connections", {
          driver: cache,
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

    const databases = await d1Driver().listDatabases(database);
    return databases.map(db => ({
      uuid: db.uuid,
      name: db.name,
    }));
  }

  // -------------------- BigQuery catalog --------------------

  listBigQueryDatasets(database: IDatabaseConnection): Promise<string[]> {
    return bigQueryCatalog.listDatasets(bigQueryEngine, database);
  }

  /** Datasets for autocomplete: by prefix, stopping at `limit`. */
  listBigQueryDatasetsForAutocomplete(
    database: IDatabaseConnection,
    opts?: { prefix?: string; limit?: number },
  ): Promise<string[]> {
    return bigQueryCatalog.listDatasetsForAutocomplete(
      bigQueryEngine,
      database,
      opts,
    );
  }

  /** Columns of one table (nested RECORD fields flattened with dots). */
  getBigQueryTableColumns(
    database: IDatabaseConnection,
    datasetId: string,
    tableId: string,
  ): Promise<Array<{ name: string; type: string }>> {
    return bigQueryCatalog.getTableColumns(
      bigQueryEngine,
      database,
      datasetId,
      tableId,
    );
  }

  /** A dataset's table ids for autocomplete: by prefix, up to `limit`. */
  listBigQueryTableIdsForAutocomplete(
    database: IDatabaseConnection,
    datasetId: string,
    opts?: { prefix?: string; limit?: number },
  ): Promise<string[]> {
    return bigQueryCatalog.listTableIdsForAutocomplete(
      bigQueryEngine,
      database,
      datasetId,
      opts,
    );
  }

  /** Every dataset's tables and columns, for autocomplete. */
  getBigQuerySchema(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    return bigQueryCatalog.getSchema(bigQueryEngine, database);
  }

  listBigQueryTables(
    database: IDatabaseConnection,
    datasetId: string,
  ): Promise<bigQueryCatalog.BigQueryTableEntry[]> {
    return bigQueryCatalog.listTables(bigQueryEngine, database, datasetId);
  }

  listBigQueryDatasetsAndTables(
    database: IDatabaseConnection,
  ): Promise<bigQueryCatalog.BigQueryTableEntry[]> {
    return bigQueryCatalog.listDatasetsAndTables(bigQueryEngine, database);
  }

  /** The result schema of a BigQuery query, by dry run (nothing runs). */
  getBigQueryQuerySchema(
    database: IDatabaseConnection,
    query: string,
  ): Promise<{
    success: boolean;
    columns?: Array<{ name: string; type: string; nullable: boolean }>;
    error?: string;
  }> {
    return bigQueryEngine.getQuerySchema(database, query);
  }

  // -------------------- Cancellation --------------------

  cancelBigQueryJob(executionId: string): Promise<CancelResult> {
    return bigQueryEngine.cancelJob(executionId);
  }

  cancelPostgresQuery(executionId: string): Promise<CancelResult> {
    return postgresEngine.cancelQuery(executionId);
  }

  cancelMongoDBQuery(executionId: string): Promise<CancelResult> {
    return mongoEngine.cancelQuery(executionId);
  }

  cancelClickHouseQuery(executionId: string): Promise<CancelResult> {
    return clickHouseEngine.cancelQuery(executionId);
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
  async cancelQuery(executionId: string): Promise<CancelResult> {
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

    // The engine running it answers; the others do not know the id.
    for (const engine of allEngines()) {
      if (typeof engine.cancelQuery !== "function") continue;
      const res = await engine.cancelQuery(executionId);
      if (res?.success) return res;
      // An engine that found the executionId but failed to cancel says why.
      if (res?.error && res.error !== QUERY_NOT_FOUND) return res;
    }

    // No engine-native handle matched. If a detached task was registered we
    // still aborted it above, so report success — the engine query (if any)
    // will unwind once the abort propagates or its connection closes.
    if (detached) {
      return { success: true };
    }

    return { success: false, error: QUERY_NOT_FOUND };
  }
}

// Export singleton instance
export const databaseConnectionService = new DatabaseConnectionService();
