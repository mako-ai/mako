import { describe, it, expect } from "vitest";
import { BigQueryDatabaseDriver } from "./driver";
import {
  makeCapturingDriver,
  makeFakeConnection,
  normalizeSql,
  type QueryResponder,
} from "../../test-support";

/**
 * Write-SQL unit tests for the BigQuery driver. Asserts backtick-qualified
 * `project.dataset.table` refs, typed column handling, and DDL shape with no
 * BigQuery connection. Methods that read INFORMATION_SCHEMA are fed canned
 * column metadata via the capturing driver's responder.
 */

const conn = makeFakeConnection("bigquery", { project_id: "proj" });

/** Responder that fakes INFORMATION_SCHEMA reads for a users table. */
const infoSchemaResponder: QueryResponder = sql => {
  if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
    return {
      success: true,
      data: [
        { column_name: "id", data_type: "INT64" },
        { column_name: "name", data_type: "STRING" },
      ],
    };
  }
  // SCHEMATA probe etc.
  return { success: true, data: [] };
};

describe("BigQueryDatabaseDriver write SQL", () => {
  it("createTable builds a backtick-qualified ref and injects soft-delete cols", async () => {
    const bq = new BigQueryDatabaseDriver();
    const cap = makeCapturingDriver(bq);
    await bq.createTable(
      conn,
      "users",
      [
        { name: "id", type: "INT64" },
        { name: "name", type: "STRING", nullable: false },
      ],
      {
        schema: "ds",
        softDeleteColumns: { isDeleted: "is_deleted", deletedAt: "deleted_at" },
      },
    );
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `proj`.`ds`.`users`");
    expect(sql).toContain("`name` STRING NOT NULL");
    expect(sql).toContain("`is_deleted` BOOL");
    expect(sql).toContain("`deleted_at` TIMESTAMP");
  });

  it("ensureSchema creates the dataset with a location when missing", async () => {
    const bq = new BigQueryDatabaseDriver();
    const cap = makeCapturingDriver(bq); // default: SCHEMATA probe returns empty
    await bq.ensureSchema(conn, "mako_internal", { location: "EU" });
    const all = cap.sql().map(normalizeSql);
    expect(
      all.some(s =>
        s.includes(
          "CREATE SCHEMA IF NOT EXISTS `proj`.`mako_internal` OPTIONS(location='EU')",
        ),
      ),
    ).toBe(true);
  });

  it("dropTable is guarded with IF EXISTS", async () => {
    const bq = new BigQueryDatabaseDriver();
    const cap = makeCapturingDriver(bq);
    await bq.dropTable(conn, "users", { schema: "ds" });
    expect(normalizeSql(cap.lastSql() ?? "")).toBe(
      "DROP TABLE IF EXISTS `proj`.`ds`.`users`;",
    );
  });

  it("deleteBatch builds a NULL-safe WHERE on the qualified table", async () => {
    const bq = new BigQueryDatabaseDriver();
    const cap = makeCapturingDriver(bq);
    await bq.deleteBatch(
      conn,
      "users",
      { id: 5, tenant: null },
      { schema: "ds" },
    );
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain("DELETE FROM `proj`.`ds`.`users` WHERE");
    expect(sql).toContain("`id` = '5'");
    expect(sql).toContain("`tenant` IS NULL");
  });

  it("addMissingColumns batch-adds columns absent from INFORMATION_SCHEMA", async () => {
    const bq = new BigQueryDatabaseDriver();
    // COLUMNS probe returns only `id` → name + email are missing.
    const cap = makeCapturingDriver(bq, sql =>
      sql.includes("INFORMATION_SCHEMA.COLUMNS")
        ? { success: true, data: [{ column_name: "id", data_type: "INT64" }] }
        : { success: true, data: [] },
    );
    await bq.addMissingColumns(conn, "users", "ds", [
      { id: 1, name: "x", email: "a@b.com" },
    ]);
    const alter = cap
      .sql()
      .map(normalizeSql)
      .find(s => s.startsWith("ALTER TABLE"));
    expect(alter).toContain("ALTER TABLE `proj`.`ds`.`users`");
    expect(alter).toContain("ADD COLUMN IF NOT EXISTS `name`");
    expect(alter).toContain("ADD COLUMN IF NOT EXISTS `email`");
    expect(alter).not.toContain("`id`");
  });

  it("insertBatch emits a typed INSERT against the qualified table", async () => {
    const bq = new BigQueryDatabaseDriver();
    const cap = makeCapturingDriver(bq, infoSchemaResponder);
    const res = await bq.insertBatch(
      conn,
      "users",
      [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ],
      { schema: "ds" },
    );
    expect(res.success).toBe(true);
    expect(res.rowsWritten).toBe(2);
    const insert = cap
      .sql()
      .map(normalizeSql)
      .find(s => s.startsWith("INSERT INTO"));
    expect(insert).toContain(
      "INSERT INTO `proj`.`ds`.`users` (`id`, `name`) VALUES",
    );
  });
});
