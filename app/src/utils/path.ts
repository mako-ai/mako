/**
 * Slash-separated path helpers for repo-relative and project-relative paths
 * (dbt files, app files, git changes). Not Node's `path`: there is no
 * platform separator, no ".", and a top-level file has an empty dirname.
 */

/** Last non-empty segment: "models/staging/orders.sql" → "orders.sql". */
export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

/**
 * Everything before the last non-empty segment, "" at the top level:
 * "models/staging/orders.sql" → "models/staging", "orders.sql" → "".
 */
export function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}
