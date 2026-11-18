/**
 * The `since` of an incremental CDC poll — which source changes a scheduled
 * poll re-reads.
 *
 * It used to be MAX(_syncedAt) of the destination live table. `_syncedAt` is
 * Mako's wall-clock write time, and webhooks write the same live table, so:
 *
 * 1. A webhook write at T moved the next poll's cursor to T. A source change
 *    before T that the webhook missed was never read again (PL Close calls
 *    updated 14:13–14:58 on 2026-11-17 were skipped by three hourly polls).
 * 2. A record updated during a poll, after its page was read, was skipped:
 *    the cursor jumped to the end of the run.
 *
 * Anchoring on MAX(_mako_source_ts) alone fixes neither: a webhook row
 * carries the source's update time too, so it still advances that maximum.
 * The cursor therefore belongs to the poll, never to the destination:
 *
 * - When a poll completes an entity, it stamps the START of its run on the
 *   entity's CdcEntityState (`lastPollRunStartedAt`, only ever moved forward).
 *   Every source change before that start was readable when the run read it.
 *   Webhook writes never touch this field.
 * - A completed backfill run start (`lastBackfillRunStartedAt`) is the same
 *   guarantee, so the later of the two anchors the next poll.
 * - `since = anchor - overlap` (default 10 min, `CDC_POLL_CURSOR_OVERLAP_MINUTES`)
 *   covers clock skew between Mako and the source and source-side index lag.
 *   The CDC merge is keyed and newer-source-ts-wins, so the overlap re-read
 *   updates rows in place and writes no duplicates.
 * - With no stamp on record (first poll after the stamps shipped, or after
 *   a resync wiped the entity state), the start of the flow's last
 *   successful run that synced this entity (`flow_executions`) anchors the
 *   poll. That run read every change before its start, and webhooks never
 *   write a flow execution.
 * - With no such run either, the destination is the last resort:
 *   MAX(_mako_source_ts) - overlap, else MAX(_syncedAt) - overlap with a
 *   warning. Webhook rows advance that maximum, so a change a webhook never
 *   delivered can fall before it. ES Stripe on 2026-11-18: the 04:01 poll
 *   was the first after the stamps shipped, charges had no stamp, the
 *   newest webhook charge was created 00:02, so `since` was 23:52 and two
 *   pending SEPA charges created at 18:54 and 19:45 were never read.
 *
 * Connector STATE does not compete with this: FetchState lives for one run
 * (backfill checkpoints aside), and a boxed connector receives `since` as
 * `state.mako.since` at the start of every run (SandboxedConnector.readState).
 */

export const DEFAULT_POLL_OVERLAP_MS = 10 * 60 * 1000; // 10 min

/** `CDC_POLL_CURSOR_OVERLAP_MINUTES` overrides the 10-minute overlap. */
export function pollOverlapMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CDC_POLL_CURSOR_OVERLAP_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_POLL_OVERLAP_MS;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes >= 0
    ? minutes * 60 * 1000
    : DEFAULT_POLL_OVERLAP_MS;
}

export function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type PollSinceDecision = {
  since: Date;
  anchor: Date;
  anchorKind: "poll" | "backfill" | "run";
} | null;

/**
 * The poll-owned anchor: the later of the last completed poll run start and
 * the last completed backfill run start, minus the overlap. Without either
 * stamp, the start of the flow's last successful run that synced the entity.
 * A stamp later than this run's own start (clock trouble, manual edits) is
 * ignored. null = nothing on record; the caller falls back to the
 * destination.
 */
export function decidePollSince(input: {
  lastPollRunStartedAt?: Date | string | null;
  lastBackfillRunStartedAt?: Date | string | null;
  /** The flow's last successful run that synced this entity (its start). */
  lastSuccessfulRunStartedAt?: Date | string | null;
  runStartedAt?: Date | string | null;
  overlapMs: number;
}): PollSinceDecision {
  const runStartedAt = toDate(input.runStartedAt);
  const usable = (d: Date | null) =>
    d && (!runStartedAt || d.getTime() <= runStartedAt.getTime()) ? d : null;
  const poll = usable(toDate(input.lastPollRunStartedAt));
  const backfill = usable(toDate(input.lastBackfillRunStartedAt));
  if (!poll && !backfill) {
    const run = usable(toDate(input.lastSuccessfulRunStartedAt));
    if (
      !run ||
      (runStartedAt && run.getTime() >= runStartedAt.getTime()) // this run
    ) {
      return null;
    }
    return {
      since: new Date(run.getTime() - input.overlapMs),
      anchor: run,
      anchorKind: "run",
    };
  }
  const anchorKind: "poll" | "backfill" =
    poll && (!backfill || poll.getTime() >= backfill.getTime())
      ? "poll"
      : "backfill";
  const anchor = (anchorKind === "poll" ? poll : backfill) as Date;
  return {
    since: new Date(anchor.getTime() - input.overlapMs),
    anchor,
    anchorKind,
  };
}

/**
 * Fallback when no poll or backfill stamp exists: the destination's newest
 * source timestamp, else its newest write time, minus the overlap.
 */
export function destinationFallbackSince(input: {
  maxSourceTs?: Date | string | null;
  maxSyncedAt?: Date | string | null;
  overlapMs: number;
}): { since: Date; column: "_mako_source_ts" | "_syncedAt" } | null {
  const sourceTs = toDate(input.maxSourceTs);
  if (sourceTs) {
    return {
      since: new Date(sourceTs.getTime() - input.overlapMs),
      column: "_mako_source_ts",
    };
  }
  const syncedAt = toDate(input.maxSyncedAt);
  if (syncedAt) {
    return {
      since: new Date(syncedAt.getTime() - input.overlapMs),
      column: "_syncedAt",
    };
  }
  return null;
}
