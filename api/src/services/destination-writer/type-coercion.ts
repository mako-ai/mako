/**
 * Per-column type coercions a database-source flow applies to rows (and to
 * the inferred destination schema) before writing.
 */
import { ITypeCoercion } from "../../database/workspace-schema";
import { ColumnDefinition } from "../../databases/driver";

/**
 * Apply type coercions to a row of data
 */
export function applyTypeCoercions(
  row: Record<string, unknown>,
  coercions: ITypeCoercion[],
): Record<string, unknown> {
  const result = { ...row };

  for (const coercion of coercions) {
    const { column, targetType, format, nullValue, transformer } = coercion;

    if (!(column in result)) {
      continue;
    }

    let value = result[column];

    // Handle null values
    if (value === null || value === undefined) {
      if (nullValue !== undefined) {
        result[column] = nullValue;
      }
      continue;
    }

    // Apply transformer first
    if (transformer && typeof value === "string") {
      switch (transformer) {
        case "lowercase":
          value = value.toLowerCase();
          break;
        case "uppercase":
          value = value.toUpperCase();
          break;
        case "trim":
          value = value.trim();
          break;
        case "json_parse":
          try {
            value = JSON.parse(value);
          } catch {
            // Keep original value if parse fails
          }
          break;
        case "json_stringify":
          value = JSON.stringify(value);
          break;
      }
    }

    // Apply type coercion
    switch (targetType) {
      case "string":
        result[column] = String(value);
        break;
      case "integer":
        result[column] = parseInt(String(value), 10);
        break;
      case "number":
      case "float":
      case "double":
        result[column] = parseFloat(String(value));
        break;
      case "boolean":
        if (typeof value === "string") {
          result[column] = ["true", "1", "yes", "on"].includes(
            value.toLowerCase(),
          );
        } else {
          result[column] = Boolean(value);
        }
        break;
      case "timestamp":
      case "date":
      case "datetime":
        if (value instanceof Date) {
          result[column] = value;
        } else if (typeof value === "string" || typeof value === "number") {
          const date = new Date(value);
          if (!isNaN(date.getTime())) {
            // Apply format if specified (for output formatting)
            if (format === "ISO") {
              result[column] = date.toISOString();
            } else if (format === "YYYY-MM-DD") {
              result[column] = date.toISOString().split("T")[0];
            } else {
              result[column] = date;
            }
          }
        }
        break;
      case "json":
        if (typeof value === "string") {
          try {
            result[column] = JSON.parse(value);
          } catch {
            result[column] = value;
          }
        } else {
          result[column] = value;
        }
        break;
      default:
        // Unknown type, keep as-is but apply transformer result
        result[column] = value;
    }
  }

  return result;
}

/**
 * Map type coercion target types to database column types
 * This is used to override inferred schema during table creation
 */
const coercionTypeToDbType: Record<string, string> = {
  string: "STRING",
  integer: "INT64",
  number: "FLOAT64",
  float: "FLOAT64",
  double: "FLOAT64",
  boolean: "BOOL",
  timestamp: "TIMESTAMP",
  date: "DATE",
  datetime: "TIMESTAMP",
  json: "JSON",
};

/**
 * Apply type coercions to the inferred schema
 * This ensures that the table is created with the correct column types
 * even when the data values might infer a different type
 */
export function applyTypeCoercionsToSchema(
  columns: ColumnDefinition[],
  coercions: ITypeCoercion[],
): ColumnDefinition[] {
  // Create a map of column name -> target type
  const coercionMap = new Map<string, string>();
  for (const coercion of coercions) {
    const dbType = coercionTypeToDbType[coercion.targetType.toLowerCase()];
    if (dbType) {
      coercionMap.set(coercion.column, dbType);
    }
  }

  // Apply overrides to the column definitions
  return columns.map(col => {
    const overrideType = coercionMap.get(col.name);
    if (overrideType) {
      return { ...col, type: overrideType };
    }
    return col;
  });
}
