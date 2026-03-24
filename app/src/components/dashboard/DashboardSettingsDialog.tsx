import { useEffect, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Switch,
  FormControlLabel,
  Typography,
  Box,
  Divider,
  Alert,
} from "@mui/material";
import { Copy, Trash2 } from "lucide-react";
import { useDashboardStore } from "../../store/dashboardStore";
import { useWorkspace } from "../../contexts/workspace-context";
import { useConsoleStore } from "../../store/consoleStore";

interface DashboardSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  dashboardId?: string;
}

const MATERIALIZATION_SCHEDULE_PRESETS = [
  { key: "hourly", label: "Every hour", cron: "0 * * * *" },
  { key: "every-6-hours", label: "Every 6 hours", cron: "0 */6 * * *" },
  { key: "daily", label: "Daily", cron: "0 0 * * *" },
  { key: "weekly", label: "Weekly", cron: "0 0 * * 0" },
] as const;

function resolveSchedulePresetKey(cron: string | null | undefined): string {
  const preset = MATERIALIZATION_SCHEDULE_PRESETS.find(
    item => item.cron === cron,
  );
  return preset?.key ?? "custom";
}

function describeMaterializationSchedule(
  enabled: boolean,
  cron: string,
): string {
  if (!enabled) {
    return "Automatic materialization is disabled. Refresh manually when needed.";
  }

  const preset = MATERIALIZATION_SCHEDULE_PRESETS.find(
    item => item.cron === cron,
  );
  if (preset) {
    return `${preset.label} in UTC.`;
  }

  return cron.trim()
    ? `Runs on cron "${cron}" in UTC.`
    : "Enter a cron expression in UTC.";
}

