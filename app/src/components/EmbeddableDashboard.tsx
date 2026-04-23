import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Typography,
  CircularProgress,
  ThemeProvider,
  createTheme,
} from "@mui/material";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { initDuckDB, loadArrowTable } from "../lib/duckdb";
import { createDuckDBQueryExecutor } from "../dashboard-runtime/query-executor";
import WidgetContainer from "./widgets/WidgetContainer";
import ChartWidget from "./widgets/ChartWidget";
import KpiCard from "./widgets/KpiCard";
import DataTableWidget from "./widgets/DataTableWidget";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

interface EmbedDashboardSpec {
  title: string;
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
  dataSources: Array<{
    id: string;
    name: string;
    exportUrl: string;
  }>;
  layout: { columns: number; rowHeight: number };
  theme?: "light" | "dark";
}

const darkTheme = createTheme({ palette: { mode: "dark" } });
const lightTheme = createTheme({ palette: { mode: "light" } });

const EmbeddableDashboard: React.FC = () => {
  const [spec, setSpec] = useState<EmbedDashboardSpec | null>(null);
  const [db, setDb] = useState<AsyncDuckDB | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataReady, setDataReady] = useState(false);
  const { width: gridWidth, containerRef: gridContainerRef } =
    useContainerWidth();

  const queryExecutor = useMemo(
    () =>
      db
        ? createDuckDBQueryExecutor(db)
        : async () => {
            throw new Error("Embedded DuckDB session is not ready");
          },
    [db],
  );

  useEffect(() => {
    const token = window.location.pathname.split("/embed/")[1];
    if (!token) {
      setError("Missing embed token");
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const res = await fetch(`/api/embed/dashboards/${token}`);
        if (!res.ok) {
          throw new Error(`Failed to load dashboard: ${res.statusText}`);
        }
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to load");
        setSpec(data.data);

        const duckdb = await initDuckDB();
        setDb(duckdb);

        for (const ds of data.data.dataSources) {
          const exportRes = await fetch(ds.exportUrl, {
            credentials: "include",
          });
          if (exportRes.ok) {
            const buffer = new Uint8Array(await exportRes.arrayBuffer());
            await loadArrowTable(duckdb, ds.name, buffer);
          }
        }

        setDataReady(true);
      } catch (e: unknown) {
        setError(
          e instanceof Error ? e.message : "Failed to load embedded dashboard",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error || !spec) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
        }}
      >
        <Typography color="error">{error || "Dashboard not found"}</Typography>
      </Box>
    );
  }

  const theme = spec.theme === "dark" ? darkTheme : lightTheme;

  const allGridLayouts = (() => {
    const breakpoints = ["lg", "md", "sm", "xs"] as const;
    type GridItem = {
      i: string;
      x: number;
      y: number;
      w: number;
      h: number;
      static: boolean;
    };
    const result: Record<string, GridItem[]> = {};
    for (const bp of breakpoints) {
      const items: GridItem[] = [];
      for (const w of spec.widgets) {
        const wAny = w as any;
        const bpLayout =
          w.layouts?.[bp] ?? (bp === "lg" ? wAny.layout : undefined);
        if (!bpLayout) continue;
        items.push({
          i: w.id,
          x: bpLayout.x ?? 0,
          y: bpLayout.y ?? 0,
          w: bpLayout.w ?? 6,
          h: bpLayout.h ?? 4,
          static: true,
        });
      }
      if (items.length > 0) result[bp] = items;
    }
    if (!result.lg) {
      result.lg = spec.widgets.map(w => ({
        i: w.id,
        x: 0,
        y: 0,
        w: 6,
        h: 4,
        static: true,
      }));
    }
    return result;
  })();

  return (
    <ThemeProvider theme={theme}>
      <Box
        sx={{
          minHeight: "100vh",
          backgroundColor: "background.default",
          color: "text.primary",
        }}
      >
        <Box
          sx={{
            px: 3,
            py: 2,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <Typography variant="h5" sx={{ fontWeight: 600 }}>
            {spec.title}
          </Typography>
        </Box>

        <Box ref={gridContainerRef} sx={{ p: 2 }}>
          {dataReady && db ? (
            <ResponsiveGridLayout
              className="layout"
              width={gridWidth || 800}
              layouts={allGridLayouts}
              breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
              cols={{ lg: spec.layout.columns || 12, md: 10, sm: 6, xs: 4 }}
              rowHeight={spec.layout.rowHeight || 80}
            >
              {spec.widgets.map(widget => (
                <div key={widget.id}>
                  <WidgetContainer title={widget.title}>
                    {widget.type === "chart" ? (
                      <ChartWidget
                        queryExecutor={queryExecutor}
                        dataSourceId={widget.dataSourceId}
                        localSql={widget.localSql}
                        vegaLiteSpec={widget.vegaLiteSpec}
                        layoutSignature={`${widget.layouts?.lg?.x ?? 0}:${widget.layouts?.lg?.y ?? 0}:${widget.layouts?.lg?.w ?? 6}:${widget.layouts?.lg?.h ?? 4}`}
                      />
                    ) : widget.type === "kpi" && widget.kpiConfig ? (
                      <KpiCard
                        queryExecutor={queryExecutor}
                        dataSourceId={widget.dataSourceId}
                        localSql={widget.localSql}
                        kpiConfig={widget.kpiConfig}
                      />
                    ) : widget.type === "table" ? (
                      <DataTableWidget
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
    </ThemeProvider>
  );
};

export default EmbeddableDashboard;
