/**
 * Relative-time labels ("5 min ago") in one place. Two styles, both
 * past-only and both rendering "just now" under a minute:
 *
 * - `formatRelativeTime` — spelled-out units for prose-like labels:
 *   "5 min ago", "3 hr ago", "2 days ago", "3 months ago", "1 year ago".
 * - `formatRelativeTimeCompact` — single-letter units for dense tables and
 *   chips: "5m ago", "3h ago", "2d ago".
 */

/** Anything the UI holds a timestamp as: ISO string, epoch ms, or Date. */
export type DateInput = string | number | Date | null | undefined;

/** Parse a `DateInput`; `null` when absent or unparseable. */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/**
 * Spelled-out relative time for data freshness and "last used" labels.
 * `null` when the input is absent or invalid so callers can substitute
 * their own placeholder ("Never", "unknown").
 */
export function formatRelativeTime(value: DateInput): string | null {
  const date = toDate(value);
  if (!date) return null;
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hr ago`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return plural(diffDays, "day");
  const diffMonths = Math.round(diffDays / 30);
  if (diffMonths < 12) return plural(diffMonths, "month");
  return plural(Math.round(diffDays / 365), "year");
}

export interface CompactRelativeTimeOptions {
  /** Rendered when the input is absent or invalid. Default "—". */
  empty?: string;
  /**
   * Past this many days, render a short absolute date ("Mar 4", or "Mar 4,
   * 2025" outside the current year) instead of "40d ago".
   */
  absoluteAfterDays?: number;
}

/** Compact relative time for tables and chips: "5m ago", "3h ago", "2d ago". */
export function formatRelativeTimeCompact(
  value: DateInput,
  options: CompactRelativeTimeOptions = {},
): string {
  const date = toDate(value);
  if (!date) return options.empty ?? "—";
  const now = Date.now();
  const minutes = Math.floor((now - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (
    options.absoluteAfterDays !== undefined &&
    days >= options.absoluteAfterDays
  ) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year:
        date.getFullYear() !== new Date(now).getFullYear()
          ? "numeric"
          : undefined,
    });
  }
  return `${days}d ago`;
}
