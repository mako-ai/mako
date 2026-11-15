import type { IDatabaseConnection } from "../../../database/workspace-schema";

/** The connection's own string, or one built from its fields. */
export function buildMongoDBConnectionString(
  database: IDatabaseConnection,
): string {
  const conn = database.connection;

  // If connection string is provided, use it directly
  if (conn.connectionString) {
    return conn.connectionString;
  }

  // Build connection string from individual parameters
  let connectionString = "mongodb://";

  if (conn.username && conn.password) {
    connectionString += `${encodeURIComponent(conn.username)}:${encodeURIComponent(conn.password)}@`;
  }

  connectionString += `${conn.host || "localhost"}:${conn.port || 27017}`;

  if (conn.database) {
    connectionString += `/${conn.database}`;
  }

  const params: string[] = [];

  if (conn.authSource) {
    params.push(`authSource=${conn.authSource}`);
  }

  if (conn.replicaSet) {
    params.push(`replicaSet=${conn.replicaSet}`);
  }

  if (conn.ssl) {
    params.push("ssl=true");
  }

  if (params.length > 0) {
    connectionString += `?${params.join("&")}`;
  }

  return connectionString;
}

/** The database named in a connection string's path, if any. */
export function extractDatabaseName(connectionString: string): string | null {
  try {
    const url = new URL(connectionString);
    const pathname = url.pathname;
    if (pathname && pathname.length > 1) {
      return pathname.substring(1).split("?")[0];
    }
  } catch {
    // Invalid URL
  }
  return null;
}
