/**
 * DbtJobView — run history + live logs (view mode, pattern: FlowLogs) and
 * the job edit form (commands list + schedule, pattern: ScheduleConsoleModal).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
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
} from "lucide-react";
import { CronExpressionParser } from "cron-parser";
import { useWorkspace } from "../contexts/workspace-context";
import { useDbtStore, type DbtJobItem } from "../store/dbtStore";
import DbtRunHistory from "./DbtRunHistory";

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
  const fetchProjects = useDbtStore(s => s.fetchProjects);
  const fetchJobs = useDbtStore(s => s.fetchJobs);
  const fetchRuns = useDbtStore(s => s.fetchRuns);
  const triggerJob = useDbtStore(s => s.triggerJob);
  const cancelRun = useDbtStore(s => s.cancelRun);
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

  // Edit-form state
  const [formName, setFormName] = useState("");
  const [formEnvironment, setFormEnvironment] = useState("");
  const [formCommands, setFormCommands] = useState<string[]>(["build"]);
  const [formScheduleEnabled, setFormScheduleEnabled] = useState(false);
  const [formPreset, setFormPreset] = useState<SchedulePreset>("daily");
  const [formCron, setFormCron] = useState(PRESET_CRONS.daily);
  const [formTimezone, setFormTimezone] = useState("UTC");
  const [formEnabled, setFormEnabled] = useState(true);
  const [formDefer, setFormDefer] = useState(false);
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

  const runningRun = jobRuns.find(
    run => run.status === "running" || run.status === "queued",
  );

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
    setFormDefer(!!job.deferToProduction);
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
      deferToProduction: formDefer,
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
    formDefer,
    saveJob,
  ]);

  if (!job) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Loading job…</Typography>
      </Box>
    );
  }

  const commandSummary = job.commands
    .map(command => `dbt ${command}`)
    .join(" → ");
  const scheduleSummary = job.schedule?.cron
    ? `${job.schedule.cron} ${job.schedule.timezone}`
    : "manual";

  const header = (
    <Box
      sx={{
        borderBottom: "1px solid",
        borderColor: "divider",
        backgroundColor: "background.paper",
      }}
    >
      {/* Line 1 — identity + actions */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          pt: 0.75,
          pb: editing ? 0.75 : 0.25,
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {job.name}
        </Typography>
        <Chip
          label={job.environment}
          size="small"
          variant="outlined"
          sx={{ flexShrink: 0 }}
        />
        {!job.enabled && (
          <Chip
            label="disabled"
            size="small"
            color="warning"
            variant="outlined"
            sx={{ flexShrink: 0 }}
          />
        )}
        {editing && (
          <Chip
            label="editing"
            size="small"
            color="info"
            variant="outlined"
            sx={{ flexShrink: 0 }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        {!editing &&
          (runningRun ? (
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
          ))}
        <Button
          size="small"
          variant="outlined"
          startIcon={<EditIcon size={14} />}
          onClick={editing ? () => setEditing(false) : beginEdit}
        >
          {editing ? "Cancel" : "Edit"}
        </Button>
        {!editing && (
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={handleRefresh}>
              <RefreshIcon size={16} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      {/* Line 2 — muted command + schedule summary (view mode only) */}
      {!editing && (
        <Box sx={{ display: "flex", px: 1.5, pb: 0.5 }}>
          <Tooltip title={`${commandSummary} · ${scheduleSummary}`}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {commandSummary} · {scheduleSummary}
            </Typography>
          </Tooltip>
        </Box>
      )}
    </Box>
  );

  if (editing) {
    return (
      <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {header}
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

          <Box
            sx={{
              mb: 2,
              p: 1.5,
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
            }}
          >
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
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={formEnabled}
                      onChange={e => setFormEnabled(e.target.checked)}
                    />
                  }
                  label="Schedule enabled"
                  sx={{ display: "block", mt: 1 }}
                />
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block" }}
                >
                  Turn off to keep the schedule but pause automatic runs.
                </Typography>
              </Box>
            )}
          </Box>

          <Tooltip title="Run with --defer --state against the last successful prod manifest. Use with `--select state:modified+` to build only what changed (Slim CI).">
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={formDefer}
                  onChange={e => setFormDefer(e.target.checked)}
                />
              }
              label="Defer to production (Slim CI)"
              sx={{ display: "block", mb: 2 }}
            />
          </Tooltip>

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
      {header}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <DbtRunHistory
          workspaceId={workspaceId}
          projectId={projectId}
          runs={jobRuns}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
          emptyHint="No runs yet. Press Run now to start one."
        />
      </Box>
    </Box>
  );
}
