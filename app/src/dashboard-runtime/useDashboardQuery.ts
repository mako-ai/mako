import { useEffect, useState } from "react";
import type { DashboardQueryExecutor, DashboardQueryResult } from "./types";
import { executeDashboardSql } from "./commands";

interface UseDashboardQueryOptions {
  sql: string;
  dataSourceId?: string;
  enabled?: boolean;
  queryExecutor?: DashboardQueryExecutor;
  filterClause?: string;
}

function applyFilterClause(sql: string, clause: string): string {
  const lower = sql.toLowerCase();
  const whereIdx = lower.indexOf("where");

  const groupIdx = lower.indexOf("group by");
  const orderIdx = lower.indexOf("order by");
  const limitIdx = lower.indexOf("limit");
  const firstTrailing = Math.min(
    groupIdx === -1 ? sql.length : groupIdx,
    orderIdx === -1 ? sql.length : orderIdx,
    limitIdx === -1 ? sql.length : limitIdx,
  );

  if (whereIdx !== -1 && whereIdx < firstTrailing) {
    return `${sql.slice(0, firstTrailing)} AND (${clause}) ${sql.slice(firstTrailing)}`;
  }
  return `${sql.slice(0, firstTrailing)} WHERE ${clause} ${sql.slice(firstTrailing)}`;
}

export function useDashboardQuery({
  sql,
  dataSourceId,
  enabled = true,
  queryExecutor,
  filterClause,
}: UseDashboardQueryOptions) {
  const [result, setResult] = useState<DashboardQueryResult | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !sql.trim()) {
      setLoading(false);
      return;
    }

    const effectiveSql = filterClause
      ? applyFilterClause(sql, filterClause)
      : sql;

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const next = queryExecutor
          ? await queryExecutor(effectiveSql, { dataSourceId })
          : await executeDashboardSql({ sql: effectiveSql, dataSourceId });
        if (!cancelled) {
          setResult(next);
        }
      } catch (err) {
        if (!cancelled) {
          setResult(null);
          setError(err instanceof Error ? err.message : "Query failed");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataSourceId, enabled, filterClause, queryExecutor, sql]);

  return { result, loading, error };
}
