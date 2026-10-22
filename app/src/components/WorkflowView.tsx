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
  ListItemText,
  Menu,
  MenuItem,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import MonacoEditor from "@monaco-editor/react";
import {
  ArrowLeft as BackIcon,
  ChevronDown as ChevronIcon,
  Clock as ScheduleIcon,
  Play as RunIcon,
  RotateCcw as RetryIcon,
  Sparkles as AskIcon,
  Webhook as WebhookIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import {
  fetchWorkflowFile,
  fetchWorkflowFlow,
  isActiveRun,
  useWorkflowsStore,
  type WorkflowFlow,
  type WorkflowRun,
  type WorkflowRunSummary,
} from "../store/workflowsStore";
import { useUIStore } from "../store/uiStore";
import { formatDuration } from "../utils/format";
import { formatRelativeTimeCompact } from "../utils/relative-time";
import { describeCron, inTime, nextRunOf } from "../lib/cronText";
import WorkflowRunDetail from "./WorkflowRunDetail";
import FlowPanel from "./WorkflowRunFlow";
import StatusDot from "./WorkflowStatusDot";

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
  // followed in the panel. Mounted only while open, so the initial state is the dialog's state.
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
  const retry = useWorkflowsStore(s => s.retry);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // The last sandbox run: shown in place of a selected run until one is
  // picked. It is in no list (it ran in the viewer's own sandbox).
  const [sandboxRunId, setSandboxRunId] = useState<string | null>(null);
  const readSandboxRun = useWorkflowsStore(s =>
    sandboxRunId ? s.runsById[sandboxRunId] : undefined,
  );
  const sandboxRun: WorkflowRun | null = sandboxRunId
    ? (readSandboxRun ?? {
        runId: sandboxRunId,
        workflowId,
        sandbox: true,
        status: "RUNNING",
        steps: [],
      })
    : null;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listedRun = useWorkflowsStore(s =>
    selectedRunId ? s.runsById[selectedRunId] : undefined,
  );
  const selectedRun = sandboxRun ?? listedRun;

  const runs = useMemo(
    () =>
      (overview?.recentRuns ?? []).filter(
        (run): run is WorkflowRunSummary & { runId: string } =>
          run.workflowId === workflowId && Boolean(run.runId),
      ),
    [overview?.recentRuns, workflowId],
  );
  const selectedSummary: WorkflowRunSummary | undefined =
    sandboxRun ?? runs.find(run => run.runId === selectedRunId);
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

  // Follow the sandbox run until it ends.
  const sandboxStatus = sandboxRun?.status;
  useEffect(() => {
    if (!sandboxRunId || !isActiveRun(sandboxStatus)) return;
    const timer = setInterval(
      () => void fetchRun(workspaceId, sandboxRunId),
      ACTIVE_POLL_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [workspaceId, sandboxRunId, sandboxStatus, fetchRun]);

  const select = (runId: string) => {
    setSandboxRunId(null);
    setSelectedRunId(runId);
  };

  const [homeTab, setHomeTab] = useState<"runs" | "flow">("runs");

  // Back to the workflow's runs.
  const showRuns = () => {
    setSandboxRunId(null);
    setSelectedRunId(null);
  };

  const schedules = (overview?.schedules ?? []).filter(
    s => s.workflowId === workflowId,
  );
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
        {error && (
          <Typography variant="caption" color="error.main">
            {error}
          </Typography>
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

      {selectedSummary && (
        <Box sx={{ ...BAR_SX, gap: 2 }}>
          <Button
            size="small"
            startIcon={<BackIcon size={14} />}
            onClick={showRuns}
            sx={{ textTransform: "none", height: 24 }}
          >
            All runs
          </Button>
          <RunPicker
            runs={runs}
            selected={selectedSummary}
            status={selectedStatus}
            onSelect={select}
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
          {/* A retried run's time spans the retry: say so instead. */}
          <Dim>
            {selectedRun?.steps.some(step => (step.attempt ?? 1) > 1)
              ? "retried"
              : formatDuration(
                  selectedRun?.durationMs ?? selectedSummary.durationMs,
                )}
          </Dim>
          {(selectedStatus === "FAILED" || selectedStatus === "CANCELLED") && (
            <Box sx={{ ml: "auto", display: "flex", gap: 1 }}>
              <RetryMenu
                run={selectedRun}
                sandbox={Boolean(selectedSummary.sandbox)}
                onRetry={async step => {
                  if (!selectedSummary.runId) return;
                  const result = await retry(
                    workspaceId,
                    selectedSummary.runId,
                    step,
                  );
                  setError(result.ok ? null : (result.error ?? "Failed"));
                  if (result.ok) {
                    await fetchRun(workspaceId, selectedSummary.runId);
                    void fetchOverview(workspaceId);
                  }
                }}
                onNewInput={() => setDialogOpen(true)}
              />
              {selectedStatus === "FAILED" && (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<AskIcon size={14} />}
                  onClick={() =>
                    useUIStore
                      .getState()
                      .askMako(
                        fixRequest(workflowId, selectedSummary, selectedRun),
                      )
                  }
                  sx={{ textTransform: "none", height: 24 }}
                >
                  Ask Mako to fix
                </Button>
              )}
            </Box>
          )}
        </Box>
      )}
      {selectedSummary ? (
        <WorkflowRunDetail
          key={selectedSummary.runId}
          run={selectedRun}
          status={selectedStatus}
        />
      ) : (
        <>
          <TriggersStrip
            deployed={Boolean(workflow)}
            mayChange={Boolean(overview?.mayChange)}
            active={active}
            schedules={schedules.map(s => s.cron)}
            webhookUrl={webhookUrl}
            onChange={change}
          />
          <Tabs
            value={homeTab}
            onChange={(_e, value) => setHomeTab(value)}
            sx={{
              minHeight: 32,
              px: 1,
              borderBottom: "1px solid",
              borderColor: "divider",
              "& .MuiTab-root": {
                minHeight: 32,
                py: 0,
                textTransform: "none",
                fontSize: 13,
              },
            }}
          >
            <Tab value="runs" label="Runs" />
            <Tab value="flow" label="Flow" />
          </Tabs>
          {homeTab === "runs" ? (
            <RunsTable
              runs={runs}
              onSelect={select}
              unreadable={overview?.hatchetError}
            />
          ) : (
            <WorkflowFlowView
              workspaceId={workspaceId}
              workflowId={workflowId}
            />
          )}
        </>
      )}

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
            if (sandbox && result.runId) setSandboxRunId(result.runId);
            else {
              await fetchOverview(workspaceId);
              if (result.runId) select(result.runId);
            }
            return null;
          }}
        />
      )}
    </Box>
  );
}

