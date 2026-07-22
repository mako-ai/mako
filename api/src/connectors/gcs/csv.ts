import { createHash } from "crypto";
import { parse } from "csv-parse";
import type { Readable } from "stream";

export interface CsvParseOptions {
  delimiter?: string;
  hasHeader?: boolean;
  batchSize?: number;
  /** Skip this many data rows (not counting header). Used for resume. */
  skipRows?: number;
  sourceKey: string;
  sourceGeneration?: string;
  sourceUpdatedAt?: string;
  primaryKey?: string;
}

export interface CsvRecord {
  id: string;
  [key: string]: unknown;
}

function stableRowId(sourceKey: string, rowIndex: number, pk?: string): string {
  if (pk) return String(pk);
  return createHash("sha256")
    .update(`${sourceKey}:${rowIndex}`)
    .digest("hex")
    .slice(0, 32);
}

function matchGlob(fileName: string, glob: string): boolean {
  // Supports simple patterns: *.csv, prefix*.csv, exact names.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(fileName);
}

export function fileMatchesGlob(objectName: string, glob?: string): boolean {
  if (!glob || glob === "*" || glob === "*.*") return true;
  const baseName = objectName.split("/").pop() || objectName;
  return matchGlob(baseName, glob);
}

/**
 * Stream-parse a CSV into batches of records. Resolves with the number of
 * data rows consumed from the stream (including skipped ones).
 */
export async function parseCsvStream(
  stream: Readable,
  options: CsvParseOptions,
  onBatch: (batch: CsvRecord[]) => Promise<void>,
): Promise<{ rowsRead: number; rowsEmitted: number }> {
  const delimiter = options.delimiter || ",";
  const hasHeader = options.hasHeader !== false;
  const batchSize = options.batchSize || 1000;
  const skipRows = options.skipRows || 0;

  const parser = parse({
    delimiter,
    columns: hasHeader,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
  });

  stream.pipe(parser);

  let rowsRead = 0;
  let rowsEmitted = 0;
  let batch: CsvRecord[] = [];
  let columnCount = 0;

  for await (const row of parser) {
    if (rowsRead < skipRows) {
      rowsRead++;
      continue;
    }

    let data: Record<string, unknown>;
    if (hasHeader) {
      data = row as Record<string, unknown>;
    } else {
      const values = row as string[];
      columnCount = Math.max(columnCount, values.length);
      data = {};
      for (let i = 0; i < values.length; i++) {
        data[`column_${i + 1}`] = values[i];
      }
    }

    const pkValue = options.primaryKey ? data[options.primaryKey] : undefined;
    const id = stableRowId(
      options.sourceKey,
      rowsRead,
      pkValue != null && pkValue !== "" ? String(pkValue) : undefined,
    );

    batch.push({
      ...data,
      id,
      _source_key: options.sourceKey,
      _source_generation: options.sourceGeneration ?? null,
      _source_updated_at: options.sourceUpdatedAt ?? null,
    });
    rowsRead++;
    rowsEmitted++;

    if (batch.length >= batchSize) {
      await onBatch(batch);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await onBatch(batch);
  }

  return { rowsRead, rowsEmitted };
}
