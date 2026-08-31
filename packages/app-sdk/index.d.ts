import type * as React from "react";

export interface QueryState<Row = Record<string, unknown>> {
  data: Row[] | null;
  error: string | null;
  loading: boolean;
  truncated: boolean;
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
): QueryState<Row>;

/** Analytical SQL over the app's bindings; table names are binding names. */
export function useDuckDB<Row = Record<string, unknown>>(
  sql: string,
  opts?: QueryOptions,
): DuckDBState<Row>;

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
