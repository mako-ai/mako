import type * as React from "react";

/**
 * What a pending binding load is waiting on (SDK ≥ 2.7.4).
 *
 * - `requesting`: sent, the server has not said yet (or predates phases).
 * - `queued`, `checking`, `querying_warehouse`, `writing_parquet`,
 *   `uploading`: Mako is BUILDING the file from the warehouse (seconds to
 *   minutes). Only a refresh, a laptop dev build or a sandbox live binding
 *   builds; a published app never builds on a read.
 * - `resolving`, `signing`: the file exists; Mako is finding it and signing
 *   its download link (well under a second).
 * - `downloading`, `loading_duckdb`, `running_sql`: the browser's own work.
 */
export type BindingPhase =
  | "requesting"
  | "queued"
  | "checking"
  | "querying_warehouse"
  | "writing_parquet"
  | "uploading"
  | "resolving"
  | "signing"
  | "downloading"
  | "loading_duckdb"
  | "running_sql";

/** The phases grouped by the wait a person cares about. */
export type BindingStage =
  | "waiting"
  | "building"
  | "linking"
  | "downloading"
  | "loading"
  | "querying";

/** One binding's progress while it loads or refreshes. */
export interface BindingProgress {
  phase: BindingPhase;
  /** Rows written so far while building; null when the server does not say. */
  rowsWritten?: number | null;
  /** Building: the file's size. Downloading: bytes received so far. */
  bytes?: number | null;
  /** Downloading: the file's size, when the server sent Content-Length. */
  bytesTotal?: number | null;
}

/** Several bindings at once (useDuckDB): the slowest wait, sums, a count. */
export interface CombinedBindingProgress {
  phase: BindingPhase;
  rowsWritten: number | null;
  bytes: number | null;
  bytesTotal: number | null;
  pending: number;
}

export const BINDING_PHASES: readonly BindingPhase[];
export const BINDING_PHASE_LABELS: Record<BindingPhase, string>;
/** "Building from warehouse", "Getting download link", "Downloading", "Loading into DuckDB", … */
export const BINDING_STAGE_LABELS: Record<BindingStage, string>;
export function bindingPhaseStage(phase: BindingPhase | string | null | undefined): BindingStage | null;
/**
 * A progress-bar caption: the stage label plus rows or bytes when known,
 * e.g. "Building from warehouse · 120,000 rows", "Downloading · 3.1 of 10.0 MB".
 * Empty when nothing is pending. Pass a hook's state (`bindingPhaseLabel(q)`)
 * or a progress record.
 */
export function bindingPhaseLabel(
  progress:
    | BindingPhase
    | {
        phase: BindingPhase | null;
        rowsWritten?: number | null;
        bytes?: number | null;
        bytesTotal?: number | null;
      }
    | null
    | undefined,
): string;

/** One binding's progress, or null when it is not loading. */
export function useBindingProgress(name: string): BindingProgress | null;
/** Every pending binding's progress, by name. */
export function useBindingProgress(): Record<string, BindingProgress>;

/** What a refresh built — the server's answer to `POST __data/<name>/refresh`. */
export interface RefreshResult {
  binding: string;
  /** "live" bindings have no artifact; the refresh just re-fetched them. */
  materialization: "parquet" | "live";
  rowCount?: number;
  byteSize?: number;
  /** ISO 8601; absent for a live binding. */
  materializedAt?: string;
}

/** Why a refresh was refused or failed. */
export interface RefreshError extends Error {
  /** 403: not allowed here; 404: no such binding; 429: refreshed too recently; 502: the query failed. */
  status?: number;
  /** With 429: how long until the next refresh is accepted. */
  retryAfterMs?: number;
}

