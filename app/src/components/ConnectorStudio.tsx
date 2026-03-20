import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Typography,
  Tabs,
  Tab,
  Chip,
  CircularProgress,
  Alert,
  TextField,
  Divider,
  Stack,
  List,
  ListItem,
  ListItemText,
  Switch,
  Card,
  CardContent,
} from "@mui/material";
import {
  Play as RunIcon,
  Hammer as BuildIcon,
  X as ErrorIcon,
  Clock as TimeIcon,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import Editor from "@monaco-editor/react";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import {
  useConnectorBuilderStore,
  type ConnectorInstance,
} from "../store/connectorBuilderStore";
import { useConsoleStore } from "../store/consoleStore";
import { ConnectorInstanceForm } from "./ConnectorInstanceForm";

interface ConnectorStudioProps {
  connectorId: string;
  workspaceId: string;
}

type BottomTab = "output" | "logs" | "schema";
type RightTab = "run-inputs" | "instances" | "versions" | "ai";

function safeParseJson(
  value: string,
  label: string,
): { parsed: Record<string, unknown>; error: string | null } {
  if (!value.trim()) {
    return { parsed: {}, error: null };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { parsed: {}, error: `${label} must be a JSON object` };
    }
    return { parsed: parsed as Record<string, unknown>, error: null };
  } catch (error) {
    return {
      parsed: {},
      error: `${label} is not valid JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export function ConnectorStudio({
  connectorId,
  workspaceId,
}: ConnectorStudioProps) {
  const {
    updateConnector,
    buildConnector,
    devRun,
    buildState: buildStateMap,
    devRunState: devRunStateMap,
    fetchConnectors,
    fetchInstances,
    toggleInstance,
    instances: instancesMap,
  } = useConnectorBuilderStore();

  const connector = useConnectorBuilderStore(state =>
    (state.connectors[workspaceId] || []).find(c => c._id === connectorId),
  );

  const buildState = buildStateMap[connectorId];
  const devRunState = devRunStateMap[connectorId];
  const connectorInstances: ConnectorInstance[] =
    instancesMap[connectorId] || [];

  const [bottomTab, setBottomTab] = useState<BottomTab>("output");
  const [rightTab, setRightTab] = useState<RightTab>("run-inputs");
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [configJson, setConfigJson] = useState("{}");
  const [secretsJson, setSecretsJson] = useState("{}");
  const [stateJson, setStateJson] = useState("{}");
  const [inputError, setInputError] = useState<string | null>(null);
  const [versions, setVersions] = useState<
    Array<{
      version: number;
      buildHash?: string;
      createdAt: string;
      createdBy: string;
    }>
  >([]);
  const editorRef = useRef<any>(null);
  const saveTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!connector && workspaceId) {
      fetchConnectors(workspaceId);
    }
  }, [connector, workspaceId, fetchConnectors]);

  // Load instances for this connector
  useEffect(() => {
    if (workspaceId && connectorId) {
      fetchInstances(workspaceId, connectorId);
    }
  }, [workspaceId, connectorId, fetchInstances]);

  // Load versions when Versions tab is selected
  useEffect(() => {
    if (rightTab === "versions" && workspaceId && connectorId) {
      import("../lib/api-client").then(({ apiClient }) => {
        apiClient
          .get<{
            success: boolean;
            data: {
              currentVersion: number;
              versions: Array<{
                version: number;
                buildHash?: string;
                createdAt: string;
                createdBy: string;
              }>;
            };
          }>(
            `/workspaces/${workspaceId}/connector-builder/connectors/${connectorId}/versions`,
          )
          .then(res => {
            if (res.success) {
              setVersions(res.data.versions || []);
            }
          })
          .catch(() => {});
      });
    }
  }, [rightTab, workspaceId, connectorId, connector?.version]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!value || !connector) return;

      // Debounced auto-save to backend
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = window.setTimeout(() => {
        updateConnector(workspaceId, connectorId, { code: value });
        // Also update the tab content
        useConsoleStore
          .getState()
          .updateContent(
            Object.values(useConsoleStore.getState().tabs).find(
              t =>
                t.kind === "connector-studio" &&
                t.metadata?.connectorId === connectorId,
            )?.id || "",
            value,
          );
      }, 1500);
    },
    [connector, workspaceId, connectorId, updateConnector],
  );

  const handleRun = useCallback(async () => {
    if (!connector) return;

    // Validate JSON inputs
    const config = safeParseJson(configJson, "Config");
    const secrets = safeParseJson(secretsJson, "Secrets");
    const state = safeParseJson(stateJson, "State");

    const validationError = config.error || secrets.error || state.error;
    if (validationError) {
      setInputError(validationError);
      return;
    }
    setInputError(null);

    // Save current code before running
    const currentCode = editorRef.current?.getValue();
    if (currentCode && currentCode !== connector.source.code) {
      await updateConnector(workspaceId, connectorId, { code: currentCode });
    }

    await devRun(workspaceId, connectorId, {
      config: config.parsed,
      secrets: secrets.parsed as Record<string, string>,
      state: state.parsed,
      trigger: { type: "manual" },
    });
  }, [
    connector,
    workspaceId,
    connectorId,
    updateConnector,
    devRun,
    configJson,
    secretsJson,
    stateJson,
  ]);

  const handleBuild = useCallback(async () => {
    if (!connector) return;

    const currentCode = editorRef.current?.getValue();
    if (currentCode && currentCode !== connector.source.code) {
      await updateConnector(workspaceId, connectorId, { code: currentCode });
    }

    await buildConnector(workspaceId, connectorId);
  }, [connector, workspaceId, connectorId, updateConnector, buildConnector]);

  const handleEditorMount = useCallback(
    (editor: any) => {
      editorRef.current = editor;

      editor.addCommand(
        // Cmd/Ctrl + Enter to run
        editor.KeyMod.CtrlCmd | editor.KeyCode.Enter,
        () => {
          handleRun();
        },
      );
    },
    [handleRun],
  );

  // Set Monaco markers for build errors
  useEffect(() => {
    if (!editorRef.current || !buildState?.errors) return;

    const monaco = (window as any).monaco;
    if (!monaco) return;

    const model = editorRef.current.getModel();
    if (!model) return;

    const markers = buildState.errors
      .filter(e => e.line !== undefined)
      .map(e => ({
        severity:
          e.severity === "error"
            ? monaco.MarkerSeverity.Error
            : monaco.MarkerSeverity.Warning,
        startLineNumber: e.line || 1,
        startColumn: e.column || 1,
        endLineNumber: e.line || 1,
        endColumn: (e.column || 1) + 100,
        message: e.message,
        source: "connector-builder-build",
      }));

    monaco.editor.setModelMarkers(model, "connector-builder-build", markers);
  }, [buildState?.errors]);

  // Set Monaco markers for runtime errors (source-mapped)
  useEffect(() => {
    if (!editorRef.current) return;

    const monaco = (window as any).monaco;
    if (!monaco) return;

    const model = editorRef.current.getModel();
    if (!model) return;

    const runtimeError = devRunState?.runtimeError;
    if (runtimeError?.originalLine) {
      monaco.editor.setModelMarkers(model, "connector-builder-runtime", [
        {
          severity: monaco.MarkerSeverity.Error,
          startLineNumber: runtimeError.originalLine,
          startColumn: runtimeError.originalColumn || 1,
          endLineNumber: runtimeError.originalLine,
          endColumn: (runtimeError.originalColumn || 1) + 100,
          message: `Runtime error: ${runtimeError.message}`,
          source: "connector-builder-runtime",
        },
      ]);
    } else {
      monaco.editor.setModelMarkers(model, "connector-builder-runtime", []);
    }
  }, [devRunState?.runtimeError]);

  if (!connector) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
        }}
      >
        <CircularProgress size={24} />
      </Box>
    );
  }

  // Derive output grid data
  const batches = devRunState?.output?.batches || [];
  const entityNames = batches.map(b => b.entity);
  const currentEntity = selectedEntity || entityNames[0] || null;
  const currentBatch = batches.find(b => b.entity === currentEntity);
  const gridRows = currentBatch?.records || [];
  const gridColumns: GridColDef[] = currentBatch
    ? Object.keys(gridRows[0] || {}).map(key => ({
        field: key,
        headerName: key,
        flex: 1,
        minWidth: 120,
        renderCell: params => {
          const val = params.value;
          if (val === null || val === undefined) return "";
          if (typeof val === "object") return JSON.stringify(val);
          return String(val);
        },
      }))
    : [];

  const outputLogs = devRunState?.output?.logs || [];
  const schemaEntries = batches
    .filter(b => !!b.schema)
    .map(b => b.schema as NonNullable<typeof b.schema>);

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Action Bar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 0.75,
          borderBottom: "1px solid",
          borderColor: "divider",
          minHeight: 40,
        }}
      >
        <Button
          size="small"
          variant="contained"
          startIcon={
            devRunState?.running ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <RunIcon size={14} />
            )
          }
          onClick={handleRun}
          disabled={devRunState?.running || buildState?.building}
          sx={{ textTransform: "none", fontSize: "0.8rem" }}
        >
          {devRunState?.running ? "Running..." : "Run"}
        </Button>

        <Button
          size="small"
          variant="outlined"
          startIcon={
            buildState?.building ? (
              <CircularProgress size={14} />
            ) : (
              <BuildIcon size={14} />
            )
          }
          onClick={handleBuild}
          disabled={buildState?.building || devRunState?.running}
          sx={{ textTransform: "none", fontSize: "0.8rem" }}
        >
          {buildState?.building ? "Building..." : "Build"}
        </Button>

        <Box sx={{ flex: 1 }} />

        {/* Status indicators */}
        {devRunState?.durationMs !== undefined && !devRunState.running && (
          <Chip
            icon={<TimeIcon size={12} />}
            label={`${devRunState.durationMs}ms`}
            size="small"
            variant="outlined"
            sx={{ fontSize: "0.7rem" }}
          />
        )}

        {devRunState?.rowCount !== undefined && !devRunState.running && (
          <Chip
            label={`${devRunState.rowCount} rows`}
            size="small"
            color={devRunState.rowCount > 0 ? "success" : "default"}
            variant="outlined"
            sx={{ fontSize: "0.7rem" }}
          />
        )}

        {devRunState?.error && !devRunState.running && (
          <Chip
            icon={<ErrorIcon size={12} />}
            label="Error"
            size="small"
            color="error"
            variant="outlined"
            sx={{ fontSize: "0.7rem" }}
          />
        )}

        {buildState?.errors &&
          buildState.errors.length > 0 &&
          !buildState.building && (
            <Chip
              label={`${buildState.errors.filter(e => e.severity === "error").length} errors`}
              size="small"
              color="error"
              variant="outlined"
              sx={{ fontSize: "0.7rem" }}
            />
          )}

        {devRunState?.runtime && !devRunState.running && (
          <Chip
            label={devRunState.runtime}
            size="small"
            variant="outlined"
            sx={{ fontSize: "0.65rem" }}
          />
        )}

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontStyle: "italic" }}
        >
          v{connector.version}
        </Typography>
      </Box>

      {/* Main Layout */}
      <PanelGroup direction="horizontal" style={{ flex: 1 }}>
        {/* Left: Editor + Output */}
        <Panel defaultSize={65} minSize={30}>
          <PanelGroup direction="vertical">
            {/* Code Editor */}
            <Panel defaultSize={60} minSize={20}>
              <Editor
                height="100%"
                language="typescript"
                theme="vs-dark"
                value={connector.source.code}
                onChange={handleEditorChange}
                onMount={handleEditorMount}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                  wordWrap: "on",
                  folding: true,
                  suggestOnTriggerCharacters: true,
                }}
              />
            </Panel>

            {/* Resize Handle */}
            <PanelResizeHandle
              style={{
                height: 4,
                cursor: "row-resize",
                transition: "background-color 0.2s ease",
              }}
            />

            {/* Bottom Panel: Output/Logs/Schema */}
            <Panel defaultSize={40} minSize={15}>
              <Box
                sx={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                {/* Tab Headers */}
                <Box
                  sx={{
                    borderBottom: "1px solid",
                    borderColor: "divider",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <Tabs
                    value={bottomTab}
                    onChange={(_, v) => setBottomTab(v)}
                    sx={{
                      minHeight: 32,
                      "& .MuiTab-root": {
                        minHeight: 32,
                        py: 0,
                        fontSize: "0.75rem",
                        textTransform: "none",
                      },
                    }}
                  >
                    <Tab
                      label={`Output${devRunState?.rowCount ? ` (${devRunState.rowCount})` : ""}`}
                      value="output"
                    />
                    <Tab
                      label={`Logs${outputLogs.length ? ` (${outputLogs.length})` : ""}`}
                      value="logs"
                    />
                    <Tab label="Schema" value="schema" />
                  </Tabs>

                  {/* Entity selector for multi-entity output */}
                  {entityNames.length > 1 && bottomTab === "output" && (
                    <Box sx={{ ml: 1, display: "flex", gap: 0.5 }}>
                      {entityNames.map(name => (
                        <Chip
                          key={name}
                          label={name}
                          size="small"
                          variant={
                            currentEntity === name ? "filled" : "outlined"
                          }
                          onClick={() => setSelectedEntity(name)}
                          sx={{ fontSize: "0.7rem" }}
                        />
                      ))}
                    </Box>
                  )}
                </Box>

                {/* Tab Content */}
                <Box sx={{ flex: 1, overflow: "auto" }}>
                  {bottomTab === "output" && (
                    <OutputPanel
                      rows={gridRows}
                      columns={gridColumns}
                      error={devRunState?.error}
                      running={devRunState?.running || false}
                    />
                  )}
                  {bottomTab === "logs" && (
                    <LogsPanel
                      logs={outputLogs}
                      stderrLogs={devRunState?.logs}
                      buildLog={buildState?.buildLog}
                    />
                  )}
                  {bottomTab === "schema" && (
                    <SchemaPanel schemas={schemaEntries} />
                  )}
                </Box>
              </Box>
            </Panel>
          </PanelGroup>
        </Panel>

        {/* Resize Handle */}
        <PanelResizeHandle
          style={{
            width: 4,
            cursor: "col-resize",
            transition: "background-color 0.2s ease",
          }}
        />

        {/* Right: Config + AI panel */}
        <Panel defaultSize={35} minSize={15}>
          <Box
            sx={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <Tabs
              value={rightTab}
              onChange={(_, v) => setRightTab(v)}
              sx={{
                minHeight: 32,
                borderBottom: "1px solid",
                borderColor: "divider",
                "& .MuiTab-root": {
                  minHeight: 32,
                  py: 0,
                  fontSize: "0.75rem",
                  textTransform: "none",
                },
              }}
            >
              <Tab label="Run Inputs" value="run-inputs" />
              <Tab label="Instances" value="instances" />
              <Tab label="Versions" value="versions" />
              <Tab label="AI" value="ai" />
            </Tabs>

            <Box sx={{ flex: 1, overflow: "auto" }}>
              {rightTab === "run-inputs" ? (
                <Box sx={{ p: 2 }}>
                  <Stack spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                      Configure config, secrets, and state for dev runs.
                    </Typography>

                    {inputError && (
                      <Alert
                        severity="error"
                        onClose={() => setInputError(null)}
                        sx={{ fontSize: "0.75rem" }}
                      >
                        {inputError}
                      </Alert>
                    )}

                    <TextField
                      label="Config JSON"
                      value={configJson}
                      onChange={e => setConfigJson(e.target.value)}
                      multiline
                      minRows={4}
                      fullWidth
                      size="small"
                      slotProps={{
                        input: {
                          sx: { fontFamily: "monospace", fontSize: "0.8rem" },
                        },
                      }}
                    />
                    <TextField
                      label="Secrets JSON"
                      value={secretsJson}
                      onChange={e => setSecretsJson(e.target.value)}
                      multiline
                      minRows={4}
                      fullWidth
                      size="small"
                      slotProps={{
                        input: {
                          sx: { fontFamily: "monospace", fontSize: "0.8rem" },
                        },
                      }}
                    />
                    <TextField
                      label="State JSON"
                      value={stateJson}
                      onChange={e => setStateJson(e.target.value)}
                      multiline
                      minRows={4}
                      fullWidth
                      size="small"
                      slotProps={{
                        input: {
                          sx: { fontFamily: "monospace", fontSize: "0.8rem" },
                        },
                      }}
                    />

                    <Divider />

                    <Box>
                      <Typography
                        variant="subtitle2"
                        gutterBottom
                        color="text.secondary"
                      >
                        Build Metadata
                      </Typography>
                      <Typography variant="caption" display="block">
                        Build hash:{" "}
                        {connector?.bundle?.buildHash || "Not built yet"}
                      </Typography>
                      <Typography variant="caption" display="block">
                        Version: {connector?.version || 1}
                      </Typography>
                    </Box>
                  </Stack>
                </Box>
              ) : rightTab === "instances" ? (
                <Box
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    height: "100%",
                  }}
                >
                  {/* Instance list */}
                  {connectorInstances.length > 0 && (
                    <Box
                      sx={{
                        borderBottom: "1px solid",
                        borderColor: "divider",
                        maxHeight: 200,
                        overflow: "auto",
                      }}
                    >
                      <List dense disablePadding>
                        {connectorInstances.map(inst => (
                          <ListItem
                            key={inst._id}
                            secondaryAction={
                              <Switch
                                size="small"
                                checked={inst.status.enabled}
                                onChange={() =>
                                  toggleInstance(workspaceId, inst._id)
                                    .then(() =>
                                      fetchInstances(workspaceId, connectorId),
                                    )
                                    .catch(() => {})
                                }
                              />
                            }
                          >
                            <ListItemText
                              primary={inst.name}
                              secondary={
                                <Box
                                  sx={{
                                    display: "flex",
                                    gap: 0.5,
                                    mt: 0.25,
                                  }}
                                >
                                  <Chip
                                    label={
                                      inst.status.enabled
                                        ? "enabled"
                                        : "disabled"
                                    }
                                    size="small"
                                    color={
                                      inst.status.enabled
                                        ? "success"
                                        : "default"
                                    }
                                    sx={{ height: 18, fontSize: "0.6rem" }}
                                  />
                                  {inst.triggers
                                    .map(t => t.type)
                                    .map(t => (
                                      <Chip
                                        key={t}
                                        label={t}
                                        size="small"
                                        variant="outlined"
                                        sx={{
                                          height: 18,
                                          fontSize: "0.6rem",
                                        }}
                                      />
                                    ))}
                                </Box>
                              }
                              primaryTypographyProps={{
                                variant: "body2",
                                noWrap: true,
                              }}
                            />
                          </ListItem>
                        ))}
                      </List>
                    </Box>
                  )}
                  {/* Instance form */}
                  <Box sx={{ flex: 1, overflow: "auto" }}>
                    <ConnectorInstanceForm connectorId={connectorId} />
                  </Box>
                </Box>
              ) : rightTab === "versions" ? (
                <Box sx={{ p: 1.5, overflow: "auto", height: "100%" }}>
                  {versions.length === 0 ? (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ textAlign: "center", mt: 4 }}
                    >
                      No versions yet. Build the connector to create a version.
                    </Typography>
                  ) : (
                    <Stack spacing={1}>
                      {[...versions].reverse().map(v => (
                        <Card
                          key={v.version}
                          variant="outlined"
                          sx={{
                            bgcolor:
                              v.version === connector?.version
                                ? "action.selected"
                                : undefined,
                          }}
                        >
                          <CardContent
                            sx={{ py: 1, "&:last-child": { pb: 1 } }}
                          >
                            <Box
                              sx={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                              }}
                            >
                              <Typography variant="subtitle2">
                                v{v.version}
                                {v.version === connector?.version && (
                                  <Chip
                                    label="current"
                                    size="small"
                                    color="primary"
                                    sx={{
                                      ml: 1,
                                      height: 16,
                                      fontSize: "0.6rem",
                                    }}
                                  />
                                )}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                {new Date(v.createdAt).toLocaleDateString()}
                              </Typography>
                            </Box>
                            {v.buildHash && (
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ fontFamily: "monospace" }}
                              >
                                {v.buildHash.slice(0, 12)}
                              </Typography>
                            )}
                          </CardContent>
                        </Card>
                      ))}
                    </Stack>
                  )}
                </Box>
              ) : (
                <Box
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    p: 3,
                    textAlign: "center",
                  }}
                >
                  <Typography variant="h6" color="text.secondary" gutterBottom>
                    AI Assistant
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    AI-powered connector development coming in a future update.
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Panel>
      </PanelGroup>
    </Box>
  );
}

// ── Sub-components ──

function OutputPanel({
  rows,
  columns,
  error,
  running,
}: {
  rows: Record<string, unknown>[];
  columns: GridColDef[];
  error?: string;
  running: boolean;
}) {
  if (running) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 1,
        }}
      >
        <CircularProgress size={20} />
        <Typography variant="body2" color="text.secondary">
          Executing connector...
        </Typography>
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 1 }}>
        <Alert severity="error" sx={{ fontSize: "0.8rem" }}>
          {error}
        </Alert>
      </Box>
    );
  }

  if (rows.length === 0) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
        }}
      >
        <Typography variant="body2" color="text.secondary">
          No output yet. Click &quot;Run&quot; to execute the connector.
        </Typography>
      </Box>
    );
  }

  return (
    <DataGrid
      rows={rows.map((r, i) => ({ ...r, __rowId: i }))}
      columns={columns}
      getRowId={row => row.__rowId}
      density="compact"
      disableRowSelectionOnClick
      hideFooterSelectedRowCount
      sx={{
        border: "none",
        fontSize: "0.8rem",
        "& .MuiDataGrid-cell": { py: 0.25 },
        "& .MuiDataGrid-columnHeader": { fontSize: "0.75rem" },
      }}
    />
  );
}

function LogsPanel({
  logs,
  stderrLogs,
  buildLog,
}: {
  logs: Array<{
    level: string;
    message: string;
    timestamp?: string;
    data?: unknown;
  }>;
  stderrLogs?: string;
  buildLog?: string;
}) {
  const allLogs = [
    ...(buildLog
      ? [
          {
            level: "info" as const,
            message: `[Build Log]\n${buildLog}`,
            timestamp: undefined as string | undefined,
          },
        ]
      : []),
    ...logs,
  ];

  if (allLogs.length === 0 && !stderrLogs) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
        }}
      >
        <Typography variant="body2" color="text.secondary">
          No logs yet.
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        p: 1,
        fontFamily: "monospace",
        fontSize: "0.75rem",
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {allLogs.map((log, i) => (
        <Box
          key={i}
          sx={{
            display: "flex",
            gap: 1,
            py: 0.25,
            color:
              log.level === "error"
                ? "error.main"
                : log.level === "warn"
                  ? "warning.main"
                  : log.level === "debug"
                    ? "text.disabled"
                    : "text.primary",
          }}
        >
          {log.timestamp && (
            <Typography
              variant="caption"
              sx={{
                fontFamily: "monospace",
                color: "text.disabled",
                flexShrink: 0,
              }}
            >
              {new Date(log.timestamp).toLocaleTimeString()}
            </Typography>
          )}
          <Chip
            label={log.level.toUpperCase()}
            size="small"
            sx={{
              height: 18,
              fontSize: "0.6rem",
              fontFamily: "monospace",
              flexShrink: 0,
            }}
          />
          <span>{log.message}</span>
        </Box>
      ))}
      {stderrLogs && (
        <Box sx={{ mt: 1, color: "text.secondary" }}>
          <Typography
            variant="caption"
            sx={{ fontFamily: "monospace", fontWeight: 600 }}
          >
            stderr:
          </Typography>
          <pre style={{ margin: 0 }}>{stderrLogs}</pre>
        </Box>
      )}
    </Box>
  );
}

function SchemaPanel({
  schemas,
}: {
  schemas: Array<{
    name: string;
    columns: Array<{
      name: string;
      type: string;
      nullable?: boolean;
      primaryKey?: boolean;
    }>;
  }>;
}) {
  if (schemas.length === 0) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
        }}
      >
        <Typography variant="body2" color="text.secondary">
          Run the connector to see schema information.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 1.5 }}>
      {schemas.map(schema => (
        <Box key={schema.name} sx={{ mb: 2 }}>
          <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 0.5 }}>
            {schema.name}
          </Typography>
          <Box
            component="table"
            sx={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.75rem",
              fontFamily: "monospace",
              "& td, & th": {
                px: 1,
                py: 0.5,
                borderBottom: "1px solid",
                borderColor: "divider",
                textAlign: "left",
              },
              "& th": {
                fontWeight: 600,
                color: "text.secondary",
              },
            }}
          >
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>PK</th>
              </tr>
            </thead>
            <tbody>
              {schema.columns.map(col => (
                <tr key={col.name}>
                  <td>{col.name}</td>
                  <td>{col.type}</td>
                  <td>{col.nullable !== false ? "yes" : "no"}</td>
                  <td>{col.primaryKey ? "yes" : ""}</td>
                </tr>
              ))}
            </tbody>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
