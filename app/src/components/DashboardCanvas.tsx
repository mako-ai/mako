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
  Button,
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
  executeDashboardSql,
  getDashboardMosaicInstance,
  refreshAllDashboardDataSourcesCommand,
} from "../dashboard-runtime/commands";
import { useDashboardRuntimeStore } from "../dashboard-runtime/store";
import type {
  DashboardQueryExecutor,
  DashboardRuntimeStatus,
} from "../dashboard-runtime/types";
import type { MosaicInstance } from "../lib/mosaic";
import type { CrossFilterSelection } from "./ResultsChart";
import WidgetContainer from "./widgets/WidgetContainer";
import ChartWidget from "./widgets/ChartWidget";
import KpiCard from "./widgets/KpiCard";
import DataTableWidget from "./widgets/DataTableWidget";
import MosaicChart from "./widgets/MosaicChart";
import MosaicKpiCard from "./widgets/MosaicKpiCard";
import MosaicDataTable from "./widgets/MosaicDataTable";
import DataSourcePanel from "./dashboard/DataSourcePanel";
import AddWidgetDialog from "./dashboard/AddWidgetDialog";
import DashboardSettingsDialog from "./dashboard/DashboardSettingsDialog";
import WidgetInspector from "./dashboard/WidgetInspector";

interface ActiveCrossFilter extends CrossFilterSelection {
  dataSourceId: string;
}

function resolveFilterField(
  selectedField: string,
  availableFields: string[],
): string | null {
  if (!selectedField) return null;
  if (availableFields.length === 0) return selectedField;

  const lowerSelected = selectedField.toLowerCase();
  const lowerFields = availableFields.map(f => f.toLowerCase());

  // 1) Exact match
  const exactIdx = lowerFields.indexOf(lowerSelected);
  if (exactIdx >= 0) return availableFields[exactIdx];

  // 2) Common convention matches: *_field, field_*, field_code, *_field_code
  const conventionMatches = availableFields.filter(field => {
    const lf = field.toLowerCase();
    return (
      lf.endsWith(`_${lowerSelected}`) ||
      lf.startsWith(`${lowerSelected}_`) ||
      lf === `${lowerSelected}_code` ||
      lf.endsWith(`_${lowerSelected}_code`)
    );
  });
  if (conventionMatches.length === 1) return conventionMatches[0];

  // 3) Token match fallback (shortest candidate wins)
  const tokenMatches = availableFields.filter(field =>
    field
      .toLowerCase()
      .split("_")
      .some(token => token === lowerSelected),
  );
  if (tokenMatches.length > 0) {
    return [...tokenMatches].sort((a, b) => a.length - b.length)[0];
  }

  return null;
}

function buildSqlClause(
  sel: CrossFilterSelection,
  targetField: string,
): string {
  const esc = (v: unknown) => {
    if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
    if (v instanceof Date) return `'${v.toISOString()}'`;
    return String(v);
  };

  if (sel.type === "point") {
    if (sel.values.length === 0) return "";
    if (sel.values.length === 1) {
      return `"${targetField}" = ${esc(sel.values[0])}`;
    }
    return `"${targetField}" IN (${sel.values.map(esc).join(", ")})`;
  }

  if (sel.type === "interval" && sel.values.length === 2) {
    return `"${targetField}" >= ${esc(sel.values[0])} AND "${targetField}" <= ${esc(sel.values[1])}`;
  }

  return "";
}

type ViewMode = "canvas" | "code";

interface DashboardCanvasProps {
  dashboardId?: string;
  isNew?: boolean;
  onCreated?: (dashboardId: string) => void;
}

function shouldClearTransientWidgetError(
  error: string,
  runtimeStatus: DashboardRuntimeStatus | undefined,
  hasRuntimeSession: boolean,
): boolean {
  if (error === "Dashboard runtime session is not initialized") {
    return hasRuntimeSession;
  }

  if (
    error.includes("is not materialized yet") ||
    error.includes("is still loading")
  ) {
    return runtimeStatus === "loading" || runtimeStatus === "ready";
  }

  return false;
}

