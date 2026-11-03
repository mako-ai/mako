/**
 * Allowlisted Parquet COPY options for app binding artifacts.
 *
 * Scope: only app bindings (`buildQueryParquetFile`) read these options. The
 * CDC and sync load paths call `buildParquetFromBatches` without
 * `writeOptions` and keep writing SNAPPY, which their warehouse loaders were
 * built and tested against.
 *
 * Env strings never reach DuckDB SQL: codecs and integers are validated
 * against a closed set, then interpolated from those typed values only.
 *
 * The env is read ONCE. `initAppBindingParquetWriteOptions()` runs at API boot
 * and throws on a typo, so a bad revision never starts serving. Anything that
 * builds without booting the API (scripts, tests) resolves lazily on first
 * use; an invalid value there logs one error and falls back to SNAPPY, which
 * every parquet reader decodes. No build ever throws over the env.
 *
 * Default ZSTD level 3 (DuckDB's own default). On 5 real bindings measured
 * with `scripts/parquet-compression-benchmark.ts`, level 3 is 28-48% smaller
 * than SNAPPY against 26-40% for level 1, at an encode cost within run-to-run
 * noise. Level 9 saves up to 12 points more but adds up to 1 s of encode per
 * build on a 65 MB binding. DuckDB-WASM decode time is flat across levels.
 */
import { loggers } from "../logging";

const logger = loggers.api("parquet-compression");

export const PARQUET_CODECS = ["SNAPPY", "ZSTD"] as const;
export type ParquetCodec = (typeof PARQUET_CODECS)[number];

/** Default for app binding builds. Override with PARQUET_COMPRESSION=SNAPPY. */
export const DEFAULT_PARQUET_CODEC: ParquetCodec = "ZSTD";

/** 1 = fastest, 22 = smallest. See the module comment for why 3. */
export const DEFAULT_PARQUET_ZSTD_LEVEL = 3;
export const MIN_PARQUET_ZSTD_LEVEL = 1;
export const MAX_PARQUET_ZSTD_LEVEL = 22;

/**
 * DuckDB COPY default when ROW_GROUP_SIZE is omitted. Exposed as
 * PARQUET_ROW_GROUP_SIZE only when the operator wants to override it.
 * DuckDB rejects values below its vector size (2048).
 */
export const DEFAULT_PARQUET_ROW_GROUP_SIZE = 122_880;
export const MIN_PARQUET_ROW_GROUP_SIZE = 2_048;

export interface ParquetWriteOptions {
  codec: ParquetCodec;
  /** Only emitted in COPY SQL for ZSTD. */
  zstdLevel: number;
  /** Set only when PARQUET_ROW_GROUP_SIZE is provided. */
  rowGroupSize?: number;
}

/**
 * What the CDC/sync paths write, and the fallback for an invalid env:
 * `(FORMAT PARQUET, COMPRESSION SNAPPY)`, byte-for-byte the SQL they always ran.
 */
export const SNAPPY_WRITE_OPTIONS: Readonly<ParquetWriteOptions> =
  Object.freeze({
    codec: "SNAPPY",
    zstdLevel: DEFAULT_PARQUET_ZSTD_LEVEL,
  });

export interface ParquetWriteMetrics {
  compression: ParquetCodec;
  byteSize: number;
  zstdLevel?: number;
  rowGroupSize?: number;
  encodeDurationMs: number;
}

function parseAllowlistedCodec(raw: string | undefined): ParquetCodec {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PARQUET_CODEC;
  const codec = raw.trim().toUpperCase();
  if (codec === "SNAPPY" || codec === "ZSTD") return codec;
  throw new Error(
    `Invalid PARQUET_COMPRESSION=${JSON.stringify(raw)}. Allowed: ${PARQUET_CODECS.join(", ")}.`,
  );
}

