/**
 * Pure artifact-addressing helpers for app data bindings.
 *
 * Deliberately free of side-effecting imports (no DB, storage client, or
 * Inngest) so the key/URL shapes — including the per-dbt-environment preview
 * artifacts — can be unit tested without booting the module graph. The
 * storage prefix is passed in by `app-binding-materialization.service`, which
 * owns the wiring.
 */

/** How long without a heartbeat before a build is treated as dead. */
export const BUILD_STALE_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * dbt environment names are authored by users in project settings, but we
 * interpolate them into artifact storage keys AND MongoDB update paths
 * (`dataBindings.$.cache.environments.<env>.status`). Restrict them to a safe
 * identifier so a name can never traverse a storage prefix or create nested
 * Mongo paths. Throws — callers surface this as a 400.
 */
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertSafeEnvironmentName(environment: string): void {
  if (!SAFE_ENVIRONMENT_NAME.test(environment)) {
    throw new Error(
      `Unsupported dbt environment name "${environment}" — environment ` +
        `artifacts require a name of letters, digits, "_" or "-".`,
    );
  }
}

/** Mongo update path for one field of a binding's environment artifact. */
export function envCachePath(environment: string, field: string): string {
  return `dataBindings.$.cache.environments.${environment}.${field}`;
}

/**
 * Storage key for a binding's Parquet artifact. Prod keeps the historical
 * un-namespaced key; an environment build gets its own `/<env>/` segment so a
 * dev/staging preview can never overwrite the prod artifact.
 */
export function buildAppBindingArtifactKeyWithPrefix(input: {
  prefix: string;
  workspaceId: string;
  appId: string;
  bindingId: string;
  definitionHash: string;
  environment?: string;
}): string {
  const env = input.environment ? `/${input.environment}` : "";
  return `${input.prefix}/workspaces/${input.workspaceId}/apps/${input.appId}/bindings/${input.bindingId}${env}/${input.definitionHash}.parquet`;
}

/**
 * Proxied API path the browser fetches to read a binding's Parquet artifact.
 * The environment (when set) is a QUERY parameter, matching the serve route —
 * the path itself is the same for every environment.
 */
export function buildAppBindingArtifactPath(input: {
  workspaceId: string;
  appId: string;
  bindingId: string;
  revision?: string | null;
  environment?: string;
}): string {
  const base = `/api/workspaces/${input.workspaceId}/apps/${input.appId}/bindings/${input.bindingId}/materialization/artifact`;
  const params = new URLSearchParams();
  if (input.revision) params.set("rev", input.revision);
  if (input.environment) params.set("env", input.environment);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Whether an environment artifact's build is in flight (fresh heartbeat). */
export function isEnvironmentBuildActive(
  artifact:
    | { status?: string | null; statusAt?: Date | string | null }
    | undefined,
): boolean {
  if (artifact?.status !== "queued" && artifact?.status !== "building") {
    return false;
  }
  const at = artifact.statusAt ? new Date(artifact.statusAt).getTime() : 0;
  return Date.now() - at < BUILD_STALE_THRESHOLD_MS;
}

/**
 * Hydrate `cache.parquetUrl` for every ready, materialized binding on a
 * serialized app object — including each ready per-environment artifact
 * (`cache.environments[env].parquetUrl`). Pure (string building) — no store
 * calls.
 */
export function hydrateAppBindingUrls(app: {
  _id: string;
  workspaceId: string;
  dataBindings?: Array<Record<string, any>>;
}): typeof app {
  if (!Array.isArray(app.dataBindings)) return app;
  for (const binding of app.dataBindings) {
    const cache = binding.cache;
    if (cache?.parquetArtifactKey && cache.parquetBuildStatus === "ready") {
      cache.parquetUrl = buildAppBindingArtifactPath({
        workspaceId: app.workspaceId,
        appId: app._id,
        bindingId: binding.id,
        revision: cache.artifactRevision || undefined,
      });
    }
    const environments = cache?.environments as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!environments) continue;
    for (const [envName, artifact] of Object.entries(environments)) {
      if (artifact?.artifactKey && artifact.status === "ready") {
        artifact.parquetUrl = buildAppBindingArtifactPath({
          workspaceId: app.workspaceId,
          appId: app._id,
          bindingId: binding.id,
          revision: (artifact.artifactRevision as string) || undefined,
          environment: envName,
        });
      }
    }
  }
  return app;
}
