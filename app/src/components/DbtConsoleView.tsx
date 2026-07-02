/**
 * DbtConsoleView — per-project command bar + Problems panel (dbt Cloud
 * parity). Hosts:
 *   - a free-form dbt command input (validated server-side against the same
 *     allowlist as stored jobs) with an environment + "defer to prod" toggle;
 *   - a Problems tab that runs `dbt parse` and surfaces compile/parse
 *     diagnostics, each clickable to open the offending file;
 *   - Results + Logs tabs for the most recent command.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Select,
  Tab,
  Tabs,
  TextField,
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
  type DbtCommandRunResult,
  type DbtRunLogLine,
} from "../store/dbtStore";
import { focusDbtFileTab } from "../dbt-runtime/shell";

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
          No output yet — run a command.
        </Typography>
      ) : (
        logs.map((log, index) => (
          <Box
            key={index}
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

export default function DbtConsoleView({ projectId }: { projectId: string }) {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;

  const project = useDbtStore(s => s.projects.find(p => p._id === projectId));
  const fetchProjects = useDbtStore(s => s.fetchProjects);
  const compileModel = useDbtStore(s => s.compileModel);
  const runCommand = useDbtStore(s => s.runCommand);

  const [view, setView] = useState<"console" | "lineage">("console");
  const [environment, setEnvironment] = useState("");
  const [defer, setDefer] = useState(false);
  const [command, setCommand] = useState("");
  const [tab, setTab] = useState<"problems" | "results" | "logs">("problems");
  const [busy, setBusy] = useState<"command" | "parse" | null>(null);
  const [result, setResult] = useState<DbtCommandRunResult | null>(null);
  const [problems, setProblems] = useState<Problem[] | null>(null);

  useEffect(() => {
    if (!project && workspaceId) void fetchProjects(workspaceId);
  }, [project, workspaceId, fetchProjects]);

  // Default to the user's PERSONAL environment when provisioned (safe fast
  // iteration in their own schema), else the project default.
  useEffect(() => {
    if (project && !environment) {
      const personal = project.environments?.find(
        env => env.ownerUserId && env.ownerUserId === user?.id,
      );
      setEnvironment(personal?.name ?? project.defaultEnvironment);
    }
  }, [project, environment, user?.id]);

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
    setTab("logs");
    const res = await runCommand(
      workspaceId,
      projectId,
      command.trim(),
      environment || undefined,
      defer,
    );
    setResult(res);
    if (res && res.stepResults.length > 0) setTab("results");
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
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading project…</Typography>
      </Box>
    );
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
              onChange={e => setEnvironment(e.target.value)}
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
                  Defer to prod
                </Typography>
              }
              sx={{ mr: 0 }}
            />
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
                label="Results"
                value="results"
                sx={{ minHeight: 32, py: 0 }}
              />
              <Tab label="Logs" value="logs" sx={{ minHeight: 32, py: 0 }} />
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

            {tab === "results" && (
              <Box sx={{ p: 1 }}>
                {!result || result.stepResults.length === 0 ? (
                  <Typography variant="caption" color="text.secondary">
                    {busy === "command"
                      ? "Running…"
                      : "Run a build/run/test command to see node results."}
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
                      {result.stepResults.map(step => (
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
                )}
              </Box>
            )}

            {tab === "logs" && <LogLines logs={result?.logs ?? []} />}
          </Box>

          {result && tab !== "logs" && (
            <Box
              sx={{
                px: 1.5,
                py: 0.5,
                borderTop: "1px solid",
                borderColor: "divider",
              }}
            >
              <Chip
                size="small"
                label={
                  result.ok ? "Last command: success" : "Last command: failed"
                }
                color={result.ok ? "success" : "error"}
                variant="outlined"
              />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
