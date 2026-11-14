/**
 * The execute routes' row cap (query-row-cap.ts), with the engines stubbed:
 * batch-read engines stop at the cap, whole-result engines are cut, a cut is
 * marked, and writes are never read through a cursor.
 *
 * Run with: pnpm --filter api exec tsx src/services/query-row-cap.test.ts
 */
import assert from "node:assert/strict";

import type { IDatabaseConnection } from "../database/workspace-schema";
import type {
  QueryExecuteOptions,
  QueryResult,
} from "./database-connection.service";
import {
  capResult,
  DEFAULT_EXECUTE_MAX_ROWS,
  executeQueryWithRowCap,
  resolveExecuteMaxRows,
  StopReading,
} from "./query-row-cap";

type ReadingOptions = QueryExecuteOptions & {
  onRows: (rows: Record<string, unknown>[]) => void;
};

const rowsOf = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ i: from + i }));

const connection = (type: string) =>
  ({ type, name: "c", connection: {} }) as unknown as IDatabaseConnection;

/**
 * A service whose batch read hands over `total` rows in batches of `batch`
 * and stops at StopReading like the Postgres cursor (or, `failOnStop`, fails
 * like BigQuery's pages do), and whose executeQuery returns them whole.
 */
function fakeService(
  total: number,
  batch: number,
  opts: { failOnStop?: boolean } = {},
) {
  const calls = { reading: 0, whole: 0, rowsHandedOver: 0 };
  const seen: { options?: QueryExecuteOptions } = {};
  return {
    calls,
    seen,
    service: {
      async executeQueryReadingRows(
        _db: IDatabaseConnection,
        _q: string,
        options: ReadingOptions,
      ): Promise<QueryResult> {
        calls.reading++;
        seen.options = options;
        const read: Record<string, unknown>[] = [];
        for (let at = 0; at < total; at += batch) {
          const page = rowsOf(Math.min(batch, total - at), at);
          calls.rowsHandedOver += page.length;
          try {
            options.onRows(page);
          } catch (error) {
            if (opts.failOnStop || !(error instanceof StopReading)) {
              return { success: false, error: String(error) };
            }
            read.push(...page);
            break;
          }
          read.push(...page);
        }
        return {
          success: true,
          data: read,
          rowCount: read.length,
          fields: [{ name: "i", type: "int4" }],
        };
      },
      async executeQuery(
        _db: IDatabaseConnection,
        _q: unknown,
        options?: QueryExecuteOptions,
      ): Promise<QueryResult> {
        calls.whole++;
        seen.options = options;
        return {
          success: true,
          data: rowsOf(total),
          rowCount: total,
          fields: [{ name: "i", type: "int" }],
        };
      },
    },
  };
}

async function main() {
  // The cap's configuration.
  assert.equal(resolveExecuteMaxRows({}), DEFAULT_EXECUTE_MAX_ROWS);
  assert.equal(resolveExecuteMaxRows({ QUERY_EXECUTE_MAX_ROWS: "123" }), 123);
  for (const bad of ["0", "-5", "abc", "1.5", ""]) {
    assert.equal(
      resolveExecuteMaxRows({ QUERY_EXECUTE_MAX_ROWS: bad }),
      DEFAULT_EXECUTE_MAX_ROWS,
      bad,
    );
  }

  // capResult: under or at the cap untouched, over it cut and marked.
  const under = { success: true, data: rowsOf(3), rowCount: 3 };
  assert.equal(capResult(under, 3), under);
  const over = capResult({ success: true, data: rowsOf(5), rowCount: 5 }, 3);
  assert.equal((over.data as unknown[]).length, 3);
  assert.equal(over.truncated, true);
  assert.equal(over.rowCount, 3);
  assert.equal(over.rowLimit, 3);
  const failed = { success: false, error: "x" };
  assert.equal(capResult(failed, 1), failed);
  const notRows = { success: true, data: { n: 1 } };
  assert.equal(capResult(notRows, 1), notRows);
  const engineCut = capResult(
    { success: true, data: rowsOf(2), truncated: true },
    2,
  );
  assert.equal(engineCut.truncated, true, "an engine's own cut stays marked");
  assert.equal(engineCut.rowLimit, 2);

  // Postgres: read through the cursor, stopped just past the cap, with the
  // engine's own fields.
  {
    const { service, calls, seen } = fakeService(100_000, 1000);
    const result = await executeQueryWithRowCap(
      service,
      connection("postgresql"),
      "SELECT * FROM big",
      { executionId: "e1" },
      2500,
    );
    assert.equal(calls.reading, 1);
    assert.equal(calls.whole, 0);
    assert.ok(
      calls.rowsHandedOver <= 3000,
      `stopped early (${calls.rowsHandedOver} rows read)`,
    );
    assert.equal(result.success, true);
    assert.equal((result.data as unknown[]).length, 2500);
    assert.equal(result.truncated, true);
    assert.equal(result.rowCount, 2500);
    assert.deepEqual(result.fields, [{ name: "i", type: "int4" }]);
    assert.equal(seen.options?.executionId, "e1", "options pass through");
    assert.equal(seen.options?.maxRows, 2500);
  }
  // Postgres under the cap: whole, unmarked.
  {
    const { service } = fakeService(40, 1000);
    const result = await executeQueryWithRowCap(
      service,
      connection("postgresql"),
      "SELECT 1",
      {},
      50,
    );
    assert.equal((result.data as unknown[]).length, 40);
    assert.equal(result.truncated, undefined);
  }
  // BigQuery: paging stops; the engine reports the stop as a failure, and
  // the rows read are the result.
  {
    const { service, calls } = fakeService(10_000, 500, { failOnStop: true });
    const result = await executeQueryWithRowCap(
      service,
      connection("bigquery"),
      "SELECT * FROM ds.t",
      {},
      1200,
    );
    assert.equal(result.success, true);
    assert.equal((result.data as unknown[]).length, 1200);
    assert.equal(result.truncated, true);
    assert.ok(calls.rowsHandedOver <= 1500);
    assert.deepEqual(result.fields, [{ name: "i" }]);
  }
  // A Postgres write is never read through a cursor.
  {
    const { service, calls } = fakeService(5, 5);
    await executeQueryWithRowCap(
      service,
      connection("postgresql"),
      "DELETE FROM t RETURNING *",
      {},
      2,
    );
    assert.equal(calls.reading, 0);
    assert.equal(calls.whole, 1);
  }
  // Every other engine: run whole (told the cap), then cut.
  for (const type of ["mysql", "clickhouse", "mssql", "mongodb"]) {
    const { service, calls, seen } = fakeService(30, 30);
    const result = await executeQueryWithRowCap(
      service,
      connection(type),
      type === "mongodb" ? "db.t.find({})" : "SELECT * FROM t",
      {},
      10,
    );
    assert.equal(calls.whole, 1, type);
    assert.equal(seen.options?.maxRows, 10, type);
    assert.equal((result.data as unknown[]).length, 10, type);
    assert.equal(result.truncated, true, type);
    assert.deepEqual(result.fields, [{ name: "i", type: "int" }], type);
  }

  console.info("query-row-cap tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
