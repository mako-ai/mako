/**
 * DbtConsoleView — per-project command bar + Problems panel (dbt Cloud
 * parity). Hosts:
 *   - a free-form dbt command input (validated server-side against the same
 *     allowlist as stored jobs) with an environment + "defer to prod" toggle;
 *   - a Problems tab that runs `dbt parse` and surfaces compile/parse
 *     diagnostics, each clickable to open the offending file;
 *   - a Commands tab sharing DbtCommandsPanel with the file editor, so a
 *     command's status, logs and node results read the same in both places.
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
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Select,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  AlertTriangle as WarnIcon,
  CircleX as ErrorIcon,
  Play as RunIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import {
  useDbtStore,
  visibleDbtEnvironments,
  type DbtRunLogLine,
} from "../store/dbtStore";
import { focusDbtFileTab } from "../dbt-runtime/shell";
import { resolveDevEnvName, resolveProdLikeEnvName } from "../lib/dbt-env";
import {
  appendInvocation,
  settleInvocation,
  type DbtCommandInvocation,
} from "../lib/dbt-command-history";
import DbtCommandsPanel from "./DbtCommandsPanel";
import EntityLoadErrorState, {
  EntityLoadingState,
} from "./EntityLoadErrorState";
import { missingEntityError } from "../lib/entity-labels";

const DbtLineageView = lazy(() => import("./DbtLineageView"));

interface Problem {
  severity: "error" | "warn";
  message: string;
  filePath?: string;
}

// dbt error messages frequently embed the offending file path, e.g.
//   "Compilation Error in model stg_orders (models/staging/stg_orders.sql)"
//   "Parsing Error ... path: models/schema.yml"
const FILE_IN_PARENS = /\(([^()]+\.(?:sql|yml|yaml))\)/i;
const FILE_AFTER_PATH = /\bpath:\s*([^\s,)]+\.(?:sql|yml|yaml))/i;

function extractFilePath(message: string): string | undefined {
  const m = message.match(FILE_IN_PARENS) ?? message.match(FILE_AFTER_PATH);
  return m?.[1];
}

/** Pull error/warn diagnostics out of a parse run's JSON log stream. */
function logsToProblems(logs: DbtRunLogLine[]): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    const severity =
      log.level === "error" ? "error" : log.level === "warn" ? "warn" : null;
    if (!severity) continue;
    const message = log.line.trim();
    if (!message || seen.has(message)) continue;
    seen.add(message);
    problems.push({ severity, message, filePath: extractFilePath(message) });
  }
  return problems;
}

