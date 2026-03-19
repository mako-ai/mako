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
import WidgetContainer from "../widgets/WidgetContainer";
import ChartWidget from "../widgets/ChartWidget";
import KpiCard from "../widgets/KpiCard";
import DataTableWidget from "../widgets/DataTableWidget";

interface PresentationModeProps {
  onExit: () => void;
}

const PresentationMode: React.FC<PresentationModeProps> = ({ onExit }) => {
  const { activeDashboard, db, dataSourceStatus } = useDashboardStore();
  const { width: gridWidth, containerRef: gridContainerRef } =
    useContainerWidth();

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

  if (!activeDashboard || !db) return null;

  const allSourcesReady = activeDashboard.dataSources.every(
    ds => dataSourceStatus[ds.id] === "ready",
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
            db={db}
            localSql={widget.localSql}
            vegaLiteSpec={widget.vegaLiteSpec}
          />
        );
      case "kpi":
        return widget.kpiConfig ? (
          <KpiCard
            db={db}
            localSql={widget.localSql}
            kpiConfig={widget.kpiConfig}
          />
        ) : null;
      case "table":
        return (
          <DataTableWidget
            db={db}
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
