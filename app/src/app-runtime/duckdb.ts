/**
 * Per-app DuckDB-WASM runtime (runs in the parent window, not the sandboxed
 * iframe). Each app gets its own DuckDB instance so materialized binding tables
 * are isolated from dashboards and other apps. Parquet artifacts are fetched
 * from the workspace-scoped serve route (which proxies filesystem/GCS/S3) and
 * loaded as in-memory tables, exactly like the dashboard runtime.
 */

import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import {
  createDuckDBInstance,
  loadParquetTable,
  queryDuckDB,
  collectStreamBytes,
  terminateTrackedDuckDBInstance,
  type DuckDBQueryResult,
} from "../lib/duckdb";
import type { AppDataBinding } from "@mako/schemas";

interface AppDuckDB {
  db: AsyncDuckDB;
  /** tableName -> loaded artifact revision (skip reload when unchanged). */
  loaded: Map<string, string>;
}

const instances = new Map<string, AppDuckDB>();
const initializing = new Map<string, Promise<AppDuckDB>>();

/** DuckDB-safe table name derived from a binding name. */
export function bindingTableName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(safe) ? safe : `t_${safe}`;
}

async function getInstance(appId: string): Promise<AppDuckDB> {
  const existing = instances.get(appId);
  if (existing) return existing;
  const pending = initializing.get(appId);
  if (pending) return pending;

  const promise = (async () => {
    const db = await createDuckDBInstance();
    const inst: AppDuckDB = { db, loaded: new Map() };
    instances.set(appId, inst);
    initializing.delete(appId);
    return inst;
  })();
  initializing.set(appId, promise);
  return promise;
}

/**
 * Ensure a binding's Parquet artifact is loaded into the app's DuckDB instance.
 * Returns false if the binding isn't a ready materialized artifact.
 */
export async function ensureBindingLoaded(
  appId: string,
  binding: AppDataBinding,
  signal?: AbortSignal,
): Promise<boolean> {
  const cache = binding.cache;
  if (
    binding.materialization !== "parquet" ||
    !cache?.parquetUrl ||
    cache.parquetBuildStatus !== "ready"
  ) {
    return false;
  }

  const inst = await getInstance(appId);
  const table = bindingTableName(binding.name);
  const revision = cache.artifactRevision || cache.definitionHash || "";
  if (inst.loaded.get(table) === revision) return true;

  const response = await fetch(cache.parquetUrl, {
    credentials: "include",
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch parquet for "${binding.name}"`);
  }
  const buffer = await collectStreamBytes(response.body);
  await loadParquetTable(inst.db, table, buffer);
  inst.loaded.set(table, revision);
  return true;
}

/** Run analytical SQL against the app's loaded tables. */
export async function queryAppDuckDB(
  appId: string,
  sql: string,
): Promise<DuckDBQueryResult> {
  const inst = await getInstance(appId);
  return queryDuckDB(inst.db, sql);
}

/** Tear down an app's DuckDB instance (on tab close / unmount). */
export async function disposeAppDuckDB(appId: string): Promise<void> {
  const inst = instances.get(appId);
  if (!inst) return;
  instances.delete(appId);
  try {
    await terminateTrackedDuckDBInstance(inst.db, "app-runtime-dispose");
  } catch {
    // best-effort teardown
  }
}
