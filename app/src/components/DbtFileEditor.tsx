/**
 * DbtFileEditor — full-screen Monaco editor for one dbt project file
 * (pattern: AppFileEditor) plus a Compile / Run model verification panel
 * for SQL model files under models/.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Select,
  Tab,
  Tabs,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import MonacoEditor from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useDbtStore,
  type DbtCompileResult,
  type DbtRunModelResult,
  type DbtRunLogLine,
} from "../store/dbtStore";

function languageForDbtPath(path: string): string {
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

function modelNameForPath(path: string): string | null {
  if (!path.startsWith("models/") || !path.endsWith(".sql")) return null;
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.sql$/, "");
}

function LogLines({ logs }: { logs: DbtRunLogLine[] }) {
  return (
    <Box
      sx={{
        fontFamily: "monospace",
        fontSize: "0.75rem",
        whiteSpace: "pre-wrap",
        p: 1,
        overflow: "auto",
        height: "100%",
      }}
    >
      {logs.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          No output.
        </Typography>
      ) : (
        logs.map((log, index) => (
          <Box
            key={index}
            component="div"
            sx={{
              color:
                log.level === "error"
                  ? "error.main"
                  : log.level === "warn"
                    ? "warning.main"
                    : "text.primary",
            }}
          >
            {log.line}
          </Box>
        ))
      )}
    </Box>
  );
}

export default function DbtFileEditor({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const monacoTheme = useTheme().palette.mode === "dark" ? "vs-dark" : "vs";

  const project = useDbtStore(s => s.projects.find(p => p._id === projectId));
  const file = useDbtStore(s => s.filesByProject[projectId]?.[path]);
  const fetchProjects = useDbtStore(s => s.fetchProjects);
  const readFile = useDbtStore(s => s.readFile);
  const writeFile = useDbtStore(s => s.writeFile);
  const persistFile = useDbtStore(s => s.persistFile);
  const compileModel = useDbtStore(s => s.compileModel);
  const runModel = useDbtStore(s => s.runModel);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [environment, setEnvironment] = useState<string>("");
  const [defer, setDefer] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<"compiled" | "results" | "logs">(
    "compiled",
  );
  const [busy, setBusy] = useState<"compile" | "run" | null>(null);
  const [compileResult, setCompileResult] = useState<DbtCompileResult | null>(
    null,
  );
  const [runResult, setRunResult] = useState<DbtRunModelResult | null>(null);

  const modelName = useMemo(() => modelNameForPath(path), [path]);

  useEffect(() => {
    if (!project && workspaceId) void fetchProjects(workspaceId);
  }, [project, workspaceId, fetchProjects]);

  useEffect(() => {
    if (workspaceId && !file?.loaded) {
      void readFile(workspaceId, projectId, path);
    }
  }, [workspaceId, projectId, path, file?.loaded, readFile]);

  useEffect(() => {
    if (project && !environment) {
      setEnvironment(project.defaultEnvironment);
    }
  }, [project, environment]);

  const handleChange = useCallback(
    (value: string | undefined) => {
      writeFile(projectId, path, value ?? "");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (workspaceId) {
        saveTimer.current = setTimeout(() => {
          void persistFile(workspaceId, projectId, path);
        }, 1200);
      }
    },
    [projectId, path, workspaceId, writeFile, persistFile],
  );

  const saveNow = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (workspaceId) void persistFile(workspaceId, projectId, path);
  }, [workspaceId, projectId, path, persistFile]);

  const handleEditorMount = useCallback(
    (
      editor: { addCommand: (keys: number, handler: () => void) => void },
      monaco: { KeyMod: { CtrlCmd: number }; KeyCode: { KeyS: number } },
    ) => {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveNow);
    },
    [saveNow],
  );

  const handleCompile = useCallback(async () => {
    if (!workspaceId || !modelName) return;
    saveNow();
    setBusy("compile");
    setPanelOpen(true);
    setPanelTab("compiled");
    const result = await compileModel(
      workspaceId,
      projectId,
      modelName,
      environment || undefined,
      defer,
    );
    setCompileResult(result);
    if (result && !result.ok) setPanelTab("logs");
    setBusy(null);
  }, [
    workspaceId,
    projectId,
    modelName,
    environment,
    defer,
    compileModel,
    saveNow,
  ]);

  const handleRunModel = useCallback(async () => {
    if (!workspaceId || !modelName) return;
    if (
      environment === "prod" &&
      !window.confirm(`Run ${modelName} against the prod environment?`)
    ) {
      return;
    }
    saveNow();
    setBusy("run");
    setPanelOpen(true);
    setPanelTab("results");
    const result = await runModel(
      workspaceId,
      projectId,
      modelName,
      environment || undefined,
      defer,
    );
    setRunResult(result);
    if (result && !result.ok) setPanelTab("logs");
    setBusy(null);
  }, [
    workspaceId,
    projectId,
    modelName,
    environment,
    defer,
    runModel,
    saveNow,
  ]);

  if (!file?.loaded) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading file…</Typography>
      </Box>
    );
  }

  const activeLogs =
    panelTab === "logs"
      ? busy === "compile" || (!runResult && compileResult)
        ? (compileResult?.logs ?? [])
        : (runResult?.logs ?? compileResult?.logs ?? [])
      : [];

  const editorPane = (
    <Box sx={{ height: "100%", minHeight: 0 }}>
      <MonacoEditor
        height="100%"
        path={`dbt/${projectId}/${path}`}
        language={languageForDbtPath(path)}
        value={file.content}
        theme={monacoTheme}
        onChange={handleChange}
        onMount={handleEditorMount as never}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          automaticLayout: true,
          scrollBeyondLastLine: false,
        }}
      />
    </Box>
  );

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Breadcrumb + actions */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          minHeight: 30,
          px: 1.5,
          py: 0.25,
          backgroundColor: "background.paper",
          color: "text.secondary",
          fontSize: "0.75rem",
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Box sx={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
          {project?.name ?? "dbt"} / {path}
          {file.dirty ? " •" : ""}
        </Box>
        {modelName && (
          <>
            <Select
              size="small"
              value={environment}
              onChange={e => setEnvironment(e.target.value)}
              sx={{ fontSize: "0.75rem", minWidth: 90 }}
            >
              {(project?.environments ?? []).map(env => (
                <MenuItem key={env.name} value={env.name}>
                  {env.name}
                </MenuItem>
              ))}
            </Select>
            <Tooltip title="Resolve unselected refs against the last prod build (dbt --defer)">
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={defer}
                    onChange={e => setDefer(e.target.checked)}
                  />
                }
                label={
                  <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
                    Defer
                  </Typography>
                }
                sx={{ mr: 0 }}
              />
            </Tooltip>
            <Button
              size="small"
              variant="outlined"
              disabled={busy !== null}
              onClick={handleCompile}
            >
              {busy === "compile" ? "Compiling…" : "Compile"}
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={busy !== null}
              onClick={handleRunModel}
            >
              {busy === "run" ? "Running…" : "Run model"}
            </Button>
          </>
        )}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0 }}>
        {panelOpen ? (
          <PanelGroup direction="vertical">
            <Panel defaultSize={60} minSize={20}>
              {editorPane}
            </Panel>
            <PanelResizeHandle
              style={{ height: 4, background: "var(--mui-palette-divider)" }}
            />
            <Panel defaultSize={40} minSize={15}>
              <Box
                sx={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  borderTop: "1px solid",
                  borderColor: "divider",
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    borderBottom: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Tabs
                    value={panelTab}
                    onChange={(_e, value) => setPanelTab(value)}
                    sx={{ minHeight: 32, flex: 1 }}
                  >
                    <Tab
                      label="Compiled SQL"
                      value="compiled"
                      sx={{ minHeight: 32, py: 0 }}
                    />
                    <Tab
                      label="Results"
                      value="results"
                      sx={{ minHeight: 32, py: 0 }}
                    />
                    <Tab
                      label="Logs"
                      value="logs"
                      sx={{ minHeight: 32, py: 0 }}
                    />
                  </Tabs>
                  {busy && <CircularProgress size={14} sx={{ mr: 1 }} />}
                  <Button size="small" onClick={() => setPanelOpen(false)}>
                    Close
                  </Button>
                </Box>
                <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                  {panelTab === "compiled" &&
                    (compileResult?.compiledSql ? (
                      <MonacoEditor
                        height="100%"
                        language="sql"
                        value={compileResult.compiledSql}
                        theme={monacoTheme}
                        options={{
                          readOnly: true,
                          minimap: { enabled: false },
                          fontSize: 12,
                          scrollBeyondLastLine: false,
                        }}
                      />
                    ) : (
                      <Box sx={{ p: 2 }}>
                        <Typography variant="caption" color="text.secondary">
                          {busy === "compile"
                            ? "Compiling…"
                            : compileResult && !compileResult.ok
                              ? "Compile failed — see Logs."
                              : "Press Compile to see the rendered SQL."}
                        </Typography>
                      </Box>
                    ))}
                  {panelTab === "results" && (
                    <Box sx={{ p: 1 }}>
                      {!runResult ? (
                        <Typography variant="caption" color="text.secondary">
                          {busy === "run"
                            ? "Running model…"
                            : "Press Run model to build this model on the selected environment."}
                        </Typography>
                      ) : (
                        <Box
                          component="table"
                          sx={{
                            width: "100%",
                            fontSize: "0.75rem",
                            borderCollapse: "collapse",
                            "& td, & th": {
                              borderBottom: "1px solid",
                              borderColor: "divider",
                              p: 0.5,
                              textAlign: "left",
                            },
                          }}
                        >
                          <thead>
                            <tr>
                              <th>Node</th>
                              <th>Type</th>
                              <th>Status</th>
                              <th>Time</th>
                              <th>Rows</th>
                            </tr>
                          </thead>
                          <tbody>
                            {runResult.stepResults.map(step => (
                              <Box
                                component="tr"
                                key={step.uniqueId}
                                sx={{
                                  color:
                                    step.status === "error" ||
                                    step.status === "fail"
                                      ? "error.main"
                                      : step.status === "warn"
                                        ? "warning.main"
                                        : "inherit",
                                }}
                              >
                                <td>{step.name}</td>
                                <td>{step.resourceType}</td>
                                <td>{step.status}</td>
                                <td>
                                  {(step.executionTimeMs / 1000).toFixed(2)}s
                                </td>
                                <td>{step.rowsAffected ?? ""}</td>
                              </Box>
                            ))}
                          </tbody>
                        </Box>
                      )}
                    </Box>
                  )}
                  {panelTab === "logs" && <LogLines logs={activeLogs} />}
                </Box>
              </Box>
            </Panel>
          </PanelGroup>
        ) : (
          editorPane
        )}
      </Box>
    </Box>
  );
}
