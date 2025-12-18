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
import { useConsoleStore } from "../store/consoleStore";
import { useAppStore, useAppDispatch } from "../store";
import { useWorkspace } from "../contexts/workspace-context";
import { ConsoleModification } from "../hooks/useMonacoConsole";
import { useSqlAutocomplete } from "../hooks/useSqlAutocomplete";

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
  // Version history UI is currently disabled; re-enable when implemented

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
    saveConsole,
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

  // Update active editor content when tab focus changes
  useEffect(() => {
    if (activeConsoleId && consoleRefs.current[activeConsoleId]?.current) {
      const content =
        consoleRefs.current[activeConsoleId].current.getCurrentContent();
      setActiveEditorContent(content);
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
  const getWorkspaceId = useCallback(
    () => currentWorkspace?.id,
    [currentWorkspace?.id],
  );

  const getConnectionId = useCallback(() => {
    const activeTab = consoleTabs.find(tab => tab.id === activeConsoleId);
    return activeTab?.connectionId;
  }, [consoleTabs, activeConsoleId]);

  const getConnectionType = useCallback(() => {
    const activeTab = consoleTabs.find(tab => tab.id === activeConsoleId);
    const connection = availableDatabases.find(
      db => db.id === activeTab?.connectionId,
    );
    return connection?.type;
  }, [consoleTabs, activeConsoleId, availableDatabases]);

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
      databaseId?: string; // Sub-database ID (e.g., D1 UUID)
      databaseName?: string; // Sub-database name for cluster mode
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

    setIsExecuting(true);
    const startTime = Date.now();
    try {
      const result = await executeQuery(
        currentWorkspace.id,
        connectionId,
        contentToExecute,
        options,
      );
      const executionTime = Date.now() - startTime;
      if (result.success) {
        setTabResults(prev => ({
          ...prev,
          [tabId]: {
            results: result.data,
            executedAt: new Date().toISOString(),
            resultCount: Array.isArray(result.data) ? result.data.length : 1,
            executionTime,
          },
        }));
      } else {
        setErrorMessage(JSON.stringify(result.error, null, 2));
        setErrorModalOpen(true);
        setTabResults(prev => ({ ...prev, [tabId]: null }));
      }
    } catch (e: any) {
      setErrorMessage(JSON.stringify(e, null, 2));
      setErrorModalOpen(true);
      setTabResults(prev => ({ ...prev, [tabId]: null }));
    } finally {
      setIsExecuting(false);
    }
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
      let savePath = currentPath;
      let isNew = false;
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
      if (result.success) {
        // Update file path and title for new files (POST)
        if (isNew && savePath) {
          updateConsoleFilePath(tabId, savePath);
        }

        // Keep the full path as the title to distinguish between files with same name
        if (savePath) {
          updateConsoleTitle(tabId, savePath);
        }

        // Mark tab as dirty since it's now saved and should be persistent
        updateConsoleDirty(tabId, true);

        // Update the saved database values to reflect what was just persisted
        // This is used for dirty state tracking in the Console component
        updateConsoleSavedDatabase(
          tabId,
          connectionId,
          databaseId,
          databaseName,
        );

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
          // The server SHOULD return the same ID we sent
          // If not, something is wrong with the backend
          useConsoleTreeStore
            .getState()
            .addConsole(currentWorkspace.id, savePath!, tabId);
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
                        onSave={(content, currentPath) =>
                          handleConsoleSave(tab.id, content, currentPath)
                        }
                        isExecuting={isExecuting}
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
