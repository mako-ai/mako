import type * as React from "react";

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
export interface MakoLocation {
  pathname: string;
  search: string;
  hash: string;
  href: string;
  searchParams: URLSearchParams;
}

/** Rows of a named data binding (bindings/<name>.sql, materialized). */
export function useQuery<Row = Record<string, unknown>>(
  name: string,
  opts?: QueryOptions,
): QueryState<Row> & { refresh: () => Promise<RefreshResult> };

/** Analytical SQL over the app's bindings; table names are binding names. */
export function useDuckDB<Row = Record<string, unknown>>(
  sql: string,
  opts?: QueryOptions,
): DuckDBState<Row> & { refresh: () => Promise<RefreshResult[]> };

/**
 * Rematerialize one binding on demand and reload it everywhere it is used.
 * Concurrent calls for the same binding share one request.
 */
export function refreshBinding(name: string): Promise<RefreshResult>;

/**
 * Refresh several bindings — all of them when `names` is omitted. Every one
 * is attempted; rejects after they settle if any failed (`failures` lists
 * them).
 */
export function refreshBindings(
  names?: string[],
): Promise<RefreshResult[]>;

export function useTheme(): { theme: "light" | "dark" };
export function useLocation(): MakoLocation;
export function useSearchParams(): [
  URLSearchParams,
  (
    next: URLSearchParams | Record<string, string> | string,
    opts?: { replace?: boolean },
  ) => void,
];
export function navigate(to: string, opts?: { replace?: boolean }): void;
