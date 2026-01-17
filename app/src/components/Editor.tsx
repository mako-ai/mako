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
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { loader } from "@monaco-editor/react";
import Console, { ConsoleRef } from "./Console";
import ResultsTable from "./ResultsTable";
import Settings from "../pages/Settings";
import ConnectorTab from "./ConnectorTab";
import { WorkspaceMembers } from "./WorkspaceMembers";
import { FlowEditor } from "./FlowEditor";
import ConflictResolutionDialog, {
  ConflictData,
} from "./ConflictResolutionDialog";
import { useConsoleStore } from "../store/consoleStore";
import { useAppStore, useAppDispatch } from "../store";
import { useWorkspace } from "../contexts/workspace-context";
import { ConsoleModification } from "../hooks/useMonacoConsole";
import { useSqlAutocomplete } from "../hooks/useSqlAutocomplete";
import { trackEvent } from "../lib/analytics";

interface QueryResult {
  results: any[];
  executedAt: string;
  resultCount: number;
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

function Editor() {
  const { currentWorkspace } = useWorkspace();
  const dispatch = useAppDispatch();
  const [tabResults, setTabResults] = useState<
    Record<string, QueryResult | null>
  >({});
  const [isExecuting, setIsExecuting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");
  const [availableDatabases, setAvailableDatabases] = useState<
    {
      id: string;
      name: string;
      description: string;
      database: string;
      type: string;
      active: boolean;
      lastConnectedAt?: string;
      connection: {
        host?: string;
        port?: number;
        connectionString?: string;
      };
      displayName: string;
      hostKey: string;
      hostName: string;
    }[]
  >([]);

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

  // Refs for query cancellation
  const abortControllerRef = useRef<AbortController | null>(null);
  const executionIdRef = useRef<string | null>(null);

  // Tab store
  const {
    consoleTabs,
    activeConsoleId,
    removeConsoleTab,
    updateConsoleContent,
    updateConsoleConnection,
    updateConsoleDatabase,
    updateConsoleSavedDatabase,
    updateConsoleFilePath,
    updateConsoleTitle,
    updateConsoleDirty,
    setActiveConsole,
    executeQuery,
    cancelQuery,
    saveConsole,
    replaceTabId,
    hasUnsavedChanges,
    getTabById,
  } = useConsoleStore();

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
  const setActiveEditorContent = useAppStore(
    state => state.setActiveEditorContent,
  );

  // Update active editor content when tab focus changes AND focus the Monaco editor
  useEffect(() => {
    if (activeConsoleId && consoleRefs.current[activeConsoleId]?.current) {
      const consoleRef = consoleRefs.current[activeConsoleId].current;
      const content = consoleRef.getCurrentContent();
      setActiveEditorContent(content);

      // Focus the Monaco editor in the active console
      // This ensures CMD+Enter executes the correct console after tab switching
      // Use requestAnimationFrame to ensure the tab visibility CSS has been applied
      requestAnimationFrame(() => {
        // Double RAF to ensure layout is complete
        requestAnimationFrame(() => {
          consoleRef.focus();
        });
      });
    } else {
      setActiveEditorContent(undefined);
    }
  }, [activeConsoleId, consoleTabs.length, setActiveEditorContent]);

  // Update the page title based on the active tab
  useEffect(() => {
    const baseTitle = "Mako RevOps";
    if (!activeConsoleId) {
      document.title = baseTitle;
      return;
    }
    const activeTab = consoleTabs.find(tab => tab.id === activeConsoleId);
    document.title = activeTab?.title
      ? `${activeTab.title} - ${baseTitle}`
      : baseTitle;
  }, [activeConsoleId, consoleTabs]);

  // Fetch databases when workspace changes
  useEffect(() => {
    const fetchDatabases = async () => {
      if (!currentWorkspace) return;
      try {
        const { apiClient } = await import("../lib/api-client");
        const res = await apiClient.get<{
          success: boolean;
          data: any[];
        }>(`/workspaces/${currentWorkspace.id}/databases`);
        if (res.success) setAvailableDatabases((res as any).data);
      } catch (e) {
        console.error("Failed to fetch databases list", e);
      }
    };
    fetchDatabases();
  }, [currentWorkspace]);

  // Load Monaco instance for unified SQL autocomplete
  const [monacoInstance, setMonacoInstance] = useState<unknown>(null);
  useEffect(() => {
    loader.init().then(monaco => setMonacoInstance(monaco));
  }, []);

  // Dynamic getters for unified SQL autocomplete (reads from active console)
  // These getters read directly from the store at call time to avoid stale closures.
  // This is critical for autocomplete to work correctly when switching consoles.
  const getWorkspaceId = useCallback(
    () => currentWorkspace?.id,
    [currentWorkspace?.id],
  );

  // Use a ref to track availableDatabases so getConnectionType can access fresh values
  const availableDatabasesRef = useRef(availableDatabases);
  useEffect(() => {
    availableDatabasesRef.current = availableDatabases;
  }, [availableDatabases]);

  const getConnectionId = useCallback(() => {
    // Read fresh state from the store at call time (not from closed-over React state)
    const state = useAppStore.getState();
    const tabs = state.consoles.tabs;
    const activeTabId = state.consoles.activeTabId;
    const activeTab = activeTabId ? tabs[activeTabId] : null;
    return activeTab?.connectionId;
  }, []); // Empty deps - always reads fresh from store

  const getConnectionType = useCallback(() => {
    // Read fresh state from the store at call time
    const state = useAppStore.getState();
    const tabs = state.consoles.tabs;
    const activeTabId = state.consoles.activeTabId;
    const activeTab = activeTabId ? tabs[activeTabId] : null;
    const connectionId = activeTab?.connectionId;
    // Use ref to get current availableDatabases without causing effect re-runs
    const connection = availableDatabasesRef.current.find(
      db => db.id === connectionId,
    );
    return connection?.type;
  }, []); // Empty deps - reads fresh from store and ref

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

      // Prefer the explicitly provided consoleId from the event (e.g., from create_console),
      // only fall back to activeConsoleId if no explicit ID was provided
      const targetConsoleId = eventConsoleId || activeConsoleId;

      // Function to show diff with retry
      const showDiffWithRetry = (retries = 10, delay = 100) => {
        if (consoleRefs.current[targetConsoleId]?.current) {
          consoleRefs.current[targetConsoleId].current.showDiff(modification);
        } else if (retries > 0) {
          // Keep retrying silently
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

      // Start the retry mechanism
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
    setActiveConsole(newValue);
  };

  const closeConsole = (id: string) => {
    removeConsoleTab(id);
    delete consoleRefs.current[id];
  };

  const handleAddTab = () => {
    useConsoleStore.getState().addConsoleTab({
      title: "New Console",
      content: "",
      initialContent: "",
    });
  };

  const handleConsoleExecute = async (
    tabId: string,
    contentToExecute: string,
    connectionId?: string,
    options?: {
      databaseId?: string;
      databaseName?: string;
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

    // Set up abort controller and execution ID
    abortControllerRef.current = new AbortController();
    executionIdRef.current = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    setIsExecuting(true);
    setIsCancelling(false);
    const startTime = Date.now();
    try {
      const result = await executeQuery(
        currentWorkspace.id,
        connectionId,
        contentToExecute,
        {
          ...options,
          executionId: executionIdRef.current,
          signal: abortControllerRef.current.signal,
        },
      );
      const executionTime = Date.now() - startTime;
      if (result.success) {
        // Track successful query execution
        trackEvent("query_executed", {
          connection_id: connectionId,
          success: true,
          duration_ms: executionTime,
        });

        setTabResults(prev => ({
          ...prev,
          [tabId]: {
            results: result.data,
            executedAt: new Date().toISOString(),
            resultCount: Array.isArray(result.data) ? result.data.length : 1,
            executionTime,
          },
        }));
      } else if (result.error !== "Query cancelled") {
        setErrorMessage(JSON.stringify(result.error, null, 2));
        setErrorModalOpen(true);
        setTabResults(prev => ({ ...prev, [tabId]: null }));
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setErrorMessage(JSON.stringify(e, null, 2));
        setErrorModalOpen(true);
        setTabResults(prev => ({ ...prev, [tabId]: null }));
      }
    } finally {
      setIsExecuting(false);
      setIsCancelling(false);
      abortControllerRef.current = null;
      executionIdRef.current = null;
    }
  };

  const handleConsoleCancel = async () => {
    if (!currentWorkspace || !executionIdRef.current) return;
    setIsCancelling(true);
    abortControllerRef.current?.abort();
    await cancelQuery(currentWorkspace.id, executionIdRef.current);
  };

  const handleConsoleSave = async (
    tabId: string,
    contentToSave: string,
    currentPath?: string,
    forceNew?: boolean, // Force POST (create) even when path is provided - used by conflict resolution "Save as New"
  ): Promise<boolean> => {
    if (!currentWorkspace) {
      setErrorMessage("No workspace selected");
      setErrorModalOpen(true);
      return false;
    }

    setIsSaving(true);
    let success = false;
    try {
      let savePath = currentPath;
      let isNew = forceNew || false;
      if (!savePath) {
        const fileName = prompt(
          "Enter a file name to save (e.g., myFolder/myConsole). .js will be appended if absent.",
        );
        if (!fileName) {
          setIsSaving(false);
          return false;
        }
        savePath = fileName.endsWith(".js") ? fileName.slice(0, -3) : fileName;
        isNew = true;
      }

      // Get the current connection and database info for the tab
      const currentTab = consoleTabs.find(tab => tab.id === tabId);
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
        isNew,
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
        // Determine which ID to use - server may return a different ID if it
        // overwrote a placeholder console at the same path
        const actualId = result.id || tabId;
        const idChanged = actualId !== tabId;

        // If the server used a different ID (e.g., overwrote a placeholder),
        // update our tab to use the server's ID for consistency
        if (idChanged && isNew) {
          replaceTabId(tabId, actualId);
        }

        // Use the actual ID for all state updates
        const idToUpdate = idChanged && isNew ? actualId : tabId;

        // Update file path and title for new files (POST)
        if (isNew && savePath) {
          updateConsoleFilePath(idToUpdate, savePath);
        }

        // Keep the full path as the title to distinguish between files with same name
        if (savePath) {
          updateConsoleTitle(idToUpdate, savePath);
        }

        // Mark tab as dirty since it's now saved and should be persistent
        updateConsoleDirty(idToUpdate, true);

        // Update the saved database values to reflect what was just persisted
        // This is used for dirty state tracking in the Console component
        updateConsoleSavedDatabase(
          idToUpdate,
          connectionId,
          databaseId,
          databaseName,
        );

        // Track console save
        trackEvent("console_saved", {
          console_id: actualId,
          is_new: isNew,
          id_changed: idChanged,
        });

        setSnackbarMessage(
          `Console saved ${isNew ? "as" : "to"} '${savePath}.js'`,
        );
        setSnackbarOpen(true);
        success = true;

        // Just add the console to the tree - no refresh needed
        if (isNew) {
          const { useConsoleTreeStore } = await import(
            "../store/consoleTreeStore"
          );
          // Use the actual ID returned by the server (may differ from tabId
          // if a placeholder console was overwritten at the same path)
          useConsoleTreeStore
            .getState()
            .addConsole(currentWorkspace.id, savePath!, actualId);
        }

        // Refresh the console tree directly via store
        // No blocking refresh here; tree already updated optimistically
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

    // Check if the target console has an open tab with unsaved local changes.
    // If so, warn the user - their local edits in that tab will be lost because
    // we're replacing the server content with the draft's content.
    const existingTab = getTabById(existingId);
    if (existingTab && hasUnsavedChanges(existingId)) {
      const confirmed = window.confirm(
        `The file "${existingTab.title || conflictData.existingName}" is open in another tab with unsaved changes.\n\n` +
          `If you proceed, those unsaved changes will be lost.\n\n` +
          `Do you want to continue with the overwrite?`,
      );
      if (!confirmed) {
        // User cancelled - keep the conflict dialog open
        return;
      }
      // User confirmed - close the existing tab first to avoid silent data loss
      // This is explicit rather than letting replaceTabId silently delete it
      removeConsoleTab(existingId);
    }

    setIsSaving(true);
    setConflictDialogOpen(false);

    try {
      const { apiClient } = await import("../lib/api-client");

      // Safe overwrite: Update the existing console in place with new content.
      // This is atomic - if it fails, the original content is preserved.
      // We update the existing console rather than delete-then-create to avoid
      // data loss if the save fails after delete.
      // isSaved: true tells the backend this is an explicit save (not auto-save draft)
      // which disables upsert to prevent creating ghost drafts if the target was deleted.
      const result = await apiClient.put<{
        success: boolean;
        data?: any;
        error?: string;
      }>(`/workspaces/${currentWorkspace.id}/consoles/${existingId}`, {
        content: pendingSaveData.content,
        connectionId: pendingSaveData.connectionId,
        databaseName: pendingSaveData.databaseName,
        databaseId: pendingSaveData.databaseId,
        isSaved: true, // Explicit save: fail if target doesn't exist (race condition protection)
      });

      if (result.success) {
        // Update local state to use the existing console's ID since we've taken it over
        const oldTabId = pendingSaveData.tabId;

        // Replace the tab ID so future saves go to the correct console
        replaceTabId(oldTabId, existingId);

        // Update the tab properties (now using the new ID)
        updateConsoleFilePath(existingId, pendingSaveData.path);
        updateConsoleTitle(existingId, pendingSaveData.path);
        updateConsoleDirty(existingId, true); // Mark as persistent (not replaceable) after successful save
        updateConsoleSavedDatabase(
          existingId,
          pendingSaveData.connectionId,
          pendingSaveData.databaseId,
          pendingSaveData.databaseName,
        );

        // Update console tree
        const { useConsoleTreeStore } = await import(
          "../store/consoleTreeStore"
        );
        useConsoleTreeStore
          .getState()
          .addConsole(currentWorkspace.id, pendingSaveData.path, existingId);

        setSnackbarMessage(
          `Console overwritten at '${pendingSaveData.path}.js'`,
        );
        setSnackbarOpen(true);

        trackEvent("console_saved", {
          console_id: existingId,
          is_new: false,
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

  const handleConflictSaveAsNew = () => {
    setConflictDialogOpen(false);
    setConflictData(null);

    if (pendingSaveData) {
      // Prompt for a new filename
      const newFileName = prompt(
        "Enter a different file name:",
        pendingSaveData.path + "_copy",
      );
      if (newFileName) {
        const newPath = newFileName.endsWith(".js")
          ? newFileName.slice(0, -3)
          : newFileName;
        // Retry save with new path - force POST to create at the new location
        handleConsoleSave(
          pendingSaveData.tabId,
          pendingSaveData.content,
          newPath,
          true, // forceNew: create new console at the new path
        );
      }
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
                          updateConsoleDirty(tab.id, true);
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
                    flowId={tab.metadata?.flowId}
                    isNew={tab.metadata?.isNew}
                    flowType={tab.metadata?.flowType}
                    onSave={() => {
                      // The FlowEditor already handles refreshing the flows list
                      // We don't need to close the tab anymore
                    }}
                    onCancel={() => {
                      closeConsole(tab.id);
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
                        dbContentHash={tab.dbContentHash}
                        title={tab.title}
                        onExecute={(content, connectionId, databaseId) =>
                          handleConsoleExecute(tab.id, content, connectionId, {
                            databaseId: databaseId || tab.databaseId,
                            databaseName: tab.databaseName,
                          })
                        }
                        onCancel={handleConsoleCancel}
                        onSave={(content, currentPath) =>
                          handleConsoleSave(tab.id, content, currentPath)
                        }
                        isExecuting={isExecuting}
                        isCancelling={isCancelling}
                        isSaving={isSaving}
                        onContentChange={content => {
                          updateConsoleContent(tab.id, content);
                          if (content !== tab.initialContent && !tab.isDirty) {
                            updateConsoleDirty(tab.id, true);
                          }
                          // Also refresh activeEditorContent for Chat consumers
                          const ref = consoleRefs.current[tab.id]?.current;
                          if (activeConsoleId === tab.id && ref) {
                            setActiveEditorContent(ref.getCurrentContent());
                          }
                        }}
                        onSaveSuccess={newDbContentHash => {
                          // Update the dbContentHash in the store
                          dispatch({
                            type: "UPDATE_CONSOLE_DB_HASH",
                            payload: {
                              id: tab.id,
                              dbContentHash: newDbContentHash,
                            },
                          });
                        }}
                        // Current database selection (single source of truth from store)
                        connectionId={tab.connectionId}
                        databaseId={tab.databaseId}
                        databaseName={tab.databaseName}
                        // Saved database values (for dirty tracking)
                        savedConnectionId={tab.savedConnectionId}
                        savedDatabaseId={tab.savedDatabaseId}
                        savedDatabaseName={tab.savedDatabaseName}
                        databases={availableDatabases}
                        onDatabaseChange={connId =>
                          updateConsoleConnection(tab.id, connId)
                        }
                        onDatabaseNameChange={(dbId, dbName) =>
                          updateConsoleDatabase(tab.id, dbId, dbName)
                        }
                        filePath={tab.filePath}
                        enableVersionControl={true}
                      />
                    </Panel>

                    <StyledVerticalResizeHandle />

                    <Panel defaultSize={40} minSize={1}>
                      <Box sx={{ height: "100%", overflow: "hidden" }}>
                        <ResultsTable results={tabResults[tab.id] || null} />
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
              // Add a blank tab on demand
              useConsoleStore.getState().addConsoleTab({
                title: "New Console",
                content: "",
                initialContent: "",
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
