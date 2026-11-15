import assert from "node:assert/strict";
import {
  buildColumnResetQuery,
  escapeBigQueryPath,
  escapePostgresIdentifier,
  isSafeSqlIdentifier,
} from "./flow-column-reset-sql";

assert.equal(escapePostgresIdentifier('we"ird'), '"we""ird"');
assert.equal(escapeBigQueryPath("a`b"), "`a\\`b`");

assert.ok(isSafeSqlIdentifier("amount_cents"));
assert.ok(isSafeSqlIdentifier("_mako_x1"));
assert.ok(!isSafeSqlIdentifier("1st"));
assert.ok(!isSafeSqlIdentifier("a; DROP TABLE t"));
assert.ok(!isSafeSqlIdentifier(""));

const base = { schema: "raw", tableName: "stripe_charges", column: "amount" };

assert.equal(
  buildColumnResetQuery({
    ...base,
    destinationType: "bigquery",
    projectId: "proj",
    forceReplay: false,
  }),
  "UPDATE `proj.raw.stripe_charges` SET `amount` = NULL WHERE TRUE",
);
// No project: dataset-qualified only.
assert.equal(
  buildColumnResetQuery({
    ...base,
    destinationType: "bigquery",
    forceReplay: false,
  }),
  "UPDATE `raw.stripe_charges` SET `amount` = NULL WHERE TRUE",
);
// A forced replay rewinds both LWW guards so the backfill rewrites every row.
assert.equal(
  buildColumnResetQuery({
    ...base,
    destinationType: "bigquery",
    projectId: "proj",
    forceReplay: true,
  }),
  "UPDATE `proj.raw.stripe_charges` SET `amount` = NULL, `_mako_source_ts` = TIMESTAMP('1970-01-01 00:00:00 UTC'), `_mako_ingest_seq` = -1 WHERE TRUE",
);
assert.equal(
  buildColumnResetQuery({
    ...base,
    destinationType: "cloudsql-postgres",
    forceReplay: true,
  }),
  `UPDATE "raw"."stripe_charges" SET "amount" = NULL, "_mako_source_ts" = TIMESTAMP '1970-01-01 00:00:00+00', "_mako_ingest_seq" = -1`,
);
assert.equal(
  buildColumnResetQuery({
    ...base,
    destinationType: "clickhouse",
    forceReplay: true,
  }),
  null,
  "unsupported engines get no query (the route answers 400)",
);

console.log("flow column-reset SQL: all assertions passed");
