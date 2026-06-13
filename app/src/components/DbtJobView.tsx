/**
 * DbtJobView — run history + live logs (view mode, pattern: FlowLogs) and
 * the job edit form (commands list + schedule, pattern: ScheduleConsoleModal).
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
  Chip,
  CircularProgress,
  Tab,
  Tabs,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Play as RunIcon,
  Square as StopIcon,
  Pencil as EditIcon,
  RefreshCw as RefreshIcon,
  Plus as AddIcon,
  Trash2 as RemoveIcon,
  FileCode as ModelIcon,
  RotateCcw as RetryIcon,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { CronExpressionParser } from "cron-parser";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useDbtStore,
  type DbtJobItem,
  type DbtRunItem,
} from "../store/dbtStore";
import { focusDbtFileTab } from "../dbt-runtime/shell";

const DbtLineageView = lazy(() => import("./DbtLineageView"));

type SchedulePreset = "hourly" | "daily" | "every6h" | "weekly" | "custom";

const PRESET_CRONS: Record<Exclude<SchedulePreset, "custom">, string> = {
  hourly: "0 * * * *",
  daily: "0 6 * * *",
  every6h: "0 */6 * * *",
  weekly: "0 6 * * 1",
};

const COMMAND_PRESETS = [
  "build",
  "run",
  "test",
  "seed",
  "snapshot",
  "compile",
  "source freshness",
  "docs generate",
];

function presetFromCron(cron: string): SchedulePreset {
  if (cron === PRESET_CRONS.hourly) return "hourly";
  if (cron === PRESET_CRONS.daily) return "daily";
  if (cron === PRESET_CRONS.every6h) return "every6h";
  if (cron === PRESET_CRONS.weekly) return "weekly";
  return "custom";
}

