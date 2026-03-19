import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  TextField,
  Chip,
  LinearProgress,
  ToggleButton,
  ToggleButtonGroup,
  Button,
} from "@mui/material";
import {
  RefreshCw,
  Save,
  Download,
  FileImage,
  Database,
  Plus,
  Settings,
  Undo2,
  Redo2,
  LayoutGrid,
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
import { initDuckDB } from "../lib/duckdb";
import WidgetContainer from "./widgets/WidgetContainer";
import ChartWidget from "./widgets/ChartWidget";
import KpiCard from "./widgets/KpiCard";
import DataTableWidget from "./widgets/DataTableWidget";
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

const DashboardCanvas: React.FC<DashboardCanvasProps> = ({
  dashboardId,
  isNew,
  onCreated,
}) => {
  const { currentWorkspace } = useWorkspace();
  const { effectiveMode } = useTheme();
  const {
    activeDashboard,
    openDashboard,
    saveDashboard,
    addWidget,
    modifyWidget,
    removeWidget,
    undo,
    redo,
    db,
    setDb,
    dataSourceStatus,
    loadDataSource,
    refreshAllDataSources,
  } = useDashboardStore();

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const [widgetErrors, setWidgetErrors] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [codeValue, setCodeValue] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [dataSourcePanelOpen, setDataSourcePanelOpen] = useState(false);
  const [addWidgetOpen, setAddWidgetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectedWidget, setInspectedWidget] =
    useState<DashboardWidget | null>(null);

  const { width: gridWidth, containerRef: gridContainerRef } =
    useContainerWidth();

  const workspaceId = currentWorkspace?.id;
  const { createDashboard } = useDashboardStore();

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
          crossFilter: { enabled: true, resolution: "intersect" },
          layout: { columns: 12, rowHeight: 80 },
          cache: { ttlSeconds: 3600 },
          access: "private",
        } as any);
        if (created) {
          useDashboardStore.setState({
            activeDashboardId: created._id,
            activeDashboard: created,
            dataSourceStatus: {},
            history: [],
            historyIndex: -1,
          });
          onCreated?.(created._id);
        }
      })();
      return;
    }

    if (dashboardId) {
      openDashboard(workspaceId, dashboardId);
    }
  }, [workspaceId, dashboardId, isNew, openDashboard, createDashboard]);

  useEffect(() => {
    if (activeDashboard) {
      setTitleValue(activeDashboard.title);
    }
  }, [activeDashboard?.title]);

  useEffect(() => {
    if (!activeDashboard || !workspaceId) return;
    let cancelled = false;

    (async () => {
      const duckdb = await initDuckDB();
      if (cancelled) return;
      setDb(duckdb);

      for (const ds of activeDashboard.dataSources) {
        if (!cancelled) {
          await loadDataSource(ds, workspaceId);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeDashboard?._id, workspaceId]);

  // Sync code view when switching to code mode
  useEffect(() => {
    if (viewMode === "code" && activeDashboard) {
      setCodeValue(JSON.stringify(activeDashboard, null, 2));
      setCodeError(null);
    }
  }, [viewMode, activeDashboard?._id]);

  const handleTitleSave = useCallback(() => {
    setEditingTitle(false);
    if (
      activeDashboard &&
      workspaceId &&
      titleValue !== activeDashboard.title
    ) {
      useDashboardStore
        .getState()
        .updateDashboard(workspaceId, activeDashboard._id, {
          title: titleValue,
        });
      useDashboardStore.setState(prev => ({
        ...prev,
        activeDashboard: prev.activeDashboard
          ? { ...prev.activeDashboard, title: titleValue }
          : prev.activeDashboard,
      }));
    }
  }, [activeDashboard, workspaceId, titleValue]);

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
      link.download = `${activeDashboard?.title || "dashboard"}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch {
      // silent
    }
  }, [activeDashboard?.title]);

  const handleRefresh = useCallback(() => {
    if (workspaceId) {
      refreshAllDataSources(workspaceId);
    }
  }, [workspaceId, refreshAllDataSources]);

  const handleLayoutChange = useCallback(
    (layout: readonly any[]) => {
      if (!activeDashboard) return;
      for (const item of layout) {
        const widget = activeDashboard.widgets.find(w => w.id === item.i);
        if (widget) {
          const newLayout = { x: item.x, y: item.y, w: item.w, h: item.h };
          if (
            widget.layout.x !== newLayout.x ||
            widget.layout.y !== newLayout.y ||
            widget.layout.w !== newLayout.w ||
            widget.layout.h !== newLayout.h
          ) {
            modifyWidget(widget.id, { layout: newLayout });
          }
        }
      }
    },
    [activeDashboard, modifyWidget],
  );

  const handleCodeSave = useCallback(() => {
    if (!workspaceId || !activeDashboard) return;
    try {
      const parsed = JSON.parse(codeValue);
      useDashboardStore.setState(prev => ({
        ...prev,
        activeDashboard: { ...prev.activeDashboard!, ...parsed },
      }));
      useDashboardStore.getState().saveDashboard(workspaceId);
      setCodeError(null);
    } catch (e: any) {
      setCodeError(e?.message || "Invalid JSON");
    }
  }, [codeValue, workspaceId, activeDashboard]);

  const handleDuplicateWidget = useCallback(
    async (widget: DashboardWidget) => {
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
      addWidget(newWidget);
    },
    [addWidget],
  );

  const allSourcesReady = useMemo(() => {
    if (!activeDashboard) return false;
    if (activeDashboard.dataSources.length === 0) return true;
    return activeDashboard.dataSources.every(
      ds => dataSourceStatus[ds.id] === "ready",
    );
  }, [activeDashboard, dataSourceStatus]);

  const someSourcesLoading = useMemo(() => {
    return Object.values(dataSourceStatus).some(s => s === "loading");
  }, [dataSourceStatus]);

  const gridLayout = useMemo(() => {
    if (!activeDashboard) return [];
    return activeDashboard.widgets.map(w => ({
      i: w.id,
      x: w.layout.x,
      y: w.layout.y,
      w: w.layout.w,
      h: w.layout.h,
      minW: w.layout.minW || 2,
      minH: w.layout.minH || 2,
    }));
  }, [activeDashboard?.widgets]);

  if (!activeDashboard) {
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

  const renderWidget = (widget: DashboardWidget) => {
    if (!db || !allSourcesReady) return null;

    switch (widget.type) {
      case "chart":
        return (
          <ChartWidget
            db={db}
            localSql={widget.localSql}
            vegaLiteSpec={widget.vegaLiteSpec}
            onError={err =>
              setWidgetErrors(prev => ({ ...prev, [widget.id]: err }))
            }
          />
        );
      case "kpi":
        return widget.kpiConfig ? (
          <KpiCard
            db={db}
            localSql={widget.localSql}
            kpiConfig={widget.kpiConfig}
            onError={err =>
              setWidgetErrors(prev => ({ ...prev, [widget.id]: err }))
            }
          />
        ) : null;
      case "table":
        return (
          <DataTableWidget
            db={db}
            localSql={widget.localSql}
            tableConfig={widget.tableConfig}
            onError={err =>
              setWidgetErrors(prev => ({ ...prev, [widget.id]: err }))
            }
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
        {/* Title */}
        {editingTitle ? (
          <TextField
            value={titleValue}
            onChange={e => setTitleValue(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={e => {
              if (e.key === "Enter") handleTitleSave();
              if (e.key === "Escape") {
                setEditingTitle(false);
                setTitleValue(activeDashboard.title);
              }
            }}
            size="small"
            autoFocus
            sx={{ maxWidth: 280 }}
          />
        ) : (
          <Tooltip title="Click to rename">
            <Typography
              variant="subtitle2"
              sx={{
                fontWeight: 600,
                cursor: "pointer",
                "&:hover": { color: "primary.main" },
                maxWidth: 280,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              onClick={() => setEditingTitle(true)}
            >
              {activeDashboard.title}
            </Typography>
          </Tooltip>
        )}

        <Box sx={{ flex: 1 }} />

        {/* Data Sources */}
        <Tooltip title="Manage data sources">
          <Chip
            icon={<Database size={14} />}
            label={`${activeDashboard.dataSources.length} sources`}
            size="small"
            variant="outlined"
            onClick={() => setDataSourcePanelOpen(true)}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>

        {/* Add Widget */}
        <Tooltip title="Add widget">
          <IconButton size="small" onClick={() => setAddWidgetOpen(true)}>
            <Plus size={18} />
          </IconButton>
        </Tooltip>

        {/* Divider */}
        <Box
          sx={{
            width: 1,
            height: 20,
            backgroundColor: "divider",
            mx: 0.25,
          }}
        />

        {/* Undo / Redo */}
        <Tooltip title="Undo (Cmd+Z)">
          <span>
            <IconButton
              size="small"
              onClick={undo}
              disabled={useDashboardStore.getState().historyIndex <= 0}
            >
              <Undo2 size={16} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Redo (Cmd+Shift+Z)">
          <span>
            <IconButton
              size="small"
              onClick={redo}
              disabled={
                useDashboardStore.getState().historyIndex >=
                useDashboardStore.getState().history.length - 1
              }
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
            <Tooltip title="Canvas view">
              <LayoutGrid size={14} />
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="code" sx={{ px: 1, py: 0.25 }}>
            <Tooltip title="Code view (JSON)">
              <Code2 size={14} />
            </Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>

        {/* Divider */}
        <Box
          sx={{
            width: 1,
            height: 20,
            backgroundColor: "divider",
            mx: 0.25,
          }}
        />

        {/* Export */}
        <Tooltip title="Export PNG">
          <IconButton size="small" onClick={handleExportPng}>
            <FileImage size={16} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Export PDF">
          <IconButton size="small" onClick={handleExportPng}>
            <Download size={16} />
          </IconButton>
        </Tooltip>

        {/* Refresh & Save */}
        <Tooltip title="Refresh all data">
          <IconButton size="small" onClick={handleRefresh}>
            <RefreshCw size={16} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Save">
          <IconButton
            size="small"
            onClick={() => workspaceId && saveDashboard(workspaceId)}
          >
            <Save size={16} />
          </IconButton>
        </Tooltip>

        {/* Settings */}
        <Tooltip title="Dashboard settings">
          <IconButton size="small" onClick={() => setSettingsOpen(true)}>
            <Settings size={16} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Loading bar */}
      {someSourcesLoading && <LinearProgress />}

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
            <Box ref={gridContainerRef} sx={{ height: "100%", p: 1 }}>
              {activeDashboard.widgets.length === 0 ? (
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
                  {activeDashboard.dataSources.length === 0 ? (
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<Database size={16} />}
                      onClick={() => setDataSourcePanelOpen(true)}
                    >
                      Add a data source
                    </Button>
                  ) : (
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<Plus size={16} />}
                      onClick={() => setAddWidgetOpen(true)}
                    >
                      Add a widget
                    </Button>
                  )}
                </Box>
              ) : (
                <ResponsiveGridLayout
                  className="layout"
                  width={gridWidth || 800}
                  layouts={{ lg: gridLayout }}
                  breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
                  cols={{ lg: 12, md: 10, sm: 6, xs: 4 }}
                  rowHeight={activeDashboard.layout?.rowHeight || 80}
                  onLayoutChange={handleLayoutChange}
                  dragConfig={{ handle: ".drag-handle" }}
                >
                  {activeDashboard.widgets.map(widget => (
                    <div key={widget.id}>
                      <WidgetContainer
                        title={widget.title}
                        loading={!allSourcesReady}
                        error={widgetErrors[widget.id]}
                        onRemove={() => removeWidget(widget.id)}
                        onDuplicate={() => handleDuplicateWidget(widget)}
                        onInspect={() => setInspectedWidget(widget)}
                      >
                        {renderWidget(widget)}
                      </WidgetContainer>
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
                  Dashboard JSON Spec
                </Typography>
                <Box sx={{ flex: 1 }} />
                {codeError && (
                  <Typography variant="caption" color="error">
                    {codeError}
                  </Typography>
                )}
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleCodeSave}
                  sx={{ textTransform: "none", fontSize: 12 }}
                >
                  Apply Changes
                </Button>
              </Box>
              <Box sx={{ flex: 1 }}>
                <Editor
                  height="100%"
                  language="json"
                  value={codeValue}
                  onChange={val => setCodeValue(val || "")}
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
            onClose={() => setInspectedWidget(null)}
          />
        )}
      </Box>

      {/* Panels & Dialogs */}
      <DataSourcePanel
        open={dataSourcePanelOpen}
        onClose={() => setDataSourcePanelOpen(false)}
      />
      <AddWidgetDialog
        open={addWidgetOpen}
        onClose={() => setAddWidgetOpen(false)}
      />
      <DashboardSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </Box>
  );
};

export default DashboardCanvas;
