/**
 * list_connections discovery coverage.
 *
 * The connection-type filter used to be a hand-rolled copy that drifted from
 * the SQL tool surface: MySQL (and ClickHouse/MSSQL/SQLite) connections were
 * queryable via sql_* tools but invisible to list_connections — the tool the
 * MCP server instructions tell external agents to call first. The filter now
 * derives from the shared dialect registry; these tests pin that contract.
 *
 * Run: tsx src/agent-lib/tools/universal-tools.test.ts
 */
import assert from "node:assert/strict";
import { Types } from "mongoose";

import { summarizeConnectionForListing } from "./universal-tools";
import { ALL_SQL_TYPES, ALL_SUPPORTED_TYPES } from "./shared/sql-dialects";

function docFor(type: string, connection: Record<string, unknown>) {
  return {
    _id: new Types.ObjectId(),
    name: `${type}-conn`,
    type,
    connection,
  };
}

// Every SQL type the sql_* tools can query must be discoverable, plus mongodb.
for (const type of ALL_SQL_TYPES) {
  assert.ok(
    ALL_SUPPORTED_TYPES.has(type),
    `list_connections filter must include SQL type: ${type}`,
  );
}
assert.ok(ALL_SUPPORTED_TYPES.has("mysql"), "mysql must be discoverable");
assert.ok(ALL_SUPPORTED_TYPES.has("mongodb"), "mongodb must be discoverable");

// MySQL: dialect + host/database display, same shape as PostgreSQL.
{
  const summary = summarizeConnectionForListing(
    docFor("mysql", { host: "db.example.com", database: "blog" }),
  );
  assert.equal(summary.type, "mysql");
  assert.equal(summary.sqlDialect, "mysql");
  assert.equal(summary.host, "db.example.com");
  assert.equal(summary.databaseName, "blog");
  assert.equal(summary.displayName, "mysql-conn (mysql: db.example.com/blog)");
}

// Existing types keep their exact display shape (regression guard).
{
  const pg = summarizeConnectionForListing(
    docFor("postgresql", { host: "pg.example.com", database: "app" }),
  );
  assert.equal(pg.sqlDialect, "postgresql");
  assert.equal(
    pg.displayName,
    "postgresql-conn (postgresql: pg.example.com/app)",
  );

  const redshift = summarizeConnectionForListing(
    docFor("redshift", { host: "rs.example.com", db: "warehouse" }),
  );
  assert.equal(redshift.sqlDialect, "postgresql");
  assert.equal(
    redshift.displayName,
    "redshift-conn (postgresql: rs.example.com/warehouse)",
  );

  const bq = summarizeConnectionForListing(
    docFor("bigquery", { project_id: "my-project" }),
  );
  assert.equal(bq.sqlDialect, "bigquery");
  assert.equal(bq.displayName, "bigquery-conn (bigquery: my-project)");

  const d1 = summarizeConnectionForListing(
    docFor("cloudflare-d1", { database_id: "abc-123" }),
  );
  assert.equal(d1.sqlDialect, "sqlite");
  assert.equal(d1.displayName, "cloudflare-d1-conn (sqlite: abc-123)");

  const mongo = summarizeConnectionForListing(
    docFor("mongodb", { database: "analytics" }),
  );
  assert.equal(mongo.sqlDialect, undefined);
  assert.equal(mongo.displayName, "mongodb-conn (mongodb: analytics)");
}

// ClickHouse / MSSQL fall through with their dialect attached.
{
  const ch = summarizeConnectionForListing(docFor("clickhouse", {}));
  assert.equal(ch.sqlDialect, "clickhouse");
  assert.equal(ch.displayName, "clickhouse-conn (clickhouse)");
}

// eslint-disable-next-line no-console
console.log("universal-tools tests passed");
// Imported tool modules hold live handles (driver pools/timers); an explicit
// exit keeps the tsx test chain moving.
// eslint-disable-next-line no-process-exit
process.exit(0);