const DashboardCanvas: React.FC<DashboardCanvasProps> = ({
  dashboardId,
  isNew,
  onCreated,
}) => {
  const { currentWorkspace } = useWorkspace();
  const { effectiveMode } = useTheme();
  const activeDashboard = useDashboardStore(state => state.activeDashboard);
  const openDashboard = useDashboardStore(state => state.openDashboard);
  const saveDashboard = useDashboardStore(state => state.saveDashboard);
  const createDashboard = useDashboardStore(state => state.createDashboard);
  const addWidget = useDashboardStore(state => state.addWidget);
  const modifyWidget = useDashboardStore(state => state.modifyWidget);
  const removeWidget = useDashboardStore(state => state.removeWidget);
  const undo = useDashboardStore(state => state.undo);
  const redo = useDashboardStore(state => state.redo);
  const historyIndex = useDashboardStore(state => state.historyIndex);
  const historyLength = useDashboardStore(state => state.history.length);
  const runtimeSession = useDashboardRuntimeStore(state =>
    activeDashboard ? state.sessions[activeDashboard._id] || null : null,
  );

  const [widgetErrors, setWidgetErrors] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [codeValue, setCodeValue] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [dataSourcePanelOpen, setDataSourcePanelOpen] = useState(false);
  const [addWidgetOpen, setAddWidgetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectedWidget, setInspectedWidget] =
    useState<DashboardWidget | null>(null);
  const [crossFilterMap, setCrossFilterMap] = useState<
    Record<string, ActiveCrossFilter>
  >({});
  const [mosaicInstance, setMosaicInstance] = useState<MosaicInstance | null>(
    null,
  );

  const { width: gridWidth, containerRef: gridContainerRef } =
    useContainerWidth();

  const workspaceId = currentWorkspace?.id;
  const widgetErrorHandlersRef = useRef<
    Record<string, (error: string) => void>
  >({});
  const selectionHandlersRef = useRef<
    Record<string, (sel: CrossFilterSelection | null) => void>
  >({});
  const queryExecutor = useCallback<DashboardQueryExecutor>(
    (sql, options) =>
      executeDashboardSql({
        sql,
        dataSourceId: options?.dataSourceId,
      }),
    [],
  );

  const getWidgetErrorHandler = useCallback((widgetId: string) => {
    const existing = widgetErrorHandlersRef.current[widgetId];
    if (existing) {
      return existing;
    }

    const handler = (error: string) => {
      setWidgetErrors(prev =>
        prev[widgetId] === error ? prev : { ...prev, [widgetId]: error },
      );
    };
    widgetErrorHandlersRef.current[widgetId] = handler;
    return handler;
  }, []);

  const getWidgetSelectionHandler = useCallback(
    (widgetId: string, dataSourceId: string) => {
      const key = `${widgetId}:${dataSourceId}`;
      const existing = selectionHandlersRef.current[key];
      if (existing) return existing;

      const handler = (selection: CrossFilterSelection | null) => {
        setCrossFilterMap(
          (
            prev: Record<string, ActiveCrossFilter>,
          ): Record<string, ActiveCrossFilter> => {
            if (!selection) {
              if (!(widgetId in prev)) return prev;
              const next = { ...prev };
              delete next[widgetId];
              return next;
            }
            return { ...prev, [widgetId]: { ...selection, dataSourceId } };
          },
        );
      };
      selectionHandlersRef.current[key] = handler;
      return handler;
    },
    [],
  );

  const crossFilterEngine = activeDashboard?.crossFilter?.engine ?? "mosaic";
  const useMosaic = crossFilterEngine === "mosaic";

  const widgetFilterClauses = useMemo(() => {
    if (useMosaic) return {};
    if (!activeDashboard?.crossFilter?.enabled) return {};

    const result: Record<string, string> = {};
    for (const widget of activeDashboard.widgets) {
      if (widget.crossFilter && !widget.crossFilter.enabled) continue;

      const clauses: string[] = [];
      const schemaFields =
        runtimeSession?.dataSources[widget.dataSourceId]?.schema?.map(
          col => col.name,
        ) ?? [];
      for (const [sourceId, filter] of Object.entries(crossFilterMap)) {
        if (sourceId === widget.id) continue;
        if (filter.dataSourceId !== widget.dataSourceId) continue;
        const resolvedField = resolveFilterField(filter.field, schemaFields);
        if (!resolvedField) continue;
        const clause = buildSqlClause(filter, resolvedField);
        if (clause) clauses.push(clause);
      }
      if (clauses.length > 0) {
        result[widget.id] = clauses.join(" AND ");
      }
    }
    return result;
  }, [
    useMosaic,
    activeDashboard?.crossFilter?.enabled,
    activeDashboard?.widgets,
    crossFilterMap,
    runtimeSession?.dataSources,
  ]);

  useEffect(() => {
    if (!activeDashboard) {
      widgetErrorHandlersRef.current = {};
      selectionHandlersRef.current = {};
      setWidgetErrors({});
      setCrossFilterMap({});
      return;
    }

    const widgetById = new Map(
      activeDashboard.widgets.map(widget => [widget.id, widget]),
    );
    const activeWidgetIds = new Set(widgetById.keys());
    const hasRuntimeSession = Boolean(runtimeSession);

    setWidgetErrors(prev => {
      let changed = false;
      const next: Record<string, string> = {};

      for (const [widgetId, error] of Object.entries(prev)) {
        const widget = widgetById.get(widgetId);
        if (!widget) {
          changed = true;
          continue;
        }

        const runtimeStatus =
          runtimeSession?.dataSources[widget.dataSourceId]?.status;
        if (
          shouldClearTransientWidgetError(
            error,
            runtimeStatus,
            hasRuntimeSession,
          )
        ) {
          changed = true;
          continue;
        }

        next[widgetId] = error;
      }

      return changed ? next : prev;
    });

    for (const widgetId of Object.keys(widgetErrorHandlersRef.current)) {
      if (!activeWidgetIds.has(widgetId)) {
        delete widgetErrorHandlersRef.current[widgetId];
      }
    }

    for (const key of Object.keys(selectionHandlersRef.current)) {
      const wId = key.split(":")[0];
      if (!activeWidgetIds.has(wId)) {
        delete selectionHandlersRef.current[key];
      }
    }

    setCrossFilterMap(prev => {
      const stale = Object.keys(prev).filter(id => !activeWidgetIds.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [activeDashboard, runtimeSession]);

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
    if (!activeDashboard || !workspaceId) return;
    void activateDashboardSession(workspaceId);
  }, [activeDashboard?._id, workspaceId]);

  const allSourcesReady = useMemo(() => {
    if (!activeDashboard) return false;
    if (activeDashboard.dataSources.length === 0) return true;
    return activeDashboard.dataSources.every(
      ds => runtimeSession?.dataSources[ds.id]?.status === "ready",
    );
  }, [activeDashboard, runtimeSession]);

  useEffect(() => {
    if (!useMosaic || !allSourcesReady || !activeDashboard) {
      setMosaicInstance(null);
      return;
    }
    let cancelled = false;
    void getDashboardMosaicInstance(activeDashboard._id).then(instance => {
      if (!cancelled) setMosaicInstance(instance);
    });
    return () => {
      cancelled = true;
    };
  }, [useMosaic, allSourcesReady, activeDashboard?._id]);

  // Sync code view when switching to code mode
  useEffect(() => {
    if (viewMode === "code" && activeDashboard) {
      setCodeValue(JSON.stringify(activeDashboard, null, 2));
      setCodeError(null);
    }
  }, [viewMode, activeDashboard?._id]);

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
      void refreshAllDashboardDataSourcesCommand(workspaceId);
    }
  }, [workspaceId]);

  const handleLayoutChange = useCallback(
    (layout: readonly any[], allLayouts?: Record<string, readonly any[]>) => {
      if (!activeDashboard) return;

      // Persist only the canonical desktop layout.
      // Responsive breakpoints can compact/reflow items; saving those coordinates
      // would overwrite the original positions and prevent restoration on expand.
      const layoutToPersist =
        allLayouts?.lg ?? (gridWidth >= 1200 ? layout : undefined);
      if (!layoutToPersist) return;

      for (const item of layoutToPersist) {
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
    [activeDashboard, gridWidth, modifyWidget],
  );

  const handleCodeSave = useCallback(() => {
    if (!workspaceId || !activeDashboard) return;
    try {
      const parsed = JSON.parse(codeValue);
      useDashboardStore.setState(state => ({
        activeDashboard: state.activeDashboard
          ? { ...state.activeDashboard, ...parsed }
          : state.activeDashboard,
      }));
      void saveDashboard(workspaceId);
      setCodeError(null);
    } catch (e: any) {
      setCodeError(e?.message || "Invalid JSON");
    }
  }, [activeDashboard, codeValue, saveDashboard, workspaceId]);

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

  const isRuntimeInitializing = useMemo(() => {
    if (!activeDashboard) {
      return false;
    }

    return activeDashboard.dataSources.length > 0 && !runtimeSession;
  }, [activeDashboard, runtimeSession]);

  const someSourcesLoading = useMemo(() => {
    if (isRuntimeInitializing) {
      return true;
    }

    return Object.values(runtimeSession?.dataSources || {}).some(
      s => s.status === "loading",
    );
  }, [isRuntimeInitializing, runtimeSession]);

  const loadingSummary = useMemo(() => {
    if (!activeDashboard) {
      return null;
    }

    if (isRuntimeInitializing) {
      return {
        label: "Initializing dashboard runtime",
        rowsLoaded: 0,
      };
    }

    const loadingSources = activeDashboard.dataSources.filter(
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
  }, [activeDashboard, isRuntimeInitializing, runtimeSession]);

  const errorSummary = useMemo(() => {
    if (!activeDashboard) {
      return null;
    }

    const failingSources = activeDashboard.dataSources.filter(
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
  }, [activeDashboard, runtimeSession]);

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

  const isCrossFilterEnabled = activeDashboard.crossFilter?.enabled ?? false;

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

    if (useMosaic && mosaicInstance) {
      switch (widget.type) {
        case "chart":
          return (
            <MosaicChart
              queryExecutor={queryExecutor}
              widgetId={widget.id}
              tableName={dataSourceRuntime.tableRef}
              localSql={widget.localSql}
              vegaLiteSpec={widget.vegaLiteSpec}
              mosaicInstance={mosaicInstance}
              crossFilterEnabled={widgetCrossFilterEnabled}
              onError={getWidgetErrorHandler(widget.id)}
            />
          );
        case "kpi":
          return widget.kpiConfig ? (
            <MosaicKpiCard
              widgetId={widget.id}
              localSql={widget.localSql}
              kpiConfig={widget.kpiConfig}
              mosaicInstance={mosaicInstance}
              crossFilterEnabled={widgetCrossFilterEnabled}
              onError={getWidgetErrorHandler(widget.id)}
            />
          ) : null;
        case "table":
          return (
            <MosaicDataTable
              widgetId={widget.id}
              localSql={widget.localSql}
              tableConfig={widget.tableConfig}
              mosaicInstance={mosaicInstance}
              crossFilterEnabled={widgetCrossFilterEnabled}
              onError={getWidgetErrorHandler(widget.id)}
            />
          );
        default:
          return null;
      }
    }

    const filterClause = widgetFilterClauses[widget.id];

    switch (widget.type) {
      case "chart":
        return (
          <ChartWidget
            queryExecutor={queryExecutor}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            vegaLiteSpec={widget.vegaLiteSpec}
            onError={getWidgetErrorHandler(widget.id)}
            layoutSignature={`${widget.layout.x}:${widget.layout.y}:${widget.layout.w}:${widget.layout.h}`}
            enableCrossFilter={widgetCrossFilterEnabled}
            filterClause={filterClause}
            onSelectionChange={
              widgetCrossFilterEnabled
                ? getWidgetSelectionHandler(widget.id, widget.dataSourceId)
                : undefined
            }
          />
        );
      case "kpi":
        return widget.kpiConfig ? (
          <KpiCard
            queryExecutor={queryExecutor}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            kpiConfig={widget.kpiConfig}
            onError={getWidgetErrorHandler(widget.id)}
            filterClause={filterClause}
          />
        ) : null;
      case "table":
        return (
          <DataTableWidget
            queryExecutor={queryExecutor}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            tableConfig={widget.tableConfig}
            onError={getWidgetErrorHandler(widget.id)}
            filterClause={filterClause}
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
            label={`${activeDashboard.dataSources.length} sources`}
            size="small"
            variant="outlined"
            onClick={() => setDataSourcePanelOpen(true)}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>

        {/* Refresh Sources */}
        <Tooltip title="Refresh all data sources">
          <IconButton size="small" onClick={handleRefresh}>
            <RefreshCw size={16} />
          </IconButton>
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
              onClick={undo}
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
              onClick={redo}
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
