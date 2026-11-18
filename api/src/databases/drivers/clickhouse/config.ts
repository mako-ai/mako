import type { IDatabaseConnection } from "../../../database/workspace-schema";

export const CLICKHOUSE_REQUEST_TIMEOUT_MS = 120_000; // cold starts
export const CLICKHOUSE_MAX_RETRIES = 3;
export const CLICKHOUSE_RETRY_BASE_DELAY_MS = 1000;

/**
 * Serverless ClickHouse (ClickHouse Cloud) idles after a few minutes and wakes
 * on the next request, which takes 2 to 9 minutes (measured on 2026-11-18).
 * A query sent while it wakes used to hit the 120 s request timeout and fail
 * ("Timeout error."), so a scheduled binding build failed on most wakes.
 *
 * Before a query, Mako now sends `SELECT 1` until the server answers, for up
 * to the connection's wake timeout: `wake_timeout_ms` on the connection, else
 * 10 minutes for a `*.clickhouse.cloud` host, else 0 (the old 3 quick
 * retries). Each attempt waits at most 30 s and the pause between attempts
 * grows from 2 s to 30 s.
 */
export const CLICKHOUSE_WAKE_TIMEOUT_SETTING = "wake_timeout_ms";
export const CLICKHOUSE_SERVERLESS_WAKE_TIMEOUT_MS = 10 * 60_000;
export const CLICKHOUSE_WAKE_ATTEMPT_TIMEOUT_MS = 30_000;
export const CLICKHOUSE_WAKE_BASE_DELAY_MS = 2_000;
export const CLICKHOUSE_WAKE_MAX_DELAY_MS = 30_000;
/**
 * "Test connection" (and the verify-before-save on create and update) holds an
 * HTTP request open while it waits, so it gets a short budget: a sleeping
 * service usually answers within it, and a wrong host or a blocked IP fails in
 * about a minute instead of hanging behind the proxy's own timeout.
 */
export const CLICKHOUSE_INTERACTIVE_WAKE_TIMEOUT_MS = 60_000;

/**
 * Errors a sleeping ClickHouse Cloud service never produces: the hostname does
 * not resolve. Waking cannot fix them, so the wake loop fails at once.
 */
export function isDnsLookupError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
  return /\b(ENOTFOUND|EAI_AGAIN)\b/.test(error.message);
}

/** Whether a ClickHouse URL points at a serverless service that idles. */
export function isServerlessClickHouseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "clickhouse.cloud" || host.endsWith(".clickhouse.cloud");
  } catch {
    return false;
  }
}

/**
 * How long to keep waking the server before failing (0: do not wait).
 * `wake_timeout_ms` on the connection wins; forms may store it as a string.
 */
export function resolveClickHouseWakeTimeoutMs(
  database: IDatabaseConnection,
  url: string,
): number {
  const raw = (database.connection as Record<string, unknown> | undefined)?.[
    CLICKHOUSE_WAKE_TIMEOUT_SETTING
  ];
  if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return isServerlessClickHouseUrl(url)
    ? CLICKHOUSE_SERVERLESS_WAKE_TIMEOUT_MS
    : 0;
}

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
