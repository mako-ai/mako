import React, { useRef, useEffect, useState, useCallback } from "react";
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
import { useConsoleStore } from "../store/consoleStore";
import { useDashboardStore } from "../store/dashboardStore";
import { useUIStore } from "../store/uiStore";
import { useSchemaStore } from "../store/schemaStore";
import { useWorkspace } from "../contexts/workspace-context";
import { ConsoleModification } from "../hooks/useMonacoConsole";
import { useSqlAutocomplete } from "../hooks/useSqlAutocomplete";
import { trackEvent } from "../lib/analytics";
import { getApiBasePath } from "../lib/api-base-path";
import { computeConsoleStateHash } from "../utils/stateHash";

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
  const [tabChartSpecs, setTabChartSpecs] = useState<
    Record<string, import("../lib/chart-spec").MakoChartSpec | null>
  >({});
  const [tabViewModes, setTabViewModes] = useState<
    Record<string, ResultsViewMode>
  >({});
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

  // Conflict resolution state
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [conflictData, setConflictData] = useState<ConflictData | null>(null);
  const [pendingSaveData, setPendingSaveData] = useState<{
    tabId: string;
    content: string;
    path: string;
    connectionId?: string;
    databaseId?: string;
    databaseName?: string;
  } | null>(null);

  // Refs for query cancellation (per-tab to support parallel queries)
  const abortControllersRef = useRef<Record<string, AbortController | null>>(
    {},
  );
  const executionIdsRef = useRef<Record<string, string | null>>({});

  // Tab store
  const {
    tabs,
    activeTabId,
    closeTab,
    updateContent,
    updateConnection,
    updateDatabase,
    updateFilePath,
    updateTitle,
    updateDirty,
    updateSavedState,
    setActiveTab,
    executeQuery,
    cancelQuery,
    saveConsole,
    deleteConsole,
    openTab,
  } = useConsoleStore();
  const consoleTabs = Object.values(tabs);
  const activeConsoleId = activeTabId;

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
        setTabChartSpecs(prev => ({ ...prev, [tabId]: payload.spec }));
        setTabViewModes(prev => ({ ...prev, [tabId]: "chart" }));
      };
    }
    return () => {
      if (onChartSpecChangeRef) {
        onChartSpecChangeRef.current = undefined;
      }
    };
  }, [activeTabId, onChartSpecChangeRef]);

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

  /* ------------------------ Console Actions ------------------------ */
  const handleTabChange = (_: React.SyntheticEvent, newValue: string) => {
    setActiveTab(newValue);
  };

  const closeConsole = (id: string) => {
    const closingTab = tabs[id];
    if (closingTab?.kind === "dashboard") {
      const dbId = closingTab.metadata?.dashboardId as string | undefined;
      if (dbId) {
        useDashboardStore.getState().closeDashboard(dbId);
      }
    }
    closeTab(id);
    delete consoleRefs.current[id];
    setTabResults(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setTabPagination(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
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

    setIsSaving(true);
    let success = false;
    try {
      // Get the current tab info (needed for default filename and connection info)
      const currentTab = tabs[tabId];

      const savePath = currentPath;
      if (!savePath) {
        // Open the folder navigator save dialog instead of prompt()
        setSaveDialogTabId(tabId);
        setSaveDialogContent(contentToSave);
        setSaveDialogOpen(true);
        setIsSaving(false);
        return false;
      }

      // Get the current connection and database info for the tab
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
          is_new: !currentPath,
        });

        setSnackbarMessage(
          `Console saved ${!currentPath ? "as" : "to"} '${savePath}.js'`,
        );
        setSnackbarOpen(true);
        success = true;

        // Add the console to the tree
        if (!currentPath) {
          const { useConsoleTreeStore } = await import(
            "../store/consoleTreeStore"
          );
          useConsoleTreeStore
            .getState()
            .addConsole(currentWorkspace.id, savePath ?? "", tabId);
        }
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

    setIsSaving(true);
    try {
      const currentTab = tabs[saveDialogTabId];
      const connectionId = currentTab?.connectionId;
      const databaseId = currentTab?.databaseId;
      const databaseName = currentTab?.databaseName;

      // Use POST to create with explicit folderId
      const response = await fetch(
        `/api/workspaces/${currentWorkspace.id}/consoles`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            id: saveDialogTabId,
            path: savePath,
            content: saveDialogContent,
            connectionId,
            databaseName,
            databaseId,
            folderId: folderId || undefined,
          }),
        },
      );

      const result = await response.json();

      if (response.status === 409 && result.error === "conflict") {
        setPendingSaveData({
          tabId: saveDialogTabId,
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
        const tabId = saveDialogTabId;
        updateFilePath(tabId, savePath);
        updateTitle(tabId, savePath);
        updateDirty(tabId, true);

        const newHash = computeConsoleStateHash(
          saveDialogContent,
          connectionId,
          databaseId,
          databaseName,
        );
        updateSavedState(tabId, true, newHash);

        trackEvent("console_saved", {
          console_id: tabId,
          is_new: true,
        });

        setSnackbarMessage(`Console saved as '${savePath}'`);
        setSnackbarOpen(true);

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
      setSaveDialogContent("");
    }
  };

  const handleConflictSaveAsNew = () => {
    setConflictDialogOpen(false);
    setConflictData(null);

    if (pendingSaveData) {
      // Open save dialog with a suggested copy name
      setSaveDialogTabId(pendingSaveData.tabId);
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
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <Tabs
              value={activeConsoleId}
              onChange={handleTabChange}
              variant="scrollable"
              scrollButtons="auto"
            >
              {consoleTabs.map(tab => (
                <Tab
                  key={tab.id}
                  value={tab.id}
                  label={
                    <Box
                      sx={{ display: "flex", alignItems: "center", gap: 0.75 }}
                    >
                      {tab.icon ? (
                        <Box
                          component="img"
                          src={tab.icon}
                          alt="tab icon"
                          sx={{ width: 20, height: 20 }}
                        />
                      ) : tab.kind === "settings" ? (
                        <SettingsIcon size={20} strokeWidth={1.5} />
                      ) : tab.kind === "connectors" ? (
                        <DataSourceIcon size={20} strokeWidth={1.5} />
                      ) : tab.kind === "flow-editor" ? (
                        tab.metadata?.flowType === "webhook" ? (
                          <WebhookIcon size={20} strokeWidth={1.5} />
                        ) : tab.metadata?.enabled === false ? (
                          <PauseIcon size={20} strokeWidth={1.5} />
                        ) : (
                          <ScheduleIcon size={20} strokeWidth={1.5} />
                        )
                      ) : tab.kind === "dashboard" ? (
                        <DashboardIcon size={20} strokeWidth={1.5} />
                      ) : (
                        <ConsoleIcon size={20} strokeWidth={1.5} />
                      )}
                      <span
                        style={{
                          fontStyle: tab.isDirty ? "normal" : "italic",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "150px",
                        }}
                        onDoubleClick={e => {
                          e.stopPropagation();
                          updateDirty(tab.id, true);
                        }}
                      >
                        {tab.title}
                      </span>
                      <IconButton
                        component="span"
                        size="small"
                        onClick={e => {
                          e.stopPropagation();
                          closeConsole(tab.id);
                        }}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  }
                />
              ))}
            </Tabs>
            <IconButton
              onClick={handleAddTab}
              size="small"
              sx={{ ml: 1, mr: 1 }}
              title="Add new console tab"
            >
              <AddIcon />
            </IconButton>
          </Box>

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
                      />
                    </Panel>

                    <StyledVerticalResizeHandle />

                    <Panel defaultSize={40} minSize={1}>
                      <Box sx={{ height: "100%", overflow: "hidden" }}>
                        <ResultsTable
                          results={tabResults[tab.id] || null}
                          chartSpec={tabChartSpecs[tab.id] ?? null}
                          onChartSpecChange={spec =>
                            setTabChartSpecs(prev => ({
                              ...prev,
                              [tab.id]: spec,
                            }))
                          }
                          viewMode={tabViewModes[tab.id] ?? "table"}
                          onViewModeChange={mode =>
                            setTabViewModes(prev => ({
                              ...prev,
                              [tab.id]: mode,
                            }))
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
          setSaveDialogContent("");
        }}
        mode="save"
        onSave={handleSaveDialogConfirm}
        defaultName={saveDialogTabId ? tabs[saveDialogTabId]?.title || "" : ""}
        isSaving={isSaving}
      />

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
    </Box>
  );
}

export default Editor;
