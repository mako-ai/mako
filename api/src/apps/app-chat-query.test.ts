/**
 * "Chat with app" SQL: the agent's query sees the app's binding tables and
 * nothing else on the host.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeAppData,
  queryAppData,
  type AppDataTable,
} from "./app-chat-query";

let dir: string;
let tables: AppDataTable[];
let secret: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-chat-query-"));
  const orders = path.join(dir, "orders.parquet");
  const regions = path.join(dir, "regions.parquet");
  secret = path.join(dir, "secret.csv");
  fs.writeFileSync(secret, "token\nshh\n");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    `COPY (SELECT range AS id, range % 3 AS region_id, range * 10 AS amount FROM range(500)) TO '${orders}' (FORMAT parquet)`,
  );
  await connection.run(
    `COPY (SELECT * FROM (VALUES (0, 'EU'), (1, 'US'), (2, 'APAC')) t(id, name)) TO '${regions}' (FORMAT parquet)`,
  );
  connection.closeSync();
  instance.closeSync();
  tables = [
    { name: "orders", file: orders },
    { name: "sales-regions", file: regions },
  ];
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("queryAppData", () => {
  it("queries bindings as tables, including hyphenated names", async () => {
    const result = await queryAppData(
      tables,
      `SELECT r.name, sum(o.amount)::BIGINT AS total
         FROM orders o JOIN "sales-regions" r ON r.id = o.region_id
        GROUP BY 1 ORDER BY 1`,
    );
    expect(result.columns.map(c => c.name)).toEqual(["name", "total"]);
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it("caps rows and says so", async () => {
    const result = await queryAppData(tables, "SELECT * FROM orders", {
      maxRows: 10,
    });
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it.each([
    ["read another file", () => `SELECT * FROM read_csv('${secret}')`],
    ["read a system file", () => "SELECT * FROM read_text('/etc/passwd')"],
    ["write a file", () => `COPY orders TO '${path.join(dir, "out.csv")}'`],
    ["attach a database", () => `ATTACH '${path.join(dir, "x.db")}'`],
    ["re-enable file access", () => "SET enable_external_access = true"],
    ["install an extension", () => "INSTALL httpfs"],
  ])("refuses to %s", async (_label, sql) => {
    await expect(queryAppData(tables, sql())).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, "out.csv"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "x.db"))).toBe(false);
  });

  it("gets a fresh database per query, so a DROP touches nothing", async () => {
    await queryAppData(tables, "DROP VIEW orders");
    const result = await queryAppData(
      tables,
      "SELECT count(*) AS n FROM orders",
    );
    expect(result.rows[0]).toEqual({ n: "500" });
  });

  it("times out a runaway query", async () => {
    await expect(
      queryAppData(tables, "SELECT count(*) FROM range(100000000000) a", {
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("describeAppData", () => {
  it("returns columns, row counts and samples", async () => {
    const [orders, regions] = await describeAppData(tables, 2);
    expect(orders.rowCount).toBe(500);
    expect(orders.columns.map(c => c.name)).toEqual([
      "id",
      "region_id",
      "amount",
    ]);
    expect(orders.sampleRows).toHaveLength(2);
    expect(regions.name).toBe("sales-regions");
    expect(regions.rowCount).toBe(3);
  });
});
