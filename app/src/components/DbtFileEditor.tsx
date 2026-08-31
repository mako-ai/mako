/**
 * DbtFileEditor — full-screen Monaco editor for one dbt project file plus a
 * persistent dbt Cloud-style bottom panel (Commands / Problems / Results /
 * Compiled code / Lineage) and a status bar (inline command input, defer
 * environment, compile status, dbt version, problem counts).
 *
 * The panel toolbar mirrors dbt Cloud's: Preview (bounded read-only `dbt show`,
 * also bound to ⌘↵) · Compile · Build ▾ (split button whose menu carries the
 * Build/Run/Test × graph-operator matrix). Preview fills the Results grid with
 * real rows; Build/Run/Test node outcomes live in the Commands tab next to the
 * command that produced them.
 */

import { useConsoleStore } from "../store/consoleStore";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
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
  Switch,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  AlertTriangle as WarnIcon,
  CircleX as ErrorIcon,
  CheckCircle2 as OkIcon,
  ChevronDown as CollapseIcon,
  ChevronUp as ExpandIcon,
  Code2 as CompileIcon,
  Play as RunIcon,
  Table2 as PreviewIcon,
  Terminal as CommandIcon,
  Wrench as BuildIcon,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import MonacoEditor, { type Monaco } from "@monaco-editor/react";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import {
  DBT_PREVIEW_DEFAULT_LIMIT,
  useDbtStore,
  visibleDbtEnvironments,
  type DbtCompileResult,
  type DbtPreviewResult,
  type DbtRunLogLine,
  type DbtStepResult,
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
  isMarkdownDbtPath,
  languageForDbtPath,
  logsToProblems,
  modelNameForPath,
  modelNamesFromPaths,
  type Problem,
} from "../lib/dbt-editor-logic";
import { resolveDevEnvName, resolveProdLikeEnvName } from "../lib/dbt-env";
import {
  appendInvocation,
  settleInvocation,
  type DbtCommandInvocation,
} from "../lib/dbt-command-history";
import {
  downloadTextFile,
  previewFilename,
  rowsToCsv,
  rowsToNdjson,
} from "../lib/preview-export";
import { focusDbtFileTab } from "../dbt-runtime/shell";
import EntityBreadcrumbs from "./EntityBreadcrumbs";
import EntityLoadErrorState, {
  EntityLoadingState,
} from "./EntityLoadErrorState";
import StreamingMarkdown from "./StreamingMarkdown";
import DbtCommandsPanel from "./DbtCommandsPanel";
import { useConfirmProdRun } from "../dbt-runtime/confirm-prod-run";

const DbtLineageView = lazy(() => import("./DbtLineageView"));
// The results grid drags in MUI's DataGrid (+ its stylesheet) and the charting
// stack; keep it out of the editor's chunk until a Preview actually runs.
const ResultsTable = lazy(() => import("./ResultsTable"));

type PanelTab = "commands" | "problems" | "results" | "compiled" | "lineage";

/**
 * dbt Cloud's empty Results state: previews are explicit, so an untouched tab
 * says which button fills it rather than pretending to be loading.
 */
