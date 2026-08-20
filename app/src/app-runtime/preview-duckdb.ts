/**
 * Shared DuckDB bridge for token-authorized app viewers.
 *
 * The public share page (/share/:token) and the draft preview page
 * (/preview/:token) both render apps outside the editor: bindings arrive as
 * content descriptors with a tokenized parquet `artifactUrl` when
 * materialized. This module owns the shared legs so the two pages cannot
 * drift: adapting those descriptors into loadable bindings, hydrating ready
 * artifacts into the page's DuckDB instance, and answering the sandbox's
 * `mako-app:run-duckdb` requests.
 */
import type { AppDataBinding } from "@mako/schemas";

import {
  applySandboxRowLimit,
  checkSandboxDuckDbSql,
  ensureBindingLoaded,
  queryAppDuckDB,
  resolveSandboxRowLimit,
} from "./duckdb";
import { PREVIEW_MESSAGE } from "./preview";

/** Binding descriptor served by the share / preview content endpoints. */
export interface TokenViewerBinding {
  id: string;
  name: string;
  materialization: "live" | "parquet";
  ready: boolean;
  rowCount: number | null;
  materializedAt: string | null;
  artifactUrl: string | null;
}

/** Adapt a content-endpoint binding to the shape the DuckDB loader expects. */
export function toLoadableBinding(
  binding: TokenViewerBinding,
): AppDataBinding | null {
  if (!binding.ready || !binding.artifactUrl) return null;
  return {
    id: binding.id,
    name: binding.name,
    connectionId: "",
    language: "sql",
    code: "",
    materialization: "parquet",
    cache: {
      parquetUrl: binding.artifactUrl,
      parquetBuildStatus: "ready",
      artifactRevision: binding.materializedAt || binding.id,
    },
  } as AppDataBinding;
}

/**
 * (Re)load every ready parquet binding into the page's DuckDB instance.
 * ensureBindingLoaded is revision-cached (no-op when unchanged) and reloads
 * in place when a new snapshot is ready, so bindings mid-rematerialization
 * keep their previously-loaded table instead of being dropped.
 */
export function hydrateReadyBindings(
  duckAppId: string,
  bindings: TokenViewerBinding[],
): void {
  for (const binding of bindings) {
    const loadable = toLoadableBinding(binding);
    if (loadable) {
      void ensureBindingLoaded(duckAppId, loadable).catch(() => {
        /* surfaced when the app actually queries it */
      });
    }
  }
}

/**
 * Answer one sandbox `run-duckdb` request: safety-check the SQL, lazily
 * ensure every ready artifact is loaded, run, row-cap, and post the result
 * back into the iframe.
 */
export function serveSandboxDuckDbRequest(args: {
  duckAppId: string;
  bindings: TokenViewerBinding[];
  requestId: unknown;
  sql: unknown;
  rowLimit: unknown;
  post: (message: Record<string, unknown>) => void;
}): void {
  const { duckAppId, bindings, requestId, post } = args;
  const safety = checkSandboxDuckDbSql(String(args.sql ?? ""));
  if (!safety.ok) {
    post({
      type: PREVIEW_MESSAGE.duckDbResult,
      requestId,
      success: false,
      error: safety.error,
    });
    return;
  }
  const loadables = bindings
    .map(toLoadableBinding)
    .filter((b): b is AppDataBinding => !!b);
  const rowLimit = resolveSandboxRowLimit(args.rowLimit);
  void Promise.all(
    loadables.map(b => ensureBindingLoaded(duckAppId, b).catch(() => false)),
  )
    .then(() => queryAppDuckDB(duckAppId, String(args.sql ?? "")))
    .then(result => {
      const limited = applySandboxRowLimit(result.rows, rowLimit);
      post({
        type: PREVIEW_MESSAGE.duckDbResult,
        requestId,
        success: true,
        rows: limited.rows,
        fields: result.fields,
        rowCount: result.rows.length,
        truncated: limited.truncated,
        rowLimit,
      });
    })
    .catch(err =>
      post({
        type: PREVIEW_MESSAGE.duckDbResult,
        requestId,
        success: false,
        error: err instanceof Error ? err.message : "DuckDB query failed",
      }),
    );
}
