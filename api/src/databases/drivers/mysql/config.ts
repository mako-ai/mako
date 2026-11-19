import type { IDatabaseConnection } from "../../../database/workspace-schema";
import { loggers } from "../../../logging";
import type { SshTunnelConfig } from "../../../services/ssh-tunnel.service";

const logger = loggers.db("mysql");

export const MYSQL_CONNECTION_TIMEOUT_MS = 30_000;
export const MYSQL_MAX_RETRIES = 3;
export const MYSQL_RETRY_BASE_DELAY_MS = 1000;

/**
 * Pool settings. mysql2 reaps idle connections only when maxIdle is below
 * connectionLimit. With both at 2 the 10 s idleTimeout never ran, so a
 * connection idled until the server's wait_timeout closed it and the API
 * logged "Connection lost" (4 times in 3 hours, 30 s after binding builds).
 * maxIdle 1 turns the reaper on: an idle connection closes after 10 s, well
 * below any server wait_timeout.
 */
export const MYSQL_POOL_OPTIONS = {
  waitForConnections: true,
  connectionLimit: 2,
  maxIdle: 1,
  idleTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
} as const;

/** A connection the server or the network closed under us. */
export const MYSQL_LOST_CONNECTION_PATTERNS: RegExp[] = [
  /Connection lost/i, // PROTOCOL_CONNECTION_LOST
  /ECONNRESET/i,
  /closed state/i, // checked out after the server closed it
];

const LOST_CONNECTION_CODES = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNRESET",
]);

export function isLostConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && LOST_CONNECTION_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return MYSQL_LOST_CONNECTION_PATTERNS.some(p => p.test(message));
}

/**
 * Build an SshTunnelConfig from the saved connection, or null when SSH is disabled.
 * Throws on invalid/incomplete configuration so callers get a clear error.
 */
export function buildSshTunnelConfig(
  database: IDatabaseConnection,
  tunnelKey: string,
): SshTunnelConfig | null {
  const tunnel = database.connection.sshTunnel;
  if (!tunnel?.enabled) return null;

  if (!tunnel.host) {
    throw new Error("SSH tunnel host is required");
  }
  if (!tunnel.username) {
    throw new Error("SSH tunnel username is required");
  }
  const authMethod = tunnel.authMethod || "password";
  if (authMethod === "password" && !tunnel.password) {
    throw new Error("SSH tunnel password is required when using password auth");
  }
  if (authMethod === "privateKey" && !tunnel.privateKey) {
    throw new Error("SSH private key is required when using key auth");
  }

  // Strip port suffix from host fields if the user accidentally entered host:port
  const parseHost = (
    raw: string,
  ): { host: string; port: number | undefined } => {
    // Bracketed IPv6: [::1]:3306
    const bracketMatch = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketMatch) {
      return {
        host: bracketMatch[1],
        port: bracketMatch[2] ? Number(bracketMatch[2]) : undefined,
      };
    }
    // Non-bracketed host:port — use lastIndexOf so IPv4 like 127.0.0.1:22 works
    const lastColon = raw.lastIndexOf(":");
    if (lastColon > 0) {
      const maybePart = raw.slice(lastColon + 1);
      if (/^\d+$/.test(maybePart)) {
        return { host: raw.slice(0, lastColon), port: Number(maybePart) };
      }
    }
    return { host: raw, port: undefined };
  };

  const rawRemote = parseHost(database.connection.host || "127.0.0.1");
  const remoteHost = rawRemote.host;
  const remotePort = database.connection.port || rawRemote.port || 3306;

  const rawSsh = parseHost(tunnel.host);
  const sshHost = rawSsh.host;
  const sshPort = tunnel.port ?? rawSsh.port ?? 22;

  return {
    key: tunnelKey,
    sshHost,
    sshPort,
    sshUsername: tunnel.username,
    authMethod,
    sshPassword: tunnel.password,
    privateKey: tunnel.privateKey,
    passphrase: tunnel.passphrase,
    remoteHost,
    remotePort,
  };
}

export function buildMySQLConfig(
  database: IDatabaseConnection,
  targetDatabase?: string,
  tunnelEndpoint?: { host: string; port: number },
) {
  const conn = database.connection;
  const baseConfig = {
    connectTimeout: MYSQL_CONNECTION_TIMEOUT_MS,
  };

  if (conn.connectionString) {
    try {
      let urlString = conn.connectionString;
      if (!urlString.startsWith("mysql://")) {
        urlString = `mysql://${urlString}`;
      }
      const url = new URL(urlString);
      if (targetDatabase) {
        url.pathname = `/${targetDatabase}`;
      }

      const sslParam = url.searchParams.get("ssl");
      const sslMode = url.searchParams.get("sslmode");
      const ssl =
        conn.ssl ||
        sslParam === "true" ||
        sslParam === "1" ||
        sslMode === "require" ||
        sslMode === "verify-ca" ||
        sslMode === "verify-full" ||
        sslMode === "prefer";

      return {
        host: tunnelEndpoint?.host ?? (url.hostname || undefined),
        port:
          tunnelEndpoint?.port ??
          (url.port ? Number.parseInt(url.port, 10) : 3306),
        database: url.pathname.slice(1)
          ? decodeURIComponent(url.pathname.slice(1))
          : undefined,
        user: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        ssl: ssl ? { rejectUnauthorized: false } : undefined,
        ...baseConfig,
      };
    } catch (error) {
      logger.warn("Failed to parse MySQL connection string", { error });
    }
  }

  let host = conn.host;
  let port = conn.port || 3306;
  if (host && host.includes(":")) {
    const idx = host.lastIndexOf(":");
    const maybePart = host.slice(idx + 1);
    if (/^\d+$/.test(maybePart)) {
      port = conn.port || Number(maybePart);
      host = host.slice(0, idx);
    }
  }

  return {
    host: tunnelEndpoint?.host ?? host,
    port: tunnelEndpoint?.port ?? port,
    database: targetDatabase || conn.database,
    user: conn.username,
    password: conn.password,
    ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    ...baseConfig,
  };
}
