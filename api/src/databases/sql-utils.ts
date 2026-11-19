/**
 * Shared SQL helpers for database drivers.
 */

/** Escape a string value as a single-quoted SQL literal. */
export function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Null-safe equality of two quoted SQL operands: true when both are equal or
 * both are NULL. MERGE and key joins use it on every key column, so a
 * composite key with a NULL part matches its own row. Plain `=` never matches
 * NULL, and each sync then inserts that row again (106,281 duplicate Meta ads
 * rows on 19 Nov 2026, all with a NULL `region`).
 *
 * Written as `=` OR both NULL rather than `IS NOT DISTINCT FROM`. BigQuery
 * runs `IS NOT DISTINCT FROM` as a cross join: 317,716 slot-ms against 375
 * for this form on a 119k-row self join. Both prune partitions the same.
 */
export function nullSafeEquals(left: string, right: string): string {
  return `(${left} = ${right} OR (${left} IS NULL AND ${right} IS NULL))`;
}
