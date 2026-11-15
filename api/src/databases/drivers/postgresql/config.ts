import type { IDatabaseConnection } from "../../../database/workspace-schema";

export const POSTGRES_CONNECTION_TIMEOUT_MS = 30_000;
export const POSTGRES_QUERY_TIMEOUT_MS = 120_000;
export const POSTGRES_MAX_RETRIES = 3;
export const POSTGRES_RETRY_BASE_DELAY_MS = 1000;

/**
 * Build PostgreSQL pool/client configuration with timeout settings
 * Supports both connection string and individual fields
 */
export function buildPostgreSQLConfig(
  database: IDatabaseConnection,
  targetDatabase?: string,
) {
  const conn = database.connection;
  const baseConfig = {
    connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
    query_timeout: POSTGRES_QUERY_TIMEOUT_MS,
    statement_timeout: POSTGRES_QUERY_TIMEOUT_MS,
  };

  // If connection string is provided, use it directly
  if (conn.connectionString) {
    let connectionString = conn.connectionString;

    // If a target database is specified, we need to modify the connection string
    if (targetDatabase) {
      try {
        const url = new URL(connectionString);
        url.pathname = `/${targetDatabase}`;
        connectionString = url.toString();
      } catch {
        // If URL parsing fails, just use the original connection string
      }
    }

    return {
      connectionString,
      ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
      ...baseConfig,
    };
  }

  // Build from individual fields (Redshift default port 5439)
  const defaultPort = database.type === "redshift" ? 5439 : 5432;
  return {
    host: conn.host,
    port: conn.port ?? defaultPort,
    database: targetDatabase || conn.database,
    user: conn.username,
    password: conn.password,
    ssl: conn.ssl ? { rejectUnauthorized: false } : false,
    ...baseConfig,
  };
}
