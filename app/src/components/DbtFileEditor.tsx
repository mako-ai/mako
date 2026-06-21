/**
 * DbtFileEditor — full-screen Monaco editor for one dbt project file plus a
 * persistent dbt Studio-style bottom panel (Commands / Problems / Results /
 * Code quality / Compiled code / Lineage) and a status bar (inline command
 * input, defer environment, compile status, dbt version, problem counts).
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  Checkbox,
  CircularProgress,
  Divider,
  FormControlLabel,
  IconButton,
  InputBase,
  ListSubheader,
  Menu,
  MenuItem,
  Select,
  Tab,
  Tabs,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import {
  AlertTriangle as WarnIcon,
  CircleX as ErrorIcon,
  CheckCircle2 as OkIcon,
  ChevronDown as CollapseIcon,
  ChevronUp as ExpandIcon,
  Hammer as CompileIcon,
  Play as RunIcon,
  Terminal as CommandIcon,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import MonacoEditor, { type Monaco } from "@monaco-editor/react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useDbtStore,
  type DbtCompileResult,
  type DbtCommandRunResult,
  type DbtRunModelResult,
  type DbtRunLogLine,
} from "../store/dbtStore";
import {
  registerDbtJinjaLanguage,
  registerDbtCompletions,
} from "../lib/dbt-monaco";
import { dbtVersionLabel } from "../lib/dbt-versions";
import {
  buildDbtNodeCommand,
  type DbtRunVerb,
  type DbtSelectScope,
} from "../lib/dbt-node-selection";
import {
  languageForDbtPath,
  logsToProblems,
  modelNameForPath,
  modelNamesFromPaths,
  type Problem,
} from "../lib/dbt-editor-logic";
import { focusDbtFileTab } from "../dbt-runtime/shell";
import EntityBreadcrumbs from "./EntityBreadcrumbs";

const DbtLineageView = lazy(() => import("./DbtLineageView"));

type PanelTab =
  | "commands"
  | "problems"
  | "results"
  | "quality"
  | "compiled"
  | "lineage";

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

function StepResultsTable({
  steps,
}: {
  steps: DbtRunModelResult["stepResults"];
}) {
  return (
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
        {steps.map(step => (
          <Box
            component="tr"
            key={step.uniqueId}
            sx={{
              color:
                step.status === "error" || step.status === "fail"
                  ? "error.main"
                  : step.status === "warn"
                    ? "warning.main"
                    : "inherit",
            }}
          >
            <td>{step.name}</td>
            <td>{step.resourceType}</td>
            <td>{step.status}</td>
            <td>{(step.executionTimeMs / 1000).toFixed(2)}s</td>
            <td>{step.rowsAffected ?? ""}</td>
          </Box>
        ))}
      </tbody>
    </Box>
  );
}

function ProblemList({
  problems,
  projectId,
  busy,
  emptyOk,
}: {
  problems: Problem[] | null;
  projectId: string;
  busy: boolean;
  emptyOk: string;
}) {
  if (problems === null || busy) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="caption" color="text.secondary">
          {busy ? "Parsing project…" : "Run a command or parse to populate."}
        </Typography>
      </Box>
    );
  }
  if (problems.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="caption" color="success.main">
          {emptyOk}
        </Typography>
      </Box>
    );
  }
  return (
    <>
      {problems.map((problem, index) => (
        <Box
          key={index}
          onClick={() => {
            if (problem.filePath) focusDbtFileTab(projectId, problem.filePath);
          }}
          sx={{
            display: "flex",
            alignItems: "flex-start",
            gap: 1,
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            cursor: problem.filePath ? "pointer" : "default",
            "&:hover": problem.filePath
              ? { bgcolor: "action.hover" }
              : undefined,
          }}
        >
          {problem.severity === "error" ? (
            <ErrorIcon
              size={15}
              style={{ marginTop: 2, flexShrink: 0 }}
              color="var(--mui-palette-error-main)"
            />
          ) : (
            <WarnIcon
              size={15}
              style={{ marginTop: 2, flexShrink: 0 }}
              color="var(--mui-palette-warning-main)"
            />
          )}
          <Box sx={{ minWidth: 0 }}>
            <Typography
              variant="caption"
              sx={{
                display: "block",
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
              }}
            >
              {problem.message}
            </Typography>
            {problem.filePath && (
              <Typography variant="caption" color="primary">
                {problem.filePath}
              </Typography>
            )}
          </Box>
        </Box>
      ))}
    </>
  );
}

export default function DbtFileEditor({
  tabId,
  projectId,
  path,
}: {
  tabId: string;
  projectId: string;
  path: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const monacoTheme = useTheme().palette.mode === "dark" ? "vs-dark" : "vs";

  const project = useDbtStore(s => s.projects.find(p => p._id === projectId));
  const file = useDbtStore(s => s.filesByProject[projectId]?.[path]);
  const filePaths = useDbtStore(s => s.filePathsByProject[projectId]);
  const fetchProjects = useDbtStore(s => s.fetchProjects);
  const readFile = useDbtStore(s => s.readFile);
  const writeFile = useDbtStore(s => s.writeFile);
  const persistFile = useDbtStore(s => s.persistFile);
  const compileModel = useDbtStore(s => s.compileModel);
  const runCommand = useDbtStore(s => s.runCommand);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [environment, setEnvironment] = useState<string>("");
  const [defer, setDefer] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("compiled");
  const [busy, setBusy] = useState<
    "compile" | "run" | "command" | "parse" | null
  >(null);
  const [compileResult, setCompileResult] = useState<DbtCompileResult | null>(
    null,
  );
  const [command, setCommand] = useState("");
  const [commandResult, setCommandResult] =
    useState<DbtCommandRunResult | null>(null);
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [runMenuAnchor, setRunMenuAnchor] = useState<HTMLElement | null>(null);

  const modelName = useMemo(() => modelNameForPath(path), [path]);

  // Live-compile plumbing: refs let the debounced save callback re-compile
  // without re-creating the timer on every keystroke. `manualBusyRef` is set
  // only by explicit compile/run/command actions so auto-compile can defer to
  // them (but is NOT blocked by the background project parse).
  const manualBusyRef = useRef(false);
  const autoCompileRef = useRef<() => void>(() => {});

  // Keep model names current for the (global, singleton) ref() completion
  // provider without re-registering it on every keystroke.
  const modelNamesRef = useRef<string[]>([]);
  useEffect(() => {
    modelNamesRef.current = modelNamesFromPaths(filePaths ?? []);
  }, [filePaths]);

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    registerDbtJinjaLanguage(monaco);
    registerDbtCompletions(monaco, {
      getModelNames: () => modelNamesRef.current,
    });
  }, []);

  useEffect(() => {
    if (!project && workspaceId) void fetchProjects(workspaceId);
  }, [project, workspaceId, fetchProjects]);

  useEffect(() => {
    if (workspaceId && !file?.loaded) {
      void readFile(workspaceId, projectId, path);
    }
  }, [workspaceId, projectId, path, file?.loaded, readFile]);

  useEffect(() => {
    if (project && !environment) setEnvironment(project.defaultEnvironment);
  }, [project, environment]);

  const handleChange = useCallback(
    (value: string | undefined) => {
      writeFile(projectId, path, value ?? "");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (workspaceId) {
        saveTimer.current = setTimeout(() => {
          void persistFile(workspaceId, projectId, path);
          // Live re-compile after the edit settles (dbt Studio parity).
          autoCompileRef.current();
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

  const runParse = useCallback(async () => {
    if (!workspaceId) return;
    setBusy("parse");
    const compile = await compileModel(
      workspaceId,
      projectId,
      undefined,
      environment || undefined,
    );
    setProblems(logsToProblems(compile?.logs ?? []));
    setBusy(null);
  }, [workspaceId, projectId, environment, compileModel]);

  const handleCompile = useCallback(async () => {
    if (!workspaceId || !modelName) return;
    saveNow();
    manualBusyRef.current = true;
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
    if (result && !result.ok) setPanelTab("problems");
    manualBusyRef.current = false;
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

  // Quiet, automatic compile: refreshes the Compiled code tab + status pill
  // without stealing focus or switching tabs. Dev-only and skipped while an
  // explicit compile/run/command is in flight (but not blocked by parse).
  const autoCompile = useCallback(async () => {
    if (!workspaceId || !modelName || !environment) return;
    if (environment === "prod" || manualBusyRef.current) return;
    setBusy("compile");
    const result = await compileModel(
      workspaceId,
      projectId,
      modelName,
      environment,
      defer,
    );
    setCompileResult(result);
    setBusy(null);
  }, [workspaceId, projectId, modelName, environment, defer, compileModel]);

  useEffect(() => {
    autoCompileRef.current = autoCompile;
  }, [autoCompile]);

  // On open / environment change: parse the project (Problems + Code quality)
  // then live-compile the active model so the status pill and Compiled code
  // populate automatically — mirroring dbt Studio (no Compile button).
  useEffect(() => {
    if (!workspaceId || !environment) return;
    let cancelled = false;
    void (async () => {
      await runParse();
      if (cancelled) return;
      if (modelName && file?.loaded) await autoCompile();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId, environment, modelName, file?.loaded]);

  // Build/Run/Test the active model with dbt graph operators. `scope` maps to
  // the `+` selectors: "" = node only, "down" = node+ (children), "up" =
  // +node (parents), "both" = +node+ (both directions).
  const runNodeSelection = useCallback(
    async (verb: DbtRunVerb, scope: DbtSelectScope) => {
      if (!workspaceId || !modelName) return;
      const cmd = buildDbtNodeCommand(verb, modelName, scope);
      if (
        environment === "prod" &&
        !window.confirm(`Run "dbt ${cmd}" against the prod environment?`)
      ) {
        return;
      }
      saveNow();
      manualBusyRef.current = true;
      setBusy("command");
      setPanelOpen(true);
      setPanelTab("results");
      const res = await runCommand(
        workspaceId,
        projectId,
        cmd,
        environment || undefined,
        defer,
      );
      setCommandResult(res);
      if (res && res.stepResults.length === 0) setPanelTab("commands");
      manualBusyRef.current = false;
      setBusy(null);
    },
    [
      workspaceId,
      projectId,
      modelName,
      environment,
      defer,
      runCommand,
      saveNow,
    ],
  );

  const handleRunCommand = useCallback(async () => {
    if (!workspaceId || !command.trim()) return;
    if (
      environment === "prod" &&
      !window.confirm(`Run "${command}" against the prod environment?`)
    ) {
      return;
    }
    saveNow();
    manualBusyRef.current = true;
    setBusy("command");
    setPanelOpen(true);
    setPanelTab("commands");
    const res = await runCommand(
      workspaceId,
      projectId,
      command.trim(),
      environment || undefined,
      defer,
    );
    setCommandResult(res);
    manualBusyRef.current = false;
    setBusy(null);
  }, [
    workspaceId,
    projectId,
    command,
    environment,
    defer,
    runCommand,
    saveNow,
  ]);

  const errorCount = useMemo(
    () => problems?.filter(p => p.severity === "error").length ?? 0,
    [problems],
  );
  const warnCount = useMemo(
    () => problems?.filter(p => p.severity === "warn").length ?? 0,
    [problems],
  );
  const errorProblems = useMemo(
    () => problems?.filter(p => p.severity === "error") ?? null,
    [problems],
  );
  const warnProblems = useMemo(
    () => problems?.filter(p => p.severity === "warn") ?? null,
    [problems],
  );

  const resultSteps = commandResult?.stepResults;
  const commandLogs = commandResult?.logs ?? compileResult?.logs ?? [];

  // Status pill mirrors dbt Studio: it reflects the live compile state of the
  // active model (runs/tests surface their outcome in Results/Commands).
  const status: { label: string; tone: "ok" | "error" | "busy" | "idle" } =
    busy === "compile"
      ? { label: "Compiling…", tone: "busy" }
      : busy === "run" || busy === "command"
        ? { label: "Running…", tone: "busy" }
        : busy === "parse"
          ? { label: "Checking…", tone: "busy" }
          : compileResult
            ? compileResult.ok
              ? { label: "Compiled", tone: "ok" }
              : { label: "Compile error", tone: "error" }
            : errorCount > 0
              ? { label: "Errors", tone: "error" }
              : { label: "Ready", tone: "idle" };

  if (!file?.loaded) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading file…</Typography>
      </Box>
    );
  }

  const editorPane = (
    <Box sx={{ height: "100%", minHeight: 0 }}>
      <MonacoEditor
        height="100%"
        path={`dbt/${projectId}/${path}`}
        language={languageForDbtPath(path)}
        value={file.content}
        theme={monacoTheme}
        onChange={handleChange}
        beforeMount={handleBeforeMount}
        onMount={handleEditorMount as never}
        options={{
          minimap: { enabled: true },
          fontSize: 13,
          automaticLayout: true,
          scrollBeyondLastLine: false,
        }}
      />
    </Box>
  );

  const panelHeader = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      {modelName && (
        <Box sx={{ display: "flex", alignItems: "center", pl: 0.5 }}>
          <Tooltip title="Recompile this model">
            <span>
              <IconButton
                size="small"
                aria-label="Recompile this model"
                disabled={busy !== null}
                onClick={handleCompile}
              >
                <CompileIcon size={15} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Build / Run / Test this model (with upstream/downstream selectors)">
            <span>
              <IconButton
                size="small"
                color="primary"
                aria-label="Build, run, or test this model"
                disabled={busy !== null}
                onClick={e => setRunMenuAnchor(e.currentTarget)}
              >
                <RunIcon size={15} />
                <CollapseIcon size={11} style={{ marginLeft: -1 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Box
            sx={{
              width: "1px",
              height: 16,
              bgcolor: "divider",
              mx: 0.5,
              flexShrink: 0,
            }}
          />
        </Box>
      )}
      <Tabs
        value={panelTab}
        onChange={(_e, value: PanelTab) => {
          setPanelTab(value);
          if (!panelOpen) setPanelOpen(true);
        }}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ minHeight: 34, flex: 1, "& .MuiTab-root": { minHeight: 34 } }}
      >
        <Tab label="Commands" value="commands" sx={{ py: 0 }} />
        <Tab
          label={`Problems${errorCount + warnCount ? ` ${errorCount + warnCount}` : ""}`}
          value="problems"
          sx={{ py: 0 }}
        />
        <Tab label="Results" value="results" sx={{ py: 0 }} />
        <Tab
          label={`Code quality${warnCount ? ` ${warnCount}` : ""}`}
          value="quality"
          sx={{ py: 0 }}
        />
        <Tab label="Compiled code" value="compiled" sx={{ py: 0 }} />
        <Tab label="Lineage" value="lineage" sx={{ py: 0 }} />
      </Tabs>
      {busy && <CircularProgress size={14} sx={{ mr: 1 }} />}
      <Tooltip title={panelOpen ? "Collapse panel" : "Expand panel"}>
        <IconButton size="small" onClick={() => setPanelOpen(o => !o)}>
          {panelOpen ? <CollapseIcon size={16} /> : <ExpandIcon size={16} />}
        </IconButton>
      </Tooltip>
    </Box>
  );

  const panelBody = (
    <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      {panelTab === "commands" && (
        <Box sx={{ height: "100%" }}>
          {commandResult ? (
            <LogLines logs={commandLogs} />
          ) : (
            <Box sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary">
                Type a dbt command in the bar below (e.g.{" "}
                <code>build --select stg_orders+</code>) and press Enter.
              </Typography>
            </Box>
          )}
        </Box>
      )}

      {panelTab === "problems" && (
        <ProblemList
          problems={errorProblems}
          projectId={projectId}
          busy={busy === "parse"}
          emptyOk="No problems — project parses cleanly."
        />
      )}

      {panelTab === "results" && (
        <Box sx={{ p: 1 }}>
          {!resultSteps || resultSteps.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              {busy === "run" || busy === "command"
                ? "Running…"
                : "Run a model or command to see node results."}
            </Typography>
          ) : (
            <StepResultsTable steps={resultSteps} />
          )}
        </Box>
      )}

      {panelTab === "quality" && (
        <ProblemList
          problems={warnProblems}
          projectId={projectId}
          busy={busy === "parse"}
          emptyOk="No code-quality warnings."
        />
      )}

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
                  ? "Compile failed — see Problems."
                  : modelName
                    ? "Compiling… (live — refreshes on save)."
                    : "Open a .sql model to compile."}
            </Typography>
          </Box>
        ))}

      {panelTab === "lineage" && (
        <Suspense
          fallback={
            <Box sx={{ p: 3, display: "flex", justifyContent: "center" }}>
              <CircularProgress size={20} />
            </Box>
          }
        >
          <DbtLineageView projectId={projectId} />
        </Suspense>
      )}
    </Box>
  );

  const toneColor =
    status.tone === "ok"
      ? "success.main"
      : status.tone === "error"
        ? "error.main"
        : "text.secondary";

  const statusBar = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 1,
        py: 0.25,
        borderTop: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        flexShrink: 0,
        minHeight: 30,
      }}
    >
      {/* Inline command bar (screenshot: bottom-left command input) */}
      <CommandIcon
        size={14}
        style={{ flexShrink: 0, opacity: 0.6, marginLeft: 4 }}
      />
      <InputBase
        value={command}
        onChange={e => setCommand(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") void handleRunCommand();
        }}
        placeholder="Type a command, ex. dbt build --select <model_name>"
        disabled={busy !== null}
        sx={{
          flex: 1,
          minWidth: 0,
          fontFamily: "monospace",
          fontSize: "0.78rem",
        }}
      />
      {command.trim() && (
        <Tooltip title="Run command (Enter)">
          <IconButton
            size="small"
            onClick={handleRunCommand}
            disabled={busy !== null}
          >
            <RunIcon size={14} />
          </IconButton>
        </Tooltip>
      )}

      {/* Defer / environment */}
      <Tooltip title="Resolve unselected refs against the last prod build (dbt --defer)">
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={defer}
              onChange={e => setDefer(e.target.checked)}
              sx={{ p: 0.25 }}
            />
          }
          label={
            <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
              Defer to
            </Typography>
          }
          sx={{ mr: 0, ml: 0.5 }}
        />
      </Tooltip>
      <Select
        size="small"
        variant="standard"
        disableUnderline
        value={environment}
        onChange={e => setEnvironment(e.target.value)}
        sx={{ fontSize: "0.72rem", textTransform: "uppercase" }}
      >
        {(project?.environments ?? []).map(env => (
          <MenuItem key={env.name} value={env.name}>
            {env.name}
          </MenuItem>
        ))}
      </Select>

      <Box
        sx={{ width: "1px", height: 16, bgcolor: "divider", flexShrink: 0 }}
      />

      {/* Status */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          color: toneColor,
        }}
      >
        {status.tone === "ok" ? (
          <OkIcon size={13} />
        ) : status.tone === "error" ? (
          <ErrorIcon size={13} />
        ) : status.tone === "busy" ? (
          <CircularProgress size={11} />
        ) : null}
        <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
          Status: {status.label}
        </Typography>
      </Box>

      {/* dbt version */}
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ whiteSpace: "nowrap" }}
      >
        dbt {project ? dbtVersionLabel(project.dbtVersion) : ""}
      </Typography>

      {/* Problem counts */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          pr: 0.5,
          cursor: "pointer",
        }}
        onClick={() => {
          setPanelOpen(true);
          setPanelTab("problems");
        }}
      >
        <Box
          sx={{ display: "flex", alignItems: "center", gap: 0.25 }}
          title={`${errorCount} errors`}
        >
          <ErrorIcon size={13} />
          <Typography variant="caption">{errorCount}</Typography>
        </Box>
        <Box
          sx={{ display: "flex", alignItems: "center", gap: 0.25 }}
          title={`${warnCount} warnings`}
        >
          <WarnIcon size={13} />
          <Typography variant="caption">{warnCount}</Typography>
        </Box>
      </Box>
    </Box>
  );

  // dbt node-selection shortcuts (graph operators). Mirrors dbt Studio's
  // Build/Run/Test menu: model / model+ / +model / +model+.
  const RUN_SCOPES: Array<{
    scope: DbtSelectScope;
    label: string;
  }> = [
    { scope: "", label: "model" },
    { scope: "down", label: "model+ (Downstream)" },
    { scope: "up", label: "+model (Upstream)" },
    { scope: "both", label: "+model+ (Up/downstream)" },
  ];
  const RUN_VERBS: Array<{ verb: DbtRunVerb; label: string }> = [
    { verb: "build", label: "Build" },
    { verb: "run", label: "Run" },
    { verb: "test", label: "Test" },
  ];

  const runMenu = (
    <Menu
      anchorEl={runMenuAnchor}
      open={Boolean(runMenuAnchor)}
      onClose={() => setRunMenuAnchor(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      transformOrigin={{ vertical: "top", horizontal: "left" }}
    >
      {RUN_VERBS.flatMap(({ verb, label }, vi) => [
        vi > 0 ? <Divider key={`${verb}-div`} /> : null,
        <ListSubheader
          key={`${verb}-h`}
          sx={{ lineHeight: 2, fontSize: "0.7rem" }}
        >
          {label}
        </ListSubheader>,
        ...RUN_SCOPES.map(({ scope, label: scopeLabel }) => (
          <MenuItem
            key={`${verb}-${scope}`}
            dense
            onClick={() => {
              setRunMenuAnchor(null);
              void runNodeSelection(verb, scope);
            }}
          >
            {label} {scopeLabel}
          </MenuItem>
        )),
      ])}
    </Menu>
  );

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Breadcrumb (workspace › Transforms › project › path). Compile is live
          and runs go through the command bar, mirroring dbt Studio. */}
      <EntityBreadcrumbs tabId={tabId} />

      <Box sx={{ flex: 1, minHeight: 0 }}>
        {panelOpen ? (
          <PanelGroup direction="vertical">
            <Panel defaultSize={62} minSize={20}>
              {editorPane}
            </Panel>
            <PanelResizeHandle
              style={{ height: 4, background: "var(--mui-palette-divider)" }}
            />
            <Panel defaultSize={38} minSize={12}>
              <Box
                sx={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {panelHeader}
                {panelBody}
              </Box>
            </Panel>
          </PanelGroup>
        ) : (
          <Box
            sx={{ height: "100%", display: "flex", flexDirection: "column" }}
          >
            <Box sx={{ flex: 1, minHeight: 0 }}>{editorPane}</Box>
            {panelHeader}
          </Box>
        )}
      </Box>

      {statusBar}
      {runMenu}
    </Box>
  );
}
