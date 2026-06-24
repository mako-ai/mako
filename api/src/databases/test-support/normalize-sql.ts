/**
 * Collapse insignificant whitespace in a SQL string so assertions don't break
 * on indentation / newline churn. Trims, then squeezes runs of whitespace to a
 * single space. Use for `toContain` / equality checks on generated SQL.
 */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Convenience: does `haystack` contain `needle` ignoring whitespace differences?
 */
export function sqlContains(haystack: string, needle: string): boolean {
  return normalizeSql(haystack).includes(normalizeSql(needle));
}
