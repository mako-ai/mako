import { DatabaseDriver } from "../driver";
import { IDatabaseConnection } from "../../database/workspace-schema";

export interface ExecuteQueryResult {
  success: boolean;
  data?: unknown;
  error?: string;
  rowCount?: number;
}

export interface CapturedQuery {
  sql: string;
  options?: unknown;
}

export type QueryResponder = (
  sql: string,
  options?: unknown,
) => ExecuteQueryResult | Promise<ExecuteQueryResult>;

export interface CapturingDriver<D extends DatabaseDriver> {
  driver: D;
  /** Every (sql, options) pair passed to `executeQuery`, in call order. */
  calls: CapturedQuery[];
  /** SQL strings only, in call order. */
  sql(): string[];
  /** Most recent SQL string, if any. */
  lastSql(): string | undefined;
  /** Clear recorded calls (keeps the patched method). */
  reset(): void;
  /** Restore the driver's original `executeQuery`. */
  restore(): void;
}

/**
 * Replace a driver's `executeQuery` with a recording stub so write-method SQL
 * can be asserted with zero database. Drivers build SQL then delegate to
 * `this.executeQuery(db, sql)`, so this captures exactly what would hit the
 * engine.
 *
 * `responder` lets a test fake engine responses (e.g. INFORMATION_SCHEMA column
 * metadata for BigQuery typed writes). Defaults to an empty success result.
 *
 * Intentionally free of any test-runner imports so it is safe to share with
 * gated integration suites.
 */
export function makeCapturingDriver<D extends DatabaseDriver>(
  driver: D,
  responder: QueryResponder = () => ({ success: true, data: [] }),
): CapturingDriver<D> {
  const calls: CapturedQuery[] = [];
  const original = driver.executeQuery.bind(driver);

  (driver as DatabaseDriver).executeQuery = async (
    _db: IDatabaseConnection,
    sql: string,
    options?: unknown,
  ) => {
    calls.push({ sql, options });
    return responder(sql, options);
  };

  return {
    driver,
    calls,
    sql: () => calls.map(c => c.sql),
    lastSql: () => calls[calls.length - 1]?.sql,
    reset: () => {
      calls.length = 0;
    },
    restore: () => {
      (driver as DatabaseDriver).executeQuery = original;
    },
  };
}
