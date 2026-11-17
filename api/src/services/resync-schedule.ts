/**
 * A resync schedule (`backfillSchedule`) runs first at its next cron tick
 * after it is set or changed, never at once.
 *
 * The CDC backfill scheduler fires a schedule when its next occurrence after
 * `backfillSchedule.lastRunAt` has passed, and at once when `lastRunAt` is
 * empty (`isCronDue`). A schedule set on a new flow had no `lastRunAt`, and a
 * changed or re-enabled one kept the time of its last run under the old
 * cron: both were overdue the moment they were saved, and a full backfill of
 * every entity started as soon as the flow was idle. On a large Close org
 * that is hours of reads nobody asked for.
 *
 * So every writer of a schedule passes the schedule it had and the one it
 * writes through here: a new, changed or re-enabled schedule counts as
 * having just run.
 */
interface ResyncScheduleTiming {
  enabled?: boolean | null;
  cron?: string | null;
  timezone?: string | null;
  lastRunAt?: Date | null;
}

const tz = (timezone?: string | null) => timezone?.trim() || "UTC";

/** The `lastRunAt` the schedule `after` is saved with. */
export function resyncLastRunAt(
  before: ResyncScheduleTiming | null | undefined,
  after: ResyncScheduleTiming,
  now: Date = new Date(),
): Date | undefined {
  const kept = before?.lastRunAt ?? undefined;
  const cron = after.cron?.trim();
  if (!after.enabled || !cron) return kept;
  const unchanged =
    Boolean(before?.enabled) &&
    before?.cron?.trim() === cron &&
    tz(before?.timezone) === tz(after.timezone);
  return unchanged ? kept : now;
}
