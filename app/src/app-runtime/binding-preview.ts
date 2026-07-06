/**
 * dbt preview-environment support for materialized (parquet) app bindings.
 *
 * Parquet artifacts ALWAYS hold prod data (materialization resolves
 * `{{ dbt_schema }}` against the prod-like environment server-side). When an
 * editor activates a preview env override, dbt-linked parquet bindings must
 * not read those prod artifacts: this module executes the binding live
 * (row-capped) against the override schema and loads the rows into the app's
 * DuckDB table under the same name, so BOTH read paths — `useQuery` and
 * `useDuckDB` / `query_duckdb` — see the preview data. The prod artifact is
 * never rebuilt or touched; resetting the override reloads the parquet
 * snapshot (the table revision encodes the override).
 */

import { containsDbtSchemaToken, type AppDataBinding } from "@mako/schemas";
import { useAppStore, prodLikeDbtEnvironment } from "../store/appStore";
import { ensureBindingLoaded, loadBindingRowsTable } from "./duckdb";

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
 * Ensure a parquet binding's DuckDB table holds the data the CURRENT preview
 * environment should see: the prod Parquet artifact by default, or a live
 * (row-capped) execution against the override schema while a dbt preview env
 * override is active. Returns false when the table could not be loaded (e.g.
 * artifact not built yet).
 */
export async function ensureBindingLoadedForPreview(
  workspaceId: string,
  appId: string,
  binding: AppDataBinding,
  signal?: AbortSignal,
): Promise<boolean> {
  if (binding.materialization !== "parquet") return false;

  const override = await getBindingPreviewOverride(workspaceId, appId, binding);
  if (!override) return ensureBindingLoaded(appId, binding, signal);

  return loadBindingRowsTable(
    appId,
    binding,
    `dbt-preview:${override.environment}`,
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
