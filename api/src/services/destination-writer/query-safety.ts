/**
 * Static read-only checks for a user-supplied source query.
 */

/**
 * Dangerous SQL statement patterns that should be rejected
 */
const DANGEROUS_PATTERNS = [
  { pattern: /^\s*DROP\s+/i, name: "DROP" },
  { pattern: /^\s*DELETE\s+/i, name: "DELETE" },
  { pattern: /^\s*TRUNCATE\s+/i, name: "TRUNCATE" },
  { pattern: /^\s*ALTER\s+/i, name: "ALTER" },
  { pattern: /^\s*CREATE\s+/i, name: "CREATE" },
  { pattern: /^\s*INSERT\s+/i, name: "INSERT" },
  { pattern: /^\s*UPDATE\s+/i, name: "UPDATE" },
  { pattern: /^\s*GRANT\s+/i, name: "GRANT" },
  { pattern: /^\s*REVOKE\s+/i, name: "REVOKE" },
  {
    pattern:
      /;\s*(DROP|DELETE|TRUNCATE|ALTER|CREATE|INSERT|UPDATE|GRANT|REVOKE)\s+/i,
    name: "multi-statement",
  },
  // CTE with data-modifying operations (e.g., WITH deleted AS (DELETE FROM ...) SELECT ...)
  // Only match when a DML keyword appears after "AS (" inside a CTE definition,
  // to avoid false positives on column names or string literals containing these words.
  {
    pattern:
      /\bWITH\b[^;]*\bAS\s*\(\s*(DELETE|INSERT|UPDATE|DROP|TRUNCATE|ALTER)\b/i,
    name: "data-modifying CTE",
  },
];

/**
 * Result of query safety check
 */
export interface QuerySafetyResult {
  safe: boolean;
  warnings: string[];
  errors: string[];
  suggestedFixes?: string[];
}

/**
 * Check if a query is safe for sync operations (read-only)
 * Returns errors for dangerous statements and warnings for best practices
 */
export function checkQuerySafety(query: string): QuerySafetyResult {
  const result: QuerySafetyResult = {
    safe: true,
    warnings: [],
    errors: [],
    suggestedFixes: [],
  };

  const trimmedQuery = query.trim();

  // Check for dangerous patterns
  for (const { pattern, name } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmedQuery)) {
      result.safe = false;
      result.errors.push(
        `Query contains dangerous ${name} statement. Only SELECT queries are allowed for sync operations.`,
      );
    }
  }

  // Check if query starts with SELECT
  if (
    !trimmedQuery.match(/^\s*SELECT\s+/i) &&
    !trimmedQuery.match(/^\s*WITH\s+/i)
  ) {
    result.safe = false;
    result.errors.push(
      "Query must start with SELECT or WITH (CTE). Only read operations are allowed.",
    );
  }

  // Check for ORDER BY (warning, not error)
  if (!trimmedQuery.match(/ORDER\s+BY\s+/i)) {
    result.warnings.push(
      "Query does not have ORDER BY clause. For consistent pagination results, consider adding ORDER BY.",
    );
    result.suggestedFixes?.push(
      "Add ORDER BY clause with a unique column (e.g., ORDER BY id ASC)",
    );
  }

  // Check for multiple statements (semicolons)
  const semicolonCount = (trimmedQuery.match(/;/g) || []).length;
  if (
    semicolonCount > 1 ||
    (semicolonCount === 1 && !trimmedQuery.endsWith(";"))
  ) {
    result.safe = false;
    result.errors.push(
      "Query contains multiple statements. Only single SELECT queries are allowed.",
    );
  }

  // Check for LIMIT without ORDER BY (warning)
  if (
    trimmedQuery.match(/LIMIT\s+\d+/i) &&
    !trimmedQuery.match(/ORDER\s+BY\s+/i)
  ) {
    result.warnings.push(
      "Query has LIMIT without ORDER BY. Results may be non-deterministic across runs.",
    );
  }

  return result;
}
