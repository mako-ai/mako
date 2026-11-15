/**
 * Which engine runs a connection type.
 *
 * The engines that live in a driver folder are process-wide singletons
 * (`drivers/<engine>/engine.ts`): their pools and running-query maps exist
 * once whichever driver or caller reaches them. Cloud SQL, D1 and KV are
 * their own engines and live in the driver registry, resolved through
 * `getOrRegister` so this module and the API's startup registration share
 * one instance (one set of pools, one cancel map).
 *
 * MSSQL has an engine but no registered driver: the registry is the list of
 * database types the UI offers, and MSSQL is not one.
 */
import type { QueryEngine } from "./engine";
import { bigQueryEngine } from "./drivers/bigquery/engine";
import { clickHouseEngine } from "./drivers/clickhouse/engine";
import { CloudflareD1DatabaseDriver } from "./drivers/cloudflare-d1/driver";
import { CloudflareKVDatabaseDriver } from "./drivers/cloudflare-kv/driver";
import { CloudSQLPostgresDatabaseDriver } from "./drivers/cloudsql-postgres/driver";
import { mongoEngine } from "./drivers/mongodb/engine";
import { mssqlEngine } from "./drivers/mssql/engine";
import { mysqlEngine } from "./drivers/mysql/engine";
import { postgresEngine } from "./drivers/postgresql/engine";
import { databaseRegistry } from "./registry";

export function cloudSqlDriver(): CloudSQLPostgresDatabaseDriver {
  return databaseRegistry.getOrRegister(
    "cloudsql-postgres",
    () => new CloudSQLPostgresDatabaseDriver(),
  );
}

export function d1Driver(): CloudflareD1DatabaseDriver {
  return databaseRegistry.getOrRegister(
    "cloudflare-d1",
    () => new CloudflareD1DatabaseDriver(),
  );
}

export function kvDriver(): CloudflareKVDatabaseDriver {
  return databaseRegistry.getOrRegister(
    "cloudflare-kv",
    () => new CloudflareKVDatabaseDriver(),
  );
}

const ENGINES: Record<string, () => QueryEngine> = {
  bigquery: () => bigQueryEngine,
  postgresql: () => postgresEngine,
  redshift: () => postgresEngine,
  mongodb: () => mongoEngine,
  clickhouse: () => clickHouseEngine,
  mssql: () => mssqlEngine,
  mysql: () => mysqlEngine,
  "cloudsql-postgres": cloudSqlDriver,
  "cloudflare-d1": d1Driver,
  "cloudflare-kv": kvDriver,
};

/** The engine for a connection type; undefined for an unknown one. */
export function engineFor(type: string): QueryEngine | undefined {
  return ENGINES[type]?.();
}

/**
 * Every engine, once each, in the order a cancel looks for an executionId.
 * Resolving the registry-held ones registers them if they are not yet.
 */
export function allEngines(): QueryEngine[] {
  return [...new Set(Object.values(ENGINES).map(resolve => resolve()))];
}
