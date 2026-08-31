/**
 * The one "is this cron due?" predicate.
 *
 * Every scheduler scan in the codebase asks the same question — has the
 * schedule's next occurrence after the last run already passed? — and it
 * used to be answered four ways: dashboard materialization had it right,
 * app bindings borrowed that, and the flow scheduler + CDC backfill each
 * hand-rolled their own (the flow one as three competing heuristics that
 * are provably equivalent to this predicate). Answer it here, once.
 *
 * Semantics:
 * - no/blank cron        → never due
 * - never ran            → due now (the first occurrence is owed)
 * - otherwise            → due iff next occurrence after `lastRunAt` ≤ `now`
 *
 * An invalid cron or timezone THROWS (from cron-parser) — callers decide
 * whether that skips the item (scanners log-and-continue) or surfaces
 * (validation paths).
 */
import { CronExpressionParser } from "cron-parser";

export interface CronDueInput {
  cron?: string | null;
  timezone?: string | null;
  lastRunAt?: Date | null;
  now?: Date;
}

/** Next occurrence strictly after `from`. Throws on an invalid cron/tz. */
export function nextCronRunAt(
  cron: string,
  options?: { timezone?: string | null; from?: Date },
): Date {
  return CronExpressionParser.parse(cron, {
    currentDate: options?.from ?? new Date(),
    tz: options?.timezone?.trim() || "UTC",
  })
    .next()
    .toDate();
}

export function isCronDue(input: CronDueInput): boolean {
  const cron = input.cron?.trim();
  if (!cron) return false;
  if (!input.lastRunAt) return true;
  const next = nextCronRunAt(cron, {
    timezone: input.timezone,
    from: input.lastRunAt,
  });
  return next.getTime() <= (input.now ?? new Date()).getTime();
}
