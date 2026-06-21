/**
 * Shared SQL helpers for database drivers.
 */

/** Escape a string value as a single-quoted SQL literal. */
export function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
