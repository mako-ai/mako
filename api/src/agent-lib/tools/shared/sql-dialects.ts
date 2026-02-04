/**
 * Shared SQL Dialect Helpers
 *
 * Common utilities for working with different SQL database types.
 * Used by both sql-tools.ts and flow agent.
 */

import { Types } from "mongoose";

/**
 * SQL dialect types supported by the system
 */
export type SqlDialect =
  | "postgresql"
  | "mysql"
  | "bigquery"
  | "sqlite"
  | "clickhouse";

/**
 * Database type to dialect mapping
 */
export const SQL_TYPES = {
  postgres: new Set(["postgresql", "cloudsql-postgres"]),
  mysql: new Set(["mysql"]),
  bigquery: new Set(["bigquery"]),
  sqlite: new Set(["sqlite", "cloudflare-d1"]),
  clickhouse: new Set(["clickhouse"]),
} as const;

/**
 * All supported SQL database types
 */
export const ALL_SQL_TYPES = new Set([
  ...SQL_TYPES.postgres,
  ...SQL_TYPES.mysql,
  ...SQL_TYPES.bigquery,
  ...SQL_TYPES.sqlite,
  ...SQL_TYPES.clickhouse,
]);

/**
 * All supported database types (SQL + MongoDB)
 */
export const ALL_SUPPORTED_TYPES = new Set([...ALL_SQL_TYPES, "mongodb"]);

/**
 * Get the SQL dialect for a database type
 * @throws Error if the type is not a supported SQL type
 */
export function getDialect(type: string): SqlDialect {
  if (SQL_TYPES.postgres.has(type)) return "postgresql";
  if (SQL_TYPES.mysql.has(type)) return "mysql";
  if (SQL_TYPES.bigquery.has(type)) return "bigquery";
  if (SQL_TYPES.sqlite.has(type)) return "sqlite";
  if (SQL_TYPES.clickhouse.has(type)) return "clickhouse";
  throw new Error(`Unknown SQL type: ${type}`);
}

/**
 * Get the SQL dialect for a database type, or null if not SQL
 */
export function getSqlDialectOrNull(type: string): SqlDialect | null {
  if (SQL_TYPES.postgres.has(type)) return "postgresql";
  if (SQL_TYPES.mysql.has(type)) return "mysql";
  if (SQL_TYPES.bigquery.has(type)) return "bigquery";
  if (SQL_TYPES.sqlite.has(type)) return "sqlite";
  if (SQL_TYPES.clickhouse.has(type)) return "clickhouse";
  return null;
}

/**
 * Check if a database type is a SQL database
 */
export function isSqlType(type: string): boolean {
  return ALL_SQL_TYPES.has(type);
}

/**
 * Check if a database type is supported (SQL or MongoDB)
 */
export function isSupportedType(type: string): boolean {
  return ALL_SUPPORTED_TYPES.has(type);
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate and convert a string to a MongoDB ObjectId
 * @throws Error if the value is not a valid ObjectId
 */
export function ensureValidObjectId(
  value: string,
  label: string,
): Types.ObjectId {
  if (typeof value !== "string" || !Types.ObjectId.isValid(value)) {
    throw new Error(`'${label}' must be a valid identifier`);
  }
  return new Types.ObjectId(value);
}

// =============================================================================
// SQL Escaping Helpers
// =============================================================================

export const escapePostgresLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

export const escapePostgresIdentifier = (value: string): string =>
  `"${value.replace(/"/g, '""')}"`;

export const escapeBigQueryIdentifier = (value: string): string =>
  `\`${value.replace(/`/g, "\\`")}\``;

export const escapeMySqlIdentifier = (value: string): string =>
  `\`${value.replace(/`/g, "``")}\``;

export const escapeSqliteLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

export const escapeSqliteIdentifier = (value: string): string =>
  `"${value.replace(/"/g, '""')}"`;

// =============================================================================
// Query Helpers
// =============================================================================

/**
 * Check if a SQL query needs a default LIMIT clause
 */
export function needsDefaultLimit(sql: string): boolean {
  const trimmed = sql.trim();
  if (!trimmed) return false;

  const normalized = trimmed
    .replace(/(--.*?$)/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

  const isSelect = /^\s*select\b/.test(normalized);
  const hasUnion = /\bunion\b/.test(normalized);
  const hasLimit = /\blimit\s+\d+/i.test(normalized);

  // Has LIMIT, or is not a SELECT (could be INSERT/UPDATE/etc)
  if (hasLimit || !isSelect) return false;

  // For UNION queries, only add LIMIT if none of the parts have it
  if (hasUnion) return !hasLimit;

  return true;
}

/**
 * Add a default LIMIT clause to a SELECT query if needed
 */
export function addDefaultLimit(sql: string, limit: number = 500): string {
  if (!needsDefaultLimit(sql)) return sql;
  return `${sql.trim()}\nLIMIT ${limit}`;
}
