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
 * The environment a user's ad-hoc work targets by default — mirrors the
 * server's resolveDevEnvironmentForUser:
 *   saved per-user choice (`myDevEnvironment`) > the user's personal
 *   environment > the project default.
 * Single player: the shared dev default IS the personal target; teams: each
 * user's own environment keeps builds out of teammates' schemas.
 */
export function resolveDevEnvName(
  project: {
    environments?: Array<{ name: string; ownerUserId?: string }>;
    defaultEnvironment?: string;
    myDevEnvironment?: string;
  },
  userId: string | undefined,
): string | undefined {
  const environments = project.environments ?? [];
  if (
    project.myDevEnvironment &&
    environments.some(env => env.name === project.myDevEnvironment)
  ) {
    return project.myDevEnvironment;
  }
  const personal = userId
    ? environments.find(env => env.ownerUserId === userId)
    : undefined;
  return personal?.name ?? project.defaultEnvironment;
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
