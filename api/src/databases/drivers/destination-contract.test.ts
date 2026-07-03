import { describe, it, expect } from "vitest";
import { BigQueryDatabaseDriver } from "./bigquery/driver";
import { PostgreSQLDatabaseDriver } from "./postgresql/driver";
import { CloudSQLPostgresDatabaseDriver } from "./cloudsql-postgres/driver";
import { MySQLDatabaseDriver } from "./mysql/driver";
import { RedshiftDatabaseDriver } from "./redshift/driver";
import { BIGQUERY_WORKING_DATASET } from "../../utils/bigquery-working-dataset";
import {
  runDestinationContract,
  type DestinationContractExpectations,
} from "../test-support/destination-contract";
import { DatabaseDriver } from "../driver";

/**
 * Contract tests for the destination-dialect capabilities on DatabaseDriver.
 * Adding a new sync destination = adding one row here.
 */

const PG_ROWCOUNT_EXPECTED =
  "SELECT c.relname AS table_id, c.reltuples::bigint AS row_count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('a''b','c')";

const BQ_MAP_COLUMN_CASES: Array<[string, string]> = [
  ["text", "STRING"],
  ["VARCHAR(255)", "STRING"],
  ["clob", "STRING"],
  ["integer", "INT64"],
  ["int8", "INT64"],
  ["bigint", "INT64"],
  ["real", "FLOAT64"],
  // NOTE: the float check uses exact `=== "DOUBLE"`, so "double precision"
  // falls through to the STRING default. Pre-existing behavior, locked in here.
  ["double precision", "STRING"],
  ["numeric", "FLOAT64"],
  ["blob", "BYTES"],
  ["boolean", "BOOL"],
  ["timestamp", "TIMESTAMP"],
  ["date", "TIMESTAMP"],
  ["jsonb", "STRING"],
  ["uuid", "STRING"],
];

const cases: Array<[DatabaseDriver, DestinationContractExpectations]> = [
  [
    new BigQueryDatabaseDriver(),
    {
      type: "bigquery",
      stagingSchema: {
        cases: [
          { primary: "user_ds", expected: BIGQUERY_WORKING_DATASET },
          { primary: undefined, expected: BIGQUERY_WORKING_DATASET },
        ],
      },
      softDeleteForCdc: { value: true },
      typedColumns: { value: true },
      mapColumnType: { cases: BQ_MAP_COLUMN_CASES },
      formatTableRef: {
        cases: [
          { schema: "ds", table: "tbl", expected: "`ds`.tbl" },
          {
            schema: "ds",
            table: "tbl",
            projectId: "proj",
            expected: "`proj`.`ds`.tbl",
          },
        ],
      },
      rowCountBatchQuery: {
        schema: "ds",
        tables: ["a'b", "c"],
        projectId: "proj",
        expected:
          "SELECT table_id, row_count FROM `proj`.`ds`.__TABLES__ WHERE table_id IN ('a''b','c')",
      },
      quoteIdentifier: { absent: true },
    },
  ],
  [
    new PostgreSQLDatabaseDriver(),
    {
      type: "postgresql",
      stagingSchema: { absent: true },
      softDeleteForCdc: { absent: true },
      typedColumns: { absent: true },
      mapColumnType: { absent: true },
      formatTableRef: { absent: true },
      rowCountBatchQuery: {
        schema: "public",
        tables: ["a'b", "c"],
        expected: PG_ROWCOUNT_EXPECTED,
      },
      quoteIdentifier: {
        cases: [
          ["_syncedAt", '"_syncedAt"'],
          ['weird"name', '"weird""name"'],
        ],
      },
    },
  ],
  [
    new CloudSQLPostgresDatabaseDriver(),
    {
      type: "cloudsql-postgres",
      stagingSchema: { absent: true },
      softDeleteForCdc: { absent: true },
      typedColumns: { absent: true },
      mapColumnType: { absent: true },
      formatTableRef: { absent: true },
      rowCountBatchQuery: {
        schema: "public",
        tables: ["a'b", "c"],
        expected: PG_ROWCOUNT_EXPECTED,
      },
      quoteIdentifier: {
        cases: [
          ["_syncedAt", '"_syncedAt"'],
          ['weird"name', '"weird""name"'],
        ],
      },
    },
  ],
  [
    new MySQLDatabaseDriver(),
    {
      type: "mysql",
      stagingSchema: { absent: true },
      softDeleteForCdc: { absent: true },
      typedColumns: { absent: true },
      mapColumnType: { absent: true },
      formatTableRef: {
        cases: [
          { schema: "app", table: "tbl", expected: "`app`.`tbl`" },
          { schema: undefined, table: "tbl", expected: "`tbl`" },
        ],
      },
      // No cheap metadata row-count path wired up (information_schema
      // estimates are unreliable for InnoDB) — callers skip counting.
      rowCountBatchQuery: { absent: true },
      quoteIdentifier: {
        cases: [
          ["_syncedAt", "`_syncedAt`"],
          ["weird`name", "`weird``name`"],
        ],
      },
    },
  ],
  [
    new RedshiftDatabaseDriver(),
    {
      type: "redshift",
      stagingSchema: { absent: true },
      softDeleteForCdc: { absent: true },
      typedColumns: { absent: true },
      mapColumnType: { absent: true },
      formatTableRef: { absent: true },
      // Redshift has no cheap metadata row-count path → callers skip counting.
      rowCountBatchQuery: { absent: true },
      quoteIdentifier: {
        cases: [
          ["_syncedAt", '"_syncedAt"'],
          ['weird"name', '"weird""name"'],
        ],
      },
    },
  ],
];

for (const [driver, expectations] of cases) {
  describe(`destination contract: ${expectations.type}`, () => {
    runDestinationContract(driver, expectations);
  });
}

// Supplementary cases not expressible in the generic single-case contract.
describe("destination contract: extra cases", () => {
  const bq = new BigQueryDatabaseDriver();

  it("BigQuery row-count query without a projectId", () => {
    expect(bq.buildRowCountBatchQuery("ds", ["a'b", "c"])).toBe(
      "SELECT table_id, row_count FROM `ds`.__TABLES__ WHERE table_id IN ('a''b','c')",
    );
  });

  it("Postgres and Cloud SQL Postgres produce identical row-count SQL", () => {
    const pg = new PostgreSQLDatabaseDriver();
    const cloudsql = new CloudSQLPostgresDatabaseDriver();
    const tables = ["a'b", "c"];
    expect(cloudsql.buildRowCountBatchQuery("public", tables)).toBe(
      pg.buildRowCountBatchQuery("public", tables),
    );
  });
});
