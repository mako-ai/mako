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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  Alert,
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
  Pencil,
  Eye,
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
  applyFreshMaterializationCommand,
  getDashboardMosaicInstance,
  refreshDashboardCommand,
  reloadDashboardDataSourcesCommand,
  refreshDashboardWidgetCommand,
} from "../dashboard-runtime/commands";
import { useDashboardRuntimeStore } from "../dashboard-runtime/store";
import { serializeDashboardDefinition } from "../dashboard-runtime/types";
import { useAuth } from "../contexts/auth-context";
import { computeDashboardStateHash } from "../utils/stateHash";
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveWidgetLayout(widget: DashboardWidget) {
  const fallback = { x: 0, y: 0, w: 6, h: 4, minW: 1, minH: 1 };
  const candidate = (widget as any).layout ?? (widget as any).layouts?.lg;
  if (!candidate || typeof candidate !== "object") {
    return fallback;
  }

  return {
    x: typeof candidate.x === "number" ? candidate.x : fallback.x,
    y: typeof candidate.y === "number" ? candidate.y : fallback.y,
    w: typeof candidate.w === "number" ? candidate.w : fallback.w,
    h: typeof candidate.h === "number" ? candidate.h : fallback.h,
    minW: typeof candidate.minW === "number" ? candidate.minW : fallback.minW,
    minH: typeof candidate.minH === "number" ? candidate.minH : fallback.minH,
  };
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
  const { user } = useAuth();
  const { effectiveMode } = useTheme();
  const dashboard = useDashboardStore(state =>
    dashboardId ? state.openDashboards[dashboardId] : undefined,
  );
  const openDashboard = useDashboardStore(state => state.openDashboard);
  const saveDashboard = useDashboardStore(state => state.saveDashboard);
  const markDashboardSaved = useDashboardStore(
    state => state.markDashboardSaved,
  );
  const getDashboardSavedStateHash = useDashboardStore(
    state => state.getDashboardSavedStateHash,
  );
  const materializeDashboard = useDashboardStore(
    state => state.materializeDashboard,
  );
  const createDashboard = useDashboardStore(state => state.createDashboard);
  const addWidget = useDashboardStore(state => state.addWidget);
  const modifyWidget = useDashboardStore(state => state.modifyWidget);
  const removeWidget = useDashboardStore(state => state.removeWidget);
  const applyDefinition = useDashboardStore(state => state.applyDefinition);
  const undo = useDashboardStore(state => state.undo);
  const redo = useDashboardStore(state => state.redo);
  const conflict = useDashboardStore(state =>
    state.conflict?.dashboardId === dashboardId ? state.conflict : null,
  );
  const resolveConflict = useDashboardStore(state => state.resolveConflict);
  const acquireLock = useDashboardStore(state => state.acquireLock);
  const forceAcquireLock = useDashboardStore(state => state.forceAcquireLock);
  const releaseLock = useDashboardStore(state => state.releaseLock);
  const heartbeatLock = useDashboardStore(state => state.heartbeatLock);
  const historyEntry = useDashboardStore(state =>
    dashboardId ? state.historyMap[dashboardId] : undefined,
  );
  const isMaterializationBuilding = (dashboard?.dataSources || []).some(
    dataSource => dataSource.cache?.parquetBuildStatus === "building",
  );
  const historyIndex = historyEntry?.index ?? -1;
  const historyLength = historyEntry?.stack.length ?? 0;
  const runtimeSession = useDashboardRuntimeStore(state =>
    dashboardId ? state.sessions[dashboardId] || null : null,
  );

  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [isEditModeLocal, setIsEditModeLocal] = useState(false);
  const [codeValue, setCodeValue] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [dataSourcePanelOpen, setDataSourcePanelOpen] = useState(false);
  const [addWidgetOpen, setAddWidgetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showEventLog, setShowEventLog] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [inspectedWidget, setInspectedWidget] =
    useState<DashboardWidget | null>(null);
  const [mosaicInstance, setMosaicInstance] = useState<MosaicInstance | null>(
    null,
  );
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isEditModeLocalRef = useRef(false);
  const workspaceIdRef = useRef<string | undefined>(undefined);
  const dashboardIdRef = useRef<string | undefined>(dashboardId);

  const {
    width: gridWidth,
    containerRef: gridContainerRef,
    measureWidth,
  } = useContainerWidth({ measureBeforeMount: true });

  const workspaceId = currentWorkspace?.id;
  isEditModeLocalRef.current = isEditModeLocal;
  workspaceIdRef.current = workspaceId;
  dashboardIdRef.current = dashboardId;

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
          materializationSchedule: {
            enabled: true,
            cron: "0 0 * * *",
            timezone: "UTC",
          },
          layout: { columns: 12, rowHeight: 80 },
          cache: {},
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

  const isDashboardLoaded = !!dashboard;
  useEffect(() => {
    if (!isDashboardLoaded || !workspaceId || !dashboardId) return;
    void activateDashboardSession(workspaceId, dashboardId, "viewer");
  }, [isDashboardLoaded, workspaceId, dashboardId]);

  // The grid container ref only enters the DOM after the dashboard loads
  // (the loading state early-return doesn't include it). Re-trigger
  // useContainerWidth's measurement so it picks up the real element and
  // attaches a ResizeObserver. measureBeforeMount: true above ensures the
  // mounted→true transition re-fires the hook's internal effect.
  useEffect(() => {
    if (isDashboardLoaded) {
      measureWidth();
    }
  }, [isDashboardLoaded, measureWidth]);

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

  const handleForceEditMode = useCallback(async () => {
    if (!workspaceId || !dashboardId) return;
    setLockError(null);
    setIsEditModeLocal(true);
    const acquired = await forceAcquireLock(workspaceId, dashboardId);
    if (!acquired) {
      setIsEditModeLocal(false);
      setLockError("Failed to acquire edit lock. Please try again.");
      return;
    }
  }, [workspaceId, dashboardId, forceAcquireLock]);

  const handleEditModeToggle = useCallback(
    async (mode: "edit" | "view") => {
      if (!workspaceId || !dashboardId) return;
      setLockError(null);

      if (mode === "edit") {
        // Optimistic toggle to avoid blocking the UI on network latency.
        setIsEditModeLocal(true);
        const acquired = await acquireLock(workspaceId, dashboardId);
        if (!acquired) {
          setIsEditModeLocal(false);
          const d = useDashboardStore.getState().openDashboards[dashboardId];
          const lock = d?.editLock;
          if (lock && lock.userId !== user?.id) {
            setLockError(
              `${lock.userName || "Another user"} is currently editing this dashboard`,
            );
          } else {
            setLockError("Failed to acquire edit lock. Please try again.");
          }
          return;
        }
      } else {
        // Optimistic toggle; release happens in background.
        setIsEditModeLocal(false);
        void releaseLock(workspaceId, dashboardId);
      }
    },
    [workspaceId, dashboardId, acquireLock, releaseLock, user],
  );

  // Heartbeat to keep lock alive while editing
  useEffect(() => {
    if (isEditModeLocal && workspaceId && dashboardId) {
      heartbeatRef.current = setInterval(() => {
        heartbeatLock(workspaceId, dashboardId);
      }, 30_000);
    }
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [isEditModeLocal, workspaceId, dashboardId, heartbeatLock]);

  // Release lock on unmount
  useEffect(() => {
    return () => {
      if (
        isEditModeLocalRef.current &&
        workspaceIdRef.current &&
        dashboardIdRef.current
      ) {
        void releaseLock(workspaceIdRef.current, dashboardIdRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLayoutChange = useCallback(
    (_layout: any, allLayouts: Record<string, any>) => {
      if (!dashboard || !dashboardId || !allLayouts) return;

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
          modifyWidget(dashboardId, widget.id, {
            layouts: { ...currentLayouts, ...updatedLayouts },
          } as any);
        }
      }
    },
    [dashboard, dashboardId, modifyWidget],
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
          lg: {
            ...lgLayout,
            y: lgLayout.y + lgLayout.h,
          },
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
        bytesLoaded: 0,
        totalBytes: null,
        progress: null,
      };
    }

    const loadingSources = dashboard.dataSources.filter(
      ds => runtimeSession?.dataSources[ds.id]?.status === "loading",
    );

    if (loadingSources.length === 0) {
      return null;
    }

    let bytesLoaded = 0;
    let totalBytes = 0;
    let hasKnownByteSize = true;
    for (const dataSource of loadingSources) {
      const runtime = runtimeSession?.dataSources[dataSource.id];
      bytesLoaded += runtime?.bytesLoaded ?? 0;
      if (runtime?.totalBytes == null) {
        hasKnownByteSize = false;
        continue;
      }
      totalBytes += runtime.totalBytes;
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
      bytesLoaded,
      totalBytes: hasKnownByteSize ? totalBytes : null,
      progress:
        hasKnownByteSize && totalBytes > 0
          ? (bytesLoaded / totalBytes) * 100
          : null,
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

  const dataFreshness = useMemo(() => {
    if (!dashboard || dashboard.dataSources.length === 0) return null;

    const ttl = dashboard.materializationSchedule?.dataFreshnessTtlMs;
    const defaultTtl = 24 * 60 * 60 * 1000; // 24 hours
    const threshold = ttl ?? defaultTtl;

    let oldestDate: Date | null = null;
    for (const ds of dashboard.dataSources) {
      const builtAt = ds.cache?.parquetBuiltAt;
      if (!builtAt) continue;
      const d = new Date(builtAt);
      if (!oldestDate || d < oldestDate) oldestDate = d;
    }

    if (!oldestDate) {
      const lr = dashboard.cache?.lastRefreshedAt;
      if (lr) oldestDate = new Date(lr);
    }

    if (!oldestDate) return null;

    const ageMs = Date.now() - oldestDate.getTime();
    if (ageMs < threshold) return null;

    const hours = Math.floor(ageMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    const label =
      days > 0
        ? `${days} day${days !== 1 ? "s" : ""} ago`
        : `${hours} hour${hours !== 1 ? "s" : ""} ago`;

    return { ageMs, label };
  }, [dashboard]);

  const recentEventLog = useMemo(
    () => runtimeSession?.eventLog.slice(-10).reverse() || [],
    [runtimeSession?.eventLog],
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
        const bpLayout =
          w.layouts?.[bp] ?? (bp === "lg" ? wAny.layout : undefined);
        if (!bpLayout) continue;
        items.push({
          i: w.id,
          x: bpLayout.x ?? 0,
          y: bpLayout.y ?? 0,
          w: bpLayout.w ?? 6,
          h: bpLayout.h ?? 4,
          minW: bpLayout.minW || 1,
          minH: bpLayout.minH || 1,
        });
      }
      if (items.length > 0) result[bp] = items;
    }
    if (!result.lg) {
      result.lg = widgets.map(w => ({
        i: w.id,
        x: 0,
        y: 0,
        w: 6,
        h: 4,
        minW: 1,
        minH: 1,
      }));
    }
    return result;
  }, [widgets]);

  const hasUnsavedChanges = useMemo(() => {
    if (!dashboard || !dashboardId) return false;
    const savedHash = getDashboardSavedStateHash(dashboardId);
    if (!savedHash) return true;
    return computeDashboardStateHash(dashboard) !== savedHash;
  }, [dashboard, dashboardId, getDashboardSavedStateHash]);

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
  const isReadOnly = dashboard.readOnly === true;
  const isEditMode = isEditModeLocal && !isReadOnly;
  const renderWidget = (widget: DashboardWidget) => {
    const snapshot = dashboard.snapshots?.[widget.id];
    if (!runtimeSession && !snapshot) {
      return null;
    }

    const dataSourceRuntime = runtimeSession?.dataSources[widget.dataSourceId];
    if (
      (!dataSourceRuntime || dataSourceRuntime.status !== "ready") &&
      !snapshot
    ) {
      return null;
    }

    const widgetCrossFilterEnabled =
      isCrossFilterEnabled && (widget.crossFilter?.enabled ?? true);
    if (!mosaicInstance && !snapshot) {
      return null;
    }

    const widgetRuntime = runtimeSession?.widgets[widget.id];
    const refreshGeneration = widgetRuntime?.refreshGeneration ?? 0;
    const widgetLayout = resolveWidgetLayout(widget);
    const widgetRenderKey = [
      widget.id,
      widgetLayout.x,
      widgetLayout.y,
      widgetLayout.w,
      widgetLayout.h,
      refreshGeneration,
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
        if (!widget.kpiConfig) {
          return null;
        }
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
        {/* Edit / View mode toggle (hidden when read-only) */}
        {!isReadOnly && (
          <ToggleButtonGroup
            value={isEditMode ? "edit" : "view"}
            exclusive
            onChange={(_, v) => v && handleEditModeToggle(v as "edit" | "view")}
            size="small"
            sx={{ height: 28 }}
          >
            <ToggleButton value="view" sx={{ px: 1, py: 0.25 }}>
              <Tooltip title="View mode">
                <Eye size={14} />
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="edit" sx={{ px: 1, py: 0.25 }}>
              <Tooltip title="Edit mode">
                <Pencil size={14} />
              </Tooltip>
            </ToggleButton>
          </ToggleButtonGroup>
        )}

        {isReadOnly && (
          <Chip
            label="Read-only"
            size="small"
            color="default"
            variant="outlined"
            sx={{ mr: 0.5 }}
          />
        )}

        {/* Data Sources */}
        <Tooltip
          title={
            isReadOnly ? "Data sources (read-only)" : "Manage data sources"
          }
        >
          <Chip
            icon={<Database size={14} />}
            label={`${dashboard.dataSources.length} sources`}
            size="small"
            variant="outlined"
            onClick={
              isReadOnly ? undefined : () => setDataSourcePanelOpen(true)
            }
            sx={{ cursor: isReadOnly ? "default" : "pointer" }}
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

        {isEditMode && (
          <>
            {/* Reload data: re-fetch from source DB */}
            <Tooltip title="Reload data from source database">
              <Chip
                icon={<Database size={14} />}
                label="Reload data"
                size="small"
                variant="outlined"
                onClick={
                  isMaterializationBuilding ? undefined : handleReloadData
                }
                sx={{
                  cursor: isMaterializationBuilding ? "default" : "pointer",
                }}
                disabled={isMaterializationBuilding}
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

            {/* Canvas / Code view toggle */}
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
          </>
        )}

        {/* Export */}
        <Tooltip title="Export">
          <IconButton size="small" onClick={handleExportPng}>
            <Download size={16} />
          </IconButton>
        </Tooltip>

        {isEditMode && (
          <>
            <Tooltip
              title={
                hasCodeError
                  ? "Fix JSON errors before saving"
                  : hasUnsavedChanges
                    ? "Save (Ctrl+S)"
                    : "No changes to save"
              }
            >
              <span>
                <IconButton
                  size="small"
                  disabled={
                    !hasUnsavedChanges || (viewMode === "code" && hasCodeError)
                  }
                  onClick={async () => {
                    if (!workspaceId || !dashboardId) return;
                    const saved = await saveDashboard(workspaceId, dashboardId);
                    if (!saved) return;
                    markDashboardSaved(dashboardId);
                    void materializeDashboard(workspaceId, dashboardId, {
                      force: true,
                    });
                  }}
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
          </>
        )}

        {/* Settings always available (read-only users can view settings) */}
        {!isEditMode && (
          <Tooltip title="Dashboard settings">
            <IconButton size="small" onClick={() => setSettingsOpen(true)}>
              <Settings size={16} />
            </IconButton>
          </Tooltip>
        )}

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

      {/* Lock / conflict banners */}
      {lockError && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0 }}
          onClose={() => setLockError(null)}
          action={
            <Button color="inherit" size="small" onClick={handleForceEditMode}>
              Force take over
            </Button>
          }
        >
          {lockError}
        </Alert>
      )}
      {!isEditMode &&
        dashboard?.editLock &&
        new Date(dashboard.editLock.expiresAt) > new Date() &&
        !isReadOnly &&
        (() => {
          const isSelfLock = dashboard.editLock!.userId === user?.id;
          return (
            <Alert
              severity={isSelfLock ? "warning" : "info"}
              sx={{ borderRadius: 0 }}
              action={
                <Box sx={{ display: "flex", gap: 0.5 }}>
                  <Button
                    color="inherit"
                    size="small"
                    onClick={
                      isSelfLock
                        ? handleForceEditMode
                        : () => handleEditModeToggle("edit")
                    }
                  >
                    {isSelfLock ? "Resume editing" : "Enter edit mode"}
                  </Button>
                  {!isSelfLock && (
                    <Button
                      color="inherit"
                      size="small"
                      onClick={handleForceEditMode}
                    >
                      Force take over
                    </Button>
                  )}
                </Box>
              }
            >
              {isSelfLock
                ? "You have unsaved changes from a previous session"
                : `${dashboard.editLock!.userName} is currently editing this dashboard`}
            </Alert>
          );
        })()}
      {dataFreshness && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={handleReloadData}
              disabled={isMaterializationBuilding}
            >
              Refresh now
            </Button>
          }
        >
          Data was last refreshed {dataFreshness.label}
        </Alert>
      )}

      {/* Loading bar */}
      {someSourcesLoading && (
        <Box sx={{ borderBottom: "1px solid", borderColor: "divider" }}>
          <LinearProgress
            variant={
              loadingSummary?.progress != null ? "determinate" : "indeterminate"
            }
            value={loadingSummary?.progress ?? undefined}
          />
          {loadingSummary && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", px: 1.5, py: 0.5 }}
            >
              {loadingSummary.label}
              {loadingSummary.progress != null &&
                ` · ${Math.round(loadingSummary.progress)}%`}
              {loadingSummary.totalBytes != null &&
                ` · ${formatBytes(loadingSummary.bytesLoaded)} / ${formatBytes(loadingSummary.totalBytes)}`}
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
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <Typography variant="caption" sx={{ flex: 1 }}>
            {errorSummary.count > 1
              ? `${errorSummary.count} data sources failed to load.`
              : "Data source failed to load."}{" "}
            {errorSummary.message}
          </Typography>
          <Tooltip title="Retry loading data sources">
            <IconButton
              size="small"
              onClick={() => {
                if (workspaceId) {
                  void reloadDashboardDataSourcesCommand(
                    workspaceId,
                    dashboardId,
                  );
                }
              }}
              sx={{
                color: "error.contrastText",
                p: 0.5,
                "&:hover": { backgroundColor: "error.dark" },
              }}
            >
              <RefreshCw size={14} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
      {runtimeSession?.materializationPolling && (
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            backgroundColor: "warning.light",
            color: "warning.contrastText",
          }}
        >
          <Typography variant="caption" sx={{ display: "block" }}>
            Refreshing data sources in the background. The dashboard is using
            the previous materialized snapshot until fresh data is ready.
          </Typography>
        </Box>
      )}
      {runtimeSession?.freshDataAvailable && workspaceId && dashboardId && (
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            backgroundColor: "success.light",
            color: "success.contrastText",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
          }}
        >
          <Typography variant="caption" sx={{ display: "block" }}>
            Fresh materialized data is available.
          </Typography>
          <Chip
            size="small"
            label="Update now"
            onClick={() =>
              void applyFreshMaterializationCommand({
                workspaceId,
                dashboardId,
              })
            }
            sx={{ cursor: "pointer", backgroundColor: "background.paper" }}
          />
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
        {/* Main content: Canvas or Code (code view only available in edit mode) */}
        <Box sx={{ flex: 1, overflow: "auto" }}>
          {viewMode === "canvas" || !isEditMode ? (
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
                  <Typography variant="body2">
                    {isEditMode
                      ? "No widgets yet."
                      : "This dashboard has no widgets."}
                  </Typography>
                  {isEditMode &&
                    (dashboard.dataSources.length === 0 ? (
                      <Tooltip title="Add a data source">
                        <IconButton
                          onClick={() => setDataSourcePanelOpen(true)}
                        >
                          <Database size={16} />
                        </IconButton>
                      </Tooltip>
                    ) : (
                      <Tooltip title="Add a widget">
                        <IconButton onClick={() => setAddWidgetOpen(true)}>
                          <Plus size={16} />
                        </IconButton>
                      </Tooltip>
                    ))}
                </Box>
              ) : (
                <ResponsiveGridLayout
                  className="layout"
                  width={gridWidth || 800}
                  layouts={allGridLayouts}
                  breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480 }}
                  cols={{ lg: 12, md: 10, sm: 6, xs: 4 }}
                  rowHeight={dashboard.layout?.rowHeight || 80}
                  onLayoutChange={handleLayoutChange}
                  dragConfig={{
                    handle: ".drag-handle",
                    enabled: isEditMode,
                  }}
                  resizeConfig={{ enabled: isEditMode }}
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
                            isEditMode={isEditMode}
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
      <Dialog open={!!conflict} maxWidth="sm" fullWidth>
        <DialogTitle>Save Conflict</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This dashboard was modified by another user while you were editing.
            Your save was rejected to prevent overwriting their changes.
          </DialogContentText>
          <DialogContentText sx={{ mt: 1 }}>
            You can discard your local changes and load the latest version, or
            overwrite the server version with your changes.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() =>
              workspaceId && resolveConflict("discard", workspaceId)
            }
          >
            Discard my changes
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() =>
              workspaceId && resolveConflict("overwrite", workspaceId)
            }
          >
            Overwrite with my changes
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default DashboardCanvas;