export default function DashboardSettingsDialog({
  open,
  onClose,
  dashboardId,
}: DashboardSettingsDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const dashboard = useDashboardStore(s =>
    dashboardId ? s.openDashboards[dashboardId] : undefined,
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<"private" | "workspace">("private");
  const [gridColumns, setGridColumns] = useState(12);
  const [rowHeight, setRowHeight] = useState(80);
  const [materializationEnabled, setMaterializationEnabled] = useState(true);
  const [materializationPreset, setMaterializationPreset] = useState("daily");
  const [materializationCron, setMaterializationCron] = useState("0 0 * * *");
  const [crossFilterEnabled, setCrossFilterEnabled] = useState(false);
  const [crossFilterResolution, setCrossFilterResolution] = useState<
    "intersect" | "union"
  >("intersect");
  const [crossFilterEngine, setCrossFilterEngine] = useState<
    "mosaic" | "legacy"
  >("mosaic");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isReadOnly = dashboard?.readOnly === true;

  useEffect(() => {
    if (dashboard && open) {
      setTitle(dashboard.title);
      setDescription(dashboard.description ?? "");
      setAccess(dashboard.access);
      setGridColumns(dashboard.layout.columns);
      setRowHeight(dashboard.layout.rowHeight);
      const schedule = dashboard.materializationSchedule ?? {
        enabled: true,
        cron: "0 0 * * *",
        timezone: "UTC",
      };
      setMaterializationEnabled(schedule.enabled);
      setMaterializationCron(schedule.cron ?? "0 0 * * *");
      setMaterializationPreset(resolveSchedulePresetKey(schedule.cron));
      setCrossFilterEnabled(dashboard.crossFilter.enabled);
      setCrossFilterResolution(dashboard.crossFilter.resolution);
      setCrossFilterEngine(dashboard.crossFilter.engine ?? "mosaic");
      setConfirmDelete(false);
    }
  }, [dashboard, open]);

  const handleSave = async () => {
    if (!workspaceId || !dashboard) return;
    await useDashboardStore
      .getState()
      .updateDashboard(workspaceId, dashboard._id, {
        title,
        description,
        access,
        layout: { columns: gridColumns, rowHeight },
        materializationSchedule: {
          enabled: materializationEnabled,
          cron: materializationEnabled ? materializationCron.trim() : null,
          timezone: "UTC",
        },
        crossFilter: {
          enabled: crossFilterEnabled,
          resolution: crossFilterResolution,
          engine: crossFilterEngine,
        },
      } as any);
    useDashboardStore.setState(state => {
      if (dashboardId && state.openDashboards[dashboardId]) {
        Object.assign(state.openDashboards[dashboardId], {
          title,
          description,
          access,
          layout: { columns: gridColumns, rowHeight },
          materializationSchedule: {
            enabled: materializationEnabled,
            cron: materializationEnabled ? materializationCron.trim() : null,
            timezone: "UTC",
          },
          crossFilter: {
            enabled: crossFilterEnabled,
            resolution: crossFilterResolution,
            engine: crossFilterEngine,
          },
        });
      }
    });
    onClose();
  };

  const handleDuplicate = async () => {
    if (!workspaceId || !dashboard) return;
    await useDashboardStore
      .getState()
      .duplicateDashboard(workspaceId, dashboard._id);
    onClose();
  };

  const handleDelete = async () => {
    if (!workspaceId || !dashboard) return;
    await useDashboardStore
      .getState()
      .deleteDashboard(workspaceId, dashboard._id);
    const tabs = useConsoleStore.getState().tabs;
    const dashTab = Object.values(tabs).find(
      t => t.kind === "dashboard" && t.metadata?.dashboardId === dashboard._id,
    );
    if (dashTab) {
      useConsoleStore.getState().closeTab(dashTab.id);
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Dashboard Settings</DialogTitle>
      <DialogContent
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 2.5,
          pt: "16px !important",
        }}
      >
        <TextField
          label="Title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          fullWidth
          size="small"
          disabled={isReadOnly}
        />
        <TextField
          label="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          size="small"
          disabled={isReadOnly}
        />
        <FormControl size="small" fullWidth disabled={isReadOnly}>
          <InputLabel>Access</InputLabel>
          <Select
            value={access}
            label="Access"
            onChange={e => setAccess(e.target.value as "private" | "workspace")}
          >
            <MenuItem value="private">Private</MenuItem>
            <MenuItem value="workspace">Workspace</MenuItem>
          </Select>
        </FormControl>

        <Box sx={{ display: "flex", gap: 2 }}>
          <TextField
            label="Grid columns"
            type="number"
            value={gridColumns}
            onChange={e => setGridColumns(Number(e.target.value))}
            size="small"
            fullWidth
            slotProps={{ htmlInput: { min: 1 } }}
            disabled={isReadOnly}
          />
          <TextField
            label="Row height"
            type="number"
            value={rowHeight}
            onChange={e => setRowHeight(Number(e.target.value))}
            size="small"
            fullWidth
            slotProps={{ htmlInput: { min: 20 } }}
            disabled={isReadOnly}
          />
        </Box>

        <FormControlLabel
          control={
            <Switch
              checked={materializationEnabled}
              onChange={e => setMaterializationEnabled(e.target.checked)}
              disabled={isReadOnly}
            />
          }
          label="Automatic materialization"
        />

        {materializationEnabled && (
          <>
            <FormControl size="small" fullWidth>
              <InputLabel>Materialization Schedule</InputLabel>
              <Select
                value={materializationPreset}
                label="Materialization Schedule"
                onChange={e => {
                  const nextPreset = e.target.value;
                  setMaterializationPreset(nextPreset);
                  const preset = MATERIALIZATION_SCHEDULE_PRESETS.find(
                    item => item.key === nextPreset,
                  );
                  if (preset) {
                    setMaterializationCron(preset.cron);
                  }
                }}
              >
                {MATERIALIZATION_SCHEDULE_PRESETS.map(preset => (
                  <MenuItem key={preset.key} value={preset.key}>
                    {preset.label}
                  </MenuItem>
                ))}
                <MenuItem value="custom">Custom</MenuItem>
              </Select>
            </FormControl>

            <TextField
              label="Cron Expression"
              value={materializationCron}
              onChange={e => {
                setMaterializationPreset("custom");
                setMaterializationCron(e.target.value);
              }}
              fullWidth
              size="small"
              helperText={describeMaterializationSchedule(
                materializationEnabled,
                materializationCron,
              )}
            />
          </>
        )}

        <FormControlLabel
          control={
            <Switch
              checked={crossFilterEnabled}
              onChange={e => setCrossFilterEnabled(e.target.checked)}
              disabled={isReadOnly}
            />
          }
          label="Cross-filtering enabled"
        />

        {crossFilterEnabled && (
          <>
            <FormControl size="small" fullWidth>
              <InputLabel>Cross-filter resolution</InputLabel>
              <Select
                value={crossFilterResolution}
                label="Cross-filter resolution"
                onChange={e =>
                  setCrossFilterResolution(
                    e.target.value as "intersect" | "union",
                  )
                }
              >
                <MenuItem value="intersect">Intersect</MenuItem>
                <MenuItem value="union">Union</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>Cross-filter engine</InputLabel>
              <Select
                value={crossFilterEngine}
                label="Cross-filter engine"
                onChange={e =>
                  setCrossFilterEngine(e.target.value as "mosaic" | "legacy")
                }
              >
                <MenuItem value="mosaic">Mosaic</MenuItem>
                <MenuItem value="legacy">Legacy</MenuItem>
              </Select>
            </FormControl>
          </>
        )}

        <Divider sx={{ mt: 1 }} />

        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography variant="subtitle2" color="text.secondary">
            Actions
          </Typography>
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<Copy size={16} />}
              onClick={handleDuplicate}
            >
              Duplicate
            </Button>
            {!isReadOnly && (
              <Button
                variant="outlined"
                color="error"
                size="small"
                startIcon={<Trash2 size={16} />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            )}
          </Box>
          {confirmDelete && (
            <Alert
              severity="error"
              action={
                <Button color="error" size="small" onClick={handleDelete}>
                  Confirm
                </Button>
              }
            >
              This dashboard will be permanently deleted.
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{isReadOnly ? "Close" : "Cancel"}</Button>
        {!isReadOnly && (
          <Button variant="contained" onClick={handleSave}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