function ResultsEmptyState({ message }: { message: string }) {
  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        color: "text.secondary",
      }}
    >
      <PreviewIcon size={44} strokeWidth={1.25} />
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        There&apos;s nothing here.
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {message}
      </Typography>
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
  const confirmProdRun = useConfirmProdRun();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;
  const monacoTheme = useMonacoTheme();

  const project = useDbtStore(s => s.projects.find(p => p._id === projectId));
  const file = useDbtStore(s => s.filesByProject[projectId]?.[path]);
  const fileLoadError = useDbtStore(
    s => s.loadErrors[`file:${projectId}:${path}`],
  );
  const filePaths = useDbtStore(s => s.filePathsByProject[projectId]);
  const fetchProjects = useDbtStore(s => s.fetchProjects);
  const readFile = useDbtStore(s => s.readFile);
  const writeFile = useDbtStore(s => s.writeFile);
  const persistFile = useDbtStore(s => s.persistFile);
  const compileModel = useDbtStore(s => s.compileModel);
  const runCommand = useDbtStore(s => s.runCommand);
  const previewModel = useDbtStore(s => s.previewModel);
  const setMyEnvironment = useDbtStore(s => s.setMyEnvironment);

  const save = useDebouncedCallback(() => {
    if (!workspaceId) return;
    void persistFile(workspaceId, projectId, path);
    // Live re-compile after the edit settles (dbt Studio parity).
    autoCompileRef.current();
  }, 1200);
  const [environment, setEnvironment] = useState<string>("");
  const [defer, setDefer] = useState(false);
  // Run menu builds/runs with --full-refresh (rebuild incremental models
  // from scratch). Sticky per editor instance, like the Defer checkbox.
  const [fullRefresh, setFullRefresh] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("compiled");
  const [busy, setBusy] = useState<
    "compile" | "preview" | "command" | "parse" | null
  >(null);
  const [compileResult, setCompileResult] = useState<DbtCompileResult | null>(
    null,
  );
  const [command, setCommand] = useState("");
  const [preview, setPreview] = useState<DbtPreviewResult | null>(null);
  // Session-scoped Commands rail (see lib/dbt-command-history).
  const [history, setHistory] = useState<DbtCommandInvocation[]>([]);
  const [selectedInvocationId, setSelectedInvocationId] = useState<
    string | null
  >(null);
  const [problems, setProblems] = useState<Problem[] | null>(null);
  const [runMenuAnchor, setRunMenuAnchor] = useState<HTMLElement | null>(null);
  // Markdown docs (.md/.markdown) open in a rendered preview by default; the
  // header switch flips back to the raw Monaco editor for editing.
  const [markdownPreview, setMarkdownPreview] = useState(true);

  const modelName = useMemo(() => modelNameForPath(path), [path]);
  // Defer target for display: the project's production-like environment.
  const prodEnvName = useMemo(
    () => (project ? (resolveProdLikeEnvName(project) ?? "prod") : "prod"),
    [project],
  );
  const isMarkdown = useMemo(() => isMarkdownDbtPath(path), [path]);
  const showMarkdownPreview = isMarkdown && markdownPreview;

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

  // Default to the user's saved dev environment (per-user setting), else
  // their personal environment, else the project default. Single player:
  // the shared dev default IS the personal target.
  useEffect(() => {
    if (project && !environment) {
      setEnvironment(
        resolveDevEnvName(project, user?.id) ?? project.defaultEnvironment,
      );
    }
  }, [project, environment, user?.id]);

  // Picking an environment is a per-user setting: persist it so the console,
  // the agent's builds, and other windows follow the same choice.
  const handleEnvironmentChange = useCallback(
    (name: string) => {
      setEnvironment(name);
      if (workspaceId) void setMyEnvironment(workspaceId, projectId, name);
    },
    [workspaceId, projectId, setMyEnvironment],
  );

  const handleChange = useCallback(
    (value: string | undefined) => {
      writeFile(projectId, path, value ?? "");
      // First keystroke pins the tab (preview -> permanent), as for consoles.
      useConsoleStore.getState().updateDirty(tabId, true);
      save.call();
    },
    [projectId, path, writeFile, save, tabId],
  );

  const saveNow = useCallback(() => {
    save.cancel();
    if (workspaceId) void persistFile(workspaceId, projectId, path);
  }, [save, workspaceId, projectId, path, persistFile]);

  // ⌘S saves, ⌘↵ previews. Both are registered once on mount, so they read the
  // live handler through a ref rather than capturing the mount-time closure.
  const previewRef = useRef<() => void>(() => {});
  const handleEditorMount = useCallback(
    (
      editor: { addCommand: (keys: number, handler: () => void) => void },
      monaco: {
        KeyMod: { CtrlCmd: number };
        KeyCode: { KeyS: number; Enter: number };
      },
    ) => {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveNow);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
        previewRef.current(),
      );
    },
    [saveNow],
  );

  /**
   * Run one dbt invocation and log it in the Commands rail: append a `running`
   * entry up front (so a slow build is visible while it runs), then settle it
   * with the outcome. Returns the runner's result untouched so each caller can
   * still drive its own tab.
   */
  const invocationSeq = useRef(0);
  const recordInvocation = useCallback(
    async <T,>(
      commandLabel: string,
      run: () => Promise<T>,
      describe: (result: T) => {
        status: "success" | "error";
        logs: DbtRunLogLine[];
        stepResults: DbtStepResult[];
      },
    ): Promise<T> => {
      const id = `inv-${(invocationSeq.current += 1)}`;
      const startedAt = Date.now();
      setHistory(entries =>
        appendInvocation(entries, {
          id,
          command: commandLabel,
          environment: environment || "—",
          startedAt,
          status: "running",
          logs: [],
          stepResults: [],
        }),
      );
      setSelectedInvocationId(id);
      try {
        const result = await run();
        setHistory(entries =>
          settleInvocation(entries, id, {
            durationMs: Date.now() - startedAt,
            ...describe(result),
          }),
        );
        return result;
      } catch (error) {
        // The store actions swallow failures into result objects, so this only
        // fires on a genuine crash — still, never strand an entry as running.
        setHistory(entries =>
          settleInvocation(entries, id, {
            durationMs: Date.now() - startedAt,
            status: "error",
            logs: [
              {
                ts: new Date().toISOString(),
                level: "error",
                line: String(error),
              },
            ],
          }),
        );
        throw error;
      }
    },
    [environment],
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
    const result = await recordInvocation(
      `compile --select ${modelName}`,
      () =>
        compileModel(
          workspaceId,
          projectId,
          modelName,
          environment || undefined,
          defer,
        ),
      compiled => ({
        status: compiled?.ok ? ("success" as const) : ("error" as const),
        logs: compiled?.logs ?? [],
        stepResults: [],
      }),
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
    recordInvocation,
  ]);

  /**
   * Preview (⌘↵) — a bounded, read-only `dbt show` over the model's compiled
   * SQL. Nothing is materialized, so unlike Build/Run/Test it needs no prod
   * confirmation and never touches run history.
   */
  const previewInFlightRef = useRef(false);
  const handlePreview = useCallback(async () => {
    if (!workspaceId || !modelName) return;
    // ⌘↵ can arrive from both Monaco's binding and the document listener, and
    // it is a chord people mash — one preview at a time either way.
    if (previewInFlightRef.current) return;
    previewInFlightRef.current = true;
    saveNow();
    manualBusyRef.current = true;
    setBusy("preview");
    setPanelOpen(true);
    setPanelTab("results");
    const result = await recordInvocation(
      `show --select ${modelName} --limit ${DBT_PREVIEW_DEFAULT_LIMIT}`,
      () =>
        previewModel(
          workspaceId,
          projectId,
          modelName,
          environment || undefined,
          defer,
        ),
      previewed => ({
        status: previewed?.ok ? ("success" as const) : ("error" as const),
        logs: previewed?.logs ?? [],
        stepResults: [],
      }),
    );
    setPreview(result);
    manualBusyRef.current = false;
    previewInFlightRef.current = false;
    setBusy(null);
  }, [
    workspaceId,
    projectId,
    modelName,
    environment,
    defer,
    previewModel,
    saveNow,
    recordInvocation,
  ]);

  useEffect(() => {
    previewRef.current = () => void handlePreview();
  }, [handlePreview]);

  // ⌘↵ previews from anywhere in the tab, not just with Monaco focused (the
  // panel, the command bar, a markdown preview). Monaco binds the same chord
  // to override its built-in "insert line below" and stops propagation there,
  // so this listener only sees the cases Monaco didn't handle.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      const container = containerRef.current;
      if (!container) return;
      // Console tabs stay mounted while hidden, so a document listener would
      // otherwise fire in every open dbt file. Only the visible tab responds.
      const tabHost = container.closest("[data-mako-tab-id]");
      if (tabHost && !tabHost.hasAttribute("data-mako-active-tab-content")) {
        return;
      }
      event.preventDefault();
      previewRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

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

  // On open / environment change: parse the project (populating Problems)
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
      const cmd = buildDbtNodeCommand(verb, modelName, scope, { fullRefresh });
      if (environment === "prod" && !(await confirmProdRun(`dbt ${cmd}`))) {
        return;
      }
      saveNow();
      manualBusyRef.current = true;
      setBusy("command");
      setPanelOpen(true);
      setPanelTab("commands");
      await recordInvocation(
        cmd,
        () =>
          runCommand(
            workspaceId,
            projectId,
            cmd,
            environment || undefined,
            defer,
          ),
        res => ({
          status: res?.ok ? ("success" as const) : ("error" as const),
          logs: res?.logs ?? [],
          stepResults: res?.stepResults ?? [],
        }),
      );
      manualBusyRef.current = false;
      setBusy(null);
    },
    [
      workspaceId,
      projectId,
      modelName,
      environment,
      defer,
      fullRefresh,
      runCommand,
      saveNow,
      recordInvocation,
      confirmProdRun,
    ],
  );

  const handleRunCommand = useCallback(async () => {
    if (!workspaceId || !command.trim()) return;
    if (environment === "prod" && !(await confirmProdRun(command))) {
      return;
    }
    saveNow();
    manualBusyRef.current = true;
    setBusy("command");
    setPanelOpen(true);
    setPanelTab("commands");
    // Accept a pasted "dbt build ..." — the API strips it too, but the rail
    // shouldn't read "dbt dbt build ...".
    const normalized = command.trim().replace(/^dbt\s+/i, "");
    await recordInvocation(
      normalized,
      () =>
        runCommand(
          workspaceId,
          projectId,
          normalized,
          environment || undefined,
          defer,
        ),
      res => ({
        status: res?.ok ? ("success" as const) : ("error" as const),
        logs: res?.logs ?? [],
        stepResults: res?.stepResults ?? [],
      }),
    );
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
    recordInvocation,
    confirmProdRun,
  ]);

  const errorCount = useMemo(
    () => problems?.filter(p => p.severity === "error").length ?? 0,
    [problems],
  );
  const warnCount = useMemo(
    () => problems?.filter(p => p.severity === "warn").length ?? 0,
    [problems],
  );

  // The Results grid speaks ResultsTable's QueryResult shape. `fields` carries
  // the warehouse column order so a preview's columns don't get alphabetised,
  // and empty-but-typed results still render their headers.
  const previewResults = useMemo(() => {
    if (!preview?.ok) return null;
    return {
      results: preview.rows,
      executedAt: new Date().toISOString(),
      resultCount: preview.rows.length,
      fields: preview.columns,
    };
  }, [preview]);

  // Preview rows are already in memory, so export needs no server round trip
  // (unlike the SQL console, which streams a full paginated result set).
  const handleDownloadPreview = useCallback(
    (format: "csv" | "ndjson") => {
      if (!preview?.ok) return;
      const content =
        format === "csv"
          ? rowsToCsv(preview.columns, preview.rows)
          : rowsToNdjson(preview.rows);
      downloadTextFile(
        previewFilename(preview.node ?? modelName ?? undefined, format),
        content,
        format,
      );
    },
    [preview, modelName],
  );

  // Status pill mirrors dbt Cloud: it reflects the live compile state of the
  // active model (previews/runs surface their outcome in Results/Commands).
  const status: { label: string; tone: "ok" | "error" | "busy" | "idle" } =
    busy === "compile"
      ? { label: "Compiling…", tone: "busy" }
      : busy === "preview"
        ? { label: "Previewing…", tone: "busy" }
        : busy === "command"
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
    if (fileLoadError) {
      return (
        <EntityLoadErrorState
          error={fileLoadError}
          entityLabel="file"
          onRetry={() => {
            if (workspaceId) void readFile(workspaceId, projectId, path);
          }}
        />
      );
    }
    return <EntityLoadingState label="Loading file…" />;
  }

  const editorPane = showMarkdownPreview ? (
    <Box sx={{ height: "100%", minHeight: 0, overflow: "auto" }}>
      <Box sx={{ maxWidth: 820, mx: "auto", px: 3, py: 3 }}>
        <StreamingMarkdown>{file.content}</StreamingMarkdown>
      </Box>
    </Box>
  ) : (
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
          ...EDITOR_OPTIONS.code,
          minimap: { enabled: true },
          wordWrap: isMarkdown ? "on" : "off",
        }}
      />
    </Box>
  );

  const markdownPreviewToggle = isMarkdown ? (
    <FormControlLabel
      control={
        <Switch
          size="small"
          checked={markdownPreview}
          onChange={e => setMarkdownPreview(e.target.checked)}
        />
      }
      label={
        <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
          Preview
        </Typography>
      }
      sx={{ mr: 0, ml: 0 }}
    />
  ) : null;

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
          <Tooltip title="Preview this model's rows (⌘↵) — read-only, nothing is materialized">
            <span>
              <IconButton
                size="small"
                aria-label="Preview this model"
                disabled={busy !== null}
                onClick={handlePreview}
              >
                <PreviewIcon size={16} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Compile this model's Jinja to SQL">
            <span>
              <IconButton
                size="small"
                aria-label="Compile this model"
                disabled={busy !== null}
                onClick={handleCompile}
              >
                <CompileIcon size={16} />
              </IconButton>
            </span>
          </Tooltip>
          {/* Split button: clicking builds the model, the caret opens the
              Build/Run/Test × graph-operator matrix. */}
          <Box sx={{ display: "flex", alignItems: "center" }}>
            <Tooltip title="Build this model (dbt build --select <model>)">
              <span>
                <IconButton
                  size="small"
                  aria-label="Build this model"
                  disabled={busy !== null}
                  onClick={() => void runNodeSelection("build", "")}
                  sx={{ pr: 0.25 }}
                >
                  <BuildIcon size={16} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Build / Run / Test this model (with upstream/downstream selectors)">
              <span>
                <IconButton
                  size="small"
                  aria-label="Build, run, or test this model"
                  disabled={busy !== null}
                  onClick={e => setRunMenuAnchor(e.currentTarget)}
                  sx={{ pl: 0.25 }}
                >
                  <CollapseIcon size={13} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
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
        <DbtCommandsPanel
          history={history}
          selectedId={selectedInvocationId}
          onSelect={setSelectedInvocationId}
        />
      )}

      {panelTab === "problems" && (
        <ProblemList
          problems={problems}
          projectId={projectId}
          busy={busy === "parse"}
          emptyOk="No problems — project parses cleanly."
        />
      )}

      {panelTab === "results" &&
        (busy === "preview" ? (
          <Box
            sx={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CircularProgress size={24} />
          </Box>
        ) : previewResults ? (
          <Box sx={{ height: "100%", minHeight: 0 }}>
            <Suspense
              fallback={
                <Box sx={{ p: 3, display: "flex", justifyContent: "center" }}>
                  <CircularProgress size={20} />
                </Box>
              }
            >
              <ResultsTable
                results={previewResults}
                hideChartView
                onDownload={handleDownloadPreview}
              />
            </Suspense>
          </Box>
        ) : preview && !preview.ok ? (
          // Failed preview: the reason is in the logs, so point at the tab
          // that has them rather than showing an empty grid.
          <ResultsEmptyState message="Preview failed — see the Commands tab for the error." />
        ) : (
          <ResultsEmptyState
            message={
              modelName
                ? "Press the Preview button above (⌘↵)."
                : "Open a .sql model to preview its rows."
            }
          />
        ))}

      {panelTab === "compiled" &&
        (compileResult?.compiledSql ? (
          <MonacoEditor
            height="100%"
            language="sql"
            value={compileResult.compiledSql}
            theme={monacoTheme}
            options={{ ...EDITOR_OPTIONS.readOnly, wordWrap: "off" }}
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

      {/* Full refresh / defer / environment */}
      <Tooltip title="Rebuild incremental models from scratch (dbt --full-refresh) — applies to the Build/Run menu">
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={fullRefresh}
              onChange={e => setFullRefresh(e.target.checked)}
              sx={{ p: 0.25 }}
            />
          }
          label={
            <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
              Full refresh
            </Typography>
          }
          sx={{ mr: 0, ml: 0.5 }}
        />
      </Tooltip>
      <Tooltip
        title={
          `Resolve unselected refs against the last "${prodEnvName}" build ` +
          "(dbt --defer). Change the defer target in Project settings."
        }
      >
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
              Defer to {prodEnvName}
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
        onChange={e => handleEnvironmentChange(e.target.value)}
        sx={{ fontSize: "0.72rem", textTransform: "uppercase" }}
      >
        {visibleDbtEnvironments(project?.environments, user?.id).map(env => (
          <MenuItem key={env.name} value={env.name}>
            {env.ownerUserId ? `${env.name} (personal)` : env.name}
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
    <Box
      ref={containerRef}
      sx={{ height: "100%", display: "flex", flexDirection: "column" }}
    >
      {/* Breadcrumb (workspace › Transforms › project › path). Compile is live
          and runs go through the toolbar or the command bar, mirroring dbt
          Cloud. */}
      <EntityBreadcrumbs tabId={tabId} trailing={markdownPreviewToggle} />

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
