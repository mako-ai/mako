/**
 * BigQuery SQL text for values and identifiers: type mapping and
 * inference, escaping, and typed literals for INSERT/MERGE.
 */
/**
 * Map source database column types to valid BigQuery types so columns are
 * created correctly regardless of the source engine.
 */
export function mapToBigQueryType(sourceType: string): string {
  const t = sourceType.toUpperCase();
  if (t === "TEXT" || t.includes("CHAR") || t.includes("CLOB")) return "STRING";
  if (t === "INTEGER" || t === "INT" || t.includes("INT")) return "INT64";
  if (t === "REAL" || t === "FLOAT" || t === "DOUBLE" || t === "NUMERIC") {
    return "FLOAT64";
  }
  if (t === "BLOB") return "BYTES";
  if (t.includes("BOOL")) return "BOOL";
  if (t.includes("TIME") || t.includes("DATE")) return "TIMESTAMP";
  return "STRING"; // Default to STRING for safety
}

/**
 * Map JavaScript types to BigQuery types
 */
export function inferBigQueryType(value: unknown): string {
  if (value === null || value === undefined) return "STRING";
  if (typeof value === "boolean") return "BOOL";
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return "INT64";
    }
    return "FLOAT64";
  }
  if (typeof value === "bigint") return "INT64";
  if (value instanceof Date) return "TIMESTAMP";
  if (Array.isArray(value)) return "JSON";
  if (typeof value === "object") return "JSON";
  if (typeof value === "string") {
    // Try to detect date strings
    if (/^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}:\d{2}/.test(value)) {
      return "TIMESTAMP";
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "DATE";
    }
    return "STRING";
  }
  return "STRING";
}

/**
 * Escape a BigQuery identifier (table name, column name)
 */
export function escapeIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "\\`")}\``;
}

/**
 * Escape a string for safe embedding inside a BigQuery single-quoted literal.
 * Uses backslash escaping which works in both regular strings and JSON literals.
 * Order matters: backslashes first, then control chars, then single quotes.
 */
export function escapeForBigQueryString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/'/g, "\\'");
}

/**
 * Escape a string for safe embedding inside a BigQuery JSON literal.
 * Uses triple-quoted strings to avoid single-quote escaping issues entirely.
 * Returns the full `JSON '''...'''` expression.
 */
export function formatBigQueryJsonLiteral(jsonStr: string): string {
  // Use PARSE_JSON with escaped single-quoted string for maximum safety
  const escaped = escapeForBigQueryString(jsonStr);
  return `PARSE_JSON('${escaped}')`;
}

/**
 * Format a value for BigQuery insertion
 * @param value - The value to format
 * @param targetType - Optional target column type to cast to (e.g., "STRING", "INT64")
 * @param useCast - If true, wrap value in CAST() to ensure consistent types (for STRUCT arrays)
 */
