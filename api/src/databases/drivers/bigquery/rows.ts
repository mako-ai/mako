/**
 * BigQuery REST rows (`{ f: [{ v }] }`) and schemas, as plain objects and
 * field lists.
 */
import { inferFieldsFromRows } from "../../../services/query-pagination.service";
import type { QueryField } from "../../query-types";

/** A field of a BigQuery table or result schema. */
export interface BigQueryField {
  name: string;
  type?: string;
  mode?: string;
  fields?: BigQueryField[];
}

export interface BigQuerySchema {
  fields?: BigQueryField[];
}

/** A REST row: one cell per schema field. */
export interface BigQueryRow {
  f?: Array<{ v?: unknown }>;
}

/** The schema's fields, or ones inferred from the rows when it has none. */
export function schemaToFields(
  schema: BigQuerySchema | undefined,
  rows: Array<Record<string, unknown>>,
): QueryField[] {
  const schemaFields = Array.isArray(schema?.fields) ? schema.fields : [];
  if (schemaFields.length === 0) {
    return inferFieldsFromRows(rows);
  }

  return schemaFields
    .map((field): QueryField | null => {
      const name = field?.name ? String(field.name) : "";
      if (!name) {
        return null;
      }
      return {
        name,
        type: field?.type ? String(field.type) : undefined,
      };
    })
    .filter((field): field is QueryField => field !== null);
}

export function mapRowsToObjects(
  rows: BigQueryRow[] | undefined,
  schema: BigQuerySchema | undefined,
): Record<string, unknown>[] {
  const fields = schema?.fields || [];
  return (rows || []).map(r => mapRow(r, fields));
}

function mapRow(
  row: BigQueryRow | undefined,
  fields: BigQueryField[],
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const cells = Array.isArray(row?.f) ? row.f : [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const cell = cells[i]?.v;
    obj[field.name] = parseCellValue(cell, field);
  }
  return obj;
}

function parseCellValue(value: unknown, field: BigQueryField): unknown {
  if (value === null || value === undefined) return null;
  const mode = String(field?.mode || "").toUpperCase();
  const type = String(field?.type || "").toUpperCase();
  if (mode === "REPEATED") {
    const arr: unknown[] = Array.isArray(value) ? value : [];
    return arr.map(v =>
      parseCellValue((v as { v?: unknown } | null)?.v ?? v, {
        ...field,
        mode: undefined,
      }),
    );
  }
  switch (type) {
    case "RECORD":
      return mapRow(value as BigQueryRow, field.fields || []);
    case "INTEGER":
    case "INT64":
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC":
      return value === "" ? null : Number(value);
    case "BOOLEAN":
    case "BOOL":
      return value === true || value === "true";
    case "TIMESTAMP": {
      if (value === "") return null;
      // BigQuery REST API returns TIMESTAMP as epoch-seconds float (e.g. "1.677123456E9").
      // Convert to ISO 8601 string for human-readable display.
      const num = Number(value);
      if (!isNaN(num)) {
        return new Date(num * 1000)
          .toISOString()
          .replace("T", " ")
          .replace("Z", " UTC");
      }
      return value;
    }
    case "DATETIME": {
      // DATETIME has no timezone in BigQuery; value is already a string like "2025-01-01 20:45:28".
      return value;
    }
    default:
      return value;
  }
}

/**
 * Flatten BigQuery schema fields to column definitions
 * Handles nested RECORD/STRUCT types by flattening with dot notation
 */
export function flattenSchemaFields(
  fields: BigQueryField[],
  prefix = "",
): Array<{ name: string; type: string; nullable: boolean }> {
  const columns: Array<{ name: string; type: string; nullable: boolean }> = [];

  for (const field of fields) {
    const name = prefix ? `${prefix}.${field.name}` : field.name;
    const mode = field.mode || "NULLABLE";
    const nullable = mode !== "REQUIRED";

    if (field.type === "RECORD" && Array.isArray(field.fields)) {
      // Flatten nested records
      columns.push(...flattenSchemaFields(field.fields, name));
    } else {
      columns.push({
        name,
        type: field.type as string,
        nullable,
      });
    }
  }

  return columns;
}
