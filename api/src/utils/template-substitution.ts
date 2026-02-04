/**
 * Template Substitution Utility
 *
 * Shared utility for replacing template placeholders in SQL queries.
 * Used by:
 * - validateQuery() for agent and frontend validation
 * - executeDbSyncChunk() for Inngest flow execution
 *
 * Supported placeholders:
 * - {{limit}} - batch size for pagination
 * - {{offset}} - offset for pagination
 * - {{last_sync_value}} - last value of tracking column (incremental sync)
 * - {{keyset_value}} - last keyset column value (keyset pagination)
 */

/**
 * Values to substitute into template placeholders
 */
export interface TemplateValues {
  limit?: number;
  offset?: number;
  last_sync_value?: string | number | null;
  keyset_value?: string | number | null;
}

/**
 * Options for template substitution
 */
export interface SubstituteOptions {
  /**
   * When true, removes clauses that reference null template values
   * instead of substituting them. Useful for validation where we want
   * to test the base query structure.
   */
  stripNullClauses?: boolean;
}

/**
 * Regular expressions for matching template placeholders
 * Supports whitespace tolerance: {{limit}}, {{ limit }}, {{  limit  }}
 */
const TEMPLATE_PATTERNS = {
  limit: /\{\{\s*limit\s*\}\}/gi,
  offset: /\{\{\s*offset\s*\}\}/gi,
  last_sync_value: /\{\{\s*last_sync_value\s*\}\}/gi,
  keyset_value: /\{\{\s*keyset_value\s*\}\}/gi,
};

/**
 * Check if a query contains any template placeholders
 */
export function hasTemplates(query: string): boolean {
  return Object.values(TEMPLATE_PATTERNS).some(pattern => pattern.test(query));
}

/**
 * Check which templates are present in a query
 */
export function detectTemplates(query: string): {
  hasLimit: boolean;
  hasOffset: boolean;
  hasLastSyncValue: boolean;
  hasKeysetValue: boolean;
} {
  // Reset lastIndex for each pattern (they have 'g' flag)
  Object.values(TEMPLATE_PATTERNS).forEach(p => (p.lastIndex = 0));

  return {
    hasLimit: TEMPLATE_PATTERNS.limit.test(query),
    hasOffset: TEMPLATE_PATTERNS.offset.test(query),
    hasLastSyncValue: TEMPLATE_PATTERNS.last_sync_value.test(query),
    hasKeysetValue: TEMPLATE_PATTERNS.keyset_value.test(query),
  };
}

/**
 * Get safe default values for validation
 * These allow the query to execute without errors while fetching minimal data
 */
export function getValidationDefaults(): TemplateValues {
  return {
    limit: 1,
    offset: 0,
    last_sync_value: null,
    keyset_value: null,
  };
}

/**
 * Substitute template placeholders in a query with provided values
 *
 * @param query - SQL query containing template placeholders
 * @param values - Values to substitute
 * @param options - Substitution options
 * @returns Query with placeholders replaced
 *
 * @example
 * // Basic substitution
 * substituteTemplates(
 *   "SELECT * FROM users LIMIT {{limit}} OFFSET {{offset}}",
 *   { limit: 100, offset: 0 }
 * )
 * // Returns: "SELECT * FROM users LIMIT 100 OFFSET 0"
 *
 * @example
 * // Incremental sync
 * substituteTemplates(
 *   "SELECT * FROM users WHERE updated_at > '{{last_sync_value}}'",
 *   { last_sync_value: "2024-01-15T10:30:00Z" }
 * )
 * // Returns: "SELECT * FROM users WHERE updated_at > '2024-01-15T10:30:00Z'"
 */
export function substituteTemplates(
  query: string,
  values: TemplateValues,
  options?: SubstituteOptions,
): string {
  let result = query;

  // Reset lastIndex for all patterns (they have 'g' flag)
  Object.values(TEMPLATE_PATTERNS).forEach(p => (p.lastIndex = 0));

  // Substitute {{limit}}
  if (values.limit !== undefined && values.limit !== null) {
    result = result.replace(TEMPLATE_PATTERNS.limit, String(values.limit));
  } else if (options?.stripNullClauses) {
    // For validation: use a safe default
    result = result.replace(TEMPLATE_PATTERNS.limit, "1");
  }

  // Substitute {{offset}}
  if (values.offset !== undefined && values.offset !== null) {
    result = result.replace(TEMPLATE_PATTERNS.offset, String(values.offset));
  } else if (options?.stripNullClauses) {
    // For validation: use a safe default
    result = result.replace(TEMPLATE_PATTERNS.offset, "0");
  }

  // Substitute {{last_sync_value}}
  if (values.last_sync_value !== undefined && values.last_sync_value !== null) {
    result = result.replace(
      TEMPLATE_PATTERNS.last_sync_value,
      String(values.last_sync_value),
    );
  } else if (options?.stripNullClauses) {
    // For validation with null last_sync_value:
    // We need to handle the WHERE clause carefully
    // Option 1: Use epoch timestamp for timestamps, 0 for numerics
    // Option 2: Remove the entire WHERE condition
    // We'll use a safe approach: substitute with a value that returns all rows
    // Using '1970-01-01T00:00:00Z' for timestamps or '0' for numerics
    // Since we don't know the type, we'll use a string that works for both contexts
    result = result.replace(TEMPLATE_PATTERNS.last_sync_value, "0");
  }

  // Substitute {{keyset_value}}
  if (values.keyset_value !== undefined && values.keyset_value !== null) {
    result = result.replace(
      TEMPLATE_PATTERNS.keyset_value,
      String(values.keyset_value),
    );
  } else if (options?.stripNullClauses) {
    // For validation: use 0 which should work for most numeric keyset columns
    result = result.replace(TEMPLATE_PATTERNS.keyset_value, "0");
  }

  return result;
}

/**
 * Prepare a query for validation by substituting safe defaults
 * This ensures the query can be executed without syntax errors
 *
 * @param query - SQL query with potential template placeholders
 * @returns Query ready for validation execution
 */
export function prepareQueryForValidation(query: string): string {
  const defaults = getValidationDefaults();
  return substituteTemplates(query, defaults, { stripNullClauses: true });
}
