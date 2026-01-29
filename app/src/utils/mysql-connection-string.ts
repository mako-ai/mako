/**
 * MySQL Connection String Utilities
 *
 * Two-way parsing and building of MySQL connection URIs.
 * Used for the database connection form's two-way binding between
 * the connection string field and individual form fields.
 */

export interface MySQLConnectionFields {
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
}

/**
 * Parse a MySQL connection string into individual fields.
 *
 * Supports formats:
 * - mysql://user:password@host:port/database?ssl=true
 * - user:password@host:port/database
 */
export function parseMySQLConnectionString(
  connectionString: string,
): MySQLConnectionFields | null {
  if (!connectionString || !connectionString.trim()) {
    return null;
  }

  try {
    let urlString = connectionString.trim();
    if (!urlString.startsWith("mysql://")) {
      if (urlString.includes("@") || urlString.includes(":")) {
        urlString = `mysql://${urlString}`;
      } else {
        return null;
      }
    }

    const url = new URL(urlString);
    const sslParam = url.searchParams.get("ssl");
    const sslMode = url.searchParams.get("sslmode");
    const ssl =
      sslParam === "true" ||
      sslParam === "1" ||
      sslMode === "require" ||
      sslMode === "verify-ca" ||
      sslMode === "verify-full" ||
      sslMode === "prefer";

    return {
      host: url.hostname || undefined,
      port: url.port ? parseInt(url.port, 10) : 3306,
      database: url.pathname.slice(1)
        ? decodeURIComponent(url.pathname.slice(1))
        : undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      ssl,
    };
  } catch {
    return null;
  }
}

/**
 * Build a MySQL connection string from individual fields.
 */
export function buildMySQLConnectionString(
  fields: MySQLConnectionFields,
): string {
  const { host, port, database, username, password, ssl } = fields;

  if (!host) {
    return "";
  }

  let connectionString = "mysql://";

  if (username) {
    connectionString += encodeURIComponent(username);
    if (password) {
      connectionString += `:${encodeURIComponent(password)}`;
    }
    connectionString += "@";
  }

  connectionString += host;
  if (port && port !== 3306) {
    connectionString += `:${port}`;
  }

  if (database) {
    connectionString += `/${encodeURIComponent(database)}`;
  }

  if (ssl) {
    connectionString += "?ssl=true";
  }

  return connectionString;
}
