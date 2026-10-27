/**
 * How many rows one parquet artifact may hold.
 *
 * Two numbers, both env-configurable (read ONCE, validated at API boot like
 * the codec in parquet-compression.ts):
 *
 * - PARQUET_ROW_LIMIT: what a binding gets when it declares nothing.
 * - PARQUET_MAX_ROW_LIMIT: the most any binding may ask for with
 *   `-- row_limit: <n>` front matter.
 *
 * Why 2M and 5M (measured 2026-10-27; numbers in the PR that set them):
 * - Server memory stays flat. The builder streams rows into an on-disk
 *   DuckDB file capped at 512 MB of buffer: peak RSS was 430 MB at 0.5M
 *   rows and 570 MB at 5M. The DuckDB file grows instead, and on Cloud Run
 *   /tmp is RAM: 60 MB per 1M narrow rows, 300 MB per 1M rows of a real
 *   43-column binding.
 * - Build time grows linearly. Prod builds run at 250-500 us per row on
 *   one vCPU, so 5M rows take 20-40 minutes against the 60-minute request
 *   timeout. 10M would not fit.
 * - The browser holds every binding in DuckDB-WASM, which stops at 3.1 GB
 *   per page. A 43-column binding costs about 950 bytes per row there (3.2M
 *   rows loaded, 4.1M ran out of memory); a 14-column one about 180 bytes
 *   (10M rows loaded in 3.5 s, 1.7 GB).
 */
import { loggers } from "../logging";

const logger = loggers.api("parquet-row-limit");

/** Rows a binding may hold when it declares no `-- row_limit:`. */
export const DEFAULT_PARQUET_ROW_LIMIT = 2_000_000;

/** The most any binding may declare. */
export const DEFAULT_PARQUET_MAX_ROW_LIMIT = 5_000_000;

export interface ParquetRowLimits {
  /** Applied when a binding declares nothing. */
  defaultRowLimit: number;
  /** Hard ceiling on what a binding may declare. */
  maxRowLimit: number;
}

/**
 * A row count as people write it: `2000000`, `2_000_000`, `2,000,000`,
 * `500k`, `2M`, `2.5m`. Null for anything else, zero and negatives included.
 */
