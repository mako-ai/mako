/**
 * Runtime signal for a MERGE that scanned a partitioned live table with no
 * partition filter. On 17 Nov 2026 two Close shadow flows did this on every
 * MERGE and scanned about 25 times the bytes before anyone noticed. One
 * structured warning per table per hour keeps the log readable.
 */

export type UnprunedMergeReason =
  "layout_mismatch" | "too_many_partitions" | "no_probe";

/** What a MERGE without a partition filter knows about the table. */
export interface UnprunedMerge {
  reason: UnprunedMergeReason;
  /** The table's real partition column and granularity. */
  tableField: string;
  tableGranularity?: string;
  layoutField?: string;
  layoutGranularity?: string;
  detail?: string;
  partitions?: number;
  maxPartitions?: number;
}

/** One warning per table per hour. */
export const UNPRUNED_MERGE_WARN_INTERVAL_MS = 60 * 60 * 1000;

const lastWarnedAt = new Map<string, number>();

/**
 * True when this table has not warned within the last hour, and records the
 * warning. Call it once per unpruned MERGE, log only when it returns true.
 */
export function claimUnprunedMergeWarning(
  tableKey: string,
  now: number = Date.now(),
): boolean {
  const last = lastWarnedAt.get(tableKey);
  if (last !== undefined && now - last < UNPRUNED_MERGE_WARN_INTERVAL_MS) {
    return false;
  }
  lastWarnedAt.set(tableKey, now);
  return true;
}

/** Test seam. */
export function resetUnprunedMergeWarnings(): void {
  lastWarnedAt.clear();
}
