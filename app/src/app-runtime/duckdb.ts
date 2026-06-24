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
  /** tableName -> in-flight load, so concurrent callers serialize per table. */
  loading: Map<string, Promise<void>>;
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
    const inst: AppDuckDB = { db, loaded: new Map(), loading: new Map() };
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
  const parquetUrl = cache.parquetUrl;

  // Fast path: this exact snapshot is already loaded.
  if (inst.loaded.get(table) === revision) return true;

  // Serialize loads for a table. The viewer preloads bindings in an effect at
  // the same time the booted app issues on-demand reads (and several widgets
  // can read the same binding at once); without this, two callers would
  // DROP/CREATE the same table from separate connections concurrently, leaving
  // it missing mid-rebuild — which surfaces as "data source not ready" until
  // the user retries. Each load waits for the in-flight one, then re-checks the
  // revision so it no-ops when the snapshot it needs already landed.
  const prior = inst.loading.get(table) ?? Promise.resolve();
  const result = prior.then(async () => {
    if (inst.loaded.get(table) === revision) return true;
    const response = await fetch(parquetUrl, {
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
  });

  // Keep the per-table chain alive for the next caller even if this load fails.
  inst.loading.set(
    table,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** Run analytical SQL against the app's loaded tables. */
export async function queryAppDuckDB(
  appId: string,
  sql: string,
): Promise<DuckDBQueryResult> {
  const inst = await getInstance(appId);
  return queryDuckDB(inst.db, sql);
}

/**
 * Default max rows posted back to the sandboxed iframe per query / binding
 * read. The cap exists to bound the structured-clone cost of the postMessage
 * bridge, not to protect data access (the instance only holds this app's own
 * materialized tables). It matches the 500k-row parquet materialization cap
 * (api/src/services/app-binding-materialization.service.ts), so a plain
 * binding read can never be truncated — only row-multiplying SQL (joins,
 * cross products, generate_series, ...) can exceed it. Apps override it per
 * call via the SDK's `rowLimit` option; `rowLimit: null` disables it.
 */
export const SANDBOX_DUCKDB_ROW_LIMIT = 500_000;

/**
 * Sanitize a row limit requested by the (untrusted) preview iframe.
 * - `null` / `Infinity` -> no cap (explicit opt-out)
 * - finite number >= 1  -> that many rows (floored)
 * - anything else       -> the default cap
 */
export function resolveSandboxRowLimit(requested: unknown): number | null {
  if (requested === null) return null;
  if (typeof requested === "number") {
    if (requested === Infinity) return null;
    if (Number.isFinite(requested) && requested >= 1) {
      return Math.floor(requested);
    }
  }
  return SANDBOX_DUCKDB_ROW_LIMIT;
}

/** Apply a resolved row limit to a query result, flagging dropped rows. */
export function applySandboxRowLimit<T>(
  rows: T[],
  rowLimit: number | null,
): { rows: T[]; truncated: boolean } {
  if (rowLimit == null || rows.length <= rowLimit) {
    return { rows, truncated: false };
  }
  return { rows: rows.slice(0, rowLimit), truncated: true };
}

const LEADING_SQL_COMMENTS = /^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*\s*/;

/**
 * Read-only gate for SQL arriving from the sandboxed preview iframe. The
 * DuckDB instance only holds this app's materialized tables, but statement
 * level commands (INSTALL / LOAD / ATTACH / CREATE / COPY / PRAGMA / SET ...)
 * must not be reachable from untrusted app code. Requiring a single statement
 * that starts with SELECT or WITH rules all of them out without
 * false-positives on identifiers that merely contain those words.
 */
export function checkSandboxDuckDbSql(
  sql: string,
): { ok: true } | { ok: false; error: string } {
  const stripped = sql.replace(LEADING_SQL_COMMENTS, "").trim();
  if (!/^(SELECT|WITH)\b/i.test(stripped)) {
    return {
      ok: false,
      error:
        "Only read-only SELECT / WITH queries are allowed from the app sandbox.",
    };
  }
  // Reject multi-statement SQL: scan for a semicolon (outside string
  // literals / quoted identifiers) that is followed by more SQL.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inSingle) {
      if (ch === "'") {
        if (stripped[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (stripped[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === ";" && stripped.slice(i + 1).trim().length > 0) {
      return {
        ok: false,
        error: "Only a single SQL statement is allowed from the app sandbox.",
      };
    }
  }
  return { ok: true };
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