export interface QueryState<Row = Record<string, unknown>> {
  data: Row[] | null;
  error: string | null;
  /** First load (or a new query): no rows yet. */
  loading: boolean;
  /** A refresh is in flight; `data` still holds the previous rows. */
  refreshing: boolean;
  truncated: boolean;
  /**
   * What `loading` / `refreshing` is waiting on; null when neither is true.
   * Caption it with `bindingPhaseLabel(phase)`.
   */
  phase: BindingPhase | null;
  /** While building: rows written so far, when the server says. */
  rowsWritten: number | null;
  /** While building: file size; while downloading: bytes received. */
  bytes: number | null;
  /** While downloading: the file's size, when known. */
  bytesTotal: number | null;
  /**
   * Rematerialize the data behind this query and re-run it. Rejects with a
   * `RefreshError` — the rows on screen are untouched when it does.
   */
  refresh: () => Promise<RefreshResult | RefreshResult[]>;
}
export interface DuckDBState<Row = Record<string, unknown>>
  extends QueryState<Row> {
  fields: string[] | null;
  rowCount: number | null;
}
export interface QueryOptions {
  rowLimit?: number | null;
}
export interface UseQueryOptions extends QueryOptions {
  /**
   * Opt in to the preview: fetch `__data/<name>.snapshot.json` (the first
   * rows of the last build, no DuckDB-WASM needed) while the parquet loads,
   * and expose it as `preview`. `data`, `loading`, `phase` and every other
   * field behave exactly as without it. Default false.
   */
  snapshot?: boolean;
}
/**
 * The first rows of the binding's last build, for a skeleton or a first
 * paint. The first N rows of the build stream in the query's own order: not
 * a sample, not sorted, not filtered. Never aggregate it.
 */
export interface QueryPreview<Row = Record<string, unknown>> {
  /** At most a few hundred rows, typed exactly as `data` will be. */
  data: Row[];
  fields: string[];
  /** Rows in the whole build, not in `data`. */
  rowCount: number;
  /** True when `data` holds fewer rows than `rowCount`. */
  truncated: boolean;
  /** ISO 8601, when the snapshot's build ran; null when unknown. */
  builtAt: string | null;
}
export interface DuckDBOptions extends QueryOptions {
  /**
   * "arrow": `data` is DuckDB's Arrow Table as returned (no row objects, no
   * date/BigInt normalization, `rowLimit` ignored). Default "rows".
   */
  format?: "rows" | "arrow";
}

/**
 * The page's shared DuckDB-WASM engine (`AsyncDuckDB` from
 * @duckdb/duckdb-wasm 1.29), typed loosely so the SDK needs no dependency.
 * Never close() or terminate() it: every hook on the page reads from it.
 */
export interface SharedDuckDB {
  connect(): Promise<DuckDBConnection>;
  registerFileBuffer(name: string, buffer: Uint8Array): Promise<void>;
  dropFile(name: string): Promise<void>;
  [key: string]: unknown;
}
export interface DuckDBConnection {
  /** Resolves with an Arrow Table. */
  query(sql: string): Promise<any>;
  close(): Promise<void>;
  [key: string]: unknown;
}
export interface MakoLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
  searchParams: URLSearchParams;
}

/**
 * Rows of a named data binding (bindings/<name>.sql, materialized).
 *
 * With `{ snapshot: true }` the result also carries `preview`: the snapshot
 * rows while `loading` is true and no error has arrived, null otherwise.
 * `data` stays null until the full parquet is in, so code that sums or
 * filters `data` never sees a prefix.
 */
export function useQuery<Row = Record<string, unknown>>(
  name: string,
  opts: UseQueryOptions & { snapshot: true },
): QueryState<Row> & {
  refresh: () => Promise<RefreshResult>;
  /** The binding's own progress record (null when it is not loading). */
  progress: BindingProgress | null;
  preview: QueryPreview<Row> | null;
};
export function useQuery<Row = Record<string, unknown>>(
  name: string,
  opts?: UseQueryOptions,
): QueryState<Row> & {
  refresh: () => Promise<RefreshResult>;
  /** The binding's own progress record (null when it is not loading). */
  progress: BindingProgress | null;
};

/** This package's version at runtime; pages also get `window.__MAKO_APP_SDK__`. */
export const SDK_VERSION: string;

/**
 * Analytical SQL over the app's bindings; table names are binding names.
 * Since 2.8 only the bindings the SQL names are downloaded (each decoded
 * once into a DuckDB table); one it misses loads on DuckDB's "table does
 * not exist" and the query re-runs. Catalog queries (SHOW TABLES,
 * information_schema) load every binding.
 */
