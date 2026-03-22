import os from "os";
import path from "path";
import { promises as fsPromises } from "fs";
import initWasm, {
  Compression,
  Table,
  WriterPropertiesBuilder,
  writeParquet,
} from "parquet-wasm/node";
import { serializeToArrowIPC, type FieldMeta } from "./arrow-serializer";

let parquetInitPromise: Promise<void> | null = null;

async function ensureParquetWasm(): Promise<void> {
  if (!parquetInitPromise) {
    parquetInitPromise = initWasm();
  }
  await parquetInitPromise;
}

export interface ParquetTempFileResult {
  filePath: string;
  rowCount: number;
  byteSize: number;
}

export async function writeParquetTempFile(options: {
  rows: Record<string, unknown>[];
  fields: FieldMeta[];
  filenameBase?: string;
}): Promise<ParquetTempFileResult> {
  await ensureParquetWasm();

  const arrowBuffer = serializeToArrowIPC(options.rows, options.fields);
  const table = Table.fromIPCStream(arrowBuffer);
  const writerProps = new WriterPropertiesBuilder()
    .setCompression(Compression.ZSTD)
    .setMaxRowGroupSize(5000)
    .build();
  const parquetBytes = writeParquet(table, writerProps);

  const safeBase = (options.filenameBase || "dashboard-export").replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  const filePath = path.join(
    os.tmpdir(),
    `${safeBase}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.parquet`,
  );

  await fsPromises.writeFile(filePath, parquetBytes);

  return {
    filePath,
    rowCount: options.rows.length,
    byteSize: parquetBytes.byteLength,
  };
}
