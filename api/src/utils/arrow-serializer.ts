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
    const arrowType = columnTypes.get(field.name) ?? Utf8;
    columnArrays[field.name] = effectiveRows.map(row =>
      coerceValue(row[field.name], arrowType),
    );
  }

  const table = tableFromArrays(columnArrays);
  return tableToIPC(table);
}

const ARROW_STREAM_BATCH_SIZE = 5000;

function buildBatchTable(
  rows: Record<string, unknown>[],
  fields: FieldMeta[],
  columnTypes: Map<string, ArrowDataType>,
) {
  const columnArrays: Record<string, unknown[]> = {};
  for (const field of fields) {
    const arrowType = columnTypes.get(field.name) ?? Utf8;
    columnArrays[field.name] = rows.map(row =>
      coerceValue(row[field.name], arrowType),
    );
  }
  return tableFromArrays(columnArrays);
}

/**
 * Create a streaming Arrow IPC response. Rows flow through in batches of
 * ~5 000 so neither server nor client ever buffers the full dataset.
 *
 * Uses a RecordBatchStreamWriter driven by an async iterator so the output
 * is a single valid Arrow IPC stream (schema, N record-batches, EOS).
 *
 * @param fields  Column metadata (name + optional DB type string). If empty,
 *   fields are inferred from the first batch of rows.
 * @param streamRows  Callback that receives an `emitRows` function. Call
 *   `emitRows(batch)` for every chunk from the DB cursor. Return `{ totalRows }`.
 * @returns A web-standard `Response` with `Content-Type: application/vnd.apache.arrow.stream`.
 */
export function createArrowIPCStreamResponse(options: {
  fields?: FieldMeta[];
  filename?: string;
  streamRows: (
    emitRows: (rows: Array<Record<string, unknown>>) => Promise<void>,
  ) => Promise<{ totalRows: number }>;
}): Response {
  const { fields: initialFields, streamRows, filename } = options;

  const headers = new Headers();
  headers.set("Content-Type", "application/vnd.apache.arrow.stream");
  if (filename) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${filename}.arrow"`,
    );
  }
  headers.set("Cache-Control", "no-store");

  type BatchTable = ReturnType<typeof buildBatchTable>;
  let resolveNextTable: ((table: BatchTable | null) => void) | null = null;
  const tableQueue: (BatchTable | null)[] = [];

  function enqueueTable(table: BatchTable | null) {
    if (resolveNextTable) {
      const resolve = resolveNextTable;
      resolveNextTable = null;
      resolve(table);
    } else {
      tableQueue.push(table);
    }
  }

  function dequeueTable(): Promise<BatchTable | null> {
    if (tableQueue.length > 0) {
      return Promise.resolve(tableQueue.shift() ?? null);
    }
    return new Promise(resolve => {
      resolveNextTable = resolve;
    });
  }

  async function* batchGenerator(): AsyncGenerator<any> {
    for (;;) {
      const table = await dequeueTable();
      if (table === null) break;
      for (const batch of table.batches) {
        yield batch;
      }
    }
  }

  let resolvedFields: FieldMeta[] = initialFields ?? [];
  const columnTypes = new Map<string, ArrowDataType>();

  function ensureSchema(sampleRows: Record<string, unknown>[]) {
    if (resolvedFields.length > 0) return;
    if (sampleRows.length === 0) return;
    resolvedFields = Object.keys(sampleRows[0]).map(name => ({ name }));
    const sampleSize = Math.min(100, sampleRows.length);
    for (const field of resolvedFields) {
      const samples = sampleRows.slice(0, sampleSize).map(r => r[field.name]);
      columnTypes.set(
        field.name,
        inferArrowType(field.name, undefined, samples),
      );
    }
  }

  if (resolvedFields.length > 0) {
    for (const field of resolvedFields) {
      columnTypes.set(field.name, inferArrowType(field.name, field.type, []));
    }
  }

  const writeComplete = (async () => {
    let pendingRows: Record<string, unknown>[] = [];

    const result = await streamRows(async rows => {
      ensureSchema(rows);
      pendingRows.push(...rows);
      while (pendingRows.length >= ARROW_STREAM_BATCH_SIZE) {
        const batch = pendingRows.splice(0, ARROW_STREAM_BATCH_SIZE);
        const table = buildBatchTable(batch, resolvedFields, columnTypes);
        enqueueTable(table);
      }
    });

    if (pendingRows.length > 0) {
      const table = buildBatchTable(pendingRows, resolvedFields, columnTypes);
      enqueueTable(table);
      pendingRows = [];
    }

    enqueueTable(null);
    return result;
  })();

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          const arrowModule = await import("apache-arrow");
          const writer = new arrowModule.RecordBatchStreamWriter();
          const gen = batchGenerator();
          const first = await gen.next();
          if (first.done || !first.value) {
            if (resolvedFields.length === 0) {
              resolvedFields = [{ name: "_empty" }];
              columnTypes.set("_empty", Utf8);
            }
            const emptyTable = buildBatchTable([], resolvedFields, columnTypes);
            const bytes = tableToIPC(emptyTable, "stream");
            controller.enqueue(bytes);
            await writeComplete;
            controller.close();
            return;
          }

          writer.write(first.value);

          for await (const batch of gen) {
            writer.write(batch);
          }

          writer.finish();

          const bytes = await writer.toUint8Array();
          controller.enqueue(bytes);

          await writeComplete;
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      })();
    },
  });

  return new Response(readable, { headers });
}
