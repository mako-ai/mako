/**
 * Shared helpers for dbt environment badges (jobs list, run history).
 */

/**
 * MUI Chip color for a dbt environment badge. Prod-like envs are flagged
 * `warning` so destructive/scheduled prod runs stand out; the project default
 * and dev-like envs get `info`, everything else stays neutral.
 */
export function envBadgeColor(
  envName: string,
  defaultEnvironment?: string,
): "warning" | "info" | "default" {
  const lower = envName.trim().toLowerCase();
  if (lower === "prod" || lower === "production") return "warning";
  if (
    lower === "dev" ||
    lower === "development" ||
    (defaultEnvironment != null && envName === defaultEnvironment)
  ) {
    return "info";
  }
  return "default";
}
