/**
 * The `workflow` tab. For a workflow: its runs and the selected run, laid out
 * like the Transforms run history. For a file under `workflows/`: the file,
 * read-only. Polls while on screen, faster while a run is active.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import MonacoEditor from "@monaco-editor/react";
import {
  Play as RunIcon,
  Square as StopIcon,
  Webhook as WebhookIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import {
  isActiveRun,
  useWorkflowsStore,
  type WorkflowRunSummary,
} from "../store/workflowsStore";
import { formatDuration } from "../utils/format";
import { formatRelativeTimeCompact } from "../utils/relative-time";

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

const SMALL_CHIP_SX = {
  height: 16,
  fontSize: "0.62rem",
  flexShrink: 0,
  "& .MuiChip-label": { px: 0.5 },
} as const;

export function VersionChip({
  preview,
  small,
}: {
  preview: boolean;
  small?: boolean;
}) {
  return (
    <Chip
      label={preview ? "preview" : "live"}
      size="small"
      variant="outlined"
      color={preview ? "info" : "default"}
      sx={small ? SMALL_CHIP_SX : { height: 20 }}
    />
  );
}

function Note({ children }: { children: string }) {
  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="caption" color="text.secondary">
        {children}
      </Typography>
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
  const fetchFile = useWorkflowsStore(s => s.fetchFile);
  const monacoTheme = useMonacoTheme();
  const [contents, setContents] = useState<string | null | undefined>();

  useEffect(() => {
    let current = true;
    setContents(undefined);
    void fetchFile(workspaceId, path).then(text => {
      if (current) setContents(text);
    });
    return () => {
      current = false;
    };
  }, [workspaceId, path, fetchFile]);

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
      <Box
        sx={{
          px: 1.5,
          py: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography variant="caption" color="text.secondary">
          Read-only. Change it with the Mako agent or in the repository.
        </Typography>
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
  open,
  workflowId,
  previewBranch,
  live,
  initialInput,
  onClose,
  onRun,
}: {
  open: boolean;
  workflowId: string;
  /** Set when unmerged code of this workflow can be run. */
  previewBranch: string | null;
  /** False while the workflow exists only on the previewed branch. */
  live: boolean;
  initialInput: string;
  onClose: () => void;
  onRun: (
    input: Record<string, unknown>,
    preview: boolean,
  ) => Promise<string | null>;
}) {
  const [version, setVersion] = useState<"live" | "preview">("live");
  const [input, setInput] = useState(initialInput);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setVersion(live ? "live" : "preview");
      setInput(initialInput);
      setError(null);
    }
  }, [open, live, initialInput]);

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
      version === "preview",
    );
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Run {workflowId}</DialogTitle>
      <DialogContent
        sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 0.5 }}
      >
        {previewBranch && (
          <ToggleButtonGroup
            exclusive
            fullWidth
            size="small"
            color="primary"
            value={version}
            onChange={(_event, value) => value && setVersion(value)}
            aria-label="Version"
          >
            <ToggleButton
              value="live"
              disabled={!live}
              sx={{ textTransform: "none" }}
            >
              Live
            </ToggleButton>
            <ToggleButton value="preview" sx={{ textTransform: "none" }}>
              Preview
            </ToggleButton>
          </ToggleButtonGroup>
        )}
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
        <Button variant="contained" onClick={submit} disabled={busy}>
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
  const cancelRun = useWorkflowsStore(s => s.cancel);
  const setWebhook = useWorkflowsStore(s => s.setWebhook);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const selectedRun = useWorkflowsStore(s =>
    selectedRunId ? s.runsById[selectedRunId] : undefined,
  );

  const runs = useMemo(
    () =>
      (overview?.recentRuns ?? []).filter(
        (run): run is WorkflowRunSummary & { runId: string } =>
          run.workflowId === workflowId && Boolean(run.runId),
      ),
    [overview?.recentRuns, workflowId],
  );
  const selectedSummary = runs.find(run => run.runId === selectedRunId);
  const selectedStatus = selectedRun?.status ?? selectedSummary?.status;
  const hasActive = runs.some(run => isActiveRun(run.status));

  // Poll the list, and the open run while it is still going.
  useEffect(() => {
    const tick = () => {
      void fetchOverview(workspaceId);
      if (selectedRunId && isActiveRun(selectedStatus)) {
        void fetchRun(workspaceId, selectedRunId);
      }
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

  // Land on the newest run, and load whichever run is selected.
  useEffect(() => {
    if (!selectedRunId && runs.length > 0) setSelectedRunId(runs[0].runId);
  }, [selectedRunId, runs]);
  useEffect(() => {
    if (selectedRunId) void fetchRun(workspaceId, selectedRunId);
  }, [workspaceId, selectedRunId, selectedSummary?.status, fetchRun]);

  const schedule = overview?.schedules?.find(s => s.workflowId === workflowId);
  const webhookUrl = overview?.workflows?.find(
    w => !w.preview && w.workflowId === workflowId,
  )?.webhookUrl;
  const previewBranch =
    overview?.preview &&
    !overview.preview.buildError &&
    overview.workflows?.some(w => w.preview && w.workflowId === workflowId)
      ? overview.preview.branch
      : null;
  const deployment = overview?.deployment;

  const toggleWebhook = async (enabled: boolean) => {
    await setWebhook(workspaceId, workflowId, enabled);
    void fetchOverview(workspaceId);
  };

  const act = async (action: typeof cancelRun, runId: string) => {
    const result = await action(workspaceId, runId);
    setActionError(result.ok ? null : (result.error ?? "Failed"));
    void fetchOverview(workspaceId);
  };

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          px: 1.5,
          py: 0.75,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexWrap: "wrap",
        }}
      >
        <Button
          size="small"
          variant="contained"
          startIcon={<RunIcon size={14} />}
          onClick={() => setDialogOpen(true)}
          sx={{ textTransform: "none" }}
        >
          Run
        </Button>
        <Typography variant="caption" color="text.secondary">
          {schedule ? `Schedule: ${schedule.cron} (UTC)` : "No schedule"}
        </Typography>
        {webhookUrl === null && (
          <Chip
            icon={<WebhookIcon size={12} />}
            label="Add webhook"
            size="small"
            variant="outlined"
            onClick={() => void toggleWebhook(true)}
            sx={{ height: 20, borderStyle: "dashed" }}
          />
        )}
        {webhookUrl && (
          <Tooltip title="POST JSON to this URL to start a run. Click to copy it; ✕ removes it.">
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
              onDelete={() => void toggleWebhook(false)}
              sx={{ height: 20 }}
            />
          </Tooltip>
        )}
        <Box sx={{ ml: "auto", display: "flex", gap: 1, flexWrap: "wrap" }}>
          {deployment?.liveSha && (
            <>
              <VersionChip preview={false} />
              <Chip
                label={short(deployment.liveSha)}
                size="small"
                variant="outlined"
                sx={{ height: 20, fontFamily: "monospace" }}
              />
            </>
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
          {overview?.preview && (
            <Chip
              label={`preview · ${overview.preview.branch}${
                overview.preview.buildError ? " · build failed" : ""
              }`}
              size="small"
              variant="outlined"
              color={overview.preview.buildError ? "error" : "info"}
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
                  onClick={() => setSelectedRunId(run.runId)}
                  onKeyDown={e =>
                    e.key === "Enter" && setSelectedRunId(run.runId)
                  }
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
                    <VersionChip preview={run.preview} small />
                    {run.durationMs !== undefined && (
                      <Typography variant="caption" color="text.secondary">
                        {formatDuration(run.durationMs)}
                      </Typography>
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
            <Box
              sx={{
                display: "flex",
                gap: 2,
                alignItems: "center",
                px: 1.5,
                py: 0.75,
                borderBottom: "1px solid",
                borderColor: "divider",
                flexWrap: "wrap",
              }}
            >
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
              <VersionChip preview={selectedSummary.preview} />
              <Typography variant="caption" color="text.secondary">
                {formatRelativeTimeCompact(selectedSummary.startedAt)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {formatDuration(
                  selectedRun?.durationMs ?? selectedSummary.durationMs,
                )}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {selectedSummary.trigger ?? "schedule"}
              </Typography>
              {actionError && (
                <Typography variant="caption" color="error">
                  {actionError}
                </Typography>
              )}
              {isActiveRun(selectedStatus) && (
                <Button
                  size="small"
                  color="warning"
                  variant="outlined"
                  startIcon={<StopIcon size={14} />}
                  onClick={() => void act(cancelRun, selectedSummary.runId)}
                  sx={{ ml: "auto", textTransform: "none" }}
                >
                  Cancel
                </Button>
              )}
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
                <Typography variant="caption" color="text.secondary">
                  {selectedStatus === "QUEUED" ? "Run queued…" : "No logs."}
                </Typography>
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

      <RunDialog
        open={dialogOpen}
        workflowId={workflowId}
        previewBranch={previewBranch}
        live={Boolean(
          overview?.workflows?.some(
            w => !w.preview && w.workflowId === workflowId,
          ),
        )}
        initialInput={formatInput(selectedRun?.input)}
        onClose={() => setDialogOpen(false)}
        onRun={async (input, preview) => {
          const result = await startRun(
            workspaceId,
            workflowId,
            input,
            preview,
          );
          if (!result.ok) return result.error ?? "Failed to start the run";
          await fetchOverview(workspaceId);
          if (result.runId) setSelectedRunId(result.runId);
          return null;
        }}
      />
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