export function formatBigQueryValue(
  value: unknown,
  targetType?: string,
  useCast = false,
): string {
  const resolvedTargetType = useCast
    ? targetType || inferBigQueryType(value)
    : targetType;
  const upperType = resolvedTargetType?.toUpperCase();

  // For useCast mode (STRUCT arrays in MERGE/INSERT), NULL must be typed to avoid
  // BigQuery defaulting to INT64 and causing "Array elements of types do not have
  // a common supertype" errors when mixed with other typed values
  if (value === null || value === undefined) {
    if (useCast && upperType) {
      return `CAST(NULL AS ${upperType})`;
    }
    return "NULL";
  }
  const isNumericTarget =
    upperType === "INT64" ||
    upperType === "INTEGER" ||
    upperType === "FLOAT64" ||
    upperType === "FLOAT" ||
    upperType === "NUMERIC" ||
    upperType === "BIGNUMERIC";

  // When useCast is true (for STRUCT arrays in MERGE), we need to ensure ALL values
  // are formatted consistently to avoid "Array elements of types do not have a common supertype"
  // We do this by always formatting as string and casting to target type
  if (useCast && upperType) {
    // First, format the value as a plain string literal
    let stringValue: string;

    if (typeof value === "boolean") {
      stringValue = value ? "true" : "false";
    } else if (value instanceof Date) {
      stringValue = value.toISOString();
    } else if (Array.isArray(value)) {
      if (upperType === "JSON") {
        return formatBigQueryJsonLiteral(JSON.stringify(value));
      }
      // For STRING target, serialize array as JSON string
      stringValue = escapeForBigQueryString(JSON.stringify(value));
    } else if (typeof value === "object") {
      stringValue = escapeForBigQueryString(JSON.stringify(value));
      if (upperType === "JSON") {
        return formatBigQueryJsonLiteral(JSON.stringify(value));
      }
    } else {
      stringValue = escapeForBigQueryString(String(value));
    }

    // Use SAFE_CAST for type conversion to handle mismatched data gracefully
    // This ensures all STRUCTs have consistent schema
    if (isNumericTarget) {
      return `SAFE_CAST('${stringValue}' AS ${upperType})`;
    } else if (upperType === "BOOL" || upperType === "BOOLEAN") {
      // BigQuery SAFE_CAST doesn't handle 'true'/'false' strings well for BOOL
      // Use explicit CASE for boolean conversion
      const lower = stringValue.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") return "TRUE";
      if (lower === "false" || lower === "0" || lower === "no") return "FALSE";
      return `SAFE_CAST('${stringValue}' AS BOOL)`;
    } else if (upperType === "TIMESTAMP" || upperType === "DATETIME") {
      // If the value is a numeric Unix timestamp (seconds or milliseconds),
      // convert to ISO string first since SAFE_CAST can't parse numeric strings
      const numericValue = Number(stringValue);
      if (!isNaN(numericValue) && stringValue.trim() !== "") {
        // Timestamps > 1e12 are in milliseconds, otherwise seconds
        const ms = numericValue > 1e12 ? numericValue : numericValue * 1000;
        const date = new Date(ms);
        if (!isNaN(date.getTime())) {
          stringValue = date.toISOString();
        }
      }
      return `SAFE_CAST('${stringValue}' AS TIMESTAMP)`;
    } else if (upperType === "DATE") {
      // If the value is a numeric Unix timestamp, convert to date string
      const numericValue = Number(stringValue);
      if (!isNaN(numericValue) && stringValue.trim() !== "") {
        const ms = numericValue > 1e12 ? numericValue : numericValue * 1000;
        const date = new Date(ms);
        if (!isNaN(date.getTime())) {
          stringValue = date.toISOString();
        }
      }
      return `SAFE_CAST('${stringValue.slice(0, 10)}' AS DATE)`;
    } else if (upperType === "STRING") {
      return `CAST('${stringValue}' AS STRING)`;
    } else {
      return `SAFE_CAST('${stringValue}' AS ${upperType})`;
    }
  }

  // Non-CAST mode (for VALUES clause in INSERT, which handles types per-row)
  // Handle numbers: ONLY unquote if we have EXPLICIT numeric target type
  // When targetType is undefined/unknown, ALWAYS quote (safer default)
  if (typeof value === "number" || typeof value === "bigint") {
    // Only output unquoted number if we're 100% sure target is numeric
    if (targetType && isNumericTarget) {
      return String(value);
    }
    // For STRING, unknown, or ANY other case: quote the number
    return `'${String(value)}'`;
  }

  // Handle booleans
  if (typeof value === "boolean") {
    if (upperType === "BOOL" || upperType === "BOOLEAN") {
      return value ? "TRUE" : "FALSE";
    }
    // For STRING or unknown, quote it
    return value ? "'true'" : "'false'";
  }

  // Handle dates
  if (value instanceof Date) {
    if (upperType === "DATE") {
      return `DATE '${value.toISOString().slice(0, 10)}'`;
    }
    if (upperType === "TIMESTAMP" || upperType === "DATETIME" || !upperType) {
      return `TIMESTAMP '${value.toISOString()}'`;
    }
    // For STRING target, quote the ISO string
    return `'${value.toISOString()}'`;
  }

  // Handle arrays — serialize as JSON string so BigQuery creates/matches STRING columns
  if (Array.isArray(value)) {
    if (upperType === "JSON") {
      return formatBigQueryJsonLiteral(JSON.stringify(value));
    }
    const jsonStr = escapeForBigQueryString(JSON.stringify(value));
    return `'${jsonStr}'`;
  }

  // Handle objects (JSON)
  if (typeof value === "object") {
    const jsonStr = escapeForBigQueryString(JSON.stringify(value));
    if (upperType === "JSON") {
      return formatBigQueryJsonLiteral(JSON.stringify(value));
    }
    // For STRING or unknown, just quote the JSON string
    return `'${jsonStr}'`;
  }

  // Handle strings
  const strVal = String(value);
  const escapedStr = escapeForBigQueryString(strVal);

  // If target is TIMESTAMP, wrap with TIMESTAMP keyword
  if (upperType === "TIMESTAMP" || upperType === "DATETIME") {
    return `TIMESTAMP '${escapedStr}'`;
  }

  // If target is DATE, extract date part and wrap
  if (upperType === "DATE") {
    return `DATE '${escapedStr.slice(0, 10)}'`;
  }

  // If target is numeric, try to parse string as number
  if (isNumericTarget) {
    const parsed = parseFloat(strVal);
    if (!isNaN(parsed)) return String(parsed);
  }

  // If target is BOOL, try to parse string as boolean
  if (upperType === "BOOL" || upperType === "BOOLEAN") {
    const lower = strVal.toLowerCase();
    if (lower === "true" || lower === "1") return "TRUE";
    if (lower === "false" || lower === "0") return "FALSE";
  }

  // Default: quoted string
  return `'${escapedStr}'`;
}
