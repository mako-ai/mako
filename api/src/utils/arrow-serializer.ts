/* eslint-disable no-console */
import {
  tableToIPC,
  tableFromArrays,
  vectorFromArray,
  RecordBatchStreamWriter,
  Utf8,
  Float64,
  Int32,
  Bool,
  TimestampMillisecond,
} from "apache-arrow";

export interface FieldMeta {
  name: string;
  type?: string;
}

type ArrowDataType =
  | typeof Utf8
  | typeof Float64
  | typeof Int32
  | typeof Bool
  | typeof TimestampMillisecond;

const DEFAULT_ARROW_BATCH_SIZE = 5000;

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

  if (typeof value === "object") {
    if (
      value != null &&
      typeof (value as any).toString === "function" &&
      (value as any)._bsontype
    ) {
      return (value as any).toString();
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function inferFieldsFromFirstBatch(
  rows: Record<string, unknown>[],
  fields: FieldMeta[],
): FieldMeta[] {
  if (fields.length > 0 || rows.length === 0) {
    return fields;
  }

  return Object.keys(rows[0] || {}).map(name => ({
    name,
    type: undefined,
  }));
}

function buildColumnTypes(
  fields: FieldMeta[],
  rows: Record<string, unknown>[],
): Map<string, ArrowDataType> {
  const sampleSize = Math.min(100, rows.length);
  const columnTypes: Map<string, ArrowDataType> = new Map();

  for (const field of fields) {
    const samples: unknown[] = [];
    for (let i = 0; i < sampleSize; i++) {
      samples.push(rows[i]?.[field.name]);
    }
    columnTypes.set(
      field.name,
      inferArrowType(field.name, field.type, samples),
    );
  }

  return columnTypes;
}

function buildArrowTable(
  rows: Record<string, unknown>[],
  fields: FieldMeta[],
  columnTypes: Map<string, ArrowDataType>,
) {
  const columns: Record<string, unknown> = {};

  for (const field of fields) {
    const arrowType = columnTypes.get(field.name) || Utf8;
    const values = rows.map(row => coerceValue(row[field.name], arrowType));
    columns[field.name] = vectorFromArray(values, new arrowType());
  }

  if (fields.length === 0) {
    columns["_empty"] = vectorFromArray([], new Utf8());
  }

  return tableFromArrays(columns as any);
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
  const resolvedFields = inferFieldsFromFirstBatch(effectiveRows, fields);
  const columnTypes = buildColumnTypes(resolvedFields, effectiveRows);
  const table = buildArrowTable(effectiveRows, resolvedFields, columnTypes);
  return tableToIPC(table);
}

export function createArrowIPCStream(
  fields: FieldMeta[],
  streamRows: (
    emitRows: (rows: Array<Record<string, unknown>>) => Promise<void>,
  ) => Promise<{ totalRows: number }>,
): ReadableStream<Uint8Array> {
  const streamWriter = RecordBatchStreamWriter.throughDOM();
  const writer = streamWriter.writable.getWriter();

  void (async () => {
    let pendingRows: Record<string, unknown>[] = [];
    let resolvedFields = fields;
    let columnTypes = buildColumnTypes(fields, []);
    let columnTypesResolved = false;
    let emittedRows = 0;
    console.log(
      `[opfs-diag] createArrowIPCStream start: initialFields=${fields.length}`,
    );

    const flushRows = async (rows: Record<string, unknown>[]) => {
      if (rows.length === 0) {
        return;
      }

      resolvedFields = inferFieldsFromFirstBatch(rows, resolvedFields);
      if (!columnTypesResolved) {
        columnTypes = buildColumnTypes(resolvedFields, rows);
        columnTypesResolved = true;
      }
      emittedRows += rows.length;
      console.log(
        `[opfs-diag] createArrowIPCStream flushRows: batchRows=${rows.length} emittedRows=${emittedRows} resolvedFields=${resolvedFields.length}`,
      );
      const table = buildArrowTable(rows, resolvedFields, columnTypes);
      for (const batch of table.batches) {
        await writer.write(batch as any);
      }
    };

    try {
      await streamRows(async rows => {
        if (rows.length === 0) {
          console.log(
            "[opfs-diag] createArrowIPCStream received empty row batch",
          );
          return;
        }

        console.log(
          `[opfs-diag] createArrowIPCStream received row batch: rows=${rows.length}`,
        );
        pendingRows.push(...rows);
        while (pendingRows.length >= DEFAULT_ARROW_BATCH_SIZE) {
          const batch = pendingRows.slice(0, DEFAULT_ARROW_BATCH_SIZE);
          pendingRows = pendingRows.slice(DEFAULT_ARROW_BATCH_SIZE);
          await flushRows(batch);
        }
      });

      await flushRows(pendingRows);

      if (emittedRows === 0) {
        const emptyFields = inferFieldsFromFirstBatch([], resolvedFields);
        console.log(
          `[opfs-diag] createArrowIPCStream zero-row branch: resolvedFields=${emptyFields.length}`,
        );
        if (emptyFields.length > 0) {
          const emptyTypes = buildColumnTypes(emptyFields, []);
          const emptyTable = buildArrowTable([], emptyFields, emptyTypes);
          for (const batch of emptyTable.batches) {
            await writer.write(batch as any);
          }
          console.log(
            `[opfs-diag] createArrowIPCStream emitted empty schema batch: fields=${emptyFields.length}`,
          );
        } else {
          console.log(
            "[opfs-diag] createArrowIPCStream closing cleanly without emitting synthetic empty batch",
          );
        }
      }

      await writer.close();
      console.log(
        `[opfs-diag] createArrowIPCStream close success: emittedRows=${emittedRows} resolvedFields=${resolvedFields.length}`,
      );
    } catch (error) {
      console.warn("[opfs-diag] createArrowIPCStream aborting", error);
      await writer.abort(error);
    }
  })();

  return streamWriter.readable;
}

/**
 * Convenience wrapper for Arrow IPC export responses.
 */
export function createArrowIPCStreamResponse(options: {
  fields?: FieldMeta[];
  filename?: string;
  streamRows: (
    emitRows: (rows: Array<Record<string, unknown>>) => Promise<void>,
  ) => Promise<{ totalRows: number }>;
}): Response {
  const { fields = [], streamRows, filename } = options;
  const headers = new Headers();
  headers.set("Content-Type", "application/vnd.apache.arrow.stream");
  headers.set("Cache-Control", "no-store");

  if (filename) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${filename}.arrow"`,
    );
  }

  return new Response(createArrowIPCStream(fields, streamRows), {
    headers,
  });
}
