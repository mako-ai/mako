import React, { useEffect, useCallback } from "react";
import { Box, IconButton, Tooltip } from "@mui/material";
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

const PresentationMode: React.FC<PresentationModeProps> = ({ onExit }) => {
  const activeDashboard = useDashboardStore(state => state.activeDashboard);
  const runtimeSession = useDashboardRuntimeStore(state =>
    activeDashboard ? state.sessions[activeDashboard._id] || null : null,
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

  if (!activeDashboard) return null;

  const allSourcesReady = activeDashboard.dataSources.every(
    ds => runtimeSession?.dataSources[ds.id]?.status === "ready",
  );

  const gridLayout = activeDashboard.widgets.map(w => ({
    i: w.id,
    x: w.layout.x,
    y: w.layout.y,
    w: w.layout.w,
    h: w.layout.h,
    static: true,
  }));

  const renderWidget = (widget: DashboardWidget) => {
    if (!allSourcesReady) return null;
    switch (widget.type) {
      case "chart":
        return (
          <ChartWidget
            queryExecutor={queryExecutor}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            vegaLiteSpec={widget.vegaLiteSpec}
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

      <Box ref={gridContainerRef} sx={{ flex: 1, overflow: "auto", p: 2 }}>
        <ResponsiveGridLayout
          className="layout"
          width={gridWidth || 800}
          layouts={{ lg: gridLayout }}
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
