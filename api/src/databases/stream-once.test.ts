/**
 * A streamed read (binding parquet builds, exports) runs the query ONCE on
 * every SQL engine.
 *
 * It used to page with `LIMIT n OFFSET k`, one query per page. Without an
 * ORDER BY an engine may return rows in a different order on every run, so
 * the pages overlapped and skipped rows. The fakes below answer every query
 * with the rows in a new order. A paged read duplicates and drops rows
 * against them; a single read returns each row exactly once.
 *
 * - Cloud SQL Postgres: a server-side cursor (DECLARE once, FETCH batches);
 * - MySQL: mysql2's query().stream();
 * - every other SQL engine: one query, capped, failing loudly past the cap.
 */
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IDatabaseConnection } from "../database/workspace-schema";
import { DatabaseConnectionService } from "../services/database-connection.service";
import { mssqlEngine } from "./drivers/mssql/engine";
import { mysqlEngine } from "./drivers/mysql/engine";
import { cloudSqlDriver } from "./engines";

const ROWS = Array.from({ length: 23 }, (_, i) => ({ id: i }));

/** A fresh order per call: rotate by the call number, reverse odd calls. */
function reordered(call: number): Array<{ id: number }> {
  const shift = (call * 7) % ROWS.length;
  const rotated = [...ROWS.slice(shift), ...ROWS.slice(0, shift)];
  return call % 2 ? rotated.reverse() : rotated;
}

/** Apply a trailing `LIMIT n [OFFSET k]` or `OFFSET k ROWS FETCH NEXT n`. */
function page<T>(sql: string, rows: T[]): T[] {
  const limit = /LIMIT (\d+)(?: OFFSET (\d+))?\s*$/i.exec(sql);
  if (limit) {
    const offset = Number(limit[2] ?? 0);
    return rows.slice(offset, offset + Number(limit[1]));
  }
  const fetch = /OFFSET (\d+) ROWS FETCH NEXT (\d+) ROWS ONLY\s*$/i.exec(sql);
  if (fetch) {
    const offset = Number(fetch[1]);
    return rows.slice(offset, offset + Number(fetch[2]));
  }
  return rows;
}

function conn(type: string): IDatabaseConnection {
  return {
    _id: "6577f0f0f0f0f0f0f0f0f0f0",
    type,
    name: `${type}-conn`,
    connection: { host: "db.internal", database: "app" },
  } as unknown as IDatabaseConnection;
}

async function readAll(type: string) {
  const ids: number[] = [];
  const batches: number[] = [];
  const result = await new DatabaseConnectionService().executeStreamingQuery(
    conn(type),
    "SELECT id FROM t",
    {
      batchSize: 5,
      readOnly: true,
      onBatch: async rows => {
        batches.push(rows.length);
        for (const row of rows) ids.push(row.id as number);
      },
    },
  );
  return { result, ids, batches };
}

function expectEveryRowOnce(ids: number[]) {
  expect(ids).toHaveLength(ROWS.length);
  expect([...ids].sort((a, b) => a - b)).toEqual(ROWS.map(r => r.id));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Cloud SQL Postgres streams through one cursor", () => {
  it("declares the query once and FETCHes it in batches", async () => {
    const statements: string[] = [];
    let calls = 0;
    let cursor: Array<{ id: number }> = [];
    const client = {
      processID: 4242,
      query: async (q: string | { text: string }) => {
        const text = typeof q === "string" ? q : q.text;
        statements.push(text);
        if (text.startsWith("DECLARE")) {
          cursor = reordered(++calls);
          return { rows: [], fields: [] };
        }
        const fetch = /^FETCH (\d+) FROM _mako_rows$/.exec(text);
        if (fetch) {
          const rows = cursor.splice(0, Number(fetch[1]));
          return { rows, fields: [{ name: "id", dataTypeID: 23 }] };
        }
        if (/^SELECT /.test(text)) {
          // A paged read: the query runs again, in a new order.
          return {
            rows: page(text, reordered(++calls)),
            fields: [{ name: "id", dataTypeID: 23 }],
          };
        }
        return { rows: [], fields: [] };
      },
      release: vi.fn(),
    };
    vi.spyOn(cloudSqlDriver(), "getConnection").mockResolvedValue({
      connect: async () => client,
      query: async () => ({ rows: [] }),
    } as never);

    const { result, ids, batches } = await readAll("cloudsql-postgres");

    expect(result).toEqual({ success: true, totalRows: ROWS.length });
    expectEveryRowOnce(ids);
    expect(batches).toEqual([5, 5, 5, 5, 3]);
    expect(statements.filter(s => s.startsWith("DECLARE"))).toHaveLength(1);
    expect(statements.some(s => /\bOFFSET\b/i.test(s))).toBe(false);
    expect(statements).toContain("BEGIN TRANSACTION READ ONLY");
    expect(statements).toContain("COMMIT");
    expect(client.release).toHaveBeenCalledWith(false);
  });
});

describe("MySQL streams one query", () => {
  it("reads mysql2's row stream once, in batches", async () => {
    const sql: string[] = [];
    let calls = 0;
    const connection = {
      threadId: null,
      query: async (q: string) => {
        sql.push(q);
        return [[], []];
      },
      // A paged read goes through execute(): a new order per call.
      execute: async (q: string) => {
        sql.push(q);
        return [page(q, reordered(++calls)), []];
      },
      commit: async () => undefined,
      rollback: async () => undefined,
      release: vi.fn(),
      destroy: vi.fn(),
      connection: {
        query: (q: string) => {
          sql.push(q);
          const rows = reordered(++calls);
          return { stream: () => Readable.from(rows) };
        },
      },
    };
    vi.spyOn(mysqlEngine, "getPool").mockResolvedValue({
      getConnection: async () => connection,
    } as never);

    const { result, ids, batches } = await readAll("mysql");

    expect(result).toEqual({ success: true, totalRows: ROWS.length });
    expectEveryRowOnce(ids);
    expect(batches).toEqual([5, 5, 5, 5, 3]);
    expect(sql).toEqual(["START TRANSACTION READ ONLY", "SELECT id FROM t"]);
    expect(connection.release).toHaveBeenCalledOnce();
  });
});

describe("other SQL engines run one capped query", () => {
  function fakeMssql() {
    const sql: string[] = [];
    vi.spyOn(mssqlEngine, "executeQuery").mockImplementation(
      async (_db, query) => {
        sql.push(String(query));
        const rows = page(String(query), reordered(sql.length));
        return { success: true, data: rows, rowCount: rows.length };
      },
    );
    return sql;
  }

  it("reads every row once from one query", async () => {
    const sql = fakeMssql();
    const { result, ids, batches } = await readAll("mssql");

    expect(result).toEqual({ success: true, totalRows: ROWS.length });
    expectEveryRowOnce(ids);
    expect(batches).toEqual([5, 5, 5, 5, 3]);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/FETCH NEXT 100001 ROWS ONLY$/);
  });

  it("fails loudly past the cap instead of cutting the result", async () => {
    vi.stubEnv("STREAM_SINGLE_READ_MAX_ROWS", "10");
    const sql = fakeMssql();
    const { result, ids } = await readAll("mssql");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/more than 10 rows/);
    expect(ids).toHaveLength(0);
    expect(sql).toHaveLength(1);
  });
});
