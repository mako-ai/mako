import { describe, it, expect, beforeEach } from "vitest";
import { MySQLDatabaseDriver } from "./driver";
import {
  buildMySqlLayoutIndexes,
  buildUniqueIndexSql,
  buildUpsertSql,
  formatValue,
  inferMySqlType,
} from "./write";
import {
  makeCapturingDriver,
  makeFakeConnection,
  normalizeSql,
  type CapturingDriver,
} from "../../test-support";

/**
 * Write-SQL unit tests for the MySQL driver (CDC destination support).
 * Drivers build SQL then call `this.executeQuery`, so capturing that call
 * asserts the generated SQL with no database.
 */

const conn = makeFakeConnection("mysql", { database: "app" });

describe("MySQLDatabaseDriver write SQL", () => {
  let cap: CapturingDriver<MySQLDatabaseDriver>;
  let my: MySQLDatabaseDriver;

  const setup = (responder?: Parameters<typeof makeCapturingDriver>[1]) => {
    my = new MySQLDatabaseDriver();
    cap = makeCapturingDriver(my, responder);
  };

  beforeEach(() => setup());

  it("createTable backtick-quotes identifiers and renders nullability", async () => {
    await my.createTable(
      conn,
      "users",
      [
        { name: "id", type: "BIGINT", primaryKey: true },
        { name: "email", type: "TEXT", nullable: false },
        { name: "bio", type: "TEXT", nullable: true },
      ],
      { schema: "app" },
    );
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `app`.`users`");
    expect(sql).toContain("`id` BIGINT PRIMARY KEY");
    expect(sql).toContain("`email` TEXT NOT NULL");
    expect(sql).not.toContain("`bio` TEXT NOT NULL");
  });

  it("createTable never makes a TEXT column a bare primary key", async () => {
    await my.createTable(
      conn,
      "users",
      [{ name: "id", type: "TEXT", primaryKey: true }],
      { schema: "app" },
    );
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain("`id` TEXT");
    expect(sql).not.toContain("PRIMARY KEY");
  });

  it("insertBatch builds a multi-row VALUES statement with escaped literals", async () => {
    await my.insertBatch(
      conn,
      "users",
      [
        { id: 1, email: "a@b.com", active: true },
        { id: 2, email: "o'brien@x.com", active: false },
      ],
      { schema: "app" },
    );
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain("INSERT INTO `app`.`users` (`id`, `email`, `active`)");
    expect(sql).toContain("(1, 'a@b.com', 1)");
    expect(sql).toContain("(2, 'o''brien@x.com', 0)");
  });

  it("upsertBatch uses the 8.0.19+ alias syntax (no removed VALUES())", async () => {
    // Unique-index probe answers "exists" so no CREATE INDEX is emitted.
    setup(sql =>
      sql.includes("information_schema.statistics")
        ? { success: true, data: [{ index_name: "k", cols: "id" }] }
        : { success: true, data: [] },
    );
    await my.upsertBatch(conn, "users", [{ id: 1, email: "a@b.com" }], ["id"], {
      schema: "app",
    });
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain("AS `new` ON DUPLICATE KEY UPDATE");
    expect(sql).toContain("`email` = `new`.`email`");
    expect(sql).not.toMatch(/VALUES\s*\(\s*`email`\s*\)/i);
  });

  it("upsertBatch guards updates on _mako_source_ts and assigns ordering columns last", () => {
    const sql = normalizeSql(
      buildUpsertSql(
        "app",
        "users",
        ["id", "email", "_mako_source_ts"],
        [{ id: 1, email: "a@b.com", _mako_source_ts: new Date(0) }],
        ["id"],
      ),
    );
    expect(sql).toContain(
      "`email` = IF(COALESCE(`new`.`_mako_source_ts`, '1970-01-01') >= COALESCE(`users`.`_mako_source_ts`, '1970-01-01'), `new`.`email`, `users`.`email`)",
    );
    // Ordering column assignment comes AFTER the guarded columns.
    expect(sql.indexOf("`email` = IF(")).toBeLessThan(
      sql.indexOf("`_mako_source_ts` = IF("),
    );
  });

  it("upsertBatch creates a unique key index with a 191-char prefix for TEXT keys", async () => {
    setup(sql => {
      if (sql.includes("information_schema.statistics")) {
        return { success: true, data: [] }; // no unique index yet
      }
      if (sql.includes("information_schema.columns")) {
        return {
          success: true,
          data: [
            { column_name: "id", data_type: "text" },
            { column_name: "email", data_type: "text" },
          ],
        };
      }
      return { success: true, data: [] };
    });
    await my.upsertBatch(conn, "users", [{ id: "x" }], ["id"], {
      schema: "app",
    });
    const createIndex = cap
      .sql()
      .find(sql => sql.includes("CREATE UNIQUE INDEX"));
    expect(createIndex).toBeDefined();
    expect(normalizeSql(createIndex ?? "")).toContain(
      "ON `app`.`users` (`id`(191))",
    );
  });

  it("deleteBatch renders IS NULL and equality filters", async () => {
    await my.deleteBatch(
      conn,
      "users",
      { id: "abc", _dataSourceId: null },
      { schema: "app" },
    );
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toBe(
      "DELETE FROM `app`.`users` WHERE `id` = 'abc' AND `_dataSourceId` IS NULL",
    );
  });

  it("swapStagingTable is a single atomic multi-RENAME", async () => {
    await my.swapStagingTable(conn, "users", "users_staging", {
      schema: "app",
    });
    const renames = cap.sql().filter(sql => sql.startsWith("RENAME TABLE"));
    expect(renames).toHaveLength(1);
    expect(normalizeSql(renames[0])).toMatch(
      /RENAME TABLE `app`\.`users` TO `app`\.`users_old_\d+`, `app`\.`users_staging` TO `app`\.`users`/,
    );
  });

  it("addMissingColumns ALTERs only missing columns (checked, no IF NOT EXISTS)", async () => {
    setup(sql =>
      sql.includes("information_schema.columns")
        ? { success: true, data: [{ column_name: "id", data_type: "bigint" }] }
        : { success: true, data: [] },
    );
    await my.addMissingColumns(conn, "users", "app", [
      { id: 1, plan: "pro" },
    ]);
    const alters = cap.sql().filter(sql => sql.startsWith("ALTER TABLE"));
    expect(alters).toHaveLength(1);
    expect(normalizeSql(alters[0])).toBe(
      "ALTER TABLE `app`.`users` ADD COLUMN `plan` TEXT",
    );
  });
});

