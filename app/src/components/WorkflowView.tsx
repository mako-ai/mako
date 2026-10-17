/**
 * The `workflow` tab. For a workflow: its runs and the selected run, laid out
 * like the Transforms run history. For a file under `workflows/`: the file,
 * read-only. Polls while on screen, faster while a run is active.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import MonacoEditor from "@monaco-editor/react";
import { Play as RunIcon, Webhook as WebhookIcon } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import {
  fetchWorkflowFile,
  isActiveRun,
  useWorkflowsStore,
  type WorkflowRunSummary,
} from "../store/workflowsStore";
import { formatDuration } from "../utils/format";
import { formatRelativeTimeCompact } from "../utils/relative-time";

/** A toolbar or header: a padded row closed by a divider. */
const BAR_SX = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 1.5,
  px: 1.5,
  py: 0.75,
  borderBottom: "1px solid",
  borderColor: "divider",
} as const;

const Dim = ({ children }: { children: ReactNode }) => (
  <Typography variant="caption" color="text.secondary">
    {children}
  </Typography>
);

const ACTIVE_POLL_INTERVAL_MS = 3_000;
const IDLE_POLL_INTERVAL_MS = 8_000;

const STATUS: Record<string, { label: string; color: string }> = {
  COMPLETED: { label: "Success", color: "success.main" },
  FAILED: { label: "Failed", color: "error.main" },
  RUNNING: { label: "Running", color: "primary.main" },
  QUEUED: { label: "Queued", color: "primary.main" },
  CANCELLED: { label: "Cancelled", color: "warning.main" },
};
const statusOf = (status?: string) =>
  STATUS[status ?? ""] ?? {
    label: (status ?? "unknown").toLowerCase(),
    color: "text.secondary",
  };

const short = (sha: string | null | undefined) => (sha ?? "").slice(0, 7);

export const SMALL_CHIP_SX = {
  height: 16,
  fontSize: "0.62rem",
  flexShrink: 0,
  "& .MuiChip-label": { px: 0.5 },
} as const;

function Note({ children }: { children: string }) {
  return (
    <Box sx={{ p: 2 }}>
      <Dim>{children}</Dim>
    </Box>
  );
}

function FileView({
  workspaceId,
  path,
}: {
  workspaceId: string;
  path: string;
}) {
  const monacoTheme = useMonacoTheme();
  const [contents, setContents] = useState<string | null | undefined>();

  useEffect(() => {
    let current = true;
    setContents(undefined);
    void fetchWorkflowFile(workspaceId, path).then(text => {
      if (current) setContents(text);
    });
    return () => {
      current = false;
    };
  }, [workspaceId, path]);

  if (contents === undefined) {
    return (
      <Box sx={{ p: 2 }}>
        <CircularProgress size={18} />
      </Box>
    );
  }
  if (contents === null) {
    return <Note>This file is not on the branch you are on.</Note>;
  }
  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={BAR_SX}>
        <Dim>
          Read-only. Change it with the Mako agent or in the repository.
        </Dim>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <MonacoEditor
          height="100%"
          path={`workflows/${path}`}
          language={path.endsWith(".ts") ? "typescript" : undefined}
          value={contents}
          theme={monacoTheme}
          options={{ ...EDITOR_OPTIONS.readOnly, wordWrap: "off" }}
        />
      </Box>
    </Box>
  );
}

