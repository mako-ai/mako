import React, { useCallback, useMemo } from "react";
import { Box, Typography, IconButton, Tooltip } from "@mui/material";
import { Database, Plus } from "lucide-react";
import { ResponsiveGridLayout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  useDashboardStore,
  type DashboardWidget,
} from "../../store/dashboardStore";
import { refreshDashboardWidgetCommand } from "../../dashboard-runtime/commands";
import type { MosaicInstance } from "../../lib/mosaic";
import type {
  Dashboard,
  DashboardSessionRuntimeState,
} from "../../dashboard-runtime/types";
import { getWidgetSizeDefaults, deriveResponsiveLayouts } from "@mako/schemas";
import WidgetContainer from "../widgets/WidgetContainer";
import MosaicChart from "../widgets/MosaicChart";
import MosaicKpiCard from "../widgets/MosaicKpiCard";
import MosaicDataTable from "../widgets/MosaicDataTable";

const {
  modifyWidget: modifyWidgetAction,
  removeWidget: removeWidgetAction,
  addWidget: addWidgetAction,
} = useDashboardStore.getState();

function resolveWidgetLayout(widget: DashboardWidget) {
  const vegaMark =
    typeof widget.vegaLiteSpec?.mark === "string"
      ? widget.vegaLiteSpec.mark
      : ((widget.vegaLiteSpec?.mark as Record<string, unknown> | undefined)
          ?.type as string | undefined);
  const sizeDefaults = getWidgetSizeDefaults(widget.type, vegaMark);
  const fallback = {
    x: 0,
    y: 0,
    w: sizeDefaults.w,
    h: sizeDefaults.h,
    minW: sizeDefaults.minW,
    minH: sizeDefaults.minH,
  };
  const candidate = (widget as any).layout ?? (widget as any).layouts?.lg;
  if (!candidate || typeof candidate !== "object") return fallback;
  return {
    x: typeof candidate.x === "number" ? candidate.x : fallback.x,
    y: typeof candidate.y === "number" ? candidate.y : fallback.y,
    w: typeof candidate.w === "number" ? candidate.w : fallback.w,
    h: typeof candidate.h === "number" ? candidate.h : fallback.h,
    minW: typeof candidate.minW === "number" ? candidate.minW : fallback.minW,
    minH: typeof candidate.minH === "number" ? candidate.minH : fallback.minH,
  };
}

interface DashboardGridProps {
  dashboard: Dashboard;
  dashboardId?: string;
  runtimeSession: DashboardSessionRuntimeState | null;
  mosaicInstance: MosaicInstance | null;
  allSourcesReady: boolean;
  isEditMode: boolean;
  gridContainerRef: React.RefObject<HTMLDivElement | null>;
  gridWidth: number;
  queryGeneration: number;
  onOpenDataSourcePanel: () => void;
  onOpenAddWidget: () => void;
  onInspectWidget: (widget: DashboardWidget) => void;
}

