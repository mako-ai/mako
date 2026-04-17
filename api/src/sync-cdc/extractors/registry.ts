import type {
  IDatabaseConnection,
  IIncrementalConfig,
} from "../../database/workspace-schema";
import { BigQueryBulkExtractor } from "./bigquery";

export type BulkLogLevel = "info" | "debug" | "warn";

export type BulkLogFn = (
  level: BulkLogLevel,
  message: string,
  data?: Record<string, unknown>,
) => void;

/**
 * A unit of bulk work. Each slice becomes its own Inngest `step.run`, which
 * means Inngest memoizes completed slices — if a container dies mid-run, only
 * the in-progress slice re-runs and already-loaded slices are skipped.
 *
 * Shape matches Airbyte's `stream_slices()` model: the extractor decides how
 * to partition work, orchestration just iterates.
 */
export interface BulkSlice {
  /** Stable id; used verbatim as the Inngest step id for memoization. */
  id: string;
  /** Human-readable label for UI logs (e.g. "2024-03-18 → 2024-03-25"). */
  label: string;
  /** Inclusive lower bound on the tracking column; absent = no lower bound. */
  rangeStart?: string | number | null;
  /** Exclusive upper bound on the tracking column; absent = no upper bound. */
  rangeEnd?: string | number | null;
  /** Optional estimate used for logging / capacity hints. */
  estimatedRows?: number;
}

export interface BulkExtraction {
  rows: AsyncIterable<Record<string, unknown>>;
  totalRows?: number;
  maxTrackingValue?: string | null;
  cleanup: () => Promise<void>;
}

export interface BulkExtractor {
  /**
   * Partition the total work into one or more slices. Each slice will be
   * extracted + loaded as a separate Inngest step.
   *
   * Contract:
   *   - Incremental syncs and small datasets SHOULD return a single slice
   *     with no range bounds (behaves like a whole-table read).
   *   - Large backfills SHOULD subdivide along the tracking column so that
   *     any single slice fits comfortably in memory.
   *   - Called inside its own `step.run`, so side effects are fine but the
   *     call should be cheap (one or two metadata queries, no row scans).
   */
  plan(params: {
    connection: IDatabaseConnection;
    query: string;
    syncMode: "full" | "incremental";
    incrementalConfig?: IIncrementalConfig;
    trackingColumn?: string;
    /**
     * "auto" (default): partition when it makes sense.
     * "off": escape hatch — always return a single whole-dataset slice.
     */
    slicing?: "auto" | "off";
    onLog?: BulkLogFn;
  }): Promise<BulkSlice[]>;

  /**
   * Extract rows for a single slice. When `slice.rangeStart`/`rangeEnd` are
   * set, the extractor MUST scope the query to `[rangeStart, rangeEnd)` on
   * the tracking column. Absent bounds = no range filter (whole dataset).
   */
  extract(params: {
    connection: IDatabaseConnection;
    query: string;
    syncMode: "full" | "incremental";
    incrementalConfig?: IIncrementalConfig;
    trackingColumn?: string;
    slice?: BulkSlice;
    onLog?: BulkLogFn;
  }): Promise<BulkExtraction>;
}

export function resolveBulkExtractor(
  sourceType: string,
): BulkExtractor | undefined {
  const normalized = sourceType.toLowerCase();
  switch (normalized) {
    case "bigquery":
      return new BigQueryBulkExtractor();
    default:
      return undefined;
  }
}
