/**
 * Human-readable number formatting shared across the UI. One definition each
 * so a duration reads the same in a dbt run card, a console execution row and
 * a run-history table.
 */

/**
 * Elapsed time: "450ms", "1.5s", "2m 5s". Missing, non-finite or negative
 * input renders as "—" (an em dash), never as an empty string, so the label
 * stays visible in a table cell.
 */
export function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  // Round to whole seconds first so 119.6s reads "2m 0s", not "1m 60s".
  const totalSeconds = Math.round(seconds);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * Binary-scaled size with one decimal above bytes: "512 B", "1.5 KB",
 * "12.0 MB", "3.8 GB". Non-finite or negative input renders as "—".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}
