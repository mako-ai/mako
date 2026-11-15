/**
 * Engine results in the shapes previews and exports share: rows as a list,
 * and `{ name, type }` fields whatever descriptor the engine returned (pg's
 * `dataTypeID`, mysql2's `columnType`, a bare name), inferred from the rows
 * when it returned none.
 */
import { inferFieldsFromRows } from "../services/query-pagination.service";
import { mapPostgresOidToType } from "./drivers/postgresql/pg-type-utils";
import type { QueryField } from "./query-types";

/** A query's result rows as a list (one document, or none, made a list). */
export function resultRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  return data == null ? [] : [data as Record<string, unknown>];
}

/** Field descriptors from any engine, or ones inferred from the rows. */
export function normalizeQueryFields(
  fields: unknown[] | undefined,
  rows: Array<Record<string, unknown>>,
): QueryField[] {
  if (Array.isArray(fields) && fields.length > 0) {
    return fields
      .map(raw => {
        if (typeof raw === "string") {
          return { name: raw };
        }
        const field = (raw ?? {}) as Record<string, unknown>;
        const name = field.name || field.columnName || field.originalName || "";
        if (!name) {
          return null;
        }

        const type =
          field.type ||
          field.dataType ||
          field.columnType ||
          (typeof field.dataTypeID === "number"
            ? mapPostgresOidToType(field.dataTypeID)
            : undefined);
        return {
          name: String(name),
          type: type ? String(type) : undefined,
        };
      })
      .filter((field): field is QueryField => field !== null);
  }

  return inferFieldsFromRows(rows);
}