export function parseRowCount(raw: string): number | null {
  const m = raw
    .trim()
    .replace(/[_,]/g, "")
    .match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!m) return null;
  const scale = m[2] === "" ? 1 : m[2].toLowerCase() === "k" ? 1e3 : 1e6;
  const n = Number(m[1]) * scale;
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function parseLimitEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = parseRowCount(raw);
  if (n === null) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}. Expected a positive row count such as 2000000 or 2M.`,
    );
  }
  return n;
}

/** Strict parse: throws on any invalid value. */
export function resolveParquetRowLimits(
  env: NodeJS.Dict<string> = process.env,
): ParquetRowLimits {
  const maxRowLimit = parseLimitEnv(
    env.PARQUET_MAX_ROW_LIMIT,
    "PARQUET_MAX_ROW_LIMIT",
    DEFAULT_PARQUET_MAX_ROW_LIMIT,
  );
  const defaultRowLimit = parseLimitEnv(
    env.PARQUET_ROW_LIMIT,
    "PARQUET_ROW_LIMIT",
    Math.min(DEFAULT_PARQUET_ROW_LIMIT, maxRowLimit),
  );
  if (defaultRowLimit > maxRowLimit) {
    throw new Error(
      `PARQUET_ROW_LIMIT (${fmtRows(defaultRowLimit)}) is above PARQUET_MAX_ROW_LIMIT (${fmtRows(maxRowLimit)}).`,
    );
  }
  return { defaultRowLimit, maxRowLimit };
}

let limits: ParquetRowLimits | undefined;

/**
 * Boot-time validation. Throws on an invalid env so the API refuses to start;
 * on success the limits are fixed for the life of the process.
 */
export function initParquetRowLimits(
  env: NodeJS.Dict<string> = process.env,
): ParquetRowLimits {
  limits = resolveParquetRowLimits(env);
  logger.info("Parquet row limits", { ...limits });
  return limits;
}

/**
 * The limits every binding build applies. Resolved once; never throws.
 * Without a boot-time init, an invalid env logs one error and the built-in
 * defaults apply.
 */
export function parquetRowLimits(): ParquetRowLimits {
  if (limits) return limits;
  try {
    limits = resolveParquetRowLimits(process.env);
  } catch (error) {
    logger.error("Invalid parquet row limit env; using the defaults", {
      error: error instanceof Error ? error.message : String(error),
    });
    limits = {
      defaultRowLimit: DEFAULT_PARQUET_ROW_LIMIT,
      maxRowLimit: DEFAULT_PARQUET_MAX_ROW_LIMIT,
    };
  }
  return limits;
}

/** Test hook: forget the resolved limits. */
export function resetParquetRowLimitsForTest(): void {
  limits = undefined;
}

export function fmtRows(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The row limit of one binding from its `-- row_limit:` front matter.
 * Absent = the default. Throws, naming the binding, on a value that is not a
 * row count or is above the maximum: the build fails and says so, rather
 * than quietly applying some other number.
 */
export function resolveBindingRowLimit(
  bindingName: string,
  declared: string | undefined,
  { defaultRowLimit, maxRowLimit }: ParquetRowLimits = parquetRowLimits(),
): number {
  if (declared === undefined || declared.trim() === "") return defaultRowLimit;
  const n = parseRowCount(declared);
  if (n === null) {
    throw new Error(
      `Binding "${bindingName}" has an invalid "-- row_limit: ${declared}". ` +
        `Write a positive row count such as 3000000 or 3M (at most ${fmtRows(maxRowLimit)}).`,
    );
  }
  if (n > maxRowLimit) {
    throw new Error(
      `Binding "${bindingName}" asks for "-- row_limit: ${declared}" (${fmtRows(n)} rows), ` +
        `above the ${fmtRows(maxRowLimit)}-row maximum for one binding. ` +
        `Aggregate the query, or shard it into several bindings (for example one per year or country).`,
    );
  }
  return n;
}

/**
 * A `-- row_limit:` worth suggesting for a binding that returned `rowCount`
 * rows: 25% headroom, rounded up to the next 100k, never above the maximum.
 */
export function suggestedRowLimit(
  rowCount: number,
  maxRowLimit: number,
): number {
  const withHeadroom = Math.ceil((rowCount * 1.25) / 100_000) * 100_000;
  return Math.min(withHeadroom, maxRowLimit);
}

/**
 * The message for a binding whose query returned more rows than its limit:
 * its name, how many rows it returned, and what to do about it.
 */
export function bindingRowLimitMessage(input: {
  bindingName: string;
  rowLimit: number;
  /** Rows the query returned, or at least returned when not `exact`. */
  rowCount: number;
  /** False when counting stopped at `maxRowLimit`. */
  exact: boolean;
  maxRowLimit: number;
}): string {
  const { bindingName, rowLimit, rowCount, exact, maxRowLimit } = input;
  const file = `bindings/${bindingName}.sql`;
  const kept =
    "Nothing was stored, so the app keeps serving the previous build.";
  const shard =
    "aggregate the query, or shard it into several bindings (for example one per year or country)";
  if (!exact || rowCount > maxRowLimit) {
    return (
      `Binding "${bindingName}" returned more than ${fmtRows(rowCount)} rows, ` +
      `above the ${fmtRows(maxRowLimit)}-row maximum for one binding. ${kept} ` +
      `To fix it, ${shard}.`
    );
  }
  const suggestion = suggestedRowLimit(rowCount, maxRowLimit);
  return (
    `Binding "${bindingName}" returned ${fmtRows(rowCount)} rows, over its row limit of ` +
    `${fmtRows(rowLimit)}. ${kept} To raise the limit, add "-- row_limit: ${suggestion}" ` +
    `to the front matter of ${file} (at most ${fmtRows(maxRowLimit)}). Or ${shard}.`
  );
}