function statusColor(status: DbtRunItem["status"]): string {
  switch (status) {
    case "running":
      return "primary.main";
    case "success":
      return "success.main";
    case "error":
      return "error.main";
    case "cancelled":
      return "warning.main";
    default:
      return "text.secondary";
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function relativeTime(iso?: string): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function DbtJobView({
  projectId,
  jobId,
}: {
  projectId: string;
  jobId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const project = useDbtStore(s => s.projects.find(p => p._id === projectId));
  const jobs = useDbtStore(s => s.jobsByProject[projectId]);
  const runs = useDbtStore(s => s.runsByProject[projectId]);
  const runDetails = useDbtStore(s => s.runDetails);
  const fetchProjects = useDbtStore(s => s.fetchProjects);
  const fetchJobs = useDbtStore(s => s.fetchJobs);
  const fetchRuns = useDbtStore(s => s.fetchRuns);
  const fetchRunDetails = useDbtStore(s => s.fetchRunDetails);
  const triggerJob = useDbtStore(s => s.triggerJob);
  const cancelRun = useDbtStore(s => s.cancelRun);
  const retryRun = useDbtStore(s => s.retryRun);
  const saveJob = useDbtStore(s => s.saveJob);

  const job = useMemo(
    () => (jobs ?? []).find(j => j._id === jobId),
    [jobs, jobId],
  );

  const jobRuns = useMemo(
    () => (runs ?? []).filter(run => run.jobId === jobId),
    [runs, jobId],
  );

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [viewTab, setViewTab] = useState<"runs" | "lineage">("runs");
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  // Edit-form state
  const [formName, setFormName] = useState("");
  const [formEnvironment, setFormEnvironment] = useState("");
  const [formCommands, setFormCommands] = useState<string[]>(["build"]);
  const [formScheduleEnabled, setFormScheduleEnabled] = useState(false);
  const [formPreset, setFormPreset] = useState<SchedulePreset>("daily");
  const [formCron, setFormCron] = useState(PRESET_CRONS.daily);
  const [formTimezone, setFormTimezone] = useState("UTC");
  const [formEnabled, setFormEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const timezones = useMemo<string[]>(() => {
    const intlWithSupportedValues = Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    };
    return typeof intlWithSupportedValues.supportedValuesOf === "function"
      ? intlWithSupportedValues.supportedValuesOf("timeZone")
      : ["UTC"];
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    if (!project) void fetchProjects(workspaceId);
    if (!jobs) void fetchJobs(workspaceId, projectId);
    void fetchRuns(workspaceId, projectId, jobId);
  }, [
    workspaceId,
    projectId,
    jobId,
    project,
    jobs,
    fetchProjects,
    fetchJobs,
    fetchRuns,
  ]);

  useEffect(() => {
    if (!selectedRunId && jobRuns.length > 0) {
      setSelectedRunId(jobRuns[0]._id);
    }
  }, [selectedRunId, jobRuns]);

  const selectedRun = selectedRunId ? runDetails[selectedRunId] : undefined;
  const selectedRunListItem = jobRuns.find(run => run._id === selectedRunId);
  const selectedStatus = selectedRun?.status ?? selectedRunListItem?.status;
  const runningRun = jobRuns.find(
    run => run.status === "running" || run.status === "queued",
  );

  // Fetch details when selection changes; poll every 2s while running.
  useEffect(() => {
    if (!workspaceId || !selectedRunId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      const details = await fetchRunDetails(
        workspaceId,
        projectId,
        selectedRunId,
      );
      if (stopped) return;
      if (details?.status === "running" || details?.status === "queued") {
        timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, projectId, selectedRunId, fetchRunDetails]);

  // Auto-scroll logs while running.
  useEffect(() => {
    if (selectedStatus === "running" && logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [selectedRun?.logs.length, selectedStatus]);

  const handleRunNow = useCallback(async () => {
    if (!workspaceId) return;
    const runId = await triggerJob(workspaceId, projectId, jobId);
    if (runId) setSelectedRunId(runId);
  }, [workspaceId, projectId, jobId, triggerJob]);

  const handleStop = useCallback(async () => {
    if (!workspaceId || !runningRun) return;
    await cancelRun(workspaceId, projectId, runningRun._id);
    await fetchRuns(workspaceId, projectId, jobId);
  }, [workspaceId, projectId, jobId, runningRun, cancelRun, fetchRuns]);

  const handleRetry = useCallback(async () => {
    if (!workspaceId || !selectedRunId) return;
    const runId = await retryRun(workspaceId, projectId, selectedRunId, jobId);
    if (runId) setSelectedRunId(runId);
  }, [workspaceId, projectId, jobId, selectedRunId, retryRun]);

  const handleRefresh = useCallback(() => {
    if (workspaceId) void fetchRuns(workspaceId, projectId, jobId);
  }, [workspaceId, projectId, jobId, fetchRuns]);

  const beginEdit = useCallback(() => {
    if (!job) return;
    setFormName(job.name);
    setFormEnvironment(job.environment);
    setFormCommands(job.commands.length > 0 ? [...job.commands] : ["build"]);
    setFormScheduleEnabled(!!job.schedule?.cron);
    const cron = job.schedule?.cron ?? PRESET_CRONS.daily;
    setFormCron(cron);
    setFormPreset(presetFromCron(cron));
    setFormTimezone(job.schedule?.timezone ?? "UTC");
    setFormEnabled(job.enabled);
    setEditing(true);
  }, [job]);

  const previewRuns = useMemo(() => {
    if (!formScheduleEnabled || !formCron) return [];
    try {
      const interval = CronExpressionParser.parse(formCron, {
        currentDate: new Date(),
        tz: formTimezone,
      });
      return Array.from({ length: 3 }, () =>
        interval.next().toDate().toLocaleString(),
      );
    } catch {
      return [];
    }
  }, [formScheduleEnabled, formCron, formTimezone]);

  const handlePresetChange = useCallback((preset: SchedulePreset) => {
    setFormPreset(preset);
    if (preset !== "custom") {
      setFormCron(PRESET_CRONS[preset]);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!workspaceId) return;
    setSaving(true);
    const payload: Partial<DbtJobItem> & { name: string } = {
      name: formName.trim() || "Untitled job",
      environment: formEnvironment,
      commands: formCommands.map(c => c.trim()).filter(Boolean),
      schedule: formScheduleEnabled
        ? { cron: formCron, timezone: formTimezone }
        : null,
      enabled: formEnabled,
    };
    const saved = await saveJob(workspaceId, projectId, payload, jobId);
    setSaving(false);
    if (saved) setEditing(false);
  }, [
    workspaceId,
    projectId,
    jobId,
    formName,
    formEnvironment,
    formCommands,
    formScheduleEnabled,
    formCron,
    formTimezone,
    formEnabled,
    saveJob,
  ]);

  if (!job) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading job…</Typography>
      </Box>
    );
  }

  const topBar = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 1.5,
        py: 0.75,
        borderBottom: "1px solid",
        borderColor: "divider",
        backgroundColor: "background.paper",
      }}
    >
      <Typography variant="subtitle2" sx={{ flexShrink: 0 }}>
        {job.name}
      </Typography>
      <Chip label={job.environment} size="small" variant="outlined" />
      {!job.enabled && (
        <Chip
          label="disabled"
          size="small"
          color="warning"
          variant="outlined"
        />
      )}
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {job.commands.map(command => `dbt ${command}`).join(" → ")}
        {job.schedule?.cron
          ? ` · ${job.schedule.cron} ${job.schedule.timezone}`
          : " · manual"}
      </Typography>
      {runningRun ? (
        <Button
          size="small"
          color="warning"
          variant="outlined"
          startIcon={<StopIcon size={14} />}
          onClick={handleStop}
        >
          Stop
        </Button>
      ) : (
        <Button
          size="small"
          variant="contained"
          startIcon={<RunIcon size={14} />}
          onClick={handleRunNow}
        >
          Run now
        </Button>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<EditIcon size={14} />}
        onClick={editing ? () => setEditing(false) : beginEdit}
      >
        {editing ? "Cancel" : "Edit"}
      </Button>
      <Tooltip title="Refresh">
        <IconButton size="small" onClick={handleRefresh}>
          <RefreshIcon size={16} />
        </IconButton>
      </Tooltip>
    </Box>
  );

  if (editing) {
    return (
      <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {topBar}
        <Box sx={{ flex: 1, overflow: "auto", p: 2, maxWidth: 560 }}>
          <TextField
            fullWidth
            size="small"
            label="Job name"
            value={formName}
            onChange={e => setFormName(e.target.value)}
            sx={{ mb: 2 }}
          />
          <FormControl fullWidth size="small" sx={{ mb: 2 }}>
            <InputLabel id="dbt-job-env">Environment</InputLabel>
            <Select
              labelId="dbt-job-env"
              label="Environment"
              value={formEnvironment}
              onChange={e => setFormEnvironment(e.target.value)}
            >
              {(project?.environments ?? []).map(env => (
                <MenuItem key={env.name} value={env.name}>
                  {env.name} ({env.targetSchema})
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Commands
          </Typography>
          {formCommands.map((command, index) => {
            const preset = COMMAND_PRESETS.find(
              p => command === p || command.startsWith(`${p} `),
            );
            const flags = preset ? command.slice(preset.length).trim() : "";
            return (
              <Box
                key={index}
                sx={{ display: "flex", gap: 1, mb: 1, alignItems: "center" }}
              >
                <Select
                  size="small"
                  value={preset ?? "build"}
                  onChange={e => {
                    const next = [...formCommands];
                    next[index] = flags
                      ? `${e.target.value} ${flags}`
                      : e.target.value;
                    setFormCommands(next);
                  }}
                  sx={{ minWidth: 150 }}
                >
                  {COMMAND_PRESETS.map(p => (
                    <MenuItem key={p} value={p}>
                      dbt {p}
                    </MenuItem>
                  ))}
                </Select>
                <TextField
                  size="small"
                  placeholder="--select staging --full-refresh"
                  value={flags}
                  onChange={e => {
                    const next = [...formCommands];
                    const base = preset ?? "build";
                    next[index] = e.target.value.trim()
                      ? `${base} ${e.target.value}`
                      : base;
                    setFormCommands(next);
                  }}
                  sx={{ flex: 1 }}
                />
                <IconButton
                  size="small"
                  disabled={formCommands.length <= 1}
                  onClick={() =>
                    setFormCommands(formCommands.filter((_c, i) => i !== index))
                  }
                >
                  <RemoveIcon size={14} />
                </IconButton>
              </Box>
            );
          })}
          <Button
            size="small"
            startIcon={<AddIcon size={14} />}
            onClick={() => setFormCommands([...formCommands, "test"])}
            sx={{ mb: 2 }}
          >
            Add command
          </Button>

          <Box sx={{ mb: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={formScheduleEnabled}
                  onChange={e => setFormScheduleEnabled(e.target.checked)}
                />
              }
              label="Run on a schedule"
            />
            {formScheduleEnabled && (
              <Box sx={{ pl: 1, pt: 1 }}>
                <RadioGroup
                  value={formPreset}
                  onChange={e =>
                    handlePresetChange(e.target.value as SchedulePreset)
                  }
                >
                  <FormControlLabel
                    value="hourly"
                    control={<Radio size="small" />}
                    label="Hourly"
                  />
                  <FormControlLabel
                    value="daily"
                    control={<Radio size="small" />}
                    label="Daily at 06:00"
                  />
                  <FormControlLabel
                    value="every6h"
                    control={<Radio size="small" />}
                    label="Every 6 hours"
                  />
                  <FormControlLabel
                    value="weekly"
                    control={<Radio size="small" />}
                    label="Weekly (Mon 06:00)"
                  />
                  <FormControlLabel
                    value="custom"
                    control={<Radio size="small" />}
                    label="Custom cron"
                  />
                </RadioGroup>
                {formPreset === "custom" && (
                  <TextField
                    size="small"
                    label="Cron expression"
                    value={formCron}
                    onChange={e => setFormCron(e.target.value)}
                    sx={{ mt: 1, mb: 1 }}
                  />
                )}
                <FormControl fullWidth size="small" sx={{ mt: 1, mb: 1 }}>
                  <InputLabel id="dbt-job-tz">Timezone</InputLabel>
                  <Select
                    labelId="dbt-job-tz"
                    label="Timezone"
                    value={formTimezone}
                    onChange={e => setFormTimezone(e.target.value)}
                  >
                    {timezones.map(tz => (
                      <MenuItem key={tz} value={tz}>
                        {tz}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                {previewRuns.length > 0 ? (
                  <Typography variant="caption" color="text.secondary">
                    Next runs: {previewRuns.join(" · ")}
                  </Typography>
                ) : (
                  <Typography variant="caption" color="error">
                    Invalid cron expression
                  </Typography>
                )}
              </Box>
            )}
          </Box>

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={formEnabled}
                onChange={e => setFormEnabled(e.target.checked)}
              />
            }
            label="Enabled"
            sx={{ display: "block", mb: 2 }}
          />

          <Button
            variant="contained"
            disabled={
              saving ||
              !formEnvironment ||
              formCommands.length === 0 ||
              (formScheduleEnabled && previewRuns.length === 0)
            }
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save job"}
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {topBar}
      <Tabs
        value={viewTab}
        onChange={(_e, value) => setViewTab(value)}
        sx={{
          minHeight: 32,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Tab label="Runs" value="runs" sx={{ minHeight: 32, py: 0 }} />
        <Tab label="Lineage" value="lineage" sx={{ minHeight: 32, py: 0 }} />
      </Tabs>
      {viewTab === "lineage" ? (
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
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <PanelGroup direction="horizontal">
            {/* Run history */}
            <Panel defaultSize={25} minSize={15}>
              <Box
                sx={{
                  height: "100%",
                  overflow: "auto",
                  borderRight: "1px solid",
                  borderColor: "divider",
                }}
              >
                {jobRuns.length === 0 ? (
                  <Box sx={{ p: 2 }}>
                    <Typography variant="caption" color="text.secondary">
                      No runs yet. Press Run now to start one.
                    </Typography>
                  </Box>
                ) : (
                  jobRuns.map(run => (
                    <Box
                      key={run._id}
                      onClick={() => setSelectedRunId(run._id)}
                      sx={{
                        px: 1.5,
                        py: 0.75,
                        cursor: "pointer",
                        borderBottom: "1px solid",
                        borderColor: "divider",
                        backgroundColor:
                          run._id === selectedRunId
                            ? "action.selected"
                            : "transparent",
                        "&:hover": { backgroundColor: "action.hover" },
                      }}
                    >
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 0.75,
                        }}
                      >
                        <Box
                          sx={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            backgroundColor: statusColor(run.status),
                            flexShrink: 0,
                          }}
                        />
                        <Typography variant="caption" sx={{ flex: 1 }}>
                          {relativeTime(run.createdAt)}
                        </Typography>
                        <Chip
                          label={run.trigger}
                          size="small"
                          variant="outlined"
                          sx={{ height: 16, fontSize: "0.6rem" }}
                        />
                      </Box>
                      <Typography
                        variant="caption"
                        sx={{ color: statusColor(run.status) }}
                      >
                        {run.status}
                        {run.durationMs !== undefined
                          ? ` · ${formatDuration(run.durationMs)}`
                          : ""}
                      </Typography>
                    </Box>
                  ))
                )}
              </Box>
            </Panel>
            <PanelResizeHandle
              style={{ width: 4, background: "var(--mui-palette-divider)" }}
            />
            {/* Run details */}
            <Panel defaultSize={75} minSize={30}>
              {!selectedRun && !selectedRunListItem ? (
                <Box sx={{ p: 2 }}>
                  <Typography variant="caption" color="text.secondary">
                    Select a run to see details.
                  </Typography>
                </Box>
              ) : (
                <Box
                  sx={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {/* Summary strip */}
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
                    <Typography
                      variant="caption"
                      sx={{
                        color: statusColor(
                          (selectedStatus ?? "queued") as DbtRunItem["status"],
                        ),
                        fontWeight: 600,
                      }}
                    >
                      {selectedStatus}
                      {selectedStatus === "running" && (
                        <CircularProgress size={10} sx={{ ml: 0.5 }} />
                      )}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {(selectedRun ?? selectedRunListItem)?.commands
                        .map(command => `dbt ${command}`)
                        .join(" → ")}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatDuration(
                        (selectedRun ?? selectedRunListItem)?.durationMs,
                      )}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {(selectedRun ?? selectedRunListItem)?.trigger} ·{" "}
                      {(selectedRun ?? selectedRunListItem)?.triggeredBy}
                    </Typography>
                    {(selectedRun ?? selectedRunListItem)?.error && (
                      <Typography variant="caption" color="error">
                        {(selectedRun ?? selectedRunListItem)?.error}
                      </Typography>
                    )}
                    {selectedStatus === "error" && (
                      <Tooltip title="Re-run only the failed/skipped nodes">
                        <Button
                          size="small"
                          variant="outlined"
                          startIcon={<RetryIcon size={14} />}
                          onClick={handleRetry}
                          sx={{ ml: "auto" }}
                        >
                          Retry from failure
                        </Button>
                      </Tooltip>
                    )}
                  </Box>

                  {/* Models table */}
                  {(selectedRun?.stepResults?.length ?? 0) > 0 && (
                    <Box
                      sx={{
                        maxHeight: "40%",
                        overflow: "auto",
                        borderBottom: "1px solid",
                        borderColor: "divider",
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
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedRun?.stepResults?.map(step => (
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
                              <td>
                                {step.status}
                                {step.message &&
                                (step.status === "error" ||
                                  step.status === "fail")
                                  ? ` — ${step.message}`
                                  : ""}
                              </td>
                              <td>
                                {(step.executionTimeMs / 1000).toFixed(2)}s
                              </td>
                              <td>{step.rowsAffected ?? ""}</td>
                              <td>
                                {step.resourceType === "model" && (
                                  <Tooltip title="Open model">
                                    <IconButton
                                      size="small"
                                      onClick={() =>
                                        focusDbtFileTab(
                                          projectId,
                                          `models/${step.name}.sql`,
                                        )
                                      }
                                    >
                                      <ModelIcon size={12} />
                                    </IconButton>
                                  </Tooltip>
                                )}
                              </td>
                            </Box>
                          ))}
                        </tbody>
                      </Box>
                    </Box>
                  )}

                  {/* Logs */}
                  <Box
                    ref={logScrollRef}
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
                    {(selectedRun?.logs ?? []).length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        {selectedStatus === "queued"
                          ? "Run queued…"
                          : "No logs."}
                      </Typography>
                    ) : (
                      selectedRun?.logs.map((log, index) => (
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
                          <Box
                            component="span"
                            sx={{ color: "text.secondary", mr: 1 }}
                          >
                            {new Date(log.ts).toLocaleTimeString()}
                          </Box>
                          {log.line}
                        </Box>
                      ))
                    )}
                  </Box>
                </Box>
              )}
            </Panel>
          </PanelGroup>
        </Box>
      )}
    </Box>
  );
}
