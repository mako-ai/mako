import React, {
  useRef,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  Box,
  Tabs,
  Tab,
  IconButton,
  Button,
  Typography,
  styled,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Snackbar,
} from "@mui/material";
import { Close as CloseIcon, Add as AddIcon } from "@mui/icons-material";
import {
  SquareTerminal as ConsoleIcon,
  Settings as SettingsIcon,
  CloudUpload as DataSourceIcon,
  Clock as ScheduleIcon,
  Webhook as WebhookIcon,
  CirclePause as PauseIcon,
  ChartPie as DashboardIcon,
  ChevronRight as BreadcrumbChevronIcon,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { loader } from "@monaco-editor/react";
import Console, { ConsoleRef } from "./Console";
import ResultsTable from "./ResultsTable";
import Settings from "../pages/Settings";
import ConnectorTab from "./ConnectorTab";
import { WorkspaceMembers } from "./WorkspaceMembers";
import { FlowEditor } from "./FlowEditor";
import DashboardCanvas from "./DashboardCanvas";
import type { DbFlowFormRef } from "./DbFlowForm";
import ConflictResolutionDialog, {
  ConflictData,
} from "./ConflictResolutionDialog";
import FileExplorerDialog from "./FileExplorerDialog";
import { SaveCommentDialog } from "./SaveCommentDialog";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { useConsoleStore, selectConsoleTabs } from "../store/consoleStore";
import { useShallow } from "zustand/react/shallow";
import { useDashboardStore } from "../store/dashboardStore";
import { useUIStore } from "../store/uiStore";
import { useSchemaStore } from "../store/schemaStore";
import { useWorkspace } from "../contexts/workspace-context";
import { ConsoleModification } from "../hooks/useMonacoConsole";
import { useSqlAutocomplete } from "../hooks/useSqlAutocomplete";
import { trackEvent } from "../lib/analytics";
import { getApiBasePath } from "../lib/api-base-path";
import { generateObjectId } from "../utils/objectId";
import {
  computeConsoleStateHash,
  computeDashboardStateHash,
} from "../utils/stateHash";

interface QueryPageInfo {
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  returnedRows: number;
  capApplied: boolean;
}

interface QueryResult {
  results: any[];
  executedAt: string;
  resultCount: number;
  executionTime?: number;
  fields?: Array<{ name?: string; originalName?: string } | string>;
  pageInfo?: QueryPageInfo | null;
  currentPage?: number;
}

interface TabPaginationState {
  currentPage: number;
  cursorHistory: Array<string | null>;
  nextCursor: string | null;
  hasMore: boolean;
  pageSize: number;
  capApplied: boolean;
}

// Styled PanelResizeHandle components
const StyledVerticalResizeHandle = styled(PanelResizeHandle)(({ theme }) => ({
  height: "4px",
  background: theme.palette.divider,
  cursor: "row-resize",
  transition: "background-color 0.2s ease",
  "&:hover": {
    backgroundColor: theme.palette.primary.main,
  },
}));

type ResultsViewMode = "table" | "json" | "chart";

export interface ChartSpecChangePayload {
  spec: import("../lib/chart-spec").MakoChartSpec;
  onRenderResult?: (result: { success: boolean; error?: string }) => void;
}

export interface ConsoleResultsContext {
  viewMode: ResultsViewMode;
  chartSpec: import("../lib/chart-spec").MakoChartSpec | null;
  hasResults: boolean;
  rowCount: number;
  columns: string[];
  sampleRows: Record<string, unknown>[];
}

interface EditorProps {
  dbFlowFormRef?: React.RefObject<DbFlowFormRef | null>;
  onChartSpecChangeRef?: React.MutableRefObject<
    ((payload: ChartSpecChangePayload) => void) | undefined
  >;
  resultsContextRef?: React.MutableRefObject<ConsoleResultsContext | null>;
}

function LockConflictDialog() {
  const prompt = useDashboardStore(state => state.lockConflictPrompt);
  const setPrompt = useDashboardStore(state => state.setLockConflictPrompt);

  useEffect(() => {
    return () => {
      const current = useDashboardStore.getState().lockConflictPrompt;
      if (current) {
        current.resolve(false);
        useDashboardStore.getState().setLockConflictPrompt(null);
      }
    };
  }, []);

  const handleTakeOver = () => {
    prompt?.resolve(true);
    setPrompt(null);
  };

  const handleCancel = () => {
    prompt?.resolve(false);
    setPrompt(null);
  };

  return (
    <Dialog open={prompt !== null} onClose={handleCancel}>
      <DialogTitle>Dashboard Locked</DialogTitle>
      <DialogContent>
        <Typography>
          {prompt?.lockedBy ?? "Another user"} is currently editing this
          dashboard. Do you want to take over?
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleCancel}>Cancel</Button>
        <Button onClick={handleTakeOver} variant="contained" color="warning">
          Take over
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * MUI <Tabs> clones its direct children to inject props (selected, onChange,
 * textColor, indicator, ...). This wrapper accepts all Tab props (plus MUI's
 * clone-injected extras), wires up dnd-kit's useSortable for drag-to-reorder,
 * and forwards everything to an underlying <Tab>.
 *
 * UX:
 * - Dragged tab stays in place (only dimmed); no translation or layout shift.
 * - A thin vertical bar (drop indicator) is rendered on the leading or
 *   trailing edge of the tab currently under the pointer, showing where the
 *   dragged tab will land on drop.
 *
 * Implementation notes:
 * - We intentionally do NOT spread dnd-kit's `attributes` onto the Tab — they
 *   include role="button"/tabIndex which would clobber MUI Tab's own
 *   role="tab"/tabIndex logic and break tab selection + cause a feedback
 *   loop with MUI Tabs' indicator ResizeObserver.
 * - We use inline `style` (not `sx`) for the drag opacity so emotion doesn't
 *   churn className hashes on every pointer move during a drag.
 */
function SortableConsoleTab(props: React.ComponentProps<typeof Tab>) {
  const id = props.value as string;
  const { listeners, setNodeRef, isDragging, isOver, activeIndex, overIndex } =
    useSortable({ id });

  // Show a drop indicator on the hovered tab, but not on the dragged tab
  // itself and not when dropping would be a no-op (same index).
  const showIndicator =
    isOver && !isDragging && activeIndex !== -1 && activeIndex !== overIndex;
  // Leading edge when moving the tab to the left, trailing edge when moving
  // it to the right.
  const indicatorSide: "left" | "right" =
    activeIndex > overIndex ? "left" : "right";

  const dragStyle: React.CSSProperties = {
    opacity: isDragging ? 0.4 : 1,
    touchAction: "none",
  };

  const indicatorSx = showIndicator
    ? {
        "&::after": {
          content: '""',
          position: "absolute",
          top: 0,
          bottom: 0,
          [indicatorSide]: -3,
          width: "6px",
          backgroundColor: "divider",
          pointerEvents: "none",
          zIndex: 2,
        },
      }
    : undefined;

  const mergedSx = indicatorSx
    ? ([props.sx, indicatorSx] as React.ComponentProps<typeof Tab>["sx"])
    : props.sx;

  return (
    <Tab
      {...props}
      {...listeners}
      ref={setNodeRef as unknown as React.Ref<HTMLDivElement>}
      sx={mergedSx}
      style={{ ...(props.style || {}), ...dragStyle }}
    />
  );
}

function Editor({
  dbFlowFormRef,
  onChartSpecChangeRef,
  resultsContextRef,
}: EditorProps = {}) {
  const { currentWorkspace } = useWorkspace();
  const [tabResults, setTabResults] = useState<
    Record<string, QueryResult | null>
  >({});
  const [tabPagination, setTabPagination] = useState<
    Record<string, TabPaginationState | null>
  >({});
  const tabs = useConsoleStore(state => state.tabs);
  const [tabChartSpecs, setTabChartSpecs] = useState<
    Record<string, import("../lib/chart-spec").MakoChartSpec | null>
  >(() => {
    const initial: Record<
      string,
      import("../lib/chart-spec").MakoChartSpec | null
    > = {};
    for (const tab of Object.values(tabs)) {
      if (tab.chartSpec) {
        initial[tab.id] =
          tab.chartSpec as import("../lib/chart-spec").MakoChartSpec;
      }
    }
    return initial;
  });
  const [tabViewModes, setTabViewModes] = useState<
    Record<string, ResultsViewMode>
  >(() => {
    const initial: Record<string, ResultsViewMode> = {};
    for (const tab of Object.values(tabs)) {
      if (tab.resultsViewMode) {
        initial[tab.id] = tab.resultsViewMode;
      }
    }
    return initial;
  });
  const pendingRenderCallbackRef = useRef<
    Record<
      string,
      ((result: { success: boolean; error?: string }) => void) | undefined
    >
  >({});
  // Per-tab execution state to allow parallel queries across tabs
  const [executingTabs, setExecutingTabs] = useState<Record<string, boolean>>(
    {},
  );
  const [cancellingTabs, setCancellingTabs] = useState<Record<string, boolean>>(
    {},
  );
  const [isSaving, setIsSaving] = useState(false);
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");
  const connectionsMap = useSchemaStore(state => state.connections);
  const ensureConnections = useSchemaStore(state => state.ensureConnections);
  const availableDatabases = React.useMemo(
    () => (currentWorkspace ? connectionsMap[currentWorkspace.id] || [] : []),
    [currentWorkspace, connectionsMap],
  );

  // Save dialog state (folder navigator)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveDialogTabId, setSaveDialogTabId] = useState<string | null>(null);
  const [saveDialogContent, setSaveDialogContent] = useState("");
  // Which flow opened the dialog:
  //   "new"           — first-time save of a draft tab (POST with the tab's own id)
  //   "save-as-copy"  — create a brand-new console record (POST with a fresh id),
  //                     leaving the current tab untouched.
  //   "rename-move"   — relocate an already-saved console (PUT via saveConsole)
  //                     to a new path; current tab updates to the new path.
  const [saveDialogMode, setSaveDialogMode] = useState<
    "new" | "save-as-copy" | "rename-move"
  >("new");
  // Id that will be sent to the API. Same as saveDialogTabId for "new" and
  // "rename-move"; a freshly-generated id for "save-as-copy".
  const [saveDialogTargetId, setSaveDialogTargetId] = useState<string | null>(
    null,
  );

  // Save comment dialog state (version commit message)
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  const [suggestedComment, setSuggestedComment] = useState<string | undefined>(
    undefined,
  );
  const [suggestedCommentLoading, setSuggestedCommentLoading] = useState(false);
  const saveCommentAbortRef = useRef<AbortController | null>(null);
  const [pendingCommentSave, setPendingCommentSave] = useState<{
    tabId: string;
    content: string;
    path: string;
    resolve: (success: boolean) => void;
  } | null>(null);

  // Version history panel state
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [versionHistoryTabId, setVersionHistoryTabId] = useState<string | null>(
    null,
  );
  const [versionHistoryEntityType, setVersionHistoryEntityType] = useState<
    "console" | "dashboard"
  >("console");

  // Conflict resolution state
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [conflictData, setConflictData] = useState<ConflictData | null>(null);

  const [pendingDashboardCloseTabId, setPendingDashboardCloseTabId] = useState<
    string | null
  >(null);

  const [pendingSaveData, setPendingSaveData] = useState<{
    tabId: string;
    content: string;
    path: string;
    connectionId?: string;
    databaseId?: string;
    databaseName?: string;
    comment?: string;
  } | null>(null);

  // Refs for query cancellation (per-tab to support parallel queries)
  const abortControllersRef = useRef<Record<string, AbortController | null>>(
    {},
  );
  const executionIdsRef = useRef<Record<string, string | null>>({});

  // Tab store — individual selectors to avoid full-store re-renders
  const activeTabId = useConsoleStore(state => state.activeTabId);
  const closeTab = useConsoleStore(state => state.closeTab);
  const updateContent = useConsoleStore(state => state.updateContent);
  const updateConnection = useConsoleStore(state => state.updateConnection);
  const updateDatabase = useConsoleStore(state => state.updateDatabase);
  const updateFilePath = useConsoleStore(state => state.updateFilePath);
  const updateTitle = useConsoleStore(state => state.updateTitle);
  const updateDirty = useConsoleStore(state => state.updateDirty);
  const updateSavedState = useConsoleStore(state => state.updateSavedState);
  const updateChartSpec = useConsoleStore(state => state.updateChartSpec);
  const updateResultsViewMode = useConsoleStore(
    state => state.updateResultsViewMode,
  );
  const setActiveTab = useConsoleStore(state => state.setActiveTab);
  const getVersionManager = useConsoleStore(state => state.getVersionManager);
  const generateSaveComment = useConsoleStore(
    state => state.generateSaveComment,
  );
  const executeQuery = useConsoleStore(state => state.executeQuery);
  const cancelQuery = useConsoleStore(state => state.cancelQuery);
  const saveConsole = useConsoleStore(state => state.saveConsole);
  const deleteConsole = useConsoleStore(state => state.deleteConsole);
  const openTab = useConsoleStore(state => state.openTab);
  const reorderTabs = useConsoleStore(state => state.reorderTabs);
  const reloadConsole = useConsoleStore(state => state.reloadConsole);
  // useShallow prevents infinite re-renders: selectConsoleTabs returns a new
  // array on every call; without shallow comparison useSyncExternalStore would
  // detect a change every render and trigger a re-render loop.
  const consoleTabs = useConsoleStore(useShallow(selectConsoleTabs));
  const activeConsoleId = activeTabId;

  const setChartSpecForTab = useCallback(
    (tabId: string, spec: import("../lib/chart-spec").MakoChartSpec | null) => {
      setTabChartSpecs(prev => ({ ...prev, [tabId]: spec }));
      updateChartSpec(tabId, spec as Record<string, unknown> | null);
    },
    [updateChartSpec],
  );

  const setViewModeForTab = useCallback(
    (tabId: string, mode: ResultsViewMode) => {
      setTabViewModes(prev => ({ ...prev, [tabId]: mode }));
      updateResultsViewMode(tabId, mode);
    },
    [updateResultsViewMode],
  );

  // Refs for each Console instance
  const consoleRefs = useRef<Record<string, React.RefObject<ConsoleRef>>>({});

  // Ensure refs exist for every tab
  useEffect(() => {
    consoleTabs.forEach(tab => {
      if (!consoleRefs.current[tab.id]) {
        consoleRefs.current[tab.id] = React.createRef<ConsoleRef>();
      }
    });
  }, [consoleTabs]);

  // Seed local chart spec / view mode state when tabs are loaded from the server
  useEffect(() => {
    for (const tab of consoleTabs) {
      if (tab.chartSpec) {
        setTabChartSpecs(prev => {
          if (prev[tab.id]) return prev;
          return {
            ...prev,
            [tab.id]:
              tab.chartSpec as import("../lib/chart-spec").MakoChartSpec,
          };
        });
      }
      if (tab.resultsViewMode) {
        setTabViewModes(prev => {
          if (prev[tab.id]) return prev;
          return { ...prev, [tab.id]: tab.resultsViewMode! };
        });
      }
    }
  }, [consoleTabs]);

  // Keep activeEditorContent in app store updated so Chat can use it
  const setActiveEditorContent = useUIStore(
    state => state.setActiveEditorContent,
  );

  // Update active editor content when tab focus changes AND focus the Monaco editor
  useEffect(() => {
    if (activeConsoleId && consoleRefs.current[activeConsoleId]?.current) {
      const consoleRef = consoleRefs.current[activeConsoleId].current;
      const content = consoleRef.getCurrentContent();
      setActiveEditorContent(content);

      // Focus the Monaco editor in the active console
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          consoleRef.focus();
        });
      });
    } else {
      setActiveEditorContent(undefined);
    }
  }, [activeConsoleId, consoleTabs.length, setActiveEditorContent]);

  // Expose chart spec change handler so Chat can set the spec for the active tab
  useEffect(() => {
    if (onChartSpecChangeRef) {
      onChartSpecChangeRef.current = (payload: ChartSpecChangePayload) => {
        const tabId = activeTabId;
        if (!tabId) return;
        if (payload.onRenderResult) {
          pendingRenderCallbackRef.current[tabId] = payload.onRenderResult;
        }
        setChartSpecForTab(tabId, payload.spec);
        setViewModeForTab(tabId, "chart");
      };
    }
    return () => {
      if (onChartSpecChangeRef) {
        onChartSpecChangeRef.current = undefined;
      }
    };
  }, [
    activeTabId,
    onChartSpecChangeRef,
    setChartSpecForTab,
    setViewModeForTab,
  ]);

  // Keep resultsContextRef up to date so Chat can read results state at request time
  useEffect(() => {
    if (!resultsContextRef) return;
    const tabId = activeTabId;
    if (!tabId) {
      resultsContextRef.current = null;
      return;
    }
    const result = tabResults[tabId];
    const viewMode = tabViewModes[tabId] ?? "table";
    const chartSpec = tabChartSpecs[tabId] ?? null;

    if (!result || !result.results) {
      resultsContextRef.current = {
        viewMode,
        chartSpec,
        hasResults: false,
        rowCount: 0,
        columns: [],
        sampleRows: [],
      };
      return;
    }

    const rows = Array.isArray(result.results)
      ? result.results
      : [result.results];
    const columns: string[] = [];
    if (result.fields && Array.isArray(result.fields)) {
      for (const f of result.fields) {
        const name = typeof f === "string" ? f : f?.name;
        if (name) columns.push(name);
      }
    }
    if (
      columns.length === 0 &&
      rows.length > 0 &&
      typeof rows[0] === "object" &&
      rows[0]
    ) {
      columns.push(...Object.keys(rows[0]));
    }

    resultsContextRef.current = {
      viewMode,
      chartSpec,
      hasResults: true,
      rowCount: rows.length,
      columns,
      sampleRows: rows.slice(0, 5),
    };
  }, [activeTabId, tabResults, tabViewModes, tabChartSpecs, resultsContextRef]);

  // Update the page title based on the active tab
  useEffect(() => {
    const baseTitle = "Mako";
    if (!activeConsoleId) {
      document.title = baseTitle;
      return;
    }
    const activeTab = consoleTabs.find(tab => tab.id === activeConsoleId);
    document.title = activeTab?.title
      ? `${activeTab.title} - ${baseTitle}`
      : baseTitle;
  }, [activeConsoleId, consoleTabs]);

  // Fetch connections when workspace changes
  useEffect(() => {
    if (currentWorkspace?.id) {
      ensureConnections(currentWorkspace.id);
    }
  }, [currentWorkspace?.id, ensureConnections]);

  // Load Monaco instance for unified SQL autocomplete
  const [monacoInstance, setMonacoInstance] = useState<unknown>(null);
  useEffect(() => {
    loader.init().then(monaco => setMonacoInstance(monaco));
  }, []);

  // Dynamic getters for unified SQL autocomplete
  const getWorkspaceId = useCallback(
    () => currentWorkspace?.id,
    [currentWorkspace?.id],
  );

  const availableDatabasesRef = useRef(availableDatabases);
  useEffect(() => {
    availableDatabasesRef.current = availableDatabases;
  }, [availableDatabases]);

  const getConnectionId = useCallback(() => {
    const state = useConsoleStore.getState();
    const activeTab = state.activeTabId ? state.tabs[state.activeTabId] : null;
    return activeTab?.connectionId;
  }, []);

  const getConnectionType = useCallback(() => {
    const state = useConsoleStore.getState();
    const activeTab = state.activeTabId ? state.tabs[state.activeTabId] : null;
    const connectionId = activeTab?.connectionId;
    const connection = availableDatabasesRef.current.find(
      db => db.id === connectionId,
    );
    return connection?.type;
  }, []);

  // Unified SQL autocomplete - single global provider for all consoles
  useSqlAutocomplete({
    monaco: monacoInstance,
    getWorkspaceId,
    getConnectionId,
    getConnectionType,
  });

  // Listen for console modification events from AI
  useEffect(() => {
    const handleConsoleModification = (event: Event) => {
      const customEvent = event as CustomEvent<{
        consoleId: string;
        modification: ConsoleModification;
      }>;

      const { consoleId: eventConsoleId, modification } = customEvent.detail;
      const targetConsoleId = eventConsoleId || activeConsoleId;

      if (!targetConsoleId) return;

      const showDiffWithRetry = (retries = 10, delay = 100) => {
        const consoleRef = consoleRefs.current[targetConsoleId]?.current;
        if (consoleRef) {
          consoleRef.showDiff(modification);
        } else if (retries > 0) {
          setTimeout(() => {
            showDiffWithRetry(retries - 1, delay);
          }, delay);
        } else {
          console.error(
            "Console ref not found after retries. Target ID:",
            targetConsoleId,
            "Available IDs:",
            Object.keys(consoleRefs.current),
          );
        }
      };

      showDiffWithRetry();
    };

    window.addEventListener("console-modification", handleConsoleModification);
    return () => {
      window.removeEventListener(
        "console-modification",
        handleConsoleModification,
      );
    };
  }, [activeConsoleId, consoleTabs]);

  // Listen for console execution events from AI (run_console tool)
  useEffect(() => {
    const handleExecutionStart = (event: Event) => {
      const { consoleId } = (event as CustomEvent<{ consoleId: string }>)
        .detail;
      if (consoleId) {
        setExecutingTabs(prev => ({ ...prev, [consoleId]: true }));
      }
    };

    const handleExecutionResult = (event: Event) => {
      const customEvent = event as CustomEvent<{
        consoleId: string;
        result: QueryResult | null;
      }>;
      const { consoleId, result } = customEvent.detail;
      if (consoleId) {
        setTabResults(prev => ({ ...prev, [consoleId]: result }));
        setExecutingTabs(prev => ({ ...prev, [consoleId]: false }));
      }
    };

    window.addEventListener("console-execution-start", handleExecutionStart);
    window.addEventListener("console-execution-result", handleExecutionResult);
    return () => {
      window.removeEventListener(
        "console-execution-start",
        handleExecutionStart,
      );
      window.removeEventListener(
        "console-execution-result",
        handleExecutionResult,
      );
    };
  }, []);

  /* ------------------------ Console Actions ------------------------ */
  const handleTabChange = (_: React.SyntheticEvent, newValue: string) => {
    setActiveTab(newValue);
  };

  // Drag-to-reorder tabs
  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      // Keep click-to-select working: only start a drag after 4px of movement.
      activationConstraint: { distance: 4 },
    }),
  );
  const sortableTabIds = useMemo(
    () => consoleTabs.map(t => t.id),
    [consoleTabs],
  );
  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      reorderTabs(String(active.id), String(over.id));
    },
    [reorderTabs],
  );

  const cleanupTab = (tabId: string) => {
    closeTab(tabId);
    delete consoleRefs.current[tabId];
    setTabResults(prev => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabPagination(prev => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  };

  const closeConsole = (id: string) => {
    const closingTab = tabs[id];
    if (closingTab?.kind === "dashboard") {
      const dbId = closingTab.metadata?.dashboardId as string | undefined;
      if (dbId) {
        const store = useDashboardStore.getState();
        const dashboard = store.openDashboards[dbId];
        if (dashboard) {
          const savedHash = store.getDashboardSavedStateHash(dbId);
          const currentHash = computeDashboardStateHash(dashboard);
          if (savedHash !== undefined && currentHash !== savedHash) {
            setPendingDashboardCloseTabId(id);
            return;
          }
        }
        store.closeDashboard(dbId);
      }
    }
    cleanupTab(id);
  };

  const finalizeDashboardClose = (tabId: string) => {
    const closingTab = tabs[tabId];
    const dbId = closingTab?.metadata?.dashboardId as string | undefined;
    if (dbId) {
      useDashboardStore.getState().closeDashboard(dbId);
    }
    cleanupTab(tabId);
  };

  const handleDashboardCloseSave = async () => {
    if (!pendingDashboardCloseTabId || !currentWorkspace) return;
    const tab = tabs[pendingDashboardCloseTabId];
    const dbId = tab?.metadata?.dashboardId as string | undefined;
    if (dbId) {
      const result = await useDashboardStore
        .getState()
        .saveDashboard(currentWorkspace.id, dbId);
      if (!result.ok) return;
    }
    finalizeDashboardClose(pendingDashboardCloseTabId);
    setPendingDashboardCloseTabId(null);
  };

  const handleDashboardCloseDiscard = () => {
    if (!pendingDashboardCloseTabId) return;
    finalizeDashboardClose(pendingDashboardCloseTabId);
    setPendingDashboardCloseTabId(null);
  };

  const handleDashboardCloseCancel = () => {
    setPendingDashboardCloseTabId(null);
  };

  const handleAddTab = () => {
    openTab({
      title: "New Console",
      content: "",
    });
  };

  const handleConsoleExecute = async (
    tabId: string,
    contentToExecute: string,
    connectionId?: string,
    options?: {
      databaseId?: string;
      databaseName?: string;
      cursor?: string | null;
      currentPage?: number;
      cursorHistory?: Array<string | null>;
      pageSize?: number;
    },
  ) => {
    if (!contentToExecute.trim()) return;

    if (!currentWorkspace) {
      setErrorMessage("No workspace selected");
      setErrorModalOpen(true);
      return;
    }

    if (!connectionId) {
      setErrorMessage("No database connection selected");
      setErrorModalOpen(true);
      return;
    }

    // Create per-tab abort controller and execution ID
    const abortController = new AbortController();
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    abortControllersRef.current[tabId] = abortController;
    executionIdsRef.current[tabId] = executionId;

    setExecutingTabs(prev => ({ ...prev, [tabId]: true }));
    setCancellingTabs(prev => ({ ...prev, [tabId]: false }));
    const startTime = Date.now();
    try {
      const result = await executeQuery(
        currentWorkspace.id,
        connectionId,
        contentToExecute,
        {
          ...options,
          executionId,
          signal: abortController.signal,
          pageSize: options?.pageSize ?? 500,
          cursor: options?.cursor ?? null,
        },
      );
      const executionTime = Date.now() - startTime;
      if (result.success) {
        trackEvent("query_executed", {
          connection_id: connectionId,
          success: true,
          duration_ms: executionTime,
        });

        const fields =
          "fields" in result
            ? (
                result as {
                  fields?: Array<
                    { name?: string; originalName?: string } | string
                  >;
                }
              ).fields
            : undefined;

        setTabResults(prev => ({
          ...prev,
          [tabId]: {
            results: result.rows || [],
            executedAt: new Date().toISOString(),
            resultCount: Array.isArray(result.rows) ? result.rows.length : 0,
            executionTime,
            fields,
            pageInfo: result.pageInfo || null,
            currentPage: options?.currentPage ?? 1,
          },
        }));
        setTabPagination(prev => ({
          ...prev,
          [tabId]: {
            currentPage: options?.currentPage ?? 1,
            cursorHistory: options?.cursorHistory ?? [null],
            nextCursor: result.pageInfo?.nextCursor ?? null,
            hasMore: result.pageInfo?.hasMore ?? false,
            pageSize: result.pageInfo?.pageSize ?? options?.pageSize ?? 500,
            capApplied: result.pageInfo?.capApplied ?? false,
          },
        }));
      } else if (result.error !== "Query cancelled") {
        setErrorMessage(JSON.stringify(result.error, null, 2));
        setErrorModalOpen(true);
        setTabResults(prev => ({ ...prev, [tabId]: null }));
        setTabPagination(prev => ({ ...prev, [tabId]: null }));
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setErrorMessage(JSON.stringify(e, null, 2));
        setErrorModalOpen(true);
        setTabResults(prev => ({ ...prev, [tabId]: null }));
        setTabPagination(prev => ({ ...prev, [tabId]: null }));
      }
    } finally {
      setExecutingTabs(prev => ({ ...prev, [tabId]: false }));
      setCancellingTabs(prev => ({ ...prev, [tabId]: false }));
      delete abortControllersRef.current[tabId];
      delete executionIdsRef.current[tabId];
    }
  };

  const handleNextResultsPage = async (tabId: string) => {
    const pagination = tabPagination[tabId];
    const tab = tabs[tabId];
    if (!pagination?.nextCursor || !tab?.connectionId) {
      return;
    }

    await handleConsoleExecute(tabId, tab.content, tab.connectionId, {
      databaseId: tab.databaseId,
      databaseName: tab.databaseName,
      cursor: pagination.nextCursor,
      currentPage: pagination.currentPage + 1,
      cursorHistory: [...pagination.cursorHistory, pagination.nextCursor],
      pageSize: pagination.pageSize,
    });
  };

  const handlePreviousResultsPage = async (tabId: string) => {
    const pagination = tabPagination[tabId];
    const tab = tabs[tabId];
    if (!pagination || pagination.currentPage <= 1 || !tab?.connectionId) {
      return;
    }

    const previousHistory = pagination.cursorHistory.slice(0, -1);
    const previousCursor = previousHistory[previousHistory.length - 1] ?? null;

    await handleConsoleExecute(tabId, tab.content, tab.connectionId, {
      databaseId: tab.databaseId,
      databaseName: tab.databaseName,
      cursor: previousCursor,
      currentPage: pagination.currentPage - 1,
      cursorHistory: previousHistory.length > 0 ? previousHistory : [null],
      pageSize: pagination.pageSize,
    });
  };

  const handleDownloadResults = useCallback(
    (tabId: string, format: "csv" | "ndjson") => {
      const tab = tabs[tabId];
      if (!currentWorkspace) {
        setErrorMessage("No workspace selected");
        setErrorModalOpen(true);
        return;
      }

      if (!tab?.connectionId) {
        setErrorMessage("No database connection selected");
        setErrorModalOpen(true);
        return;
      }

      const action = `${getApiBasePath(import.meta.env.VITE_API_URL)}/workspaces/${currentWorkspace.id}/execute/export`;
      const iframe = document.createElement("iframe");
      iframe.name = `download-frame-${Date.now()}`;
      iframe.style.display = "none";
      document.body.appendChild(iframe);

      const form = document.createElement("form");
      form.method = "POST";
      form.action = action;
      form.target = iframe.name;
      form.style.display = "none";

      const appendField = (name: string, value?: string) => {
        if (value === undefined || value === null) {
          return;
        }
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      };

      appendField("connectionId", tab.connectionId);
      appendField("databaseId", tab.databaseId);
      appendField("databaseName", tab.databaseName);
      appendField("query", tab.content);
      appendField("format", format);
      appendField("filename", tab.title || "query-results");

      document.body.appendChild(form);
      form.submit();

      setSnackbarMessage(
        format === "csv" ? "CSV download started" : "NDJSON download started",
      );
      setSnackbarOpen(true);

      window.setTimeout(() => {
        form.remove();
        iframe.remove();
      }, 60000);
    },
    [currentWorkspace, tabs],
  );

  const handleConsoleCancel = async (tabId: string) => {
    const executionId = executionIdsRef.current[tabId];
    if (!currentWorkspace || !executionId) return;
    setCancellingTabs(prev => ({ ...prev, [tabId]: true }));
    abortControllersRef.current[tabId]?.abort();
    await cancelQuery(currentWorkspace.id, executionId);
  };

  const executeConsoleSave = async (
    tabId: string,
    contentToSave: string,
    savePath: string,
    comment: string,
  ): Promise<boolean> => {
    if (!currentWorkspace) return false;
    setIsSaving(true);
    let success = false;
    try {
      const currentTab = tabs[tabId];
      const connectionId = currentTab?.connectionId;
      const databaseId = currentTab?.databaseId;
      const databaseName = currentTab?.databaseName;

      const result = await saveConsole(
        currentWorkspace.id,
        tabId,
        contentToSave,
        savePath,
        connectionId,
        databaseName,
        databaseId,
        tabChartSpecs[tabId] ?? undefined,
        tabViewModes[tabId],
        comment,
      );

      // Handle conflict - show resolution dialog
      if (result.error === "conflict" && result.conflict) {
        setPendingSaveData({
          tabId,
          content: contentToSave,
          path: savePath,
          connectionId,
          databaseId,
          databaseName,
          comment,
        });
        setConflictData(result.conflict);
        setConflictDialogOpen(true);
        setIsSaving(false);
        return false;
      }

      if (result.success) {
        // Update file path and title
        updateFilePath(tabId, savePath);
        updateTitle(tabId, savePath);
        updateDirty(tabId, true);

        // Update saved state (isSaved=true, new savedStateHash)
        const newHash = computeConsoleStateHash(
          contentToSave,
          connectionId,
          databaseId,
          databaseName,
        );
        updateSavedState(tabId, true, newHash);

        trackEvent("console_saved", {
          console_id: tabId,
        });

        setSnackbarMessage(`Console saved to '${savePath}.js'`);
        setSnackbarOpen(true);
        success = true;
      } else {
        setErrorMessage(JSON.stringify(result.error, null, 2));
        setErrorModalOpen(true);
      }
    } catch (e: any) {
      setErrorMessage(JSON.stringify(e, null, 2));
      setErrorModalOpen(true);
    } finally {
      setIsSaving(false);
    }
    return success;
  };

  const handleConsoleSave = async (
    tabId: string,
    contentToSave: string,
    currentPath?: string,
  ): Promise<boolean> => {
    if (!currentWorkspace) {
      setErrorMessage("No workspace selected");
      setErrorModalOpen(true);
      return false;
    }

    if (!currentPath) {
      setSaveDialogMode("new");
      setSaveDialogTabId(tabId);
      setSaveDialogTargetId(tabId);
      setSaveDialogContent(contentToSave);
      setSaveDialogOpen(true);
      return false;
    }

    const vm = getVersionManager(tabId);
    const aiComments = vm?.getRecentAiComments() ?? [];
    const existingComment =
      aiComments.length > 0 ? aiComments.join("; ") : undefined;
    setSuggestedComment(existingComment);

    if (!existingComment && currentWorkspace?.id) {
      saveCommentAbortRef.current?.abort();
      const controller = new AbortController();
      saveCommentAbortRef.current = controller;
      setSuggestedCommentLoading(true);
      generateSaveComment(
        currentWorkspace.id,
        tabId,
        { newContent: contentToSave, source: "user" },
        controller.signal,
      ).then(comment => {
        if (!controller.signal.aborted) {
          setSuggestedComment(comment ?? undefined);
          setSuggestedCommentLoading(false);
        }
      });
    }

    return new Promise<boolean>(resolve => {
      setPendingCommentSave({
        tabId,
        content: contentToSave,
        path: currentPath,
        resolve,
      });
      setCommentDialogOpen(true);
    });
  };

  const handleCommentSaveConfirm = async (comment: string) => {
    setCommentDialogOpen(false);
    saveCommentAbortRef.current?.abort();
    setSuggestedCommentLoading(false);
    const pending = pendingCommentSave;
    setPendingCommentSave(null);
    if (!pending) return;
    const success = await executeConsoleSave(
      pending.tabId,
      pending.content,
      pending.path,
      comment,
    );
    pending.resolve(success);
  };

  const handleCommentSaveCancel = () => {
    setCommentDialogOpen(false);
    saveCommentAbortRef.current?.abort();
    setSuggestedCommentLoading(false);
    const pending = pendingCommentSave;
    setPendingCommentSave(null);
    pending?.resolve(false);
  };

  // Conflict resolution handlers
  const handleConflictOverwrite = async () => {
    if (!pendingSaveData || !currentWorkspace || !conflictData) return;

    const existingId = conflictData.existingId;

    // Check if the target console has an open tab
    const existingTab = tabs[existingId];
    if (existingTab) {
      // Check if the existing tab has unsaved changes by comparing current state to saved state
      const existingHash = existingTab.savedStateHash;
      const currentHash = computeConsoleStateHash(
        existingTab.content,
        existingTab.connectionId,
        existingTab.databaseId,
        existingTab.databaseName,
      );
      const hasChanges = !existingHash || currentHash !== existingHash;

      if (hasChanges) {
        const confirmed = window.confirm(
          `The file "${existingTab.title || conflictData.existingName}" is open in another tab with unsaved changes.\n\n` +
            `If you proceed, those unsaved changes will be lost.\n\n` +
            `Do you want to continue with the overwrite?`,
        );
        if (!confirmed) {
          return;
        }
      }
      // Close the existing tab since we're deleting that console
      closeTab(existingId);
    }

    setIsSaving(true);
    setConflictDialogOpen(false);

    try {
      // Step 1: Delete the existing console at the conflicting path
      const deleteResult = await deleteConsole(currentWorkspace.id, existingId);

      if (!deleteResult.success) {
        setErrorMessage(
          deleteResult.error || "Failed to delete existing console",
        );
        setErrorModalOpen(true);
        setIsSaving(false);
        setPendingSaveData(null);
        setConflictData(null);
        return;
      }

      // Step 2: Save our console with the path (same ID as before)
      const result = await saveConsole(
        currentWorkspace.id,
        pendingSaveData.tabId,
        pendingSaveData.content,
        pendingSaveData.path,
        pendingSaveData.connectionId,
        pendingSaveData.databaseName,
        pendingSaveData.databaseId,
        tabChartSpecs[pendingSaveData.tabId] ?? undefined,
        tabViewModes[pendingSaveData.tabId],
        pendingSaveData.comment,
      );

      if (result.success) {
        const tabId = pendingSaveData.tabId;

        // Update the tab properties
        updateFilePath(tabId, pendingSaveData.path);
        updateTitle(tabId, pendingSaveData.path);
        updateDirty(tabId, true);

        // Update saved state (isSaved=true, new savedStateHash)
        const newHash = computeConsoleStateHash(
          pendingSaveData.content,
          pendingSaveData.connectionId,
          pendingSaveData.databaseId,
          pendingSaveData.databaseName,
        );
        updateSavedState(tabId, true, newHash);

        // Update console tree
        const { useConsoleTreeStore } = await import(
          "../store/consoleTreeStore"
        );
        useConsoleTreeStore
          .getState()
          .addConsole(currentWorkspace.id, pendingSaveData.path, tabId);

        setSnackbarMessage(`Console saved at '${pendingSaveData.path}.js'`);
        setSnackbarOpen(true);

        trackEvent("console_saved", {
          console_id: tabId,
          is_new: true,
          was_overwrite: true,
        });
      } else {
        setErrorMessage(result.error || "Failed to save after overwrite");
        setErrorModalOpen(true);
      }
    } catch (error: any) {
      setErrorMessage(error?.message || "Failed to overwrite");
      setErrorModalOpen(true);
    }

    setPendingSaveData(null);
    setConflictData(null);
    setIsSaving(false);
  };

  const handleSaveDialogConfirm = async (
    name: string,
    folderId: string | null,
    _section: "my" | "workspace",
  ) => {
    if (!saveDialogTabId || !currentWorkspace) return;
    setSaveDialogOpen(false);

    // Build the path: if folderId is provided the API will handle folder association via the path or directly
    const savePath = name.endsWith(".js") ? name.slice(0, -3) : name;
    const targetId = saveDialogTargetId ?? saveDialogTabId;
    const mode = saveDialogMode;

    setIsSaving(true);
    try {
      // Source tab (for connection/chart/view-mode). Even in "save-as-copy",
      // the new record inherits these from the source tab.
      const sourceTab = tabs[saveDialogTabId];
      const connectionId = sourceTab?.connectionId;
      const databaseId = sourceTab?.databaseId;
      const databaseName = sourceTab?.databaseName;

      if (mode === "rename-move") {
        // PUT /consoles/:id — updates the existing console's path.
        const result = await saveConsole(
          currentWorkspace.id,
          targetId,
          saveDialogContent,
          savePath,
          connectionId,
          databaseName,
          databaseId,
          tabChartSpecs[saveDialogTabId] ?? undefined,
          tabViewModes[saveDialogTabId],
        );

        if (result.error === "conflict" && result.conflict) {
          setPendingSaveData({
            tabId: targetId,
            content: saveDialogContent,
            path: savePath,
            connectionId,
            databaseId,
            databaseName,
          });
          setConflictData(result.conflict);
          setConflictDialogOpen(true);
          setIsSaving(false);
          return;
        }

        if (result.success) {
          updateFilePath(targetId, savePath);
          updateTitle(targetId, savePath);
          updateDirty(targetId, true);

          const newHash = computeConsoleStateHash(
            saveDialogContent,
            connectionId,
            databaseId,
            databaseName,
          );
          updateSavedState(targetId, true, newHash);

          trackEvent("console_renamed", {
            console_id: targetId,
            new_path: savePath,
          });

          setSnackbarMessage(`Renamed to '${savePath}.js'`);
          setSnackbarOpen(true);

          const { useConsoleTreeStore } = await import(
            "../store/consoleTreeStore"
          );
          useConsoleTreeStore.getState().refresh(currentWorkspace.id);
        } else {
          setErrorMessage(JSON.stringify(result.error, null, 2));
          setErrorModalOpen(true);
        }

        return;
      }

      // Both "new" and "save-as-copy" use POST to create a new record.
      const response = await fetch(
        `/api/workspaces/${currentWorkspace.id}/consoles`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            id: targetId,
            path: savePath,
            content: saveDialogContent,
            connectionId,
            databaseName,
            databaseId,
            folderId: folderId || undefined,
            chartSpec: tabChartSpecs[saveDialogTabId] ?? null,
            resultsViewMode: tabViewModes[saveDialogTabId],
            comment: "",
          }),
        },
      );

      const result = await response.json();

      if (response.status === 409 && result.error === "conflict") {
        setPendingSaveData({
          tabId: targetId,
          content: saveDialogContent,
          path: savePath,
          connectionId,
          databaseId,
          databaseName,
        });
        setConflictData(result.conflict);
        setConflictDialogOpen(true);
        setIsSaving(false);
        return;
      }

      if (result.success) {
        if (mode === "save-as-copy") {
          // Do NOT mutate the source tab. Just refresh the tree so the copy
          // shows up. Optionally we could also open the new console as a tab,
          // but keep the UX conservative: user stays focused on their work.
          trackEvent("console_saved_as_copy", {
            source_console_id: saveDialogTabId,
            new_console_id: targetId,
          });
          setSnackbarMessage(`Saved a copy as '${savePath}.js'`);
          setSnackbarOpen(true);
        } else {
          // "new" — first-time save of a draft; update the originating tab.
          updateFilePath(targetId, savePath);
          updateTitle(targetId, savePath);
          updateDirty(targetId, true);

          const newHash = computeConsoleStateHash(
            saveDialogContent,
            connectionId,
            databaseId,
            databaseName,
          );
          updateSavedState(targetId, true, newHash);

          trackEvent("console_saved", {
            console_id: targetId,
            is_new: true,
          });

          setSnackbarMessage(`Console saved as '${savePath}'`);
          setSnackbarOpen(true);
        }

        const { useConsoleTreeStore } = await import(
          "../store/consoleTreeStore"
        );
        useConsoleTreeStore.getState().refresh(currentWorkspace.id);
      } else {
        setErrorMessage(JSON.stringify(result.error, null, 2));
        setErrorModalOpen(true);
      }
    } catch (e: any) {
      setErrorMessage(JSON.stringify(e, null, 2));
      setErrorModalOpen(true);
    } finally {
      setIsSaving(false);
      setSaveDialogTabId(null);
      setSaveDialogTargetId(null);
      setSaveDialogMode("new");
      setSaveDialogContent("");
    }
  };

  // "Save a Copy..." — POST a brand-new console record with a fresh id; the
  // currently open tab keeps pointing at the original file.
  const handleSaveAsCopy = (tabId: string, contentToSave: string) => {
    if (!currentWorkspace) {
      setErrorMessage("No workspace selected");
      setErrorModalOpen(true);
      return;
    }
    const newId = generateObjectId();
    setSaveDialogMode("save-as-copy");
    setSaveDialogTabId(tabId);
    setSaveDialogTargetId(newId);
    setSaveDialogContent(contentToSave);
    setSaveDialogOpen(true);
  };

  // "Rename / Move..." — relocate the existing console (same id) to a new path.
  const handleRenameMove = (
    tabId: string,
    contentToSave: string,
    currentPath?: string,
  ) => {
    if (!currentWorkspace) {
      setErrorMessage("No workspace selected");
      setErrorModalOpen(true);
      return;
    }
    if (!currentPath) {
      // Nothing to rename yet — fall back to first-time save flow.
      setSaveDialogMode("new");
      setSaveDialogTabId(tabId);
      setSaveDialogTargetId(tabId);
      setSaveDialogContent(contentToSave);
      setSaveDialogOpen(true);
      return;
    }
    setSaveDialogMode("rename-move");
    setSaveDialogTabId(tabId);
    setSaveDialogTargetId(tabId);
    setSaveDialogContent(contentToSave);
    setSaveDialogOpen(true);
  };

  const handleConflictSaveAsNew = () => {
    setConflictDialogOpen(false);
    setConflictData(null);

    if (pendingSaveData) {
      // Re-open the dialog to let the user pick a new name.
      setSaveDialogMode("new");
      setSaveDialogTabId(pendingSaveData.tabId);
      setSaveDialogTargetId(pendingSaveData.tabId);
      setSaveDialogContent(pendingSaveData.content);
      setSaveDialogOpen(true);
    }
    setPendingSaveData(null);
  };

  const handleConflictClose = () => {
    setConflictDialogOpen(false);
    setConflictData(null);
    setPendingSaveData(null);
  };

  const handleCloseErrorModal = () => {
    setErrorModalOpen(false);
    setErrorMessage("");
  };

  const handleCloseSnackbar = () => {
    setSnackbarOpen(false);
  };

  /* ----------------------------- Render ---------------------------- */
  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {consoleTabs.length > 0 ? (
        <Box
          sx={{
            height: "100%",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Tabs */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              minHeight: 36,
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToHorizontalAxis]}
              onDragEnd={handleTabDragEnd}
            >
              <SortableContext
                items={sortableTabIds}
                strategy={horizontalListSortingStrategy}
              >
                <Tabs
                  value={activeConsoleId}
                  onChange={handleTabChange}
                  variant="scrollable"
                  scrollButtons="auto"
                  sx={{
                    minHeight: 36,
                    "& .MuiTabs-indicator": { height: 2 },
                  }}
                >
                  {consoleTabs.map(tab => (
                    <SortableConsoleTab
                      key={tab.id}
                      value={tab.id}
                      sx={{
                        minHeight: 36,
                        py: 0.25,
                        px: 1.25,
                        textTransform: "none",
                      }}
                      label={
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                            minWidth: 0,
                            maxWidth: "100%",
                          }}
                        >
                          {tab.icon ? (
                            <Box
                              component="img"
                              src={tab.icon}
                              alt="tab icon"
                              sx={{ width: 18, height: 18 }}
                            />
                          ) : tab.kind === "settings" ? (
                            <SettingsIcon size={18} strokeWidth={1.5} />
                          ) : tab.kind === "connectors" ? (
                            <DataSourceIcon size={18} strokeWidth={1.5} />
                          ) : tab.kind === "flow-editor" ? (
                            tab.metadata?.flowType === "webhook" ? (
                              <WebhookIcon size={18} strokeWidth={1.5} />
                            ) : tab.metadata?.enabled === false ? (
                              <PauseIcon size={18} strokeWidth={1.5} />
                            ) : (
                              <ScheduleIcon size={18} strokeWidth={1.5} />
                            )
                          ) : tab.kind === "dashboard" ? (
                            <DashboardIcon size={18} strokeWidth={1.5} />
                          ) : (
                            <ConsoleIcon size={18} strokeWidth={1.5} />
                          )}
                          <span
                            style={{
                              fontStyle: tab.isDirty ? "normal" : "italic",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              display: "inline-block",
                              maxWidth: "150px",
                            }}
                            onDoubleClick={e => {
                              e.stopPropagation();
                              updateDirty(tab.id, true);
                            }}
                            title={tab.title}
                          >
                            {tab.title?.split("/").filter(Boolean).pop() ||
                              tab.title}
                          </span>
                          <IconButton
                            component="span"
                            size="small"
                            onClick={e => {
                              e.stopPropagation();
                              closeConsole(tab.id);
                            }}
                            onPointerDown={e => {
                              // Prevent the Tab's drag listener from starting
                              // a drag when the user clicks the close button.
                              e.stopPropagation();
                            }}
                            sx={{ p: 0.25, ml: 0.25 }}
                          >
                            <CloseIcon fontSize="inherit" />
                          </IconButton>
                        </Box>
                      }
                    />
                  ))}
                </Tabs>
              </SortableContext>
            </DndContext>
            <IconButton
              onClick={handleAddTab}
              size="small"
              sx={{ ml: 0.5, mr: 0.5, p: 0.5 }}
              title="Add new console tab"
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </Box>

          {/* Breadcrumb path (Cursor-style) — only for console tabs */}
          {(() => {
            const activeTab = activeConsoleId ? tabs[activeConsoleId] : null;
            if (activeTab?.kind !== "console") return null;
            const filePath = activeTab.filePath;
            const isUnsaved = !filePath;
            const segments = isUnsaved
              ? ["Unsaved console"]
              : [
                  activeTab.access === "workspace"
                    ? "Workspace"
                    : "My Consoles",
                  ...filePath.split("/").filter(Boolean),
                ];
            return (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  minHeight: 22,
                  px: 1.5,
                  py: 0.25,
                  backgroundColor: "background.paper",
                  color: "text.secondary",
                  fontSize: "0.75rem",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  gap: 0.25,
                }}
              >
                {segments.map((segment, index) => (
                  <Box
                    key={`${index}-${segment}`}
                    component="span"
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 0.25,
                      minWidth: 0,
                    }}
                  >
                    {index > 0 && (
                      <BreadcrumbChevronIcon
                        size={12}
                        strokeWidth={2}
                        style={{ flexShrink: 0, opacity: 0.6 }}
                      />
                    )}
                    <Box
                      component="span"
                      sx={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontStyle: isUnsaved ? "italic" : "normal",
                      }}
                    >
                      {segment}
                    </Box>
                  </Box>
                ))}
              </Box>
            );
          })()}

          {/* Unified tab rendering: every tab stays mounted, visibility toggled with CSS */}
          <Box sx={{ flexGrow: 1, overflow: "hidden" }}>
            {consoleTabs.map(tab => (
              <Box
                key={tab.id}
                sx={{
                  height: "100%",
                  display: activeConsoleId === tab.id ? "block" : "none",
                  overflow: "hidden",
                }}
              >
                {tab.kind === "settings" ? (
                  <Settings />
                ) : tab.kind === "members" ? (
                  <WorkspaceMembers />
                ) : tab.kind === "connectors" ? (
                  <ConnectorTab
                    tabId={tab.id}
                    sourceId={
                      typeof tab.content === "string" ? tab.content : undefined
                    }
                  />
                ) : tab.kind === "flow-editor" ? (
                  <FlowEditor
                    flowId={tab.metadata?.flowId as string | undefined}
                    isNew={tab.metadata?.isNew as boolean | undefined}
                    flowType={
                      tab.metadata?.flowType as
                        | "webhook"
                        | "scheduled"
                        | "db-scheduled"
                        | undefined
                    }
                    onSave={() => {
                      // The FlowEditor already handles refreshing the flows list
                    }}
                    onCancel={() => {
                      closeConsole(tab.id);
                    }}
                    dbFlowFormRef={dbFlowFormRef}
                  />
                ) : tab.kind === "dashboard" ? (
                  <DashboardCanvas
                    dashboardId={tab.metadata?.dashboardId as string}
                    isNew={tab.metadata?.isNew as boolean}
                    onCreated={(newId: string) => {
                      useConsoleStore.setState(state => {
                        const existingTab = state.tabs[tab.id];
                        if (existingTab) {
                          existingTab.metadata = {
                            ...existingTab.metadata,
                            dashboardId: newId,
                            isNew: false,
                          };
                          existingTab.title = "Untitled Dashboard";
                        }
                      });
                    }}
                  />
                ) : (
                  /* Console tab: editor + results split */
                  <PanelGroup
                    direction="vertical"
                    style={{ height: "100%", width: "100%" }}
                  >
                    <Panel defaultSize={60} minSize={1}>
                      <Console
                        ref={consoleRefs.current[tab.id]}
                        consoleId={tab.id}
                        initialContent={tab.content}
                        title={tab.title}
                        onExecute={(content, connectionId, databaseId) =>
                          handleConsoleExecute(tab.id, content, connectionId, {
                            databaseId: databaseId || tab.databaseId,
                            databaseName: tab.databaseName,
                          })
                        }
                        onCancel={() => handleConsoleCancel(tab.id)}
                        onSave={(content, currentPath) =>
                          handleConsoleSave(tab.id, content, currentPath)
                        }
                        onSaveAsCopy={content =>
                          handleSaveAsCopy(tab.id, content)
                        }
                        onRenameMove={(content, currentPath) =>
                          handleRenameMove(tab.id, content, currentPath)
                        }
                        isExecuting={executingTabs[tab.id] || false}
                        isCancelling={cancellingTabs[tab.id] || false}
                        isSaving={isSaving}
                        onContentChange={content => {
                          updateContent(tab.id, content);
                          if (!tab.isDirty) {
                            updateDirty(tab.id, true);
                          }
                          // Also refresh activeEditorContent for Chat consumers
                          const ref = consoleRefs.current[tab.id]?.current;
                          if (activeConsoleId === tab.id && ref) {
                            setActiveEditorContent(ref.getCurrentContent());
                          }
                        }}
                        connectionId={tab.connectionId}
                        databaseId={tab.databaseId}
                        databaseName={tab.databaseName}
                        databases={availableDatabases}
                        onDatabaseChange={connId =>
                          updateConnection(tab.id, connId)
                        }
                        onDatabaseNameChange={(dbId, dbName) =>
                          updateDatabase(tab.id, dbId, dbName)
                        }
                        filePath={tab.filePath}
                        enableVersionControl={true}
                        onHistoryClick={() => {
                          setVersionHistoryTabId(tab.id);
                          setVersionHistoryEntityType("console");
                          setVersionHistoryOpen(true);
                        }}
                        historyAvailable={tab.isSaved}
                      />
                    </Panel>

                    <StyledVerticalResizeHandle />

                    <Panel defaultSize={40} minSize={1}>
                      <Box sx={{ height: "100%", overflow: "hidden" }}>
                        <ResultsTable
                          results={tabResults[tab.id] || null}
                          chartSpec={tabChartSpecs[tab.id] ?? null}
                          onChartSpecChange={spec =>
                            setChartSpecForTab(tab.id, spec)
                          }
                          viewMode={tabViewModes[tab.id] ?? "table"}
                          onViewModeChange={mode =>
                            setViewModeForTab(tab.id, mode)
                          }
                          onChartRenderError={error => {
                            const cb = pendingRenderCallbackRef.current[tab.id];
                            if (cb) {
                              cb({ success: false, error });
                              delete pendingRenderCallbackRef.current[tab.id];
                            }
                          }}
                          onChartRenderSuccess={() => {
                            const cb = pendingRenderCallbackRef.current[tab.id];
                            if (cb) {
                              cb({ success: true });
                              delete pendingRenderCallbackRef.current[tab.id];
                            }
                          }}
                          onPreviousPage={() =>
                            handlePreviousResultsPage(tab.id)
                          }
                          onNextPage={() => handleNextResultsPage(tab.id)}
                          onDownload={format =>
                            handleDownloadResults(tab.id, format)
                          }
                        />
                      </Box>
                    </Panel>
                  </PanelGroup>
                )}
              </Box>
            ))}
          </Box>
        </Box>
      ) : (
        <Box
          sx={{
            flexGrow: 1,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
          }}
        >
          <Typography>No console open</Typography>
          <Button
            variant="contained"
            disableElevation
            onClick={() => {
              openTab({
                title: "New Console",
                content: "",
              });
            }}
          >
            Open Console
          </Button>
        </Box>
      )}

      {/* Error Modal */}
      <Dialog
        open={errorModalOpen}
        onClose={handleCloseErrorModal}
        maxWidth="md"
        fullWidth
        PaperProps={{ sx: { maxHeight: "80vh" } }}
      >
        <DialogTitle
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Typography variant="h6" color="error">
            Operation Error
          </Typography>
          <IconButton aria-label="close" onClick={handleCloseErrorModal}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Box component="pre" sx={{ p: 2, overflow: "auto" }}>
            {errorMessage}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={handleCloseErrorModal}
            variant="contained"
            disableElevation
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Conflict Resolution Dialog */}
      <ConflictResolutionDialog
        open={conflictDialogOpen}
        onClose={handleConflictClose}
        conflict={conflictData}
        newContent={pendingSaveData?.content || ""}
        onOverwrite={handleConflictOverwrite}
        onSaveAsNew={handleConflictSaveAsNew}
        isProcessing={isSaving}
      />

      {/* Save Dialog (folder navigator) */}
      <FileExplorerDialog
        open={saveDialogOpen}
        onClose={() => {
          setSaveDialogOpen(false);
          setSaveDialogTabId(null);
          setSaveDialogTargetId(null);
          setSaveDialogMode("new");
          setSaveDialogContent("");
        }}
        mode="save"
        onSave={handleSaveDialogConfirm}
        defaultName={(() => {
          if (!saveDialogTabId) return "";
          const tab = tabs[saveDialogTabId];
          if (!tab) return "";
          if (saveDialogMode === "save-as-copy") {
            const base = tab.filePath || tab.title || "";
            return base ? `${base} (copy)` : "";
          }
          if (saveDialogMode === "rename-move") {
            return tab.filePath || tab.title || "";
          }
          return tab.title || "";
        })()}
        isSaving={isSaving}
      />

      {/* Save comment dialog (version commit message) */}
      <SaveCommentDialog
        open={commentDialogOpen}
        onSave={handleCommentSaveConfirm}
        onCancel={handleCommentSaveCancel}
        title="Save Console"
        defaultComment={suggestedComment}
        loading={suggestedCommentLoading}
      />

      {/* Version history panel */}
      {versionHistoryTabId && (
        <VersionHistoryPanel
          open={versionHistoryOpen}
          onClose={() => {
            setVersionHistoryOpen(false);
            setVersionHistoryTabId(null);
          }}
          entityType={versionHistoryEntityType}
          entityId={versionHistoryTabId}
          onRestore={() => {
            if (currentWorkspace && versionHistoryTabId) {
              reloadConsole(currentWorkspace.id, versionHistoryTabId);
            }
          }}
        />
      )}

      {/* Success Snackbar */}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={6000}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={handleCloseSnackbar}
          severity="success"
          sx={{ width: "100%" }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>

      {/* Lock Conflict Dialog (human-in-the-loop for agent enter_edit_mode) */}
      <LockConflictDialog />

      {/* Unsaved Dashboard Changes Dialog */}
      <Dialog
        open={pendingDashboardCloseTabId !== null}
        onClose={handleDashboardCloseCancel}
      >
        <DialogTitle>Unsaved Changes</DialogTitle>
        <DialogContent>
          <Typography>
            This dashboard has unsaved changes. Do you want to save before
            closing?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDashboardCloseDiscard} color="error">
            Discard
          </Button>
          <Button onClick={handleDashboardCloseCancel}>Cancel</Button>
          <Button onClick={handleDashboardCloseSave} variant="contained">
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default Editor;