function RunDialog({
  workflowId,
  deployed,
  initialInput,
  onClose,
  onRun,
}: {
  workflowId: string;
  /** The workflow is on main; otherwise only the sandbox can run it. */
  deployed: boolean;
  initialInput: string;
  onClose: () => void;
  onRun: (
    input: Record<string, unknown>,
    sandbox: boolean,
  ) => Promise<string | null>;
}) {
  // A run, on main or in the sandbox, answers its runId at once and is
  // followed in the list. Mounted only while open, so the initial state is the dialog's state.
  const [target, setTarget] = useState<"main" | "sandbox">(
    deployed ? "main" : "sandbox",
  );
  const [input, setInput] = useState(initialInput);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input || "{}");
    } catch {
      setError("The input is not valid JSON.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("The input must be a JSON object.");
      return;
    }
    setBusy(true);
    const failure = await onRun(
      parsed as Record<string, unknown>,
      target === "sandbox",
    );
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Run {workflowId}</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 0.5 }}
      >
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          color="primary"
          value={target}
          onChange={(_event, value) => value && setTarget(value)}
          aria-label="What to run"
        >
          <Tooltip title="The deployed code on main">
            <ToggleButton
              value="main"
              disabled={!deployed}
              sx={{ textTransform: "none" }}
            >
              Main
            </ToggleButton>
          </Tooltip>
          <Tooltip title="Your checkout as it is now, uncommitted edits included. No schedule.">
            <ToggleButton value="sandbox" sx={{ textTransform: "none" }}>
              Sandbox
            </ToggleButton>
          </Tooltip>
        </ToggleButtonGroup>
        <TextField
          label="Input (JSON)"
          multiline
          minRows={5}
          value={input}
          onChange={e => setInput(e.target.value)}
          error={Boolean(error)}
          helperText={error ?? "Filled in from the last run."}
          sx={{
            mt: 1,
            "& textarea": { fontFamily: "monospace", fontSize: 13 },
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={submit}
          disabled={busy}
          startIcon={busy ? <CircularProgress size={12} /> : undefined}
        >
          Run
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RunsView({
  workspaceId,
  workflowId,
}: {
  workspaceId: string;
  workflowId: string;
}) {
  const overview = useWorkflowsStore(s => s.overviewByWorkspace[workspaceId]);
  const fetchOverview = useWorkflowsStore(s => s.fetchOverview);
  const fetchRun = useWorkflowsStore(s => s.fetchRun);
  const startRun = useWorkflowsStore(s => s.run);
  const setTriggers = useWorkflowsStore(s => s.setTriggers);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listedRun = useWorkflowsStore(s =>
    selectedRunId ? s.runsById[selectedRunId] : undefined,
  );
  const selectedRun = listedRun;

  const runs = useMemo(
    () =>
      (overview?.recentRuns ?? []).filter(
        (run): run is WorkflowRunSummary & { runId: string } =>
          run.workflowId === workflowId && Boolean(run.runId),
      ),
    [overview?.recentRuns, workflowId],
  );
  const selectedSummary: WorkflowRunSummary | undefined = runs.find(
    run => run.runId === selectedRunId,
  );
  const selectedStatus = selectedRun?.status ?? selectedSummary?.status;
  const hasActive = runs.some(run => isActiveRun(run.status));

  // Poll the list, and the selected run while it is still going: the first
  // tick after a selection loads that run whatever its state.
  useEffect(() => {
    let first = true;
    const tick = () => {
      void fetchOverview(workspaceId);
      if (selectedRunId && (first || isActiveRun(selectedStatus))) {
        void fetchRun(workspaceId, selectedRunId);
      }
      first = false;
    };
    tick();
    const timer = setInterval(
      tick,
      hasActive ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [
    workspaceId,
    selectedRunId,
    selectedStatus,
    hasActive,
    fetchOverview,
    fetchRun,
  ]);

  const select = (runId: string) => {
    setSelectedRunId(runId);
  };

  // Land on the newest run.
  useEffect(() => {
    if (!selectedRunId && runs.length > 0) setSelectedRunId(runs[0].runId);
  }, [selectedRunId, runs]);

  const schedule = overview?.schedules?.find(s => s.workflowId === workflowId);
  const workflow = overview?.workflows?.find(w => w.workflowId === workflowId);
  const active = Boolean(workflow?.active);
  const webhookUrl = workflow?.webhookUrl;
  const deployment = overview?.deployment;

  // The Active switch or the webhook: the next poll shows the result, and a
  // refusal is shown in the bar.
  const change = async (triggers: { active?: boolean; webhook?: boolean }) => {
    const result = await setTriggers(workspaceId, workflowId, triggers);
    setError(result.ok ? null : (result.error ?? "Failed"));
    void fetchOverview(workspaceId);
  };

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={BAR_SX}>
        <Button
          size="small"
          variant="contained"
          startIcon={<RunIcon size={14} />}
          onClick={() => setDialogOpen(true)}
          sx={{ textTransform: "none" }}
        >
          Run
        </Button>
        {workflow &&
          (overview?.mayChange ? (
            <Tooltip
              title={
                active
                  ? "On: the schedule and webhook start runs."
                  : "Off: it runs only when you press Run."
              }
            >
              <FormControlLabel
                sx={{ mr: 0, "& .MuiFormControlLabel-label": { fontSize: 13 } }}
                label={active ? "Active" : "Inactive"}
                control={
                  <Switch
                    size="small"
                    checked={active}
                    onChange={(_e, on) => void change({ active: on })}
                  />
                }
              />
            </Tooltip>
          ) : (
            <Chip
              label={active ? "Active" : "Inactive"}
              size="small"
              variant="outlined"
              color={active ? "success" : "default"}
              sx={{ height: 20 }}
            />
          ))}
        <Dim>
          {schedule
            ? `Schedule: ${schedule.cron} (UTC)`
            : workflow
              ? "No schedule"
              : "Not on main yet"}
        </Dim>
        {error && (
          <Typography variant="caption" color="error.main">
            {error}
          </Typography>
        )}
        {webhookUrl === null && (
          <Chip
            icon={<WebhookIcon size={12} />}
            label="Add webhook"
            size="small"
            variant="outlined"
            onClick={() => void change({ webhook: true })}
            sx={{ height: 20, borderStyle: "dashed" }}
          />
        )}
        {webhookUrl && (
          <Tooltip title="POST JSON to this URL to start a run while the workflow is active. With ?sandbox=<your user id> it runs your sandbox's version instead, any time. Click to copy it; ✕ removes it.">
            <Chip
              icon={<WebhookIcon size={12} />}
              label={copied ? "Copied" : "Webhook"}
              size="small"
              variant="outlined"
              color="primary"
              onClick={() => {
                void navigator.clipboard.writeText(webhookUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              onDelete={() => void change({ webhook: false })}
              sx={{ height: 20 }}
            />
          </Tooltip>
        )}
        <Box sx={{ ml: "auto", display: "flex", gap: 1, flexWrap: "wrap" }}>
          {deployment?.liveSha && (
            <Tooltip title="The commit the worker runs">
              <Chip
                label={short(deployment.liveSha)}
                size="small"
                variant="outlined"
                sx={{ height: 20, fontFamily: "monospace" }}
              />
            </Tooltip>
          )}
          {deployment?.buildError && (
            <Chip
              label={`build failed · ${short(deployment.targetSha)}`}
              size="small"
              variant="outlined"
              color="error"
              sx={{ height: 20 }}
            />
          )}
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box
          sx={{
            width: 280,
            flexShrink: 0,
            overflow: "auto",
            borderRight: "1px solid",
            borderColor: "divider",
          }}
        >
          {runs.length === 0 ? (
            <Note>No runs yet.</Note>
          ) : (
            runs.map(run => {
              const status = statusOf(run.status);
              return (
                <Box
                  key={run.runId}
                  role="button"
                  tabIndex={0}
                  onClick={() => select(run.runId)}
                  onKeyDown={e => e.key === "Enter" && select(run.runId)}
                  sx={{
                    px: 1.5,
                    py: 0.75,
                    cursor: "pointer",
                    borderBottom: "1px solid",
                    borderColor: "divider",
                    backgroundColor:
                      run.runId === selectedRunId
                        ? "action.selected"
                        : "transparent",
                    "&:hover": { backgroundColor: "action.hover" },
                  }}
                >
                  <Box
                    sx={{ display: "flex", alignItems: "center", gap: 0.75 }}
                  >
                    <Box
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        backgroundColor: status.color,
                        flexShrink: 0,
                      }}
                    />
                    <Typography
                      variant="caption"
                      sx={{
                        flex: 1,
                        fontWeight: 600,
                        color: status.color,
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                      }}
                    >
                      {status.label}
                      {isActiveRun(run.status) && <CircularProgress size={9} />}
                    </Typography>
                    {run.durationMs !== undefined && (
                      <Dim>{formatDuration(run.durationMs)}</Dim>
                    )}
                  </Box>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.5,
                      mt: 0.25,
                    }}
                  >
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ flex: 1 }}
                    >
                      {formatRelativeTimeCompact(run.startedAt)}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontSize: "0.65rem" }}
                    >
                      {run.trigger ?? "schedule"}
                    </Typography>
                  </Box>
                </Box>
              );
            })
          )}
        </Box>

        {!selectedSummary ? (
          <Note>
            {runs.length === 0
              ? "Start a run, or wait for the schedule."
              : "Select a run to see details."}
          </Note>
        ) : (
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Box sx={{ ...BAR_SX, gap: 2 }}>
              <Chip
                size="small"
                variant="outlined"
                icon={
                  isActiveRun(selectedStatus) ? (
                    <CircularProgress size={10} />
                  ) : undefined
                }
                label={statusOf(selectedStatus).label}
                sx={{
                  height: 20,
                  fontWeight: 600,
                  color: statusOf(selectedStatus).color,
                  borderColor: statusOf(selectedStatus).color,
                }}
              />
              {selectedSummary.sandbox && (
                <Chip
                  label="sandbox"
                  size="small"
                  variant="outlined"
                  color="info"
                  sx={{ height: 20 }}
                />
              )}
              <Dim>{formatRelativeTimeCompact(selectedSummary.startedAt)}</Dim>
              <Dim>
                {formatDuration(
                  selectedRun?.durationMs ?? selectedSummary.durationMs,
                )}
              </Dim>
              <Dim>{selectedSummary.trigger ?? "schedule"}</Dim>
            </Box>

            <Box
              sx={{
                borderBottom: "1px solid",
                borderColor: "divider",
                overflowX: "auto",
              }}
            >
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
                    verticalAlign: "top",
                  },
                  "& td:first-of-type, & th:first-of-type": { pl: 1.5 },
                  "& th": { fontWeight: 600, color: "text.secondary" },
                  "& tr:last-of-type td": { borderBottom: 0 },
                }}
              >
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Status</th>
                    <th>Attempt</th>
                    <th>Time</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedRun?.steps ?? []).map(step => (
                    <Box
                      component="tr"
                      key={step.step}
                      sx={{
                        color:
                          step.status === "FAILED"
                            ? "error.main"
                            : isActiveRun(step.status)
                              ? "primary.main"
                              : "inherit",
                      }}
                    >
                      <td>{step.step}</td>
                      <td>
                        {(step.status ?? "").toLowerCase()}
                        {step.error ? ` — ${step.error.split("\n")[0]}` : ""}
                      </td>
                      <td>{step.attempt ?? ""}</td>
                      <td>{formatDuration(step.durationMs)}</td>
                      <Box
                        component="td"
                        sx={{
                          fontFamily: "monospace",
                          wordBreak: "break-word",
                        }}
                      >
                        {step.output === "{}" ? "" : step.output}
                      </Box>
                    </Box>
                  ))}
                </tbody>
              </Box>
            </Box>

            {/* Logs, and the full error of a failed step */}
            <Box
              sx={{
                flex: 1,
                minHeight: 0,
                overflow: "auto",
                fontFamily: "monospace",
                fontSize: "0.72rem",
                p: 1,
                whiteSpace: "pre-wrap",
              }}
            >
              {!selectedRun ? (
                <CircularProgress size={14} />
              ) : selectedRun.steps.every(
                  step => step.logs.length === 0 && !step.error,
                ) ? (
                <Dim>
                  {selectedStatus === "QUEUED" ? "Run queued…" : "No logs."}
                </Dim>
              ) : (
                selectedRun.steps.flatMap(step =>
                  [...step.logs, step.error].map(
                    (line, index) =>
                      line && (
                        <Box
                          key={`${step.step}-${index}`}
                          sx={
                            index === step.logs.length
                              ? { color: "error.main" }
                              : undefined
                          }
                        >
                          <Box
                            component="span"
                            sx={{ color: "text.secondary", mr: 1 }}
                          >
                            {step.step}
                          </Box>
                          {line}
                        </Box>
                      ),
                  ),
                )
              )}
            </Box>
          </Box>
        )}
      </Box>

      {dialogOpen && (
        <RunDialog
          workflowId={workflowId}
          deployed={Boolean(workflow)}
          initialInput={formatInput(selectedRun?.input)}
          onClose={() => setDialogOpen(false)}
          onRun={async (input, sandbox) => {
            const result = await startRun(
              workspaceId,
              workflowId,
              input,
              sandbox,
            );
            if (!result.ok) return result.error ?? "Failed to start the run";
            await fetchOverview(workspaceId);
            if (result.runId) select(result.runId);
            return null;
          }}
        />
      )}
    </Box>
  );
}

/** The last run's input, pretty-printed, as the starting point for a new run. */
function formatInput(input: string | undefined): string {
  try {
    return JSON.stringify(JSON.parse(input ?? "{}"), null, 2);
  } catch {
    return "{}";
  }
}

export default function WorkflowView({
  workflowId,
  path,
}: {
  workflowId?: string;
  path?: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  if (!workspaceId) return null;
  if (path) return <FileView workspaceId={workspaceId} path={path} />;
  if (workflowId) {
    return <RunsView workspaceId={workspaceId} workflowId={workflowId} />;
  }
  return null;
}
