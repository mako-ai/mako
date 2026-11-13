/**
 * inspect_table descriptions: dbt's when the table is a dbt relation, the
 * warehouse's (BigQuery INFORMATION_SCHEMA) otherwise, and the response
 * shape of before when neither has any.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

const queries = vi.hoisted(() => [] as string[]);
const warehouse = vi.hoisted(() => ({
  descriptions: [] as Array<Record<string, unknown>>,
  failDescriptions: false,
}));
const manifests = vi.hoisted(() => ({
  value: [] as unknown[],
  fail: false,
}));

vi.mock("../../services/database-connection.service", () => ({
  databaseConnectionService: {
    executeQuery: vi.fn(async (_database: unknown, sql: string) => {
      queries.push(sql);
      if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
        return {
          success: true,
          data: [
            {
              column_name: "account_id",
              data_type: "STRING",
              is_nullable: "NO",
            },
            { column_name: "name", data_type: "STRING", is_nullable: "YES" },
          ],
        };
      }
      if (sql.includes("COLUMN_FIELD_PATHS")) {
        return warehouse.failDescriptions
          ? { success: false, error: "Access Denied" }
          : { success: true, data: warehouse.descriptions };
      }
      return { success: true, data: [{ account_id: "a1", name: "Acme" }] };
    }),
  },
}));
vi.mock("../../dbt/ontology/manifest-index.service", () => ({
  loadManifestIndexes: vi.fn(async () => {
    if (manifests.fail) throw new Error("mongo down");
    return manifests.value;
  }),
}));

import { inspectSqlTableImpl } from "./sql-tools";
import { DatabaseConnection } from "../../database/workspace-schema";
import { buildManifestIndex } from "../../dbt/ontology/manifest-index";
import { ONTOLOGY_MANIFEST } from "../../dbt/test-support/ontology-fixtures";

const WS = new Types.ObjectId().toString();
const CONN = new Types.ObjectId().toString();

const BEFORE = {
  sqlDialect: "bigquery",
  entityKind: "table",
  database: "dbt_prod",
  fields: [
    { name: "account_id", types: ["STRING"], nullable: false },
    { name: "name", types: ["STRING"], nullable: true },
  ],
};

beforeEach(() => {
  queries.length = 0;
  warehouse.descriptions = [];
  warehouse.failDescriptions = false;
  manifests.fail = false;
  manifests.value = [
    {
      projectId: "p1",
      projectName: "Analytics",
      source: "prod",
      index: buildManifestIndex(ONTOLOGY_MANIFEST),
    },
  ];
  vi.spyOn(DatabaseConnection, "findOne").mockResolvedValue({
    type: "bigquery",
    connection: { project_id: "acme-prod" },
  } as never);
});

const inspect = (database: string, table: string) =>
  inspectSqlTableImpl(CONN, database, table, WS) as Promise<
    Record<string, unknown>
  >;

describe("inspect_table descriptions", () => {
  it("prefers the dbt manifest when the table is a dbt relation", async () => {
    warehouse.descriptions = [
      { column_name: "", description: '"From the warehouse"' },
    ];
    const result = await inspect("dbt_prod", "dim_account");
    expect(result).toMatchObject({
      ...BEFORE,
      entityName: "dim_account",
      description: "One row per account (customer organisation).",
      descriptionSource: "dbt",
      dbtNode: { name: "dim_account", resourceType: "model" },
      fields: [
        {
          name: "account_id",
          types: ["STRING"],
          nullable: false,
          description: "Primary key.",
        },
        { name: "name", types: ["STRING"], nullable: true },
      ],
    });
    expect(typeof result.samples).toBe("string");
    // dbt answered: the warehouse was not asked for descriptions.
    expect(queries.some(sql => sql.includes("COLUMN_FIELD_PATHS"))).toBe(false);
  });

  it("maps a dbt source table too", async () => {
    const result = await inspect("crm_public", "organisations");
    expect(result).toMatchObject({
      description: "CRM organisations.",
      descriptionSource: "dbt",
      dbtNode: { name: "crm.organisations", resourceType: "source" },
    });
  });

  it("falls back to BigQuery's own descriptions for a table dbt does not know", async () => {
    warehouse.descriptions = [
      { column_name: "", description: '"Legacy accounts export"' },
      { column_name: "name", description: "Display name" },
    ];
    const result = await inspect("legacy", "accounts");
    expect(result).toMatchObject({
      ...BEFORE,
      database: "legacy",
      description: "Legacy accounts export",
      descriptionSource: "warehouse",
      fields: [
        { name: "account_id", types: ["STRING"], nullable: false },
        {
          name: "name",
          types: ["STRING"],
          nullable: true,
          description: "Display name",
        },
      ],
    });
    expect(result.dbtNode).toBeUndefined();
    const sql = queries.find(q => q.includes("COLUMN_FIELD_PATHS")) ?? "";
    expect(sql).toContain(
      "`acme-prod`.`legacy`.INFORMATION_SCHEMA.TABLE_OPTIONS",
    );
    expect(sql).toContain("option_name = 'description'");
    expect(sql).toContain("table_name = 'accounts'");
    expect(sql).toContain("field_path = column_name");
  });

  it("keeps the previous response shape when nothing describes the table", async () => {
    const result = await inspect("legacy", "accounts");
    expect(Object.keys(result).sort()).toEqual([
      "database",
      "entityKind",
      "entityName",
      "fields",
      "samples",
      "sqlDialect",
    ]);
    expect(result).toMatchObject({ ...BEFORE, database: "legacy" });
  });

  it("still inspects when the manifest or the description query fails", async () => {
    manifests.fail = true;
    warehouse.failDescriptions = true;
    const result = await inspect("legacy", "accounts");
    expect(result).toMatchObject({ ...BEFORE, database: "legacy" });
    expect(result.description).toBeUndefined();
    expect(result.descriptionSource).toBeUndefined();
  });
});
