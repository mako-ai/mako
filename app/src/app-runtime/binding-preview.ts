/**
 * dbt preview-environment support for materialized (parquet) app bindings.
 *
 * By default, parquet artifacts hold prod data (materialization resolves
 * `{{ dbt_schema }}` against the prod-like environment server-side). When an
 * editor activates a preview env override, dbt-linked parquet bindings
 * prioritize environment-specific artifacts:
 *
 * 1. If an env-specific artifact is ready, load it (full-fidelity data)
 * 2. Otherwise, execute live (row-capped) against the override schema
 * 3. If no override, load the prod artifact as always
 *
 * The table revision encodes the source (artifact environment or live preview),
 * allowing resetting the override to reload the correct data.
 */

import { containsDbtSchemaToken, type AppDataBinding } from "@mako/schemas";
import { useAppStore, prodLikeDbtEnvironment } from "../store/appStore";
import {
  ensureBindingLoaded,
  loadBindingRowsTable,
  dropBindingTableByRevisionPrefix,
  loadEnvironmentArtifact,
  ENV_ARTIFACT_REVISION_PREFIX,
} from "./duckdb";

/**
 * Revision prefix for DuckDB tables loaded from a live preview-env run
 * (`dbt-preview:<env>`) rather than the prod Parquet artifact. Marks the
 * table as override data so resetting the override can evict it when no prod
 * artifact is available to reload.
 */
const DBT_PREVIEW_REVISION_PREFIX = "dbt-preview:";

/**
 * The active preview env override for a binding, or null when the binding
 * reads prod (no override set, override invalid, or binding not dbt-linked).
 */
export async function getBindingPreviewOverride(
  workspaceId: string,
  appId: string,
  binding: AppDataBinding,
): Promise<{ environment: string } | null> {
  if (!binding.dbtProjectId || !containsDbtSchemaToken(binding.code)) {
    return null;
  }
  const store = useAppStore.getState();
  const override = store.previewDbtEnv[appId];
  if (!override) return null;
  const info = await store.fetchDbtEnvInfo(workspaceId, binding.dbtProjectId);
  if (!info || !info.environments.some(env => env.name === override)) {
    return null;
  }
  if (override === prodLikeDbtEnvironment(info)) return null;
  return { environment: override };
}

/**
 * The ready per-environment artifact for a binding, or null when none has
 * been built (or its build failed) — in which case the caller runs the query
 * live instead.
 */
function getEnvironmentArtifactInfo(
  appId: string,
  binding: AppDataBinding,
  environment: string,
): { url: string; revision: string } | null {
  const app = useAppStore.getState().openApps[appId];
  const artifact = app?.dataBindings.find(b => b.id === binding.id)?.cache
    ?.environments?.[environment];
  if (artifact?.status !== "ready" || !artifact.parquetUrl) return null;
  return {
    url: artifact.parquetUrl,
    revision: artifact.artifactRevision || artifact.definitionHash || "",
  };
}

/**
 * Ensure a parquet binding's DuckDB table holds the data the CURRENT preview
 * environment should see:
 *
 * 1. If no override: load the prod artifact (existing behavior)
 * 2. If override + env artifact ready: load the environment artifact
 * 3. If override + env artifact not ready: execute live (row-capped)
 *
 * Returns false when the table could not be loaded.
 */
export async function ensureBindingLoadedForPreview(
  workspaceId: string,
  appId: string,
  binding: AppDataBinding,
  signal?: AbortSignal,
): Promise<boolean> {
  if (binding.materialization !== "parquet") return false;

  const override = await getBindingPreviewOverride(workspaceId, appId, binding);
  if (!override) {
    const loaded = await ensureBindingLoaded(appId, binding, signal);
    if (!loaded) {
      // No ready prod artifact to reload (never materialized / build failed):
      // evict rows a previous override left behind — from either a live run
      // or an environment artifact — so prod reads fail loudly instead of
      // silently serving another environment's data.
      await dropBindingTableByRevisionPrefix(
        appId,
        binding.name,
        DBT_PREVIEW_REVISION_PREFIX,
      );
      await dropBindingTableByRevisionPrefix(
        appId,
        binding.name,
        ENV_ARTIFACT_REVISION_PREFIX,
      );
    }
    return loaded;
  }

  // Prefer environment-specific artifact if ready
  const envArtifact = getEnvironmentArtifactInfo(
    appId,
    binding,
    override.environment,
  );
  if (envArtifact) {
    try {
      return await loadEnvironmentArtifact(
        appId,
        binding,
        override.environment,
        envArtifact.url,
        envArtifact.revision,
        signal,
      );
    } catch (error) {
      console.warn(
        `Failed to load environment artifact for "${binding.name}" (${override.environment}):`,
        error,
      );
      // Fall through to live query on error
    }
  }

  // Fall back to live query (row-capped)
  return loadBindingRowsTable(
    appId,
    binding,
    `${DBT_PREVIEW_REVISION_PREFIX}${override.environment}`,
    async () => {
      const result = await useAppStore
        .getState()
        .runBinding(workspaceId, appId, binding.name);
      if (!result.success) {
        throw new Error(
          result.error ||
            `Failed to run "${binding.name}" against the preview environment`,
        );
      }
      return (result.rows ?? []) as Record<string, unknown>[];
    },
  );
}
