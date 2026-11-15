/**
 * What one engine (Postgres, MySQL, MongoDB, BigQuery, ...) does on its own:
 * connect and pool, run a query, cancel it, test a connection, and close
 * what it holds. No access rules: `checked-query.ts` applies the write
 * and read-only checks once, for every engine, before it calls one of these.
 *
 * Each engine lives in its driver's folder (`drivers/<engine>/`); the
 * stateful drivers that predate this split (Cloud SQL, D1, KV) implement it
 * directly. `engines.ts` resolves the engine for a connection type.
 */
import type { IDatabaseConnection } from "../database/workspace-schema";
import type {
  CancelResult,
  ConnectionTestResult,
  DatabaseQuery,
  QueryExecuteOptions,
  QueryResult,
} from "./query-types";

export interface QueryEngine {
  /**
   * Engines whose queries are not SQL (MongoDB, Cloudflare KV): the lexical
   * read-only analyzer cannot vouch for them, and previews/streams read
   * their whole result instead of paging it with LIMIT/OFFSET.
   *
   * Engine-native reads (the Postgres cursor, BigQuery's page-token
   * previews and streams) are the facade's to choose, by connection type.
   */
  readonly nonSql?: boolean;

  /**
   * Run a query. Failures are `{ success: false }` (a connect error may
   * throw: the facade turns it into one).
   */
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
}