const DashboardGrid: React.FC<DashboardGridProps> = ({
  dashboard,
  dashboardId,
  runtimeSession,
  mosaicInstance,
  allSourcesReady,
  isEditMode,
  gridContainerRef,
  gridWidth,
  queryGeneration,
  onOpenDataSourcePanel,
  onOpenAddWidget,
  onInspectWidget,
}) => {
  const widgets = useMemo(() => dashboard?.widgets ?? [], [dashboard]);
  const crossFilterResolution =
    dashboard?.crossFilter.resolution ?? "intersect";
  const isCrossFilterEnabled = dashboard?.crossFilter.enabled ?? false;

  const handleLayoutChange = useCallback(
    (_layout: any, allLayouts: Record<string, any>) => {
      if (!dashboard || !dashboardId || !allLayouts || !isEditMode) return;

      for (const widget of dashboard.widgets) {
        const currentLayouts =
          widget.layouts ??
          ((widget as any).layout
            ? { lg: (widget as any).layout }
            : { lg: { x: 0, y: 0, w: 6, h: 4 } });
        const updatedLayouts: Record<
          string,
          { x: number; y: number; w: number; h: number }
        > = {};
        let changed = false;

        for (const [bp, items] of Object.entries(allLayouts)) {
          if (!Array.isArray(items)) continue;
          const item = items.find((i: any) => i.i === widget.id);
          if (!item) continue;
          const newPos = { x: item.x, y: item.y, w: item.w, h: item.h };
          const existing = (currentLayouts as any)[bp];
          if (
            !existing ||
            existing.x !== newPos.x ||
            existing.y !== newPos.y ||
            existing.w !== newPos.w ||
            existing.h !== newPos.h
          ) {
            updatedLayouts[bp] = newPos;
            changed = true;
          }
        }

        if (changed) {
          modifyWidgetAction(dashboardId, widget.id, {
            layouts: { ...currentLayouts, ...updatedLayouts },
          } as any);
        }
      }
    },
    [dashboard, dashboardId, isEditMode],
  );

  const handleDuplicateWidget = useCallback(
    async (widget: DashboardWidget) => {
      if (!dashboardId) return;
      const { nanoid } = await import("nanoid");
      const lgLayout = widget.layouts?.lg ?? resolveWidgetLayout(widget);
      const newWidget: DashboardWidget = {
        ...widget,
        id: nanoid(),
        title: `${widget.title || "Widget"} (copy)`,
        layouts: {
          ...(widget.layouts ?? {}),
          lg: { ...lgLayout, y: lgLayout.y + lgLayout.h },
        },
      };
      addWidgetAction(dashboardId, newWidget);
    },
    [dashboardId],
  );

  const allGridLayouts = useMemo(() => {
    const breakpoints = ["lg", "md", "sm", "xs"] as const;
    type GridItem = {
      i: string;
      x: number;
      y: number;
      w: number;
      h: number;
      minW: number;
      minH: number;
    };
    const result: Record<string, GridItem[]> = {};
    for (const bp of breakpoints) {
      const items: GridItem[] = [];
      for (const w of widgets) {
        const wAny = w as any;
        const vegaMark =
          typeof w.vegaLiteSpec?.mark === "string"
            ? w.vegaLiteSpec.mark
            : ((w.vegaLiteSpec?.mark as Record<string, unknown> | undefined)
                ?.type as string | undefined);
        const sizeDefaults = getWidgetSizeDefaults(w.type, vegaMark);

        let bpLayout =
          w.layouts?.[bp] ?? (bp === "lg" ? wAny.layout : undefined);

        if (!bpLayout && w.layouts?.lg) {
          const lgWithMins = {
            ...w.layouts.lg,
            minW: w.layouts.lg.minW ?? sizeDefaults.minW,
            minH: w.layouts.lg.minH ?? sizeDefaults.minH,
          };
          bpLayout = deriveResponsiveLayouts(lgWithMins)[bp];
        }

        if (!bpLayout) continue;
        items.push({
          i: w.id,
          x: bpLayout.x ?? 0,
          y: bpLayout.y ?? 0,
          w: bpLayout.w ?? sizeDefaults.w,
          h: bpLayout.h ?? sizeDefaults.h,
          minW: bpLayout.minW ?? sizeDefaults.minW,
          minH: bpLayout.minH ?? sizeDefaults.minH,
        });
      }
      if (items.length > 0) result[bp] = items;
    }
    if (!result.lg) {
      result.lg = widgets.map(w => {
        const sd = getWidgetSizeDefaults(w.type);
        return {
          i: w.id,
          x: 0,
          y: 0,
          w: sd.w,
          h: sd.h,
          minW: sd.minW,
          minH: sd.minH,
        };
      });
    }
    return result;
  }, [widgets]);

  const renderWidget = (widget: DashboardWidget) => {
    const snapshot = dashboard.snapshots?.[widget.id];
    if (!runtimeSession && !snapshot) return null;

    const dataSourceRuntime = runtimeSession?.dataSources[widget.dataSourceId];
    if (
      (!dataSourceRuntime || dataSourceRuntime.status !== "ready") &&
      !snapshot
    ) {
      return null;
    }

    const widgetCrossFilterEnabled =
      isCrossFilterEnabled && (widget.crossFilter?.enabled ?? true);
    if (!mosaicInstance && !snapshot) return null;

    const widgetRuntime = runtimeSession?.widgets[widget.id];
    const refreshGeneration = widgetRuntime?.refreshGeneration ?? 0;
    const sessionId = runtimeSession?.sessionId ?? "";
    const widgetLayout = resolveWidgetLayout(widget);
    const widgetRenderKey = [
      widget.id,
      widgetLayout.x,
      widgetLayout.y,
      widgetLayout.w,
      widgetLayout.h,
      refreshGeneration,
      sessionId,
    ].join(":");

    switch (widget.type) {
      case "chart":
        return (
          <MosaicChart
            dashboardId={dashboard._id}
            widgetId={widget.id}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            initialRows={snapshot?.rows}
            initialFields={snapshot?.fields}
            vegaLiteSpec={widget.vegaLiteSpec}
            mosaicInstance={mosaicInstance}
            crossFilterEnabled={widgetCrossFilterEnabled}
            crossFilterResolution={crossFilterResolution}
            queryGeneration={queryGeneration}
            refreshGeneration={refreshGeneration}
            key={widgetRenderKey}
          />
        );
      case "kpi":
        if (!widget.kpiConfig) return null;
        return (
          <MosaicKpiCard
            dashboardId={dashboard._id}
            widgetId={widget.id}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            initialRows={snapshot?.rows}
            initialFields={snapshot?.fields}
            kpiConfig={widget.kpiConfig}
            mosaicInstance={mosaicInstance}
            crossFilterEnabled={widgetCrossFilterEnabled}
            crossFilterResolution={crossFilterResolution}
            queryGeneration={queryGeneration}
            refreshGeneration={refreshGeneration}
            key={widgetRenderKey}
          />
        );
      case "table":
        return (
          <MosaicDataTable
            dashboardId={dashboard._id}
            widgetId={widget.id}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            initialRows={snapshot?.rows}
            initialFields={snapshot?.fields}
            tableConfig={widget.tableConfig}
            mosaicInstance={mosaicInstance}
            crossFilterEnabled={widgetCrossFilterEnabled}
            crossFilterResolution={crossFilterResolution}
            queryGeneration={queryGeneration}
            refreshGeneration={refreshGeneration}
            key={widgetRenderKey}
          />
        );
      default:
        return null;
    }
  };

  if (dashboard.widgets.length === 0) {
    return (
      <Box ref={gridContainerRef} sx={{ height: "100%" }}>
        <Box
          sx={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            color: "text.secondary",
            gap: 2,
          }}
        >
          <Typography variant="body2">
            {isEditMode ? "No widgets yet." : "This dashboard has no widgets."}
          </Typography>
          {isEditMode &&
            (dashboard.dataSources.length === 0 ? (
              <Tooltip title="Add a data source">
                <IconButton onClick={onOpenDataSourcePanel}>
                  <Database size={16} />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="Add a widget">
                <IconButton onClick={onOpenAddWidget}>
                  <Plus size={16} />
                </IconButton>
              </Tooltip>
            ))}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      ref={gridContainerRef}
      sx={{ height: "100%", pb: isEditMode ? "120px" : 0 }}
    >
      <ResponsiveGridLayout
        className="layout"
        width={gridWidth || 800}
        layouts={allGridLayouts}
        breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
        cols={{ lg: 12, md: 10, sm: 6, xs: 4 }}
        rowHeight={dashboard.layout?.rowHeight || 80}
        onLayoutChange={handleLayoutChange}
        dragConfig={{ handle: ".drag-handle", enabled: isEditMode }}
        resizeConfig={{ enabled: isEditMode }}
      >
        {dashboard.widgets.map(widget => (
          <div key={widget.id}>
            {(() => {
              const widgetRuntime = runtimeSession?.widgets[widget.id];
              const widgetError =
                widgetRuntime?.queryError || widgetRuntime?.renderError;
              return (
                <WidgetContainer
                  title={widget.title}
                  loading={!allSourcesReady}
                  error={widgetError || undefined}
                  isEditMode={isEditMode}
                  onRefresh={() =>
                    dashboardId &&
                    refreshDashboardWidgetCommand({
                      dashboardId,
                      widgetId: widget.id,
                    })
                  }
                  onRemove={() =>
                    dashboardId && removeWidgetAction(dashboardId, widget.id)
                  }
                  onDuplicate={() => handleDuplicateWidget(widget)}
                  onInspect={() => onInspectWidget(widget)}
                >
                  {renderWidget(widget)}
                </WidgetContainer>
              );
            })()}
          </div>
        ))}
      </ResponsiveGridLayout>
    </Box>
  );
};

export default DashboardGrid;
