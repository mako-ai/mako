/**
 * A Postgres server-side cursor read on a checked-out client, shared by the
 * PostgreSQL engine and the Cloud SQL Postgres driver. The statement runs
 * once, in one transaction and one snapshot; OFFSET pages would re-run it and,
 * without an ORDER BY, may skip or repeat rows between pages.
 */
import type { PoolClient } from "pg";
import { StopReading } from "../../../services/query-row-cap";
import type { CursorReadOptions, QueryResult } from "../../query-types";
import {
  normalizePostgresFields,
  normalizePostgresRows,
} from "./pg-type-utils";

/** Rows a Postgres cursor fetches at a time. */
const CURSOR_FETCH_ROWS = 1000;

/**
 * The cursor read itself, on a client the caller checked out (and releases):
 * BEGIN (READ ONLY when asked), DECLARE `query` once, FETCH `fetchRows` at a
 * time into `onRows`, COMMIT. Any failure rolls back and throws. Shared by
 * the Postgres engine and the Cloud SQL Postgres driver.
 */
export async function readCursorOnClient(
  client: PoolClient,
  query: string,
  options: CursorReadOptions,
): Promise<QueryResult> {
  const { signal, timeoutMs } = options;
  const fetchRows = Math.max(
    1,
    Math.floor(options.fetchRows ?? CURSOR_FETCH_ROWS),
  );
  const keepRows = options.keepRows !== false;
  let open = false;
  try {
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
    await client.query(`DECLARE _mako_rows NO SCROLL CURSOR FOR\n${query}\n`);
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
  }
}

/** A failed cursor read as a result: a user cancel reads "Query cancelled". */
export function cursorFailure(error: unknown): QueryResult {
  if (
    error instanceof Error &&
    error.message.includes("canceling statement due to user request")
  ) {
    return { success: false, error: "Query cancelled" };
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : "PostgreSQL query failed",
  };
}
