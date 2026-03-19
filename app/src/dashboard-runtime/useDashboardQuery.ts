import { useEffect, useState } from "react";
import type { DashboardQueryExecutor, DashboardQueryResult } from "./types";
import { executeDashboardSql } from "./commands";

interface UseDashboardQueryOptions {
  sql: string;
  dataSourceId?: string;
  enabled?: boolean;
  queryExecutor?: DashboardQueryExecutor;
}

export function useDashboardQuery({
  sql,
  dataSourceId,
  enabled = true,
  queryExecutor,
}: UseDashboardQueryOptions) {
  const [result, setResult] = useState<DashboardQueryResult | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !sql.trim()) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const next = queryExecutor
          ? await queryExecutor(sql, { dataSourceId })
          : await executeDashboardSql({ sql, dataSourceId });
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
  }, [dataSourceId, enabled, queryExecutor, sql]);

  return { result, loading, error };
}
