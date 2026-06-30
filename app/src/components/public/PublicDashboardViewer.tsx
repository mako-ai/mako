import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Tooltip,
  Typography,
} from "@mui/material";
import { RefreshCw } from "lucide-react";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import {
  createDuckDBInstance,
  terminateTrackedDuckDBInstance,
  loadParquetTable,
  dropTable,
  collectStreamBytes,
} from "../../lib/duckdb";
import { createDuckDBQueryExecutor } from "../../dashboard-runtime/query-executor";
import WidgetContainer from "../widgets/WidgetContainer";
import ChartWidget from "../widgets/ChartWidget";
import KpiCard from "../widgets/KpiCard";
import DataTableWidget from "../widgets/DataTableWidget";
import {
  buildResponsiveGridLayouts,
  type ResponsiveGridItem,
} from "../dashboard/buildResponsiveLayouts";

/**
 * Read-only public dashboard renderer (/share/:token).
 *
 * Loads materialized Parquet snapshots into a local DuckDB-WASM instance and
 * runs each widget's localSql against them. No live queries ever leave the
 * browser — anonymous viewers only see pre-built snapshot artifacts. The
 * Refresh button asks the server to re-materialize (throttled server-side).
 */

export interface PublicDashboardContent {
  type: "dashboard";
  title: string;
  description?: string;
  widgets: Array<{
    id: string;
    title?: string;
    type: "chart" | "kpi" | "table";
    dataSourceId: string;
    localSql: string;
    vegaLiteSpec?: Record<string, unknown>;
    kpiConfig?: {
      valueField: string;
      format?: string;
      comparisonField?: string;
      comparisonLabel?: string;
    };
    tableConfig?: { columns?: string[]; pageSize?: number };
    layouts: {
      lg: { x: number; y: number; w: number; h: number };
      md?: { x: number; y: number; w: number; h: number };
      sm?: { x: number; y: number; w: number; h: number };
      xs?: { x: number; y: number; w: number; h: number };
    };
  }>;
  layout: { columns: number; rowHeight: number };
  dataSources: Array<{
    id: string;
    name: string;
    tableRef: string;
    ready: boolean;
    rowCount: number | null;
    materializedAt: string | null;
    artifactUrl: string | null;
  }>;
  /** Owner opt-in: show an "Ask AI" chat panel over the snapshot data. */
  chatEnabled?: boolean;
  refresh: { cooldownMs: number; lastRefreshAt: string | null };
}

interface Props {
  token: string;
  content: PublicDashboardContent;
  /** Re-fetches /content; returns the fresh payload (or null). */
  reloadContent: () => Promise<PublicDashboardContent | null>;
}

function latestMaterializedAt(content: PublicDashboardContent): string | null {
  let latest: string | null = null;
  for (const ds of content.dataSources) {
    if (ds.materializedAt && (!latest || ds.materializedAt > latest)) {
      latest = ds.materializedAt;
    }
  }
  return latest;
}

