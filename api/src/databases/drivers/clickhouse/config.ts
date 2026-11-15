import type { IDatabaseConnection } from "../../../database/workspace-schema";

export const CLICKHOUSE_REQUEST_TIMEOUT_MS = 120_000; // cold starts
export const CLICKHOUSE_MAX_RETRIES = 3;
export const CLICKHOUSE_RETRY_BASE_DELAY_MS = 1000;

/**
 * Parse a JDBC-style ClickHouse URL and return connection config
 * Supports formats:
 * - jdbc:clickhouse://host:port?user=default&password=xxx&ssl=true
 * - clickhouse://host:port?user=default&password=xxx
 * - https://host:port (ClickHouse Cloud style)
 */
export function parseClickHouseConnectionString(connectionString: string): {
  url: string;
  username: string;
  password: string;
  database: string;
} {
  let urlToParse = connectionString.trim();

  // Remove jdbc: prefix if present
  if (urlToParse.startsWith("jdbc:")) {
    urlToParse = urlToParse.slice(5);
  }

  // Replace clickhouse:// with https:// for URL parsing
  if (urlToParse.startsWith("clickhouse://")) {
    urlToParse = "https://" + urlToParse.slice("clickhouse://".length);
  }

  // Parse the URL
  const parsedUrl = new URL(urlToParse);

  // Extract query parameters
  const user =
    parsedUrl.searchParams.get("user") ||
    parsedUrl.searchParams.get("username") ||
    parsedUrl.username ||
    "default";
  const password =
    parsedUrl.searchParams.get("password") || parsedUrl.password || "";
  const database =
    parsedUrl.searchParams.get("database") ||
    parsedUrl.pathname.slice(1) ||
    "default";
  const ssl =
    parsedUrl.searchParams.get("ssl") === "true" ||
    parsedUrl.searchParams.get("secure") === "true" ||
    parsedUrl.protocol === "https:";

  // Build the base URL with protocol
  const protocol = ssl ? "https" : "http";
  const host = parsedUrl.hostname;
  const port = parsedUrl.port || (ssl ? "8443" : "8123");

  return {
    url: `${protocol}://${host}:${port}`,
    username: user,
    password: password,
    database: database,
  };
}

/**
 * Build ClickHouse client config from database connection
 * Supports both connection string and individual fields
 * Includes timeout and keep_alive settings for resilience
 */
export function buildClickHouseClientConfig(
  database: IDatabaseConnection,
  databaseNameOverride?: string,
): {
  url: string;
  username: string;
  password: string;
  database: string;
  request_timeout: number;
  keep_alive: { enabled: boolean; idle_socket_ttl: number };
} {
  const conn = database.connection;

  // Base config with timeout and keep_alive settings
  const baseConfig = {
    request_timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS,
    keep_alive: {
      enabled: true,
      idle_socket_ttl: 2500, // Default: 2.5 seconds
    },
  };

  // If connection string is provided, parse it
  if (conn.connectionString) {
    const parsed = parseClickHouseConnectionString(conn.connectionString);
    // In cluster mode the active database is chosen per-query (e.g. from the
    // console picker), so it must take precedence over the connection string.
    if (databaseNameOverride) {
      parsed.database = databaseNameOverride;
    }
    return { ...parsed, ...baseConfig };
  }

  // Build from individual fields
  let host = conn.host || "http://localhost";
  if (!host.startsWith("http://") && !host.startsWith("https://")) {
    host = (conn.ssl ? "https://" : "http://") + host;
  }

  return {
    url: `${host}:${conn.port || 8123}`,
    username: conn.username || "default",
    password: conn.password || "",
    database: databaseNameOverride || conn.database || "default",
    ...baseConfig,
  };
}
