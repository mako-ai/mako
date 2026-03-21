import React, {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  Chip,
  LinearProgress,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import {
  RefreshCw,
  Save,
  Download,
  Database,
  Plus,
  Settings,
  Undo2,
  Redo2,
  ChartPie as DashboardIcon,
  Code2,
} from "lucide-react";
import { ResponsiveGridLayout, useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import Editor from "@monaco-editor/react";
import {
  useDashboardStore,
  type DashboardWidget,
} from "../store/dashboardStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useTheme } from "../contexts/ThemeContext";
import {
  activateDashboardSession,
  getDashboardMosaicInstance,
  refreshDashboardCommand,
  reloadDashboardDataSourcesCommand,
  refreshDashboardWidgetCommand,
} from "../dashboard-runtime/commands";
import { useDashboardRuntimeStore } from "../dashboard-runtime/store";
import { serializeDashboardDefinition } from "../dashboard-runtime/types";
import type { MosaicInstance } from "../lib/mosaic";
import WidgetContainer from "./widgets/WidgetContainer";
import MosaicChart from "./widgets/MosaicChart";
import MosaicKpiCard from "./widgets/MosaicKpiCard";
import MosaicDataTable from "./widgets/MosaicDataTable";
import DataSourcePanel from "./dashboard/DataSourcePanel";
import AddWidgetDialog from "./dashboard/AddWidgetDialog";
import DashboardSettingsDialog from "./dashboard/DashboardSettingsDialog";
import WidgetInspector from "./dashboard/WidgetInspector";
type ViewMode = "canvas" | "code";

interface DashboardCanvasProps {
  dashboardId?: string;
  isNew?: boolean;
  onCreated?: (dashboardId: string) => void;
}

function formatZodErrors(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .slice(0, 5)
    .map(issue => `${issue.path.join(".")}: ${issue.message}`)
    .join(" | ");
}

const DashboardCanvas: React.FC<DashboardCanvasProps> = ({
  dashboardId,
  isNew,
  onCreated,
}) => {
  const { currentWorkspace } = useWorkspace();
  const { effectiveMode } = useTheme();
  const dashboard = useDashboardStore(state =>
    dashboardId ? state.openDashboards[dashboardId] : undefined,
  );
  const openDashboard = useDashboardStore(state => state.openDashboard);
  const saveDashboard = useDashboardStore(state => state.saveDashboard);
  const createDashboard = useDashboardStore(state => state.createDashboard);
  const addWidget = useDashboardStore(state => state.addWidget);
  const modifyWidget = useDashboardStore(state => state.modifyWidget);
  const removeWidget = useDashboardStore(state => state.removeWidget);
  const applyDefinition = useDashboardStore(state => state.applyDefinition);
  const undo = useDashboardStore(state => state.undo);
  const redo = useDashboardStore(state => state.redo);
  const historyEntry = useDashboardStore(state =>
    dashboardId ? state.historyMap[dashboardId] : undefined,
  );
  const historyIndex = historyEntry?.index ?? -1;
  const historyLength = historyEntry?.stack.length ?? 0;
  const runtimeSession = useDashboardRuntimeStore(state =>
    dashboardId ? state.sessions[dashboardId] || null : null,
  );

  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [codeValue, setCodeValue] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [dataSourcePanelOpen, setDataSourcePanelOpen] = useState(false);
  const [addWidgetOpen, setAddWidgetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showEventLog, setShowEventLog] = useState(false);
  const [inspectedWidget, setInspectedWidget] =
    useState<DashboardWidget | null>(null);
  const [mosaicInstance, setMosaicInstance] = useState<MosaicInstance | null>(
    null,
  );

  const { width: gridWidth, containerRef: gridContainerRef } =
    useContainerWidth();

  const workspaceId = currentWorkspace?.id;
  const crossFilterResolution =
    dashboard?.crossFilter.resolution ?? "intersect";
  const isCrossFilterEnabled = dashboard?.crossFilter.enabled ?? false;
  const widgets = useMemo(() => dashboard?.widgets ?? [], [dashboard]);

  // Suppress re-serialization while user is typing in the code editor
  const isUserEditingCodeRef = useRef(false);
  const queryGeneration = runtimeSession?.queryGeneration ?? 0;

  useEffect(() => {
    if (!workspaceId) return;

    if (isNew && !dashboardId) {
      (async () => {
        const created = await createDashboard(workspaceId, {
          title: "Untitled Dashboard",
          dataSources: [],
          widgets: [],
          relationships: [],
          globalFilters: [],
          crossFilter: {
            enabled: true,
            resolution: "intersect",
            engine: "mosaic",
          },
          layout: { columns: 12, rowHeight: 80 },
          cache: { ttlSeconds: 3600 },
          access: "private",
        } as any);
        if (created) {
          useDashboardStore.setState(state => {
            state.openDashboards[created._id] = created;
            state.activeDashboardId = created._id;
            state.historyMap[created._id] = { stack: [], index: -1 };
          });
          onCreated?.(created._id);
        }
      })();
      return;
    }

    if (dashboardId) {
      openDashboard(workspaceId, dashboardId);
    }
  }, [
    workspaceId,
    dashboardId,
    isNew,
    openDashboard,
    createDashboard,
    onCreated,
  ]);

  useEffect(() => {
    if (!dashboard || !workspaceId || !dashboardId) return;
    void activateDashboardSession(workspaceId, dashboardId);
  }, [dashboard, workspaceId, dashboardId]);

  useEffect(() => {
    if (viewMode === "code" && dashboard && !isUserEditingCodeRef.current) {
      setCodeValue(
        JSON.stringify(serializeDashboardDefinition(dashboard), null, 2),
      );
      setCodeError(null);
    }
  }, [viewMode, dashboard]);

  // When switching to code mode, always serialize fresh
  const prevViewModeRef = useRef(viewMode);
  useEffect(() => {
    if (
      viewMode === "code" &&
      prevViewModeRef.current !== "code" &&
      dashboard
    ) {
      setCodeValue(
        JSON.stringify(serializeDashboardDefinition(dashboard), null, 2),
      );
      setCodeError(null);
    }
    prevViewModeRef.current = viewMode;
  }, [viewMode, dashboard]);

  const handleCodeChange = useCallback(
    (val: string | undefined) => {
      const newVal = val || "";
      setCodeValue(newVal);
      isUserEditingCodeRef.current = true;

      if (!dashboardId) return;

      try {
        const parsed = JSON.parse(newVal);
        const zodError = applyDefinition(dashboardId, parsed);
        if (zodError) {
          setCodeError(formatZodErrors(zodError));
        } else {
          setCodeError(null);
        }
      } catch (e: any) {
        setCodeError(e?.message || "Invalid JSON");
      }

      // Reset the flag after a short delay to allow store-triggered re-renders
      // to not fight with user typing
      setTimeout(() => {
        isUserEditingCodeRef.current = false;
      }, 100);
    },
    [dashboardId, applyDefinition],
  );

  const handleExportPng = useCallback(async () => {
    const gridEl = document.querySelector(".layout") as HTMLElement;
    if (!gridEl) return;
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(gridEl, {
        backgroundColor: null,
        scale: 2,
      });
      const link = document.createElement("a");
      link.download = `${dashboard?.title || "dashboard"}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch {
      // silent
    }
  }, [dashboard?.title]);

  const handleRefresh = useCallback(() => {
    void refreshDashboardCommand(dashboardId);
  }, [dashboardId]);

  const handleReloadData = useCallback(() => {
    if (workspaceId) {
      void reloadDashboardDataSourcesCommand(workspaceId, dashboardId);
    }
  }, [workspaceId, dashboardId]);

  const handleLayoutChange = useCallback(
    (layout: readonly any[], allLayouts?: Record<string, readonly any[]>) => {
      if (!dashboard || !dashboardId) return;

      const layoutToPersist =
        allLayouts?.lg ?? (gridWidth >= 1200 ? layout : undefined);
      if (!layoutToPersist) return;

      for (const item of layoutToPersist) {
        const widget = dashboard.widgets.find(w => w.id === item.i);
        if (widget) {
          const newLayout = { x: item.x, y: item.y, w: item.w, h: item.h };
          if (
            widget.layout.x !== newLayout.x ||
            widget.layout.y !== newLayout.y ||
            widget.layout.w !== newLayout.w ||
            widget.layout.h !== newLayout.h
          ) {
            modifyWidget(dashboardId, widget.id, { layout: newLayout });
          }
        }
      }
    },
    [dashboard, dashboardId, gridWidth, modifyWidget],
  );

  const handleDuplicateWidget = useCallback(
    async (widget: DashboardWidget) => {
      if (!dashboardId) return;
      const { nanoid } = await import("nanoid");
      const newWidget: DashboardWidget = {
        ...widget,
        id: nanoid(),
        title: `${widget.title || "Widget"} (copy)`,
        layout: {
          ...widget.layout,
          y: widget.layout.y + widget.layout.h,
        },
      };
      addWidget(dashboardId, newWidget);
    },
    [dashboardId, addWidget],
  );

  const allSourcesReady = useMemo(() => {
    if (!dashboard) return false;
    if (dashboard.dataSources.length === 0) return true;
    return dashboard.dataSources.every(
      ds => runtimeSession?.dataSources[ds.id]?.status === "ready",
    );
  }, [dashboard, runtimeSession]);

  const isRuntimeInitializing = useMemo(() => {
    if (!dashboard) {
      return false;
    }

    return dashboard.dataSources.length > 0 && !runtimeSession;
  }, [dashboard, runtimeSession]);

  useEffect(() => {
    if (!dashboard || !dashboardId || !allSourcesReady) {
      setMosaicInstance(null);
      return;
    }

    let cancelled = false;
    void getDashboardMosaicInstance(dashboardId)
      .then(instance => {
        if (!cancelled) {
          setMosaicInstance(instance);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMosaicInstance(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dashboard, dashboardId, allSourcesReady]);

  const someSourcesLoading = useMemo(() => {
    if (isRuntimeInitializing) {
      return true;
    }

    return Object.values(runtimeSession?.dataSources || {}).some(
      s => s.status === "loading",
    );
  }, [isRuntimeInitializing, runtimeSession]);

  const loadingSummary = useMemo(() => {
    if (!dashboard) {
      return null;
    }

    if (isRuntimeInitializing) {
      return {
        label: "Initializing dashboard runtime",
        rowsLoaded: 0,
      };
    }

    const loadingSources = dashboard.dataSources.filter(
      ds => runtimeSession?.dataSources[ds.id]?.status === "loading",
    );

    if (loadingSources.length === 0) {
      return null;
    }

    return {
      label:
        loadingSources.length === 1
          ? `Loading ${loadingSources[0].name}`
          : `Loading ${loadingSources.length} data sources`,
      rowsLoaded: loadingSources.reduce(
        (sum, ds) =>
          sum + (runtimeSession?.dataSources[ds.id]?.rowsLoaded || 0),
        0,
      ),
    };
  }, [dashboard, isRuntimeInitializing, runtimeSession]);

  const errorSummary = useMemo(() => {
    if (!dashboard) {
      return null;
    }

    const failingSources = dashboard.dataSources.filter(
      ds => runtimeSession?.dataSources[ds.id]?.status === "error",
    );

    if (failingSources.length === 0) {
      return null;
    }

    const first = failingSources[0];
    return {
      count: failingSources.length,
      message:
        runtimeSession?.dataSources[first.id]?.error ||
        "Failed to load one or more data sources",
    };
  }, [dashboard, runtimeSession]);
  const recentEventLog = useMemo(
    () => runtimeSession?.eventLog.slice(-10).reverse() || [],
    [runtimeSession?.eventLog],
  );

  const gridLayout = useMemo(() => {
    return widgets.map(w => ({
      i: w.id,
      x: w.layout.x,
      y: w.layout.y,
      w: w.layout.w,
      h: w.layout.h,
      minW: w.layout.minW || 2,
      minH: w.layout.minH || 2,
    }));
  }, [widgets]);

  if (!dashboard) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
        }}
      >
        <Typography>Loading dashboard...</Typography>
      </Box>
    );
  }

  const hasCodeError = Boolean(codeError);
  const renderWidget = (widget: DashboardWidget) => {
    if (!runtimeSession) {
      return null;
    }

    const dataSourceRuntime = runtimeSession?.dataSources[widget.dataSourceId];
    if (!dataSourceRuntime || dataSourceRuntime.status !== "ready") {
      return null;
    }

    const widgetCrossFilterEnabled =
      isCrossFilterEnabled && (widget.crossFilter?.enabled ?? true);
    if (!mosaicInstance) {
      return null;
    }

    const widgetRuntime = runtimeSession.widgets[widget.id];
    const refreshGeneration = widgetRuntime?.refreshGeneration ?? 0;

    switch (widget.type) {
      case "chart":
        return (
          <MosaicChart
            dashboardId={dashboard._id}
            widgetId={widget.id}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            vegaLiteSpec={widget.vegaLiteSpec}
            mosaicInstance={mosaicInstance}
            crossFilterEnabled={widgetCrossFilterEnabled}
            crossFilterResolution={crossFilterResolution}
            queryGeneration={queryGeneration}
            refreshGeneration={refreshGeneration}
          />
        );
      case "kpi":
        if (!widget.kpiConfig) {
          return null;
        }
        return (
          <MosaicKpiCard
            dashboardId={dashboard._id}
            widgetId={widget.id}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            kpiConfig={widget.kpiConfig}
            mosaicInstance={mosaicInstance}
            crossFilterEnabled={widgetCrossFilterEnabled}
            crossFilterResolution={crossFilterResolution}
            queryGeneration={queryGeneration}
            refreshGeneration={refreshGeneration}
          />
        );
      case "table":
        return (
          <MosaicDataTable
            dashboardId={dashboard._id}
            widgetId={widget.id}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            tableConfig={widget.tableConfig}
            mosaicInstance={mosaicInstance}
            crossFilterEnabled={widgetCrossFilterEnabled}
            crossFilterResolution={crossFilterResolution}
            queryGeneration={queryGeneration}
            refreshGeneration={refreshGeneration}
          />
        );
      default:
        return null;
    }
  };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Toolbar */}
      <Box
        sx={{
          px: 1.5,
          py: 0.75,
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.default",
          minHeight: 44,
        }}
      >
        {/* Data Sources */}
        <Tooltip title="Manage data sources">
          <Chip
            icon={<Database size={14} />}
            label={`${dashboard.dataSources.length} sources`}
            size="small"
            variant="outlined"
            onClick={() => setDataSourcePanelOpen(true)}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>

        {/* Refresh dashboard: clear filters + rerun widgets */}
        <Tooltip title="Clear filters and rerun all widgets">
          <Chip
            icon={<RefreshCw size={14} />}
            label="Refresh"
            size="small"
            variant="outlined"
            onClick={handleRefresh}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>

        {/* Reload data: re-fetch from source DB */}
        <Tooltip title="Reload data from source database">
          <Chip
            icon={<Database size={14} />}
            label="Reload data"
            size="small"
            variant="outlined"
            onClick={handleReloadData}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>

        {/* Add Widget */}
        <Tooltip title="Add widget">
          <IconButton size="small" onClick={() => setAddWidgetOpen(true)}>
            <Plus size={18} />
          </IconButton>
        </Tooltip>

        {/* Undo / Redo */}
        <Tooltip title="Undo (Cmd+Z)">
          <span>
            <IconButton
              size="small"
              onClick={() => dashboardId && undo(dashboardId)}
              disabled={historyIndex <= 0}
            >
              <Undo2 size={16} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Redo (Cmd+Shift+Z)">
          <span>
            <IconButton
              size="small"
              onClick={() => dashboardId && redo(dashboardId)}
              disabled={historyIndex >= historyLength - 1}
            >
              <Redo2 size={16} />
            </IconButton>
          </span>
        </Tooltip>

        {/* View toggle */}
        <ToggleButtonGroup
          value={viewMode}
          exclusive
          onChange={(_, v) => v && setViewMode(v)}
          size="small"
          sx={{ height: 28 }}
        >
          <ToggleButton value="canvas" sx={{ px: 1, py: 0.25 }}>
            <Tooltip title="Dashboard view">
              <DashboardIcon size={14} />
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="code" sx={{ px: 1, py: 0.25 }}>
            <Tooltip title="Code view (JSON)">
              <Code2 size={14} />
            </Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>

        {/* Export */}
        <Tooltip title="Export">
          <IconButton size="small" onClick={handleExportPng}>
            <Download size={16} />
          </IconButton>
        </Tooltip>

        <Tooltip
          title={hasCodeError ? "Fix JSON errors before saving" : "Save"}
        >
          <span>
            <IconButton
              size="small"
              disabled={viewMode === "code" && hasCodeError}
              onClick={() =>
                workspaceId &&
                dashboardId &&
                saveDashboard(workspaceId, dashboardId)
              }
            >
              <Save size={16} />
            </IconButton>
          </span>
        </Tooltip>

        {/* Settings */}
        <Tooltip title="Dashboard settings">
          <IconButton size="small" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Toggle dashboard event log">
          <Chip
            size="small"
            label={`Logs ${recentEventLog.length}`}
            variant={showEventLog ? "filled" : "outlined"}
            onClick={() => setShowEventLog(prev => !prev)}
            sx={{ cursor: "pointer", ml: "auto" }}
          />
        </Tooltip>
      </Box>

      {/* Loading bar */}
      {someSourcesLoading && (
        <Box sx={{ borderBottom: "1px solid", borderColor: "divider" }}>
          <LinearProgress />
          {loadingSummary && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", px: 1.5, py: 0.5 }}
            >
              {loadingSummary.label}
              {loadingSummary.rowsLoaded > 0 &&
                ` · ${loadingSummary.rowsLoaded.toLocaleString()} rows loaded`}
            </Typography>
          )}
        </Box>
      )}
      {errorSummary && (
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            backgroundColor: "error.light",
            color: "error.contrastText",
          }}
        >
          <Typography variant="caption" sx={{ display: "block" }}>
            {errorSummary.count > 1
              ? `${errorSummary.count} data sources failed.`
              : "Data source failed."}{" "}
            {errorSummary.message}
          </Typography>
        </Box>
      )}
      {showEventLog && recentEventLog.length > 0 && (
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            backgroundColor: "background.paper",
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {recentEventLog.map((entry, index) => (
            <Typography
              key={`${entry.timestamp}-${index}`}
              variant="caption"
              sx={{
                display: "block",
                color:
                  entry.level === "error"
                    ? "error.main"
                    : entry.level === "warn"
                      ? "warning.main"
                      : "text.secondary",
                fontFamily: "monospace",
                mb: 0.5,
              }}
            >
              [{new Date(entry.timestamp).toLocaleTimeString()}] {entry.message}
            </Typography>
          ))}
        </Box>
      )}

      {/* Content area */}
      <Box
        sx={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {/* Main content: Canvas or Code */}
        <Box sx={{ flex: 1, overflow: "auto" }}>
          {viewMode === "canvas" ? (
            <Box ref={gridContainerRef} sx={{ height: "100%" }}>
              {dashboard.widgets.length === 0 ? (
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
                  <Typography variant="body2">No widgets yet.</Typography>
                  {dashboard.dataSources.length === 0 ? (
                    <Tooltip title="Add a data source">
                      <IconButton onClick={() => setDataSourcePanelOpen(true)}>
                        <Database size={16} />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Add a widget">
                      <IconButton onClick={() => setAddWidgetOpen(true)}>
                        <Plus size={16} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              ) : (
                <ResponsiveGridLayout
                  className="layout"
                  width={gridWidth || 800}
                  layouts={{ lg: gridLayout }}
                  breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
                  cols={{ lg: 12, md: 10, sm: 6, xs: 4 }}
                  rowHeight={dashboard.layout?.rowHeight || 80}
                  onLayoutChange={handleLayoutChange}
                  dragConfig={{ handle: ".drag-handle" }}
                >
                  {dashboard.widgets.map(widget => (
                    <div key={widget.id}>
                      {(() => {
                        const widgetRuntime =
                          runtimeSession?.widgets[widget.id];
                        const widgetError =
                          widgetRuntime?.queryError ||
                          widgetRuntime?.renderError;
                        return (
                          <WidgetContainer
                            title={widget.title}
                            loading={!allSourcesReady}
                            error={widgetError || undefined}
                            onRefresh={() =>
                              dashboardId &&
                              refreshDashboardWidgetCommand({
                                dashboardId,
                                widgetId: widget.id,
                              })
                            }
                            onRemove={() =>
                              dashboardId &&
                              removeWidget(dashboardId, widget.id)
                            }
                            onDuplicate={() => handleDuplicateWidget(widget)}
                            onInspect={() => setInspectedWidget(widget)}
                          >
                            {renderWidget(widget)}
                          </WidgetContainer>
                        );
                      })()}
                    </div>
                  ))}
                </ResponsiveGridLayout>
              )}
            </Box>
          ) : (
            /* Code View */
            <Box
              sx={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Box
                sx={{
                  px: 1.5,
                  py: 0.5,
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  backgroundColor: "background.paper",
                }}
              >
                <Typography variant="caption" color="text.secondary">
                  Dashboard Definition (JSON)
                </Typography>
                <Box sx={{ flex: 1 }} />
                {codeError && (
                  <Typography variant="caption" color="error">
                    {codeError}
                  </Typography>
                )}
              </Box>
              <Box sx={{ flex: 1 }}>
                <Editor
                  height="100%"
                  language="json"
                  value={codeValue}
                  onChange={handleCodeChange}
                  theme={effectiveMode === "dark" ? "vs-dark" : "light"}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 12,
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    formatOnPaste: true,
                    tabSize: 2,
                  }}
                />
              </Box>
            </Box>
          )}
        </Box>

        {/* Widget Inspector (side panel) */}
        {inspectedWidget && (
          <WidgetInspector
            widget={inspectedWidget}
            dashboardId={dashboardId}
            onClose={() => setInspectedWidget(null)}
          />
        )}
      </Box>

      {/* Panels & Dialogs */}
      <DataSourcePanel
        open={dataSourcePanelOpen}
        onClose={() => setDataSourcePanelOpen(false)}
        dashboardId={dashboardId}
      />
      <AddWidgetDialog
        open={addWidgetOpen}
        onClose={() => setAddWidgetOpen(false)}
        dashboardId={dashboardId}
      />
      <DashboardSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        dashboardId={dashboardId}
      />
    </Box>
  );
};

export default DashboardCanvas;
