/**
 * Bridges local-agent connections into the shared Mako driver layer.
 *
 * The agent reuses the exact same drivers and connection service as the cloud
 * API (api/src/databases + api/src/services/database-connection.service) so
 * query execution and schema browsing behave identically. Local connections
 * are plain objects shaped like IDatabaseConnection documents; the service
 * only relies on `_id.toString()`, `type` and `connection`.
 */
import { IDatabaseConnection } from "../../../api/src/database/workspace-schema";
import { databaseRegistry } from "../../../api/src/databases/registry";
import { BigQueryDatabaseDriver } from "../../../api/src/databases/drivers/bigquery/driver";
import { MongoDatabaseDriver } from "../../../api/src/databases/drivers/mongodb/driver";
import { PostgreSQLDatabaseDriver } from "../../../api/src/databases/drivers/postgresql/driver";
import { CloudSQLPostgresDatabaseDriver } from "../../../api/src/databases/drivers/cloudsql-postgres/driver";
import { CloudflareD1DatabaseDriver } from "../../../api/src/databases/drivers/cloudflare-d1/driver";
import { CloudflareKVDatabaseDriver } from "../../../api/src/databases/drivers/cloudflare-kv/driver";
import { ClickHouseDatabaseDriver } from "../../../api/src/databases/drivers/clickhouse/driver";
import { MySQLDatabaseDriver } from "../../../api/src/databases/drivers/mysql/driver";
import { RedshiftDatabaseDriver } from "../../../api/src/databases/drivers/redshift/driver";
import { LocalConnection } from "./connection-store";

let registered = false;

export function registerDrivers(): void {
  if (registered) return;
  databaseRegistry.register(new BigQueryDatabaseDriver());
  databaseRegistry.register(new MongoDatabaseDriver());
  databaseRegistry.register(new PostgreSQLDatabaseDriver());
  databaseRegistry.register(new MySQLDatabaseDriver());
  databaseRegistry.register(new CloudSQLPostgresDatabaseDriver());
  databaseRegistry.register(new CloudflareD1DatabaseDriver());
  databaseRegistry.register(new CloudflareKVDatabaseDriver());
  databaseRegistry.register(new ClickHouseDatabaseDriver());
  databaseRegistry.register(new RedshiftDatabaseDriver());
  registered = true;
}

/**
 * Shape a local connection like a DatabaseConnection mongoose document for
 * the shared driver layer. `_id` is the string id: the connection service
 * only ever calls `.toString()` on it (string is its own toString).
 */
export function toDatabaseConnection(
  local: LocalConnection,
): IDatabaseConnection {
  return {
    _id: local.id,
    workspaceId: "local",
    name: local.name,
    type: local.type,
    connection: local.connection,
    lastConnectedAt: local.lastConnectedAt
      ? new Date(local.lastConnectedAt)
      : undefined,
  } as unknown as IDatabaseConnection;
}