function parseIntegerEnv(
  raw: string | undefined,
  { name, min, max }: { name: string; min: number; max?: number },
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  const parsed = /^-?\d+$/.test(trimmed)
    ? Number.parseInt(trimmed, 10)
    : Number.NaN;
  if (
    Number.isNaN(parsed) ||
    parsed < min ||
    (max !== undefined && parsed > max)
  ) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}. Expected an integer` +
        (max !== undefined ? ` between ${min} and ${max}` : ` >= ${min}`) +
        ".",
    );
  }
  return parsed;
}

/** Strict parse: throws on any invalid value. */
export function resolveParquetWriteOptions(
  env: NodeJS.Dict<string> = process.env,
): ParquetWriteOptions {
  const codec = parseAllowlistedCodec(env.PARQUET_COMPRESSION);
  const zstdLevel =
    parseIntegerEnv(env.PARQUET_ZSTD_LEVEL, {
      name: "PARQUET_ZSTD_LEVEL",
      min: MIN_PARQUET_ZSTD_LEVEL,
      max: MAX_PARQUET_ZSTD_LEVEL,
    }) ?? DEFAULT_PARQUET_ZSTD_LEVEL;
  const rowGroupSize = parseIntegerEnv(env.PARQUET_ROW_GROUP_SIZE, {
    name: "PARQUET_ROW_GROUP_SIZE",
    min: MIN_PARQUET_ROW_GROUP_SIZE,
  });
  return {
    codec,
    zstdLevel,
    ...(rowGroupSize !== undefined ? { rowGroupSize } : {}),
  };
}

let appBindingWriteOptions: ParquetWriteOptions | undefined;

/**
 * Boot-time validation. Throws on an invalid env so the API refuses to start;
 * on success the options are fixed for the life of the process.
 */
export function initAppBindingParquetWriteOptions(
  env: NodeJS.Dict<string> = process.env,
): ParquetWriteOptions {
  appBindingWriteOptions = resolveParquetWriteOptions(env);
  logger.info("App binding parquet write options", {
    ...appBindingWriteOptions,
  });
  return appBindingWriteOptions;
}

/**
 * The options every app binding build writes with. Resolved once; never
 * throws. Without a boot-time init, an invalid env logs one error and builds
 * SNAPPY.
 */
export function appBindingParquetWriteOptions(): ParquetWriteOptions {
  if (appBindingWriteOptions) return appBindingWriteOptions;
  try {
    appBindingWriteOptions = resolveParquetWriteOptions(process.env);
  } catch (error) {
    logger.error(
      "Invalid parquet env; app bindings fall back to SNAPPY for this process",
      { error: error instanceof Error ? error.message : String(error) },
    );
    appBindingWriteOptions = { ...SNAPPY_WRITE_OPTIONS };
  }
  return appBindingWriteOptions;
}

/** Test hook: forget the resolved options. */
export function resetAppBindingParquetWriteOptionsForTest(): void {
  appBindingWriteOptions = undefined;
}

export function escapeDuckDBStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Build a COPY statement from already-validated options. `options.codec` is
 * a typed allowlist member — never pass a raw env string here.
 */
export function buildParquetCopySql(
  parquetPath: string,
  options: ParquetWriteOptions,
): string {
  const parts = [`FORMAT PARQUET`, `COMPRESSION ${options.codec}`];
  if (options.codec === "ZSTD") {
    parts.push(`COMPRESSION_LEVEL ${options.zstdLevel}`);
  }
  if (options.rowGroupSize !== undefined) {
    parts.push(`ROW_GROUP_SIZE ${options.rowGroupSize}`);
  }
  return `COPY _data TO '${escapeDuckDBStringLiteral(parquetPath)}' (${parts.join(", ")})`;
}

/** GCS/S3 object metadata values must be strings. */
export function parquetWriteArtifactMetadata(
  metrics: ParquetWriteMetrics,
): Record<string, string> {
  const metadata: Record<string, string> = {
    parquetCompression: metrics.compression,
    parquetByteSize: String(metrics.byteSize),
    parquetEncodeDurationMs: String(metrics.encodeDurationMs),
  };
  if (metrics.compression === "ZSTD" && metrics.zstdLevel !== undefined) {
    metadata.parquetZstdLevel = String(metrics.zstdLevel);
  }
  if (metrics.rowGroupSize !== undefined) {
    metadata.parquetRowGroupSize = String(metrics.rowGroupSize);
  }
  return metadata;
}
