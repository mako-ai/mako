/**
 * Incremental-sync helpers: date arithmetic for windowed walks and the one
 * correct client-side `since` filter.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` (UTC) — the date-only form most list filters take. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The ISO timestamp `days` after `iso` (negative goes back). */
export function addDaysIso(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

/** End of a window of `days` from `start`, never past `cap`. */
export function windowEnd(start: Date, days: number, cap: Date): Date {
  return new Date(Math.min(start.getTime() + days * DAY_MS, cap.getTime()));
}

/**
 * Keep the records whose string timestamp `field` is at or after `since`.
 * Records without a parseable timestamp are DROPPED: keeping them would
 * silently turn every incremental poll into a full re-pull of undated rows
 * (see .cursor/rules/15-connector-agnostic.mdc, "Incremental poll honesty").
 */
export function filterRecordsSince<T extends Record<string, unknown>>(
  records: T[],
  since: Date,
  field: string,
): T[] {
  const sinceMs = since.getTime();
  return records.filter(record => {
    const value = record[field];
    const ts = typeof value === "string" ? new Date(value).getTime() : NaN;
    return Number.isFinite(ts) ? ts >= sinceMs : false;
  });
}
