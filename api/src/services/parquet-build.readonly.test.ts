/**
 * Regression tests for read-only handling of BigQuery (and the schema-probe
 * path shared by every engine).
 *
 * PR #688 added an enforced read-only mode and, in doing so:
 *   1. gated schema introspection (`getStreamingQueryFields`) behind
 *      `!readOnly`, forcing every engine onto a `LIMIT 1` sample probe and, for
 *      BigQuery, throwing "BigQuery batch queries must use native page tokens";
 *   2. gated the BigQuery-native streaming path behind `!readOnly`, so
 *      streaming a BigQuery query read-only hit the same throw;
 *   3. made `executeQuery` fail closed for BigQuery under `readOnly`.
 *
 * The fix decouples schema introspection (inherently non-mutating — always
 * allowed) from read-only *execution* enforcement, and enforces read-only on
 * non-session engines (BigQuery) lexically via `checkPreviewQuerySafety` + the
 * native path instead of failing closed.
 *
 * These use a credential-less fake connection, so they never hit the network:
 * a validated read reaches the BigQuery client and fails on the missing
 * `project_id`, which is exactly the signal that the old page-token / refusal
 * short-circuits are gone.
 *
 * Run: tsx src/services/parquet-build.readonly.test.ts
 */
import assert from "node:assert/strict";
import { databaseConnectionService } from "./database-connection.service";
import { databaseRegistry } from "../databases/registry";
import { BigQueryDatabaseDriver } from "../databases/drivers/bigquery/driver";

// The real API process registers drivers in `index.ts`; register the BigQuery
// driver here so `getStreamingQueryFields` can reach its native dry-run schema.
databaseRegistry.register(new BigQueryDatabaseDriver());

const PAGE_TOKEN_ERROR = /native page tokens/i;

function fakeConnection(type: string): any {
  return {
    _id: "6577f0f0f0f0f0f0f0f0f0f0",
    type,
    name: `${type}-conn`,
    connection: {},
  };
}

async function main() {
  const bq = fakeConnection("bigquery");

  // 1. Schema introspection is no longer gated on `readOnly`: a read-only
  //    BigQuery probe uses the native dry-run (which fails cleanly on the
  //    missing credential) instead of throwing the misleading page-token error.
  const schema = await databaseConnectionService.getStreamingQueryFields(
    bq,
    "SELECT 1 AS a",
    { readOnly: true },
  );
  assert.equal(schema.success, false);
  assert.doesNotMatch(
    schema.error ?? "",
    PAGE_TOKEN_ERROR,
    "read-only BigQuery schema probe must not hit the offset-batch path",
  );
  assert.match(
    schema.error ?? "",
    /project_id/i,
    "read-only BigQuery schema probe should reach the native dry-run",
  );

  // 2. BigQuery streaming enforces read-only lexically: a write is rejected by
  //    the safety analyzer before any execution.
  const write = await databaseConnectionService.executeStreamingQuery(
    bq,
    "DELETE FROM t",
    { readOnly: true, batchSize: 1, onBatch: async () => {} },
  );
  assert.equal(write.success, false);
  assert.match(
    write.error ?? "",
    /read-only|forbidden|SELECT or WITH/i,
    "read-only BigQuery streaming must reject a write query",
  );
  assert.doesNotMatch(write.error ?? "", PAGE_TOKEN_ERROR);

  // 3. A validated read streams via the native BigQuery path under `readOnly`
  //    (fails on the missing credential, not the page-token throw).
  const read = await databaseConnectionService.executeStreamingQuery(
    bq,
    "SELECT 1 AS a",
    { readOnly: true, batchSize: 1, onBatch: async () => {} },
  );
  assert.equal(read.success, false);
  assert.doesNotMatch(
    read.error ?? "",
    PAGE_TOKEN_ERROR,
    "read-only BigQuery streaming must use the native page-token path",
  );
  assert.match(read.error ?? "", /project_id/i);

  // 4. executeQuery no longer fails closed for BigQuery under `readOnly`; it
  //    validates lexically then executes (reaching the credential error). Writes
  //    are still rejected, and non-SQL engines still fail closed.
  const bqRead = await databaseConnectionService.executeQuery(
    bq,
    "SELECT 1 AS a",
    { readOnly: true },
  );
  assert.equal(bqRead.success, false);
  assert.doesNotMatch(
    bqRead.error ?? "",
    /Read-only execution is not supported/i,
    "read-only BigQuery execution must no longer be refused outright",
  );

  const bqWrite = await databaseConnectionService.executeQuery(
    bq,
    "UPDATE t SET x = 1",
    { readOnly: true },
  );
  assert.equal(bqWrite.success, false);
  assert.match(bqWrite.error ?? "", /read-only|forbidden|SELECT or WITH/i);

  const mongo = await databaseConnectionService.executeQuery(
    fakeConnection("mongodb"),
    "SELECT 1",
    { readOnly: true },
  );
  assert.equal(mongo.success, false);
  assert.match(
    mongo.error ?? "",
    /not supported/i,
    "non-SQL engines must still fail closed under read-only",
  );

  // 5. Regression for MongoDB materialization (broken by PR #688): because
  //    MongoDB fails closed under `readOnly` (test 4 above), the materialization
  //    core must NOT force read-only for Mongo — the binding's JS-shell code
  //    (e.g. `db.client.db('x').collection('y').aggregate([...])`) can never
  //    pass the SQL read-only analyzer. Without read-only, the streaming path
  //    reaches the Mongo driver (and fails on the credential-less connection),
  //    rather than being rejected by the SELECT/WITH gate.
  const mongoStream = await databaseConnectionService.executeStreamingQuery(
    fakeConnection("mongodb"),
    "db.client.db('production').collection('users').aggregate([]).toArray()",
    { readOnly: false, batchSize: 1, onBatch: async () => {} },
  );
  assert.equal(mongoStream.success, false);
  assert.doesNotMatch(
    mongoStream.error ?? "",
    /SELECT or WITH|read-only|not supported/i,
    "Mongo materialization streaming must reach the driver, not the SQL read-only gate",
  );

  // eslint-disable-next-line no-console
  console.log("parquet-build/read-only regression tests passed");
}

main()
  .then(() => {
    // database-connection.service starts background timers at import, which
    // keep the event loop alive; exit explicitly so this CLI-style test (run
    // via `tsx` in the api `test` script) doesn't hang CI.
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