/**
 * What starts the workflow, in plain words: each schedule (set in
 * workflow.ts) with its next run, the webhook (added here), and the switch
 * that turns both on or off. Run is always there in the bar.
 */
function TriggersStrip({
  deployed,
  mayChange,
  active,
  schedules,
  webhookUrl,
  onChange,
}: {
  deployed: boolean;
  mayChange: boolean;
  active: boolean;
  schedules: string[];
  webhookUrl: string | null | undefined;
  onChange: (change: { active?: boolean; webhook?: boolean }) => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!deployed) {
    return (
      <Box sx={BAR_SX}>
        <Dim>
          Not on main yet: schedules and the webhook start once it is. Until
          then, Run tests it.
        </Dim>
      </Box>
    );
  }
  const row = {
    display: "flex",
    alignItems: "center",
    gap: 1,
    minHeight: 24,
  } as const;
  const muted = active ? "text.primary" : "text.disabled";
  return (
    <Box
      sx={{
        px: 1.5,
        py: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        fontSize: 13,
      }}
    >
      <Box sx={row}>
        <Typography variant="caption" sx={{ fontWeight: 600, width: 70 }}>
          Triggers
        </Typography>
        {mayChange ? (
          <FormControlLabel
            sx={{ mr: 0, "& .MuiFormControlLabel-label": { fontSize: 13 } }}
            label={active ? "On" : "Off"}
            control={
              <Switch
                size="small"
                checked={active}
                onChange={(_e, on) => onChange({ active: on })}
              />
            }
          />
        ) : (
          <Chip
            label={active ? "On" : "Off"}
            size="small"
            variant="outlined"
            color={active ? "success" : "default"}
            sx={{ height: 20 }}
          />
        )}
        <Dim>
          {active
            ? "The schedules and the webhook start runs."
            : "Only Run starts it: the schedules and the webhook are paused."}
        </Dim>
      </Box>
      {schedules.length === 0 ? (
        <Box sx={{ ...row, pl: "78px" }}>
          <ScheduleIcon size={13} />
          <Dim>
            No schedule. Add one with `on: {"{"} cron {"}"}` in workflow.ts.
          </Dim>
        </Box>
      ) : (
        schedules.map(cron => {
          const next = active ? nextRunOf(cron) : null;
          return (
            <Box key={cron} sx={{ ...row, pl: "78px", color: muted }}>
              <ScheduleIcon size={13} />
              <Tooltip title={`cron: ${cron} · set in workflow.ts`}>
                <span>{describeCron(cron)}</span>
              </Tooltip>
              {next && <Dim>· next {inTime(next)}</Dim>}
            </Box>
          );
        })
      )}
      {webhookUrl !== undefined && (
        <Box sx={{ ...row, pl: "78px", color: muted }}>
          <WebhookIcon size={13} />
          {webhookUrl === null ? (
            <>
              <Dim>No webhook.</Dim>
              <Button
                size="small"
                onClick={() => onChange({ webhook: true })}
                sx={{ textTransform: "none", py: 0, minHeight: 0 }}
              >
                Add webhook
              </Button>
            </>
          ) : (
            <>
              <span>Webhook: POST JSON to its URL</span>
              <Tooltip title={webhookUrl}>
                <Button
                  size="small"
                  onClick={() => {
                    void navigator.clipboard.writeText(webhookUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  sx={{ textTransform: "none", py: 0, minHeight: 0 }}
                >
                  {copied ? "Copied" : "Copy URL"}
                </Button>
              </Tooltip>
              <Button
                size="small"
                color="inherit"
                onClick={() => onChange({ webhook: false })}
                sx={{ textTransform: "none", py: 0, minHeight: 0 }}
              >
                Remove
              </Button>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

/**
 * The workflow's flow as its code defines it (the deployed version): each
 * step, the steps it waits for, its retries and timeout.
 */
function WorkflowFlowView({
  workspaceId,
  workflowId,
}: {
  workspaceId: string;
  workflowId: string;
}) {
  const [flow, setFlow] = useState<WorkflowFlow | { error: string } | null>(
    null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void fetchWorkflowFlow(workspaceId, workflowId).then(result => {
      if (current) setFlow(result);
    });
    return () => {
      current = false;
    };
  }, [workspaceId, workflowId]);
  if (!flow) {
    return (
      <Box sx={{ p: 2 }}>
        <CircularProgress size={14} />
      </Box>
    );
  }
  if ("error" in flow) return <Note>{flow.error}</Note>;
  const steps = flow.steps.map(step => ({
    step: step.step,
    parents: step.parents,
    logs: [],
    note: [
      step.retries ? `retries ${step.retries}` : "no retries",
      step.timeout && `timeout ${step.timeout}`,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
  return (
    <FlowPanel
      steps={steps}
      title={`Flow of ${workflowId}`}
      selected={selected}
      onSelect={setSelected}
    />
  );
}

/** The workflow's runs, newest first; a row opens that run. */
function RunsTable({
  runs,
  onSelect,
  unreadable,
}: {
  runs: Array<WorkflowRunSummary & { runId: string }>;
  onSelect: (runId: string) => void;
  /** Why the runs could not be read, when Hatchet did not answer. */
  unreadable?: string;
}) {
  if (runs.length === 0) {
    return (
      <Note>
        {unreadable ?? "No runs yet. Start one, or wait for the schedule."}
      </Note>
    );
  }
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      <Box
        component="table"
        sx={{
          width: "100%",
          fontSize: "0.78rem",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          "& td, & th": {
            borderBottom: "1px solid",
            borderColor: "divider",
            px: 1.5,
            py: 0.75,
            textAlign: "left",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
          "& th": {
            fontWeight: 600,
            color: "text.secondary",
            position: "sticky",
            top: 0,
            backgroundColor: "background.paper",
          },
          "& tbody tr": { cursor: "pointer" },
          "& tbody tr:hover": { backgroundColor: "action.hover" },
        }}
      >
        <colgroup>
          <col style={{ width: 120 }} />
          <col style={{ width: 130 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 90 }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Trigger</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {/* A retried run starts again: it moves up with its new start. */}
          {[...runs]
            .sort((a, b) =>
              String(b.startedAt ?? "").localeCompare(
                String(a.startedAt ?? ""),
              ),
            )
            .map(run => {
              const status = statusOf(run.status);
              return (
                <tr
                  key={run.runId}
                  tabIndex={0}
                  onClick={() => onSelect(run.runId)}
                  onKeyDown={e => e.key === "Enter" && onSelect(run.runId)}
                >
                  <td>
                    <Box
                      component="span"
                      sx={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 0.75,
                        fontWeight: 600,
                        color: status.color,
                      }}
                    >
                      <StatusDot status={run.status} color={status.color} />
                      {status.label}
                    </Box>
                  </td>
                  <td title={run.startedAt}>
                    {formatRelativeTimeCompact(run.startedAt)}
                  </td>
                  <td>{formatDuration(run.durationMs)}</td>
                  <td>{run.trigger ?? "schedule"}</td>
                  <Box
                    component="td"
                    title={run.error}
                    sx={{ color: "error.main", fontFamily: "monospace" }}
                  >
                    {(run.error ?? "").split("\n")[0]}
                  </Box>
                </tr>
              );
            })}
        </tbody>
      </Box>
    </Box>
  );
}

/** One run's status, when and how it started: in the picker and its list. */
function RunLabel({
  run,
  status,
}: {
  run: WorkflowRunSummary;
  status?: string;
}) {
  const shown = statusOf(status ?? run.status);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
      <StatusDot status={status ?? run.status} color={shown.color} />
      <Typography
        variant="caption"
        sx={{ fontWeight: 600, color: shown.color }}
      >
        {shown.label}
      </Typography>
      <Dim>
        {run.sandbox
          ? "sandbox test"
          : formatRelativeTimeCompact(run.startedAt)}
      </Dim>
      <Dim>· {run.sandbox ? "your checkout" : (run.trigger ?? "schedule")}</Dim>
    </Box>
  );
}

/** The run shown, and the workflow's other runs to pick from. */
function RunPicker({
  runs,
  selected,
  status,
  onSelect,
}: {
  runs: Array<WorkflowRunSummary & { runId: string }>;
  selected: WorkflowRunSummary;
  status?: string;
  onSelect: (runId: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        endIcon={<ChevronIcon size={14} />}
        onClick={e => setAnchor(e.currentTarget)}
        sx={{ textTransform: "none", height: 26, borderColor: "divider" }}
      >
        <RunLabel run={selected} status={status} />
      </Button>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        slotProps={{ paper: { sx: { maxHeight: 420 } } }}
      >
        {runs.map(run => (
          <MenuItem
            key={run.runId}
            dense
            selected={run.runId === selected.runId}
            onClick={() => {
              setAnchor(null);
              onSelect(run.runId);
            }}
            sx={{ gap: 2 }}
          >
            <RunLabel run={run} />
            <Box sx={{ ml: "auto" }}>
              <Dim>{formatDuration(run.durationMs)}</Dim>
            </Box>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

/**
 * Retry a failed run: from its failed step (the steps before it keep their
 * outputs), the whole run, or a new run with other input. A sandbox run is
 * not kept, so it can only be started again.
 */
function RetryMenu({
  run,
  sandbox,
  onRetry,
  onNewInput,
}: {
  run: WorkflowRun | undefined;
  sandbox: boolean;
  onRetry: (step?: string) => Promise<void>;
  onNewInput: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = run?.steps.find(step => step.status === "FAILED")?.step;
  const pick = async (step?: string) => {
    setAnchor(null);
    setBusy(true);
    await onRetry(step);
    setBusy(false);
  };
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={
          busy ? <CircularProgress size={12} /> : <RetryIcon size={14} />
        }
        disabled={busy}
        onClick={e => setAnchor(e.currentTarget)}
        sx={{ textTransform: "none", height: 24 }}
      >
        Retry
      </Button>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
      >
        {!sandbox && failed && (
          <MenuItem dense onClick={() => void pick(failed)}>
            <ListItemText
              primary={`Retry from “${failed}”`}
              secondary="The steps before it keep their output"
            />
          </MenuItem>
        )}
        {!sandbox && (
          <MenuItem dense onClick={() => void pick()}>
            <ListItemText
              primary="Retry the whole run"
              secondary="Every step again, same input"
            />
          </MenuItem>
        )}
        <MenuItem
          dense
          onClick={() => {
            setAnchor(null);
            onNewInput();
          }}
        >
          <ListItemText
            primary={sandbox ? "Run again…" : "Run with other input…"}
            secondary="A new run; edit its input first"
          />
        </MenuItem>
      </Menu>
    </>
  );
}

/**
 * The first message of a chat about a failed run: which workflow, which run
 * and which step. The agent reads the rest with workflows_status. A sandbox
 * run is not kept, so its error goes in the message.
 */
function fixRequest(
  workflowId: string,
  summary: WorkflowRunSummary,
  run: WorkflowRun | undefined,
): string {
  const failed = run?.steps.find(step => step.status === "FAILED");
  const step = failed?.step ? ` at step "${failed.step}"` : "";
  if (summary.sandbox) {
    const error = (failed?.error ?? summary.error ?? "").split("\n")[0];
    return `My sandbox test run of the workflow "${workflowId}" failed${step}${error ? `: ${error}` : "."}\n\nFind out why and fix the workflow.`;
  }
  return `The workflow "${workflowId}" failed${step} in run ${summary.runId}.\n\nRead the run with workflows_status, find out why it failed and fix the workflow.`;
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