describe("mysql value/type mapping", () => {
  it("formats ISO timestamp strings and Dates as MySQL DATETIME literals", () => {
    expect(formatValue(new Date("2026-01-02T03:04:05.678Z"))).toBe(
      "'2026-01-02 03:04:05.678'",
    );
    expect(formatValue("2026-01-02T03:04:05.678Z")).toBe(
      "'2026-01-02 03:04:05.678'",
    );
  });

  it("formats booleans as 1/0 and objects as JSON literals", () => {
    expect(formatValue(true)).toBe("1");
    expect(formatValue({ a: 1 })).toBe("'{\"a\":1}'");
  });

  it("infers MySQL column types", () => {
    expect(inferMySqlType(1)).toBe("BIGINT");
    expect(inferMySqlType(1.5)).toBe("DOUBLE");
    expect(inferMySqlType(true)).toBe("TINYINT(1)");
    expect(inferMySqlType(new Date())).toBe("DATETIME(3)");
    expect(inferMySqlType("2026-01-02T03:04:05Z")).toBe("DATETIME(3)");
    expect(inferMySqlType({ a: 1 })).toBe("JSON");
    expect(inferMySqlType("plain")).toBe("TEXT");
  });
});

describe("mysql layout mapping — hints → secondary indexes", () => {
  it("creates one index per partition + cluster field with text prefixes", () => {
    const indexes = buildMySqlLayoutIndexes(
      {
        tableName: "crm_leads",
        keyColumns: ["id"],
        partitioning: { field: "created_at" },
        clustering: { fields: ["status"] },
      },
      "app",
      new Map([
        ["created_at", "datetime"],
        ["status", "text"],
      ]),
    );
    expect(indexes).toHaveLength(2);
    expect(normalizeSql(indexes[0].sql)).toBe(
      "CREATE INDEX `mako_layout_crm_leads_created_at` ON `app`.`crm_leads` (`created_at`)",
    );
    expect(normalizeSql(indexes[1].sql)).toBe(
      "CREATE INDEX `mako_layout_crm_leads_status` ON `app`.`crm_leads` (`status`(191))",
    );
  });

  it("skips key columns and returns nothing without hints", () => {
    expect(
      buildMySqlLayoutIndexes(
        { tableName: "t", keyColumns: ["id"], partitioning: { field: "id" } },
        "app",
        new Map(),
      ),
    ).toHaveLength(0);
    expect(
      buildMySqlLayoutIndexes({ tableName: "t" }, "app", new Map()),
    ).toHaveLength(0);
  });
});

describe("unique index naming", () => {
  it("stays within MySQL's 64-char identifier limit", () => {
    const { indexName } = buildUniqueIndexSql(
      "app",
      "a_very_long_table_name_that_keeps_going_and_going_forever",
      ["id", "_dataSourceId"],
      new Map(),
    );
    expect(indexName.length).toBeLessThanOrEqual(64);
  });
});
