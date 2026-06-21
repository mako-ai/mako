/* eslint-disable no-console, no-process-exit */
import assert from "node:assert/strict";
import { BigQueryDatabaseDriver } from "./bigquery/driver";
import { PostgreSQLDatabaseDriver } from "./postgresql/driver";
import { CloudSQLPostgresDatabaseDriver } from "./cloudsql-postgres/driver";
import { RedshiftDatabaseDriver } from "./redshift/driver";
import { BIGQUERY_WORKING_DATASET } from "../../utils/bigquery-working-dataset";

/**
 * Contract tests for the destination-dialect capability methods on
 * DatabaseDriver. Generic sync/route code (destination-writer, backfill,
 * flows) relies on these to stay engine-agnostic, so the exact outputs here
 * are load-bearing — they reproduce the behavior that used to be inline
 * `type === "bigquery"` branches.
 */

const bq = new BigQueryDatabaseDriver();
const pg = new PostgreSQLDatabaseDriver();
const cloudsql = new CloudSQLPostgresDatabaseDriver();
const redshift = new RedshiftDatabaseDriver();

function testStagingSchema() {
  // BigQuery isolates staging in its working dataset, ignoring the live schema.
  assert.equal(bq.getStagingSchema("user_ds"), BIGQUERY_WORKING_DATASET);
  assert.equal(bq.getStagingSchema(undefined), BIGQUERY_WORKING_DATASET);
  // Other engines don't override → callers fall back to the primary schema.
  assert.equal(pg.getStagingSchema, undefined);
  assert.equal(cloudsql.getStagingSchema, undefined);
  assert.equal(redshift.getStagingSchema, undefined);
}

function testSoftDeleteForCdc() {
  assert.equal(bq.requiresSoftDeleteForCdc(), true);
  assert.equal(pg.requiresSoftDeleteForCdc, undefined);
  assert.equal(redshift.requiresSoftDeleteForCdc, undefined);
}

function testTypedColumns() {
  assert.equal(bq.requiresTypedColumns(), true);
  assert.equal(pg.requiresTypedColumns, undefined);
}

function testMapColumnType() {
  const cases: Array<[string, string]> = [
    ["text", "STRING"],
    ["VARCHAR(255)", "STRING"],
    ["clob", "STRING"],
    ["integer", "INT64"],
    ["int8", "INT64"],
    ["bigint", "INT64"],
    ["real", "FLOAT64"],
    // NOTE: the float check uses exact `=== "DOUBLE"`, so "double precision"
    // falls through to the STRING default. Pre-existing behavior — preserved
    // verbatim by the refactor, asserted here to lock it in.
    ["double precision", "STRING"],
    ["numeric", "FLOAT64"],
    ["blob", "BYTES"],
    ["boolean", "BOOL"],
    ["timestamp", "TIMESTAMP"],
    ["date", "TIMESTAMP"],
    ["jsonb", "STRING"],
    ["uuid", "STRING"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(bq.mapColumnType(input), expected, `bq.mapColumnType(${input})`);
  }
  // Other engines don't remap.
  assert.equal(pg.mapColumnType, undefined);
}

function testFormatTableRef() {
  assert.equal(bq.formatTableRef("ds", "tbl"), "`ds`.tbl");
  assert.equal(
    bq.formatTableRef("ds", "tbl", { projectId: "proj" }),
    "`proj`.`ds`.tbl",
  );
  // Postgres-family uses the conventional default (callers handle undefined).
  assert.equal(pg.formatTableRef, undefined);
}

function testRowCountBatchQuery() {
  const tables = ["a'b", "c"];

  assert.equal(
    bq.buildRowCountBatchQuery("ds", tables, { projectId: "proj" }),
    "SELECT table_id, row_count FROM `proj`.`ds`.__TABLES__ WHERE table_id IN ('a''b','c')",
  );
  assert.equal(
    bq.buildRowCountBatchQuery("ds", tables),
    "SELECT table_id, row_count FROM `ds`.__TABLES__ WHERE table_id IN ('a''b','c')",
  );
  assert.equal(bq.buildRowCountBatchQuery("ds", []), null);

  const pgExpected =
    "SELECT c.relname AS table_id, c.reltuples::bigint AS row_count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('a''b','c')";
  assert.equal(pg.buildRowCountBatchQuery("public", tables), pgExpected);
  assert.equal(cloudsql.buildRowCountBatchQuery("public", tables), pgExpected);
  assert.equal(pg.buildRowCountBatchQuery("public", []), null);

  // Redshift has no cheap metadata row-count path → no implementation, so
  // callers skip counting (preserves prior null behavior).
  assert.equal(redshift.buildRowCountBatchQuery, undefined);
}

function main() {
  testStagingSchema();
  testSoftDeleteForCdc();
  testTypedColumns();
  testMapColumnType();
  testFormatTableRef();
  testRowCountBatchQuery();
  console.log("destination-capabilities: all assertions passed");
}

main();

// Importing the real drivers pulls in databaseConnectionService, which keeps
// the event loop alive (token caches, pools). Exit explicitly so the suite —
// run sequentially via the `test` script — doesn't hang in CI.
process.exit(0);