export default function DbtConsoleView({ projectId }: { projectId: string }) {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;

  const project = useDbtStore(s => s.projects.find(p => p._id === projectId));
  const projectsLoaded = useDbtStore(s => s.projectsLoaded);
  const projectsLoadError = useDbtStore(s => s.loadErrors.projects);
  const fetchProjects = useDbtStore(s => s.fetchProjects);
  const compileModel = useDbtStore(s => s.compileModel);
  const runCommand = useDbtStore(s => s.runCommand);
  const setMyEnvironment = useDbtStore(s => s.setMyEnvironment);

  const [view, setView] = useState<"console" | "lineage">("console");
  const [environment, setEnvironment] = useState("");
  const [defer, setDefer] = useState(false);
  const [command, setCommand] = useState("");
  const [tab, setTab] = useState<"problems" | "commands">("problems");
  const [busy, setBusy] = useState<"command" | "parse" | null>(null);
  const [problems, setProblems] = useState<Problem[] | null>(null);
  // Same session-scoped rail as the file editor's Commands tab, so a command
  // run here and one run there are presented identically.
  const [history, setHistory] = useState<DbtCommandInvocation[]>([]);
  const [selectedInvocationId, setSelectedInvocationId] = useState<
    string | null
  >(null);
  const invocationSeq = useRef(0);

  useEffect(() => {
    if (!project && workspaceId) void fetchProjects(workspaceId);
  }, [project, workspaceId, fetchProjects]);

  // Default to the user's saved dev environment (per-user setting), else
  // their personal environment, else the project default.
  useEffect(() => {
    if (project && !environment) {
      setEnvironment(
        resolveDevEnvName(project, user?.id) ?? project.defaultEnvironment,
      );
    }
  }, [project, environment, user?.id]);

  // Picking an environment is a per-user setting shared with the editor and
  // agent builds — persist it.
  const handleEnvironmentChange = useCallback(
    (name: string) => {
      setEnvironment(name);
      if (workspaceId) void setMyEnvironment(workspaceId, projectId, name);
    },
    [workspaceId, projectId, setMyEnvironment],
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

  // Parse once on open (and whenever the environment changes) so the Problems
  // tab is populated without an explicit click.
  useEffect(() => {
    if (workspaceId && environment) void runParse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, environment]);

  const handleRunCommand = useCallback(async () => {
    if (!workspaceId || !command.trim()) return;
    if (
      environment === "prod" &&
      !window.confirm(`Run "${command}" against the prod environment?`)
    ) {
      return;
    }
    setBusy("command");
    setTab("commands");
    // Accept a pasted "dbt build ..." — the API strips it too, but the rail
    // shouldn't read "dbt dbt build ...".
    const normalized = command.trim().replace(/^dbt\s+/i, "");
    const id = `inv-${(invocationSeq.current += 1)}`;
    const startedAt = Date.now();
    setHistory(entries =>
      appendInvocation(entries, {
        id,
        command: normalized,
        environment: environment || "—",
        startedAt,
        status: "running",
        logs: [],
        stepResults: [],
      }),
    );
    setSelectedInvocationId(id);
    const res = await runCommand(
      workspaceId,
      projectId,
      normalized,
      environment || undefined,
      defer,
    );
    setHistory(entries =>
      settleInvocation(entries, id, {
        durationMs: Date.now() - startedAt,
        status: res?.ok ? "success" : "error",
        logs: res?.logs ?? [],
        stepResults: res?.stepResults ?? [],
      }),
    );
    setBusy(null);
  }, [workspaceId, projectId, command, environment, defer, runCommand]);

  const errorCount = useMemo(
    () => problems?.filter(p => p.severity === "error").length ?? 0,
    [problems],
  );
  const warnCount = useMemo(
    () => problems?.filter(p => p.severity === "warn").length ?? 0,
    [problems],
  );

  if (!project) {
    if (projectsLoadError) {
      return (
        <EntityLoadErrorState
          error={projectsLoadError}
          entityLabel="project"
          onRetry={() => {
            if (workspaceId) void fetchProjects(workspaceId);
          }}
        />
      );
    }
    // The workspace's project list loaded but this project isn't in it.
    if (projectsLoaded) {
      return (
        <EntityLoadErrorState
          error={missingEntityError("project")}
          entityLabel="project"
        />
      );
    }
    return <EntityLoadingState label="Loading project…" />;
  }

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Tabs
        value={view}
        onChange={(_e, value) => setView(value)}
        sx={{
          minHeight: 32,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Tab label="Console" value="console" sx={{ minHeight: 32, py: 0 }} />
        <Tab label="Lineage" value="lineage" sx={{ minHeight: 32, py: 0 }} />
      </Tabs>

      {view === "lineage" ? (
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <Suspense
            fallback={
              <Box sx={{ p: 3, display: "flex", justifyContent: "center" }}>
                <CircularProgress size={20} />
              </Box>
            }
          >
            <DbtLineageView projectId={projectId} />
          </Suspense>
        </Box>
      ) : (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Command bar */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 1.5,
              py: 1,
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <Select
              size="small"
              value={environment}
              onChange={e => handleEnvironmentChange(e.target.value)}
              sx={{ fontSize: "0.8rem", minWidth: 90 }}
            >
              {visibleDbtEnvironments(project.environments, user?.id).map(
                env => (
                  <MenuItem key={env.name} value={env.name}>
                    {env.ownerUserId ? `${env.name} (personal)` : env.name}
                  </MenuItem>
                ),
              )}
            </Select>
            <TextField
              size="small"
              fullWidth
              placeholder="dbt build --select stg_orders+"
              value={command}
              onChange={e => setCommand(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") void handleRunCommand();
              }}
              InputProps={{
                sx: { fontFamily: "monospace", fontSize: "0.8rem" },
              }}
            />
            <Tooltip
              title={
                `Resolve unselected refs against the last ` +
                `"${resolveProdLikeEnvName(project) ?? "prod"}" build ` +
                "(dbt --defer). Change the defer target in Project settings."
              }
            >
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
                    Defer to {resolveProdLikeEnvName(project) ?? "prod"}
                  </Typography>
                }
                sx={{ mr: 0 }}
              />
            </Tooltip>
            <Button
              size="small"
              variant="contained"
              disabled={busy !== null || !command.trim()}
              startIcon={
                busy === "command" ? (
                  <CircularProgress size={12} color="inherit" />
                ) : (
                  <RunIcon size={14} />
                )
              }
              onClick={handleRunCommand}
            >
              Run
            </Button>
          </Box>

          {/* Output tabs */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <Tabs
              value={tab}
              onChange={(_e, value) => setTab(value)}
              sx={{ minHeight: 32, flex: 1 }}
            >
              <Tab
                label={`Problems${problems ? ` (${errorCount + warnCount})` : ""}`}
                value="problems"
                sx={{ minHeight: 32, py: 0 }}
              />
              <Tab
                label="Commands"
                value="commands"
                sx={{ minHeight: 32, py: 0 }}
              />
            </Tabs>
            {tab === "problems" && (
              <Button
                size="small"
                disabled={busy !== null}
                onClick={runParse}
                sx={{ mr: 1 }}
              >
                {busy === "parse" ? "Parsing…" : "Re-parse"}
              </Button>
            )}
          </Box>

          <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {tab === "problems" && (
              <Box>
                {problems === null || busy === "parse" ? (
                  <Box sx={{ p: 2 }}>
                    <Typography variant="caption" color="text.secondary">
                      {busy === "parse"
                        ? "Parsing project…"
                        : "Press Re-parse."}
                    </Typography>
                  </Box>
                ) : problems.length === 0 ? (
                  <Box sx={{ p: 2 }}>
                    <Typography variant="caption" color="success.main">
                      No problems — project parses cleanly.
                    </Typography>
                  </Box>
                ) : (
                  problems.map((problem, index) => (
                    <Box
                      key={index}
                      onClick={() => {
                        if (problem.filePath) {
                          focusDbtFileTab(projectId, problem.filePath);
                        }
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
                  ))
                )}
              </Box>
            )}

            {tab === "commands" && (
              <DbtCommandsPanel
                history={history}
                selectedId={selectedInvocationId}
                onSelect={setSelectedInvocationId}
              />
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
