/**
 * Shared helpers for dbt environment badges (jobs list, run history) and
 * prod-like environment resolution.
 */

/**
 * The environment treated as "production" (the defer target). Mirrors the
 * server's resolveProdLikeEnvironmentName: an explicit `prodEnvironment`
 * setting wins when it still exists, else the env literally named "prod",
 * else the project default.
 */
export function resolveProdLikeEnvName(project: {
  environments?: Array<{ name: string }>;
  defaultEnvironment?: string;
  prodEnvironment?: string;
}): string | undefined {
  const environments = project.environments ?? [];
  if (
    project.prodEnvironment &&
    environments.some(env => env.name === project.prodEnvironment)
  ) {
    return project.prodEnvironment;
  }
  if (environments.some(env => env.name === "prod")) return "prod";
  return project.defaultEnvironment;
}

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
