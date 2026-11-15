/**
 * What one engine (Postgres, MySQL, MongoDB, BigQuery, ...) does on its own:
 * connect and pool, run a query, cancel it, test a connection, and close
 * what it holds. No access rules: `databases/execution/` applies the write
 * and read-only checks once, for every engine, before it calls one of these.
 *
 * Each engine lives in its driver's folder (`drivers/<engine>/`); the
 * stateful drivers that predate this split (Cloud SQL, D1, KV) implement it
 * directly. `engines.ts` resolves the engine for a connection type.
 */
import type { IDatabaseConnection } from "../database/workspace-schema";
import type { ColumnDefinition } from "./driver";
import type {
  CancelResult,
  ConnectionTestResult,
  CursorReadOptions,
  DatabaseQuery,
  QueryExecuteOptions,
  QueryPreviewOptions,
  QueryPreviewResult,
  QueryResult,
  StreamingQueryOptions,
  StreamingQueryResult,
} from "./query-types";

export interface QueryEngine {
  /**
   * Engines whose queries are not SQL (MongoDB, Cloudflare KV): the lexical
   * read-only analyzer cannot vouch for them, and previews/streams read
   * their whole result instead of paging it with LIMIT/OFFSET.
   */
  readonly nonSql?: boolean;

  /** Run a query. Must not throw: failures are `{ success: false }`. */
  executeQuery(
    database: IDatabaseConnection,
    query: DatabaseQuery,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult>;

  testConnection(database: IDatabaseConnection): Promise<ConnectionTestResult>;

  /** The engine's native handle (a pool or client); null for HTTP engines. */
  getConnection?(database: IDatabaseConnection): Promise<unknown>;

  /**
   * Cancel a query started with this `executionId`; answers
   * `QUERY_NOT_FOUND` for one it is not running.
   */
  cancelQuery?(executionId: string): Promise<CancelResult>;

  /** Drop everything cached for one connection (edit, delete). */
  closeConnection?(databaseId: string): Promise<void> | void;

  /** Drop everything cached (shutdown). */
  closeAllConnections?(): Promise<void> | void;

  /** Close connections unused for longer than `maxIdleMs`. */
  sweepIdleConnections?(maxIdleMs: number): Promise<void>;

  /**
   * Read `query` through a server-side cursor, batch by batch, in one
   * snapshot. Returns null when this query (or connection) cannot be read
   * that way, and the caller falls back to `executeQuery`.
   */
  readRows?(
    database: IDatabaseConnection,
    query: string,
    options: CursorReadOptions,
  ): Promise<QueryResult> | null;

  /** A native preview page (BigQuery pages with job page tokens). */
  executePreviewQuery?(
    database: IDatabaseConnection,
    query: string,
    options?: QueryPreviewOptions,
  ): Promise<QueryPreviewResult>;

  /** A native stream (BigQuery reads its job's pages). */
  executeStreamingQuery?(
    database: IDatabaseConnection,
    query: string,
    options: StreamingQueryOptions & QueryExecuteOptions,
  ): Promise<StreamingQueryResult>;

  /**
   * The result schema of `query` without running it (BigQuery's dry run).
   * An engine with one is never sampled for an export schema.
   */
  getQuerySchema?(
    database: IDatabaseConnection,
    query: string,
  ): Promise<{
    success: boolean;
    columns?: ColumnDefinition[];
    error?: string;
  }>;
}