export default function PublicDashboardViewer({
  token,
  content,
  reloadContent,
}: Props) {
  const [db, setDb] = useState<AsyncDuckDB | null>(null);
  const [dataReady, setDataReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const contentRef = useRef(content);
  contentRef.current = content;

  const { width: gridWidth, containerRef: gridContainerRef } =
    useContainerWidth();

  // Own DuckDB instance for the page lifetime.
  useEffect(() => {
    let cancelled = false;
    let instance: AsyncDuckDB | null = null;
    void (async () => {
      const created = await createDuckDBInstance();
      if (cancelled) {
        void terminateTrackedDuckDBInstance(created, "public-share-unmount");
        return;
      }
      instance = created;
      setDb(created);
    })();
    return () => {
      cancelled = true;
      if (instance) {
        void terminateTrackedDuckDBInstance(instance, "public-share-unmount");
      }
    };
  }, []);

  const loadArtifacts = useCallback(
    async (database: AsyncDuckDB, payload: PublicDashboardContent) => {
      for (const ds of payload.dataSources) {
        if (!ds.ready || !ds.artifactUrl) continue;
        const response = await fetch(ds.artifactUrl, {
          credentials: "include",
        });
        if (!response.ok || !response.body) {
          throw new Error(`Failed to load data for "${ds.name}"`);
        }
        const buffer = await collectStreamBytes(response.body);
        await dropTable(database, ds.tableRef).catch(() => undefined);
        await loadParquetTable(database, ds.tableRef, buffer);
      }
    },
    [],
  );

  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    setDataReady(false);
    setLoadError(null);
    void (async () => {
      try {
        await loadArtifacts(db, contentRef.current);
        if (!cancelled) setDataReady(true);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Failed to load data");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, dataVersion, loadArtifacts]);

  const queryExecutor = useMemo(
    () =>
      db
        ? createDuckDBQueryExecutor(db)
        : async () => {
            throw new Error("DuckDB session is not ready");
          },
    [db],
  );

  const dataAsOf = latestMaterializedAt(content);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await fetch(`/api/share/${token}/refresh`, {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json().catch(() => null);
      if (res.status === 429) {
        const retryMin = Math.ceil((json?.retryAfterMs ?? 60000) / 60000);
        setRefreshNote(
          `Data was refreshed recently — try again in ~${retryMin} min.`,
        );
        return;
      }
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "Failed to refresh");
      }

      setRefreshNote("Refreshing data…");
      const before = latestMaterializedAt(contentRef.current);
      // Poll for the new snapshot (server materializes in the background).
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 8000));
        const fresh = await reloadContent();
        if (fresh && latestMaterializedAt(fresh) !== before) {
          setDataVersion(v => v + 1);
          setRefreshNote(null);
          return;
        }
      }
      setRefreshNote(
        "Refresh is taking longer than expected — reload the page later.",
      );
    } catch (e) {
      setRefreshNote(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  };

  const allGridLayouts = useMemo(() => {
    const base = buildResponsiveGridLayouts(
      content.widgets,
      content.layout.columns || 12,
    );
    const result: Record<
      string,
      Array<ResponsiveGridItem & { static: true }>
    > = {};
    for (const [bp, items] of Object.entries(base)) {
      result[bp] = items.map(item => ({ ...item, static: true }));
    }
    return result;
  }, [content.widgets, content.layout.columns]);

  return (
    <Box
      sx={{
        height: "100vh",
        overflowY: "auto",
        backgroundColor: "background.default",
        color: "text.primary",
      }}
    >
      <Box
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          px: 3,
          py: 2,
          borderBottom: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.default",
          display: "flex",
          alignItems: "center",
          gap: 2,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" sx={{ fontWeight: 600 }} noWrap>
            {content.title}
          </Typography>
          {dataAsOf && (
            <Typography variant="caption" color="text.secondary">
              Data as of {new Date(dataAsOf).toLocaleString()}
            </Typography>
          )}
        </Box>
        {refreshNote && (
          <Typography variant="caption" color="text.secondary">
            {refreshNote}
          </Typography>
        )}
        <Tooltip title="Ask for a fresh snapshot of the data">
          <span>
            <Button
              size="small"
              variant="outlined"
              startIcon={
                refreshing ? (
                  <CircularProgress size={14} />
                ) : (
                  <RefreshCw size={14} />
                )
              }
              disabled={refreshing}
              onClick={() => void handleRefresh()}
            >
              Refresh data
            </Button>
          </span>
        </Tooltip>
      </Box>

      <Box ref={gridContainerRef} sx={{ p: 2 }}>
        {loadError ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <Typography color="error">{loadError}</Typography>
          </Box>
        ) : dataReady && db ? (
          <ResponsiveGridLayout
            className="layout"
            width={gridWidth || 800}
            layouts={allGridLayouts}
            breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
            cols={{ lg: content.layout.columns || 12, md: 10, sm: 6, xs: 4 }}
            rowHeight={content.layout.rowHeight || 80}
          >
            {content.widgets.map(widget => (
              <div key={widget.id}>
                <WidgetContainer title={widget.title}>
                  {widget.type === "chart" ? (
                    <ChartWidget
                      key={`${widget.id}-${dataVersion}`}
                      queryExecutor={queryExecutor}
                      dataSourceId={widget.dataSourceId}
                      localSql={widget.localSql}
                      vegaLiteSpec={widget.vegaLiteSpec}
                      layoutSignature={`${widget.layouts?.lg?.x ?? 0}:${widget.layouts?.lg?.y ?? 0}:${widget.layouts?.lg?.w ?? 6}:${widget.layouts?.lg?.h ?? 4}`}
                    />
                  ) : widget.type === "kpi" && widget.kpiConfig ? (
                    <KpiCard
                      key={`${widget.id}-${dataVersion}`}
                      queryExecutor={queryExecutor}
                      dataSourceId={widget.dataSourceId}
                      localSql={widget.localSql}
                      kpiConfig={widget.kpiConfig}
                    />
                  ) : widget.type === "table" ? (
                    <DataTableWidget
                      key={`${widget.id}-${dataVersion}`}
                      queryExecutor={queryExecutor}
                      dataSourceId={widget.dataSourceId}
                      localSql={widget.localSql}
                      tableConfig={widget.tableConfig}
                    />
                  ) : null}
                </WidgetContainer>
              </div>
            ))}
          </ResponsiveGridLayout>
        ) : (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        )}
      </Box>
    </Box>
  );
}
