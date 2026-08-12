/**
 * CDC backlog / lag helpers.
 *
 * Pending counts must reflect real `materializationStatus: "pending"` rows
 * only. Using `lastIngestSeq - lastMaterializedSeq` as a pending proxy
 * inflates the Stream "X pending" counter after Recover/Reprocess rewinds
 * the cursor under an old orphaned event (seq gap looks like hundreds of
 * thousands of pending rows even when only a few thousand exist).
 *
 * Cursor seq gaps are still useful for the materialize scheduler
 * (`findStaleEntities`); they are not a user-facing pending event count.
 */

export function computeEntityPendingBacklog(pendingCount: number): number {
  return Math.max(0, pendingCount || 0);
}

export function computeEntitySeqGap(
  lastIngestSeq: number,
  lastMaterializedSeq: number,
): number {
  return Math.max(0, (lastIngestSeq || 0) - (lastMaterializedSeq || 0));
}

/**
 * Flow-level lag: age of the oldest real pending event.
 * Returns 0 when nothing is pending (seq gap alone must not invent lag).
 */
export function computePendingLagSeconds(params: {
  pendingCount: number;
  oldestPendingTs: Date | null | undefined;
  nowMs?: number;
}): number {
  if ((params.pendingCount || 0) <= 0 || !params.oldestPendingTs) {
    return 0;
  }
  const now = params.nowMs ?? Date.now();
  return Math.max(
    0,
    Math.floor((now - params.oldestPendingTs.getTime()) / 1000),
  );
}
