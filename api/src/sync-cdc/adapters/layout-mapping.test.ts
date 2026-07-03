import { describe, it, expect } from "vitest";
import { buildPgLayoutIndexStatements } from "./postgresql";
import { buildMongoLayoutIndexSpecs } from "./mongodb";

/**
 * Destination-layout contract: the engine-agnostic layout hints
 * (partition field + cluster fields from entityLayouts) map to each engine's
 * native physical layout:
 *
 *   BigQuery    PARTITION BY + CLUSTER BY  (bigquery.ts, covered by
 *               bigquery-merge.test.ts DDL assertions)
 *   ClickHouse  PARTITION BY + ORDER BY    (clickhouse.ts, covered by
 *               repartition-sql.test.ts)
 *   PostgreSQL  secondary btree indexes    (this file)
 *   MongoDB     secondary indexes          (this file)
 */
describe("postgresql layout mapping — hints → btree indexes", () => {
  it("creates one index per partition + cluster field", () => {
    const statements = buildPgLayoutIndexStatements(
      {
        tableName: "crm_leads",
        keyColumns: ["id"],
        partitioning: { type: "time", field: "created_at" },
        clustering: { fields: ["status", "owner_id"] },
      },
      "public",
    );
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe(
      'CREATE INDEX IF NOT EXISTS "mako_layout_crm_leads_created_at" ON "public"."crm_leads" ("created_at")',
    );
    expect(statements[1]).toContain('("status")');
    expect(statements[2]).toContain('("owner_id")');
  });

  it("skips key columns (already covered by the unique key index)", () => {
    const statements = buildPgLayoutIndexStatements(
      {
        tableName: "t",
        keyColumns: ["id"],
        partitioning: { type: "time", field: "id" },
        clustering: { fields: ["id"] },
      },
      "public",
    );
    expect(statements).toHaveLength(0);
  });

  it("dedupes a field used for both partitioning and clustering", () => {
    const statements = buildPgLayoutIndexStatements(
      {
        tableName: "t",
        keyColumns: [],
        partitioning: { type: "time", field: "updated_at" },
        clustering: { fields: ["updated_at"] },
      },
      "public",
    );
    expect(statements).toHaveLength(1);
  });

  it("quotes identifiers (case-folding + injection safety)", () => {
    const statements = buildPgLayoutIndexStatements(
      {
        tableName: "MyTable",
        keyColumns: [],
        partitioning: { type: "time", field: '_syncedAt' },
      },
      "Analytics",
    );
    expect(statements[0]).toContain('"Analytics"."MyTable"');
    expect(statements[0]).toContain('("_syncedAt")');
  });

  it("returns nothing when no hints are set", () => {
    expect(
      buildPgLayoutIndexStatements(
        { tableName: "t", keyColumns: ["id"] },
        "public",
      ),
    ).toHaveLength(0);
  });
});

describe("mongodb layout mapping — hints → secondary indexes", () => {
  it("creates one index spec per partition + cluster field", () => {
    const specs = buildMongoLayoutIndexSpecs({
      keyColumns: ["id"],
      partitioning: { type: "time", field: "created_at" },
      clustering: { fields: ["status"] },
    });
    expect(specs).toEqual([
      { field: "created_at", name: "mako_layout_created_at" },
      { field: "status", name: "mako_layout_status" },
    ]);
  });

  it("skips key columns and dedupes", () => {
    const specs = buildMongoLayoutIndexSpecs({
      keyColumns: ["id"],
      partitioning: { type: "time", field: "ts" },
      clustering: { fields: ["ts", "id"] },
    });
    expect(specs).toEqual([{ field: "ts", name: "mako_layout_ts" }]);
  });

  it("returns nothing when no hints are set", () => {
    expect(buildMongoLayoutIndexSpecs({ keyColumns: ["id"] })).toHaveLength(0);
  });
});
