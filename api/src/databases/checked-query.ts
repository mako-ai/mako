/**
 * A query as every caller must run it: the connection's write rules
 * (access/connection-writes.ts) and the caller's `readOnly` checked once,
 * then the engine. `databaseConnectionService.executeQuery` and the
 * drivers' own `executeQuery` both come through here, so a driver reached
 * from the registry is held to the same rules as the service.
 */
import { checkConnectionWrite } from "../access/connection-writes";
import type { IDatabaseConnection } from "../database/workspace-schema";
import { checkPreviewQuerySafety } from "../services/query-pagination.service";
import { engineFor } from "./engines";
import type {
  DatabaseQuery,
  QueryExecuteOptions,
  QueryResult,
} from "./query-types";

/** Runs a query that passed the checks (on an engine, or a test's stub). */
export type EngineRunner = (
  database: IDatabaseConnection,
  query: DatabaseQuery,
  options?: QueryExecuteOptions,
) => Promise<QueryResult>;

/** The engine for the connection's type runs the query. */
export const runOnEngine: EngineRunner = (database, query, options) => {
  const engine = engineFor(database.type);
  if (!engine) {
    return Promise.resolve({
      success: false,
      error: `Unsupported database type: ${database.type}`,
    });
  }
  return engine.executeQuery(database, query, options);
};

/**
 * The checks every query passes before it runs, or the refusal. Returns
 * the options to run it with (a person's read may gain
 * `readOnlyTransaction`).
 */
export async function checkQuery(
  database: IDatabaseConnection,
  query: DatabaseQuery,
  options?: QueryExecuteOptions,
): Promise<
  { refused: string } | { refused?: undefined; options?: QueryExecuteOptions }
> {
  // Writes are for the connection's writers; a read returns from this
  // at once, in memory (access/connection-writes.ts).
  const check = await checkConnectionWrite(database, query, options);
  if (check.refused) return { refused: check.refused };
  if (check.readOnlyTransaction) {
    options = { ...options, readOnlyTransaction: true };
  }
  if (options?.readOnly) {
    if (typeof query !== "string") {
      return {
        refused:
          "Read-only execution only supports SQL strings; arbitrary MongoDB execution is disabled",
      };
    }
    // Lexical read-only validation is the uniform guarantee. Engines with a
    // session/transaction read-only mode (Postgres READ ONLY txn, ClickHouse
    // readonly=2, ...) additionally enforce it; SQL engines without one
    // (e.g. BigQuery) rely on this validated single SELECT/WITH statement.
    const safety = checkPreviewQuerySafety(query, database.type);
    if (!safety.safe) {
      return { refused: safety.errors.join(" ") };
    }
    // Non-SQL engines can't be validated by the SQL analyzer, so fail closed.
    if (engineFor(database.type)?.nonSql) {
      return {
        refused: `Read-only execution is not supported for ${database.type}; connect it with database credentials restricted to read access`,
      };
    }
  }
  return { options };
}

/** Check, then run. Never throws: a failure is `{ success: false }`. */
export async function executeCheckedQuery(
  database: IDatabaseConnection,
  query: DatabaseQuery,
  options?: QueryExecuteOptions,
  run: EngineRunner = runOnEngine,
): Promise<QueryResult> {
  try {
    const checked = await checkQuery(database, query, options);
    if (checked.refused !== undefined) {
      return { success: false, error: checked.refused };
    }
    return await run(database, query, checked.options);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
