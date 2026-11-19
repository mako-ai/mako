/**
 * The server-side row cap of the ad-hoc execute routes.
 *
 * Without it one `SELECT *` of a large table was read whole into the API
 * process and sent back as one JSON body (1M rows: 132 MB of JSON, and the
 * process grew by ~700 MB with four of them running). The cap reads at most
 * `maxRows + 1` rows where the engine can stop early, and cuts the rest:
 *
 * - Postgres reads go through a cursor (executeQueryReadingRows), which stops
 *   fetching once the cap is passed;
 * - BigQuery stops paging its job's results;
 * - MongoDB shell queries stop reading their cursor (mongo-shell-interpreter);
 *   structured find/aggregate requests get a limit;
 * - every other engine returns its result whole, and it is cut here.
 *
 * A cut result is still a success: `truncated: true`, `rowCount` the rows
 * returned, `rowLimit` the cap.
 */
import { isWrite } from "../access/connection-writes";
import type { IDatabaseConnection } from "../database/workspace-schema";
import type { DatabaseQuery } from "../databases/query-types";
import type {
  DatabaseConnectionService,
  QueryExecuteOptions,
  QueryResult,
} from "./database-connection.service";
import { inferFieldsFromRows } from "./query-pagination.service";

/** Default row cap of the execute routes; QUERY_EXECUTE_MAX_ROWS overrides. */
export const DEFAULT_EXECUTE_MAX_ROWS = 50_000;

/** The row cap: QUERY_EXECUTE_MAX_ROWS when a positive integer, else 50,000. */
export function resolveExecuteMaxRows(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.QUERY_EXECUTE_MAX_ROWS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EXECUTE_MAX_ROWS;
}

/**
 * Default cap of a streamed read that runs as ONE query with no native
 * stream (D1, MSSQL, Redshift): the whole result is held in memory, so it is
 * bounded. STREAM_SINGLE_READ_MAX_ROWS overrides.
 */
export const DEFAULT_SINGLE_READ_MAX_ROWS = 100_000;

/** STREAM_SINGLE_READ_MAX_ROWS when a positive integer, else 100,000. */
export function resolveSingleReadMaxRows(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.STREAM_SINGLE_READ_MAX_ROWS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SINGLE_READ_MAX_ROWS;
}

/** The failure of a single read whose result passed the cap. */
export function singleReadOverCapError(
  databaseType: string,
  maxRows: number,
): string {
  return (
    `The query returned more than ${maxRows.toLocaleString("en-US")} rows. ` +
    `A ${databaseType} result is read in one piece, so it is capped there ` +
    `(STREAM_SINGLE_READ_MAX_ROWS). Aggregate or filter it in SQL.`
  );
}

/**
 * Thrown from an `onRows` callback to stop reading without failing: the
 * Postgres cursor read then returns what it read so far.
 */
export class StopReading extends Error {
  constructor() {
    super("Row cap reached");
    this.name = "StopReading";
  }
}

/** Engines whose reads stop early through executeQueryReadingRows. */
const READ_IN_BATCHES = new Set(["postgresql", "bigquery"]);

export type CappedQueryResult = QueryResult & { rowLimit?: number };

/** `result` cut to `maxRows` rows, marked when cut. */
export function capResult(
  result: QueryResult,
  maxRows: number,
): CappedQueryResult {
  if (!result.success || !Array.isArray(result.data)) return result;
  const cut = result.truncated === true || result.data.length > maxRows;
  if (!cut) return result;
  const data = result.data.slice(0, maxRows);
  return {
    ...result,
    data,
    rowCount: data.length,
    truncated: true,
    rowLimit: maxRows,
  };
}

/**
 * Run `query` like `service.executeQuery`, reading at most `maxRows` rows
 * (see the top of this file).
 */
export async function executeQueryWithRowCap(
  service: Pick<
    DatabaseConnectionService,
    "executeQuery" | "executeQueryReadingRows"
  >,
  database: IDatabaseConnection,
  query: DatabaseQuery,
  options: QueryExecuteOptions,
  maxRows: number,
): Promise<CappedQueryResult> {
  const cap = Math.max(1, Math.floor(maxRows));
  if (
    typeof query === "string" &&
    READ_IN_BATCHES.has(database.type) &&
    !isWrite(database.type, query)
  ) {
    const kept: Record<string, unknown>[] = [];
    let stopped = false;
    const result = await service.executeQueryReadingRows(database, query, {
      ...options,
      maxRows: cap,
      onRows: rows => {
        for (const row of rows) {
          if (kept.length > cap) break;
          kept.push(row);
        }
        if (kept.length > cap) {
          stopped = true;
          throw new StopReading();
        }
      },
    });
    if (!result.success && stopped) {
      // The engine failed on the stop (BigQuery's pages, or a whole result
      // handed over at once): the rows it gave are the result.
      return capResult(
        { success: true, data: kept, fields: inferFieldsFromRows(kept) },
        cap,
      );
    }
    return capResult(result, cap);
  }
  const result = await service.executeQuery(database, query, {
    ...options,
    maxRows: cap,
  });
  return capResult(result, cap);
}
