/**
 * A streamed ClickHouse read (binding parquet builds, exports) runs the
 * query ONCE.
 *
 * It used to page with `LIMIT n OFFSET k`, one query per page. ClickHouse
 * returns an unordered result (GROUP BY, GROUPING SETS, parallel reads) in a
 * different order on every run, so the pages overlapped: a binding of 8,306
 * rows came out with 8,306 rows but only 6,855 distinct keys.
 *
 * The fakes below answer every query with the rows in a new order, as
 * ClickHouse may. A paged read duplicates and drops rows against them; a
 * single read returns each row exactly once.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { IDatabaseConnection } from "../../../database/workspace-schema";
import { DatabaseConnectionService } from "../../../services/database-connection.service";
import {
  ClickHouseEngine,
  clickHouseEngine,
  type ClickHouseConnectDeps,
} from "./engine";

const ROWS = Array.from({ length: 23 }, (_, i) => ({ id: i }));

/** A fresh order per call: rotate by the call number, then reverse odd calls. */
function reordered(call: number): Array<{ id: number }> {
  const shift = (call * 7) % ROWS.length;
  const rotated = [...ROWS.slice(shift), ...ROWS.slice(0, shift)];
  return call % 2 ? rotated.reverse() : rotated;
}

/** Apply a `LIMIT n OFFSET k` wrapper, if the query carries one. */
function page<T>(sql: string, rows: T[]): T[] {
  const m = /LIMIT (\d+)(?: OFFSET (\d+))?\s*$/i.exec(sql);
  if (!m) return rows;
  const offset = Number(m[2] ?? 0);
  return rows.slice(offset, offset + Number(m[1]));
}

function fakeClickHouse(chunkSize = 4) {
  const queries: Array<{ query: string; settings: unknown }> = [];
  let closed = 0;
  const deps: ClickHouseConnectDeps = {
    now: () => 0,
    sleep: async () => undefined,
    createClient: () =>
      ({
        ping: async () => ({ success: true }),
        close: async () => {
          closed += 1;
        },
        query: async (params: {
          query: string;
          clickhouse_settings: unknown;
        }) => {
          queries.push({
            query: params.query,
            settings: params.clickhouse_settings,
          });
          const rows = page(params.query, reordered(queries.length));
          return {
            json: async () => rows,
            stream: () =>
              (async function* () {
                for (let i = 0; i < rows.length; i += chunkSize) {
                  yield rows
                    .slice(i, i + chunkSize)
                    .map(row => ({ json: () => row }));
                }
              })(),
          };
        },
      }) as never,
  };
  return { deps, queries, closed: () => closed };
}

function conn(type: string): IDatabaseConnection {
  return {
    _id: "6577f0f0f0f0f0f0f0f0f0f0",
    type,
    name: `${type}-conn`,
    connection: { host: "http://10.0.0.5", port: 8123 },
  } as unknown as IDatabaseConnection;
}

async function readAll(svc: DatabaseConnectionService, type: string) {
  const ids: number[] = [];
  const batches: number[] = [];
  const result = await svc.executeStreamingQuery(
    conn(type),
    "SELECT id FROM t GROUP BY GROUPING SETS ((id))",
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

describe("a streamed ClickHouse read runs the query once", () => {
  const swapped = clickHouseEngine as unknown as {
    deps: ClickHouseConnectDeps;
  };
  const original = swapped.deps;
  afterEach(() => {
    swapped.deps = original;
  });

  it("ClickHouse: every row exactly once, in batches, from one query", async () => {
    const fake = fakeClickHouse();
    swapped.deps = fake.deps;
    const { result, ids, batches } = await readAll(
      new DatabaseConnectionService(),
      "clickhouse",
    );

    expect(result).toEqual({ success: true, totalRows: ROWS.length });
    expect(new Set(ids).size).toBe(ROWS.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ROWS.map(r => r.id));
    expect(batches).toEqual([5, 5, 5, 5, 3]);
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0].query).not.toMatch(/\bOFFSET\b/i);
    expect(fake.queries[0].settings).toMatchObject({ readonly: "2" });
  });
});

describe("ClickHouseEngine.executeStreamingQuery", () => {
  it("re-batches the client's row chunks and closes the client", async () => {
    const fake = fakeClickHouse(3);
    const engine = new ClickHouseEngine(fake.deps);
    const batches: number[][] = [];
    const result = await engine.executeStreamingQuery(
      conn("clickhouse"),
      "SELECT id FROM t",
      {
        batchSize: 10,
        onBatch: async rows => {
          batches.push(rows.map(r => r.id as number));
        },
      },
    );
    expect(result).toEqual({ success: true, totalRows: ROWS.length });
    expect(batches.map(b => b.length)).toEqual([10, 10, 3]);
    expect(batches.flat()).toEqual(reordered(1).map(r => r.id));
    expect(fake.queries[0].settings).not.toHaveProperty("readonly");
    expect(fake.closed()).toBe(1);
  });

  it("a throw from onBatch stops the read and fails it", async () => {
    const fake = fakeClickHouse(3);
    const engine = new ClickHouseEngine(fake.deps);
    let seen = 0;
    const result = await engine.executeStreamingQuery(
      conn("clickhouse"),
      "SELECT id FROM t",
      {
        batchSize: 5,
        onBatch: async rows => {
          seen += rows.length;
          throw new Error("row limit");
        },
      },
    );
    expect(result).toEqual({
      success: false,
      totalRows: 0,
      error: "row limit",
    });
    expect(seen).toBe(5);
    expect(fake.closed()).toBe(1);
  });

  it("an aborted signal cancels before connecting", async () => {
    const fake = fakeClickHouse();
    const engine = new ClickHouseEngine(fake.deps);
    const controller = new AbortController();
    controller.abort();
    const result = await engine.executeStreamingQuery(
      conn("clickhouse"),
      "SELECT id FROM t",
      { signal: controller.signal, onBatch: async () => undefined },
    );
    expect(result).toMatchObject({ success: false, error: "Query cancelled" });
    expect(fake.queries).toHaveLength(0);
  });
});
