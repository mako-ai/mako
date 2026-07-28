import React, { useCallback, useMemo, useRef } from "react";
import { Box, Typography, IconButton, Tooltip } from "@mui/material";
import { Database, Plus } from "lucide-react";
import { ResponsiveGridLayout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  useDashboardStore,
  type DashboardWidget,
} from "../../store/dashboardStore";
import { refreshDashboardWidgetDataCommand } from "../../dashboard-runtime/commands";
import { useWorkspace } from "../../contexts/workspace-context";
import type { MosaicInstance } from "../../lib/mosaic";
import type {
  Dashboard,
  DashboardSessionRuntimeState,
} from "../../dashboard-runtime/types";
import { getWidgetSizeDefaults } from "@mako/schemas";
import { buildResponsiveGridLayouts } from "./buildResponsiveLayouts";
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
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const widgets = useMemo(() => dashboard?.widgets ?? [], [dashboard]);
  const crossFilterResolution =
    dashboard?.crossFilter.resolution ?? "intersect";
  const isCrossFilterEnabled = dashboard?.crossFilter.enabled ?? false;
  const lgCols = dashboard?.layout?.columns || 12;

  // Track the active breakpoint so a drag/resize only mutates the layout the
  // user is actually looking at — `lg` is the authored source of truth, and
  // editing a smaller breakpoint marks it `custom` so the auto-reflow backs off.
  const currentBreakpointRef = useRef<string>("lg");
  const handleBreakpointChange = useCallback((bp: string) => {
    currentBreakpointRef.current = bp;
  }, []);

  const persistActiveLayout = useCallback(
    (
      layout: ReadonlyArray<{
        i: string;
        x: number;
        y: number;
        w: number;
        h: number;
      }>,
    ) => {
      if (!dashboard || !dashboardId || !isEditMode || !Array.isArray(layout)) {
        return;
      }
      const bp = currentBreakpointRef.current || "lg";
      const isBase = bp === "lg";

      for (const widget of dashboard.widgets) {
        const item = layout.find(i => i.i === widget.id);
        if (!item) continue;

        const existing = (widget.layouts ??
          ((widget as any).layout
            ? { lg: (widget as any).layout }
            : { lg: { x: 0, y: 0, w: 6, h: 4 } })) as Record<string, any>;
        const prev = existing[bp] ?? existing.lg;

        const next: Record<string, number | boolean> = {
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
        };
        if (typeof prev?.minW === "number") next.minW = prev.minW;
        if (typeof prev?.minH === "number") next.minH = prev.minH;
        if (!isBase) next.custom = true;

        const cur = existing[bp];
        const unchanged =
          cur &&
          cur.x === next.x &&
          cur.y === next.y &&
          cur.w === next.w &&
          cur.h === next.h &&
          (isBase || cur.custom === true);
        if (unchanged) continue;

        modifyWidgetAction(dashboardId, widget.id, {
          layouts: { ...existing, [bp]: next },
        } as any);
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

  const allGridLayouts = useMemo(
    () => buildResponsiveGridLayouts(widgets, lgCols),
    [widgets, lgCols],
  );

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
      data-mako-dashboard-id={dashboard._id}
      data-mako-dashboard-canvas="true"
      sx={{ height: "100%", pb: isEditMode ? "120px" : 0 }}
    >
      <ResponsiveGridLayout
        className="layout"
        width={gridWidth || 800}
        layouts={allGridLayouts}
        breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
        cols={{ lg: lgCols, md: 10, sm: 6, xs: 4 }}
        rowHeight={dashboard.layout?.rowHeight || 80}
        onBreakpointChange={handleBreakpointChange}
        onDragStop={layout => persistActiveLayout(layout)}
        onResizeStop={layout => persistActiveLayout(layout)}
        dragConfig={{ handle: ".drag-handle", enabled: isEditMode }}
        resizeConfig={{ enabled: isEditMode }}
      >
        {dashboard.widgets.map(widget => (
          <div
            key={widget.id}
            data-mako-dashboard-widget-id={widget.id}
            data-mako-dashboard-id={dashboard._id}
          >
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
                  onRefresh={() => {
                    if (!workspaceId || !dashboardId) return;
                    void refreshDashboardWidgetDataCommand({
                      workspaceId,
                      dashboardId,
                      widgetId: widget.id,
                    });
                  }}
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
