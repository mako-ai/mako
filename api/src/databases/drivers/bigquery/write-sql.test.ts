import { describe, it, expect } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
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

  // Meta ads, 19 Nov 2026: a NULL part of a composite key never matched `=`,
  // so each sync inserted the row again. The driver's ON clause runs in
  // DuckDB here, against the same NULL-keyed row upserted twice.
  it("upsertBatch matches a NULL part of a composite key", async () => {
    const bq = new BigQueryDatabaseDriver();
    const cap = makeCapturingDriver(bq, infoSchemaResponder);
    const res = await bq.upsertBatch(
      conn,
      "users",
      [{ id: 1, region: null, name: "v2" }],
      ["id", "region"],
      { schema: "ds" },
    );
    expect(res.success).toBe(true);
    const merge = cap
      .sql()
      .map(normalizeSql)
      .find(s => s.startsWith("MERGE INTO"));
    const on = merge?.match(/ ON (.+?) WHEN /)?.[1];
    expect(on).toBeDefined();

    const db = await DuckDBInstance.create(":memory:");
    const duck = await db.connect();
    await duck.run(
      "CREATE TABLE live (id INTEGER, region VARCHAR, name VARCHAR)",
    );
    await duck.run(
      "CREATE TABLE src AS SELECT 1 AS id, NULL::VARCHAR AS region, 'v2' AS name",
    );
    const duckMerge =
      `MERGE INTO live AS T USING src AS S ON ${on!.replace(/`/g, '"')} ` +
      "WHEN MATCHED THEN UPDATE SET name = S.name " +
      "WHEN NOT MATCHED THEN INSERT (id, region, name) VALUES (S.id, S.region, S.name)";
    await duck.run(duckMerge);
    await duck.run(duckMerge);
    const rows = (
      await duck.runAndReadAll("SELECT id, region, name FROM live")
    ).getRowObjects();
    duck.closeSync();
    db.closeSync();
    expect(rows).toEqual([{ id: 1, region: null, name: "v2" }]);
  });
});

/**
 * A full-sync swap retried after it already committed: the first attempt
 * swapped the rows in and dropped the staging table, then the step failed on
 * a follow-up DDL. Production (2026-11, ip_intel.crm_asns) retried the swap
 * 9 times over 4h22m; each retry backed the original up, dropped it, failed
 * to read the missing staging schema, restored it and leaked the backup.
 */
describe("BigQueryDatabaseDriver swapStagingTable", () => {
  /** INFORMATION_SCHEMA.TABLES says which tables exist. */
  function responderWith(existing: string[]): QueryResponder {
    return sql => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
        const found = existing.some(t => sql.includes(`table_name = '${t}'`));
        return { success: true, data: [{ cnt: found ? 1 : 0 }] };
      }
      if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
        // The staging table is gone, so its schema reads empty.
        return { success: true, data: [] };
      }
      return { success: true, data: [] };
    };
  }

  it("leaves the original alone when the staging table is missing", async () => {
    const bq = new BigQueryDatabaseDriver();
    const cap = makeCapturingDriver(bq, responderWith(["crm_asns"]));
    const result = await bq.swapStagingTable(
      conn,
      "crm_asns",
      "crm_asns_staging",
      { schema: "ip_intel", stagingSchema: "mako_internal" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Staging table mako_internal.crm_asns_staging not found",
    );
    const ddl = cap
      .sql()
      .map(normalizeSql)
      .filter(s => /^(CREATE|DROP|INSERT)/.test(s));
    expect(ddl).toEqual([]);
  });

  it("drops the backup after restoring the original from it", async () => {
    const bq = new BigQueryDatabaseDriver();
    // Staging exists by name but its columns cannot be read.
    const cap = makeCapturingDriver(
      bq,
      responderWith(["crm_asns", "crm_asns_staging"]),
    );
    const result = await bq.swapStagingTable(
      conn,
      "crm_asns",
      "crm_asns_staging",
      { schema: "ip_intel", stagingSchema: "mako_internal" },
    );

    expect(result.success).toBe(false);
    const all = cap.sql().map(normalizeSql);
    const backup = all
      .find(s =>
        s.startsWith("CREATE TABLE `proj`.`ip_intel`.`crm_asns_backup_"),
      )
      ?.match(/`(crm_asns_backup_\d+)`/)?.[1];
    expect(backup).toBeDefined();
    expect(all).toContain(
      `CREATE OR REPLACE TABLE \`proj\`.\`ip_intel\`.\`crm_asns\` AS SELECT * FROM \`proj\`.\`ip_intel\`.\`${backup}\`;`,
    );
    expect(all).toContain(
      `DROP TABLE IF EXISTS \`proj\`.\`ip_intel\`.\`${backup}\`;`,
    );
  });

  it("names the backup when the restore fails too", async () => {
    const bq = new BigQueryDatabaseDriver();
    const base = responderWith(["crm_asns", "crm_asns_staging"]);
    makeCapturingDriver(bq, sql =>
      sql.startsWith("CREATE OR REPLACE TABLE")
        ? { success: false, error: "quota" }
        : base(sql),
    );
    const result = await bq.swapStagingTable(
      conn,
      "crm_asns",
      "crm_asns_staging",
      { schema: "ip_intel", stagingSchema: "mako_internal" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /its rows are kept in ip_intel\.crm_asns_backup_\d+/,
    );
  });
});
