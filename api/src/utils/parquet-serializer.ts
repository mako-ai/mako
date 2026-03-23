import os from "os";
import path from "path";
import { promises as fsPromises } from "fs";
import { serializeToArrowIPC, type FieldMeta } from "./arrow-serializer";

export interface ParquetTempFileResult {
  filePath: string;
  rowCount: number;
  byteSize: number;
}

type ParquetWasmModule = {
  Compression: {
    ZSTD: unknown;
  };
  Table: {
    fromIPCStream(buffer: Uint8Array): unknown;
  };
  WriterPropertiesBuilder: new () => {
    setCompression(value: unknown): {
      setMaxRowGroupSize(size: number): {
        build(): unknown;
      };
    };
  };
  writeParquet(table: unknown, writerProperties: unknown): Uint8Array;
  initSync(module: BufferSource | WebAssembly.Module): unknown;
};

const importParquetWasm = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<ParquetWasmModule>;

let parquetWasmModulePromise: Promise<ParquetWasmModule> | null = null;

async function loadParquetWasmModule(): Promise<ParquetWasmModule> {
  if (!parquetWasmModulePromise) {
    parquetWasmModulePromise = (async () => {
      const parquetWasm = await importParquetWasm(
        "parquet-wasm/esm/parquet_wasm.js",
      );
      const wasmPath = require.resolve("parquet-wasm/esm/parquet_wasm_bg.wasm");
      const wasmBytes = await fsPromises.readFile(wasmPath);

      parquetWasm.initSync({ module: wasmBytes });

      return parquetWasm;
    })();
  }

  return parquetWasmModulePromise;
}

export async function writeParquetTempFile(options: {
  rows: Record<string, unknown>[];
  fields: FieldMeta[];
  filenameBase?: string;
}): Promise<ParquetTempFileResult> {
  const parquetWasm = await loadParquetWasmModule();
  const arrowBuffer = serializeToArrowIPC(options.rows, options.fields);
  const table = parquetWasm.Table.fromIPCStream(arrowBuffer);
  const writerProps = new parquetWasm.WriterPropertiesBuilder()
    .setCompression(parquetWasm.Compression.ZSTD)
    .setMaxRowGroupSize(5000)
    .build();
  const parquetBytes = parquetWasm.writeParquet(table, writerProps);

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
