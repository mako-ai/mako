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
  executeDashboardSql,
  refreshAllDashboardDataSourcesCommand,
} from "../dashboard-runtime/commands";
import { useDashboardRuntimeStore } from "../dashboard-runtime/store";
import {
  serializeDashboardDefinition,
  type DashboardQueryExecutor,
  type DashboardRuntimeStatus,
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

  const exactIdx = lowerFields.indexOf(lowerSelected);
  if (exactIdx >= 0) return availableFields[exactIdx];

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

  const [widgetErrors, setWidgetErrors] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [codeValue, setCodeValue] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [dataSourcePanelOpen, setDataSourcePanelOpen] = useState(false);
  const [addWidgetOpen, setAddWidgetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectedWidget, setInspectedWidget] =
    useState<DashboardWidget | null>(null);
  const [mosaicInstance, setMosaicInstance] = useState<MosaicInstance | null>(
    null,
  );
  const [crossFilterMap, setCrossFilterMap] = useState<
    Record<string, ActiveCrossFilter>
  >({});

  const { width: gridWidth, containerRef: gridContainerRef } =
    useContainerWidth();

  const workspaceId = currentWorkspace?.id;
  const crossFilterEngine = dashboard?.crossFilter.engine ?? "mosaic";
  const crossFilterResolution =
    dashboard?.crossFilter.resolution ?? "intersect";
  const isCrossFilterEnabled = dashboard?.crossFilter.enabled ?? false;
  const widgets = useMemo(() => dashboard?.widgets ?? [], [dashboard]);
  const widgetErrorHandlersRef = useRef<
    Record<string, (error: string) => void>
  >({});
  const selectionHandlersRef = useRef<
    Record<string, (sel: CrossFilterSelection | null) => void>
  >({});

  // Suppress re-serialization while user is typing in the code editor
  const isUserEditingCodeRef = useRef(false);

  const queryExecutor = useCallback<DashboardQueryExecutor>(
    (sql, options) =>
      executeDashboardSql({
        sql,
        dataSourceId: options?.dataSourceId,
        dashboardId,
      }),
    [dashboardId],
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

  const widgetFilterClauses = useMemo(() => {
    if (!isCrossFilterEnabled || crossFilterEngine !== "legacy") {
      return {};
    }

    const result: Record<string, string> = {};
    for (const widget of widgets) {
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
    crossFilterEngine,
    isCrossFilterEnabled,
    widgets,
    crossFilterMap,
    runtimeSession?.dataSources,
  ]);

  useEffect(() => {
    if (!dashboard) {
      widgetErrorHandlersRef.current = {};
      selectionHandlersRef.current = {};
      setWidgetErrors({});
      setMosaicInstance(null);
      setCrossFilterMap({});
      return;
    }

    const widgetById = new Map(
      dashboard.widgets.map(widget => [widget.id, widget]),
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
  }, [dashboard, runtimeSession]);

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
  }, [dashboard?._id, workspaceId, dashboardId]);

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
    if (workspaceId) {
      void refreshAllDashboardDataSourcesCommand(workspaceId, dashboardId);
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
    const dashboardEngine = dashboard?.crossFilter.engine ?? "mosaic";
    if (
      !dashboard ||
      !dashboardId ||
      dashboardEngine !== "mosaic" ||
      !allSourcesReady
    ) {
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
  }, [
    dashboard?._id,
    dashboard?.crossFilter.engine,
    dashboardId,
    allSourcesReady,
  ]);

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
    const filterClause =
      crossFilterEngine === "legacy"
        ? widgetFilterClauses[widget.id]
        : undefined;

    if (crossFilterEngine === "mosaic" && !mosaicInstance) {
      return null;
    }

    switch (widget.type) {
      case "chart":
        if (crossFilterEngine === "mosaic") {
          return (
            <MosaicChart
              widgetId={widget.id}
              dataSourceId={widget.dataSourceId}
              localSql={widget.localSql}
              vegaLiteSpec={widget.vegaLiteSpec}
              mosaicInstance={mosaicInstance}
              crossFilterEnabled={widgetCrossFilterEnabled}
              crossFilterResolution={crossFilterResolution}
              onError={getWidgetErrorHandler(widget.id)}
            />
          );
        }
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
        if (!widget.kpiConfig) {
          return null;
        }
        if (crossFilterEngine === "mosaic") {
          return (
            <MosaicKpiCard
              widgetId={widget.id}
              dataSourceId={widget.dataSourceId}
              localSql={widget.localSql}
              kpiConfig={widget.kpiConfig}
              mosaicInstance={mosaicInstance}
              crossFilterEnabled={widgetCrossFilterEnabled}
              crossFilterResolution={crossFilterResolution}
              onError={getWidgetErrorHandler(widget.id)}
            />
          );
        }
        return (
          <KpiCard
            queryExecutor={queryExecutor}
            dataSourceId={widget.dataSourceId}
            localSql={widget.localSql}
            kpiConfig={widget.kpiConfig}
            onError={getWidgetErrorHandler(widget.id)}
            filterClause={filterClause}
          />
        );
      case "table":
        if (crossFilterEngine === "mosaic") {
          return (
            <MosaicDataTable
              widgetId={widget.id}
              dataSourceId={widget.dataSourceId}
              localSql={widget.localSql}
              tableConfig={widget.tableConfig}
              mosaicInstance={mosaicInstance}
              crossFilterEnabled={widgetCrossFilterEnabled}
              crossFilterResolution={crossFilterResolution}
              onError={getWidgetErrorHandler(widget.id)}
            />
          );
        }
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
            label={`${dashboard.dataSources.length} sources`}
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
                      <WidgetContainer
                        title={widget.title}
                        loading={!allSourcesReady}
                        error={widgetErrors[widget.id]}
                        onRemove={() =>
                          dashboardId && removeWidget(dashboardId, widget.id)
                        }
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
