import {
  tableToIPC,
  tableFromArrays,
  Utf8,
  Float64,
  Int32,
  Bool,
  TimestampMillisecond,
} from "apache-arrow";

interface FieldMeta {
  name: string;
  type?: string;
}

type ArrowDataType =
  | typeof Utf8
  | typeof Float64
  | typeof Int32
  | typeof Bool
  | typeof TimestampMillisecond;

function inferArrowType(
  fieldName: string,
  fieldType: string | undefined,
  sampleValues: unknown[],
): ArrowDataType {
  if (fieldType) {
    const ft = fieldType.toLowerCase();
    if (ft.includes("int") || ft.includes("serial") || ft.includes("integer")) {
      return Int32;
    }
    if (
      ft.includes("float") ||
      ft.includes("double") ||
      ft.includes("decimal") ||
      ft.includes("numeric") ||
      ft.includes("real") ||
      ft.includes("money") ||
      ft.includes("bigint")
    ) {
      return Float64;
    }
    if (ft.includes("bool")) return Bool;
    if (
      ft.includes("date") ||
      ft.includes("time") ||
      ft.includes("timestamp")
    ) {
      return TimestampMillisecond;
    }
    if (
      ft.includes("text") ||
      ft.includes("varchar") ||
      ft.includes("char") ||
      ft.includes("string") ||
      ft.includes("uuid") ||
      ft.includes("json") ||
      ft.includes("xml")
    ) {
      return Utf8;
    }
  }

  for (const val of sampleValues) {
    if (val == null) continue;
    if (typeof val === "boolean") return Bool;
    if (typeof val === "number") {
      if (Number.isInteger(val) && Math.abs(val) < 2147483647) return Int32;
      return Float64;
    }
    if (val instanceof Date) return TimestampMillisecond;
    if (typeof val === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(val) && !isNaN(Date.parse(val))) {
        return TimestampMillisecond;
      }
    }
  }

  return Utf8;
}

function coerceValue(value: unknown, arrowType: ArrowDataType): unknown {
  if (value == null) return null;

  if (arrowType === TimestampMillisecond) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string" || typeof value === "number") {
      const ts = new Date(value).getTime();
      return isNaN(ts) ? null : ts;
    }
    return null;
  }

  if (arrowType === Float64 || arrowType === Int32) {
    if (typeof value === "number") return value;
    const n = Number(value);
    return isNaN(n) ? null : n;
  }

  if (arrowType === Bool) {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0) return false;
    return null;
  }

  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface SerializeOptions {
  limit?: number;
}

/**
 * Serialize an array of row objects + field metadata to Arrow IPC bytes.
 * DuckDB-WASM can register the resulting buffer directly as a table.
 */
export function serializeToArrowIPC(
  rows: Record<string, unknown>[],
  fields: FieldMeta[],
  options?: SerializeOptions,
): Uint8Array {
  const effectiveRows =
    options?.limit && rows.length > options.limit
      ? rows.slice(0, options.limit)
      : rows;

  if (effectiveRows.length === 0 || fields.length === 0) {
    const emptyArrays: Record<string, unknown[]> = {};
    for (const f of fields) {
      emptyArrays[f.name] = [];
    }
    if (fields.length === 0) {
      emptyArrays["_empty"] = [];
    }
    const table = tableFromArrays(emptyArrays);
    return tableToIPC(table);
  }

  const sampleSize = Math.min(100, effectiveRows.length);
  const columnTypes: Map<string, ArrowDataType> = new Map();

  for (const field of fields) {
    const samples: unknown[] = [];
    for (let i = 0; i < sampleSize; i++) {
      samples.push(effectiveRows[i]?.[field.name]);
    }
    columnTypes.set(
      field.name,
      inferArrowType(field.name, field.type, samples),
    );
  }

  const columnArrays: Record<string, unknown[]> = {};
  for (const field of fields) {
    const arrowType = columnTypes.get(field.name)!;
    columnArrays[field.name] = effectiveRows.map(row =>
      coerceValue(row[field.name], arrowType),
    );
  }

  const table = tableFromArrays(columnArrays);
  return tableToIPC(table);
}
