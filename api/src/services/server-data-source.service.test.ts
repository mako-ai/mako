/* eslint-disable no-console */
/**
 * Tests for the server-side data-source tools.
 *
 * - `checkServerDuckDbSql` gate: pure, always runs.
 * - End-to-end query/inspect/list: builds a real Parquet artifact, stores it,
 *   attaches it to a MakoApp binding, and runs the server tools against node
 *   DuckDB. Self-skips when MongoDB is unreachable (so it is safe in CI without
 *   a database), mirroring seed-dev-admin's soft-fail.
 */
import assert from "node:assert/strict";
import { Types } from "mongoose";
import mongoose from "mongoose";
import { buildParquetFromBatches } from "../utils/streaming-parquet-builder";
import {
  storeArtifact,
  deleteArtifact,
  getArtifactPrefix,
} from "./dashboard-cache.service";
import {
  checkServerDuckDbSql,
  querySurfaceDuckDB,
  listSurfaceDataSources,
  inspectSurfaceDataSource,
} from "./server-data-source.service";

function testSqlGate() {
  console.log("  checkServerDuckDbSql: read-only single-statement gate");

  // Accepts read-only SELECT / WITH.
  assert.equal(checkServerDuckDbSql("SELECT 1").ok, true);
  assert.equal(
    checkServerDuckDbSql("  -- comment\n SELECT * FROM foo").ok,
    true,
  );
  assert.equal(
    checkServerDuckDbSql("WITH x AS (SELECT 1 AS a) SELECT * FROM x").ok,
    true,
  );
  const trailing = checkServerDuckDbSql("SELECT 1;");
  assert.equal(trailing.ok, true);
  assert.equal(trailing.ok && trailing.statement, "SELECT 1");

  // Rejects non-read-only.
  assert.equal(checkServerDuckDbSql("DELETE FROM foo").ok, false);
  assert.equal(checkServerDuckDbSql("INSERT INTO foo VALUES (1)").ok, false);
  assert.equal(checkServerDuckDbSql("CREATE TABLE x (a INT)").ok, false);
  assert.equal(checkServerDuckDbSql("PRAGMA database_list").ok, false);
  assert.equal(checkServerDuckDbSql("").ok, false);

  // Rejects file / extension / network access.
  assert.equal(
    checkServerDuckDbSql("SELECT * FROM read_parquet('/etc/passwd')").ok,
    false,
  );
  assert.equal(
    checkServerDuckDbSql("SELECT * FROM read_csv_auto('/etc/passwd')").ok,
    false,
  );
  assert.equal(checkServerDuckDbSql("ATTACH 'x.db' AS y").ok, false);
  assert.equal(
    checkServerDuckDbSql("COPY (SELECT 1) TO '/tmp/x.csv'").ok,
    false,
  );
  assert.equal(checkServerDuckDbSql("INSTALL httpfs").ok, false);

  // Rejects multi-statement.
  assert.equal(checkServerDuckDbSql("SELECT 1; DROP TABLE foo").ok, false);
  // Semicolon inside a string literal is fine.
  assert.equal(checkServerDuckDbSql("SELECT ';' AS s").ok, true);

  console.log("    ✓ gate accepts/rejects as expected");
}

async function buildArtifact(
  key: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const built = await buildParquetFromBatches({
    filenameBase: "test-server-ds",
    fields: [
      { name: "genre", type: "VARCHAR" },
      { name: "amount", type: "DOUBLE" },
    ],
    streamBatches: async insert => {
      await insert(rows);
    },
  });
  await storeArtifact(built.filePath, key);
}

async function testEndToEnd() {
  console.log("  end-to-end: materialized binding -> node DuckDB query");

  const workspaceId = new Types.ObjectId();
  const appId = new Types.ObjectId();
  const bindingId = "bind_test";
  const artifactKey = `${getArtifactPrefix()}/test/${appId.toString()}/${bindingId}.parquet`;

  await buildArtifact(artifactKey, [
    { genre: "Rock", amount: 10 },
    { genre: "Rock", amount: 5 },
    { genre: "Jazz", amount: 7 },
  ]);

  const MakoApp = mongoose.model("MakoApp");
  await MakoApp.create({
    _id: appId,
    workspaceId,
    title: "Test App",
    template: "blank",
    runtime: "cdn",
    entrypoint: "App.tsx",
    files: [{ path: "App.tsx", contents: "" }],
    dependencies: {},
    dataBindings: [
      {
        id: bindingId,
        name: "sales",
        connectionId: new Types.ObjectId().toString(),
        language: "sql",
        code: "SELECT genre, amount FROM sales",
        materialization: "parquet",
        cache: {
          parquetArtifactKey: artifactKey,
          parquetBuildStatus: "ready",
          rowCount: 3,
          artifactRevision: "1",
        },
      },
    ],
    version: 1,
    access: "private",
    createdBy: "test",
  });

  const surface = { kind: "app" as const, id: appId.toString() };
  const wsId = workspaceId.toString();

  try {
    // list_data_sources
    const list = await listSurfaceDataSources(wsId, surface);
    assert.equal(list.success, true);
    assert.equal((list.dataSources as unknown[]).length, 1);
    assert.equal((list.dataSources as { name: string }[])[0].name, "sales");
    console.log("    ✓ list_data_sources returns the binding");

    // query_duckdb — aggregation against the materialized table.
    const q = await querySurfaceDuckDB(
      wsId,
      surface,
      'SELECT genre, SUM(amount) AS total FROM "sales" GROUP BY genre ORDER BY genre',
    );
    assert.equal(q.success, true, `query failed: ${q.error}`);
    const rows = q.rows as { genre: string; total: number }[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].genre, "Jazz");
    assert.equal(Number(rows[0].total), 7);
    assert.equal(rows[1].genre, "Rock");
    assert.equal(Number(rows[1].total), 15);
    assert.deepEqual(q.tables, ["sales"]);
    console.log("    ✓ query_duckdb returns correct aggregation");

    // query_duckdb — file access is blocked even though we loaded a parquet.
    const blocked = await querySurfaceDuckDB(
      wsId,
      surface,
      "SELECT * FROM read_parquet('/etc/hostname')",
    );
    assert.equal(blocked.success, false);
    console.log("    ✓ query_duckdb blocks file access");

    // inspect_data_source — samples rows from the materialized table.
    const inspect = await inspectSurfaceDataSource(wsId, surface, "sales");
    assert.equal(inspect.success, true);
    const ds = inspect.dataSource as {
      columns: string[];
      sampleRows: unknown[];
    };
    assert.ok(ds.columns.includes("genre"));
    assert.ok(ds.columns.includes("amount"));
    assert.equal(ds.sampleRows.length, 3);
    console.log("    ✓ inspect_data_source samples the materialized table");
  } finally {
    await MakoApp.deleteOne({ _id: appId }).catch(() => undefined);
    await deleteArtifact(artifactKey).catch(() => undefined);
  }
}

async function main() {
  console.log("server-data-source.service tests");
  testSqlGate();

  const uri = process.env.DATABASE_URL || "mongodb://127.0.0.1:27017/mako";
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 2500 });
  } catch {
    console.log("  end-to-end: SKIPPED (MongoDB unreachable)");
    console.log("✓ server-data-source.service tests passed (gate only)");
    return;
  }

  try {
    await testEndToEnd();
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }

  console.log("✓ server-data-source.service tests passed");
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
