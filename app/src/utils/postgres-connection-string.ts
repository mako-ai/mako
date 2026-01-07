/**
 * PostgreSQL Connection String Utilities
 *
 * Two-way parsing and building of PostgreSQL connection URIs.
 * Used for the database connection form's two-way binding between
 * the connection string field and individual form fields.
 */

export interface PostgresConnectionFields {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
}

/**
 * Parse a PostgreSQL connection string into individual fields.
 *
 * Supports formats:
 * - postgresql://user:password@host:port/database?sslmode=require
 * - postgres://user:password@host:port/database
 *
 * @param connectionString - The PostgreSQL connection URI
 * @returns Parsed connection fields, or null if parsing fails
 */
export function parsePostgresConnectionString(
  connectionString: string,
): PostgresConnectionFields | null {
  if (!connectionString || !connectionString.trim()) {
    return null;
  }

  try {
    // Normalize protocol - both postgres:// and postgresql:// are valid
    let urlString = connectionString.trim();

    // Ensure it starts with a valid protocol for URL parsing
    if (
      !urlString.startsWith("postgresql://") &&
      !urlString.startsWith("postgres://")
    ) {
      // Try adding protocol if missing
      if (urlString.includes("@") || urlString.includes(":")) {
        urlString = `postgresql://${urlString}`;
      } else {
        return null;
      }
    }

    const url = new URL(urlString);

    // Extract SSL mode from query params
    const sslMode = url.searchParams.get("sslmode");
    const ssl =
      sslMode === "require" ||
      sslMode === "verify-ca" ||
      sslMode === "verify-full" ||
      sslMode === "prefer";

    return {
      host: url.hostname || undefined,
      port: url.port ? parseInt(url.port, 10) : 5432,
      database: url.pathname ? url.pathname.slice(1) : undefined, // Remove leading /
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      ssl,
    };
  } catch {
    // URL parsing failed
    return null;
  }
}

/**
 * Build a PostgreSQL connection string from individual fields.
 *
 * @param fields - The connection fields
 * @returns A PostgreSQL connection URI, or empty string if required fields are missing
 */
export function buildPostgresConnectionString(
  fields: PostgresConnectionFields,
): string {
  const { host, port, database, username, password, ssl } = fields;

  // Need at least a host to build a connection string
  if (!host) {
    return "";
  }

  let connectionString = "postgresql://";

  // Add credentials if present
  if (username) {
    connectionString += encodeURIComponent(username);
    if (password) {
      connectionString += `:${encodeURIComponent(password)}`;
    }
    connectionString += "@";
  }

  // Add host and port
  connectionString += host;
  if (port && port !== 5432) {
    connectionString += `:${port}`;
  }

  // Add database if present
  if (database) {
    connectionString += `/${database}`;
  }

  // Add SSL mode if enabled
  if (ssl) {
    connectionString += "?sslmode=require";
  }

  return connectionString;
}

/**
 * Mask the password in a PostgreSQL connection string for display.
 *
 * @param connectionString - The connection string to mask
 * @returns The connection string with password replaced by *****
 */
export function maskPostgresConnectionString(connectionString: string): string {
  if (!connectionString) return connectionString;

  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = "*****";
      return url.toString();
    }
    return connectionString;
  } catch {
    // If URL parsing fails, try regex replacement
    return connectionString.replace(
      /^((?:postgres|postgresql):\/\/[^:]+:)([^@]+)(@)/,
      "$1*****$3",
    );
  }
}
