import React, { useEffect, useCallback, useMemo } from "react";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { Minimize2 } from "lucide-react";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  useDashboardStore,
  type DashboardWidget,
} from "../../store/dashboardStore";
import { executeDashboardSql } from "../../dashboard-runtime/commands";
import { useDashboardRuntimeStore } from "../../dashboard-runtime/store";
import type { DashboardQueryExecutor } from "../../dashboard-runtime/types";
import WidgetContainer from "../widgets/WidgetContainer";
import ChartWidget from "../widgets/ChartWidget";
import KpiCard from "../widgets/KpiCard";
import DataTableWidget from "../widgets/DataTableWidget";

interface PresentationModeProps {
  onExit: () => void;
}

function resolveWidgetLayout(widget: DashboardWidget) {
  const fallback = { x: 0, y: 0, w: 6, h: 4 };
  const candidate = (widget as any).layout ?? (widget as any).layouts?.lg;
  if (!candidate || typeof candidate !== "object") {
    return fallback;
  }

  return {
    x: typeof candidate.x === "number" ? candidate.x : fallback.x,
    y: typeof candidate.y === "number" ? candidate.y : fallback.y,
    w: typeof candidate.w === "number" ? candidate.w : fallback.w,
    h: typeof candidate.h === "number" ? candidate.h : fallback.h,
  };
}

const PresentationMode: React.FC<PresentationModeProps> = ({ onExit }) => {
  const activeDashboardId = useDashboardStore(state => state.activeDashboardId);
  const activeDashboard = useDashboardStore(state =>
    state.activeDashboardId
      ? state.openDashboards[state.activeDashboardId]
      : undefined,
  );
  const runtimeSession = useDashboardRuntimeStore(state =>
    activeDashboardId ? state.sessions[activeDashboardId] || null : null,
  );
  const { width: gridWidth, containerRef: gridContainerRef } =
    useContainerWidth();
  const queryExecutor = useCallback<DashboardQueryExecutor>(
    (sql, options) =>
      executeDashboardSql({
        sql,
        dataSourceId: options?.dataSourceId,
      }),
    [],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    },
    [onExit],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const errorSummary = useMemo(() => {
    if (!activeDashboard) return null;
    const failingSources = activeDashboard.dataSources.filter(
      ds => runtimeSession?.dataSources[ds.id]?.status === "error",
    );
    if (failingSources.length === 0) return null;
    const first = failingSources[0];
    return {
      count: failingSources.length,
      message:
        runtimeSession?.dataSources[first.id]?.error ||
        "Failed to load one or more data sources",
    };
  }, [activeDashboard, runtimeSession]);

  if (!activeDashboard) return null;

  const allSourcesReady = activeDashboard.dataSources.every(
    ds => runtimeSession?.dataSources[ds.id]?.status === "ready",
  );

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
      for (const w of activeDashboard.widgets) {
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
      result.lg = activeDashboard.widgets.map(w => ({
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

  const renderWidget = (widget: DashboardWidget) => {
    if (!allSourcesReady) return null;
    const widgetLayout = resolveWidgetLayout(widget);
    switch (widget.type) {
      case "chart":
        return (
          <ChartWidget
            queryExecutor={queryExecutor}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            vegaLiteSpec={widget.vegaLiteSpec}
            layoutSignature={`${widgetLayout.x}:${widgetLayout.y}:${widgetLayout.w}:${widgetLayout.h}`}
          />
        );
      case "kpi":
        return widget.kpiConfig ? (
          <KpiCard
            queryExecutor={queryExecutor}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            kpiConfig={widget.kpiConfig}
          />
        ) : null;
      case "table":
        return (
          <DataTableWidget
            queryExecutor={queryExecutor}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            tableConfig={widget.tableConfig}
          />
        );
      default:
        return null;
    }
  };

  return (
    <Box
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        backgroundColor: "background.default",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 10000,
        }}
      >
        <Tooltip title="Exit presentation (Esc)">
          <IconButton
            onClick={onExit}
            sx={{
              backgroundColor: "background.paper",
              boxShadow: 2,
              "&:hover": { backgroundColor: "action.hover" },
            }}
          >
            <Minimize2 size={20} />
          </IconButton>
        </Tooltip>
      </Box>

      {errorSummary && (
        <Box
          sx={{
            px: 2,
            py: 1,
            backgroundColor: "error.light",
            color: "error.contrastText",
          }}
        >
          <Typography variant="body2">
            {errorSummary.count > 1
              ? `${errorSummary.count} data sources failed to load.`
              : "Data source failed to load."}{" "}
            {errorSummary.message}
          </Typography>
        </Box>
      )}
      <Box ref={gridContainerRef} sx={{ flex: 1, overflow: "auto", p: 2 }}>
        <ResponsiveGridLayout
          className="layout"
          width={gridWidth || 800}
          layouts={allGridLayouts}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
          cols={{ lg: 12, md: 10, sm: 6, xs: 4 }}
          rowHeight={activeDashboard.layout?.rowHeight || 80}
        >
          {activeDashboard.widgets.map(widget => (
            <div key={widget.id}>
              <WidgetContainer title={widget.title}>
                {renderWidget(widget)}
              </WidgetContainer>
            </div>
          ))}
        </ResponsiveGridLayout>
      </Box>
    </Box>
  );
};

export default PresentationMode;
