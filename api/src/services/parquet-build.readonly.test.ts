/**
 * Regression test for BigQuery app-binding materialization.
 *
 * PR #688 added session-level read-only enforcement (`readOnly: true`) to the
 * parquet materialization pipeline. BigQuery cannot honor session read-only, so
 * `getStreamingQueryFields` / `executeStreamingQuery` skip their BigQuery-native
 * paths under `readOnly` and fall into `prepareSqlBatchQuery`, which throws
 * "BigQuery batch queries must use native page tokens" — aborting every
 * BigQuery materialization build (~10ms, before any query runs).
 *
 * The fix: materialization already validates the query read-only up front via
 * `assertReadOnlyMaterializationQuery`, so it only requests session read-only
 * for engines that actually support it (`supportsReadOnlySessionEnforcement`).
 *
 * Run: tsx src/services/parquet-build.readonly.test.ts
 */
import assert from "node:assert/strict";
import { promises as fsPromises } from "fs";
import { databaseConnectionService } from "./database-connection.service";
import { buildQueryParquetFile } from "./parquet-build.service";

function fakeConnection(type: string): any {
  return {
    _id: "6577f0f0f0f0f0f0f0f0f0f0",
    type,
    name: `${type}-conn`,
    connection: {},
  };
}

async function main() {
  // 1. Engine classification. Engines that cannot enforce read-only at the
  //    session/transaction layer must report `false`; SQL engines that can
  //    (READ ONLY transaction / read-only pragma) must report `true`.
  for (const t of [
    "bigquery",
    "mongodb",
    "mssql",
    "cloudflare-d1",
    "cloudflare-kv",
  ]) {
    assert.equal(
      databaseConnectionService.supportsReadOnlySessionEnforcement(t),
      false,
      `${t} must not report session read-only support`,
    );
  }
  for (const t of [
    "postgresql",
    "redshift",
    "cloudsql-postgres",
    "mysql",
    "clickhouse",
  ]) {
    assert.equal(
      databaseConnectionService.supportsReadOnlySessionEnforcement(t),
      true,
      `${t} must report session read-only support`,
    );
  }

  // 2. Reproduce the outage at the DB-service layer: probing a BigQuery query
  //    with `readOnly: true` bypasses the native dry-run and throws the
  //    misleading pagination error. This is exactly why materialization must
  //    not force read-only for BigQuery.
  await assert.rejects(
    () =>
      databaseConnectionService.getStreamingQueryFields(
        fakeConnection("bigquery"),
        "SELECT 1 AS a",
        { readOnly: true },
      ),
    /native page tokens/,
    "readOnly probe on BigQuery should hit the unsupported batch path",
  );

  // 3. The fix: buildQueryParquetFile requests session read-only only for
  //    engines that support it. Capture the flag the streaming APIs receive.
  const origFields = databaseConnectionService.getStreamingQueryFields.bind(
    databaseConnectionService,
  );
  const origStream = databaseConnectionService.executeStreamingQuery.bind(
    databaseConnectionService,
  );

  const captured: Record<string, { probe?: boolean; stream?: boolean }> = {};
  try {
    for (const type of ["bigquery", "postgresql"]) {
      captured[type] = {};
      (databaseConnectionService as any).getStreamingQueryFields = async (
        _c: any,
        _q: any,
        opts: any,
      ) => {
        captured[type].probe = opts?.readOnly;
        return { success: true, fields: [] };
      };
      (databaseConnectionService as any).executeStreamingQuery = async (
        _c: any,
        _q: any,
        opts: any,
      ) => {
        captured[type].stream = opts?.readOnly;
        await opts.onBatch([{ a: 1 }]);
        return { success: true, totalRows: 1 };
      };

      const built = await buildQueryParquetFile({
        connection: fakeConnection(type),
        executableQuery: "SELECT 1 AS a",
        filenameBase: `test-readonly-${type}`,
        schemaProbe: "strict",
      });
      await fsPromises.rm(built.filePath, { force: true });
    }
  } finally {
    (databaseConnectionService as any).getStreamingQueryFields = origFields;
    (databaseConnectionService as any).executeStreamingQuery = origStream;
  }

  assert.equal(
    captured.bigquery.probe,
    false,
    "BigQuery schema probe must NOT force session read-only",
  );
  assert.equal(
    captured.bigquery.stream,
    false,
    "BigQuery streaming must NOT force session read-only",
  );
  assert.equal(
    captured.postgresql.probe,
    true,
    "Postgres schema probe should keep read-only enforcement",
  );
  assert.equal(
    captured.postgresql.stream,
    true,
    "Postgres streaming should keep read-only enforcement",
  );

  // eslint-disable-next-line no-console
  console.log("parquet-build readOnly regression tests passed");
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
