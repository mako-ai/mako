import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { DataGridPremium, type GridColDef } from "@mui/x-data-grid-premium";
import MonacoEditor from "@monaco-editor/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConnectorBuilderStore,
  type ConnectorOutput,
} from "../store/connectorBuilderStore";
import { useConsoleStore } from "../store/consoleStore";

type BottomView = "output" | "logs" | "schema";

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

function ConnectorStudio({ tabId, connectorId }: ConnectorStudioProps) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const {
    connectors,
    buildState,
    devRunState,
    fetchConnectors,
    updateConnector,
    buildConnector,
    devRun,
    selectConnector,
  } = useConnectorBuilderStore();
  const { updateContent, updateTitle, updateDirty } = useConsoleStore();
  const [bottomView, setBottomView] = useState<BottomView>("output");
  const [code, setCode] = useState("");
  const [name, setName] = useState("Untitled Connector");
  const [description, setDescription] = useState("");
  const [configJson, setConfigJson] = useState("{}");
  const [secretsJson, setSecretsJson] = useState("{}");
  const [stateJson, setStateJson] = useState("{}");
  const [localError, setLocalError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const connector = useMemo(
    () =>
      workspaceId
        ? (connectors[workspaceId] || []).find(item => item._id === connectorId)
        : undefined,
    [connectorId, connectors, workspaceId],
  );

  const currentBuildState = connectorId ? buildState[connectorId] : undefined;
  const currentRunState = connectorId ? devRunState[connectorId] : undefined;
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

  const handleBuild = async () => {
    if (!workspaceId || !connectorId) {
      return;
    }

    setLocalError(null);

    try {
      if (isDirty) {
        await persistConnector();
      }
      await buildConnector(workspaceId, connectorId);
      setBottomView("logs");
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Build failed");
    }
  };

  const handleRun = async () => {
    if (!workspaceId || !connectorId) {
      return;
    }

    setLocalError(null);

    const config = safeParseJson(configJson, "Config");
    const secrets = safeParseJson(secretsJson, "Secrets");
    const state = safeParseJson(stateJson, "State");
    const firstError = config.error || secrets.error || state.error;

    if (firstError) {
      setLocalError(firstError);
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
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Run failed");
      setBottomView("logs");
    }
  };

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
      <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
        <Stack spacing={1.5}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1.5}
            alignItems={{ xs: "stretch", md: "center" }}
            justifyContent="space-between"
          >
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={1.5}
              flex={1}
            >
              <TextField
                label="Connector name"
                size="small"
                value={name}
                onChange={event => {
                  const nextName = event.target.value;
                  setName(nextName);
                  updateTitle(tabId, nextName || "Untitled Connector");
                  updateDirty(tabId, true);
                  setIsDirty(true);
                }}
                sx={{ minWidth: 260 }}
              />
              <TextField
                label="Description"
                size="small"
                value={description}
                onChange={event => {
                  setDescription(event.target.value);
                  updateDirty(tabId, true);
                  setIsDirty(true);
                }}
                fullWidth
              />
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                onClick={() => {
                  setLocalError(null);
                  void persistConnector().catch(error => {
                    setLocalError(
                      error instanceof Error ? error.message : "Save failed",
                    );
                  });
                }}
              >
                Save
              </Button>
              <Button
                variant="outlined"
                onClick={() => void handleBuild()}
                disabled={currentBuildState?.building}
              >
                {currentBuildState?.building ? "Building..." : "Build"}
              </Button>
              <Button
                variant="contained"
                onClick={() => void handleRun()}
                disabled={currentRunState?.running}
              >
                {currentRunState?.running ? "Running..." : "Run"}
              </Button>
            </Stack>
          </Stack>

          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            flexWrap="wrap"
          >
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
          </Stack>
        </Stack>
      </Box>

      {(localError || currentRunState?.error) && (
        <Alert severity="error" sx={{ m: 2, mb: 0 }}>
          {localError || currentRunState?.error}
        </Alert>
      )}

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
                    sx={{ px: 1, borderBottom: 1, borderColor: "divider" }}
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
                        {[
                          currentBuildState?.buildLog,
                          ...(currentRunState?.logs || []).map(
                            log =>
                              `[${log.level}]${log.timestamp ? ` ${log.timestamp}` : ""} ${log.message}`,
                          ),
                        ]
                          .filter(Boolean)
                          .join("\n") || "No logs yet."}
                      </Box>
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
              <Stack spacing={2}>
                <Box>
                  <Typography variant="h6">Run Inputs</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Phase 1 keeps this panel lightweight: configure config,
                    secrets, and state for dev runs. The AI copilot panel will
                    land here in a later phase.
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
            </Box>
          </Panel>
        </PanelGroup>
      </Box>
    </Box>
  );
}

export default ConnectorStudio;