export function useDuckDB<Row = Record<string, unknown>>(
  sql: string,
  opts?: QueryOptions & { format?: "rows" },
): DuckDBState<Row> & {
  refresh: () => Promise<RefreshResult[]>;
  /** The slowest pending binding's wait, with sums; null when none. */
  progress: CombinedBindingProgress | null;
  /** Every pending binding's progress, by name. */
  bindings: Record<string, BindingProgress>;
};
export function useDuckDB(
  sql: string,
  opts: DuckDBOptions & { format: "arrow" },
): Omit<DuckDBState, "data"> & {
  /** The Arrow Table (apache-arrow 17) DuckDB returned. */
  data: any | null;
  refresh: () => Promise<RefreshResult[]>;
  /** The slowest pending binding's wait, with sums; null when none. */
  progress: CombinedBindingProgress | null;
  /** Every pending binding's progress, by name. */
  bindings: Record<string, BindingProgress>;
};

export interface RefreshOptions {
  /**
   * Every phase of this refresh: the build, then the reload (link,
   * download, DuckDB), then `null` once it settles.
   */
  onProgress?: (progress: BindingProgress | null) => void;
}

/**
 * The page's shared DuckDB, booted on first call. Use it for anything the
 * hooks do not cover instead of importing @duckdb/duckdb-wasm, hyparquet or
 * apache-arrow readers. Never close or terminate it.
 */
export function getDuckDB(): Promise<SharedDuckDB>;

/** Run `fn` on a fresh connection to the shared DuckDB; closed afterwards. */
export function withConnection<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T>;

/**
 * Load a binding into the shared DuckDB as a table (once per page;
 * concurrent callers share the download). Resolves with the table name.
 */
export function ensureBinding(name: string): Promise<string>;

/** Drop a loaded binding's table to free memory; the next read reloads it. */
export function unloadBinding(name: string): Promise<void>;

/**
 * The binding's raw parquet bytes, not registered anywhere — for an app with
 * its own reader (register them via getDuckDB().registerFileBuffer to use
 * read_parquet options). Rejects like a failed load (`status`, message).
 */
export function fetchBindingBytes(
  name: string,
  opts?: {
    fresh?: boolean;
    /**
     * The same phases a hook reports (requesting → resolving/signing or a
     * build → downloading with `bytes` / `bytesTotal`), then `null`.
     */
    onProgress?: (progress: BindingProgress | null) => void;
  },
): Promise<Uint8Array>;

/**
 * Rematerialize one binding on demand and reload it everywhere it is used.
 * Concurrent calls for the same binding share one request.
 */
export function refreshBinding(
  name: string,
  opts?: RefreshOptions,
): Promise<RefreshResult>;

/**
 * Refresh several bindings — all of them when `names` is omitted. Every one
 * is attempted; rejects after they settle if any failed (`failures` lists
 * them).
 */
export function refreshBindings(
  names?: string[],
): Promise<RefreshResult[]>;

/**
 * The person viewing the app, as Mako resolved them from the session or the
 * signed view token (apps.md §28). Only what the platform knows: identity,
 * the workspace and their ACCESS role in it, their role on this app. Look
 * up anything else (team, territory, …) in the warehouse by `email`.
 */
export interface Viewer {
  id: string;
  /** Signed-in email, lowercased. */
  email: string;
  workspace: {
    id: string;
    name: string;
    /** Access role in the workspace; null when not a member. */
    role: "owner" | "admin" | "member" | "viewer" | null;
  };
  app: {
    id: string;
    slug: string | null;
    /** What they may do to this app. */
    role: "owner" | "editor" | "viewer" | null;
  };
}
export interface ViewerState {
  /** null while loading, on an anonymous share, or on an older server. */
  viewer: Viewer | null;
  loading: boolean;
  error: string | null;
}

/** Who is looking. The app decides what that means for its UI and data. */
export function useViewer(): ViewerState;
/** The same, outside a component; resolved once per page. */
export function getViewer(): Promise<Viewer | null>;

export function useTheme(): { theme: "light" | "dark" };

/**
 * The theme tokens the SDK injects into <head> on import (Mako's house
 * palette: --background, --brand, --canvas, --positive, --chart-1…5, …).
 */
export const MAKO_THEME_TOKENS_CSS: string;
export function useLocation(): MakoLocation;
export function useSearchParams(): [
  URLSearchParams,
  (
    next: URLSearchParams | Record<string, string> | string,
    opts?: { replace?: boolean },
  ) => void,
];
export function navigate(to: string, opts?: { replace?: boolean }): void;
