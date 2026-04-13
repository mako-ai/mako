import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Save as SaveIcon,
  Hammer as BuildIcon,
  Info as InfoIcon,
  Square as StopIcon,
  Trash2 as ClearIcon,
} from "lucide-react";
import { PlayArrow as PlayIcon } from "@mui/icons-material";
import { DataGridPremium, type GridColDef } from "@mui/x-data-grid-premium";
import MonacoEditor from "@monaco-editor/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConnectorBuilderStore,
  type ConnectorOutput,
} from "../store/connectorBuilderStore";
import { useConsoleStore } from "../store/consoleStore";
import { useUIStore } from "../store/uiStore";
import ConnectorInstanceForm from "./ConnectorInstanceForm";

type BottomView = "output" | "logs" | "schema";
type RightView = "inputs" | "instances" | "versions" | "ai";

interface ConnectorStudioProps {
  tabId: string;
  connectorId?: string;
}

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
      return {
        parsed: {},
        error: `${label} must be a JSON object`,
      };
    }

    return {
      parsed: parsed as Record<string, unknown>,
      error: null,
    };
  } catch (error) {
    return {
      parsed: {},
      error: `${label} is not valid JSON: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    };
  }
}

function flattenOutputRows(output?: ConnectorOutput) {
  const rows =
    output?.batches.flatMap((batch, batchIndex) =>
      batch.rows.map((row, rowIndex) => ({
        id: `${batch.entity}-${batchIndex}-${rowIndex}`,
        __entity: batch.entity,
        ...row,
      })),
    ) ?? [];

  const keys = new Set<string>();
  rows.forEach(row => {
    Object.keys(row).forEach(key => keys.add(key));
  });

  const columns: GridColDef[] = Array.from(keys).map(key => ({
    field: key,
    headerName: key,
    flex: key === "__entity" ? 0.6 : 1,
    minWidth: key === "__entity" ? 120 : 160,
  }));

  return { rows, columns };
}

const ConnectorLogsPanel = memo(function ConnectorLogsPanel({
  connectorId,
}: {
  connectorId: string;
}) {
  const logs = useConnectorBuilderStore(state => state.logHistory[connectorId]);
  const clearLogHistory = useConnectorBuilderStore(
    state => state.clearLogHistory,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "flex-end",
          px: 1,
          py: 0.5,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Tooltip title="Clear logs">
          <span>
            <IconButton
              size="small"
              onClick={() => clearLogHistory(connectorId)}
              disabled={!logs || logs.length === 0}
            >
              <ClearIcon size={14} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Box
        ref={scrollRef}
        sx={{
          flexGrow: 1,
          minHeight: 0,
          overflow: "auto",
          p: 2,
          fontSize: 12,
          fontFamily: "monospace",
          whiteSpace: "pre-wrap",
        }}
      >
        {!logs || logs.length === 0
          ? "No logs yet."
          : logs.map((entry, i) => (
              <Box
                component="span"
                key={i}
                sx={
                  entry.level === "error"
                    ? { color: "error.main" }
                    : entry.level === "warn"
                      ? { color: "warning.main" }
                      : undefined
                }
              >
                {`${entry.timestamp} [${entry.level}] ${entry.message}\n`}
              </Box>
            ))}
      </Box>
    </Box>
  );
});

function ConnectorStudio({ tabId, connectorId }: ConnectorStudioProps) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const {
    connectors,
    instances,
    executionHistory,
    buildState,
    devRunState,
    fetchConnectors,
    fetchInstances,
    fetchInstanceHistory,
    updateConnector,
    buildConnector,
    rollbackConnector,
    devRun,
    selectConnector,
    toggleInstance,
    runInstance,
    cancelInstanceRun,
  } = useConnectorBuilderStore();
  const pushLog = useConnectorBuilderStore(state => state.pushLog);
  const { updateContent, updateTitle, updateDirty } = useConsoleStore();
  const openRightPane = useUIStore(state => state.openRightPane);
  const [bottomView, setBottomView] = useState<BottomView>("output");
  const [rightView, setRightView] = useState<RightView>("inputs");
  const [code, setCode] = useState("");
  const [name, setName] = useState("Untitled Connector");
  const [description, setDescription] = useState("");
  const [configJson, setConfigJson] = useState("{}");
  const [secretsJson, setSecretsJson] = useState("{}");
  const [stateJson, setStateJson] = useState("{}");
  const [isDirty, setIsDirty] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(
    null,
  );
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  const connector = useMemo(
    () =>
      workspaceId
        ? (connectors[workspaceId] || []).find(item => item._id === connectorId)
        : undefined,
    [connectorId, connectors, workspaceId],
  );

  const currentBuildState = connectorId ? buildState[connectorId] : undefined;
  const currentRunState = connectorId ? devRunState[connectorId] : undefined;
  const connectorInstances = useMemo(
    () =>
      workspaceId && connectorId
        ? instances[`${workspaceId}:${connectorId}`] || []
        : [],
    [connectorId, instances, workspaceId],
  );
  const selectedInstance = useMemo(
    () =>
      connectorInstances.find(
        instance => instance._id === selectedInstanceId,
      ) || null,
    [connectorInstances, selectedInstanceId],
  );
  const selectedInstanceHistory = useMemo(
    () =>
      selectedInstanceId && workspaceId
        ? executionHistory[`${workspaceId}:${selectedInstanceId}:history`] || []
        : [],
    [executionHistory, selectedInstanceId, workspaceId],
  );
  const { rows, columns } = useMemo(
    () => flattenOutputRows(currentRunState?.output),
    [currentRunState?.output],
  );

  useEffect(() => {
    if (!workspaceId) {
      return;
    }

    if (!connector && connectorId) {
      void fetchConnectors(workspaceId).catch(() => undefined);
    }
  }, [connector, connectorId, fetchConnectors, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !connectorId) {
      return;
    }

    void fetchInstances(workspaceId, connectorId).catch(() => undefined);
  }, [connectorId, fetchInstances, workspaceId]);

  useEffect(() => {
    if (connectorInstances.length === 0) {
      setSelectedInstanceId(null);
      return;
    }

    if (
      selectedInstanceId &&
      connectorInstances.some(instance => instance._id === selectedInstanceId)
    ) {
      return;
    }

    setSelectedInstanceId(connectorInstances[0]._id);
  }, [connectorInstances, selectedInstanceId]);

  useEffect(() => {
    if (!workspaceId || !selectedInstanceId) {
      return;
    }

    void fetchInstanceHistory(workspaceId, selectedInstanceId).catch(
      () => undefined,
    );
  }, [fetchInstanceHistory, selectedInstanceId, workspaceId]);

  useEffect(() => {
    if (!connector) {
      return;
    }

    selectConnector(connector._id);
    setCode(connector.source.code);
    setName(connector.name);
    setDescription(connector.description || "");
    setIsDirty(false);
    updateContent(tabId, connector.source.code);
    updateTitle(tabId, connector.name);
    updateDirty(tabId, false);
  }, [
    connector,
    selectConnector,
    tabId,
    updateContent,
    updateDirty,
    updateTitle,
  ]);

  const persistConnector = async () => {
    if (!workspaceId || !connectorId) {
      throw new Error("No connector selected");
    }

    const updated = await updateConnector(workspaceId, connectorId, {
      name,
      description,
      code,
    });

    updateTitle(tabId, updated.name);
    updateContent(tabId, updated.source.code);
    updateDirty(tabId, false);
    setIsDirty(false);
    return updated;
  };

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) {
      return;
    }

    const model = editorRef.current.getModel?.();
    if (!model) {
      return;
    }

    const markers = [
      ...(currentBuildState?.errors || [])
        .filter(error => error.line !== undefined)
        .map(error => ({
          severity:
            error.severity === "warning"
              ? monacoRef.current.MarkerSeverity.Warning
              : monacoRef.current.MarkerSeverity.Error,
          startLineNumber: error.line || 1,
          startColumn: error.column || 1,
          endLineNumber: error.line || 1,
          endColumn: (error.column || 1) + 1,
          message: error.message,
          source: "connector-builder-build",
        })),
      ...(currentRunState?.runtimeError?.originalLine
        ? [
            {
              severity: monacoRef.current.MarkerSeverity.Error,
              startLineNumber: currentRunState.runtimeError.originalLine,
              startColumn: currentRunState.runtimeError.originalColumn || 1,
              endLineNumber: currentRunState.runtimeError.originalLine,
              endColumn: (currentRunState.runtimeError.originalColumn || 1) + 1,
              message: currentRunState.runtimeError.message,
              source: "connector-builder-runtime",
            },
          ]
        : []),
    ];

    monacoRef.current.editor.setModelMarkers(
      model,
      "connector-builder",
      markers,
    );
  }, [currentBuildState?.errors, currentRunState?.runtimeError]);

  const handleBuild = async () => {
    if (!workspaceId || !connectorId) {
      return;
    }

    try {
      if (isDirty) {
        await persistConnector();
      }
      await buildConnector(workspaceId, connectorId);
      setBottomView("logs");
    } catch (error) {
      pushLog(
        connectorId,
        "error",
        error instanceof Error ? error.message : "Build failed",
      );
      setBottomView("logs");
    }
  };

  const handleRun = async () => {
    if (!workspaceId || !connectorId) {
      return;
    }

    const config = safeParseJson(configJson, "Config");
    const secrets = safeParseJson(secretsJson, "Secrets");
    const state = safeParseJson(stateJson, "State");
    const firstError = config.error || secrets.error || state.error;

    if (firstError) {
      pushLog(connectorId, "error", firstError);
      setBottomView("logs");
      return;
    }

    try {
      if (isDirty) {
        await persistConnector();
      }

      await devRun(workspaceId, connectorId, {
        config: config.parsed,
        secrets: secrets.parsed,
        state: state.parsed,
        trigger: { type: "manual" },
      });
      setBottomView("output");
    } catch {
      setBottomView("logs");
    }
  };

  if (!workspaceId) {
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
        <Typography>Select a workspace to use connector builder.</Typography>
      </Box>
    );
  }

  if (!connectorId) {
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
        <Typography>Select a connector to start editing.</Typography>
      </Box>
    );
  }

  if (!connector) {
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
        <Typography>Loading connector...</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          backgroundColor: "background.paper",
          p: 0.5,
          gap: 0.5,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {currentRunState?.running ? (
            <Tooltip title="Cancel">
              <IconButton
                size="small"
                color="error"
                onClick={() => {
                  /* run state will clear on completion */
                }}
              >
                <StopIcon size={18} />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title="Run (⌘/Ctrl+Enter)">
              <span>
                <IconButton
                  size="small"
                  color="primary"
                  onClick={() => void handleRun()}
                  disabled={currentRunState?.running}
                >
                  <PlayIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}

          <Tooltip title={isDirty ? "Save (⌘/Ctrl+S)" : "No changes to save"}>
            <span>
              <IconButton
                size="small"
                onClick={() => {
                  void persistConnector().catch(error => {
                    pushLog(
                      connectorId,
                      "error",
                      error instanceof Error ? error.message : "Save failed",
                    );
                  });
                }}
                disabled={!isDirty}
              >
                <SaveIcon strokeWidth={2} size={22} />
              </IconButton>
            </span>
          </Tooltip>

          <Tooltip
            title={
              currentBuildState?.building ? "Building..." : "Build connector"
            }
          >
            <span>
              <IconButton
                size="small"
                onClick={() => void handleBuild()}
                disabled={currentBuildState?.building}
              >
                <BuildIcon strokeWidth={2} size={22} />
              </IconButton>
            </span>
          </Tooltip>

          <Divider orientation="vertical" flexItem />

          <Tooltip title={description || "No description"}>
            <IconButton size="small">
              <InfoIcon strokeWidth={2} size={22} />
            </IconButton>
          </Tooltip>

          <Divider orientation="vertical" flexItem />

          <Chip
            size="small"
            label={isDirty ? "Unsaved changes" : "Saved"}
            color={isDirty ? "warning" : "default"}
          />
          <Chip
            size="small"
            label={
              connector.bundle.buildHash ? "Bundle ready" : "No bundle yet"
            }
            color={connector.bundle.buildHash ? "success" : "default"}
          />
          {currentRunState?.duration ? (
            <Chip
              size="small"
              label={`Last run ${currentRunState.duration} ms`}
              variant="outlined"
            />
          ) : null}
          {currentRunState?.output?.metrics?.rowCount !== undefined ? (
            <Chip
              size="small"
              label={`${currentRunState.output.metrics.rowCount} rows`}
              variant="outlined"
            />
          ) : null}
          {currentRunState?.runtime ? (
            <Chip
              size="small"
              label={`Runtime: ${currentRunState.runtime}`}
              variant="outlined"
            />
          ) : null}
        </Box>
      </Box>

      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        <PanelGroup
          direction="horizontal"
          style={{ height: "100%", width: "100%" }}
        >
          <Panel defaultSize={60} minSize={35}>
            <PanelGroup
              direction="vertical"
              style={{ height: "100%", width: "100%" }}
            >
              <Panel defaultSize={60} minSize={25}>
                <MonacoEditor
                  height="100%"
                  defaultLanguage="typescript"
                  language="typescript"
                  value={code}
                  onMount={(editor, monaco) => {
                    editorRef.current = editor;
                    monacoRef.current = monaco;
                  }}
                  onChange={value => {
                    const nextCode = value ?? "";
                    setCode(nextCode);
                    updateContent(tabId, nextCode);
                    updateDirty(tabId, true);
                    setIsDirty(true);
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    wordWrap: "on",
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                  }}
                />
              </Panel>

              <PanelResizeHandle
                style={{ height: 4, background: "var(--mui-palette-divider)" }}
              />

              <Panel defaultSize={40} minSize={20}>
                <Box
                  sx={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <Tabs
                    value={bottomView}
                    onChange={(_, value: BottomView) => setBottomView(value)}
                    sx={{
                      px: 1,
                      borderBottom: 1,
                      borderColor: "divider",
                      flexShrink: 0,
                    }}
                  >
                    <Tab value="output" label="Output" />
                    <Tab value="logs" label="Logs" />
                    <Tab value="schema" label="Schema" />
                  </Tabs>

                  <Box sx={{ flexGrow: 1, minHeight: 0 }}>
                    {bottomView === "output" ? (
                      <DataGridPremium
                        rows={rows}
                        columns={columns}
                        disableRowSelectionOnClick
                        hideFooterSelectedRowCount
                        sx={{ border: 0 }}
                      />
                    ) : bottomView === "logs" ? (
                      <ConnectorLogsPanel connectorId={connectorId} />
                    ) : (
                      <Box
                        component="pre"
                        sx={{
                          m: 0,
                          p: 2,
                          height: "100%",
                          overflow: "auto",
                          fontSize: 12,
                          fontFamily: "monospace",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {JSON.stringify(
                          {
                            schemas: currentRunState?.output?.schemas || [],
                            batches: currentRunState?.output?.batches.map(
                              batch => ({
                                entity: batch.entity,
                                rowCount: batch.rows.length,
                                schema: batch.schema,
                              }),
                            ),
                            state: currentRunState?.output?.state || {},
                          },
                          null,
                          2,
                        )}
                      </Box>
                    )}
                  </Box>
                </Box>
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle
            style={{ width: 4, background: "var(--mui-palette-divider)" }}
          />

          <Panel defaultSize={40} minSize={25}>
            <Box sx={{ height: "100%", overflow: "auto", p: 2 }}>
              <Tabs
                value={rightView}
                onChange={(_, value: RightView) => setRightView(value)}
                sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}
              >
                <Tab value="inputs" label="Run Inputs" />
                <Tab value="instances" label="Instances" />
                <Tab value="versions" label="Versions" />
                <Tab value="ai" label="AI" />
              </Tabs>

              {rightView === "inputs" ? (
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="h6">Run Inputs</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Configure config, secrets, and state for dev runs.
                    </Typography>
                  </Box>

                  <Divider />

                  <TextField
                    label="Config JSON"
                    value={configJson}
                    onChange={event => setConfigJson(event.target.value)}
                    multiline
                    minRows={6}
                    fullWidth
                    InputProps={{ sx: { fontFamily: "monospace" } }}
                  />
                  <TextField
                    label="Secrets JSON"
                    value={secretsJson}
                    onChange={event => setSecretsJson(event.target.value)}
                    multiline
                    minRows={6}
                    fullWidth
                    InputProps={{ sx: { fontFamily: "monospace" } }}
                  />
                  <TextField
                    label="State JSON"
                    value={stateJson}
                    onChange={event => setStateJson(event.target.value)}
                    multiline
                    minRows={6}
                    fullWidth
                    InputProps={{ sx: { fontFamily: "monospace" } }}
                  />

                  <Divider />

                  <Box>
                    <Typography variant="subtitle2" gutterBottom>
                      Build metadata
                    </Typography>
                    <Stack spacing={1}>
                      <Typography variant="body2" color="text.secondary">
                        Build hash:{" "}
                        {connector.bundle.buildHash || "Not built yet"}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        Entrypoint: {connector.metadata.entrypoint}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        Dependencies:{" "}
                        {connector.source.resolvedDependencies.length > 0
                          ? connector.source.resolvedDependencies.join(", ")
                          : "None"}
                      </Typography>
                    </Stack>
                  </Box>
                </Stack>
              ) : rightView === "instances" ? (
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="h6">Instances</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Save reusable deployment config for this connector.
                    </Typography>
                  </Box>

                  <Button
                    variant="outlined"
                    onClick={() => setSelectedInstanceId(null)}
                  >
                    New instance
                  </Button>

                  {connectorInstances.length > 0 ? (
                    <Stack spacing={1}>
                      {connectorInstances.map(instance => (
                        <Stack
                          key={instance._id}
                          direction="row"
                          spacing={1}
                          alignItems="center"
                        >
                          <Button
                            variant={
                              selectedInstanceId === instance._id
                                ? "contained"
                                : "outlined"
                            }
                            onClick={() => setSelectedInstanceId(instance._id)}
                            sx={{ justifyContent: "flex-start", flex: 1 }}
                          >
                            {instance.name}
                          </Button>
                          <Chip size="small" label={instance.status} />
                          <Button
                            size="small"
                            onClick={() =>
                              void runInstance(workspaceId, instance._id)
                            }
                          >
                            Run
                          </Button>
                          <Button
                            size="small"
                            onClick={() =>
                              void cancelInstanceRun(workspaceId, instance._id)
                            }
                          >
                            Cancel
                          </Button>
                          <Button
                            size="small"
                            onClick={() =>
                              void toggleInstance(
                                workspaceId,
                                instance._id,
                                connectorId,
                              )
                            }
                          >
                            {instance.status === "disabled"
                              ? "Enable"
                              : "Disable"}
                          </Button>
                        </Stack>
                      ))}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      No instances created yet.
                    </Typography>
                  )}

                  <Divider />

                  <ConnectorInstanceForm
                    workspaceId={workspaceId}
                    connectorId={connectorId}
                    instance={selectedInstance}
                    onSaved={savedInstance => {
                      setSelectedInstanceId(savedInstance._id);
                    }}
                    onDeleted={() => {
                      setSelectedInstanceId(null);
                    }}
                  />

                  {selectedInstance ? (
                    <>
                      <Divider />
                      <Box>
                        <Typography variant="subtitle2" gutterBottom>
                          Recent runs
                        </Typography>
                        {selectedInstanceHistory.length === 0 ? (
                          <Typography variant="body2" color="text.secondary">
                            No executions recorded yet.
                          </Typography>
                        ) : (
                          <Stack spacing={1}>
                            {selectedInstanceHistory
                              .slice(0, 5)
                              .map(execution => (
                                <Box
                                  key={execution._id}
                                  sx={{
                                    border: 1,
                                    borderColor: "divider",
                                    borderRadius: 1,
                                    p: 1,
                                  }}
                                >
                                  <Stack spacing={0.5}>
                                    <Stack
                                      direction="row"
                                      justifyContent="space-between"
                                      alignItems="center"
                                    >
                                      <Typography variant="caption">
                                        {execution.triggerType}
                                      </Typography>
                                      <Chip
                                        size="small"
                                        label={execution.status}
                                      />
                                    </Stack>
                                    <Typography
                                      variant="caption"
                                      color="text.secondary"
                                    >
                                      {new Date(
                                        execution.startedAt,
                                      ).toLocaleString()}
                                    </Typography>
                                    <Typography
                                      variant="caption"
                                      color="text.secondary"
                                    >
                                      Rows: {execution.rowCount ?? 0}
                                      {execution.durationMs
                                        ? ` • ${execution.durationMs} ms`
                                        : ""}
                                    </Typography>
                                    {execution.error?.message ? (
                                      <Typography
                                        variant="caption"
                                        color="error"
                                      >
                                        {execution.error.message}
                                      </Typography>
                                    ) : null}
                                  </Stack>
                                </Box>
                              ))}
                          </Stack>
                        )}
                      </Box>
                    </>
                  ) : null}
                </Stack>
              ) : rightView === "versions" ? (
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="h6">Version history</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Successful builds snapshot the connector source so you can
                      inspect previous revisions.
                    </Typography>
                  </Box>

                  <Divider />

                  {connector.versions.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No build snapshots yet.
                    </Typography>
                  ) : (
                    <Stack spacing={1.5}>
                      {connector.versions
                        .slice()
                        .sort((left, right) => right.version - left.version)
                        .map(version => (
                          <Box
                            key={`${version.version}-${version.createdAt}`}
                            sx={{
                              border: 1,
                              borderColor: "divider",
                              borderRadius: 1,
                              p: 1.5,
                            }}
                          >
                            <Stack spacing={0.75}>
                              <Stack
                                direction="row"
                                justifyContent="space-between"
                                alignItems="center"
                              >
                                <Typography variant="subtitle2">
                                  Version {version.version}
                                </Typography>
                                <Chip
                                  size="small"
                                  label={
                                    version.buildHash?.slice(0, 10) || "draft"
                                  }
                                  variant="outlined"
                                />
                              </Stack>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                {new Date(version.createdAt).toLocaleString()}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                Dependencies:{" "}
                                {version.resolvedDependencies.length > 0
                                  ? version.resolvedDependencies.join(", ")
                                  : "None"}
                              </Typography>
                              <Button
                                size="small"
                                variant="outlined"
                                onClick={() =>
                                  void rollbackConnector(
                                    workspaceId,
                                    connectorId,
                                    version.version,
                                  ).catch(error => {
                                    pushLog(
                                      connectorId,
                                      "error",
                                      error instanceof Error
                                        ? error.message
                                        : "Rollback failed",
                                    );
                                  })
                                }
                              >
                                Roll back
                              </Button>
                            </Stack>
                          </Box>
                        ))}
                    </Stack>
                  )}
                </Stack>
              ) : (
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="h6">AI</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Use the global AI chat to iterate on this connector. The
                      studio already keeps the connector code and latest run
                      results in the app state for follow-up assistance.
                    </Typography>
                  </Box>
                  <Divider />
                  <Button variant="contained" onClick={openRightPane}>
                    Open global AI panel
                  </Button>
                </Stack>
              )}
            </Box>
          </Panel>
        </PanelGroup>
      </Box>
    </Box>
  );
}

export default ConnectorStudio;
